import { describe, it, expect } from 'vitest';
import {
  findCabinetConflicts,
  findTeacherConflicts,
  findStudentGroupConflicts,
  findIntraDayConflict,
  checkCapacity,
  getConflictSeverity,
  timeRangesOverlap,
} from './scheduleConflicts';
import type { SchedGroup } from '../components/schedule/scheduleTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGroup(overrides: Partial<SchedGroup> & { id: number }): SchedGroup {
  return {
    id: overrides.id,
    studentGroupId: overrides.studentGroupId,
    lv: overrides.lv ?? 'A1',
    n: overrides.n ?? 'Каб.1',
    tg: overrides.tg ?? '—',
    tk: overrides.tk ?? '—',
    tgId: overrides.tgId,
    tkId: overrides.tkId,
    cabinetId: overrides.cabinetId ?? 1,
    grammarDays: overrides.grammarDays ?? [],
    clubDays: overrides.clubDays ?? [],
    startTime: overrides.startTime ?? '08:00',
    endTime: overrides.endTime ?? '09:15',
    grammarStartTime: overrides.grammarStartTime,
    grammarEndTime: overrides.grammarEndTime,
    clubStartTime: overrides.clubStartTime,
    clubEndTime: overrides.clubEndTime,
    cap: overrides.cap ?? 15,
    stu: overrides.stu ?? [],
    linkedIds: overrides.linkedIds ?? [],
    startDate: overrides.startDate,
    endDate: overrides.endDate,
    cc: overrides.cc ?? 1,
    gta: overrides.gta ?? null,
    type: overrides.type ?? 'regular',
    tgd: overrides.tgd ?? [],
    tkd: overrides.tkd ?? [],
  };
}

function G(groups: SchedGroup[]): Record<string, SchedGroup> {
  return Object.fromEntries(groups.map(g => [String(g.id), g]));
}

// ─── 1. Time overlap algorithm ─────────────────────────────────────────────────

describe('Time overlap algorithm', () => {
  const CAB = 1;
  const DAYS = [0]; // Mon

  it('CASE A — exact same time → critical', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: DAYS, startTime: '08:00', endTime: '09:15' })]);
    const result = findCabinetConflicts(CAB, DAYS, '08:00', '09:15', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('CASE B — partial overlap 09:00 inside 08:00–09:15 → critical', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: DAYS, startTime: '08:00', endTime: '09:15' })]);
    const result = findCabinetConflicts(CAB, DAYS, '09:00', '10:15', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('CASE C — touching boundary 09:15/09:15 → NO conflict (back-to-back is OK)', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: DAYS, startTime: '08:00', endTime: '09:15' })]);
    const result = findCabinetConflicts(CAB, DAYS, '09:15', '10:30', groups);
    expect(result).toHaveLength(0);
  });

  it('CASE D — fully inside overlap → critical', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: DAYS, startTime: '08:00', endTime: '11:00' })]);
    const result = findCabinetConflicts(CAB, DAYS, '09:00', '10:00', groups);
    expect(result).toHaveLength(1);
  });

  it('CASE — reverse inside (new block wraps existing) → critical', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: DAYS, startTime: '09:00', endTime: '10:00' })]);
    const result = findCabinetConflicts(CAB, DAYS, '08:00', '11:00', groups);
    expect(result).toHaveLength(1);
  });

  it('CASE — completely before → no conflict', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: DAYS, startTime: '10:30', endTime: '11:45' })]);
    const result = findCabinetConflicts(CAB, DAYS, '08:00', '09:15', groups);
    expect(result).toHaveLength(0);
  });

  it('CASE — completely after → no conflict', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: DAYS, startTime: '08:00', endTime: '09:15' })]);
    const result = findCabinetConflicts(CAB, DAYS, '10:30', '11:45', groups);
    expect(result).toHaveLength(0);
  });
});

// ─── 2. Days intersection ──────────────────────────────────────────────────────

