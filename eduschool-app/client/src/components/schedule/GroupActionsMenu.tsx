import { C } from './scheduleTheme';
import * as GRS from './groupRowStyles';

interface GroupActionsMenuProps {
  top: number;
  right: number;
  isMobile?: boolean;
  isInvalidated: boolean;
  isCancelled: boolean;
  isTeacher: boolean;
  isGroupActive: boolean;
  isGroupPaused: boolean;
  isGroupCompleted: boolean;
  isGroupArchived: boolean;
  scheduleReadOnly: boolean;
  scheduleReadOnlyReason?: string;
  scheduleWriteLocked: boolean;
  canEditGroup: boolean;
  canDeleteGroup: boolean;
  canPauseGroup: boolean;
  canCompleteGroup: boolean;
  canCancelSession: boolean;
  canRestoreSession: boolean;
  canResumeGroup: boolean;
  cancelLoading: boolean;
  onEditSession: () => void;
  onCancelSession: () => void;
  onRestoreCancelledSession: () => void;
  onRestoreInvalidatedSession: () => void;
  onEditGroup: () => void;
  onPauseGroup: () => void;
  onResumeGroup: () => void;
  onCompleteGroup: () => void;
  onDeleteFromCell: () => void;
  onClose: () => void;
}

export function GroupActionsMenu({
  top, right, isMobile = false,
  isInvalidated, isCancelled, isTeacher, isGroupActive, isGroupPaused, isGroupCompleted, isGroupArchived,
  scheduleReadOnly, scheduleReadOnlyReason, scheduleWriteLocked,
  canEditGroup, canDeleteGroup, canPauseGroup, canCompleteGroup, canCancelSession, canRestoreSession, canResumeGroup,
  cancelLoading,
  onEditSession, onCancelSession, onRestoreCancelledSession, onRestoreInvalidatedSession,
  onEditGroup, onPauseGroup, onResumeGroup, onCompleteGroup, onDeleteFromCell, onClose,
}: GroupActionsMenuProps) {
  return (
    <div style={GRS.groupMenuDropdown(top, right, isMobile)}>
      {/* ── УРОК ── */}
      <div style={{ padding: '2px 10px 4px', fontSize: isMobile ? 11 : 9, fontWeight: 700, color: C.light, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Урок</div>
      {isInvalidated ? (
        <button
          onClick={onRestoreInvalidatedSession}
          disabled={!canRestoreSession}
          title={isTeacher ? 'Восстановление аннулированного урока доступно только владельцу' : undefined}
          style={{
            ...GRS.groupMenuItemBase(isMobile),
            color: !canRestoreSession ? C.light : C.primary,
            opacity: cancelLoading ? 0.5 : 1,
            cursor: !canRestoreSession ? 'not-allowed' : 'pointer',
          }}
        >
          {cancelLoading ? '...' : !canRestoreSession ? '🔒 Восстановить урок' : '↩ Восстановить урок'}
        </button>
      ) : isCancelled ? (
        <button
          onClick={onRestoreCancelledSession}
          disabled={!canRestoreSession}
          style={{ ...GRS.groupMenuItemBase(isMobile), color: C.primary, opacity: cancelLoading ? 0.5 : 1 }}
        >
          {cancelLoading ? '...' : '↩ Восстановить занятие'}
        </button>
      ) : isTeacher ? (
        <div style={{ padding: '3px 10px 5px', fontSize: isMobile ? 13 : 10, color: C.light, lineHeight: 1.4 }}>
          Перенос, отмена и другие изменения урока доступны администратору школы.
        </div>
      ) : (
        <>
          <button
            onClick={onEditSession}
            disabled={scheduleWriteLocked}
            title={scheduleReadOnlyReason}
            style={{ ...GRS.groupMenuItemBase(isMobile), color: scheduleWriteLocked ? C.light : C.text, cursor: scheduleWriteLocked ? 'not-allowed' : 'pointer' }}
          >
            {scheduleWriteLocked ? '🔒 Редактировать урок' : '📅 Редактировать урок'}
          </button>
          <button
            onClick={onCancelSession}
            disabled={!canCancelSession}
            title={scheduleReadOnlyReason}
            style={{ ...GRS.groupMenuItemBase(isMobile), color: scheduleWriteLocked ? C.light : C.red, opacity: (!scheduleWriteLocked && cancelLoading) ? 0.5 : 1, cursor: scheduleWriteLocked ? 'not-allowed' : 'pointer' }}
          >
            {scheduleWriteLocked ? '🔒 Отменить занятие' : cancelLoading ? '...' : '⊘ Отменить занятие'}
          </button>
        </>
      )}

      {/* ── ГРУППА ── */}
      <div style={{ height: 1, background: C.borderSoft, margin: '6px 0 4px' }} />
      <div style={{ padding: '2px 10px 4px', fontSize: isMobile ? 11 : 9, fontWeight: 700, color: C.light, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Группа</div>
      <button
        onClick={onEditGroup}
        disabled={!canEditGroup}
        title={!canEditGroup ? scheduleReadOnlyReason : undefined}
        style={{ ...GRS.groupMenuItemBase(isMobile), color: !canEditGroup ? C.light : (isGroupCompleted || isGroupArchived || isTeacher ? C.mid : C.text), cursor: !canEditGroup ? 'not-allowed' : 'pointer' }}
      >
        {isGroupCompleted || isGroupArchived || isTeacher ? '👁 Просмотр группы' : '✎ Редактировать группу'}
      </button>
      {!isTeacher && !scheduleReadOnly && !isGroupCompleted && !isGroupArchived && (
        <>
          {isGroupActive && (
            <>
              <button
                onClick={onPauseGroup}
                disabled={!canPauseGroup}
                style={{ ...GRS.groupMenuItemBase(isMobile), color: C.paused, opacity: !canPauseGroup ? 0.5 : 1, cursor: !canPauseGroup ? 'not-allowed' : 'pointer' }}
              >
                ⏸ Поставить группу на паузу
              </button>
              <button
                onClick={onCompleteGroup}
                disabled={!canCompleteGroup}
                style={{ ...GRS.groupMenuItemBase(isMobile), color: C.red, opacity: !canCompleteGroup ? 0.5 : 1, cursor: !canCompleteGroup ? 'not-allowed' : 'pointer' }}
              >
                ✓ Завершить группу
              </button>
            </>
          )}
          {isGroupPaused && (
            <>
              <button
                onClick={onResumeGroup}
                disabled={!canResumeGroup}
                style={{ ...GRS.groupMenuItemBase(isMobile), color: C.primary, opacity: !canResumeGroup ? 0.5 : 1, cursor: !canResumeGroup ? 'not-allowed' : 'pointer' }}
              >
                ▶ Возобновить группу
              </button>
              <button
                disabled
                title="Сначала возобновите группу"
                style={{ ...GRS.groupMenuItemBase(isMobile), color: C.light, cursor: 'not-allowed', opacity: 0.5 }}
              >
                🔒 Завершить группу
              </button>
            </>
          )}
        </>
      )}
      {(isGroupCompleted || isGroupArchived) && (
        <div style={{ padding: '3px 10px 5px', fontSize: isMobile ? 13 : 10, color: C.light, lineHeight: 1.4 }}>
          {isGroupArchived ? 'Группа архивирована — управление недоступно' : 'Группа завершена — управление недоступно'}
        </div>
      )}
      {!isTeacher && (
        <>
          <div style={{ height: 1, background: C.borderSoft, margin: '4px 0' }} />
          {!scheduleReadOnly && !isGroupCompleted && !isGroupArchived && (
            canDeleteGroup ? (
              <button onClick={onDeleteFromCell} style={{ ...GRS.groupMenuItemBase(isMobile), color: C.red }}>✕ Удалить из расписания</button>
            ) : (
              <div style={{ padding: '3px 10px 5px', fontSize: isMobile ? 13 : 10, color: C.light, lineHeight: 1.4 }}>
                Это отдельное занятие (отменено / доп. урок / аннулировано) — используйте действия «Урок» выше. Удаление всей группы недоступно с этой карточки.
              </div>
            )
          )}
        </>
      )}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: -1, background: isMobile ? 'rgba(0,0,0,0.35)' : undefined }} />
    </div>
  );
}
