import { ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'tertiary' | 'outline' | 'critical' | 'plain';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  fullWidth?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      isLoading,
      fullWidth,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const base =
      'inline-flex items-center justify-center gap-2 font-semibold rounded select-none ' +
      'transition duration-150 focus-visible:outline-none ' +
      'disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98]';

    const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
      primary:
        'bg-primary text-white shadow-sm ' +
        'hover:bg-primary-hover hover:shadow-md hover:-translate-y-px ' +
        'active:bg-primary-pressed active:shadow-none active:translate-y-0',

      secondary:
        'bg-primary-subdued text-primary border border-primary-subdued ' +
        'hover:bg-[#d0eade] hover:border-[#b8d9c6]',

      tertiary:
        'bg-transparent text-primary ' +
        'hover:bg-primary-subdued',

      outline:
        'bg-white text-textPrimary border border-border ' +
        'hover:bg-surface hover:border-borderSubdued shadow-sm',

      critical:
        'bg-critical text-white shadow-sm ' +
        'hover:bg-[#b82409] hover:shadow-md hover:-translate-y-px',

      plain:
        'bg-transparent text-primary underline-offset-2 ' +
        'hover:underline p-0 h-auto',
    };

    // On touch screens (no hover) every size keeps a 44px tap target; on pointer
    // devices the compact heights apply so dense desktop toolbars stay tight.
    const sizes: Record<NonNullable<ButtonProps['size']>, string> = {
      sm: 'h-11 px-3 text-body-sm [@media(hover:hover)]:h-9',
      md: 'h-11 px-5 text-body-md',
      lg: 'h-12 px-7 text-body-md',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(
          base,
          variants[variant],
          variant !== 'plain' ? sizes[size] : '',
          fullWidth ? 'w-full' : '',
          className
        )}
        {...props}
      >
        {isLoading && (
          <span
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
        )}
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';

export { Button };
