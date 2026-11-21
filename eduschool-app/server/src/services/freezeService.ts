/**
 * FREEZE SERVICE — PR 5: Freeze System Phase 1: Backend Foundation
 *
 * StudentFreeze is the single source of truth for all freeze state.
 * StudentProfile.isFrozen / frozenAt are legacy cache fields kept in sync here.
 *
 * FreezeType.LESSON_SKIP — skips a single upcoming session (lessonSessionId required)
 * FreezeType.PERIOD      — covers a date range; endDate=null means open-ended
 *
 * Effective deadline: pauseRules.minNotice (days) × 24 = hours. SOT: School.settings.pauseRules.
 */

import { PrismaClient, Prisma, Role } from '@prisma/client';
import prismaDefault from '../lib/prisma';
import { buildSessionStart, dateInTz } from '../lib/tzUtils';
import { logScheduleAction } from '../lib/auditLog';
import { notify } from '../lib/notify';
import { createLogger } from '../lib/logger';

const log = createLogger('freeze');

type DbClient =
  | PrismaClient
  | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export interface FreezeActor {
  userId: number;
  role: Role;
  schoolId: number;
}

// ─── Deadline helpers ──────────────────────────────────────────────────────────

// ponytail: legacy string parsing — remove after all schools re-save pause settings
export function parsePauseInt(v: unknown, def: number | null): number | null {
  if (v === null || v === undefined) return def;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v === 'Без ограничений' ? null : (parseInt(v) || def);
  return def;
}

async function loadSchoolConfig(
  client: DbClient,
  schoolId: number,
): Promise<{ timezone: string; deadlineHours: number; maxDays: number | null; allowed: boolean; timesPerYear: number | null }> {
  const school = await (client as PrismaClient).school.findFirst({
    where: { id: schoolId },
    select: { timezone: true, settings: true },
  });
  const settings =
    school?.settings && typeof school.settings === 'object' && !Array.isArray(school.settings)
      ? (school.settings as Record<string, unknown>)
      : {};
  const rules = (settings.pauseRules as Record<string, unknown> | undefined) ?? {};
  const minNotice = typeof rules.minNotice === 'number' ? rules.minNotice : 3;
  return {
    timezone:      school?.timezone ?? 'UTC',
    deadlineHours: minNotice * 24,
    maxDays:       parsePauseInt(rules.maxDays, null),
    allowed:       rules.allowed !== false,
    timesPerYear:  parsePauseInt(rules.timesPerYear, null),
  };
}

function getDeadline(sessionStart: Date, deadlineHours: number): Date {
  return new Date(sessionStart.getTime() - deadlineHours * 3600_000);
}

// ─── Auditable reason validation ──────────────────────────────────────────────

function requireAuditableReason(eventName: string, reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < 5) {
    throw Object.assign(
      new Error(`${eventName}: auditable reason required (min 5 chars)`),
      { httpStatus: 400 },
    );
  }
  return r;
}

// ─── Core lookup ──────────────────────────────────────────────────────────────

/**
 * Returns the first ACTIVE StudentFreeze covering the given session.
 * Used by attendanceService to determine whether to apply FROZEN status.
 *
 * LESSON_SKIP: matched by lessonSessionId
 * PERIOD:      matched by date range (endDate=null = open-ended)
 */
export async function findActiveFreeze(
  params: {
    studentProfileId: number;
    sessionId: number;
    sessionDate: Date;
    schoolId: number;
  },
  client: DbClient = prismaDefault,
) {
  const map = await findActiveFreezesForSession(
    { studentProfileIds: [params.studentProfileId], sessionId: params.sessionId, sessionDate: params.sessionDate, schoolId: params.schoolId },
    client,
  );
  return map.get(params.studentProfileId) ?? null;
}

/**
 * Batch variant: one query for the whole group during attendance submission.
 * Returns a Map keyed by studentProfileId → first matching ACTIVE freeze.
 */
