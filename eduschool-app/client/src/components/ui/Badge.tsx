import { HTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn';

export interface BadgeProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'frozen';
  size?: 'sm' | 'md' | 'lg';
}

const Badge = forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant = 'info', size = 'md', ...props }, ref) => {
    const variants = {
      info: 'bg-primaryContainer text-onPrimaryContainer',
      success: 'bg-success/20 text-success',
      warning: 'bg-warning/20 text-[#9c5717]',
      frozen: 'bg-[#EFF6FF] text-[#0284C7]',
      danger: 'bg-danger/20 text-danger',
      neutral: 'bg-surfaceLow text-textSecondary border border-border',
    };

    const sizes = {
      sm: 'px-1.5 py-0.5 text-[10px]',
      md: 'px-2.5 py-0.5 text-xs',
      lg: 'px-3 py-1 text-sm',
    };

    return (
      <div
        ref={ref}
        className={cn(
          'inline-flex items-center rounded-full font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      />
    );
  }
);
Badge.displayName = 'Badge';

export { Badge };
