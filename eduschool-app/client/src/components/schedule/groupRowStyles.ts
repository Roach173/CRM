import type { CSSProperties } from 'react';
import { C } from './scheduleTheme';

// ─── DayBadge ─────────────────────────────────────────────────────────────────

export function dayBadge(variant: 'grammar' | 'club', hasDays: boolean): CSSProperties {
  const bg = variant === 'grammar' ? C.greenLight : C.blueLight;
  const fg = variant === 'grammar' ? C.green : C.blue;
  const border = variant === 'grammar' ? '#a5d6a7' : '#90caf9';
  return {
    fontSize: 11, padding: '2px 8px', borderRadius: 10,
    background: hasDays ? bg : C.bgLight,
    color: hasDays ? fg : C.light,
    border: `1px solid ${hasDays ? border : C.border}`,
    fontWeight: 600, cursor: 'default', whiteSpace: 'nowrap', lineHeight: 1.4,
    display: 'inline-block', userSelect: 'none',
  };
}

// ─── TeacherPill ──────────────────────────────────────────────────────────────

export const teacherPillContainer: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4,
};

export function teacherPill(variant: 'grammar' | 'club', isEmpty: boolean, hasSub: boolean): CSSProperties {
  const bg = variant === 'grammar' ? C.greenLight : C.blueLight;
  const fg = variant === 'grammar' ? C.green : C.blue;
  return {
    fontSize: 11, padding: '2px 9px', borderRadius: 12,
    background: isEmpty ? C.bgLight : bg,
    color: isEmpty ? C.light : fg,
    fontWeight: 500, whiteSpace: 'nowrap',
    maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block',
    border: `1px solid ${isEmpty ? C.border : 'transparent'}`,
    textDecoration: hasSub ? 'line-through' : 'none',
    opacity: hasSub ? 0.6 : 1,
  };
}

export const subTeacherPill: CSSProperties = {
  fontSize: 11, padding: '2px 9px', borderRadius: 12,
  background: '#ff9800', color: '#fff', fontWeight: 800,
  boxShadow: '0 1px 3px rgba(255,152,0,0.3)', whiteSpace: 'nowrap',
};

// ─── StudentRow ───────────────────────────────────────────────────────────────

export const studentInfo: CSSProperties = { flex: 1, minWidth: 0 };
// Notes used to be an inline ellipsis-truncated span with the real text in title=,
// i.e. invisible on touch (no hover). Own line, clamped to 2 — tap the row for the
// full text in the profile modal, which is where notes are edited anyway.
export function studentNote(isMobile = false): CSSProperties {
  return {
    fontSize: isMobile ? 12 : 11, color: C.mid, lineHeight: 1.4, marginTop: 3,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    overflow: 'hidden', overflowWrap: 'anywhere',
  };
}
export const studentInfoRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
// Mobile: flexBasis 100% pushes the whole control cluster onto its own line under
// the name, so the name keeps full width instead of wrapping mid-word.
export function studentActions(isMobile = false): CSSProperties {
  return isMobile
    ? { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexBasis: '100%', justifyContent: 'flex-end' }
    : { display: 'flex', alignItems: 'center', gap: 8 };
}
export const menuButtonStu: CSSProperties = {
  background: 'none', border: 'none', padding: '4px', cursor: 'pointer', color: C.mid, fontSize: 18,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  minWidth: 44, minHeight: 44,
};
// Dimmed only on mobile, where the menu is a full-width bottom sheet. Dimming the
// screen behind a 150px desktop dropdown would be theatre.
export function menuBackdrop(isMobile = false): CSSProperties {
  return { position: 'fixed', inset: 0, zIndex: 998, background: isMobile ? 'rgba(0,0,0,0.35)' : undefined };
}
// Desktop: dropdown anchored under the ⋮. Mobile: bottom action sheet — the
// dropdown ran off the bottom edge of the panel for the last rows of a group,
// and its `absolute` anchor detached from the button as the panel scrolled.
export function menuDropdown(isMobile = false): CSSProperties {
  return isMobile
    ? {
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 999,
      background: C.bg, borderTop: `1px solid ${C.border}`,
      borderRadius: '16px 16px 0 0', boxShadow: '0 -4px 24px rgba(0,0,0,0.2)',
      padding: `8px 8px calc(8px + env(safe-area-inset-bottom))`,
      // A long menu on a short phone must scroll inside the sheet, not run off the top edge
      maxHeight: '80dvh', overflowY: 'auto',
    }
    : {
      position: 'absolute', right: 0, top: '100%',
      background: C.bg, border: `1px solid ${C.border}`,
      borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      zIndex: 999, minWidth: 150, padding: '4px 0',
    };
}
export function menuItemRemove(isMobile = false): CSSProperties {
  return {
    width: '100%', padding: isMobile ? '14px 16px' : '8px 12px', textAlign: 'left',
    background: 'none', border: 'none', fontSize: isMobile ? 15 : 12,
    color: '#d32f2f', cursor: 'pointer', fontWeight: isMobile ? 600 : 500,
    display: 'flex', alignItems: 'center', gap: 8,
    minHeight: isMobile ? 48 : undefined, borderRadius: isMobile ? 10 : undefined,
  };
}

export function studentRowBorder(sideColor: string, isMobile = false): CSSProperties {
  // Mobile: the controls sit on their own line, so without a real gap between
  // students a control row reads as ambiguously belonging to either neighbour.
  return { position: 'relative', borderLeft: `3px solid ${sideColor}`, marginBottom: isMobile ? 8 : 2 };
}

