import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Settings, Activity, ChevronDown } from 'lucide-react';
import { DAYS_SHORT } from './scheduleTypes';
import { dateKey } from '../../hooks/useSchedule';

/** Entity picker (cabinet / teacher / group) shown under the day tabs. */
export interface MobileDayBarSelector {
  value: string | number;
  options: Array<{ value: string | number; label: string }>;
  onChange: (value: string) => void;
}

interface Props {
  aDays: number[];
  dates: Array<Date | undefined>;
  timezone: string;
  todayKey: string;
  /** Selected day as a weekday index (0 = Mon). */
  selectedDay: number;
  onSelectDay: (ci: number) => void;
  /** Collapse on scroll-down. Only the week view drives this today. */
  collapsed?: boolean;
  hasActiveFilters?: boolean;
  hasControlAlerts?: boolean;
  onOpenSettings?: () => void;
  onOpenControl?: () => void;
  selector?: MobileDayBarSelector;
}

/**
 * The one mobile header for every schedule view (week / rooms / teachers /
 * groups): scrollable day tabs + gear / operational-control icons, with the
 * view's entity picker below the days. Extracted from WeekGrid so the other
 * views stop each inventing their own top bar.
 */
export default function MobileDayBar({
  aDays, dates, timezone, todayKey, selectedDay, onSelectDay,
  collapsed = false, hasActiveFilters = false, hasControlAlerts = false,
  onOpenSettings, onOpenControl, selector,
}: Props) {
  // ── Sliding day-tab pill ───────────────────────────────────────────────────
  // One absolutely-positioned element glides to the selected day via a GPU
  // transform, instead of the green highlight snapping between buttons. Measured
  // before paint so it never flashes at the wrong spot; the first placement is
  // instant (no slide), every later day change animates.
  const dayTabsRef = useRef<HTMLDivElement>(null);
  const pillFirstRef = useRef(true);
  const [pill, setPill] = useState({ left: 0, top: 0, width: 0, height: 0, animate: false });
  useLayoutEffect(() => {
    const btn = dayTabsRef.current?.querySelector<HTMLElement>(`[data-day="${selectedDay}"]`);
    if (!btn) return;
    setPill({
      left: btn.offsetLeft, top: btn.offsetTop,
      width: btn.offsetWidth, height: btn.offsetHeight,
      animate: !pillFirstRef.current,
    });
    pillFirstRef.current = false;
  }, [selectedDay, aDays, collapsed]);
  // Reposition on resize (button widths/positions can shift). Cheap: re-reads
  // layout only on the resize event, never per frame.
  useEffect(() => {
    function reposition() {
      const btn = dayTabsRef.current?.querySelector<HTMLElement>(`[data-day="${selectedDay}"]`);
      if (!btn) return;
      setPill(p => ({ ...p, left: btn.offsetLeft, top: btn.offsetTop, width: btn.offsetWidth, height: btn.offsetHeight, animate: false }));
    }
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [selectedDay]);

  return (
    <div
      className={`sticky top-0 z-20 bg-background border-b border-border/20 overflow-hidden ${
        collapsed ? 'max-h-0 opacity-0 border-b-0' : 'max-h-40 opacity-100'
      }`}
    >
      <div className="flex items-center gap-1 px-2 py-2">
        <div ref={dayTabsRef} className="relative flex items-center gap-1 overflow-x-auto min-w-0 flex-1 no-scrollbar">
          {/* Sliding highlight pill — glides to the selected day */}
          <div
            aria-hidden
            className="absolute left-0 top-0 rounded-xl bg-primary pointer-events-none z-0"
            style={{
              width: pill.width,
              height: pill.height,
              transform: `translate3d(${pill.left}px, ${pill.top}px, 0)`,
              opacity: pill.width ? 1 : 0,
              transition: pill.animate
                ? 'transform 0.34s cubic-bezier(0.16,1,0.3,1), width 0.34s cubic-bezier(0.16,1,0.3,1)'
                : 'none',
            }}
          />
          {aDays.map(ci => {
            const d = dates[ci];
            const isSelected = ci === selectedDay;
            const isToday = d ? dateKey(d, timezone) === todayKey : false;
            return (
              <button
                key={ci}
                data-day={ci}
                onClick={() => onSelectDay(ci)}
                className="relative z-10 flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-xl min-w-[2.5rem] flex-shrink-0 transition-colors duration-300"
                style={isSelected ? { color: '#fff' } : undefined}
              >
                <span className="text-[9px] uppercase tracking-wider font-bold opacity-70">{DAYS_SHORT[ci]}</span>
                <span className={`text-base font-bold leading-none ${isToday && !isSelected ? 'text-primary' : ''}`}>
                  {d?.getDate()}
                </span>
              </button>
            );
          })}
        </div>
        {(onOpenSettings || onOpenControl) && (
          <div className="flex items-center gap-1.5 flex-shrink-0 pl-1">
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="relative h-9 w-9 flex items-center justify-center border border-border rounded bg-white text-textSecondary hover:text-textPrimary hover:bg-surface transition-colors dark:bg-card"
                title="Настройки расписания"
              >
                <Settings className="w-[18px] h-[18px]" />
                {hasActiveFilters && (
                  <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-white dark:ring-card" />
                )}
              </button>
            )}
            {onOpenControl && (
              <button
                type="button"
                onClick={onOpenControl}
                className="relative h-9 w-9 flex items-center justify-center border border-border rounded bg-white text-textSecondary hover:text-textPrimary hover:bg-surface transition-colors dark:bg-card"
                aria-label="Операционный контроль"
                title="Операционный контроль"
              >
                <Activity className="w-[18px] h-[18px]" />
                {hasControlAlerts && (
                  <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-orange-500 ring-2 ring-white dark:ring-card" />
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Entity picker sits under the day tabs — same slot in every view */}
      {selector && (
        <div className="px-2 pb-2">
          <div className="relative">
            <select
              value={selector.value}
              onChange={e => selector.onChange(e.target.value)}
              className="w-full appearance-none rounded-xl border border-border bg-card px-4 py-2.5 pr-10 text-sm font-semibold text-textPrimary cursor-pointer"
            >
              {selector.options.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary" />
          </div>
        </div>
      )}
    </div>
  );
}
