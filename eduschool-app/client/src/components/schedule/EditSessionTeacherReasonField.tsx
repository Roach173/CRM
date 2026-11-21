import type { CSSProperties } from 'react';
import { C } from './scheduleTheme';

interface EditSessionTeacherReasonFieldProps {
  show: boolean;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  inputStyle: CSSProperties;
  labelStyle: CSSProperties;
}

// Pure presentational — teacherReplaceReason state and the save-payload wiring
// stay in EditSessionPanel. Shown only when a teacher replacement is pending
// and the session isn't being moved to another date.
export function EditSessionTeacherReasonField({
  show, value, invalid, onChange, inputStyle, labelStyle,
}: EditSessionTeacherReasonFieldProps) {
  if (!show) return null;
  return (
    <div>
      <label style={labelStyle}>Причина замены преподавателя *</label>
      <input
        style={inputStyle}
        value={value}
        placeholder="Например: преподаватель заболел"
        onChange={e => onChange(e.target.value)}
      />
      {invalid && (
        <div style={{ marginTop: 3, fontSize: 11, color: C.red }}>
          Укажите причину замены (минимум 5 символов)
        </div>
      )}
    </div>
  );
}
