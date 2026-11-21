import React from 'react';
import { cn } from '../../lib/cn';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  helpText?: string;
  error?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, helpText, error, className, id, ...props }, ref) => {
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
        <textarea
          ref={ref}
          id={inputId}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : helpText ? `${inputId}-help` : undefined}
          className={cn(
            'w-full px-3 py-2.5 rounded-sm border bg-white',
            'text-body-md text-textPrimary',
            'placeholder:text-textDisabled',
            'resize-y min-h-[96px]',
            'transition duration-150',
            'focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary',
            'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-surface',
            error
              ? 'border-critical focus:ring-critical/20 focus:border-critical'
              : 'border-border hover:border-borderSubdued',
            className
          )}
          {...props}
        />
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
Textarea.displayName = 'Textarea';