describe('Days intersection', () => {
  const CAB = 1;
  const TIME = { startTime: '08:00', endTime: '09:15' };

  it('CASE E — completely different days → no conflict', () => {
    // existing: Mon Wed Fri (0,2,4), new: Tue Thu (1,3)
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: [0, 2, 4], ...TIME })]);
    const result = findCabinetConflicts(CAB, [1, 3], '08:00', '09:15', groups);
    expect(result).toHaveLength(0);
  });

  it('CASE F — partial day overlap → conflict detected on overlapping day', () => {
    // existing: Mon Wed Fri, new: Wed Sat — overlap on Wed (2)
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: [0, 2, 4], ...TIME })]);
    const result = findCabinetConflicts(CAB, [2, 5], '08:00', '09:15', groups);
    expect(result).toHaveLength(1);
    expect(result[0].details?.days).toContain(2);
    expect(result[0].details?.days).not.toContain(5); // Sat not in conflict
  });

  it('CASE — single shared day → conflict', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: [0], ...TIME })]);
    const result = findCabinetConflicts(CAB, [0], '08:00', '09:15', groups);
    expect(result).toHaveLength(1);
  });
});

// ─── 3. Edit mode — ignore self (excludeIds) ──────────────────────────────────

describe('Edit mode — group must not conflict with itself', () => {
  it('CASE G — editing own block: excludeIds prevents self-conflict', () => {
    const group = makeGroup({ id: 42, cabinetId: 1, grammarDays: [0, 2], startTime: '08:00', endTime: '09:15' });
    const groups = G([group]);
    // Without exclude → conflict with self
    const withSelf = findCabinetConflicts(1, [0, 2], '08:00', '09:15', groups);
    expect(withSelf).toHaveLength(1);
    // With excludeIds=[42] → no conflict
    const excluded = findCabinetConflicts(1, [0, 2], '08:00', '09:15', groups, [42]);
    expect(excluded).toHaveLength(0);
  });

  it('CASE G — linked blocks excluded together', () => {
    // Grammar block 10, Club block 11 (linked). Editing 10 should exclude 11 too.
    const grammarBlock = makeGroup({ id: 10, cabinetId: 1, grammarDays: [0], startTime: '08:00', endTime: '09:15', linkedIds: [11] });
    const clubBlock = makeGroup({ id: 11, cabinetId: 1, clubDays: [2], startTime: '08:00', endTime: '09:15', linkedIds: [10] });
    const groups = G([grammarBlock, clubBlock]);
    // Excluding block 10 should also exclude block 11 (via linkedIds check)
    const result = findCabinetConflicts(1, [0, 2], '08:00', '09:15', groups, [10]);
    // Club block 11 has linkedId 10 which is in excludeIds → also excluded
    expect(result).toHaveLength(0);
  });
});

// ─── 4. Cabinet capacity ──────────────────────────────────────────────────────

