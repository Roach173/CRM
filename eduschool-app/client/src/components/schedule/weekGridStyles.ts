import type { CSSProperties } from 'react';

// WeekGrid-specific styles only.
// Shared tokens (day header, badges, cell backgrounds) live in scheduleTheme.ts.

export const timeHeader: CSSProperties = {
  width: 60, padding: '4px 4px', textAlign: 'left',
  color: 'var(--color-text-secondary)', fontSize: 10,
  position: 'sticky', left: 0, top: 0, background: 'rgb(var(--color-background))', zIndex: 10,
  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
};

export const slotStartTime: CSSProperties = { fontWeight: 600 };
export const slotEndTime: CSSProperties = { opacity: 0.6 };
export const legacySlotLabel: CSSProperties = { fontSize: 8, color: '#BBB', marginTop: 1, fontStyle: 'italic' };

export type SlotVisualState = 'conflict' | 'historical' | 'archive' | 'normal';

export function slotRow(state: SlotVisualState): CSSProperties {
  switch (state) {
    case 'conflict':
      // Orange top border + "вне сетки" label carry the warning.
      // No background wash — it bled through translucent locked cards as mud.
      return { borderTop: '1px solid rgba(234,88,12,0.25)' };
    case 'historical':
      return { borderTop: '1px solid #EEE', opacity: 0.45 };
    case 'archive':
      return { borderTop: '1px solid #EEE', opacity: 0.7 };
    default:
      return { borderTop: '1px solid var(--color-border)' };
  }
}

export function timeCell(state: SlotVisualState): CSSProperties {
  const colorMap: Record<SlotVisualState, string> = {
    conflict:  '#EA580C',
    historical: '#CCC',
    archive:   '#AAA',
    normal:    'var(--color-text-secondary)',
  };
  return {
    padding: '3px 4px', fontSize: 10,
    color: colorMap[state],
    fontWeight: state === 'conflict' ? 700 : undefined,
    verticalAlign: 'top', whiteSpace: 'nowrap',
    position: 'sticky', left: 0, background: 'rgb(var(--color-background))', zIndex: 1,
  };
}

export function tableCell(columnBg: string | undefined): CSSProperties {
  return {
    padding: 2,
    verticalAlign: 'top',
    cursor: 'pointer',
    background: columnBg,
    position: 'relative',
    border: '1px solid var(--color-border)',
  };
}

export function cellConflict(hasNotes: boolean): CSSProperties {
  return {
    position: 'absolute', top: 2, right: hasNotes ? 12 : 2,
    fontSize: 10, color: '#E65100',
    lineHeight: 1, userSelect: 'none',
  };
}

