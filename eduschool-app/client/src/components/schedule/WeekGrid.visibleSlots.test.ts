import { describe, expect, it } from 'vitest';
import { computeVisibleSlots } from './WeekGrid';

const slots = [{ id: 1 }, { id: 2 }, { id: 3 }];

describe('computeVisibleSlots', () => {
  it('staff (isTeacher=false) sees every current-policy slot, empty or not', () => {
    const result = computeVisibleSlots(slots, [], false, () => false);
    expect(result).toEqual(slots);
  });

  it('staff still sees a legacy slot only if it still has a lesson', () => {
    const withLesson = computeVisibleSlots(slots, [2], false, slotId => slotId === 2);
    expect(withLesson.map(s => s.id)).toEqual([1, 2, 3]);

    const withoutLesson = computeVisibleSlots(slots, [2], false, () => false);
    expect(withoutLesson.map(s => s.id)).toEqual([1, 3]);
  });

  it('a teacher only sees rows where they actually teach this week', () => {
    const result = computeVisibleSlots(slots, [], true, slotId => slotId === 2);
    expect(result.map(s => s.id)).toEqual([2]);
  });

  it('a teacher with no lessons this week sees an empty grid, not the full one', () => {
    // This is the regression the bug report was about: staff's "no slots left after
    // filtering" case falls back to showing everything, but that fallback must NOT
    // apply to a teacher — an empty week is meant to render empty, not as clutter.
    const result = computeVisibleSlots(slots, [], true, () => false);
    expect(result).toEqual([]);
  });
});
