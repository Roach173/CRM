import { InputHTMLAttributes, forwardRef, useId } from 'react';
import { cn } from '../../lib/cn';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'suffix'> {
  label?: string;
  helpText?: string;
  error?: string;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, helpText, error, prefix, suffix, id: idProp, ...props }, ref) => {
    const autoId = useId();
    const id = idProp ?? autoId;

    return (
      <div className="w-full space-y-1.5 text-left">
        {label && (
          <label
            htmlFor={id}
            className="block text-body-sm font-semibold text-textPrimary"
          >
            {label}
          </label>
        )}

        <div
          className={cn(
            'relative flex items-center w-full',
            'bg-white border rounded-sm transition duration-150',
            error
              ? 'border-critical focus-within:ring-1 focus-within:ring-critical/40'
              : 'border-border focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20',
          )}
        >
          {prefix && (
            <span className="pl-3 flex-shrink-0 text-textSecondary">{prefix}</span>
          )}

          <input
            id={id}
            ref={ref}
            className={cn(
              'flex-1 h-11 px-3 py-2 bg-transparent text-body-md text-textPrimary',
              'placeholder:text-textDisabled',
              'focus:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-surface',
              !prefix && 'pl-3',
              !suffix && 'pr-3',
              className
            )}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : helpText ? `${id}-help` : undefined}
            {...props}
          />

          {suffix && (
            <span className="pr-3 flex-shrink-0 text-textSecondary">{suffix}</span>
          )}
        </div>

        {helpText && !error && (
          <p id={`${id}-help`} className="text-caption text-textSecondary">
            {helpText}
          </p>
        )}
        {error && (
          <p id={`${id}-error`} className="text-caption text-critical flex items-center gap-1">
            <svg
              width="12"
              height="12"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M18 10A8 8 0 1 1 2 10a8 8 0 0 1 16 0zm-7-4a1 1 0 1 0-2 0v4a1 1 0 1 0 2 0V6zm-1 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"
                clipRule="evenodd"
              />
            </svg>
            {error}
          </p>
        )}
      </div>
    );
  }
);
Input.displayName = 'Input';

export { Input };
