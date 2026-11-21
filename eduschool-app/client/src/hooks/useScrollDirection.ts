import { useEffect, useState } from 'react';

/**
 * Tracks vertical scroll direction on a scrollable element.
 *
 * Returns 'up' (default) or 'down'. Uses a small threshold so the direction only
 * flips on a deliberate scroll, and ignores movement near the very top so the
 * chrome always reappears when the user returns to the start of the list.
 *
 * Mirrors the passive-listener idiom in components/Header.tsx.
 */
export function useScrollDirection(
  ref: React.RefObject<HTMLElement | null>,
  threshold = 8,
): 'up' | 'down' {
  const [direction, setDirection] = useState<'up' | 'down'>('up');

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    let lastY = node.scrollTop;
    let ticking = false;

    const update = () => {
      ticking = false;
      const y = node.scrollTop;
      const delta = y - lastY;
      // Near the top there is nothing to hide for — always reveal.
      if (y <= threshold) {
        setDirection('up');
        lastY = y;
        return;
      }
      if (Math.abs(delta) < threshold) return;
      setDirection(delta > 0 ? 'down' : 'up');
      lastY = y;
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [ref, threshold]);

  return direction;
}
