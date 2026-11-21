import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

const MN_FULL = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const MN_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

export function currentPeriod(): string {
  const now = new Date();
  return toPeriod(now.getFullYear(), now.getMonth() + 1);
}

export function periodLabel(period: string): string {
  const [year, mon] = period.split('-').map(Number);
  return `${MN_FULL[mon - 1]} ${year}`;
}

function toPeriod(year: number, month1: number): string {
  return `${year}-${String(month1).padStart(2, '0')}`;
}

function shiftPeriod(period: string, delta: number): string {
  const [year, mon] = period.split('-').map(Number);
  const d = new Date(year, mon - 1 + delta, 1);
  return toPeriod(d.getFullYear(), d.getMonth() + 1);
}

interface MonthYearPickerProps {
  value: string;                       // 'YYYY-MM'
  onChange: (period: string) => void;
  max?: string;                        // 'YYYY-MM' inclusive; default: current month
  min?: string;                        // 'YYYY-MM' inclusive
  className?: string;
}

export function MonthYearPicker({ value, onChange, max, min, className = '' }: MonthYearPickerProps) {
  const effMax = max ?? currentPeriod();
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => Number(value.split('-')[0]));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const canPrev = !min || shiftPeriod(value, -1) >= min;
  const canNext = shiftPeriod(value, 1) <= effMax;
  const step = (delta: number) => onChange(shiftPeriod(value, delta));

  const toggleOpen = () => {
    if (!open) setViewYear(Number(value.split('-')[0]));
    setOpen(!open);
  };

  const now = new Date();
  const arrowCls = 'h-9 w-9 flex items-center justify-center rounded-xl border border-border bg-surfaceLowest text-textSecondary hover:text-textPrimary hover:border-primary/50 transition disabled:opacity-30 disabled:pointer-events-none';

  return (
    <div ref={ref} className={`relative inline-flex items-center gap-1 ${className}`}>
      <button type="button" aria-label="Предыдущий месяц" disabled={!canPrev} onClick={() => step(-1)} className={arrowCls}>
        <ChevronLeft className="w-4 h-4" />
      </button>

      <button
        type="button"
        aria-expanded={open}
        onClick={toggleOpen}
        className="h-9 min-w-[150px] px-3 flex items-center justify-center gap-1.5 rounded-xl border border-border bg-surfaceLowest text-sm font-semibold text-textPrimary hover:border-primary/50 focus:outline-none focus:border-primary transition"
      >
        {periodLabel(value)}
        <ChevronDown className={`w-3.5 h-3.5 text-textSecondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <button type="button" aria-label="Следующий месяц" disabled={!canNext} onClick={() => step(1)} className={arrowCls}>
        <ChevronRight className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute z-50 top-full left-1/2 -translate-x-1/2 mt-1.5 w-64 bg-background border border-border rounded-xl shadow-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              aria-label="Предыдущий год"
              disabled={!!min && toPeriod(viewYear - 1, 12) < min}
              onClick={() => setViewYear(y => y - 1)}
              className="h-8 w-8 flex items-center justify-center rounded-lg text-textSecondary hover:text-textPrimary hover:bg-surfaceLow transition disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-bold text-textPrimary">{viewYear}</span>
            <button
              type="button"
              aria-label="Следующий год"
              disabled={toPeriod(viewYear + 1, 1) > effMax}
              onClick={() => setViewYear(y => y + 1)}
              className="h-8 w-8 flex items-center justify-center rounded-lg text-textSecondary hover:text-textPrimary hover:bg-surfaceLow transition disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1">
            {MN_SHORT.map((m, i) => {
              const period = toPeriod(viewYear, i + 1);
              const disabled = period > effMax || (!!min && period < min);
              const selected = period === value;
              const isNow = viewYear === now.getFullYear() && i === now.getMonth();
              return (
                <button
                  key={m}
                  type="button"
                  disabled={disabled}
                  onClick={() => { onChange(period); setOpen(false); }}
                  className={`h-9 rounded-lg text-sm transition ${
                    selected
                      ? 'bg-primary text-white font-semibold'
                      : disabled
                        ? 'text-textSecondary/40'
                        : `text-textPrimary hover:bg-surfaceLow ${isNow ? 'border border-primary/50 text-primary' : ''}`
                  }`}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
