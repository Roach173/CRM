import { PrismaClient, Prisma } from '@prisma/client';

import prismaDefault from '../../lib/prisma';
import { emitToSchool } from '../../lib/socket';
import { logScheduleAction } from '../../lib/auditLog';
import {
  dispatchMakeupCreatedNotifications,
} from '../scheduleLifecycleNotificationService';
import { snapshotNewSessions, getEffectiveSessionTeacherId, validateSessionDate } from '../sessionService';
import { assertGroupAction, GroupShape } from '../../lib/groupLifecyclePolicy';
import {
  LifecycleActor,
} from '../scheduleLifecycleTypes';
import { log, emitScheduleSessionChanged, studentUserIdsFromMemberships, DbClient } from './lifecycleShared';
import {
  requireLifecycleReason,
} from './lifecycleGuards';

/**
 * Creates a makeup session for a cancelled session.
 * PR 6: full lifecycle implementation.
 *
 * Guards:
 *   - reason required (≥ 5 chars, MAKEUP_CREATED added to EVENTS_REQUIRING_REASON)
 *   - original session must exist and belong to school (tenant isolation)
 *   - original session must be CANCELLED: LOCKED → 409, INVALIDATED → 409, other → 400
 *   - no existing active (non-CANCELLED) makeup for same original → 409 MAKEUP_ALREADY_EXISTS
 *
 * Side effects (inside $transaction for atomicity):
 *   - DB: new LessonSession with isMakeup=true, makeupForSessionId=originalId
 *   - DB: snapshotNewSessions — SessionStudent rows for active group members
 *   - Audit: logScheduleAction('MAKEUP_CREATED') with originalSessionId in after payload
 * Outside transaction:
 *   - Notifications: dispatchMakeupCreatedNotifications to students (best-effort)
 *   - Socket: session:status-changed (triggers schedule refresh)
 */
