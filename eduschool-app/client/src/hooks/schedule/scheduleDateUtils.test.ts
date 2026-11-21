import { describe, expect, it } from 'vitest';
import { getMonday, weekKey, weekDates, addWeeks, dateKey } from './scheduleDateUtils';

// Fixed reference week: Mon 2026-06-29 .. Sun 2026-07-05
describe('getMonday', () => {
  it('rolls a Saturday back to that week\'s Monday', () => {
    const monday = getMonday(new Date(2026, 6, 4)); // Sat Jul 4 2026
    expect(dateKey(monday)).toBe('2026-06-29');
  });

  it('rolls a Sunday back to that week\'s Monday (day-of-week 0 edge case)', () => {
    const monday = getMonday(new Date(2026, 6, 5)); // Sun Jul 5 2026
    expect(dateKey(monday)).toBe('2026-06-29');
  });

  it('leaves a Monday unchanged', () => {
    const monday = getMonday(new Date(2026, 6, 6)); // Mon Jul 6 2026
    expect(dateKey(monday)).toBe('2026-07-06');
  });
});

describe('weekKey / weekDates', () => {
  it('formats the Monday as an ISO date string', () => {
    expect(weekKey(new Date(2026, 6, 4))).toBe('2026-06-29');
  });

  it('expands a week key into 7 consecutive dates starting Monday', () => {
    const dates = weekDates('2026-06-29');
    expect(dates).toHaveLength(7);
    expect(dateKey(dates[0])).toBe('2026-06-29');
    expect(dateKey(dates[6])).toBe('2026-07-05');
  });
});

describe('addWeeks', () => {
  it('moves a week key forward by n weeks', () => {
    expect(addWeeks('2026-06-29', 1)).toBe('2026-07-06');
  });

  it('moves a week key backward by n weeks', () => {
    expect(addWeeks('2026-06-29', -1)).toBe('2026-06-22');
  });
});
