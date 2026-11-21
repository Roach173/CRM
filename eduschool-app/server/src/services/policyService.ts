import prisma from '../lib/prisma';
import { getDayOfWeekInTz, getNextMondayDateInTz } from '../lib/tzUtils';
import { createLogger } from '../lib/logger';
import { Prisma } from '@prisma/client';

const log = createLogger('policy');
const ROLLING_DAYS = 14;
type DbClient = typeof prisma | Prisma.TransactionClient;

export type PolicySnapshot = {
  activeDays: number[];
  workStart: string;
  workEnd: string;
  slotDuration: number;
};

// Request-scoped memo over getPolicyForDate, deduped by calendar date (UTC).
// Loops over sessions/horizon days resolve the same handful of dates; calling
// getPolicyForDate per iteration cost 1–2 DB round-trips each (policy-conflicts
// was ~1.4s for 300 sessions). Create one resolver per request — never cache
// across requests, policies are editable.
export function makeCachedPolicyResolver(schoolId: number, client: DbClient = prisma) {
  const cache = new Map<string, Promise<PolicySnapshot>>();
  return (date: Date): Promise<PolicySnapshot> => {
    const key = date.toISOString().slice(0, 10);
    let hit = cache.get(key);
    if (!hit) {
      hit = getPolicyForDate(schoolId, date, client);
      cache.set(key, hit);
    }
    return hit;
  };
}

// ─── getPolicyForDate ─────────────────────────────────────────────────────────
// Returns the school policy that was active on a given date.
// Uses SchoolSchedulePolicy with closed-interval pattern:
//   effectiveFrom <= date AND (effectiveTo IS NULL OR effectiveTo > date)
// Falls back to current School columns if no policy version found.
export async function getPolicyForDate(
  schoolId: number,
  date: Date,
  client: DbClient = prisma,
): Promise<PolicySnapshot> {
  const policy = await client.schoolSchedulePolicy.findFirst({
    where: {
      schoolId,
      effectiveFrom: { lte: date },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: date } }],
    },
    orderBy: [
      { effectiveFrom: 'desc' },
      { createdAt: 'desc' },
      { id: 'desc' },
    ],
    select: { activeDays: true, workStart: true, workEnd: true, slotDuration: true },
  });
  if (policy) return policy;

  const school = await client.school.findFirstOrThrow({
    where: { id: schoolId, deletedAt: null },
    select: { activeDays: true, workStart: true, workEnd: true, slotDuration: true },
  });
  return {
    activeDays: school.activeDays.length > 0 ? school.activeDays : [0, 1, 2, 3, 4],
    workStart: school.workStart,
    workEnd: school.workEnd,
    slotDuration: school.slotDuration,
  };
}

export function generatePolicySlotDefs(policy: PolicySnapshot) {
  const parse = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  const startMin = parse(policy.workStart);
  const endMin = parse(policy.workEnd);
  const dur = Math.max(30, Math.min(240, policy.slotDuration));
  if (startMin >= endMin || dur <= 0) return [];
  const slots: { startTime: string; endTime: string; order: number }[] = [];
  let cur = startMin; let order = 0;
  while (cur + dur <= endMin) {
    slots.push({ startTime: fmt(cur), endTime: fmt(cur + dur), order });
    cur += dur; order++;
  }
  return slots;
}

// ─── getFirstWorkingDateStr ───────────────────────────────────────────────────
// Returns YYYY-MM-DD of the first day that is active under the new activeDays
// policy, starting from nextMondayStr (inclusive). Schema: 0=Mon…6=Sun.
// If activeDays is empty, returns nextMondayStr (fail-safe).
export function getFirstWorkingDateStr(nextMondayStr: string, activeDays: number[]): string {
  if (activeDays.length === 0) return nextMondayStr;
  const activeSet = new Set(activeDays);
  const [y, m, d] = nextMondayStr.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let offset = 0; offset <= 6; offset++) {
    const candidate = new Date(Date.UTC(y, m - 1, d + offset));
    // JS getUTCDay(): Sun=0,Mon=1,…,Sat=6 → schema Mon=0,…,Sun=6
    const schemaDow = (candidate.getUTCDay() + 6) % 7;
    if (activeSet.has(schemaDow)) {
      return `${candidate.getUTCFullYear()}-${pad(candidate.getUTCMonth() + 1)}-${pad(candidate.getUTCDate())}`;
    }
  }
  return nextMondayStr;
}

