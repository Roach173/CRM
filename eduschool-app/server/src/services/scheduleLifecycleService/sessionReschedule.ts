import { PrismaClient } from '@prisma/client';

import prismaDefault from '../../lib/prisma';
import { emitToSchool } from '../../lib/socket';
import { logScheduleAction } from '../../lib/auditLog';
import { validateSingleSessionOverride, ScheduleValidationError, validateSessionTimeBounds } from '../scheduleValidation';
import {
  dispatchRescheduleNotifications,
} from '../scheduleLifecycleNotificationService';
import { getEffectiveSessionTeacherId } from '../sessionService';
import { assertGroupAction, GroupShape } from '../../lib/groupLifecyclePolicy';
import {
  LifecycleActor,
} from '../scheduleLifecycleTypes';
import { log, emitScheduleSessionChanged, studentUserIdsFromMemberships, DbClient } from './lifecycleShared';
import {
  requireLifecycleReason,
  assertSessionEditable, assertNoSalaryLockedSessionMutation,
} from './lifecycleGuards';

/**
 * Reschedules a session: changes its time slot and/or room.
 * Fully implemented as a first-class lifecycle event.
 *
 * Note: date (calendar day) changes are NOT supported here — moving a session to
 * a different day is handled by moveSession() (sessionMove.ts), backing
 * POST /session/:id/move. This function handles time and room changes on the SAME date.
 *
 * Guards:
 *   - reason required (≥ 5 chars)
 *   - session must exist and belong to school (tenant isolation)
 *   - editability check: only UPCOMING / IN_PROGRESS sessions
 *   - conflict validation via validateSingleSessionOverride (teacher + cabinet + group)
 *
 * Side effects (inside $transaction for atomicity):
 *   - DB: startTimeSnap, endTimeSnap, cabinetIdSnap updated; isManualTime, isManualCabinet set
 *   - Audit: logScheduleAction('RESCHEDULE') with before/after slot snapshot
 * Outside transaction:
 *   - Socket: session:status-changed (triggers schedule refresh on all clients)
 *
 * PR 5: notifyParents + notifyTeacher implemented via dispatchRescheduleNotifications().
 */
