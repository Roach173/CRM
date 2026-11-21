import { dateInTz, getMondayInTz, weekDatesInTz } from '../../lib/tzUtils';

// ─── Week helpers ─────────────────────────────────────────────────────────────

export function getMonday(d: Date, tz?: string): Date {
  if (tz) {
    const mondayStr = getMondayInTz(d, tz);
    const [y, m, day] = mondayStr.split('-').map(Number);
    return new Date(y, m - 1, day, 0, 0, 0, 0);
  }
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - (day === 0 ? 6 : day - 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function weekKey(d: Date, tz?: string): string {
  if (tz) return getMondayInTz(d, tz);
  const m = getMonday(d);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
}

export function weekDates(wk: string, tz?: string): Date[] {
  if (tz) {
    return weekDatesInTz(wk, tz).map(dateStr => {
      const [y, m, d] = dateStr.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    });
  }
  const mon = new Date(wk + 'T00:00:00');
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
}

export function weekLabel(wk: string): string {
  const MN = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const dates = weekDates(wk);
  const mon = dates[0];
  const sun = dates[6];
  const s = mon.getDate() + (mon.getMonth() !== sun.getMonth() ? ` ${MN[mon.getMonth()]}` : '');
  return `${s} – ${sun.getDate()} ${MN[sun.getMonth()]} ${sun.getFullYear()}`;
}

export function addWeeks(wk: string, n: number): string {
  const d = new Date(wk + 'T00:00:00');
  d.setDate(d.getDate() + n * 7);
  return weekKey(d);
}

export function dateKey(d: Date, tz?: string): string {
  if (tz) return dateInTz(d, tz);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const r = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${r}`;
}

export const formatLocalIso = dateKey;
