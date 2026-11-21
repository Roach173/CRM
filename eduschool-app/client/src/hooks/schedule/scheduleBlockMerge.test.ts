import { describe, expect, it } from 'vitest';
import { buildScheduleStateFromBlocks, mergeAttendanceMarks, type ServerBlock } from './scheduleBlockMerge';
import type { GMap } from '../../components/schedule/scheduleTypes';

function block(overrides: Partial<ServerBlock> = {}): ServerBlock {
  return {
    id: 1,
    startTime: '08:00', endTime: '09:20',
    days: [0, 2], level: 'A1', chapter: 1, maxStudents: 12,
    startDate: null, endDate: null,
    teacher: null, cabinet: null,
    ...overrides,
  };
}

describe('buildScheduleStateFromBlocks', () => {
  it('merges a grammar + club block of the same StudentGroup/slot into one SchedGroup', () => {
    const grammar = block({ id: 10, studentGroupId: 5, timeSlotId: 100, type: 'GRAMMAR' });
    const club = block({ id: 11, studentGroupId: 5, timeSlotId: 100, type: 'SPEAKING_CLUB' });
    const { newG } = buildScheduleStateFromBlocks([grammar, club], undefined, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
    const groups = Object.values(newG);
    expect(groups).toHaveLength(1);
    expect(groups[0].grammarBlockId).toBe(10);
    expect(groups[0].clubBlockId).toBe(11);
    expect(groups[0].type).toBe('regular');
  });

  it('keeps blocks at different time slots as separate SchedGroups', () => {
    const morning = block({ id: 20, studentGroupId: 6, timeSlotId: 100, startTime: '08:00', endTime: '09:20' });
    const afternoon = block({ id: 21, studentGroupId: 6, timeSlotId: 200, startTime: '11:20', endTime: '12:40' });
    const { newG } = buildScheduleStateFromBlocks([morning, afternoon], undefined, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
    expect(Object.keys(newG)).toHaveLength(2);
  });

  it('classifies a raw block day outside the configured activeDays as legacy, but keeps it visible', () => {
    const b = block({ id: 30, days: [5], studentGroupId: 7, timeSlotId: 100 });
    const activeDays = [0, 1, 2, 3, 4]; // Saturday (5) removed from school policy
    const { newG, legacyDaysArr } = buildScheduleStateFromBlocks([b], undefined, activeDays, activeDays);
    expect(legacyDaysArr).toEqual([5]);
    const group = Object.values(newG)[0];
    expect(group.grammarDays).toContain(5);
  });

  it('any-active-wins: a still-live grammar block keeps the card ACTIVE even if the paired club block closed', () => {
    const grammar = block({
      id: 50, studentGroupId: 9, timeSlotId: 100, type: 'GRAMMAR',
      blockVisibility: 'ACTIVE', isScheduleActive: true, isReadOnly: false, conflictEligible: true,
    });
    const club = block({
      id: 51, studentGroupId: 9, timeSlotId: 100, type: 'SPEAKING_CLUB',
      blockVisibility: 'CANCELLED', visibilityReason: 'status CANCELLED', isScheduleActive: false, isReadOnly: true, conflictEligible: true,
    });
    const { newG } = buildScheduleStateFromBlocks([grammar, club], undefined, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
    const group = Object.values(newG)[0];
    expect(group.blockVisibility).toBe('ACTIVE');
    expect(group.isScheduleActive).toBe(true);
    expect(group.isReadOnly).toBe(false);
  });

  it('picks the higher-severity label when neither constituent block is active', () => {
    const grammar = block({
      id: 60, studentGroupId: 10, timeSlotId: 100, type: 'GRAMMAR',
      blockVisibility: 'COMPLETED', visibilityReason: 'status COMPLETED', isScheduleActive: false, isReadOnly: true, conflictEligible: false,
    });
    const club = block({
      id: 61, studentGroupId: 10, timeSlotId: 100, type: 'SPEAKING_CLUB',
      blockVisibility: 'CANCELLED', visibilityReason: 'status CANCELLED', isScheduleActive: false, isReadOnly: true, conflictEligible: true,
    });
    const { newG } = buildScheduleStateFromBlocks([grammar, club], undefined, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
    const group = Object.values(newG)[0];
    // CANCELLED outranks COMPLETED in VISIBILITY_SEVERITY.
    expect(group.blockVisibility).toBe('CANCELLED');
    expect(group.visibilityReason).toBe('status CANCELLED');
    // Neither constituent is active — the merged card is read-only.
    expect(group.isReadOnly).toBe(true);
  });

  it('aggregates conflictEligible as OR — a still-conflict-eligible constituent wins even when the card itself is ACTIVE', () => {
    const grammar = block({
      id: 70, studentGroupId: 11, timeSlotId: 100, type: 'GRAMMAR',
      blockVisibility: 'ACTIVE', isScheduleActive: true, isReadOnly: false, conflictEligible: true,
    });
    const club = block({
      id: 71, studentGroupId: 11, timeSlotId: 100, type: 'SPEAKING_CLUB',
      blockVisibility: 'CLOSED_BY_END_DATE', isScheduleActive: false, isReadOnly: true, conflictEligible: false,
    });
    const { newG } = buildScheduleStateFromBlocks([grammar, club], undefined, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
    const group = Object.values(newG)[0];
    expect(group.conflictEligible).toBe(true);
  });

  it('SOFT_DELETED outranks every other non-active label (highest severity)', () => {
    const grammar = block({
      id: 65, studentGroupId: 12, timeSlotId: 100, type: 'GRAMMAR',
      blockVisibility: 'SOFT_DELETED', visibilityReason: 'deletedAt is set (...)', isScheduleActive: false, isReadOnly: true, conflictEligible: false,
    });
    const club = block({
      id: 66, studentGroupId: 12, timeSlotId: 100, type: 'SPEAKING_CLUB',
      blockVisibility: 'COMPLETED', isScheduleActive: false, isReadOnly: true, conflictEligible: false,
    });
    const { newG } = buildScheduleStateFromBlocks([grammar, club], undefined, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
    const group = Object.values(newG)[0];
    expect(group.blockVisibility).toBe('SOFT_DELETED');
    expect(group.isReadOnly).toBe(true);
  });

  it('sums sessionCountInRange across constituent blocks when the backend returns it', () => {
    const grammar = block({
      id: 65, studentGroupId: 13, timeSlotId: 100, type: 'GRAMMAR',
      blockVisibility: 'SOFT_DELETED', isScheduleActive: false, isReadOnly: true, conflictEligible: false, sessionCountInRange: 2,
    });
    const club = block({
      id: 66, studentGroupId: 13, timeSlotId: 100, type: 'SPEAKING_CLUB',
      blockVisibility: 'SOFT_DELETED', isScheduleActive: false, isReadOnly: true, conflictEligible: false, sessionCountInRange: 1,
    });
    const { newG } = buildScheduleStateFromBlocks([grammar, club], undefined, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
    const group = Object.values(newG)[0];
    expect(group.sessionCountInRange).toBe(3);
  });

  it('leaves sessionCountInRange undefined when the backend never returned it (no-range payload shape)', () => {
    const grammar = block({ id: 67, studentGroupId: 14, timeSlotId: 100, type: 'GRAMMAR', blockVisibility: 'ACTIVE', isScheduleActive: true });
    const { newG } = buildScheduleStateFromBlocks([grammar], undefined, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
    const group = Object.values(newG)[0];
    expect(group.sessionCountInRange).toBeUndefined();
  });

  it('builds the roster from GroupMembership (the sole enrollment source of truth)', () => {
    const b = block({
      id: 40, studentGroupId: 8, timeSlotId: 100,
      studentGroup: {
        id: 8, name: 'Group A', level: 'A1', chapter: 2,
        memberships: [{ bookIssued: true, studentProfile: { id: 1, chapter: 3, user: { firstName: 'Ann', lastName: 'Lee' } } }],
      },
    });
    const { newG } = buildScheduleStateFromBlocks([b], undefined, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
    const group = Object.values(newG)[0];
    expect(group.stu.map(s => s.id)).toEqual([1]);
    const membershipStudent = group.stu.find(s => s.id === 1)!;
    expect(membershipStudent.n).toBe('Ann Lee');
    expect(membershipStudent.ch).toBe(3);
    expect(membershipStudent.book).toBe(true);
  });
});

describe('mergeAttendanceMarks', () => {
  it('preserves in-flight attendance marks from prev state onto the freshly loaded group', () => {
    const prev: GMap = {
      '1': { id: 1, n: '', lv: 'A1', cap: 10, tg: '—', tk: '—', cc: 1, gta: 'pr', stu: [
        { id: 1, n: 'Ann', ph: '', em: '', ch: 1, pd: '', ta: 'pr', st: 'ok', cm: '', lt: 'all', book: false },
      ], type: 'regular', grammarDays: [], clubDays: [], tgd: [], tkd: [] },
    };
    const newG: GMap = {
      '1': { id: 1, n: '', lv: 'A1', cap: 10, tg: '—', tk: '—', cc: 1, gta: null, stu: [
        { id: 1, n: 'Ann', ph: '', em: '', ch: 1, pd: '', ta: null, st: 'ok', cm: '', lt: 'all', book: false },
      ], type: 'regular', grammarDays: [], clubDays: [], tgd: [], tkd: [] },
    };
    const merged = mergeAttendanceMarks(prev, newG);
    expect(merged['1'].stu[0].ta).toBe('pr');
    expect(merged['1'].gta).toBe('pr');
  });

  it('leaves a brand-new group (absent from prev) untouched', () => {
    const newG: GMap = {
      '2': { id: 2, n: '', lv: 'A1', cap: 10, tg: '—', tk: '—', cc: 1, gta: null, stu: [], type: 'regular', grammarDays: [], clubDays: [], tgd: [], tkd: [] },
    };
    const merged = mergeAttendanceMarks({}, newG);
    expect(merged['2'].gta).toBeNull();
  });
});
