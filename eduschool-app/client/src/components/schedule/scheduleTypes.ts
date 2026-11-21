// ─── Schedule Types (Shamdan compatible) ─────────────────────────────────────

export interface TimeSlot {
  id: number;
  s: string; // "08:20"
  e: string; // "09:40"
}

export interface SchedStudent {
  id: number;
  n: string;                      // name
  ph: string;                     // phone
  em: string;                     // email
  ch: number;                     // chapter
  pd: string;                     // paid_until DD.MM.YYYY
  cr?: number;                    // credits balance (prepaid lessons)
  ta: null | 'pr' | 'ab';         // today's attendance
  st: 'ok' | 'ov' | 'ho';         // status: active / overdue / on-hold
  cm: string;                     // comment
  lt: 'all' | 'grammar' | 'club'; // lesson type
  book: boolean;                  // book issued
}

/** Block-level, as-of-now visibility classification — see server's classifyBlockVisibility(). */
export type BlockVisibility =
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'CLOSED_BY_END_DATE'
  | 'SOFT_DELETED'
  | 'OUT_OF_GRID'
  | 'HISTORICAL';

export interface SchedGroup {
  id: number;
  n: string;            // room/cabinet
  lv: string;           // level
  cap: number;
  tg: string;           // grammar teacher
  tk: string;           // club teacher
  cc: number;           // current chapter
  gta: null | 'pr' | 'ab';
  stu: SchedStudent[];
  type: 'regular' | 'club' | 'trial';
  grammarDays: number[];
  clubDays: number[];
  tgd: number[];        // grammar teacher day assignments
  tkd: number[];        // club teacher day assignments
  linkedIds?: number[]; // IDs of paired blocks (Grammar↔Club)
  grammarBlockId?: number;
  clubBlockId?: number;
  startDate?: string;  // ISO date "2025-05-01"
  endDate?: string;    // ISO date "2025-05-08"
  tgId?: number;       // grammar teacher user ID
  tkId?: number;       // club teacher user ID
  cabinetId?: number;  // cabinet ID
  studentGroupId?: number; // cohort group ID
  startTime?: string;
  endTime?: string;
  grammarStartTime?: string;
  grammarEndTime?: string;
  clubStartTime?: string;
  clubEndTime?: string;
  chapter?: number;
  maxStudents?: number;
  status?: 'ACTIVE' | 'COMPLETED' | 'PAUSED' | 'ARCHIVED';
  /** Effective status of the underlying LessonBlock(s). UPCOMING = actionable / editable. */
  blockStatus?: 'UPCOMING' | 'COMPLETED' | 'CANCELLED';
  /** Backend truth-display fields (additive, from GET /schedule) — see classifyBlockVisibility(). */
  blockVisibility?: BlockVisibility;
  visibilityReason?: string;
  isScheduleActive?: boolean;
  isReadOnly?: boolean;
  conflictEligible?: boolean;
  /** Sessions this block has within the currently-viewed week, if the backend returned it. */
  sessionCountInRange?: number;
}

export type SC = Record<string, number[]>; // "di-sid" → gid[]
export function grammarBlockIdOf(group: SchedGroup): number {
  return group.grammarBlockId ?? group.id;
}

export function clubBlockIdOf(group: SchedGroup): number | undefined {
  return group.clubBlockId ?? group.linkedIds?.[0];
}

export function relatedBlockIdsOf(group: SchedGroup): number[] {
  return [...new Set([group.id, group.grammarBlockId, group.clubBlockId, ...(group.linkedIds ?? [])].filter((id): id is number => id != null))];
}

export function lessonBlockIdForDay(group: SchedGroup, dayIdx: number): number {
  if (group.clubDays.includes(dayIdx)) return clubBlockIdOf(group) ?? grammarBlockIdOf(group);
  return grammarBlockIdOf(group);
}

