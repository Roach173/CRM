import type { CSSProperties } from 'react';
import { C } from './scheduleTheme';

interface StatusOption {
  value: string;
  label: string;
}

interface EditSessionStatusFieldProps {
  status: string;
  isLocked: boolean;
  statusOptions: StatusOption[];
  statusHelper: string | null;
  statusReadOnly: boolean;
  cancelLoading: boolean;
  onStatusChange: (value: string) => void;
  onRestore: () => void;
  inputStyle: CSSProperties;
  labelStyle: CSSProperties;
}

// Pure presentational — shown only when the session isn't being moved to
// another date (a moved session always starts UPCOMING). Status transitions,
// restore logic, and lessonStatusOptionsFor() stay in EditSessionPanel.
export function EditSessionStatusField({
  status, isLocked, statusOptions, statusHelper, statusReadOnly, cancelLoading,
  onStatusChange, onRestore, inputStyle, labelStyle,
}: EditSessionStatusFieldProps) {
  if (status === 'CANCELLED') {
    return (
      <div style={{ background: '#FFF3CD', border: '1px solid #FBBF24', borderRadius: 8, padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#92400E', fontWeight: 600 }}>⚠️ Занятие отменено</span>
        <button
          onClick={onRestore}
          disabled={cancelLoading}
          style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', background: C.primary, color: '#fff', border: 'none', borderRadius: 6, cursor: cancelLoading ? 'wait' : 'pointer', opacity: cancelLoading ? 0.6 : 1 }}
        >
          Восстановить
        </button>
      </div>
    );
  }

  return (
    <div>
      <label style={labelStyle}>Статус урока</label>
      {isLocked ? (
        <select style={inputStyle} value="LOCKED" disabled>
          <option value="LOCKED">🔒 Зафиксирован</option>
        </select>
      ) : (
        <select
          style={inputStyle}
          value={status}
          onChange={e => onStatusChange(e.target.value)}
          disabled={statusReadOnly}
        >
          {statusOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      )}
      {statusHelper && (
        <div style={{ marginTop: 4, fontSize: 11, color: C.mid, lineHeight: 1.35 }}>
          {statusHelper}
        </div>
      )}
    </div>
  );
}