export async function createMakeupSession(params: {
  originalSessionId: number;
  schoolId: number;
  actor: LifecycleActor;
  newDate: Date;
  reason?: string;
  client?: DbClient;
}): Promise<any> {
  const prismaClient = (params.client ?? prismaDefault) as PrismaClient;

  // 1. Reason enforcement
  const reasonCheck = requireLifecycleReason('MAKEUP_CREATED', params.reason);
  if (!reasonCheck.valid) {
    throw Object.assign(new Error(reasonCheck.reason!), { httpStatus: 400 });
  }

  // 2. Load original session (tenant guard + group for notifications)
  const original = await prismaClient.lessonSession.findFirst({
    where: { id: params.originalSessionId, schoolId: params.schoolId, deletedAt: null },
    include: {
      lessonBlock: {
        include: {
          studentGroup: {
            include: { memberships: { where: { status: 'ACTIVE' as const }, select: { studentProfile: { include: { user: { select: { id: true } } } } } } },
          },
        },
      },
    },
  });
  if (!original) {
    throw Object.assign(new Error('SESSION_NOT_FOUND'), { httpStatus: 404 });
  }

  // 2b. Group lifecycle guard: cannot create makeup for sessions in inactive groups
  const makeupGroup = (original as any).lessonBlock?.studentGroup as GroupShape | null | undefined;
  if (makeupGroup) {
    assertGroupAction(makeupGroup, 'create:makeup');
  }

  // 3. Status validation: lifecycle guards for non-CANCELLED states
  if (original.status === 'LOCKED') {
    throw Object.assign(new Error('MAKEUP_LOCKED_SESSION'), {
      httpStatus: 409,
      details: { lifecycleError: true, message: 'Cannot create makeup for a LOCKED session' },
    });
  }
  if (original.status === 'INVALIDATED') {
    throw Object.assign(new Error('MAKEUP_INVALIDATED_SESSION'), {
      httpStatus: 409,
      details: { lifecycleError: true, message: 'Cannot create makeup for an INVALIDATED session' },
    });
  }
  if (original.status !== 'CANCELLED') {
    throw Object.assign(new Error('MAKEUP_REQUIRES_CANCELLED_SESSION'), {
      httpStatus: 400,
      details: { currentStatus: original.status },
    });
  }

  // 3b. Working date validation — policy activeDays, legacy holidays, ScheduleException.
  // Makeups may fall on any day of the week (no block day restriction) but school-level
  // date rules and block-context exceptions still apply.
  const makeupDateStr = params.newDate.toISOString().slice(0, 10);
  const makeupDateValidation = await validateSessionDate(
    params.schoolId,
    { days: [0, 1, 2, 3, 4, 5, 6], startDate: null, endDate: null },
    makeupDateStr,
    {
      teacherId: getEffectiveSessionTeacherId(original as any) ?? null,
      cabinetId: original.cabinetIdSnap ?? null,
      groupId: (original as any).lessonBlock?.studentGroupId ?? null,
    },
  );
  if (makeupDateValidation.valid === false) {
    throw Object.assign(new Error('MAKEUP_DATE_INVALID'), {
      httpStatus: 422,
      details: { lifecycleError: true, reason: makeupDateValidation.reason },
    });
  }

  // 4. Atomic: duplicate check + create session + snapshot + audit
  const makeup = await prismaClient.$transaction(async (tx) => {
    const dbClient = tx as unknown as PrismaClient;

    // Serialize concurrent makeup creation for the same original session.
    // Without this lock, two requests could both pass the existingMakeup check
    // before either insert commits, producing duplicate active makeups.
    await dbClient.$executeRaw`SELECT id FROM "LessonSession" WHERE id = ${params.originalSessionId} FOR UPDATE`;

    const existingMakeup = await dbClient.lessonSession.findFirst({
      where: {
        makeupForSessionId: params.originalSessionId,
        deletedAt: null,
        status: { not: 'CANCELLED' },
      },
      select: { id: true },
    });
    if (existingMakeup) {
      throw Object.assign(new Error('MAKEUP_ALREADY_EXISTS'), {
        httpStatus: 409,
        details: {
          lifecycleError: true,
          existingMakeupId: existingMakeup.id,
          message: 'An active makeup session already exists for this cancelled session',
        },
      });
    }

    const created = await dbClient.lessonSession.create({
      data: {
        schoolId:           params.schoolId,
        lessonBlockId:      original.lessonBlockId,
        date:               params.newDate,
        status:             'UPCOMING',
        teacherId:          original.teacherId,
        teacherIdSnap:      original.teacherIdSnap,
        cabinetIdSnap:      original.cabinetIdSnap,
        startTimeSnap:      original.startTimeSnap,
        endTimeSnap:        original.endTimeSnap,
        isMakeup:           true,
        makeupForSessionId: original.id,
      },
    }).catch((e: any) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Object.assign(new Error('MAKEUP_ALREADY_EXISTS'), {
          httpStatus: 409,
          details: { lifecycleError: true, message: 'Concurrent makeup creation conflict' },
        });
      }
      throw e;
    });

    // Snapshot students for the new makeup session
    await snapshotNewSessions(
      dbClient,
      original.lessonBlockId,
      params.schoolId,
      original.lessonBlock.studentGroupId,
      [params.newDate],
    );

    await logScheduleAction({
      client:     dbClient,
      schoolId:   params.schoolId,
      userId:     params.actor.userId,
      action:     'MAKEUP_CREATED',
      entityType: 'session',
      sessionId:  created.id,
      before:     {},
      after:      {
        makeupForSessionId: original.id,
        date:               params.newDate,
        isMakeup:           true,
      },
      reason: params.reason,
    });

    return created;
  });

  // 5. Notify students (best-effort — must not rollback the mutation)
  const studentUserIds = studentUserIdsFromMemberships((original as any).lessonBlock?.studentGroup);

  try {
    await dispatchMakeupCreatedNotifications({
      originalSessionId: params.originalSessionId,
      makeupSessionId:   makeup.id,
      lessonBlockId:     original.lessonBlockId,
      makeupDate:        params.newDate,
      blockLevel:        (original as any).lessonBlock?.level ?? '',
      studentUserIds,
    });
  } catch (err) {
    log.warn({ err, sessionId: makeup.id }, 'MAKEUP_CREATED notification dispatch failed');
  }

  // 6. Socket emit — triggers schedule refresh on all connected clients
  emitToSchool(params.schoolId, 'session:status-changed', {
    sessionId:     makeup.id,
    lessonBlockId: original.lessonBlockId,
    status:        makeup.status,
    date:          makeup.date,
  });
  emitScheduleSessionChanged(params.schoolId, {
    sessionId:     makeup.id,
    lessonBlockId: original.lessonBlockId,
    status:        makeup.status,
    date:          makeup.date,
    action:        'makeup-created',
  });

  return makeup;
}