export function studentRowArea(selected: boolean, isMobile = false): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 10,
    flexWrap: isMobile ? 'wrap' : 'nowrap',
    padding: isMobile ? '10px 12px' : '9px 16px', cursor: 'pointer',
    background: selected ? 'rgba(45,106,79,0.05)' : undefined,
    borderBottom: `1px solid ${isMobile ? C.border : C.borderSoft}`,
    transition: 'background 0.15s',
    minHeight: 44,
  };
}

export function studentAvatar(bg: string, fg: string): CSSProperties {
  return {
    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
    background: bg, color: fg,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, fontWeight: 700,
  };
}

// ─── GroupRow ─────────────────────────────────────────────────────────────────

export function groupRowContainer(expanded: boolean, color?: string): CSSProperties {
  return {
    borderBottom: `1px solid ${C.border}`,
    background: expanded ? C.bg : 'transparent',
    borderLeft: color ? `3px solid ${color}` : undefined,
  };
}

// `raised` lifts the sticky header above the NEXT group's sticky header, which
// would otherwise paint over this one's open colour-picker / kebab dropdown.
export function groupRowHeader(isMobile = false, expanded = false, raised = false): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: isMobile ? '10px 12px' : '10px 20px',
    cursor: 'pointer', userSelect: 'none', minHeight: 48,
    // Mobile: keep "which group am I in" on screen while scrolling a 100+ roster.
    ...(isMobile && expanded ? {
      position: 'sticky' as const, top: 0, zIndex: raised ? 20 : 5,
      background: C.bg, borderBottom: `1px solid ${C.borderSoft}`,
    } : {}),
  };
}

export function groupInfo(isMobile = false): CSSProperties {
  return { flex: isMobile ? '1 1 auto' : '0 1 auto', minWidth: 0 };
}
// Desktop clips overflowing badges to keep rows one line tall; on mobile that hid
// the teacher/day pills entirely, so wrap them instead.
export function groupInfoRow(isMobile = false): CSSProperties {
  return isMobile
    ? { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
    : { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', overflow: 'hidden' };
}
export const groupSpacer: CSSProperties = { flex: 1 };

export function groupMenuBtnStyle(isMobile = false): CSSProperties {
  return {
    width: isMobile ? 44 : 34, height: isMobile ? 44 : 34,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', cursor: 'pointer', borderRadius: 6,
    fontSize: isMobile ? 20 : 16, color: C.mid, flexShrink: 0,
  };
}

// Desktop anchors to the kebab via coords captured on open — which detach from the
// button as soon as the panel scrolls, and can land off-screen near the bottom.
// Mobile sidesteps both by being a bottom sheet with no anchor at all.
export function groupMenuDropdown(top: number, right: number, isMobile = false): CSSProperties {
  return isMobile
    ? {
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 300,
      maxHeight: '80dvh', overflowY: 'auto',
      background: C.bg, borderRadius: '16px 16px 0 0', boxShadow: '0 -4px 24px rgba(0,0,0,0.25)',
      borderTop: `1px solid ${C.border}`,
      padding: `10px 10px calc(10px + env(safe-area-inset-bottom))`,
    }
    : {
      position: 'fixed', top, right, zIndex: 300,
      background: C.bg, borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
      border: `1px solid ${C.border}`, padding: '6px', minWidth: 180,
    };
}

export function groupMenuItemBase(isMobile = false): CSSProperties {
  return {
    width: '100%', minHeight: isMobile ? 48 : 38,
    padding: isMobile ? '12px 14px' : '8px 12px', textAlign: 'left',
    background: 'none', border: 'none', fontSize: isMobile ? 15 : 13,
    cursor: 'pointer', borderRadius: isMobile ? 10 : 6,
  };
}

export function groupCapacityText(isFull: boolean): CSSProperties {
  return { fontSize: 11, fontWeight: 700, color: isFull ? C.red : C.primary, whiteSpace: 'nowrap' };
}

export const expandedSection: CSSProperties = { borderTop: `1px solid ${C.borderSoft}` };
export const lessonTypeBadge: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: C.mid, textTransform: 'uppercase', letterSpacing: '0.05em',
};

export const lessonTypeHeader: CSSProperties = {
  background: C.bgOff, padding: '8px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
};
export const addStudentBtn: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: C.primary, background: 'none', border: 'none', cursor: 'pointer',
  minHeight: 32,
};
export const studentPickerWrapper: CSSProperties = { padding: '12px 20px', borderBottom: `1px solid ${C.borderSoft}` };
export const studentsList: CSSProperties = { display: 'flex', flexDirection: 'column' };
export const attendanceSection: CSSProperties = { padding: '10px 16px', borderTop: `1px solid ${C.borderSoft}` };

export const noTeacherWarning: CSSProperties = {
  marginBottom: 8, display: 'flex', gap: 6, alignItems: 'flex-start',
  background: C.orangeLight, border: `1px solid ${C.orange}`, borderRadius: 6, padding: '5px 10px',
  fontSize: 11, color: C.orange,
};
export const warningIcon: CSSProperties = { flexShrink: 0 };

export function submitButton(hasConflict: boolean, saving: boolean): CSSProperties {
  return {
    width: '100%', minHeight: 42, padding: '7px 10px', fontSize: 12, fontWeight: 700, borderRadius: 7,
    border: `1px solid ${hasConflict ? '#EF9A9A' : '#a5d6a7'}`,
    cursor: saving || hasConflict ? 'not-allowed' : 'pointer',
    background: hasConflict ? '#FFEBEE' : saving ? C.bgLight : C.greenLight,
    color: hasConflict ? '#C62828' : saving ? C.mid : C.green,
  };
}
