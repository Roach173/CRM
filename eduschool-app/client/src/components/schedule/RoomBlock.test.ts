import { describe, expect, it } from 'vitest';
import { visibilityBadgeLabel } from './RoomBlock';
import type { SchedGroup } from './scheduleTypes';

function baseGroup(overrides: Partial<SchedGroup> = {}): SchedGroup {
  return {
    id: 1, n: '', lv: 'Beginner', cap: 8, tg: '—', tk: '—', cc: 1, gta: null,
    stu: [], type: 'regular', grammarDays: [], clubDays: [], tgd: [], tkd: [],
    ...overrides,
  };
}

describe('visibilityBadgeLabel', () => {
  it('returns undefined when there is no blockVisibility (e.g. teacher-shaped data)', () => {
    expect(visibilityBadgeLabel(baseGroup())).toBeUndefined();
  });

  it('returns undefined for ACTIVE (no badge needed on a normal working card)', () => {
    expect(visibilityBadgeLabel(baseGroup({ blockVisibility: 'ACTIVE' }))).toBeUndefined();
  });

  it('labels COMPLETED / CANCELLED / CLOSED_BY_END_DATE / HISTORICAL', () => {
    expect(visibilityBadgeLabel(baseGroup({ blockVisibility: 'COMPLETED' }))).toBe('✓ Завершён');
    expect(visibilityBadgeLabel(baseGroup({ blockVisibility: 'CANCELLED' }))).toBe('✕ Отменён');
    expect(visibilityBadgeLabel(baseGroup({ blockVisibility: 'CLOSED_BY_END_DATE' }))).toBe('◐ Закрыт по дате');
    expect(visibilityBadgeLabel(baseGroup({ blockVisibility: 'HISTORICAL' }))).toBe('📁 Исторический');
  });

  it('labels a plain SOFT_DELETED tombstone (e.g. superseded, not itself cancelled)', () => {
    expect(visibilityBadgeLabel(baseGroup({ blockVisibility: 'SOFT_DELETED', blockStatus: 'UPCOMING' }))).toBe('🗑 Удалён');
  });

  it('combines SOFT_DELETED + CANCELLED into one badge (the real reported case: 65/66)', () => {
    expect(visibilityBadgeLabel(baseGroup({ blockVisibility: 'SOFT_DELETED', blockStatus: 'CANCELLED' })))
      .toBe('🗑 Удалён / Отменён');
  });
});