describe('Versioned schedule blocks', () => {
  const activeQuery = { targetStartDate: '2026-05-23' };

  it('ignores blocks that ended before the target date', () => {
    const groups = G([
      makeGroup({
        id: 1,
        cabinetId: 6,
        studentGroupId: 10,
        grammarDays: [0, 1, 2, 3, 4, 5],
        startTime: '12:00',
        endTime: '14:00',
        startDate: '2026-05-01T00:00:00.000Z',
        endDate: '2026-05-20T23:59:59.999Z',
      }),
    ]);

    expect(findCabinetConflicts(6, [1], '12:00', '14:00', groups, [], activeQuery)).toHaveLength(0);
    expect(findStudentGroupConflicts(10, [1], '12:00', '14:00', groups, [], activeQuery)).toHaveLength(0);
  });

  it('ignores blocks that start after the target date', () => {
    const groups = G([
      makeGroup({
        id: 1,
        cabinetId: 6,
        tgId: 3,
        grammarDays: [1],
        startTime: '12:00',
        endTime: '14:00',
        startDate: '2026-05-25T00:00:00.000Z',
      }),
    ]);

    expect(findTeacherConflicts(3, [1], '12:00', '14:00', groups, [], activeQuery)).toHaveLength(0);
  });

  it('keeps conflicts for blocks active on the target date', () => {
    const groups = G([
      makeGroup({
        id: 1,
        cabinetId: 6,
        studentGroupId: 10,
        grammarDays: [1],
        startTime: '12:00',
        endTime: '14:00',
        startDate: '2026-05-20T00:00:00.000Z',
        endDate: '2026-05-30T23:59:59.999Z',
      }),
    ]);

    expect(findCabinetConflicts(6, [1], '12:00', '14:00', groups, [], activeQuery)).toHaveLength(1);
    expect(findStudentGroupConflicts(10, [1], '12:00', '14:00', groups, [], activeQuery)).toHaveLength(1);
  });

  it('no self-conflict after split: parent excluded by date, child excluded by id', () => {
    // After split at 2026-06-23: parent active until June 22, child from June 23.
    // User edits child on June 23 — parent must NOT appear as a conflict.
    const parent = makeGroup({
      id: 1,
      studentGroupId: 10,
      cabinetId: 6,
      tgId: 3,
      grammarDays: [0, 2, 4],
      startTime: '08:00',
      endTime: '09:00',
      startDate: '2026-06-01T00:00:00.000Z',
      endDate: '2026-06-22T00:00:00.000Z',
    });
    const child = makeGroup({
      id: 2,
      studentGroupId: 10,
      cabinetId: 6,
      tgId: 3,
      grammarDays: [0, 2, 4],
      startTime: '08:00',
      endTime: '09:00',
      startDate: '2026-06-23T00:00:00.000Z',
    });
    const groups = G([parent, child]);
    const onApplyFrom = { targetStartDate: '2026-06-23' };
    // Editing child (excludeIds=[2]): parent expired June 22 → excluded by date → no conflict
    expect(findStudentGroupConflicts(10, [0, 2, 4], '08:00', '09:00', groups, [2], onApplyFrom)).toHaveLength(0);
    expect(findCabinetConflicts(6, [0, 2, 4], '08:00', '09:00', groups, [2], onApplyFrom)).toHaveLength(0);
    expect(findTeacherConflicts(3, [0, 2, 4], '08:00', '09:00', groups, [2], onApplyFrom)).toHaveLength(0);
  });
});

describe('Cabinet capacity', () => {
  it('CASE H — 7/10 → null (green, under 75%)', () => {
    expect(checkCapacity(7, 10)).toBeNull();
  });

  it('CASE H boundary — 7/10 is exactly 70% < 75% threshold → null', () => {
    expect(checkCapacity(7, 10)).toBeNull();
  });

  it('75% threshold — 8/10 = 80% → info', () => {
    const result = checkCapacity(8, 10);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('info');
  });

  it('CASE I — 10/10 full capacity → info (at capacity but not over)', () => {
    const result = checkCapacity(10, 10);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('info');
  });

  it('CASE J — 11/10 over capacity → warning', () => {
    const result = checkCapacity(11, 10);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('warning');
  });

  it('unlimited capacity (999) → always null', () => {
    expect(checkCapacity(100, 999)).toBeNull();
    expect(checkCapacity(1000, 999)).toBeNull();
  });

  it('zero capacity → null (unconfigured)', () => {
    expect(checkCapacity(5, 0)).toBeNull();
  });

  it('zero students → null', () => {
    expect(checkCapacity(0, 10)).toBeNull();
  });
});

// ─── 5. Teacher conflicts ──────────────────────────────────────────────────────

