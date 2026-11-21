import type { SchedGroup } from '../components/schedule/scheduleTypes';
import { DAYS_SHORT } from '../components/schedule/scheduleTypes';

export type ConflictType = 'teacher' | 'cabinet' | 'capacity' | 'student-group' | 'intra-day';
export type ConflictSeverity = 'critical' | 'warning' | 'info';

export interface ScheduleConflict {
  type: ConflictType;
  severity: ConflictSeverity;
  message: string;
  details?: {
    groupName?: string;
    level?: string;
    days?: number[];
    startTime?: string;
    endTime?: string;
    cabinet?: string;
  };
  relatedGroupId?: number;
}

export interface ConflictOptions {
  targetStartDate?: string | null;
  targetEndDate?: string | null;
}

export function daysLabel(days: number[]): string {
  return days.map(d => DAYS_SHORT[d] ?? String(d)).join(' ');
}

function daysOverlap(a: number[], b: number[]): boolean {
  return a.some(d => b.includes(d));
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function timeRangesOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  if (!s1 || !e1 || !s2 || !e2) return false;
  return toMinutes(s1) < toMinutes(e2) && toMinutes(s2) < toMinutes(e1);
}

function groupLabel(g: SchedGroup): string {
  return g.lv || 'Без названия';
}

// ─── Cabinet conflicts ────────────────────────────────────────────────────────

function dateOnly(date?: string | null): string | null {
  return date ? date.slice(0, 10) : null;
}

function dateRangesOverlap(
  targetStart?: string | null,
  targetEnd?: string | null,
  groupStart?: string | null,
  groupEnd?: string | null,
): boolean {
  const ts = dateOnly(targetStart);
  const te = dateOnly(targetEnd) ?? ts;
  if (!ts || !te) return true;

  const gs = dateOnly(groupStart);
  const ge = dateOnly(groupEnd);
  return (!ge || ts <= ge) && (!gs || gs <= te);
}

function isActiveInTargetRange(g: SchedGroup, options?: ConflictOptions): boolean {
  if (!options?.targetStartDate && !options?.targetEndDate) {
    // Завершённые группы (endDate в прошлом) не конфликтуют с новыми блоками
    if (g.endDate) {
      const today = new Date().toISOString().slice(0, 10);
      if (g.endDate.slice(0, 10) < today) return false;
    }
    return true;
  }
  return dateRangesOverlap(options.targetStartDate, options.targetEndDate, g.startDate, g.endDate);
}

export function findCabinetConflicts(
  cabinetId: number,
  days: number[],
  startTime: string,
  endTime: string,
  groups: Record<string, SchedGroup>,
  excludeIds: number[] = [],
  options?: ConflictOptions,
): ScheduleConflict[] {
  if (!cabinetId || days.length === 0 || !startTime || !endTime) return [];

  const exclude = new Set(excludeIds);
  const conflicts: ScheduleConflict[] = [];

  for (const g of Object.values(groups)) {
    if (exclude.has(g.id)) continue;
    if (g.linkedIds?.some(id => exclude.has(id))) continue;
    if (!isActiveInTargetRange(g, options)) continue;
    if (g.cabinetId !== cabinetId) continue;

    const gStart = g.startTime ?? '';
    const gEnd = g.endTime ?? '';
    if (!gStart || !gEnd) continue;
    if (!timeRangesOverlap(startTime, endTime, gStart, gEnd)) continue;

    const grammarOverlap = g.grammarDays.length > 0 && daysOverlap(days, g.grammarDays);
    const clubOverlap = g.clubDays.length > 0 && daysOverlap(days, g.clubDays);
    if (!grammarOverlap && !clubOverlap) continue;

    const conflictDays = (grammarOverlap ? g.grammarDays : g.clubDays).filter(d => days.includes(d));
    conflicts.push({
      type: 'cabinet',
      severity: 'critical',
      message: `Кабинет занят: ${groupLabel(g)} · ${daysLabel(conflictDays)} · ${gStart}–${gEnd}`,
      details: { groupName: groupLabel(g), level: g.lv, days: conflictDays, startTime: gStart, endTime: gEnd },
      relatedGroupId: g.id,
    });
  }

  return conflicts;
}

// ─── Teacher conflicts ────────────────────────────────────────────────────────

