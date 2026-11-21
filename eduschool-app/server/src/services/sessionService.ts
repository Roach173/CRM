import prisma from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { getActiveExceptions, isDateExcepted } from './exceptionService';
import { blockGenerationBlocker } from '../lib/blockStateMachine';
import { withSpan } from '../lib/otel';
import { getPolicyForDate } from './policyService';
import { createLogger } from '../lib/logger';

const log = createLogger('sessionService');

type DbClient = typeof prisma | Prisma.TransactionClient;

export const ROLLING_DAYS = 14;

// ─── Effective Teacher SOT ─────────────────────────────────────────────────────
//
// Single canonical answer to "who is the teacher for this session?".
//
// Rule:
//   • isManualTeacher=true  → teacherId (substitute override wins)
//   • isManualTeacher=false → teacherIdSnap (set at creation; propagated by
//     syncSessionsForBlock self-healing whenever block.teacherId changes)
//
// LessonBlock.teacherId is only a template for future session generation.
// It is NOT the effective teacher for already-created sessions.
// Historical sessions (COMPLETED/LOCKED/CANCELLED) are never rewritten.
export function getEffectiveSessionTeacherId(session: {
  teacherId: number | null;
  teacherIdSnap: number | null;
  isManualTeacher: boolean;
}): number | null {
  if (session.isManualTeacher) return session.teacherId;
  return session.teacherIdSnap;
}

export interface SyncSessionsResult {
  skipped: boolean;
  reason?: string;
  created: number;
  invalidated: number;
}

async function getGroupSessionCreationBlocker(client: DbClient, studentGroupId?: number | null): Promise<string | null> {
  if (!studentGroupId) return null;

  const group = await client.studentGroup.findUnique({
    where: { id: studentGroupId },
    select: { status: true, deletedAt: true },
  });

  if (!group || group.deletedAt) return 'Cannot create sessions for archived group';
  if (group.status === 'PAUSED') return 'Cannot create sessions for paused group';
  if (group.status === 'COMPLETED') return 'Cannot create sessions for completed group';
  return null;
}

// Block-level generation guard: delegates to blockStateMachine.
// Called by syncSessionsForBlock before any session generation.
export function getBlockSessionCreationBlocker(blockStatus: string): string | null {
  return blockGenerationBlocker(blockStatus as any);
}

