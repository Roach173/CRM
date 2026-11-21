import { C } from './scheduleTheme';

interface EditSessionFooterActionsProps {
  saveBtnDisabled: boolean;
  saveBtnLabel: string;
  dateChanged: boolean;
  onSave: () => void;
  onClose: () => void;
  showCancelLesson: boolean;
  onCancelLesson: () => void;
}

// Pure presentational — save()/onClose/cancel-dialog wiring stays in EditSessionPanel.
export function EditSessionFooterActions({
  saveBtnDisabled, saveBtnLabel, dateChanged, onSave, onClose, showCancelLesson, onCancelLesson,
}: EditSessionFooterActionsProps) {
  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button
          onClick={onSave}
          disabled={saveBtnDisabled}
          style={{
            flex: '1 1 180px', minHeight: 40, padding: '7px 10px', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700,
            background: saveBtnDisabled ? C.bgLight : dateChanged ? '#0284C7' : C.primary,
            color: saveBtnDisabled ? C.mid : '#fff',
            cursor: saveBtnDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          {saveBtnLabel}
        </button>
        <button onClick={onClose}
          style={{ minHeight: 40, padding: '7px 14px', background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, cursor: 'pointer', color: C.mid }}>
          Закрыть
        </button>
      </div>
      {showCancelLesson && (
        <button
          onClick={onCancelLesson}
          style={{ marginTop: 6, width: '100%', minHeight: 40, padding: '6px 10px', background: 'none', border: `1px solid ${C.red}`, borderRadius: 7, fontSize: 12, fontWeight: 600, color: C.red, cursor: 'pointer' }}
        >
          Отменить занятие
        </button>
      )}
    </>
  );
}
