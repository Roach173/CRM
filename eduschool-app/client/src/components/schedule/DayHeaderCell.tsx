import type { CSSProperties } from 'react';
import {
  todayBadgeStyle,
  historyBadgeStyle,
  pastBadgeStyle,
  dayHeaderCellStyle,
  dayNameStyle,
  dateNumberStyle,
} from './scheduleTheme';
import { DAYS_SHORT } from './scheduleTypes';

interface Props {
  ci: number;
  date: Date;
  isToday: boolean;
  isPast: boolean;
  showArchiveBadge?: boolean;
  hasNote?: boolean;
  style?: CSSProperties;
  onClick?: () => void;
  onMenu?: (rect: DOMRect) => void;
}

const notesDotStyle: CSSProperties = {
  width: 6, height: 6, borderRadius: '50%',
  background: '#ff9800', margin: '2px auto 0',
};

const menuBtnStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  width: 40,
  height: 40,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  color: '#9CA3AF',
  fontSize: 16,
  lineHeight: 1,
  padding: 0,
};

export default function DayHeaderCell({ ci, date, isToday, isPast, showArchiveBadge = false, hasNote = false, style, onClick, onMenu }: Props) {
  return (
    <th
      style={{
        ...dayHeaderCellStyle(isToday, isPast, showArchiveBadge),
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
      onClick={onClick}
    >
      {showArchiveBadge && (
        <div style={historyBadgeStyle}>архив</div>
      )}
      {isToday && (
        <div style={todayBadgeStyle}>Сегодня</div>
      )}
      {isPast && !isToday && !showArchiveBadge && (
        <div style={pastBadgeStyle}>🔒 история</div>
      )}
      <div style={dayNameStyle(isToday, isPast, showArchiveBadge)}>
        {DAYS_SHORT[ci]}
      </div>
      <div style={dateNumberStyle(isToday, isPast, showArchiveBadge)}>
        {date.getDate()}.{String(date.getMonth() + 1).padStart(2, '0')}
      </div>
      {hasNote && <div style={notesDotStyle} />}
      {onMenu && (
        <button
          onClick={(e) => { e.stopPropagation(); onMenu(e.currentTarget.getBoundingClientRect()); }}
          title="Действия дня"
          style={menuBtnStyle}
        >
          ⋮
        </button>
      )}
    </th>
  );
}
