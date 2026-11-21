import { useEffect } from 'react';

// Ref-counted so nested overlays (confirm dialog on top of a profile modal)
// don't unlock the page when the inner one closes.
let locks = 0;
let prevOverflow = '';

/** Freezes background page scroll while an overlay/modal is open. */
export function useBodyScrollLock(active: boolean = true) {
  useEffect(() => {
    if (!active) return;
    if (locks++ === 0) {
      prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    return () => {
      if (--locks === 0) document.body.style.overflow = prevOverflow;
    };
  }, [active]);
}
