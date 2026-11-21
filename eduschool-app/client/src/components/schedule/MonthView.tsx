import { memo, useMemo } from 'react';
import type { UseSchedule } from '../../hooks/useSchedule';
import { dateKey } from '../../hooks/useSchedule';
import { DAYS_SHORT, lessonBlockIdForDay, schedViewPropsEqual } from './scheduleTypes';

interface Props {
  sched: UseSchedule;
  month: { year: number; month: number }; // month: 0-11
  timezone?: string;
  onDayClick: (dk: string) => void;
  onDayAnnotation?: (dk: string) => void; // when provided, day cells get an editable note button
}

const DAY_HEADERS = DAYS_SHORT;

interface MonthCell {
  date: Date;
  dk: string;
  activeCount: number;
  cancelledCount: number;
}

function MonthView({ sched, month, timezone = 'Asia/Bishkek', onDayClick, onDayAnnotation }: Props) {
  const { year, month: m } = month;

  // Per-cell active/cancelled counts are the expensive part (getGroupsInCell per
  // slot per day) — memoized so they're only recomputed when the underlying
  // schedule data actually changes, not on every unrelated re-render.
  const cells = useMemo<(MonthCell | null)[]>(() => {
    const firstDay = new Date(year, m, 1);
    const lastDay = new Date(year, m + 1, 0);
    const startDow = (firstDay.getDay() + 6) % 7; // Mon=0
    const raw: (Date | null)[] = Array(startDow).fill(null);
    for (let d = 1; d <= lastDay.getDate(); d++) raw.push(new Date(year, m, d));
    while (raw.length % 7 !== 0) raw.push(null);

    return raw.map(date => {
      if (!date) return null;
      const dk = dateKey(date, timezone);
      const ci = (date.getDay() + 6) % 7;
      let activeCount = 0;
      let cancelledCount = 0;
      for (const sl of sched.slots) {
        for (const g of sched.getGroupsInCell(ci, sl.id, date)) {
          const blockId = lessonBlockIdForDay(g, ci);
          const status = sched.sessionStatuses[`${blockId}_${dk}`];
          if (status === 'CANCELLED' || status === 'INVALIDATED') {
            if (status === 'CANCELLED') cancelledCount++;
          } else {
            activeCount++;
          }
        }
      }
      return { date, dk, activeCount, cancelledCount };
    });
  }, [year, m, timezone, sched.slots, sched.getGroupsInCell, sched.sessionStatuses]);

  const todayKey = dateKey(new Date(), timezone);

  return (
    <div className="w-full overflow-hidden">
      <table className="w-full" style={{ borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr>
            {DAY_HEADERS.map(d => (
              <th key={d} className="py-1 text-center text-[10px] lg:text-[11px] font-bold text-textSecondary">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: cells.length / 7 }, (_, wi) => {
            const rowCells = cells.slice(wi*7, wi*7+7);
            const isCurrentWeek = rowCells.some(c => c && c.dk === todayKey);
            return (
            <tr key={wi} style={isCurrentWeek ? { background: 'rgba(45,106,79,0.05)', boxShadow: 'inset 3px 0 0 var(--color-primary)' } : undefined}>
              {rowCells.map((cell, i) => {
                if (!cell) return (
                  <td key={i} className="h-10 lg:h-[60px] border border-border" />
                );

                const { date, dk, activeCount, cancelledCount } = cell;
                const isToday = dk === todayKey;
                const hasNote = Boolean(sched.dayNotes[dk]);

                return (
                  <td
                    key={i}
                    onClick={() => onDayClick(dk)}
                    className="group relative h-10 lg:h-[60px] border border-border p-1 align-top cursor-pointer transition-colors hover:bg-surfaceLow"
                    style={{ background: isToday ? 'rgba(45,106,79,0.06)' : undefined }}
                  >
                    <div className="flex items-center gap-1">
                      <span className={`text-[11px] lg:text-xs font-semibold ${isToday ? 'text-primary font-black' : 'text-textPrimary'}`}>
                        {date.getDate()}
                      </span>
                      {/* Read-only note indicator (teacher / no editor) */}
                      {hasNote && !onDayAnnotation && (
                        <span className="w-1.5 h-1.5 rounded-full bg-orange-400 inline-block flex-shrink-0" />
                      )}
                    </div>

                    {/* Day note: corner button (stopPropagation so cell click still navigates to week) */}
                    {onDayAnnotation && (
                      <button
                        type="button"
                        title={hasNote ? 'Редактировать заметку' : 'Добавить заметку'}
                        onClick={e => { e.stopPropagation(); onDayAnnotation(dk); }}
                        className={`absolute top-0.5 right-0.5 leading-none rounded px-1 text-[11px] transition-opacity ${hasNote ? 'opacity-100 text-orange-500' : 'opacity-0 group-hover:opacity-60 text-textSecondary hover:!opacity-100'}`}
                      >
                        ✎
                      </button>
                    )}

                    {/* Desktop: show active count + cancelled secondary */}
                    {activeCount > 0 && (
                      <div className="hidden lg:block text-[10px] text-textSecondary mt-0.5">
                        {activeCount} гр.
                      </div>
                    )}
                    {cancelledCount > 0 && (
                      <div className="hidden lg:block text-[10px] text-red-400 mt-0.5">
                        +{cancelledCount} отм.
                      </div>
                    )}

                    {/* Mobile: show compact badges */}
                    {activeCount > 0 && (
                      <div className="lg:hidden mt-0.5">
                        <span className="inline-block text-[9px] font-bold text-primary bg-primary/10 rounded px-1 py-px">
                          {activeCount}
                        </span>
                      </div>
                    )}
                    {cancelledCount > 0 && (
                      <div className="lg:hidden mt-0.5">
                        <span className="inline-block text-[9px] font-bold text-red-400 bg-red-50 rounded px-1 py-px">
                          -{cancelledCount}
                        </span>
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default memo(MonthView, schedViewPropsEqual(['getGroupsInCell', 'slots', 'dayNotes', 'sessionStatuses']));
