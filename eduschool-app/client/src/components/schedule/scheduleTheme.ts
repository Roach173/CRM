import type { CSSProperties } from 'react';

// ─── Design tokens ────────────────────────────────────────────────────────────
// Single source of truth for all schedule view visuals.
// Both WeekGrid and RoomsView must import from here — never duplicate.

export const T = {
  // Colors
  primary:        '#2D6A4F',
  primarySurface: 'var(--color-today-surface)',
  pastSurface:    'rgba(0,0,0,0.018)',
  todayCellBg:    'rgba(45,106,79,0.032)',
  todayStripBorder: '3px solid rgba(45,106,79,0.38)',

  // Day column
  colMinWidth: 110,

  // Borders
  borderToday:  '2px solid #2D6A4F',
  borderPast:   '2px solid #E0E0E0',
  borderLegacy: '2px dashed #CCC',
  borderEmpty:  '2px solid transparent',
} as const;

// ─── Shared badge styles ──────────────────────────────────────────────────────

export const todayBadgeStyle: CSSProperties = {
  display: 'inline-block', marginBottom: 3,
  fontSize: 8, fontWeight: 800, letterSpacing: '0.08em',
  textTransform: 'uppercase',
  background: T.primary, color: '#fff',
  borderRadius: 4, padding: '1px 6px',
};

export const historyBadgeStyle: CSSProperties = {
  display: 'inline-block', marginBottom: 3,
  fontSize: 8, fontWeight: 600, color: '#999',
  border: '1px solid #DDD', borderRadius: 3, padding: '1px 5px',
};

export const pastBadgeStyle: CSSProperties = {
  display: 'inline-block', marginBottom: 3,
  fontSize: 8, fontWeight: 600, color: '#AAA',
};

// ─── Shared day header cell ───────────────────────────────────────────────────

export function dayHeaderCellStyle(isToday: boolean, isPast: boolean, isLegacy: boolean): CSSProperties {
  return {
    padding: '6px 6px 4px',
    textAlign: 'center',
    minWidth: T.colMinWidth,
    fontWeight: 700,
    userSelect: 'none',
    opacity: isLegacy ? 0.6 : 1,
    position: 'sticky',
    top: 0,
    // Opaque, not a plain rgba() wash: this header stays pinned via `sticky`
    // while content scrolls underneath it, and a translucent background lets
    // that scrolling content show through and overlap the header's own text.
    // Layering the tint over a solid base keeps the same visual color, fully opaque.
    background: isToday
      ? 'linear-gradient(rgba(45,106,79,0.06), rgba(45,106,79,0.06)), rgb(var(--color-background))'
      : 'rgb(var(--color-background))',
    zIndex: 5,
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
    borderBottom: isToday
      ? T.borderToday
      : isPast
        ? T.borderPast
        : isLegacy
          ? T.borderLegacy
          : T.borderEmpty,
  };
}

export function dayNameStyle(isToday: boolean, isPast: boolean, isLegacy: boolean): CSSProperties {
  return {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: 1,
    color: isToday ? T.primary : isPast || isLegacy ? '#BBBBAA' : 'var(--color-text-secondary)',
  };
}

export function dateNumberStyle(isToday: boolean, isPast: boolean, isLegacy: boolean): CSSProperties {
  return {
    fontSize: 13, marginTop: 1,
    fontWeight: isToday ? 900 : 600,
    color: isToday ? T.primary : isPast || isLegacy ? '#CCCCBB' : 'var(--color-text-primary)',
  };
}

// ─── Shared row / column structural styles ───────────────────────────────────

export const stickyFirstColHeader: CSSProperties = {
  padding: '4px 8px', textAlign: 'left', fontSize: 11,
  color: 'var(--color-text-secondary)', fontWeight: 700,
  position: 'sticky', top: 0, left: 0,
  background: 'rgb(var(--color-background))', zIndex: 10,
};

export const stickyFirstColCell: CSSProperties = {
  padding: '6px 8px', fontSize: 12, fontWeight: 700,
  color: 'var(--color-text-primary)', verticalAlign: 'top',
  position: 'sticky', left: 0, background: 'rgb(var(--color-background))', zIndex: 2,
};

export const timeLabelStyle: CSSProperties = {
  fontSize: 9, fontWeight: 700,
  color: 'var(--color-text-secondary)',
  paddingLeft: 2, marginBottom: 1,
};

export function legacyRowStyle(isLegacy: boolean): CSSProperties {
  return { opacity: isLegacy ? 0.5 : 1 };
}

// ─── Shared cell backgrounds ──────────────────────────────────────────────────

export function dayCellBg(isToday: boolean, isPast: boolean, extra?: string): string | undefined {
  return extra || (isToday ? 'rgba(45,106,79,0.06)' : isPast ? T.pastSurface : undefined);
}

// ─── Legacy CSS custom properties (kept for existing consumers) ───────────────
export const C = {
  bg: 'var(--sch-bg)',
  bgOff: 'var(--sch-bg-off)',
  bgLight: 'var(--sch-bg-light)',
  border: 'var(--sch-border)',
  borderSoft: 'var(--sch-border-soft)',
  text: 'var(--sch-text)',
  mid: 'var(--sch-mid)',
  light: 'var(--sch-light)',
  primary: 'var(--sch-primary)',
  primaryLight: 'var(--sch-primary-light)',
  blue: 'var(--sch-blue)',
  blueLight: 'var(--sch-blue-light)',
  red: 'var(--sch-red)',
  redLight: 'var(--sch-red-light)',
  orange: 'var(--sch-orange)',
  orangeLight: 'var(--sch-orange-light)',
  paused: 'var(--sch-paused)',
  pausedLight: 'var(--sch-paused-light)',
  green: 'var(--sch-green)',
  greenLight: 'var(--sch-green-light)',
  greenBorder: 'var(--sch-green-border)',
  blueBorder: 'var(--sch-blue-border)',
  modalShadow: 'var(--sch-modal-shadow)',
} as const;
