import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

/**
 * Returns the date of next Monday in the given timezone as a UTC Date.
 * If today is Monday, skips to next Monday (+7 days).
 * Also returns the YYYY-MM-DD string of that Monday in school timezone.
 */
export function getNextMondayDateInTz(tz: string): { date: Date; dateStr: string } {
  const nowStr = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
  const [y, m, d] = nowStr.split('-').map(Number);
  const todayLocal = new Date(Date.UTC(y, m - 1, d));
  const dow = todayLocal.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // Always jump to next Monday (skip current week's Mon)
  const daysToAdd = dow === 1 ? 7 : (8 - dow) % 7;
  const nextMon = new Date(Date.UTC(
    todayLocal.getUTCFullYear(),
    todayLocal.getUTCMonth(),
    todayLocal.getUTCDate() + daysToAdd,
  ));
  const pad = (n: number) => String(n).padStart(2, '0');
  const nextMonStr = `${nextMon.getUTCFullYear()}-${pad(nextMon.getUTCMonth() + 1)}-${pad(nextMon.getUTCDate())}`;
  // Midnight of that Monday in school timezone → UTC
  const utcDate = fromZonedTime(`${nextMonStr}T00:00:00`, tz);
  return { date: utcDate, dateStr: nextMonStr };
}

/**
 * Combines the UTC-noon sessionDate sentinel with an "HH:mm" startTime string
 * in the school's timezone to produce the exact UTC moment the lesson begins.
 *
 * sessionDate is always stored as YYYY-MM-DDT12:00:00.000Z (timezone-safe sentinel).
 * The actual lesson time is a separate "HH:mm" string on the block/session.
 * Decoding the date via formatInTimeZone ensures correctness across all UTC offsets.
 */
export function buildSessionStart(
  sessionDate: Date,
  startTime: string,
  timezone: string,
): Date {
  const localDate = formatInTimeZone(sessionDate, timezone, 'yyyy-MM-dd');
  return fromZonedTime(`${localDate}T${startTime}:00`, timezone);
}

/**
 * Returns UTC Date boundaries for a week starting on mondayStr in the given timezone.
 * weekStartStr: "YYYY-MM-DD" (Monday date in school timezone)
 */
export function getWeekBoundaries(
  weekStartStr: string,
  tz: string
): { from: Date; to: Date } {
  const from = fromZonedTime(`${weekStartStr}T00:00:00`, tz);
  const to = fromZonedTime(`${weekStartStr}T00:00:00`, tz);
  to.setUTCDate(to.getUTCDate() + 7);
  return { from, to };
}

/**
 * Returns UTC Date boundaries for a single day in the given timezone.
 * dateStr: "YYYY-MM-DD" (date in school timezone)
 */
export function getDayBoundaries(
  dateStr: string,
  tz: string
): { from: Date; to: Date } {
  const from = fromZonedTime(`${dateStr}T00:00:00`, tz);
  const to = fromZonedTime(`${dateStr}T23:59:59`, tz);
  return { from, to };
}

/**
 * Format a UTC Date as YYYY-MM-DD in the given timezone.
 */
export function dateInTz(date: Date, tz: string): string {
  return formatInTimeZone(date, tz, 'yyyy-MM-dd');
}

/**
 * Returns true once the lesson's actual start instant (sessionDate + startTime in
 * the school's timezone) has passed. Used to gate attendance submission: a lesson
 * is markable once it has started, whether that's today (after its start time) or
 * any earlier date still stuck as UPCOMING.
 */
export function hasSessionStarted(
  sessionDate: Date,
  startTime: string,
  tz: string,
  now: Date = new Date(),
): boolean {
  // A lesson opens for attendance for the whole of its calendar day (in the
  // school's tz), not only after its start instant: once today arrives, today's
  // lessons are markable; only future days stay blocked. startTime kept for
  // signature compatibility with callers but no longer gates the same day.
  const sessionDay = formatInTimeZone(sessionDate, tz, 'yyyy-MM-dd');
  const today = formatInTimeZone(now, tz, 'yyyy-MM-dd');
  return sessionDay <= today;
}

/**
 * Returns the day-of-week for a UTC Date as seen in the given timezone.
 * Returns 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun
 * — matching the LessonBlock.days / School.activeDays Int[] schema convention.
 *
 * Uses the local date string (YYYY-MM-DD) in the given TZ so that a session
 * stored at e.g. 2026-04-26T22:00:00Z (midnight UTC+2) correctly resolves to
 * Tuesday (2026-04-27) in UTC+2, not Monday via getUTCDay().
 */
export function getDayOfWeekInTz(date: Date, tz: string): number {
  const localStr = formatInTimeZone(date, tz, 'yyyy-MM-dd'); // "YYYY-MM-DD"
  const [y, m, d] = localStr.split('-').map(Number);
  const localDay = new Date(Date.UTC(y, m - 1, d));
  return (localDay.getUTCDay() + 6) % 7; // Sun(0)→6, Mon(1)→0, ..., Sat(6)→5
}

/**
 * Returns today's date in the given timezone as a UTC midnight Date.
 * Used for bootstrap: when a school has no existing SchoolSchedulePolicy,
 * the first policy should take effect immediately (today), not next Monday.
 */
export function getTodayDateInTz(tz: string): { date: Date; dateStr: string } {
  const todayStr = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
  const utcDate = fromZonedTime(`${todayStr}T00:00:00`, tz);
  return { date: utcDate, dateStr: todayStr };
}
