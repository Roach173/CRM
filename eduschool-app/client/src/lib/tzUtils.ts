/**
 * Client-side timezone utilities — no external package, uses native Intl API.
 * All functions take school timezone as parameter (not browser timezone).
 */

// Intl.DateTimeFormat construction is expensive (~0.1ms); the schedule grid calls
// these helpers hundreds of times per render, so formatters are cached per timezone.
const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
const weekdayFmtCache = new Map<string, Intl.DateTimeFormat>();
const timeFmtCache = new Map<string, Intl.DateTimeFormat>();

/** Format a Date as YYYY-MM-DD in the given timezone. */
export function dateInTz(d: Date, tz: string): string {
  let fmt = dateFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFmtCache.set(tz, fmt);
  }
  return fmt.format(d);
}

/** Get the Monday of the week containing d, as YYYY-MM-DD in the given timezone. */
export function getMondayInTz(d: Date, tz: string): string {
  // Step 1: get the date string in school timezone
  const dateStr = dateInTz(d, tz); // "YYYY-MM-DD"
  const [y, m, day] = dateStr.split('-').map(Number);

  // Step 2: create noon UTC for that date to safely get its weekday in school tz
  const noonUTC = new Date(Date.UTC(y, m - 1, day, 12, 0, 0));

  // Step 3: get weekday name in school timezone
  let weekdayFmt = weekdayFmtCache.get(tz);
  if (!weekdayFmt) {
    weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    weekdayFmtCache.set(tz, weekdayFmt);
  }
  const weekdayStr = weekdayFmt.format(noonUTC); // 'Mon', 'Tue', ..., 'Sun'

  // Step 4: compute days back to Monday (Mon=0, ..., Sun=6)
  const dowMap: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };
  const daysBack = dowMap[weekdayStr] ?? 0;

  // Step 5: create Monday at noon UTC and format in school timezone
  const mondayNoonUTC = new Date(Date.UTC(y, m - 1, day - daysBack, 12, 0, 0));
  return dateInTz(mondayNoonUTC, tz);
}

/**
 * Return 7 date strings (YYYY-MM-DD) for Mon–Sun of the week starting on mondayStr,
 * all in the given timezone.
 */
export function weekDatesInTz(mondayStr: string, tz: string): string[] {
  const [y, m, d] = mondayStr.split('-').map(Number);
  return Array.from({ length: 7 }, (_, i) => {
    // UTC noon is safe: always resolves to the correct date in any tz (UTC-12 to UTC+14)
    const date = new Date(Date.UTC(y, m - 1, d + i, 12, 0, 0));
    return dateInTz(date, tz);
  });
}

/** Alias: current week key (Monday YYYY-MM-DD) in the given timezone. */
export function weekKeyInTz(d: Date, tz: string): string {
  return getMondayInTz(d, tz);
}

/** Format a Date as "HH:mm" in the given timezone. */
export function timeInTz(d: Date, tz: string): string {
  let fmt = timeFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    timeFmtCache.set(tz, fmt);
  }
  return fmt.format(d);
}