export async function rescheduleSession(params: {
  sessionId: number;
  schoolId: number;
  actor: LifecycleActor;
  newStartTime?: string;
  newEndTime?: string;
  newCabinetId?: number;
  overrideTeacherConflict?: boolean;
  overrideCabinetConflict?: boolean;
  reason: string;
  versionGuard?: number;
  client?: DbClient;
}): Promise<any> {
  const prismaClient = (params.client ?? prismaDefault) as PrismaClient;

  // 1. Reason validation
  const reasonCheck = requireLifecycleReason('SESSION_RESCHEDULED', params.reason);
  if (!reasonCheck.valid) {
    throw Object.assign(new Error(reasonCheck.reason!), { httpStatus: 400 });
  }

  // 2. Load session with block metadata (extended for notifications in PR 5)
  const session = await prismaClient.lessonSession.findFirst({
    where: { id: params.sessionId, schoolId: params.schoolId, deletedAt: null },
    include: {
      lessonBlock: {
        include: {
          // select-level for conflict validation fields
          studentGroup: {
            include: { memberships: { where: { status: 'ACTIVE' as const }, select: { studentProfile: { include: { user: { select: { id: true } } } } } } },
          },
        },
        // Narrowing to fields needed prevents over-fetching large relations
      },
      teacher: { select: { userId: true } },
    },
  });
  if (!session) {
    throw Object.assign(new Error('SESSION_NOT_FOUND'), { httpStatus: 404 });
  }

  // 2b. Group lifecycle guard: cannot reschedule sessions for inactive groups
  const reschedGroup = (session as any).lessonBlock?.studentGroup as GroupShape | null | undefined;
  if (reschedGroup) {
    assertGroupAction(reschedGroup, 'reschedule');
  }

  // 3. Editability: only UPCOMING / IN_PROGRESS
  const editCheck = assertSessionEditable(session.status, 'SESSION_RESCHEDULED');
  if (!editCheck.valid) {
    throw Object.assign(new Error(editCheck.reason!), { httpStatus: 422 });
  }

  // 3b. Salary safety guard (PR 5): block if session is already salary-attributed
  await assertNoSalaryLockedSessionMutation(params.sessionId, 'SESSION_RESCHEDULED', prismaClient);

  // 4. Resolve new slot (fall back to current snapshots, then block defaults)
  const newStartTime = params.newStartTime ?? session.startTimeSnap ?? session.lessonBlock.startTime;
  const newEndTime   = params.newEndTime   ?? session.endTimeSnap   ?? session.lessonBlock.endTime;
  const newCabinetId = params.newCabinetId ?? session.cabinetIdSnap ?? session.lessonBlock.cabinetId;
  const currentTeacherId = getEffectiveSessionTeacherId(session) ?? session.lessonBlock.teacherId;

  if (!newCabinetId) {
    throw Object.assign(new Error('CABINET_REQUIRED'), { httpStatus: 400 });
  }

  // 5. Snapshot old slot for audit
  const oldStartTime = session.startTimeSnap ?? session.lessonBlock.startTime;
  const oldEndTime   = session.endTimeSnap   ?? session.lessonBlock.endTime;
  const oldCabinetId = session.cabinetIdSnap ?? session.lessonBlock.cabinetId;
  const oldTeacherId = getEffectiveSessionTeacherId(session) ?? session.lessonBlock.teacherId;

  // 6. Conflict validation (teacher workload + cabinet + group — uses existing validators)
  try {
    await validateSingleSessionOverride(prismaClient, {
      sessionId:    params.sessionId,
      date:         session.date,
      schoolId:     params.schoolId,
      cabinetId:    newCabinetId,
      teacherId:    currentTeacherId!,
      startTime:    newStartTime,
      endTime:      newEndTime,
      studentGroupId: session.lessonBlock.studentGroupId,
      overrideTeacherConflict: params.overrideTeacherConflict,
    });
  } catch (e: any) {
    if (e instanceof ScheduleValidationError && e.message.startsWith('CAPACITY_WARNING:')) {
      if (!params.overrideCabinetConflict) {
        throw Object.assign(new Error(e.message), { httpStatus: 400 });
      }
      // else: capacity warning overridden — proceed
    } else {
      throw Object.assign(new Error(e.message), { httpStatus: 409 });
    }
  }

  // 6b. Working time bounds validation (SOT: SchoolSchedulePolicy by date)
  const timeBoundsResult = await validateSessionTimeBounds(
    prismaClient,
    params.schoolId,
    newStartTime,
    newEndTime,
    session.date,
  );
  if (timeBoundsResult.valid === false) {
    throw Object.assign(new Error('TIME_OUTSIDE_WORKING_HOURS'), {
      httpStatus: 422,
      details: { lifecycleError: true, reason: timeBoundsResult.reason },
    });
  }

  // 7. Atomic: DB update + audit log in one transaction
  const updated = await prismaClient.$transaction(async (tx) => {
    const dbClient = tx as unknown as PrismaClient;

    const updatedSession = await dbClient.lessonSession.update({
      where: {
        id: params.sessionId,
        ...(params.versionGuard !== undefined && { version: params.versionGuard }),
      },
      data: {
        startTimeSnap:  newStartTime,
        endTimeSnap:    newEndTime,
        cabinetIdSnap:  newCabinetId,
        isManualTime:   params.newStartTime !== undefined || params.newEndTime !== undefined,
        isManualCabinet: params.newCabinetId !== undefined,
        version: { increment: 1 },
      },
      include: {
        teacher:     { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        lessonBlock: { select: { startTime: true, endTime: true, cabinet: { select: { name: true } } } },
      },
    });

    await logScheduleAction({
      client:     dbClient,
      schoolId:   params.schoolId,
      userId:     params.actor.userId,
      action:     'RESCHEDULE',
      entityType: 'session',
      sessionId:  params.sessionId,
      before: {
        startTime: oldStartTime,
        endTime:   oldEndTime,
        cabinetId: oldCabinetId,
        teacherId: oldTeacherId,
      },
      after: {
        startTime: newStartTime,
        endTime:   newEndTime,
        cabinetId: newCabinetId,
        teacherId: currentTeacherId,
      },
      reason: params.reason,
    });

    return updatedSession;
  });

  // 8. Socket emit — triggers schedule refresh on all connected clients
  emitToSchool(params.schoolId, 'session:status-changed', {
    sessionId:     params.sessionId,
    lessonBlockId: session.lessonBlockId,
    status:        session.status,
    date:          session.date,
  });
  emitScheduleSessionChanged(params.schoolId, {
    sessionId:     params.sessionId,
    lessonBlockId: session.lessonBlockId,
    status:        updated.status,
    date:          updated.date,
    action:        'rescheduled',
  });

  // 9. Notifications (PR 5): best-effort, must NOT rollback mutation on failure
  try {
    const studentUserIds = studentUserIdsFromMemberships((session as any).lessonBlock?.studentGroup);

    const teacherUserId = (session as any).teacher?.userId as number | undefined;

    await dispatchRescheduleNotifications({
      sessionId:      params.sessionId,
      lessonBlockId:  session.lessonBlockId,
      sessionDate:    session.date,
      blockLevel:     (session as any).lessonBlock?.level ?? '',
      oldSlot:        { startTime: oldStartTime, endTime: oldEndTime, cabinetId: oldCabinetId },
      newSlot:        { startTime: newStartTime, endTime: newEndTime, cabinetId: newCabinetId },
      reason:         params.reason,
      studentUserIds,
      teacherUserId,
    });
  } catch (err) {
    log.warn(
      { err, sessionId: params.sessionId, requestId: params.actor.requestId },
      'SESSION_RESCHEDULED notification dispatch failed',
    );
  }

  return updated;
}

