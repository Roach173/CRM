import { useEffect, useRef } from 'react';

/**
 * Lightweight scroll parallax for a single element — rAF-throttled window
 * scroll listener (same throttle idiom as useScrollDirection.ts), no
 * animation library. No-op under prefers-reduced-motion.
 *
 * `strength` is the fraction of scroll delta applied as a translateY, e.g.
 * 0.15 moves the element 15% of however far the page has scrolled.
 */
export function useParallax<T extends HTMLElement = HTMLDivElement>(strength = 0.15) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const node = ref.current;
    if (!node) return undefined;

    let ticking = false;

    const update = () => {
      ticking = false;
      const rect = node.getBoundingClientRect();
      const viewportCenter = window.innerHeight / 2;
      const elementCenter = rect.top + rect.height / 2;
      const offset = (viewportCenter - elementCenter) * strength;
      node.style.transform = `translate3d(0, ${offset}px, 0)`;
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [strength]);

  return ref;
}
