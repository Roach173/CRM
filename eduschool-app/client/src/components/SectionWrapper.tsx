import { motion, type Variants } from 'framer-motion';
import type { ReactNode } from 'react';

const sectionVariants: Variants = {
  hidden: { opacity: 0, y: 60, scale: 0.98 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.95, ease: [0.22, 1, 0.36, 1], staggerChildren: 0.08 },
  },
};

type SectionWrapperProps = {
  id?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  dark?: boolean;
};

export function SectionWrapper({ id, children, className = '', contentClassName = '', dark = false }: SectionWrapperProps) {
  const maxWidth = contentClassName.includes('landing-hero-grid') ? 'min(90rem, calc(100vw - 3rem))' : 'min(80rem, calc(100vw - 2rem))';

  return (
    <motion.section
      className={`landing-section relative isolate flex items-center px-4 py-[clamp(4rem,6vw,6rem)] sm:px-6 lg:px-8 ${
        dark ? 'bg-[#06080b] text-white' : 'bg-[#f7f7f1] text-[#111315]'
      } ${className}`}
      data-snap-section
      id={id}
      initial="hidden"
      variants={sectionVariants}
      viewport={{ amount: 0.18, once: true }}
      whileInView="show"
      style={{ willChange: 'transform, opacity', transform: 'translate3d(0, 0, 0)' }}
    >
      <div className={`mx-auto w-full ${contentClassName}`} style={{ maxWidth }}>
        {children}
      </div>
    </motion.section>
  );
}