// ─── computePolicyImpact ──────────────────────────────────────────────────────
// Calculates the consequences of a proposed policy change BEFORE saving.
// Counts sessions/blocks that will be outside the new policy starting from
// policyEffectiveFrom (next Monday). No mutations — informational only.
export async function computePolicyImpact(
  schoolId: number,
  proposed: {
    activeDays: number[];
    workStart?: string;
    workEnd?: string;
    slotDuration?: number;
  },
  policyEffectiveFrom?: Date,
) {
  const school = await prisma.school.findFirst({
    where: { id: schoolId, deletedAt: null },
    select: { timezone: true },
  });
  const currentPolicy = await getPolicyForDate(schoolId, policyEffectiveFrom ?? new Date());
  const currentDays = currentPolicy.activeDays.length > 0 ? currentPolicy.activeDays : [0, 1, 2, 3, 4, 5];
  const tz = school?.timezone ?? 'UTC';

  // Effective date: use provided date (nextMonday) or fall back to now
  const effectiveFrom = policyEffectiveFrom ?? new Date();
  const { dateStr: nextMondayStr } = getNextMondayDateInTz(tz);
  const firstWorkingDate = getFirstWorkingDateStr(nextMondayStr, proposed.activeDays);

  const removedDays = currentDays.filter(d => !proposed.activeDays.includes(d));
  const activeSet = new Set(proposed.activeDays);

  const parseMin = (t: string) => {
    const [h, m] = (t ?? '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  // Count future UPCOMING sessions outside new activeDays (from effectiveFrom)
  let sessionsOutsideDays = 0;
  let sessionsOutsideHours = 0;
  const windowEnd = new Date(effectiveFrom.getTime() + ROLLING_DAYS * 24 * 60 * 60 * 1000);

  if (removedDays.length > 0 || proposed.workStart || proposed.workEnd) {
    const futureSessions = await prisma.lessonSession.findMany({
      where: {
        schoolId,
        status: 'UPCOMING',
        date: { gte: effectiveFrom, lte: windowEnd },
        deletedAt: null,
      },
      select: {
        id: true,
        date: true,
        startTimeSnap: true,
        endTimeSnap: true,
        lessonBlock: { select: { startTime: true, endTime: true } },
      },
    });

    for (const s of futureSessions) {
      const dow = getDayOfWeekInTz(s.date, tz);
      if (!activeSet.has(dow)) sessionsOutsideDays++;

      if (proposed.workStart && proposed.workEnd) {
        const wsMin = parseMin(proposed.workStart);
        const weMin = parseMin(proposed.workEnd);
        const sm = parseMin(s.startTimeSnap ?? s.lessonBlock?.startTime ?? '00:00');
        const em = parseMin(s.endTimeSnap ?? s.lessonBlock?.endTime ?? '23:59');
        if (sm < wsMin || em > weMin) sessionsOutsideHours++;
      }
    }
  }

  // Blocks outside new policy (days or hours).
  // Only active blocks count — same definition used across the schedule module:
  // deletedAt: null AND endDate: null (blocks with a past endDate are closed
  // history from a prior reschedule/split and must not surface here).
  const wsMin = proposed.workStart ? parseMin(proposed.workStart) : null;
  const weMin = proposed.workEnd ? parseMin(proposed.workEnd) : null;

  const allBlocks = await prisma.lessonBlock.findMany({
    where: { schoolId, deletedAt: null, endDate: null },
    select: {
      id: true, startTime: true, endTime: true, days: true, type: true, studentGroupId: true,
      studentGroup: { select: { level: true } },
    },
  });

  const blocksOutsideDays = allBlocks.filter(b => b.days.some(d => !activeSet.has(d))).length;
  let blocksOutsideHours = 0;
  const affectedBlockIds: number[] = [];
  const affectedGroups: {
    blockId: number;
    studentGroupId: number | null;
    groupName: string | null;
    level: string | null;
    type: string;
    reason: 'NON_WORKING_DAY' | 'OUTSIDE_WORK_HOURS';
    days: number[];
    startTime: string;
    endTime: string;
  }[] = [];

  for (const b of allBlocks) {
    const daysOut = b.days.some(d => !activeSet.has(d));
    const bsMin = parseMin(b.startTime);
    const beMin = parseMin(b.endTime);
    const timeOut = wsMin !== null && weMin !== null && (bsMin < wsMin || beMin > weMin);
    if (daysOut || timeOut) {
      affectedBlockIds.push(b.id);
      if (timeOut) blocksOutsideHours++;
      affectedGroups.push({
        blockId: b.id,
        studentGroupId: b.studentGroupId,
        groupName: b.studentGroup?.level ?? null,
        level: b.studentGroup?.level ?? null,
        type: b.type,
        reason: daysOut ? 'NON_WORKING_DAY' : 'OUTSIDE_WORK_HOURS',
        days: b.days,
        startTime: b.startTime,
        endTime: b.endTime,
      });
    }
  }

  return {
    removedDays,
    sessionsOutsideDays,
    sessionsOutsideHours,
    blocksOutsideDays,
    blocksOutsideHours,
    affectedBlockIds,
    affectedGroups,
    policyEffectiveFrom: effectiveFrom.toISOString(),
    firstWorkingDate,
  };
}

// Legacy compatibility shim. Policy changes are warnings only and must not
// invalidate sessions; explicit structural/data-integrity workflows handle
// INVALIDATED separately.
export async function invalidateSessionsForRemovedDays(
  schoolId: number,
  removedDays: number[]
): Promise<{ invalidated: number; protected: number }> {
  log.info(
    { event: 'POLICY_INVALIDATION_DISABLED', schoolId, removedDays },
    'Policy activeDays change did not invalidate sessions'
  );

  return { invalidated: 0, protected: 0 };
}
