import { useRef, useEffect, type RefObject } from 'react';

export function useZoomCtrlScroll(
  containerRef: { current: HTMLElement | null },
  zoom: number,
  onZoomChange?: (val: number) => void,
): RefObject<HTMLDivElement | null> {
  const zoomWrapRef = useRef<HTMLDivElement>(null);
  const liveZoom = useRef(zoom);
  // Last zoom applied via the CSS `zoom` property (a full-relayout operation).
  const committedZoom = useRef(zoom);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    liveZoom.current = zoom;
    committedZoom.current = zoom;
    if (zoomWrapRef.current) {
      zoomWrapRef.current.style.transform = '';
      zoomWrapRef.current.style.zoom = String(zoom / 100);
    }
  }, [zoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const next = Math.max(50, Math.min(200, liveZoom.current + (e.deltaY > 0 ? -5 : 5)));
      liveZoom.current = next;
      const wrap = zoomWrapRef.current;
      if (wrap) {
        // During the gesture: scale via transform — compositor-only, no relayout.
        // Writing CSS `zoom` here instead re-laid-out the entire grid table on
        // every wheel tick, which is what made Ctrl+scroll zoom janky.
        wrap.style.transformOrigin = '0 0';
        wrap.style.transform = `scale(${next / committedZoom.current})`;
      }
      clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => {
        // Gesture settled: swap the cheap transform for real `zoom` (one relayout,
        // restores crisp text and correct scroll dimensions), then sync React state.
        const w = zoomWrapRef.current;
        if (w) {
          w.style.transform = '';
          w.style.zoom = String(next / 100);
        }
        committedZoom.current = next;
        onZoomChange?.(next);
      }, 150);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [containerRef, onZoomChange]);

  return zoomWrapRef;
}
