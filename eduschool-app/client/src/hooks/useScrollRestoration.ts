import { useLayoutEffect, useEffect } from 'react';

/**
 * Persists an element's scroll offset in sessionStorage so it survives a
 * background-tab reload — Chrome discards inactive tabs under memory pressure
 * and remounts the app from scratch when the tab is revisited, which wipes
 * React state (and scrollTop) even though the user never navigated away.
 *
 * `signal` re-applies the stored offset whenever it changes, so a restore
 * attempted before async data has grown the scrollable area (mount fires
 * before the fetch resolves) isn't clamped to 0 and left there.
 */
export function useScrollRestoration(
  ref: React.RefObject<HTMLElement | null>,
  key: string,
  signal?: unknown,
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stored = sessionStorage.getItem(key);
    if (stored) el.scrollTop = Number(stored);
  }, [ref, key, signal]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    function onScroll() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (el) sessionStorage.setItem(key, String(el.scrollTop)); });
    }
    el.addEventListener('scroll', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
    };
  }, [ref, key]);
}
