import { HTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn';

/* ── Card ──────────────────────────────────────────────────────── */
const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded bg-white border border-border shadow-sm text-textPrimary ' +
        'transition-shadow duration-200 hover:shadow-md',
        className
      )}
      {...props}
    />
  )
);
Card.displayName = 'Card';

/* ── CardHeader ─────────────────────────────────────────────────── */
const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex flex-col space-y-1.5 p-6', className)}
      {...props}
    />
  )
);
CardHeader.displayName = 'CardHeader';

/* ── CardTitle ──────────────────────────────────────────────────── */
const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('text-heading-md font-semibold text-textPrimary leading-snug', className)}
      {...props}
    />
  )
);
CardTitle.displayName = 'CardTitle';

/* ── CardDescription ────────────────────────────────────────────── */
const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn('text-body-sm text-textSecondary', className)}
      {...props}
    />
  )
);
CardDescription.displayName = 'CardDescription';

/* ── CardContent ────────────────────────────────────────────────── */
const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('p-6 pt-0', className)}
      {...props}
    />
  )
);
CardContent.displayName = 'CardContent';

/* ── CardFooter ─────────────────────────────────────────────────── */
const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center p-6 pt-0', className)}
      {...props}
    />
  )
);
CardFooter.displayName = 'CardFooter';

/* ── CardSection (Polaris sub-section with divider) ─────────────── */
const CardSection = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('px-6 py-4 border-t border-border first:border-t-0', className)}
      {...props}
    />
  )
);
CardSection.displayName = 'CardSection';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardSection };
