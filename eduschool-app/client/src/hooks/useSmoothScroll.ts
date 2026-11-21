import { useEffect, type RefObject } from 'react';
import Lenis from 'lenis';

export function useSmoothScroll(_containerRef?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    // Check for reduced motion
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return undefined;

    // Initialize Lenis with premium options
    const lenis = new Lenis({
      duration: 1.1,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), // Buttery smooth exponential out
      orientation: 'vertical',
      gestureOrientation: 'vertical',
      wheelMultiplier: 1.0,
      touchMultiplier: 1.8,
      infinite: false,
    });

    // Share lenis globally for anchor links and routing to use
    (window as any).lenis = lenis;

    let rafId: number;
    function raf(time: number) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }
    rafId = requestAnimationFrame(raf);

    // Soft magnetic snapping (attraction) to section boundaries
    let snapTimeout: ReturnType<typeof setTimeout> | null = null;
    let isProgrammaticScroll = false;

    const handleScroll = (e: any) => {
      if (isProgrammaticScroll) return;

      if (snapTimeout) clearTimeout(snapTimeout);

      // Trigger snap only when the scroll settles down (low velocity)
      if (Math.abs(e.velocity) < 0.25) {
        snapTimeout = setTimeout(() => {
          const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-snap-section]'));
          const currentScroll = window.scrollY;

          let nearestSection: HTMLElement | null = null;
          let minDiff = Number.POSITIVE_INFINITY;

          sections.forEach((sec) => {
            const diff = sec.offsetTop - currentScroll;
            // Magnetic boundary threshold of 130px
            if (Math.abs(diff) < 130 && Math.abs(diff) < minDiff) {
              minDiff = Math.abs(diff);
              nearestSection = sec;
            }
          });

          if (nearestSection) {
            isProgrammaticScroll = true;
            lenis.scrollTo(nearestSection, {
              duration: 0.9,
              easing: (t) => 1 - Math.pow(1 - t, 4), // Quartic out for graceful magnetic settle
              onComplete: () => {
                isProgrammaticScroll = false;
              },
            });
          }
        }, 120); // Quick debounce to capture deceleration point
      }
    };

    lenis.on('scroll', handleScroll);

    // Bind clean up
    return () => {
      if (snapTimeout) clearTimeout(snapTimeout);
      cancelAnimationFrame(rafId);
      lenis.off('scroll', handleScroll);
      lenis.destroy();
      if ((window as any).lenis === lenis) {
        (window as any).lenis = undefined;
      }
    };
  }, []);
}
