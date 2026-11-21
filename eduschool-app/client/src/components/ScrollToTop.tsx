import { useEffect } from 'react';
import { useLocation } from 'react-router';

const positions = new Map<string, number>();

export function ScrollToTop() {
  const location = useLocation();
  const key = location.pathname + location.search;

  useEffect(() => {
    const saved = positions.get(key);
    window.scrollTo(0, saved ?? 0);

    const onScroll = () => {
      positions.set(key, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [key]);

  return null;
}
