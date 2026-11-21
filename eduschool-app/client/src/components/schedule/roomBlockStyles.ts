import type { CSSProperties } from 'react';

// ─── Contrast helper ──────────────────────────────────────────────────────────

function hexToLuma(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function blockTextColors(
  groupColor: string | undefined,
  isPast: boolean,
): { primary: string; secondary: string; capacity: string } {
  if (groupColor?.startsWith('#') && groupColor.length === 7) {
    const light = hexToLuma(groupColor) > 0.35;
    if (light) {
      return {
        primary:   isPast ? 'rgba(0,0,0,0.45)'   : 'rgba(0,0,0,0.87)',
        secondary: isPast ? 'rgba(0,0,0,0.35)'   : 'rgba(0,0,0,0.60)',
        capacity:  isPast ? 'rgba(0,0,0,0.35)'   : 'rgba(0,0,0,0.60)',
      };
    } else {
      return {
        primary:   isPast ? 'rgba(255,255,255,0.60)' : 'rgba(255,255,255,0.95)',
        secondary: isPast ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.75)',
        capacity:  isPast ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.75)',
      };
    }
  }
  return {
    primary:   isPast ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
    secondary: isPast ? 'var(--color-text-secondary)' : 'var(--color-text-secondary)',
    capacity:  isPast ? 'var(--color-text-secondary)' : 'var(--color-text-secondary)',
  };
}

// ─── Static ───────────────────────────────────────────────────────────────────

export const capacityRow: CSSProperties = {
  fontSize: 10, marginTop: 2, display: 'flex', alignItems: 'center', gap: 3,
};

export const capacityWarningIcon: CSSProperties = { flexShrink: 0 };

export const cancelledBadge: CSSProperties = {
  position: 'absolute', top: 2, right: 4, fontSize: 10, color: '#f44336',
};

export const inProgressDot: CSSProperties = {
  position: 'absolute', top: 2, right: 4, fontSize: 9, fontWeight: 900,
  color: '#2D6A4F', lineHeight: 1, userSelect: 'none',
};

export const lockedBadge: CSSProperties = {
  position: 'absolute', top: 2, right: 4, fontSize: 9, lineHeight: 1,
  color: '#9E9E9E', userSelect: 'none',
};

// ─── Dynamic ──────────────────────────────────────────────────────────────────

export function roomBlockContainer(
  borderColor: string, bg: string, cancelled: boolean, isPast: boolean, isLocked?: boolean,
  leftAccent?: string,
): CSSProperties {
  return {
    border: `1px solid ${borderColor}`,
    borderRadius: 6,
    padding: '4px 6px',
    marginBottom: 1,
    cursor: 'pointer',
    background: bg,
    opacity: cancelled ? 0.45 : isLocked ? 0.82 : isPast ? 0.78 : 1,
    position: 'relative',
    transition: 'opacity 0.15s',
    boxShadow: leftAccent ? `inset 3px 0 0 ${leftAccent}` : undefined,
  };
}

export function pastBadgeCircle(bg: string, fg: string): CSSProperties {
  return {
    position: 'absolute', top: 2, right: 4,
    width: 14, height: 14,
    background: bg, color: fg,
    borderRadius: '50%', fontSize: 9, fontWeight: 900,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    lineHeight: 1,
  };
}

export function roomNameText(primaryColor: string): CSSProperties {
  return {
    fontSize: 11, fontWeight: 700,
    color: primaryColor,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    paddingRight: 16, marginBottom: 1,
  };
}

export function groupNameText(primaryColor: string, _hasRoom: boolean): CSSProperties {
  return {
    fontSize: 13,
    fontWeight: 700,
    color: primaryColor,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    paddingRight: 16, marginBottom: 1,
  };
}

export function capacityText(color: string, hasConflict: boolean): CSSProperties {
  return { color, fontWeight: hasConflict ? 700 : 400 };
}


// ─── Teacher colour code ──────────────────────────────────────────────────────
// Grammar = green, Club = blue. Shared by the desktop cell pill and the mobile
// card pill so the two can never drift apart.
export const TEACHER_PILL: Record<'grammar' | 'club', { bg: string; fg: string }> = {
  grammar: { bg: '#E8F5E9', fg: '#1B5E20' },
  club:    { bg: '#E3F2FD', fg: '#1565C0' },
};
