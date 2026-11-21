import { Search, X } from 'lucide-react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

/**
 * Single source of truth for search bars across the app.
 * Pill style + left search icon + clear (X) button when non-empty.
 * `className` controls width/layout only (e.g. "flex-1", "max-w-sm", "w-80").
 */
export default function SearchInput({ value, onChange, placeholder = 'Поиск', className = '', autoFocus }: SearchInputProps) {
  return (
    <div className={`flex items-center gap-2 bg-surfaceLowest px-3 py-2 rounded-xl border border-border ${className}`}>
      <Search className="w-4 h-4 text-textSecondary flex-shrink-0" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="bg-transparent outline-none focus-visible:shadow-none text-sm text-textPrimary placeholder:text-textSecondary/50 w-full"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Очистить"
          className="text-textSecondary hover:text-danger transition-colors flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
