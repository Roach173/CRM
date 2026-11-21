import { DAYS_FULL } from './scheduleTypes';
import { C } from './scheduleTheme';

interface SlotPanelHeaderProps {
  showSlotAsLabel?: boolean;
  roomName?: string;
  ci: number;
  slot?: { s: string; e: string };
  cellDate: Date;
  groupCount: number;
  totalStudents: number;
  onClose: () => void;
  isMobile?: boolean;
}

// Pure presentational — day/slot label (or room label) plus the group/student
// count and close button. No schedule state, no groupEntries resolution.
export function SlotPanelHeader({
  showSlotAsLabel, roomName, ci, slot, cellDate, groupCount, totalStudents, onClose, isMobile = false,
}: SlotPanelHeaderProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      padding: isMobile ? '12px 12px 10px' : '14px 20px',
      borderBottom: `1px solid ${C.border}`, flexShrink: 0,
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        {showSlotAsLabel && roomName ? (
          <>
            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{roomName}</span>
            <div style={{ fontSize: 12, color: C.light, marginTop: 2 }}>
              {groupCount} групп · {totalStudents} студ.
            </div>
          </>
        ) : (
          <>
            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{DAYS_FULL[ci]}</span>
            <span style={{ fontSize: 15, color: C.mid, margin: '0 6px' }}>·</span>
            <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{slot ? `${slot.s}–${slot.e}` : ''}</span>
            <span style={{ fontSize: 14, color: C.mid, marginLeft: 8 }}>
              {cellDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}
            </span>
            <div style={{ fontSize: 12, color: C.light, marginTop: 2 }}>
              {groupCount} групп · {totalStudents} студ.
            </div>
          </>
        )}
      </div>
      <button onClick={onClose} aria-label="Закрыть"
        style={{ width: isMobile ? 44 : 30, height: isMobile ? 44 : 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', borderRadius: 6, fontSize: isMobile ? 20 : 16, color: C.mid }}
        onMouseEnter={e => (e.currentTarget.style.background = C.bgLight)}
        onMouseLeave={e => (e.currentTarget.style.background = 'none')}>✕</button>
    </div>
  );
}
