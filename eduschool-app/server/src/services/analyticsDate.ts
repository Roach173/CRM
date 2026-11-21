export type AnalyticsPeriodKey =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'last_week'
  | 'month'
  | 'last_month'
  | 'quarter'
  | 'custom';

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

export interface AnalyticsPeriods {
  currentPeriod: AnalyticsRange;
  previousPeriod?: AnalyticsRange;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function startOfWeek(date: Date): Date {
  const day = (date.getDay() + 6) % 7;
  return startOfDay(addDays(date, -day));
}

function endOfWeek(date: Date): Date {
  return endOfDay(addDays(startOfWeek(date), 6));
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function startOfQuarter(date: Date): Date {
  const quarterMonth = Math.floor(date.getMonth() / 3) * 3;
  return new Date(date.getFullYear(), quarterMonth, 1, 0, 0, 0, 0);
}

function endOfQuarter(date: Date): Date {
  const quarterMonth = Math.floor(date.getMonth() / 3) * 3;
  return new Date(date.getFullYear(), quarterMonth + 3, 0, 23, 59, 59, 999);
}

function previousCalendarRange(period: AnalyticsPeriodKey, current: AnalyticsRange): AnalyticsRange {
  if (period === 'today') {
    const prev = addDays(current.from, -1);
    return { from: startOfDay(prev), to: endOfDay(prev) };
  }
  if (period === 'yesterday') {
    const prev = addDays(current.from, -1);
    return { from: startOfDay(prev), to: endOfDay(prev) };
  }
  if (period === 'week' || period === 'last_week') {
    const prevStart = addDays(current.from, -7);
    return { from: startOfDay(prevStart), to: endOfDay(addDays(prevStart, 6)) };
  }
  if (period === 'month' || period === 'last_month') {
    const prev = new Date(current.from.getFullYear(), current.from.getMonth() - 1, 1);
    return { from: startOfMonth(prev), to: endOfMonth(prev) };
  }
  if (period === 'quarter') {
    const prev = new Date(current.from.getFullYear(), current.from.getMonth() - 3, 1);
    return { from: startOfQuarter(prev), to: endOfQuarter(prev) };
  }
  const duration = current.to.getTime() - current.from.getTime();
  const to = new Date(current.from.getTime() - 1);
  return { from: new Date(to.getTime() - duration), to };
}

export function getAnalyticsPeriods(query: Record<string, unknown>, now = new Date()): AnalyticsPeriods {
  const period = (typeof query.period === 'string' ? query.period : 'month') as AnalyticsPeriodKey;
  const compare = String(query.compare ?? 'false') === 'true';
  let currentPeriod: AnalyticsRange;

  if (period === 'today') {
    currentPeriod = { from: startOfDay(now), to: endOfDay(now) };
  } else if (period === 'yesterday') {
    const y = addDays(now, -1);
    currentPeriod = { from: startOfDay(y), to: endOfDay(y) };
  } else if (period === 'week') {
    currentPeriod = { from: startOfWeek(now), to: endOfWeek(now) };
  } else if (period === 'last_week') {
    const lastWeek = addDays(now, -7);
    currentPeriod = { from: startOfWeek(lastWeek), to: endOfWeek(lastWeek) };
  } else if (period === 'last_month') {
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    currentPeriod = { from: startOfMonth(lastMonth), to: endOfMonth(lastMonth) };
  } else if (period === 'quarter') {
    currentPeriod = { from: startOfQuarter(now), to: endOfQuarter(now) };
  } else if (period === 'custom' && typeof query.from === 'string' && typeof query.to === 'string') {
    currentPeriod = { from: startOfDay(new Date(query.from)), to: endOfDay(new Date(query.to)) };
  } else {
    currentPeriod = { from: startOfMonth(now), to: endOfMonth(now) };
  }

  return {
    currentPeriod,
    previousPeriod: compare ? previousCalendarRange(period, currentPeriod) : undefined,
  };
}

export function rangeWhere(range: AnalyticsRange) {
  return { gte: range.from, lte: range.to };
}

export function percentChange(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function safePercent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}