export async function findActiveFreezesForSession(
  params: {
    studentProfileIds: number[];
    sessionId: number;
    sessionDate: Date;
    schoolId: number;
  },
  client: DbClient = prismaDefault,
) {
  const result = new Map<number, { id: number; type: string; reason: string | null }>();
  if (params.studentProfileIds.length === 0) return result;

  const freezes = await (client as PrismaClient).studentFreeze.findMany({
    where: {
      studentProfileId: { in: params.studentProfileIds },
      schoolId: params.schoolId,
      status: 'ACTIVE',
      OR: [
        // LESSON_SKIP: exact session match
        { type: 'LESSON_SKIP', lessonSessionId: params.sessionId },
        // PERIOD: startDate <= sessionDate AND (endDate >= sessionDate OR endDate is null)
        {
          type: 'PERIOD',
          startDate: { lte: params.sessionDate },
          OR: [
            { endDate: null },
            { endDate: { gte: params.sessionDate } },
          ],
        },
      ],
    },
    select: { id: true, type: true, reason: true, studentProfileId: true },
  });
  for (const f of freezes) {
    if (!result.has(f.studentProfileId)) result.set(f.studentProfileId, { id: f.id, type: f.type, reason: f.reason });
  }
  return result;
}

// ─── createFreeze ─────────────────────────────────────────────────────────────

export interface CreateFreezeParams {
  studentProfileId: number;
  schoolId: number;
  actor: FreezeActor;
  type: 'LESSON_SKIP' | 'PERIOD';
  lessonSessionId?: number;  // required for LESSON_SKIP
  startDate?: Date;           // required for PERIOD (UTC noon sentinel)
  endDate?: Date | null;      // optional for PERIOD; null = open-ended
  reason?: string;
  skipDeadlineCheck?: boolean; // bypasses deadline + overlap checks (admin-toggle path)
  client?: DbClient;
}

