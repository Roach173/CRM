import { useState, useEffect } from 'react';
import { C } from './scheduleTheme';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../hooks/useBackButtonClose';

interface Props {
  dateKey: string;
  dateLabel: string;
  initial: string;
  isPast?: boolean;
  isDayCancelled?: boolean;
  restoring?: boolean;
  onSave: (text: string) => void;
  onClose: () => void;
  onCancelDay?: () => void;
  onRestoreDay?: () => void;
}

export default function DayAnnotationPopup({
  dateKey: _dateKey, dateLabel, initial,
  isPast, isDayCancelled, restoring,
  onSave, onClose, onCancelDay, onRestoreDay,
}: Props) {
  const [text, setText] = useState(initial);

  useBodyScrollLock();
  useBackButtonClose(true, onClose);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const showActions = !isPast && (onCancelDay || onRestoreDay);

  return (
    <div style={{ position:'fixed', inset:0, zIndex:400, display:'flex', alignItems:'flex-start', justifyContent:'center', paddingTop:80 }}>
      <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.3)' }} onClick={onClose} />
      <div style={{
        position:'relative', background: C.bg,
        borderRadius:12, padding:16, paddingBottom:'calc(16px + env(safe-area-inset-bottom))',
        width:340, maxWidth:'90vw', maxHeight:'85dvh', overflowY:'auto',
        boxShadow:'0 8px 32px rgba(0,0,0,0.25)',
      }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
          <span style={{ fontSize:14, fontWeight:700, color: C.text }}>Заметка: {dateLabel}</span>
          <button onClick={onClose} style={{ fontSize:16, background:'none', border:'none', cursor:'pointer', color: C.mid }}>✕</button>
        </div>
        <textarea
          autoFocus
          style={{
            width:'100%', fontSize:12, padding:'8px 10px',
            border:`1px solid ${C.border}`, borderRadius:8,
            background: C.bgOff, color: C.text,
            resize:'vertical', minHeight:80, boxSizing:'border-box',
          }}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Заметка на этот день..."
        />
        <div style={{ display:'flex', gap:8, marginTop:8 }}>
          <button
            onClick={() => { onSave(text); onClose(); }}
            style={{ flex:1, padding:'7px 0', background: C.primary, color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer' }}
          >
            Сохранить
          </button>
        </div>

        {showActions && (
          <>
            <div style={{ margin:'12px 0 10px', borderTop:`1px solid ${C.border}` }} />
            {isDayCancelled ? (
              <button
                disabled={restoring}
                onClick={() => { onClose(); onRestoreDay?.(); }}
                style={{
                  width:'100%', padding:'7px 0',
                  background:'none', border:`1px solid ${C.green}`,
                  borderRadius:8, fontSize:12, fontWeight:600,
                  color: C.green, cursor: restoring ? 'not-allowed' : 'pointer',
                  opacity: restoring ? 0.6 : 1,
                }}
              >
                {restoring ? 'Восстановление...' : 'Сделать день рабочим'}
              </button>
            ) : (
              <button
                onClick={() => { onClose(); onCancelDay?.(); }}
                style={{
                  width:'100%', padding:'7px 0',
                  background:'none', border:`1px solid ${C.red}`,
                  borderRadius:8, fontSize:12, fontWeight:600,
                  color: C.red, cursor:'pointer',
                }}
              >
                Отменить занятия дня
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
