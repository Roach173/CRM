import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

export function ZoomInput({ zoom, onChange }: { zoom: number; onChange: (val: number) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) {
      ref.current.value = String(zoom);
    }
  }, [zoom]);
  const apply = () => {
    const val = parseInt(ref.current?.value ?? '', 10);
    if (!isNaN(val)) {
      const clamped = Math.max(50, Math.min(200, val));
      if (ref.current) ref.current.value = String(clamped);
      onChange(clamped);
    } else {
      if (ref.current) ref.current.value = String(zoom);
    }
  };
  return (
    <input
      ref={ref}
      type="text"
      defaultValue={String(zoom)}
      onFocus={e => e.target.select()}
      onBlur={apply}
      onKeyDown={e => { if (e.key === 'Enter') { apply(); (e.target as HTMLInputElement).blur(); } }}
      className="w-[46px] text-xs text-textSecondary text-center bg-transparent outline-none border-none cursor-text"
      title="Введите масштаб (50–200)"
    />
  );
}

export function GearIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

export function ActivityIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  );
}

export function DayActionsMenu({
  x, y, isPast, isHistorical, isDayCancelled,
  onNote, onCancel, onRestore, onClose,
}: {
  x: number; y: number;
  isPast: boolean; isHistorical: boolean; isDayCancelled: boolean;
  onNote: () => void; onCancel: () => void; onRestore: () => void; onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onMD(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onMD);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMD);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const actionsOff = isPast || isHistorical;
  const base: CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '9px 14px', fontSize: 13, fontWeight: 500,
    background: 'none', border: 'none', cursor: 'pointer',
  };

  return (
    <div ref={menuRef} style={{
      position: 'fixed',
      top: y,
      left: Math.min(x, window.innerWidth - 200),
      zIndex: 600,
      background: '#fff',
      border: '1px solid #E5E7EB',
      borderRadius: 10,
      boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
      minWidth: 192,
      overflow: 'hidden',
    }}>
      <button onClick={onNote} style={{ ...base, color: '#111827' }}>
        📝 Заметка дня
      </button>
      <div style={{ borderTop: '1px solid #F3F4F6' }} />
      {isDayCancelled ? (
        <button
          onClick={actionsOff ? undefined : onRestore}
          style={{ ...base, color: actionsOff ? '#9CA3AF' : '#2D6A4F', cursor: actionsOff ? 'default' : 'pointer', opacity: actionsOff ? 0.6 : 1 }}
        >
          ↩ Восстановить уроки
        </button>
      ) : (
        <button
          onClick={actionsOff ? undefined : onCancel}
          style={{ ...base, color: actionsOff ? '#9CA3AF' : '#C62828', cursor: actionsOff ? 'default' : 'pointer', opacity: actionsOff ? 0.6 : 1 }}
        >
          ✕ Отменить все уроки
        </button>
      )}
    </div>
  );
}