export function doesGroupBelongToTeacherOnDay(
  group: SchedGroup,
  teacher: number | string | { id?: number; name?: string },
  dayIdx: number,
): boolean {
  const teacherId = typeof teacher === 'number'
    ? teacher
    : typeof teacher === 'object'
      ? teacher.id
      : undefined;
  const teacherName = typeof teacher === 'string'
    ? teacher
    : typeof teacher === 'object'
      ? teacher.name
      : undefined;

  const isGrammarDay = group.grammarDays.includes(dayIdx);
  const isClubDay = group.clubDays.includes(dayIdx);

  if (isGrammarDay) {
    if (teacherId != null && group.tgId === teacherId) return true;
    if (teacherName && group.tg === teacherName) return true;
  }
  if (isClubDay) {
    if (teacherId != null && group.tkId === teacherId) return true;
    if (teacherName && group.tk === teacherName) return true;
  }
  return false;
}

export type GMap = Record<string, SchedGroup>;

export interface MakeupSessionSummary {
  id: number;
  date: string;
  status: string;
  startTimeSnap: string | null;
  endTimeSnap: string | null;
}

export interface WeekSessionMeta {
  subTeacherId: number;
  subTeacherName: string;
  startTimeSnap: string | null;
  endTimeSnap: string | null;
  cabinetIdSnap: number | null;
  cabinetNameSnap?: string | null;
  attendanceFinalizedAt?: string | null;
  attendanceFinalizedById?: number | null;
  attendanceFinalizedBy?: { firstName: string; lastName: string } | null;
  attendanceReopenedAt?: string | null;
  attendanceReopenedById?: number | null;
  attendanceReopenedBy?: { firstName: string; lastName: string } | null;
  attendanceReopenReason?: string | null;
  canEditAttendance?: boolean;
  canReopenAttendance?: boolean;
  isHistoricalTeacher?: boolean;
  isManualDate?: boolean;
  dateOverrideFrom?: string | null;
  movedFromDate?: string | null;
  movedToDate?: string | null;
  isMakeup?: boolean;
  makeupForSessionId?: number | null;
  makeupForSession?: MakeupSessionSummary | null;
  makeupSession?: MakeupSessionSummary | null;
}

export type SchedView = 'week' | 'month' | 'rooms' | 'teacher' | 'group' | 'teacher-availability';

export const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const DAYS_FULL  = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

export const LEVELS = [
  'Beginner', 'Elementary', 'Pre-Intermediate',
  'Intermediate', 'Upper-Intermediate', 'Advanced',
];

/**
 * Canonical shape returned by useSchedule().
 * All views (WeekGrid, RoomsView, TeacherView, TeacherAvailabilityView) receive
 * this same object — no view may reconstruct or synthesise schedule data independently.
 * Source of truth: DB → /schedule + /settings/timeslots → loadFromServer → this shape.
 */
export interface ScheduleData {
  slots: TimeSlot[];
  G: GMap;
  SC: SC;
  aDays: number[];
  legacyDays: number[];
  legacySlotIds: number[];
  weekSessions: Record<string, unknown>;
  cancelledSessions: Record<string, unknown>;
  sessionStatuses: Record<string, unknown>;
}

/**
 * React.memo comparator factory for grid views that receive the whole `sched`
 * object (recreated on every useSchedule render, so identity comparison of the
 * object itself always fails). Compares every other prop by identity and
 * `sched` by only the fields the view actually renders.
 *
 * Views that read sched.G directly must list 'structureTick' instead of 'G':
 * G gets a new identity on every per-student ta/book toggle, which grid chips
 * never display — structureTick bumps only on grid-visible changes.
 */
export function schedViewPropsEqual<P extends { sched: unknown }>(schedKeys: ReadonlyArray<string>) {
  return (prev: P, next: P): boolean => {
    for (const k of Object.keys(next)) {
      if (k === 'sched') continue;
      if (!Object.is((prev as Record<string, unknown>)[k], (next as Record<string, unknown>)[k])) return false;
    }
    const ps = prev.sched as Record<string, unknown>;
    const ns = next.sched as Record<string, unknown>;
    return schedKeys.every(k => Object.is(ps[k], ns[k]));
  };
}
