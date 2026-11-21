import React from 'react';
import { cn } from '../../lib/cn';
import { ChevronDown } from 'lucide-react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  helpText?: string;
  error?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, helpText, error, className, id, children, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
    return (
      <div className="flex flex-col gap-1.5 w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-body-sm font-semibold text-textPrimary"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={inputId}
            aria-invalid={!!error}
            aria-describedby={error ? `${inputId}-error` : helpText ? `${inputId}-help` : undefined}
            className={cn(
              'w-full h-11 pl-3 pr-9 rounded-sm border bg-white',
              'text-body-md text-textPrimary appearance-none',
              'transition duration-150',
              'focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-surface',
              error
                ? 'border-critical focus:ring-critical/20 focus:border-critical'
                : 'border-border hover:border-borderSubdued',
              className
            )}
            {...props}
          >
            {children}
          </select>
          {/* Custom chevron icon */}
          <ChevronDown
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary"
            aria-hidden="true"
          />
        </div>
        {helpText && !error && (
          <p id={`${inputId}-help`} className="text-caption text-textSecondary">
            {helpText}
          </p>
        )}
        {error && (
          <p id={`${inputId}-error`} role="alert" className="text-caption text-critical flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M18 10A8 8 0 1 1 2 10a8 8 0 0 1 16 0zm-7-4a1 1 0 1 0-2 0v4a1 1 0 1 0 2 0V6zm-1 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" clipRule="evenodd" />
            </svg>
            {error}
          </p>
        )}
      </div>
    );
  }
);
Select.displayName = 'Select';
