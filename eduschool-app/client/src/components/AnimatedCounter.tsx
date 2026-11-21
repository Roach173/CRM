import { useEffect, useMemo, useState } from 'react';
import { useInView } from 'framer-motion';
import { useRef } from 'react';

type AnimatedCounterProps = {
  value: number;
  prefix?: string;
  suffix?: string;
  compact?: boolean;
  decimals?: number;
  className?: string;
};

function formatValue(value: number, compact: boolean, decimals: number) {
  if (compact) {
    return new Intl.NumberFormat('ru-RU', {
      maximumFractionDigits: decimals,
      notation: 'compact',
      compactDisplay: 'short',
    }).format(value);
  }

  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(value);
}

export function AnimatedCounter({ value, prefix = '', suffix = '', compact = false, decimals = 0, className = '' }: AnimatedCounterProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-80px' });
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    if (!isInView) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      setCurrent(value);
      return undefined;
    }

    let frame = 0;
    const duration = 1250;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCurrent(value * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isInView, value]);

  const formatted = useMemo(() => formatValue(current, compact, decimals), [compact, current, decimals]);

  return (
    <span className={className} ref={ref}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
