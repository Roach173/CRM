import { useEffect, useRef, useState } from 'react';

/**
 * Reveals an element once it scrolls into view — native IntersectionObserver,
 * no animation library (this hook is used on SchoolLanding.tsx, an eager/
 * critical-path route that deliberately stays out of the framer-motion/gsap
 * bundle used by the lazy-loaded /business-card page).
 *
 * Fires once (unobserves after the first intersection) and is a no-op under
 * prefers-reduced-motion, mirroring the check already used in
 * AnimatedCounter.tsx / useSmoothScroll.ts / PainSection.tsx.
 */
export function useScrollReveal<T extends HTMLElement = HTMLDivElement>(
  options?: { threshold?: number; rootMargin?: string },
) {
  const ref = useRef<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setIsVisible(true);
      return undefined;
    }

    const node = ref.current;
    if (!node) return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.unobserve(entry.target);
        }
      },
      { threshold: options?.threshold ?? 0.15, rootMargin: options?.rootMargin ?? '0px 0px -60px 0px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [options?.threshold, options?.rootMargin]);

  return { ref, isVisible };
}
