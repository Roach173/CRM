export type LessonSessionStatus =
  | 'UPCOMING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'LOCKED'
  | 'INVALIDATED';

export type LessonStatusOption = {
  value: LessonSessionStatus;
  label: string;
};

const STATUS_LABELS: Record<LessonSessionStatus, string> = {
  UPCOMING: 'Предстоит',
  IN_PROGRESS: 'Идёт сейчас',
  COMPLETED: 'Проведён',
  CANCELLED: 'Отменён',
  LOCKED: 'Зафиксирован',
  INVALIDATED: 'Недействителен',
};

export const START_BEFORE_COMPLETE_HELPER =
  'Сначала переведите урок в статус «Идёт сейчас», затем можно завершить его как «Проведён».';

export function normalizeLessonStatus(status: string | null | undefined): LessonSessionStatus {
  if (
    status === 'IN_PROGRESS'
    || status === 'COMPLETED'
    || status === 'CANCELLED'
    || status === 'LOCKED'
    || status === 'INVALIDATED'
  ) {
    return status;
  }
  return 'UPCOMING';
}

export function lessonStatusOptionsFor(savedStatus: string | null | undefined): LessonStatusOption[] {
  const normalized = normalizeLessonStatus(savedStatus);

  if (normalized === 'UPCOMING') {
    return [
      { value: 'UPCOMING', label: STATUS_LABELS.UPCOMING },
      { value: 'IN_PROGRESS', label: STATUS_LABELS.IN_PROGRESS },
    ];
  }

  if (normalized === 'IN_PROGRESS') {
    return [
      { value: 'IN_PROGRESS', label: STATUS_LABELS.IN_PROGRESS },
      { value: 'COMPLETED', label: STATUS_LABELS.COMPLETED },
    ];
  }

  return [{ value: normalized, label: STATUS_LABELS[normalized] }];
}

export function statusTransitionHelper(savedStatus: string | null | undefined): string | null {
  return normalizeLessonStatus(savedStatus) === 'UPCOMING' ? START_BEFORE_COMPLETE_HELPER : null;
}

export function isReadOnlyLessonStatus(savedStatus: string | null | undefined): boolean {
  const normalized = normalizeLessonStatus(savedStatus);
  return normalized === 'COMPLETED' || normalized === 'CANCELLED' || normalized === 'LOCKED' || normalized === 'INVALIDATED';
}

export function canSubmitLessonStatus(
  savedStatus: string | null | undefined,
  nextStatus: string | null | undefined,
): boolean {
  const saved = normalizeLessonStatus(savedStatus);
  const next = normalizeLessonStatus(nextStatus);

  if (saved === next) return true;
  if (saved === 'UPCOMING') return next === 'IN_PROGRESS';
  if (saved === 'IN_PROGRESS') return next === 'COMPLETED';
  return false;
}

/**
 * True once the lesson's calendar day has arrived (in the school's timezone):
 * an earlier date, or today at any time. Only future days stay blocked. Mirrors
 * the backend rule hasSessionStarted() in tzUtils. nowTimeStr/startTime are kept
 * for signature compatibility but no longer gate the same day.
 */
export function hasLessonStarted(
  lessonDateStr: string,
  todayStr: string,
  _nowTimeStr: string,
  _startTime: string,
): boolean {
  return lessonDateStr <= todayStr;
}
