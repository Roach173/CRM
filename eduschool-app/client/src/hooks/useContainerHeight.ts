import { useState, useRef, useLayoutEffect } from 'react';

/**
 * Measures the distance from a DOM element's top to the viewport bottom,
 * returning a CSS height string that fills the remaining screen space.
 * Used by WeekGrid and RoomsView to stay consistent.
 */
export function useContainerHeight(offset = 16): [React.MutableRefObject<HTMLDivElement | null>, string] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState('calc(100dvh - 210px)');

  useLayoutEffect(() => {
    let raf = 0;
    function sync() {
      if (!ref.current) return;
      const top = ref.current.getBoundingClientRect().top;
      if (top > 0) setHeight(`calc(100dvh - ${Math.round(top) + offset}px)`);
    }
    // Coalesce bursts of layout mutations into a single measurement per frame.
    function scheduleSync() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sync);
    }

    sync();
    window.addEventListener('resize', sync);

    // The grid's top can change without the window resizing — e.g. the trial /
    // subscription banner above it mounts/dismisses, or async data shifts the
    // toolbar. ResizeObserver catches size changes of the page body; a
    // MutationObserver catches elements (like the banner) being added/removed
    // above the grid. Both re-measure so the grid always reaches the viewport
    // bottom instead of leaving dead space. The MutationObserver is scoped to
    // the page's <main> (which contains the banner + toolbar) so portal-rendered
    // toasts/dropdowns don't trigger needless reflows.
    const ro = new ResizeObserver(scheduleSync);
    ro.observe(document.body);
    const mutationRoot = ref.current?.closest('main') ?? document.body;
    // Ignore mutations inside the grid itself: collapsing/expanding rows changes
    // the grid's height, not its top, so it never needs a re-measure. Without this
    // guard, collapse-all churns hundreds of rows inside the observed subtree and
    // each one forces a layout — a thrash loop that lags rapid toggle clicks.
    const mo = new MutationObserver(records => {
      if (records.every(r => ref.current?.contains(r.target))) return;
      scheduleSync();
    });
    mo.observe(mutationRoot, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', sync);
      ro.disconnect();
      mo.disconnect();
    };
  }, [offset]);

  return [ref, height];
}
