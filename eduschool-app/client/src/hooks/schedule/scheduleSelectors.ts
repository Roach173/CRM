import { timeRangesOverlap } from '../../utils/scheduleConflicts';
import { clubBlockIdOf, grammarBlockIdOf } from '../../components/schedule/scheduleTypes';
import { sessionKey } from './scheduleKeys';
import type { TimeSlot, SchedGroup, WeekSessionMeta } from '../../components/schedule/scheduleTypes';

export interface CellLessonCandidate {
  kind: 'grammar' | 'club';
  session: WeekSessionMeta | null;
  start: string;
  end: string;
}

export function groupClosedBeforeCell(g: SchedGroup, dk: string): boolean {
  const ge = g.endDate ? g.endDate.slice(0, 10) : null;
  if (!ge) return false;
  return g.status === 'COMPLETED' ? dk >= ge : dk > ge;
}

/**
 * Source of Truth for whether a block's card should render on this specific date.
 * LessonBlock is the plan for the recurring schedule; LessonSession is the fact for
 * a specific date. A session for the exact date always wins (covers cancellations,
 * reschedules, and makeups/ensured sessions on an otherwise-closed block) —
 * only in its absence does the block's own plan (startDate/groupClosedBeforeCell)
 * decide whether this date is even in scope.
 */
export function shouldShowGroupForDate(g: SchedGroup, dk: string, hasSessionForDate: boolean): boolean {
  if (hasSessionForDate) return true;
  if (!g.startDate) return true;
  const gs = g.startDate.slice(0, 10);
  if (dk < gs) return false;
  if (groupClosedBeforeCell(g, dk)) return false;
  return true;
}

// slotForTimeCache: memoized per data-generation by the caller (invalidated
// on the same deps that invalidate getGroupsInCell) — passed in explicitly so
// this stays a pure function of its arguments.
export function resolveSlotForTime(
  start: string,
  end: string,
  slots: TimeSlot[],
  slotForTimeCache: Map<string, TimeSlot | null>,
): TimeSlot | null {
  if (!start || !end) return null;
  const key = `${start}|${end}`;
  let hit = slotForTimeCache.get(key);
  if (hit === undefined) {
    hit = slots.find(s => s.s === start && s.e === end)
      ?? slots.find(s => timeRangesOverlap(s.s, s.e, start, end))
      ?? null;
    slotForTimeCache.set(key, hit);
  }
  return hit;
}

export function slotMatchesLesson(
  slotObj: TimeSlot,
  start: string,
  end: string,
  slots: TimeSlot[],
  slotForTimeCache: Map<string, TimeSlot | null>,
): boolean {
  if (!start || !end) return false;
  if (slotObj.s === start && slotObj.e === end) return true;
  const matchingSlot = resolveSlotForTime(start, end, slots, slotForTimeCache);
  if (!matchingSlot) return false;
  return matchingSlot.id === slotObj.id || (matchingSlot.s === slotObj.s && matchingSlot.e === slotObj.e);
}

export function lessonMapsToAnySlot(
  start: string,
  end: string,
  slots: TimeSlot[],
  slotForTimeCache: Map<string, TimeSlot | null>,
): boolean {
  return resolveSlotForTime(start, end, slots, slotForTimeCache) !== null;
}

export function lessonCandidatesForCell(
  g: SchedGroup,
  ci: number,
  dk: string,
  weekSessions: Record<string, WeekSessionMeta>,
): CellLessonCandidate[] {
  const grammarSession = weekSessions[sessionKey(grammarBlockIdOf(g), dk)] ?? null;
  const clubBlockId = clubBlockIdOf(g);
  const clubSession = clubBlockId ? (weekSessions[sessionKey(clubBlockId, dk)] ?? null) : null;
  const candidates: CellLessonCandidate[] = [];

  if ((g.grammarDays.includes(ci) || grammarSession) && !(grammarSession?.movedToDate && grammarSession.movedToDate !== dk)) {
    candidates.push({
      kind: 'grammar',
      session: grammarSession,
      start: grammarSession?.startTimeSnap ?? g.grammarStartTime ?? g.startTime ?? '',
      end: grammarSession?.endTimeSnap ?? g.grammarEndTime ?? g.endTime ?? '',
    });
  }

  if (clubBlockId && (g.clubDays.includes(ci) || clubSession) && !(clubSession?.movedToDate && clubSession.movedToDate !== dk)) {
    candidates.push({
      kind: 'club',
      session: clubSession,
      start: clubSession?.startTimeSnap ?? g.clubStartTime ?? g.startTime ?? '',
      end: clubSession?.endTimeSnap ?? g.clubEndTime ?? g.endTime ?? '',
    });
  }

  return candidates;
}
