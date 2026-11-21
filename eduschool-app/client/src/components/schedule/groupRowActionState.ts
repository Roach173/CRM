import type { SchedGroup } from './scheduleTypes';

// Pure lifecycle/action-availability decision for one GroupRow card. Most flags here
// are a verbatim relocation of a boolean that used to be computed inline in GroupRow.tsx.
// Exception: finalized attendance is now treated as a locally-editable draft (see
// canEditAttendanceNow) so the primary button reopens+re-submits on save instead of
// exposing a separate "reopen" click. See AI_SCHEDULE_HANDOFF.md for the backend state
// machine this mirrors (sessionStateMachine).
export interface GroupRowActionStateInput {
  group: Pick<SchedGroup, 'status' | 'studentGroupId' | 'stu'>;
  sessionStatus: string;
  isMakeup: boolean;
  isBlockCancelled: boolean;
  hasLessonStarted: boolean;
  backendCanEditAttendance: boolean;
  backendCanReopenAttendance: boolean;
  scheduleReadOnly: boolean;
  allowGroupEditWhenReadOnly: boolean;
  isTeacher: boolean;
  canDeleteSchedule: boolean;
  hasCurrentDayConflict: boolean;
  cancelLoading: boolean;
  lifecycleLoading: boolean;
  attSaving: boolean;
  reopenLoading: boolean;
}

export interface GroupRowActionState {
  isLocked: boolean;
  isInProgress: boolean;
  isCompleted: boolean;
  isCancelled: boolean;
  isInvalidated: boolean;
  isSessionOnlyCard: boolean;
  isGroupPaused: boolean;
  isGroupCompleted: boolean;
  isGroupArchived: boolean;
  isGroupActive: boolean;
  scheduleWriteLocked: boolean;
  groupEditLocked: boolean;
  invalidatedRestoreDisabled: boolean;
  canEditAttendanceNow: boolean;
  unmarkedCount: number;
  markAllDisabled: boolean;
  canBook: boolean;
  canChapter: boolean;
  canEditGroup: boolean;
  canDeleteGroup: boolean;
  canPauseGroup: boolean;
  canCompleteGroup: boolean;
  canRestoreSession: boolean;
  canCancelSession: boolean;
  primaryActionLabel: string;
  primaryActionDisabled: boolean;
  disabledReason: string | undefined;
}

