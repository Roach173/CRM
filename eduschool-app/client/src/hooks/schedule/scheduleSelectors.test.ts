import { describe, expect, it } from 'vitest';
import {
  groupClosedBeforeCell, resolveSlotForTime, slotMatchesLesson, lessonMapsToAnySlot, lessonCandidatesForCell,
  shouldShowGroupForDate,
} from './scheduleSelectors';
import type { SchedGroup, TimeSlot, WeekSessionMeta } from '../../components/schedule/scheduleTypes';

function baseGroup(overrides: Partial<SchedGroup> = {}): SchedGroup {
  return {
    id: 1, n: '', lv: 'Beginner', cap: 8, tg: '—', tk: '—', cc: 1, gta: null,
    stu: [], type: 'regular', grammarDays: [], clubDays: [], tgd: [], tkd: [],
    ...overrides,
  };
}

describe('groupClosedBeforeCell', () => {
  it('is never closed when there is no endDate', () => {
    expect(groupClosedBeforeCell(baseGroup(), '2026-07-04')).toBe(false);
  });

  it('COMPLETED groups close on (inclusive) their endDate', () => {
    const g = baseGroup({ status: 'COMPLETED', endDate: '2026-07-01' });
    expect(groupClosedBeforeCell(g, '2026-06-30')).toBe(false);
    expect(groupClosedBeforeCell(g, '2026-07-01')).toBe(true);
    expect(groupClosedBeforeCell(g, '2026-07-02')).toBe(true);
  });

  it('non-COMPLETED groups (e.g. split/replaced) close strictly after their endDate', () => {
    const g = baseGroup({ status: 'ACTIVE', endDate: '2026-07-01' });
    expect(groupClosedBeforeCell(g, '2026-07-01')).toBe(false);
    expect(groupClosedBeforeCell(g, '2026-07-02')).toBe(true);
  });
});

describe('shouldShowGroupForDate — Source of Truth (Session overrides Block per date)', () => {
  it('hides a closed block (no session) on a date after its endDate', () => {
    // The exact reported-bug shape: a promoted/completed group's block, endDate passed.
    const g = baseGroup({ status: 'COMPLETED', startDate: '2026-06-15', endDate: '2026-07-04', blockVisibility: 'COMPLETED' });
    expect(shouldShowGroupForDate(g, '2026-07-05', false)).toBe(false);
  });

  it('shows a closed block (no session) on a date on/before its endDate, as read-only truth', () => {
    const g = baseGroup({ status: 'COMPLETED', startDate: '2026-06-15', endDate: '2026-07-04', blockVisibility: 'COMPLETED' });
    expect(shouldShowGroupForDate(g, '2026-06-29', false)).toBe(true);
  });

  it('a session on a date after the block already closed still wins (makeup/ensured session)', () => {
    const g = baseGroup({ status: 'COMPLETED', startDate: '2026-06-15', endDate: '2026-07-04', blockVisibility: 'COMPLETED' });
    expect(shouldShowGroupForDate(g, '2026-07-10', true)).toBe(true);
  });

  it('a session wins even on a date before the group even started', () => {
    const g = baseGroup({ startDate: '2026-07-01' });
    expect(shouldShowGroupForDate(g, '2026-06-01', false)).toBe(false);
    expect(shouldShowGroupForDate(g, '2026-06-01', true)).toBe(true);
  });

  it('falls back to groupClosedBeforeCell unchanged when there is no session at all', () => {
    const g = baseGroup({ status: 'ACTIVE', startDate: '2026-06-15', endDate: '2026-07-01' });
    expect(shouldShowGroupForDate(g, '2026-07-01', false)).toBe(true); // non-COMPLETED closes strictly after endDate
    expect(shouldShowGroupForDate(g, '2026-07-02', false)).toBe(false);
  });

  it('with no startDate at all (legacy data shape), always shows regardless of session', () => {
    const g = baseGroup();
    expect(shouldShowGroupForDate(g, '2026-07-02', false)).toBe(true);
  });
});

