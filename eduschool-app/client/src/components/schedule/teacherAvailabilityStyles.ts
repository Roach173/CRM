import type { CSSProperties } from 'react';

// Schedule modal tokens (index.css --sch-*) — dark-mode aware
const C = {
  bg: 'var(--sch-bg)',
  border: 'var(--sch-border)',
  text: 'var(--sch-text)',
  mid: 'var(--sch-mid)',
  light: 'var(--sch-light)',
  selected: 'var(--sch-primary-light)',
  hover: 'var(--sch-bg-light)',
  disabled: 'var(--sch-bg-light)',
};

// ─── Static ───────────────────────────────────────────────────────────────────

export const container: CSSProperties = { position: 'relative', width: '100%' };

export const dropdown: CSSProperties = {
  position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 300,
  background: C.bg,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
  maxHeight: 220,
  overflowY: 'auto',
};

export const chevron: CSSProperties = { color: C.light, fontSize: 10, flexShrink: 0 };
export const dotSpacer: CSSProperties = { width: 8, flexShrink: 0 };
export const emptyLabel: CSSProperties = { flex: 1, color: C.mid };
export const flex1: CSSProperties = { flex: 1 };

// ─── Dynamic ──────────────────────────────────────────────────────────────────

export function statusDot(bg: string): CSSProperties {
  return {
    display: 'inline-block',
    width: 8, height: 8,
    borderRadius: '50%',
    background: bg,
    flexShrink: 0,
  };
}

// Look/focus/hover come from the .sch-field class (index.css) on the trigger.
export function triggerStyle(hasValue: boolean, customStyle?: CSSProperties): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6,
    cursor: 'pointer',
    color: hasValue ? C.text : C.mid,
    textAlign: 'left',
    ...customStyle,
  };
}

export function option(focused: boolean, isDisabled: boolean, isSelected: boolean): CSSProperties {
  const background = focused && !isDisabled
    ? C.hover
    : isSelected
      ? C.selected
      : isDisabled
        ? C.disabled
        : 'transparent';
  return {
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '8px 12px',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    background,
    fontSize: 13,
    color: isDisabled ? C.light : C.text,
    userSelect: 'none',
    opacity: isDisabled ? 0.6 : 1,
  };
}
