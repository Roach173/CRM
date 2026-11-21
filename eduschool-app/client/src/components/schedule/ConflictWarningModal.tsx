import { conflictGuidanceFor } from './ConflictList';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../hooks/useBackButtonClose';

const C = {
  bg: '#FFFFFF',
  bgLight: '#F3F2EE',
  border: '#E5E4DC',
  text: '#1A1A18',
  mid: '#6B6B62',
  orange: '#E65100',
};

interface Props {
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  extraAction?: { label: string; onClick: () => void };
}

export function ConflictWarningModal({ message, confirmLabel = 'Всё равно сохранить', onConfirm, onCancel, extraAction }: Props) {
  const guidance = conflictGuidanceFor(message);

  useBodyScrollLock();
  useBackButtonClose(true, onCancel);

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999,
      }}
      onClick={onCancel}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: C.bg,
          borderRadius: 12,
          padding: '24px 24px 20px',
          maxWidth: 420,
          width: 'calc(100% - 32px)',
          maxHeight: '90dvh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 22, lineHeight: 1, color: C.orange }}>⚠</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{guidance.title}</span>
        </div>
        <p style={{ fontSize: 13, color: C.mid, lineHeight: 1.5, margin: '0 0 20px' }}>
          {message}
        </p>
        <div style={{
          fontSize: 12,
          color: C.orange,
          background: '#FFF8E1',
          border: '1px solid #FFD54F',
          borderRadius: 7,
          padding: '7px 9px',
          margin: '-8px 0 16px',
          lineHeight: 1.4,
        }}>
          {guidance.guidance}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 18px',
              background: C.bgLight, color: C.mid,
              border: `1px solid ${C.border}`,
              borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 600,
            }}
          >
            Отмена
          </button>
          {extraAction && (
            <button
              onClick={extraAction.onClick}
              style={{
                padding: '8px 18px',
                background: '#fff', color: C.orange,
                border: `1px solid ${C.orange}`,
                borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 700,
              }}
            >
              {extraAction.label}
            </button>
          )}
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 18px',
              background: C.orange, color: '#fff',
              border: 'none',
              borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 700,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