export function findTeacherConflicts(
  teacherId: number,
  days: number[],
  startTime: string,
  endTime: string,
  groups: Record<string, SchedGroup>,
  excludeIds: number[] = [],
  options?: ConflictOptions,
): ScheduleConflict[] {
  if (!teacherId || days.length === 0 || !startTime || !endTime) return [];

  const exclude = new Set(excludeIds);
  const conflicts: ScheduleConflict[] = [];

  for (const g of Object.values(groups)) {
    if (exclude.has(g.id)) continue;
    if (g.linkedIds?.some(id => exclude.has(id))) continue;
    if (!isActiveInTargetRange(g, options)) continue;

    const isGrammar = g.tgId === teacherId && g.grammarDays.length > 0;
    const isClub = g.tkId === teacherId && g.clubDays.length > 0;
    if (!isGrammar && !isClub) continue;

    const teacherDays = isGrammar ? g.grammarDays : g.clubDays;
    const gStart = g.startTime ?? '';
    const gEnd = g.endTime ?? '';

    const dayOverlap = daysOverlap(days, teacherDays);
    if (!dayOverlap) continue; // different days entirely — teacher is free on those days

    const timeConflict = gStart && gEnd ? timeRangesOverlap(startTime, endTime, gStart, gEnd) : false;

    const severity: ConflictSeverity = timeConflict ? 'critical' : 'warning';
    const displayDays = severity === 'critical' ? teacherDays.filter(d => days.includes(d)) : teacherDays;

    const timeStr = gStart && gEnd ? ` · ${gStart}–${gEnd}` : '';
    conflicts.push({
      type: 'teacher',
      severity,
      message: severity === 'critical'
        ? `Учитель ведёт: ${groupLabel(g)} · ${daysLabel(displayDays)}${timeStr}`
        : `Учитель также ведёт: ${groupLabel(g)} · ${daysLabel(teacherDays)}${timeStr}`,
      details: {
        groupName: groupLabel(g),
        level: g.lv,
        days: displayDays,
        startTime: gStart || undefined,
        endTime: gEnd || undefined,
        cabinet: g.n,
      },
      relatedGroupId: g.id,
    });
  }

  return conflicts;
}

// ─── Student group conflicts ──────────────────────────────────────────────────

export function findStudentGroupConflicts(
  studentGroupId: number,
  days: number[],
  startTime: string,
  endTime: string,
  groups: Record<string, SchedGroup>,
  excludeIds: number[] = [],
  options?: ConflictOptions,
): ScheduleConflict[] {
  if (!studentGroupId || days.length === 0 || !startTime || !endTime) return [];

  const exclude = new Set(excludeIds);
  const conflicts: ScheduleConflict[] = [];

  for (const g of Object.values(groups)) {
    if (exclude.has(g.id)) continue;
    if (!isActiveInTargetRange(g, options)) continue;
    if (g.studentGroupId !== studentGroupId) continue;

    const allGroupDays = [...new Set([...g.grammarDays, ...g.clubDays])];
    if (allGroupDays.length === 0) continue;

    const dayOverlap = daysOverlap(days, allGroupDays);
    if (!dayOverlap) continue;

    const gStart = g.startTime ?? '';
    const gEnd = g.endTime ?? '';
    const timeConflict = gStart && gEnd ? timeRangesOverlap(startTime, endTime, gStart, gEnd) : false;

    const severity: ConflictSeverity = timeConflict ? 'critical' : 'warning';
    const conflictDays = allGroupDays.filter(d => days.includes(d));
    const timeStr = gStart && gEnd ? ` · ${gStart}–${gEnd}` : '';

    conflicts.push({
      type: 'student-group',
      severity,
      message: severity === 'critical'
        ? `Группа уже занята: ${groupLabel(g)} · ${daysLabel(conflictDays)}${timeStr}`
        : `Группа запланирована: ${groupLabel(g)} · ${daysLabel(allGroupDays)}${timeStr}`,
      details: {
        groupName: groupLabel(g),
        level: g.lv,
        days: conflictDays,
        startTime: gStart || undefined,
        endTime: gEnd || undefined,
        cabinet: g.n,
      },
      relatedGroupId: g.id,
    });
  }

  return conflicts;
}

// ─── Capacity check ───────────────────────────────────────────────────────────

export function checkCapacity(
  studentCount: number,
  cabinetCapacity: number,
): ScheduleConflict | null {
  if (cabinetCapacity <= 0 || cabinetCapacity >= 999 || studentCount <= 0) return null;

  if (studentCount > cabinetCapacity) {
    return {
      type: 'capacity',
      severity: 'warning',
      message: `Перегруз: ${studentCount}/${cabinetCapacity} мест (+${studentCount - cabinetCapacity} лишних)`,
    };
  }
  if (studentCount / cabinetCapacity >= 0.75) {
    return {
      type: 'capacity',
      severity: 'info',
      message: `Почти полный: ${studentCount}/${cabinetCapacity} мест`,
    };
  }
  return null;
}

// ─── Intra-day Grammar/Club overlap ──────────────────────────────────────────

export function findIntraDayConflict(
  grammarDays: number[],
  clubDays: number[],
): ScheduleConflict | null {
  const overlap = grammarDays.filter(d => clubDays.includes(d));
  if (overlap.length === 0) return null;
  return {
    type: 'intra-day',
    severity: 'critical',
    message: `Дни ${daysLabel(overlap)} — группа не может иметь Грамматику и Клуб одновременно`,
  };
}

// ─── Severity aggregator ──────────────────────────────────────────────────────

export function getConflictSeverity(conflicts: ScheduleConflict[]): ConflictSeverity | null {
  if (conflicts.length === 0) return null;
  if (conflicts.some(c => c.severity === 'critical')) return 'critical';
  if (conflicts.some(c => c.severity === 'warning')) return 'warning';
  return 'info';
}
