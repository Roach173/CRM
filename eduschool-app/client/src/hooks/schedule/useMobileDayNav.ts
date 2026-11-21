import { useEffect, useState } from 'react';
import { dateKey } from './scheduleDateUtils';

// Shared mobile day-navigation state for RoomsView/TeacherView/GroupView's mobile
// layout: which day (as a date-key string) is shown, and stepping to the
// previous/next day within the active week (aDays), never past its edges.
export function useMobileDayNav(
  aDays: number[],
  dates: Array<Date | undefined>,
  timezone: string,
  todayKey: string,
  viewWk: string,
) {
  function defaultMobileDay(): string {
    const todayIdx = aDays.find(ci => dates[ci] && dateKey(dates[ci]!, timezone) === todayKey);
    if (todayIdx !== undefined && dates[todayIdx]) return dateKey(dates[todayIdx]!, timezone);
    const firstDay = aDays[0];
    if (firstDay !== undefined && dates[firstDay]) return dateKey(dates[firstDay]!, timezone);
    return '';
  }

  const [mobileDay, setMobileDay] = useState<string>(defaultMobileDay);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setMobileDay(defaultMobileDay()); }, [viewWk]);

  const mobileDayIndex = aDays.find(
    ci => dates[ci] && dateKey(dates[ci]!, timezone) === mobileDay
  ) ?? aDays[0] ?? 0;

  function prevDay() {
    const idx = aDays.indexOf(mobileDayIndex);
    const prev = aDays[idx - 1];
    if (prev !== undefined && dates[prev]) setMobileDay(dateKey(dates[prev]!, timezone));
  }
  function nextDay() {
    const idx = aDays.indexOf(mobileDayIndex);
    const next = aDays[idx + 1];
    if (next !== undefined && dates[next]) setMobileDay(dateKey(dates[next]!, timezone));
  }

  return { mobileDay, mobileDayIndex, setMobileDay, prevDay, nextDay };
}