export async function createFreeze(params: CreateFreezeParams) {
  const reason = requireAuditableReason('FREEZE_CREATED', params.reason);
  const client = (params.client ?? prismaDefault) as PrismaClient;

  // 1. Tenant guard
  const profile = await client.studentProfile.findFirst({
    where: { id: params.studentProfileId, deletedAt: null, user: { schoolId: params.schoolId } },
    include: { user: { select: { id: true } } },
  });
  if (!profile) throw Object.assign(new Error('STUDENT_NOT_FOUND'), { httpStatus: 404 });

  const { timezone, deadlineHours, maxDays, allowed, timesPerYear } = await loadSchoolConfig(client, params.schoolId);

  // Normalize PERIOD bounds to the UTC-noon day sentinel that LessonSession.date uses.
  // Without this a raw timestamp (e.g. pause clicked at 13:17 UTC) is > today's session
  // noon sentinel, so `startDate <= sessionDate` fails and the same-day lesson still deducts.
  if (params.type === 'PERIOD') {
    if (params.startDate) params.startDate = new Date(`${dateInTz(params.startDate, timezone)}T12:00:00.000Z`);
    if (params.endDate)   params.endDate   = new Date(`${dateInTz(params.endDate, timezone)}T12:00:00.000Z`);
  }

  // Pause policy check — always enforced regardless of skipDeadlineCheck
  if (!allowed) {
    throw Object.assign(new Error('PAUSE_NOT_ALLOWED'), { httpStatus: 400 });
  }

  const now = new Date();

  // 2. Type-specific guards
  if (params.type === 'LESSON_SKIP') {
    if (!params.lessonSessionId) {
      throw Object.assign(new Error('LESSON_SESSION_ID_REQUIRED'), { httpStatus: 400 });
    }

    const session = await client.lessonSession.findFirst({
      where: { id: params.lessonSessionId, schoolId: params.schoolId, deletedAt: null },
      select: {
        id: true, status: true, date: true, startTimeSnap: true,
        lessonBlock: { select: { startTime: true } },
      },
    });
    if (!session) throw Object.assign(new Error('SESSION_NOT_FOUND'), { httpStatus: 404 });

    // UPCOMING-only guard (Decision 2)
    if (session.status !== 'UPCOMING') {
      throw Object.assign(
        new Error('FREEZE_SESSION_NOT_UPCOMING'),
        { httpStatus: 422, details: { currentStatus: session.status } },
      );
    }

    // Deadline check
    if (!params.skipDeadlineCheck) {
      const sessionStart = buildSessionStart(
        session.date,
        session.startTimeSnap ?? session.lessonBlock.startTime,
        timezone,
      );
      const deadline = getDeadline(sessionStart, deadlineHours);
      if (now > deadline) {
        throw Object.assign(
          new Error('FREEZE_DEADLINE_PASSED'),
          { httpStatus: 422, details: { deadline: deadline.toISOString(), deadlineHours } },
        );
      }
    }
  } else {
    // PERIOD
    if (!params.startDate) {
      throw Object.assign(new Error('START_DATE_REQUIRED'), { httpStatus: 400 });
    }
    // maxDays enforcement: explicit endDate must not exceed school's max pause duration
    if (params.endDate && maxDays !== null && !params.skipDeadlineCheck) {
      const durationDays = (params.endDate.getTime() - params.startDate.getTime()) / 86400_000;
      if (durationDays > maxDays) {
        throw Object.assign(
          new Error('FREEZE_PERIOD_TOO_LONG'),
          { httpStatus: 422, details: { maxDays, durationDays: Math.ceil(durationDays) } },
        );
      }
    }
  }

  return client.$transaction(async (tx) => {
    const dbClient = tx as unknown as PrismaClient;

    // Row-lock on StudentProfile serializes concurrent freeze creation
    await dbClient.$executeRaw`SELECT id FROM "StudentProfile" WHERE id = ${params.studentProfileId} FOR UPDATE`;

    // timesPerYear: inside tx to prevent race conditions with concurrent freeze creation
    if (timesPerYear !== null) {
      const yr = new Date().getFullYear();
      const freezeCount = await dbClient.studentFreeze.count({
        where: {
          studentProfileId: params.studentProfileId,
          schoolId:         params.schoolId,
          createdAt: { gte: new Date(`${yr}-01-01`), lt: new Date(`${yr + 1}-01-01`) },
        },
      });
      if (freezeCount >= timesPerYear) {
        throw Object.assign(
          new Error('PAUSE_LIMIT_REACHED'),
          { httpStatus: 422, details: { limit: timesPerYear, count: freezeCount } },
        );
      }
    }

    // 3. PERIOD overlap check (Decision 1)
    if (params.type === 'PERIOD' && !params.skipDeadlineCheck) {
      const overlap = await dbClient.studentFreeze.findFirst({
        where: {
          studentProfileId: params.studentProfileId,
          schoolId: params.schoolId,
          type: 'PERIOD',
          status: 'ACTIVE',
          // existing.startDate <= new.endDate (or new.endDate is null)
          ...(params.endDate != null ? { startDate: { lte: params.endDate } } : {}),
          // existing.endDate >= new.startDate (or existing.endDate is null)
          OR: [
            { endDate: null },
            { endDate: { gte: params.startDate } },
          ],
        },
        select: { id: true },
      });
      if (overlap) {
        throw Object.assign(
          new Error('FREEZE_PERIOD_OVERLAP'),
          { httpStatus: 409, details: { overlappingFreezeId: overlap.id } },
        );
      }

      // Deadline check for PERIOD: find first session in the range
      const firstSession = await dbClient.lessonSession.findFirst({
        where: {
          schoolId: params.schoolId,
          date: {
            gte: params.startDate!,
            ...(params.endDate ? { lte: params.endDate } : {}),
          },
          deletedAt: null,
          status: { not: 'CANCELLED' },
          lessonBlock: {
            studentGroup: {
              students: { some: { id: params.studentProfileId } },
            },
          },
        },
        orderBy: { date: 'asc' },
        select: {
          id: true, date: true, startTimeSnap: true,
          lessonBlock: { select: { startTime: true } },
        },
      });

      if (firstSession) {
        const sessionStart = buildSessionStart(
          firstSession.date,
          firstSession.startTimeSnap ?? firstSession.lessonBlock.startTime,
          timezone,
        );
        const deadline = getDeadline(sessionStart, deadlineHours);
        if (now > deadline) {
          throw Object.assign(
            new Error('FREEZE_DEADLINE_PASSED'),
            { httpStatus: 422, details: { deadline: deadline.toISOString(), deadlineHours } },
          );
        }
      }
    }

    // 4. LESSON_SKIP deduplication
    if (params.type === 'LESSON_SKIP') {
      const existing = await dbClient.studentFreeze.findFirst({
        where: { studentProfileId: params.studentProfileId, lessonSessionId: params.lessonSessionId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (existing) {
        throw Object.assign(
          new Error('FREEZE_LESSON_SKIP_EXISTS'),
          { httpStatus: 409, details: { existingFreezeId: existing.id } },
        );
      }
    }

    // 5. Create StudentFreeze (source of truth)
    const freeze = await dbClient.studentFreeze.create({
      data: {
        schoolId:         params.schoolId,
        studentProfileId: params.studentProfileId,
        type:             params.type,
        lessonSessionId:  params.lessonSessionId ?? null,
        startDate:        params.startDate ?? null,
        endDate:          params.endDate ?? null,
        reason:           reason,
        status:           'ACTIVE',
        createdById:      params.actor.userId,
      },
    });

    // 6. Sync legacy cache on StudentProfile
    await dbClient.studentProfile.update({
      where: { id: params.studentProfileId },
      data: { isFrozen: true, frozenAt: params.startDate ?? new Date() },
    });

    // 7. Audit log
    await logScheduleAction({
      client:     dbClient,
      schoolId:   params.schoolId,
      userId:     params.actor.userId,
      action:     'FREEZE_CREATED',
      entityType: 'student',
      before:     { isFrozen: profile.isFrozen, frozenAt: profile.frozenAt?.toISOString() ?? null },
      after: {
        freezeId:        freeze.id,
        type:            params.type,
        studentProfileId: params.studentProfileId,
        lessonSessionId:  params.lessonSessionId ?? null,
        startDate:        params.startDate?.toISOString() ?? null,
        endDate:          params.endDate?.toISOString() ?? null,
      },
      reason: reason,
    });

    return freeze;
  }).then(async (freeze) => {
    // 8. Notify student (best-effort)
    try {
      await notify({
        userId: profile.user.id,
        type:   'FREEZE_CREATED',
        title:  'Заморозка создана',
        body:   params.type === 'LESSON_SKIP'
          ? 'Урок заморожен — кредит не будет списан.'
          : 'Период заморозки активирован — уроки в этот период не будут списывать кредиты.',
        data: { freezeId: freeze.id, type: params.type },
      });
    } catch (err) {
      log.warn({ err, freezeId: freeze.id }, 'FREEZE_CREATED notification failed');
    }
    return freeze;
  });
}

// ─── createOpenEndedFreeze (admin-toggle wrapper) ─────────────────────────────

/**
 * Creates an open-ended PERIOD freeze (startDate=now, endDate=null) for admin account-toggle.
 * Bypasses deadline and overlap checks. Sends ACCOUNT_FROZEN notification.
 * Delegates to createFreeze with skipDeadlineCheck + isAdminToggle flags.
 */
export async function createOpenEndedFreeze(params: {
  studentProfileId: number;
  schoolId: number;
  actor: FreezeActor;
  frozenAt?: Date;
  reason?: string;
  client?: DbClient;
}) {
  return createFreeze({
    studentProfileId: params.studentProfileId,
    schoolId:         params.schoolId,
    actor:            params.actor,
    type:             'PERIOD',
    startDate:        params.frozenAt ?? new Date(),
    endDate:          null,
    reason:           params.reason,
    skipDeadlineCheck: true,
    client:            params.client,
  });
}

// ─── cancelFreeze ─────────────────────────────────────────────────────────────

export interface CancelFreezeParams {
  freezeId: number;
  schoolId: number;
  actor: FreezeActor;
  reason?: string;
  client?: DbClient;
}

export async function cancelFreeze(params: CancelFreezeParams) {
  const reason = requireAuditableReason('FREEZE_CANCELLED', params.reason);
  const client = (params.client ?? prismaDefault) as PrismaClient;

  const freeze = await client.studentFreeze.findFirst({
    where: { id: params.freezeId, schoolId: params.schoolId },
    include: {
      studentProfile: { include: { user: { select: { id: true } } } },
    },
  });
  if (!freeze) throw Object.assign(new Error('FREEZE_NOT_FOUND'), { httpStatus: 404 });
  if (freeze.status === 'CANCELLED') {
    throw Object.assign(new Error('FREEZE_ALREADY_CANCELLED'), { httpStatus: 409 });
  }

  // Actor check: Teacher cannot cancel (BR-09)
  if (params.actor.role === 'TEACHER') {
    throw Object.assign(new Error('FREEZE_CANCEL_FORBIDDEN'), { httpStatus: 403 });
  }

  // Non-creator non-admins cannot cancel (only Creator / Admin / Owner / Superadmin)
  const isAdminLike = ['SUPERADMIN', 'OWNER', 'ADMIN'].includes(params.actor.role);
  const isCreator = freeze.createdById === params.actor.userId;
  if (!isAdminLike && !isCreator) {
    throw Object.assign(new Error('FREEZE_CANCEL_FORBIDDEN'), { httpStatus: 403 });
  }

  // Deadline check for cancellation (BR-06)
  const { timezone, deadlineHours } = await loadSchoolConfig(client, params.schoolId);
  const now = new Date();

  if (freeze.type === 'LESSON_SKIP' && freeze.lessonSessionId) {
    const session = await client.lessonSession.findFirst({
      where: { id: freeze.lessonSessionId, deletedAt: null },
      select: { date: true, startTimeSnap: true, lessonBlock: { select: { startTime: true } } },
    });
    if (session) {
      const sessionStart = buildSessionStart(
        session.date,
        session.startTimeSnap ?? session.lessonBlock.startTime,
        timezone,
      );
      const deadline = getDeadline(sessionStart, deadlineHours);
      if (now > deadline) {
        throw Object.assign(
          new Error('FREEZE_CANCEL_DEADLINE_PASSED'),
          { httpStatus: 422, details: { deadline: deadline.toISOString(), deadlineHours } },
        );
      }
    }
  } else if (freeze.type === 'PERIOD' && freeze.startDate) {
    // Find the nearest future session within the period
    const nextSession = await client.lessonSession.findFirst({
      where: {
        schoolId: params.schoolId,
        date: {
          gte: now,
          ...(freeze.endDate ? { lte: freeze.endDate } : {}),
        },
        deletedAt: null,
        status: { not: 'CANCELLED' },
        lessonBlock: {
          studentGroup: {
            students: { some: { id: freeze.studentProfileId } },
          },
        },
      },
      orderBy: { date: 'asc' },
      select: {
        id: true, date: true, startTimeSnap: true,
        lessonBlock: { select: { startTime: true } },
      },
    });
    if (nextSession) {
      const sessionStart = buildSessionStart(
        nextSession.date,
        nextSession.startTimeSnap ?? nextSession.lessonBlock.startTime,
        timezone,
      );
      const deadline = getDeadline(sessionStart, deadlineHours);
      if (now > deadline) {
        throw Object.assign(
          new Error('FREEZE_CANCEL_DEADLINE_PASSED'),
          { httpStatus: 422, details: { deadline: deadline.toISOString(), deadlineHours } },
        );
      }
    }
  }

  const studentUserId = freeze.studentProfile.user.id;

  // Product decision (CRIT-1): cancelFreeze is forward-only.
  // Past FROZEN attendance records are historical facts and are NOT retroactively deducted.
  // Credit corrections for past frozen lessons must go through the explicit credit correction/ledger flow.
  // This preserves audit integrity and prevents retroactive balance mutations.
  return client.$transaction(async (tx) => {
    const dbClient = tx as unknown as PrismaClient;
    await dbClient.$executeRaw`SELECT id FROM "StudentProfile" WHERE id = ${freeze.studentProfileId} FOR UPDATE`;

    const updated = await dbClient.studentFreeze.update({
      where: { id: params.freezeId },
      data: {
        status:       'CANCELLED',
        cancelledById: params.actor.userId,
        cancelledAt:  new Date(),
      },
    });

    // Sync legacy cache: if no other ACTIVE freezes remain, unset isFrozen
    const remaining = await dbClient.studentFreeze.count({
      where: { studentProfileId: freeze.studentProfileId, status: 'ACTIVE' },
    });
    if (remaining === 0) {
      await dbClient.studentProfile.update({
        where: { id: freeze.studentProfileId },
        data: { isFrozen: false, frozenAt: null },
      });
    }

    await logScheduleAction({
      client:     dbClient,
      schoolId:   params.schoolId,
      userId:     params.actor.userId,
      action:     'FREEZE_CANCELLED',
      entityType: 'student',
      before:     { status: 'ACTIVE' },
      after: {
        freezeId:         params.freezeId,
        studentProfileId: freeze.studentProfileId,
        cancelledById:    params.actor.userId,
      },
      reason: reason,
    });

    return updated;
  }).then(async (updated) => {
    try {
      await notify({
        userId: studentUserId,
        type:   'FREEZE_CANCELLED',
        title:  'Заморозка отменена',
        body:   'Ваша заморозка была отменена. Следующие уроки будут списывать кредиты в обычном режиме.',
        data:   { freezeId: params.freezeId },
      });
    } catch (err) {
      log.warn({ err, freezeId: params.freezeId }, 'FREEZE_CANCELLED notification failed');
    }
    return updated;
  });
}

// ─── cancelAllActiveFreezes (legacy admin-toggle wrapper) ─────────────────────

/**
 * Cancels ALL ACTIVE freezes for a student.
 * Used by the legacy reverseFreeze() in scheduleLifecycleService.
 * No deadline enforcement — this is an admin account-toggle.
 */
export async function cancelAllActiveFreezes(params: {
  studentProfileId: number;
  schoolId: number;
  actor: FreezeActor;
  reason?: string;
  client?: DbClient;
}) {
  const client = (params.client ?? prismaDefault) as PrismaClient;

  const profile = await client.studentProfile.findFirst({
    where: { id: params.studentProfileId, deletedAt: null, user: { schoolId: params.schoolId } },
    include: { user: { select: { id: true } } },
  });
  if (!profile) throw Object.assign(new Error('STUDENT_NOT_FOUND'), { httpStatus: 404 });

  return client.$transaction(async (tx) => {
    const dbClient = tx as unknown as PrismaClient;
    await dbClient.$executeRaw`SELECT id FROM "StudentProfile" WHERE id = ${params.studentProfileId} FOR UPDATE`;

    await dbClient.studentFreeze.updateMany({
      where: { studentProfileId: params.studentProfileId, schoolId: params.schoolId, status: 'ACTIVE' },
      data: { status: 'CANCELLED', cancelledById: params.actor.userId, cancelledAt: new Date() },
    });

    await dbClient.studentProfile.update({
      where: { id: params.studentProfileId },
      data: { isFrozen: false, frozenAt: null },
    });

    await logScheduleAction({
      client:     dbClient,
      schoolId:   params.schoolId,
      userId:     params.actor.userId,
      action:     'FREEZE_CANCELLED',
      entityType: 'student',
      before:     { isFrozen: true },
      after: {
        studentProfileId: params.studentProfileId,
        cancelledAll:     true,
        cancelledById:    params.actor.userId,
      },
      reason: params.reason,
    });

    return profile;
  }).then(async (result) => {
    try {
      await notify({
        userId: profile.user.id,
        type:   'ACCOUNT_UNFROZEN',
        title:  'Заморозка снята',
        body:   'Заморозка вашего аккаунта снята. Уроки снова будут списывать кредиты в обычном режиме.',
        data:   {},
      });
    } catch (err) {
      log.warn({ err, studentProfileId: params.studentProfileId }, 'ACCOUNT_UNFROZEN notification failed');
    }
    return result;
  });
}

// ─── listFreezes ──────────────────────────────────────────────────────────────

export async function listFreezes(params: {
  studentProfileId: number;
  schoolId: number;
  status?: 'ACTIVE' | 'CANCELLED';
  client?: DbClient;
}) {
  const client = (params.client ?? prismaDefault) as PrismaClient;
  return client.studentFreeze.findMany({
    where: {
      studentProfileId: params.studentProfileId,
      schoolId:         params.schoolId,
      ...(params.status ? { status: params.status } : {}),
    },
    include: {
      createdBy:    { select: { id: true, firstName: true, lastName: true } },
      cancelledBy:  { select: { id: true, firstName: true, lastName: true } },
      lessonSession: { select: { id: true, date: true, startTimeSnap: true, lessonBlock: { select: { startTime: true, endTime: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
}