export function computeGroupRowActionState(input: GroupRowActionStateInput): GroupRowActionState {
  const {
    group, sessionStatus, isMakeup, isBlockCancelled, hasLessonStarted,
    backendCanEditAttendance, backendCanReopenAttendance,
    scheduleReadOnly, allowGroupEditWhenReadOnly, isTeacher, canDeleteSchedule,
    hasCurrentDayConflict, cancelLoading, lifecycleLoading, attSaving, reopenLoading,
  } = input;

  const isLocked      = sessionStatus === 'LOCKED';
  const isInProgress  = sessionStatus === 'IN_PROGRESS';
  const isCompleted   = sessionStatus === 'COMPLETED';
  const isCancelled   = sessionStatus === 'CANCELLED' || isBlockCancelled;
  const isInvalidated = sessionStatus === 'INVALIDATED';
  // This specific card can render a settled session-level event (cancelled lesson, or a
  // makeup/additional lesson), not the group's live recurring occurrence — see
  // canDeleteGroup below for why that disables the group-pair delete action.
  const isSessionOnlyCard = isCancelled || isInvalidated || isMakeup;

  // P0-3: ARCHIVED group — fully read-only
  const isGroupPaused    = group.status === 'PAUSED';
  const isGroupCompleted = group.status === 'COMPLETED';
  const isGroupArchived  = group.status === 'ARCHIVED';
  const isGroupActive    = !isGroupPaused && !isGroupCompleted && !isGroupArchived;
  const scheduleWriteLocked = scheduleReadOnly || isLocked || isCompleted || isGroupPaused || isGroupCompleted || isGroupArchived || isInvalidated;
  const groupEditLocked = scheduleReadOnly && !allowGroupEditWhenReadOnly;
  const invalidatedRestoreDisabled = !isInvalidated || cancelLoading || isTeacher || isGroupPaused || isGroupCompleted || isGroupArchived;

  // Started-lesson convenience: a started UPCOMING lesson is markable directly even
  // before a LessonSession row exists. The backend submit endpoint ensures the session
  // and permits a started UPCOMING lesson (sessionStateMachine.isAttendanceAllowed), so
  // this must not require a pre-existing editable session.
  const attendanceIsFinalized = backendCanReopenAttendance;
  const todayUpcomingMarkable = hasLessonStarted
    && sessionStatus === 'UPCOMING'
    && !attendanceIsFinalized
    && !isCancelled && !isInvalidated && !isLocked
    && isGroupActive
    && !scheduleReadOnly;
  // A finalized session is editable as a LOCAL draft too: rows toggle locally and the
  // primary button reopens+re-submits on save (no per-click writes). So "editable now"
  // covers finalized exactly like an unsubmitted lesson — same unmarked/disable logic.
  const canEditAttendanceNow = backendCanEditAttendance || todayUpcomingMarkable || backendCanReopenAttendance;

  const unmarkedCount = canEditAttendanceNow
    ? group.stu.filter(s => s.ta === null).length
    : 0;

  const markAllDisabled = attSaving || !canEditAttendanceNow || isGroupPaused || isGroupCompleted || isGroupArchived
    || isInvalidated || group.stu.length === 0;

  const primaryActionDisabled = isInvalidated
    ? invalidatedRestoreDisabled
    : attSaving || reopenLoading || hasCurrentDayConflict || group.stu.length === 0
    || isGroupPaused || isGroupCompleted || isGroupArchived || isInvalidated
    || !canEditAttendanceNow
    || unmarkedCount > 0;

  const disabledReason =
    isInvalidated && isGroupArchived ? 'Группа архивирована — восстановление недоступно'
    : isInvalidated && isGroupCompleted ? 'Группа завершена — восстановление недоступно'
    : isInvalidated && isGroupPaused ? 'Группа на паузе — восстановление недоступно'
    : isInvalidated ? (isTeacher ? 'Восстановление аннулированного урока доступно только владельцу' : 'Восстановить урок в расписание')
    : hasCurrentDayConflict ? 'Исправьте конфликт расписания перед сдачей посещаемости'
    : group.stu.length === 0 ? 'Добавьте студентов в группу перед сдачей посещаемости'
    : isGroupPaused ? 'Группа на паузе'
    : isGroupCompleted ? 'Группа завершена'
    : isGroupArchived ? 'Группа архивирована'
    : (!canEditAttendanceNow && sessionStatus === 'UPCOMING' && !hasLessonStarted) ? 'Урок ещё не начался — посещаемость станет доступна после начала'
    : !canEditAttendanceNow ? 'Посещаемость сейчас недоступна'
    : unmarkedCount > 0 ? `Отметьте всех студентов: осталось ${unmarkedCount}`
    : undefined;

  const primaryActionLabel =
    isInvalidated && (isGroupPaused || isGroupCompleted || isGroupArchived) ? '🔒 Восстановление недоступно'
    : isInvalidated ? (cancelLoading ? 'Восстановление...' : 'Восстановить аннулированный урок')
    : hasCurrentDayConflict ? 'Конфликт расписания — исправьте сначала'
    : group.stu.length === 0 ? 'Нет студентов в группе'
    : isGroupArchived ? 'Группа в архиве'
    : (reopenLoading || attSaving) ? 'Сохранение...'
    : unmarkedCount > 0 ? `Отметьте всех студентов: осталось ${unmarkedCount}`
    : backendCanReopenAttendance ? 'Сохранить изменения'
    : 'Сдать посещаемость';

  // Book issuance / chapter are group-attribute writes, not session-level actions, so
  // they follow group state (archived/active) — NOT the read-only display state of a
  // block or historical week. The isGroupArchived/isGroupActive guards already block
  // dead groups; scheduleReadOnly is deliberately excluded (restored to pre-#141).
  const canBook = !isTeacher && !!group.studentGroupId && !isGroupArchived;
  const canChapter = !isTeacher && !!group.studentGroupId && isGroupActive;

  const canEditGroup = !groupEditLocked;
  // Session-only cards (cancelled / invalidated / makeup) render a settled event, not the
  // group's live recurring occurrence — group-pair delete has no notion of "this one
  // session" and 404s if the active pair has since changed. Use the "Урок" actions instead.
  const canDeleteGroup = canDeleteSchedule && !scheduleReadOnly && !isGroupCompleted && !isGroupArchived && !isSessionOnlyCard;
  const canPauseGroup = !isTeacher && !scheduleReadOnly && isGroupActive && !!group.studentGroupId && !lifecycleLoading;
  const canCompleteGroup = !isTeacher && !scheduleReadOnly && isGroupActive && !lifecycleLoading;
  const canRestoreSession = isInvalidated ? !invalidatedRestoreDisabled : isCancelled ? !cancelLoading : false;
  const canCancelSession = !isCancelled && !isInvalidated && !isTeacher && !scheduleWriteLocked && !cancelLoading;

  return {
    isLocked, isInProgress, isCompleted, isCancelled, isInvalidated, isSessionOnlyCard,
    isGroupPaused, isGroupCompleted, isGroupArchived, isGroupActive,
    scheduleWriteLocked, groupEditLocked, invalidatedRestoreDisabled,
    canEditAttendanceNow, unmarkedCount, markAllDisabled,
    canBook, canChapter,
    canEditGroup, canDeleteGroup, canPauseGroup, canCompleteGroup, canRestoreSession, canCancelSession,
    primaryActionLabel, primaryActionDisabled, disabledReason,
  };
}