export function getSessionDates(
  days: number[],
  startDate: Date,
  endDate: Date | null,
  holidays: string[],
  from: Date,
  to: Date,
  timeZone: string
): Date[] {
  const startStr = formatInTimeZone(startDate, timeZone, 'yyyy-MM-dd');
  const fromStr = formatInTimeZone(from, timeZone, 'yyyy-MM-dd');
  
  const startNorm = new Date(`${startStr}T12:00:00.000Z`);
  const fromNorm = new Date(`${fromStr}T12:00:00.000Z`);
  
  const startLimit = startNorm > fromNorm ? startNorm : fromNorm;
  let current = new Date(startLimit);

  const toStr = formatInTimeZone(to, timeZone, 'yyyy-MM-dd');
  let endLimitNorm = new Date(`${toStr}T12:00:00.000Z`);

  if (endDate) {
    const endStr = formatInTimeZone(endDate, timeZone, 'yyyy-MM-dd');
    const endNorm = new Date(`${endStr}T12:00:00.000Z`);
    if (endNorm < endLimitNorm) {
      endLimitNorm = endNorm;
    }
  }

  const dates: Date[] = [];
  while (current <= endLimitNorm) {
    if (current < startNorm) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }
    const dayIndex = (current.getUTCDay() + 6) % 7;
    if (days.includes(dayIndex)) {
      const dateStr = current.toISOString().split('T')[0];
      if (!holidays.includes(dateStr)) dates.push(new Date(current));
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export async function snapshotNewSessions(
  client: DbClient,
  blockId: number,
  schoolId: number,
  studentGroupId: number | null,
  dates: Date[]
) {
  if (!studentGroupId || dates.length === 0) return;

  const activeMembers = await client.groupMembership.findMany({
    where: {
      studentGroupId,
      status: 'ACTIVE',
      studentProfile: { deletedAt: null },
      studentGroup: { deletedAt: null }, // never roster a soft-deleted group
    },
    select: { studentProfileId: true },
  });
  if (activeMembers.length === 0) return;

  const newSessions = await client.lessonSession.findMany({
    where: { lessonBlockId: blockId, date: { in: dates } },
    select: { id: true },
  });

  const data = newSessions.flatMap(s =>
    activeMembers.map(m => ({
      schoolId,
      lessonSessionId: s.id,
      studentProfileId: m.studentProfileId,
    }))
  );

  if (data.length > 0) {
    await client.sessionStudent.createMany({ data, skipDuplicates: true });
  }
}

// ─── validateSessionDate ──────────────────────────────────────────────────────
// Single source of truth for "is this date valid for this block?"
//
// Checks (in order):
//   1. School active days
//   2. Legacy school.settings.holidays (backward-compat)
//   3. ScheduleException (canonical; overrides legacy holidays)
//   4. Block.days match
//   5. Block startDate / endDate bounds
//
// blockContext is optional — when provided, TEACHER/CABINET/GROUP exceptions are
// also evaluated. Always pass it from ensureSingleSession and syncSessionsForBlock.
export async function validateSessionDate(
  schoolId: number,
  block: { days: number[]; startDate: Date | null; endDate: Date | null },
  dateStr: string, // "YYYY-MM-DD"
  blockContext?: { teacherId?: number | null; cabinetId?: number | null; groupId?: number | null }
): Promise<{ valid: true } | { valid: false; reason: string }> {
  const school = await prisma.school.findFirst({
    where: { id: schoolId, deletedAt: null },
    select: { timezone: true, settings: true },
  });
  if (!school) return { valid: false, reason: 'School not found' };

  const timeZone = school.timezone || 'UTC';

  const d = new Date(`${dateStr}T12:00:00.000Z`);
  const dayIndex = (d.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun

  const policy = await getPolicyForDate(schoolId, d);
  const schoolActiveDays: number[] =
    (policy.activeDays ?? []).length > 0 ? policy.activeDays : [0, 1, 2, 3, 4];
  if (!schoolActiveDays.includes(dayIndex)) {
    return { valid: false, reason: 'Date falls on a school non-working day' };
  }

  // Legacy holidays (backward-compat — settings JSON)
  const holidays: string[] = Array.isArray((school.settings as any)?.holidays)
    ? (school.settings as any).holidays
    : [];
  if (holidays.includes(dateStr)) return { valid: false, reason: 'Date is a holiday' };

  // ScheduleException check — canonical working-date authority.
  // Both SCHOOL-scope and block-specific exceptions are evaluated.
  const exceptions = await getActiveExceptions(schoolId, d, d);
  if (exceptions.length > 0 && isDateExcepted(d, exceptions, {
    teacherId:  blockContext?.teacherId  ?? undefined,
    cabinetId:  blockContext?.cabinetId  ?? undefined,
    groupId:    blockContext?.groupId    ?? undefined,
  })) {
    return { valid: false, reason: 'Date is blocked by a schedule exception' };
  }

  if (!block.days.includes(dayIndex)) {
    return { valid: false, reason: 'Date does not match block schedule' };
  }

  if (block.startDate) {
    const startStr = formatInTimeZone(block.startDate, timeZone, 'yyyy-MM-dd');
    if (dateStr < startStr) return { valid: false, reason: 'Date is before block start date' };
  }

  if (block.endDate) {
    const endStr = formatInTimeZone(block.endDate, timeZone, 'yyyy-MM-dd');
    if (dateStr > endStr) return { valid: false, reason: 'Date is after block end date' };
  }

  return { valid: true };
}

// ─── ensureSingleSession ──────────────────────────────────────────────────────
// Idempotent: returns existing session or creates a new one.
// Validates all invariants only when creating — existing sessions are always returned as-is.
// All on-demand session creation must go through here; never create sessions inline in routes.
export async function ensureSingleSession(
  block: {
    id: number;
    schoolId: number;
    days: number[];
    startDate: Date | null;
    endDate: Date | null;
    teacherId: number | null;
    cabinetId: number | null;
    startTime: string | null;
    endTime: string | null;
    studentGroupId?: number | null;
  },
  dateStr: string // "YYYY-MM-DD"
): Promise<{ session: { id: number; date: Date; status: string }; created: boolean } | { error: string }> {
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const dayEnd   = new Date(`${dateStr}T23:59:59.999Z`);
  const targetDate = new Date(`${dateStr}T12:00:00.000Z`);

  // Return existing session without re-validating (e.g. makeup sessions on unusual days)
  const existing = await prisma.lessonSession.findFirst({
    where: { lessonBlockId: block.id, date: { gte: dayStart, lte: dayEnd }, deletedAt: null },
    select: { id: true, date: true, status: true },
  });
  if (existing) return { session: existing, created: false };

  // New session — must pass all invariants before creation
  const groupBlocker = await getGroupSessionCreationBlocker(prisma, block.studentGroupId);
  if (groupBlocker) return { error: groupBlocker };

  // Pass block context so ScheduleException (teacher/cabinet/group-specific) is also checked.
  const validation = await validateSessionDate(block.schoolId, block, dateStr, {
    teacherId:  block.teacherId,
    cabinetId:  block.cabinetId,
    groupId:    block.studentGroupId,
  });
  if (!validation.valid) return { error: 'reason' in validation ? validation.reason : 'Invalid session date' };

  let created: { id: number; date: Date; status: string };
  try {
    created = await prisma.lessonSession.create({
      data: {
        schoolId: block.schoolId,
        lessonBlockId: block.id,
        date: targetDate,
        status: 'UPCOMING',
        teacherIdSnap: block.teacherId ?? null,
        cabinetIdSnap: block.cabinetId ?? null,
        startTimeSnap: block.startTime ?? null,
        endTimeSnap: block.endTime ?? null,
      },
      select: { id: true, date: true, status: true },
    });
  } catch (err: any) {
    // P1.6: Конкурентный запрос уже создал сессию (unique constraint P2002) — возвращаем существующую
    if (err?.code === 'P2002') {
      const race = await prisma.lessonSession.findFirst({
        where: { lessonBlockId: block.id, date: { gte: dayStart, lte: dayEnd }, deletedAt: null },
        select: { id: true, date: true, status: true },
      });
      if (race) return { session: race, created: false };
    }
    throw err;
  }

  await snapshotNewSessions(prisma, block.id, block.schoolId, block.studentGroupId ?? null, [targetDate]);

  return { session: created, created: true };
}

export async function cleanupInvalidSessions(block: {
  id: number;
  schoolId: number;
  days: number[];
  startDate: Date | null;
  endDate: Date | null;
}) {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);

  const future = await prisma.lessonSession.findMany({
    where: { lessonBlockId: block.id, date: { gte: now }, status: 'UPCOMING', deletedAt: null },
    select: { id: true, date: true },
  });
  if (future.length === 0) return;

  const school = await prisma.school.findFirst({
    where: { id: block.schoolId, deletedAt: null },
    select: { timezone: true },
  });
  if (!school) throw new Error(`School ${block.schoolId} not found`);
  const timeZone = school.timezone || 'UTC';

  // block.days is the source of truth for generation; policy mismatches are warnings only,
  // not a retroactive constraint on already-created sessions.
  const validDays = new Set(block.days);

  const toDelete = future
    .filter(s => {
      const sDateStr = formatInTimeZone(s.date, timeZone, 'yyyy-MM-dd');
      const bStartStr = block.startDate ? formatInTimeZone(block.startDate, timeZone, 'yyyy-MM-dd') : null;
      const bEndStr = block.endDate ? formatInTimeZone(block.endDate, timeZone, 'yyyy-MM-dd') : null;

      if (bStartStr && sDateStr < bStartStr) return true;
      if (bEndStr && sDateStr > bEndStr) return true;
      
      const dayIndex = (new Date(`${sDateStr}T12:00:00.000Z`).getUTCDay() + 6) % 7;
      if (!validDays.has(dayIndex)) return true;
      
      return false;
    })
    .map(s => s.id);

  if (toDelete.length > 0) {
    // Check both attendance AND payroll links — either constitutes financial data
    const [attended, paid] = await Promise.all([
      prisma.attendance.findMany({
        where: { lessonSessionId: { in: toDelete } },
        select: { lessonSessionId: true },
      }),
      prisma.teacherPaymentLesson.findMany({
        where: { lessonSessionId: { in: toDelete } },
        select: { lessonSessionId: true },
      }),
    ]);
    const financialIds = new Set([
      ...attended.map(a => a.lessonSessionId),
      ...paid.map(p => p.lessonSessionId),
    ]);
    // INVALIDATED instead of hard-delete — preserves history, hides from grid
    const canInvalidate = toDelete.filter(id => !financialIds.has(id));
    if (canInvalidate.length > 0) {
      await prisma.lessonSession.updateMany({
        where: { id: { in: canInvalidate } },
        data: { status: 'INVALIDATED' },
      });
    }
  }
}

export async function syncSessionsForBlock(block: {
  id: number;
  schoolId: number;
  days: number[];
  startDate: Date | null;
  endDate: Date | null;
  studentGroupId?: number | null;
  teacherId?: number | null;
  cabinetId?: number | null;
  startTime?: string;
  endTime?: string;
  status?: string;
}): Promise<SyncSessionsResult> {
  if (!block.startDate) return { skipped: true, reason: 'Block has no start date', created: 0, invalidated: 0 };

  // Block state machine: only UPCOMING blocks generate sessions.
  if (block.status) {
    const blockBlocker = getBlockSessionCreationBlocker(block.status);
    if (blockBlocker) return { skipped: true, reason: blockBlocker, created: 0, invalidated: 0 };
  }

  const groupBlocker = await getGroupSessionCreationBlocker(prisma, block.studentGroupId);
  if (groupBlocker) return { skipped: true, reason: groupBlocker, created: 0, invalidated: 0 };

  const school = await prisma.school.findFirst({ where: { id: block.schoolId, deletedAt: null } });
  const holidays: string[] = Array.isArray((school?.settings as any)?.holidays)
    ? (school?.settings as any).holidays
    : [];
  const timeZone = school?.timezone || 'Asia/Bishkek';

  // block.days is the source of truth for which days sessions should be generated.
  // policy active days only gate NEW block creation; changing policy must not stop
  // existing blocks from generating sessions on their configured days.
  const effectiveDays = block.days;
  if (effectiveDays.length === 0) {
    return { skipped: true, reason: 'Block has no active days', created: 0, invalidated: 0 };
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + ROLLING_DAYS * 24 * 60 * 60 * 1000);

  const exceptions = await getActiveExceptions(block.schoolId, now, windowEnd);

  const rawDates = getSessionDates(effectiveDays, block.startDate, block.endDate, holidays, now, windowEnd, timeZone);
  const desired = exceptions.length > 0
    ? rawDates.filter(d => !isDateExcepted(d, exceptions, {
        teacherId: block.teacherId ?? undefined,
        cabinetId: block.cabinetId ?? undefined,
        groupId: block.studentGroupId ?? undefined,
      }))
    : rawDates;
  const desiredSet = new Set(desired.map(d => d.toISOString().split('T')[0]));

  const existing = await prisma.lessonSession.findMany({
    where: { lessonBlockId: block.id, date: { gte: now, lte: windowEnd }, deletedAt: null },
    select: {
      id: true,
      date: true,
      status: true,
      isManualTeacher: true,
      isManualCabinet: true,
      isManualTime: true,
      isManualDate: true,
      dateOverrideFrom: true,
    },
  });

  const suppressedDesiredDates = new Set(
    existing
      .filter(s => s.status === 'UPCOMING' && s.isManualDate && s.dateOverrideFrom)
      .map(s => s.dateOverrideFrom!.toISOString().split('T')[0])
  );

  // Group sessions by date to detect duplicates caused by concurrent cron runs.
  // Keep the oldest session (lowest id) per date; collect extras for invalidation.
  const sessionsByDate = new Map<string, typeof existing[0][]>();
  for (const s of existing) {
    const dateStr = s.date.toISOString().split('T')[0];
    const bucket = sessionsByDate.get(dateStr) ?? [];
    bucket.push(s);
    sessionsByDate.set(dateStr, bucket);
  }

  const duplicatesToInvalidate: number[] = [];
  const existingByDate = new Map<string, typeof existing[0]>();
  for (const [dateStr, sessions] of sessionsByDate) {
    const sorted = sessions.slice().sort((a, b) => a.id - b.id);
    existingByDate.set(dateStr, sorted[0]); // canonical: oldest
    for (const extra of sorted.slice(1)) {
      if (extra.status === 'UPCOMING') duplicatesToInvalidate.push(extra.id);
    }
  }

  const toDelete = [...existingByDate.values()]
    .filter(s => s.status === 'UPCOMING' && !s.isManualDate && !desiredSet.has(s.date.toISOString().split('T')[0]))
    .map(s => s.id);

  const toCreate = desired.filter(d => {
    const dateStr = d.toISOString().split('T')[0];
    return !existingByDate.has(dateStr) && !suppressedDesiredDates.has(dateStr);
  });

  // Gather sessions to invalidate (UPCOMING only, never sessions with financial data)
  let canInvalidate: number[] = [];
  const allToDelete = [...toDelete, ...duplicatesToInvalidate];
  if (allToDelete.length > 0) {
    const [attended, creditLogged, paid] = await Promise.all([
      prisma.attendance.findMany({
        where: { lessonSessionId: { in: allToDelete } },
        select: { lessonSessionId: true },
      }),
      prisma.lessonCreditLog.findMany({
        where: { sessionId: { in: allToDelete } },
        select: { sessionId: true },
      }),
      prisma.teacherPaymentLesson.findMany({
        where: { lessonSessionId: { in: allToDelete } },
        select: { lessonSessionId: true },
      }),
    ]);
    const financialIds = new Set([
      ...attended.map(a => a.lessonSessionId),
      ...creditLogged.map(c => c.sessionId).filter((id): id is number => id != null),
      ...paid.map(p => p.lessonSessionId),
    ]);
    canInvalidate = allToDelete.filter(id => !financialIds.has(id));
  }

  // Atomic: invalidate stale/duplicate + create new in one transaction.
  // skipDuplicates makes the whole operation idempotent — safe to retry on failure.
  let createdCount = 0;
  let invalidatedCount = 0;
  if (canInvalidate.length > 0 || toCreate.length > 0) {
    await prisma.$transaction(async (tx) => {
      if (canInvalidate.length > 0) {
        const updated = await tx.lessonSession.updateMany({
          where: { id: { in: canInvalidate } },
          data: { status: 'INVALIDATED' },
        });
        invalidatedCount = updated.count;
      }
      if (toCreate.length > 0) {
        const created = await tx.lessonSession.createMany({
          data: toCreate.map(date => ({
            schoolId: block.schoolId,
            lessonBlockId: block.id,
            date,
            status: 'UPCOMING' as const,
            teacherIdSnap: block.teacherId ?? null,
            cabinetIdSnap: block.cabinetId ?? null,
            startTimeSnap: block.startTime ?? null,
            endTimeSnap: block.endTime ?? null,
          })),
          skipDuplicates: true,
        });
        createdCount = created.count;
        await snapshotNewSessions(tx, block.id, block.schoolId, block.studentGroupId ?? null, toCreate);
      }
    });
  }

  // 4. Self-healing: batch-обновление незаблокированных параметров.
  // Wrapped in a single $transaction — all three updateMany commit atomically.
  // Without a transaction, a server crash between calls could leave sessions with
  // inconsistent snapshots (e.g. teacher updated, cabinet not).
  const upcomingExisting = existing.filter(s => s.status === 'UPCOMING' && desiredSet.has(s.date.toISOString().split('T')[0]));
  let cleanUpcomingIds = new Set(upcomingExisting.map(s => s.id));
  if (upcomingExisting.length > 0) {
    const ids = upcomingExisting.map(s => s.id);
    const [attended, creditLogged, paid] = await Promise.all([
      prisma.attendance.findMany({
        where: { lessonSessionId: { in: ids } },
        select: { lessonSessionId: true },
      }),
      prisma.lessonCreditLog.findMany({
        where: { sessionId: { in: ids } },
        select: { sessionId: true },
      }),
      prisma.teacherPaymentLesson.findMany({
        where: { lessonSessionId: { in: ids } },
        select: { lessonSessionId: true },
      }),
    ]);
    const protectedIds = new Set([
      ...attended.map(a => a.lessonSessionId),
      ...creditLogged.map(c => c.sessionId).filter((id): id is number => id != null),
      ...paid.map(p => p.lessonSessionId),
    ]);
    cleanUpcomingIds = new Set(ids.filter(id => !protectedIds.has(id)));
  }

  const noManualTeacher  = upcomingExisting.filter(s => cleanUpcomingIds.has(s.id) && !s.isManualTeacher).map(s => s.id);
  const noManualCabinet  = upcomingExisting.filter(s => cleanUpcomingIds.has(s.id) && !s.isManualCabinet).map(s => s.id);
  const noManualTime     = upcomingExisting.filter(s => cleanUpcomingIds.has(s.id) && !s.isManualTime).map(s => s.id);

  const healOps = [
    ...(noManualTeacher.length > 0 ? [prisma.lessonSession.updateMany({
      where: { id: { in: noManualTeacher } },
      data: { teacherIdSnap: block.teacherId ?? null },
    })] : []),
    ...(noManualCabinet.length > 0 ? [prisma.lessonSession.updateMany({
      where: { id: { in: noManualCabinet } },
      data: { cabinetIdSnap: block.cabinetId ?? null },
    })] : []),
    ...(noManualTime.length > 0 ? [prisma.lessonSession.updateMany({
      where: { id: { in: noManualTime } },
      data: { startTimeSnap: block.startTime ?? null, endTimeSnap: block.endTime ?? null },
    })] : []),
  ];
  if (healOps.length > 0) {
    await prisma.$transaction(healOps);
  }

  return { skipped: false, created: createdCount, invalidated: invalidatedCount };
}

export async function extendAllBlockSessions() {
  return withSpan('cron.extendAllBlockSessions', async (span) => {
    const now = new Date();
    const horizon = new Date(now.getTime() + ROLLING_DAYS * 24 * 60 * 60 * 1000);

    const blocks = await prisma.lessonBlock.findMany({
      where: {
        deletedAt: null,
        // Only UPCOMING blocks generate sessions. COMPLETED/CANCELLED blocks are frozen.
        status: 'UPCOMING',
        startDate: { lte: horizon },
        OR: [{ endDate: null }, { endDate: { gte: now } }],
      },
      select: {
        id: true,
        schoolId: true,
        days: true,
        startDate: true,
        endDate: true,
        studentGroupId: true,
        teacherId: true,
        cabinetId: true,
        startTime: true,
        endTime: true,
        status: true,
      },
    });

    span.setAttribute('blockCount', blocks.length);

    let added = 0;
    const BATCH_SIZE = 50;
    for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
      const batch = blocks.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async block => {
          try {
            const before = await prisma.lessonSession.count({ where: { lessonBlockId: block.id, status: 'UPCOMING' } });
            await syncSessionsForBlock(block);
            const after = await prisma.lessonSession.count({ where: { lessonBlockId: block.id, status: 'UPCOMING' } });
            return Math.max(0, after - before);
          } catch (e) {
            log.error({ err: e, blockId: block.id }, 'cron: failed to sync block');
            return 0;
          }
        })
      );
      added += results.reduce((sum, n) => sum + n, 0);
    }

    span.setAttribute('sessionsAdded', added);
  });
}