describe('resolveSlotForTime / slotMatchesLesson / lessonMapsToAnySlot', () => {
  const slots: TimeSlot[] = [
    { id: 1, s: '08:20', e: '09:40' },
    { id: 2, s: '09:40', e: '11:00' },
  ];

  it('resolves an exact time match', () => {
    const cache = new Map<string, TimeSlot | null>();
    expect(resolveSlotForTime('08:20', '09:40', slots, cache)?.id).toBe(1);
  });

  it('resolves an overlapping (but not exact) time to the overlapping slot', () => {
    const cache = new Map<string, TimeSlot | null>();
    expect(resolveSlotForTime('08:30', '09:30', slots, cache)?.id).toBe(1);
  });

  it('returns null when nothing overlaps', () => {
    const cache = new Map<string, TimeSlot | null>();
    expect(resolveSlotForTime('22:00', '23:00', slots, cache)).toBeNull();
  });

  it('caches results across calls with the same key', () => {
    const cache = new Map<string, TimeSlot | null>();
    resolveSlotForTime('08:20', '09:40', slots, cache);
    expect(cache.get('08:20|09:40')?.id).toBe(1);
  });

  it('slotMatchesLesson accepts an exact match without needing resolution', () => {
    const cache = new Map<string, TimeSlot | null>();
    expect(slotMatchesLesson(slots[0], '08:20', '09:40', slots, cache)).toBe(true);
  });

  it('lessonMapsToAnySlot is false for an unmapped time range', () => {
    const cache = new Map<string, TimeSlot | null>();
    expect(lessonMapsToAnySlot('22:00', '23:00', slots, cache)).toBe(false);
  });
});

describe('lessonCandidatesForCell', () => {
  it('produces a grammar candidate on a grammar day using group default times', () => {
    const g = baseGroup({ grammarDays: [1], grammarStartTime: '08:20', grammarEndTime: '09:40' });
    const candidates = lessonCandidatesForCell(g, 1, '2026-07-06', {});
    expect(candidates).toEqual([
      { kind: 'grammar', session: null, start: '08:20', end: '09:40' },
    ]);
  });

  it('prefers the session snapshot time over the group default when a session exists', () => {
    const g = baseGroup({ grammarDays: [1], grammarBlockId: 5, grammarStartTime: '08:20', grammarEndTime: '09:40' });
    const session: WeekSessionMeta = {
      subTeacherId: 0, subTeacherName: '', startTimeSnap: '10:00', endTimeSnap: '11:20', cabinetIdSnap: null,
    };
    const candidates = lessonCandidatesForCell(g, 1, '2026-07-06', { '5_2026-07-06': session });
    expect(candidates[0]).toMatchObject({ kind: 'grammar', start: '10:00', end: '11:20' });
  });

  it('omits a candidate that was moved away from this date', () => {
    const g = baseGroup({ grammarDays: [1], grammarBlockId: 5 });
    const session: WeekSessionMeta = {
      subTeacherId: 0, subTeacherName: '', startTimeSnap: null, endTimeSnap: null, cabinetIdSnap: null,
      movedToDate: '2026-07-07',
    };
    const candidates = lessonCandidatesForCell(g, 1, '2026-07-06', { '5_2026-07-06': session });
    expect(candidates).toEqual([]);
  });

  it('includes both grammar and club candidates when the group has a club block', () => {
    const g = baseGroup({
      grammarDays: [1], clubDays: [1], clubBlockId: 9,
      grammarStartTime: '08:20', grammarEndTime: '09:40',
      clubStartTime: '10:00', clubEndTime: '11:20',
    });
    const candidates = lessonCandidatesForCell(g, 1, '2026-07-06', {});
    expect(candidates.map(c => c.kind)).toEqual(['grammar', 'club']);
  });
});
