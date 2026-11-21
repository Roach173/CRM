import { PrismaClient } from '@prisma/client';

import prismaDefault from '../../lib/prisma';
import { notifyMany } from '../../lib/notify';
import { emitToSchool } from '../../lib/socket';
import { logScheduleAction } from '../../lib/auditLog';
import {
  dispatchTeacherReplacedNotifications,
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
 * Assigns a substitute teacher to a session.
 * PR 3: fully implemented.
 *
 * Guards:
 *   - reason required (≥ 5 chars)
 *   - session belongs to school (tenant isolation)
 *   - session must be editable (UPCOMING or IN_PROGRESS)
 *   - new teacher must belong to the same school (cross-tenant guard)
 *   - if TeacherPaymentLesson exists → reject (salary safety)
 *
 * Side effects:
 *   - DB update: teacherId, isManualTeacher=true, version++
 *   - Audit: before/after with oldTeacherId/newTeacherId via logScheduleAction
 *   - notifyTeacher placeholder (contract: TEACHER_REPLACED.notifyTeacher=true)
 *     → actual teacher notification deferred to PR 5
 *   - notifyMany students (preserves existing route behavior)
 *   - Socket emit: session:teacher-changed
 */
export async function replaceTeacher(params: {
  sessionId: number;
  schoolId: number;
  actor: LifecycleActor;
  substituteStaffProfileId: number;
  reason: string;
  versionGuard?: number;
  client?: DbClient;
}): Promise<any> {
  const prismaClient = (params.client ?? prismaDefault) as PrismaClient;

  // Reason validation
  const reasonCheck = requireLifecycleReason('TEACHER_REPLACED', params.reason);
  if (!reasonCheck.valid) {
    throw Object.assign(new Error(reasonCheck.reason!), { httpStatus: 400 });
  }

  // Load session with school + student group for notifications
  const session = await prismaClient.lessonSession.findFirst({
    where: { id: params.sessionId, schoolId: params.schoolId, deletedAt: null },
    include: {
      lessonBlock: {
        select: {
          studentGroupId: true,
          studentGroup: {
            include: { memberships: { where: { status: 'ACTIVE' as const }, select: { studentProfile: { include: { user: { select: { id: true } } } } } } },
          },
        },
      },
    },
  });
  if (!session) {
    throw Object.assign(new Error('SESSION_NOT_FOUND'), { httpStatus: 404 });
  }

  // Group lifecycle guard: cannot replace teacher for sessions in inactive groups
  const sessionGroup = (session as any).lessonBlock?.studentGroup as GroupShape | null | undefined;
  if (sessionGroup) {
    assertGroupAction(sessionGroup, 'change:teacher');
  }

  // Session must be editable
  const editCheck = assertSessionEditable(session.status, 'TEACHER_REPLACED');
  if (!editCheck.valid) {
    throw Object.assign(new Error(editCheck.reason!), { httpStatus: 422 });
  }

  // New teacher must belong to the same school (cross-tenant guard)
  const newTeacherStaff = await prismaClient.staffProfile.findFirst({
    where: { id: params.substituteStaffProfileId, user: { schoolId: params.schoolId } },
    include: { user: { select: { id: true, firstName: true, lastName: true } } },
  });
  if (!newTeacherStaff) {
    throw Object.assign(new Error('TEACHER_NOT_FOUND'), { httpStatus: 404 });
  }

  // Salary safety: reject if salary payment already recorded for this session (PR 5: shared guard)
  await assertNoSalaryLockedSessionMutation(params.sessionId, 'TEACHER_REPLACED', prismaClient);

  const oldTeacherId = getEffectiveSessionTeacherId(session);

  // DB update + audit in one transaction (D-04: write-boundary).
  const updated = await prismaClient.$transaction(async (tx) => {
    const dbClient = tx as unknown as PrismaClient;

    const upd = await dbClient.lessonSession.update({
      where: {
        id: params.sessionId,
        ...(params.versionGuard !== undefined && { version: params.versionGuard }),
      },
      data: {
        teacherId: params.substituteStaffProfileId,
        isManualTeacher: true,
        version: { increment: 1 },
      },
      include: {
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        lessonBlock: { select: { teacher: { select: { user: { select: { firstName: true, lastName: true } } } } } },
      },
    });

    await logScheduleAction({
      client: dbClient,
      schoolId: params.schoolId,
      userId: params.actor.userId,
      action: 'CHANGE_TEACHER',
      entityType: 'session',
      sessionId: params.sessionId,
      before: { teacherId: oldTeacherId },
      after: {
        teacherId: params.substituteStaffProfileId,
        teacherName: `${newTeacherStaff.user.firstName} ${newTeacherStaff.user.lastName}`,
      },
      reason: params.reason,
    });

    return upd;
  });

  // Notify students (preserve existing behavior)
  const studentUserIds = studentUserIdsFromMemberships(session.lessonBlock.studentGroup);
  if (studentUserIds.length > 0) {
    await notifyMany(studentUserIds, {
      type: 'SUBSTITUTE_TEACHER',
      title: 'Замена преподавателя',
      body: `На ближайшем уроке вас заменит ${newTeacherStaff.user.firstName} ${newTeacherStaff.user.lastName}`,
      data: { sessionId: params.sessionId },
    });
  }

  // Notify the NEW teacher (PR 5: was a placeholder, now sends actual notification)
  // Best-effort: failure must NOT rollback the teacher replacement.
  try {
    await dispatchTeacherReplacedNotifications({
      sessionId:        params.sessionId,
      lessonBlockId:    session.lessonBlockId,
      sessionDate:      session.date,
      blockLevel:       (session as any).lessonBlock?.level ?? '',
      newTeacherUserId: newTeacherStaff.user.id,
      newTeacherName:   `${newTeacherStaff.user.firstName} ${newTeacherStaff.user.lastName}`,
      reason:           params.reason,
    });
  } catch (err) {
    log.warn({ err, sessionId: params.sessionId }, 'TEACHER_REPLACED teacher notification dispatch failed');
  }

  // Socket emit
  emitToSchool(params.schoolId, 'session:teacher-changed', {
    sessionId: params.sessionId,
    lessonBlockId: session.lessonBlockId,
    newTeacherId: params.substituteStaffProfileId,
  });
  emitScheduleSessionChanged(params.schoolId, {
    sessionId: params.sessionId,
    lessonBlockId: session.lessonBlockId,
    date: session.date,
    action: 'teacher-changed',
  });

  return updated;
}

