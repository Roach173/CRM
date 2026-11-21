import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
import { useRef, type ReactNode } from 'react';

type ParallaxWrapperProps = {
  children: ReactNode;
  speed?: number; // e.g., 0.2 means moving at 20% of scroll speed, -0.2 means moving in opposite direction
  className?: string;
};

export function ParallaxWrapper({ children, speed = 0.2, className = '' }: ParallaxWrapperProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Track the document's absolute vertical scroll
  const { scrollY } = useScroll();

  // Map scrollY to a relative translate offset
  const rawY = useTransform(scrollY, (value) => -value * speed);

  // Smooth the offset values using a premium mass-spring-damping curve
  const y = useSpring(rawY, { damping: 30, stiffness: 200, mass: 0.5 });

  return (
    <motion.div
      className={className}
      ref={ref}
      style={{
        y,
        willChange: 'transform',
        transform: 'translate3d(0, 0, 0)',
      }}
    >
      {children}
    </motion.div>
  );
}