describe('Teacher conflicts', () => {
  const T1 = 1;

  it('CASE K — teacher on Mon/Wed, new block on Tue/Thu → NO conflict', () => {
    const groups = G([makeGroup({ id: 1, tgId: T1, grammarDays: [0, 2], startTime: '08:00', endTime: '09:15' })]);
    const result = findTeacherConflicts(T1, [1, 3], '08:00', '09:15', groups);
    expect(result).toHaveLength(0);
  });

  it('CASE L — same days + same time → critical', () => {
    const groups = G([makeGroup({ id: 1, tgId: T1, grammarDays: [0, 2], startTime: '08:00', endTime: '09:15' })]);
    const result = findTeacherConflicts(T1, [0, 2], '08:00', '09:15', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('same day, different non-overlapping time → warning (busy that day, different slot)', () => {
    const groups = G([makeGroup({ id: 1, tgId: T1, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    // Teacher teaches Mon 08:00-09:15, new slot Mon 10:30-11:45 — same day, no time conflict
    const result = findTeacherConflicts(T1, [0], '10:30', '11:45', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning');
  });

  it('same day, touching time (back-to-back) → warning NOT critical', () => {
    const groups = G([makeGroup({ id: 1, tgId: T1, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    const result = findTeacherConflicts(T1, [0], '09:15', '10:30', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning'); // same day, touching = warning, not critical
  });

  it('teacher with club role on different days → no conflict', () => {
    const groups = G([makeGroup({ id: 1, tkId: T1, clubDays: [1, 3], startTime: '08:00', endTime: '09:15' })]);
    const result = findTeacherConflicts(T1, [0, 2, 4], '08:00', '09:15', groups);
    expect(result).toHaveLength(0);
  });

  it('teacher with club role — same days, time overlap → critical', () => {
    const groups = G([makeGroup({ id: 1, tkId: T1, clubDays: [1, 3], startTime: '08:00', endTime: '09:15' })]);
    const result = findTeacherConflicts(T1, [1, 3], '08:00', '09:15', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('teacher not in any group → no conflict', () => {
    const groups = G([makeGroup({ id: 1, tgId: 999, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    const result = findTeacherConflicts(T1, [0], '08:00', '09:15', groups);
    expect(result).toHaveLength(0);
  });
});

// ─── 6. Student group conflicts ───────────────────────────────────────────────
//
// HARD-BLOCK RULE (Phase 1B):
//   exact time + day overlap → severity 'critical' → backend throws WITHOUT override path
//   same day, different time → severity 'warning' → backend soft-warns, Save not disabled
//
describe('Student group conflicts', () => {
  const GID = 5;

  it('[HARD-BLOCK] same group, same days, same time → critical (must not be overrideable)', () => {
    const groups = G([makeGroup({ id: 1, studentGroupId: GID, grammarDays: [0, 2], startTime: '08:00', endTime: '09:15' })]);
    const result = findStudentGroupConflicts(GID, [0, 2], '08:00', '09:15', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
    expect(result[0].type).toBe('student-group');
  });

  it('[HARD-BLOCK] same group, partial time overlap → critical', () => {
    // Existing 08:00-09:15, new 09:00-10:15 — overlap from 09:00 to 09:15
    const groups = G([makeGroup({ id: 1, studentGroupId: GID, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    const result = findStudentGroupConflicts(GID, [0], '09:00', '10:15', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('[NOT BLOCKED] same group, same days, different non-overlapping time → warning only', () => {
    // Same day but 10:30-11:45 does not overlap 08:00-09:15 → warning, Save allowed
    const groups = G([makeGroup({ id: 1, studentGroupId: GID, grammarDays: [0, 2], startTime: '08:00', endTime: '09:15' })]);
    const result = findStudentGroupConflicts(GID, [0, 2], '10:30', '11:45', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning'); // not critical → does not disable Save
  });

  it('[NOT BLOCKED] same group, back-to-back time (touching boundary) → warning, not critical', () => {
    // Existing 08:00-09:15, new starts exactly at 09:15 → no time overlap
    const groups = G([makeGroup({ id: 1, studentGroupId: GID, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    const result = findStudentGroupConflicts(GID, [0], '09:15', '10:30', groups);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning');
  });

  it('same group, different days → no conflict (Grammar + Club companion case)', () => {
    // Grammar Mon/Wed, adding Club Tue/Thu — same group, different days = OK
    const groups = G([makeGroup({ id: 1, studentGroupId: GID, grammarDays: [0, 2], startTime: '08:00', endTime: '09:15' })]);
    const result = findStudentGroupConflicts(GID, [1, 3], '08:00', '09:15', groups);
    expect(result).toHaveLength(0);
  });

  it('different student group → no conflict', () => {
    const groups = G([makeGroup({ id: 1, studentGroupId: 999, grammarDays: [0, 2], startTime: '08:00', endTime: '09:15' })]);
    const result = findStudentGroupConflicts(GID, [0, 2], '08:00', '09:15', groups);
    expect(result).toHaveLength(0);
  });
});

// ─── 7. getConflictSeverity aggregator ───────────────────────────────────────

describe('getConflictSeverity', () => {
  const mkConflict = (severity: 'critical' | 'warning' | 'info') => ({
    type: 'cabinet' as const, severity, message: 'test',
  });

  it('empty array → null', () => {
    expect(getConflictSeverity([])).toBeNull();
  });

  it('info only → info', () => {
    expect(getConflictSeverity([mkConflict('info')])).toBe('info');
  });

  it('warning only → warning', () => {
    expect(getConflictSeverity([mkConflict('warning')])).toBe('warning');
  });

  it('critical only → critical', () => {
    expect(getConflictSeverity([mkConflict('critical')])).toBe('critical');
  });

  it('mixed info + warning → warning', () => {
    expect(getConflictSeverity([mkConflict('info'), mkConflict('warning')])).toBe('warning');
  });

  it('mixed warning + critical → critical (critical wins)', () => {
    expect(getConflictSeverity([mkConflict('warning'), mkConflict('critical')])).toBe('critical');
  });
});

// ─── 8. Edge cases — empty/missing data ───────────────────────────────────────

describe('Edge cases — empty/missing data', () => {
  it('cabinetId=0 → no conflicts (unconfigured)', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: 1, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    expect(findCabinetConflicts(0, [0], '08:00', '09:15', groups)).toHaveLength(0);
  });

  it('empty days → no conflicts', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: 1, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    expect(findCabinetConflicts(1, [], '08:00', '09:15', groups)).toHaveLength(0);
  });

  it('empty groups map → no conflicts', () => {
    expect(findCabinetConflicts(1, [0], '08:00', '09:15', {})).toHaveLength(0);
  });

  it('group with no grammarDays or clubDays → not counted', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: 1, grammarDays: [], clubDays: [], startTime: '08:00', endTime: '09:15' })]);
    expect(findCabinetConflicts(1, [0], '08:00', '09:15', groups)).toHaveLength(0);
  });

  it('missing startTime/endTime on existing block → skip gracefully', () => {
    const g = makeGroup({ id: 1, cabinetId: 1, grammarDays: [0] });
    (g as any).startTime = '';
    (g as any).endTime = '';
    const groups = G([g]);
    expect(findCabinetConflicts(1, [0], '08:00', '09:15', groups)).toHaveLength(0);
  });
});

// ─── 9. Time format — zero-padding requirement ────────────────────────────────

describe('Time format — zero-padding safety', () => {
  const CAB = 1;
  const DAYS = [0];

  it('zero-padded times compare correctly: 08:00 < 09:15', () => {
    // String comparison: '0' < '0' then '8' < '9' → correct
    expect('08:00' < '09:15').toBe(true);
  });

  it('zero-padded: 09:15 is NOT less than 09:15 (boundary)', () => {
    expect('09:15' < '09:15').toBe(false);
  });

  it('zero-padded: 09:00 < 10:00 (hour boundary)', () => {
    // '0' == '0', '9' < '1'? No — '09:00' vs '10:00': '0' < '1' ✅
    expect('09:00' < '10:00').toBe(true);
  });

  it('DANGER — non-padded "9:00" would compare incorrectly vs "10:00"', () => {
    // Document the known danger: if times are not zero-padded, comparison breaks
    // "9:00" > "10:00" because '9' > '1' — this is why fmt() must always pad
    expect('9:00' > '10:00').toBe(true); // This is WRONG semantically, but correct string behavior
  });

  it('all generated slot times are zero-padded — conflict engine relies on this', () => {
    // Simulate fmt() output: hours 0-23 all padded to 2 digits
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
    expect(fmt(8 * 60)).toBe('08:00');       // 8:00 AM
    expect(fmt(9 * 60 + 15)).toBe('09:15');  // 9:15 AM
    expect(fmt(10 * 60)).toBe('10:00');      // 10:00 AM
    expect(fmt(20 * 60 + 20)).toBe('20:20'); // 8:20 PM
  });

  it('zero-padded times: back-to-back still not a conflict', () => {
    const groups = G([makeGroup({ id: 1, cabinetId: CAB, grammarDays: DAYS, startTime: '08:20', endTime: '09:40' })]);
    // Next slot starts at exactly 09:40 → back-to-back, should NOT conflict
    const result = findCabinetConflicts(CAB, DAYS, '09:40', '11:00', groups);
    expect(result).toHaveLength(0);
  });
});

// ─── 10. Suggestion engine safety — no false suggestions ─────────────────────

describe('Suggestion engine — conflict functions used correctly', () => {
  it('free cabinet correctly identified when no groups overlap', () => {
    // Cabinet 1: Mon 08:00-09:15. Cabinet 2: free. Querying cabinet 2 for Mon 08:00-09:15
    const groups = G([makeGroup({ id: 1, cabinetId: 1, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    expect(findCabinetConflicts(2, [0], '08:00', '09:15', groups)).toHaveLength(0);
    expect(findCabinetConflicts(1, [0], '08:00', '09:15', groups)).toHaveLength(1);
  });

  it('free teacher correctly identified at different slot', () => {
    // Teacher 1 teaches Mon 08:00-09:15. Check if free Mon 10:30-11:45 (same day, different time)
    const groups = G([makeGroup({ id: 1, tgId: 1, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    const conflicts = findTeacherConflicts(1, [0], '10:30', '11:45', groups);
    // Same day, different time → warning (not critical) — suggestion engine filters for critical only
    expect(conflicts.filter(c => c.severity === 'critical')).toHaveLength(0);
  });

  it('partial overlap between two groups correctly detected', () => {
    // Cabinet 1 has a group Mon 09:00-10:15. Does it conflict with Mon 08:00-09:30?
    const groups = G([makeGroup({ id: 1, cabinetId: 1, grammarDays: [0], startTime: '09:00', endTime: '10:15' })]);
    // 08:00-09:30 overlaps with 09:00-10:15 (09:00 < 09:30 && 08:00 < 10:15)
    const result = findCabinetConflicts(1, [0], '08:00', '09:30', groups);
    expect(result).toHaveLength(1);
  });

  it('no cross-contamination between cabinets', () => {
    // Cabinet 1 conflict should not affect cabinet 2 check
    const groups = G([makeGroup({ id: 1, cabinetId: 1, grammarDays: [0], startTime: '08:00', endTime: '09:15' })]);
    expect(findCabinetConflicts(2, [0], '08:00', '09:15', groups)).toHaveLength(0);
    expect(findCabinetConflicts(1, [1], '08:00', '09:15', groups)).toHaveLength(0); // different day
    expect(findCabinetConflicts(1, [0], '09:30', '10:45', groups)).toHaveLength(0); // different time
  });
});

// ─── 11. findIntraDayConflict — initial state overlap bug (Сб in grammar+club) ─
//
// Root cause: group saved with Сб in BOTH grammarDays and clubDays.
// On open, sanitizeSelectedDays does NOT strip the overlap → intraDayConflict
// severity='critical' → editHasCritical=true → Save button disabled → no PUT request.
// Fix: initial clubDays filters out days already in grammarDays.

describe('findIntraDayConflict', () => {
  it('no overlap → null', () => {
    // grammar: Mon Wed Fri Sat Sun, club: Tue Thu — no shared day
    expect(findIntraDayConflict([0, 2, 4, 5, 6], [1, 3])).toBeNull();
  });

  it('Сб overlap (exact bug: grammar=[0,2,4,5,6], club=[1,3,5]) → critical', () => {
    const result = findIntraDayConflict([0, 2, 4, 5, 6], [1, 3, 5]);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.type).toBe('intra-day');
  });

  it('all days in grammar, club non-empty → critical (full overlap)', () => {
    const result = findIntraDayConflict([0, 1, 2, 3, 4, 5, 6], [0, 1]);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('empty grammar → null even if club non-empty', () => {
    expect(findIntraDayConflict([], [0, 1, 2])).toBeNull();
  });

  it('empty club → null', () => {
    expect(findIntraDayConflict([0, 2, 4], [])).toBeNull();
  });

  it('both empty → null', () => {
    expect(findIntraDayConflict([], [])).toBeNull();
  });
});

// ─── 12. Grammar+Club same-day time conflict (used in GroupRow hasCurrentDayConflict) ──

describe('timeRangesOverlap — Grammar+Club same-day attendance gate', () => {
  it('same day, different times (Grammar 08:06–09:06, Club 20:06–21:06) → ALLOW attendance', () => {
    expect(timeRangesOverlap('08:06', '09:06', '20:06', '21:06')).toBe(false);
  });

  it('same day, identical times (Grammar 08:06–09:06, Club 08:06–09:06) → BLOCK attendance', () => {
    expect(timeRangesOverlap('08:06', '09:06', '08:06', '09:06')).toBe(true);
  });

  it('same day, partial overlap (Grammar 08:00–09:30, Club 09:00–10:30) → BLOCK attendance', () => {
    expect(timeRangesOverlap('08:00', '09:30', '09:00', '10:30')).toBe(true);
  });

  it('missing grammar start → ALLOW (do not block attendance on missing data)', () => {
    expect(timeRangesOverlap('', '09:06', '08:06', '09:06')).toBe(false);
  });

  it('missing club times → ALLOW (do not block attendance on missing data)', () => {
    expect(timeRangesOverlap('08:06', '09:06', '', '')).toBe(false);
  });

  it('club ends before grammar starts (08:00–09:00 vs 10:00–11:00) → ALLOW', () => {
    expect(timeRangesOverlap('08:00', '09:00', '10:00', '11:00')).toBe(false);
  });
});

// ─── 13. Cabinet conflict — same group shared cabinet (Grammar + Club) ────────

describe('Cabinet — same group Grammar+Club share cabinet legitimately', () => {
  it('same studentGroupId on same cabinet, different days → no conflict', () => {
    // Grammar Mon/Wed, Club Tue/Thu, same cabinet — legit
    const grammarBlock = makeGroup({ id: 1, cabinetId: 1, studentGroupId: 10, grammarDays: [0, 2], startTime: '08:00', endTime: '09:15' });
    const groups = G([grammarBlock]);
    // Creating Club block for same group, same cabinet, different days
    // Note: findCabinetConflicts checks cabinetId match + day/time overlap
    // Different days → no dayOverlap → no conflict
    const result = findCabinetConflicts(1, [1, 3], '08:00', '09:15', groups);
    expect(result).toHaveLength(0);
  });
});
