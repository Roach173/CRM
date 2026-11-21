import type { CSSProperties } from 'react';
import { C } from './scheduleTheme';
import { formatSessionDate } from '../../utils/scheduleUtils';

interface EditSessionMakeupSectionProps {
  existingMakeupDate: string | null;
  showForm: boolean;
  makeupDate: string;
  makeupReason: string;
  makeupSaving: boolean;
  canCreate: boolean;
  showReasonError: boolean;
  minDate: string;
  onShowForm: () => void;
  onMakeupDateChange: (value: string) => void;
  onMakeupReasonChange: (value: string) => void;
  onCreate: () => void;
  onCancelForm: () => void;
  inputStyle: CSSProperties;
  labelStyle: CSSProperties;
}

// Pure presentational — shown only when the session is CANCELLED. The
// showMakeup/makeupDate/makeupReason state and the create-makeup API call
// stay in EditSessionPanel.
export function EditSessionMakeupSection({
  existingMakeupDate, showForm, makeupDate, makeupReason, makeupSaving,
  canCreate, showReasonError, minDate, onShowForm, onMakeupDateChange,
  onMakeupReasonChange, onCreate, onCancelForm, inputStyle, labelStyle,
}: EditSessionMakeupSectionProps) {
  return (
    <div style={{ paddingTop: 8, borderTop: `1px solid ${C.borderSoft}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.mid, marginBottom: 6 }}>Дополнительный урок</div>
      {existingMakeupDate ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 12, color: '#5D4037', background: '#FFF8E1', borderRadius: 6, padding: '6px 10px', fontWeight: 700 }}>
            Доп. урок: {formatSessionDate(existingMakeupDate)}
          </div>
          <button disabled style={{ fontSize: 12, color: C.light, background: C.bgLight, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'not-allowed', padding: '5px 10px', fontWeight: 700 }}>
            Доп. урок уже создан
          </button>
        </div>
      ) : !showForm ? (
        <button
          onClick={onShowForm}
          style={{ fontSize: 12, color: C.primary, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
        >
          + Создать доп. урок
        </button>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          <input
            type="date"
            style={inputStyle}
            value={makeupDate}
            min={minDate}
            onChange={e => onMakeupDateChange(e.target.value)}
          />
          <div>
            <label style={labelStyle}>Причина переноса / замещения</label>
            <textarea
              style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }}
              value={makeupReason}
              placeholder="Например: преподаватель заболел, перенос по просьбе группы"
              onChange={e => onMakeupReasonChange(e.target.value)}
            />
            {showReasonError && (
              <div style={{ marginTop: 3, fontSize: 11, color: C.red }}>
                Укажите причину не менее 5 символов
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={onCreate}
              disabled={!canCreate}
              style={{ flex: 1, padding: '5px 0', background: !canCreate ? C.bgLight : C.primary, color: !canCreate ? C.mid : '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: !canCreate ? 'not-allowed' : 'pointer' }}
            >
              {makeupSaving ? 'Создаём...' : 'Создать доп. урок'}
            </button>
            <button
              onClick={onCancelForm}
              style={{ padding: '5px 10px', background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: C.mid }}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
