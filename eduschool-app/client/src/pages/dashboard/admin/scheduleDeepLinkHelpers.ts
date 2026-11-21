import { weekKey, type useSchedule } from '../../../hooks/useSchedule';
import type { SchedGroup } from '../../../components/schedule/scheduleTypes';

type Sched = ReturnType<typeof useSchedule>;
type PolicySlot = { id: number; s: string; e: string };

// Pure helpers behind the Settings → Policy Impact "Открыть" deep-link and the
// Operational Control panel's policy-conflict actions. All take `sched` (or its
// derived fields) explicitly instead of closing over component state, so they
// don't need to live inside Schedule.tsx.

export function dayIndexFromIso(sched: Pick<Sched, 'aDays'>, dateISO: string): number {
  const date = new Date(`${dateISO}T12:00:00`);
  if (Number.isNaN(date.getTime())) return sched.aDays[0] ?? 0;
  return (date.getDay() + 6) % 7;
}

export function normalizeTime(value: string): string {
  return value.slice(0, 5);
}

export function policyWeekForDate(dateISO: string): string {
  return weekKey(new Date(`${dateISO}T12:00:00`));
}

export function findPolicyGroup(
  sched: Pick<Sched, 'G'>,
  blockId: number,
  studentGroupId?: number | null,
): SchedGroup | null {
  const groups = Object.values(sched.G);
  const exact = groups.find(g => {
    const ids = [g.id, g.grammarBlockId, g.clubBlockId, ...(g.linkedIds ?? [])].filter((id): id is number => id != null);
    return ids.includes(blockId);
  });
  if (exact) return exact;
  return groups.find(g => studentGroupId != null && g.studentGroupId === studentGroupId) ?? null;
}

export function policyEditDayForGroup(
  sched: Pick<Sched, 'aDays'>,
  group: SchedGroup,
  blockId: number,
  focusDate?: string | null,
): number {
  if (focusDate) return dayIndexFromIso(sched, focusDate);
  const grammarIds = [group.id, group.grammarBlockId].filter((id): id is number => id != null);
  const clubIds = [group.clubBlockId, ...(group.linkedIds ?? [])].filter((id): id is number => id != null);
  if (clubIds.includes(blockId)) return group.clubDays[0] ?? group.grammarDays[0] ?? sched.aDays[0] ?? 0;
  if (grammarIds.includes(blockId)) return group.grammarDays[0] ?? group.clubDays[0] ?? sched.aDays[0] ?? 0;
  return group.grammarDays[0] ?? group.clubDays[0] ?? sched.aDays[0] ?? 0;
}

export function findPolicySlot(
  sched: Pick<Sched, 'slots' | 'legacySlotIds'>,
  startTime: string,
  endTime: string,
  slots: PolicySlot[] = sched.slots.filter(s => !sched.legacySlotIds.includes(s.id)),
) {
  const policySlots = slots;
  const exact = policySlots.find(slot =>
    normalizeTime(slot.s) === normalizeTime(startTime)
    && normalizeTime(slot.e) === normalizeTime(endTime)
  );
  const sameStart = policySlots.find(slot => normalizeTime(slot.s) === normalizeTime(startTime));
  const overlapping = policySlots.find(slot =>
    normalizeTime(slot.s) < normalizeTime(endTime)
    && normalizeTime(startTime) < normalizeTime(slot.e)
  );
  return exact ?? sameStart ?? overlapping ?? policySlots[0] ?? { id: 0, s: startTime, e: endTime };
}
