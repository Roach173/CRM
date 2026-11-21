import { describe, expect, it } from 'vitest';
import { buildWeekSessionMaps, type RawWeekSession } from './scheduleSessionNormalizers';

function rawSession(overrides: Partial<RawWeekSession> = {}): RawWeekSession {
  return {
    lessonBlockId: 1, date: '2026-07-06', status: 'UPCOMING',
    startTimeSnap: null, endTimeSnap: null, cabinetIdSnap: null,
    teacher: null, isSubstitute: false, isHistoricalTeacher: false,
    ...overrides,
  };
}

describe('buildWeekSessionMaps', () => {
  it('keys every session by blockId_date and records its status', () => {
    const { subMap, statusMap } = buildWeekSessionMaps([rawSession({ lessonBlockId: 7, date: '2026-07-06', status: 'COMPLETED' })]);
    expect(statusMap['7_2026-07-06']).toBe('COMPLETED');
    expect(subMap['7_2026-07-06']).toBeDefined();
  });

  it('marks CANCELLED sessions in cancMap', () => {
    const { cancMap } = buildWeekSessionMaps([rawSession({ lessonBlockId: 3, date: '2026-07-06', status: 'CANCELLED' })]);
    expect(cancMap['3_2026-07-06']).toBe(true);
    expect(cancMap['3_2026-07-07']).toBeUndefined();
  });

  it('resolves the substitute teacher name only when isSubstitute is true', () => {
    const teacher = { id: 9, firstName: 'Ann', lastName: 'Lee' };
    const sub = buildWeekSessionMaps([rawSession({ isSubstitute: true, teacher })]).subMap['1_2026-07-06'];
    expect(sub.subTeacherName).toBe('Ann Lee');
    expect(sub.subTeacherId).toBe(9);

    const notSub = buildWeekSessionMaps([rawSession({ isSubstitute: false, teacher })]).subMap['1_2026-07-06'];
    expect(notSub.subTeacherName).toBe('');
    expect(notSub.subTeacherId).toBe(0);
  });

  it('backfills a synthetic entry at the original date when a session was manually moved', () => {
    const session = rawSession({
      lessonBlockId: 4, date: '2026-07-08',
      isManualDate: true, dateOverrideFrom: '2026-07-06',
    });
    const { subMap } = buildWeekSessionMaps([session]);
    expect(subMap['4_2026-07-08'].dateOverrideFrom).toBe('2026-07-06');
    expect(subMap['4_2026-07-06']).toMatchObject({ movedFromDate: '2026-07-06', movedToDate: '2026-07-08' });
  });

  it('does not treat a same-date override as a move', () => {
    const session = rawSession({
      lessonBlockId: 4, date: '2026-07-06',
      isManualDate: true, dateOverrideFrom: '2026-07-06',
    });
    const { subMap } = buildWeekSessionMaps([session]);
    expect(subMap['4_2026-07-06'].movedFromDate).toBeNull();
  });
});
