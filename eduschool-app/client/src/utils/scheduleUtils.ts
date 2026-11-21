export const MONTHS_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

/**
 * Single source of truth for legacy-slot visual classification.
 * Used by all schedule views (WeekGrid, RoomsView, TeacherView, GroupView).
 *
 * isLegacySlot  — slot ID is not in the current school schedule policy.
 * isArchiveWeek — the entire viewed week is in the past (< current week).
 * groupsPerDay  — for each visible day column: the groups visible in this
 *                 slot row (already filtered by room/teacher/group as needed)
 *                 and whether that column date is in the past.
 *
 * Rules (in priority order):
 *   archive  — past week, legacy slot (informational, dimmed)
 *   conflict — current/future week, legacy slot, ≥1 future day has an UPCOMING group (actionable)
 *   historical — current/future week, legacy slot, all future-day groups are non-UPCOMING (soft-dimmed)
 *   normal   — slot is in the current policy (no decoration needed)
 */
export function classifySlotVisualState(opts: {
  isLegacySlot: boolean;
  isArchiveWeek: boolean;
  groupsPerDay: Array<{ groups: { blockStatus?: string | null }[]; isPast: boolean }>;
}): 'conflict' | 'historical' | 'archive' | 'normal' {
  const { isLegacySlot, isArchiveWeek, groupsPerDay } = opts;
  if (!isLegacySlot) return 'normal';
  if (isArchiveWeek) return 'archive';
  const hasConflict = groupsPerDay.some(
    ({ groups, isPast }) => !isPast && groups.some(g => g.blockStatus == null || g.blockStatus === 'UPCOMING'),
  );
  if (hasConflict) return 'conflict';
  const hasHistorical = groupsPerDay.some(
    ({ groups, isPast }) => !isPast && groups.length > 0 && groups.every(g => g.blockStatus != null && g.blockStatus !== 'UPCOMING'),
  );
  return hasHistorical ? 'historical' : 'normal';
}

export function formatSessionDate(date?: string | null): string {
  if (!date) return '';
  return new Date(`${date}T12:00:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

export function lessonWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'урок';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'урока';
  return 'уроков';
}

export function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Roster search predicate for the slot panel. Shared deliberately: SlotPanel uses it
 * to decide which GROUPS to show, GroupRow to decide which STUDENTS to show. If the
 * two ever disagree you get a group that opens onto an empty list.
 *
 * Display-only — callers must keep passing the whole `group.stu` to attendance
 * submission, mark-all and unmarked-count. Narrowing what gets submitted to what
 * happens to be on screen would silently under-deduct credits.
 */
export function matchesStudentQuery(
  stu: { n: string; em?: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return stu.n.toLowerCase().includes(q) || (stu.em ?? '').toLowerCase().includes(q);
}
