import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { lessonWord } from '../../utils/scheduleUtils';

type SlotVisualState = 'conflict' | 'historical' | 'archive' | 'normal';

interface Props {
  /** Slot start / end, already formatted ("08:20"). */
  start: string;
  end: string;
  /** Lessons in this slot on the selected day — shown as "· 8 уроков".
   *  Omit in the pivot views, where a section is one lesson and the count is noise. */
  count?: number;
  state: SlotVisualState;
  /** Renders the "+" affordance and makes the whole band tappable. */
  onAdd?: () => void;
  children: ReactNode;
}

const CHIP: Partial<Record<SlotVisualState, { label: string; cls: string }>> = {
  conflict:   { label: 'вне сетки', cls: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10' },
  historical: { label: 'история',   cls: 'bg-black/5 text-textSecondary/60 dark:bg-white/5' },
  archive:    { label: 'архив',     cls: 'bg-black/5 text-textSecondary/60 dark:bg-white/5' },
};

/**
 * One slot on the mobile schedule: a sticky full-width time band with its cards
 * edge-to-edge underneath.
 *
 * Replaces the old 56px left time gutter. Every card in a slot shares one time,
 * so printing it once as a section header instead of reserving a column for it
 * gives each card back ~68px (~23% of card width on a 393px viewport) — the
 * gutter was blank for the entire height of the slot, which on a slot with 8
 * groups was ~650px of dead space.
 *
 * Sticky is relative to the scroll container, not the page, so the band needs no
 * top offset for MobileDayBar (which collapses on scroll and would break a fixed
 * offset). Callers must therefore render this inside their own scroll container.
 */
export default function MobileSlotSection({ start, end, count = 0, state, onAdd, children }: Props) {
  const chip = CHIP[state];
  const isConflict = state === 'conflict';

  return (
    <section>
      <div
        onClick={onAdd}
        className={`sticky top-0 z-10 flex items-center gap-2 bg-background/95 backdrop-blur-sm py-1.5 ${
          onAdd ? 'cursor-pointer' : ''
        }`}
      >
        <span className={`text-[13px] font-bold tabular-nums ${isConflict ? 'text-orange-600' : 'text-textPrimary'}`}>
          {start} – {end}
        </span>
        {count > 0 && (
          <span className="text-[11px] text-textSecondary/60">· {count} {lessonWord(count)}</span>
        )}
        {chip && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${chip.cls}`}>{chip.label}</span>
        )}
        <span className="flex-1" />
        {onAdd && (
          <button
            type="button"
            aria-label="Добавить урок"
            onClick={e => { e.stopPropagation(); onAdd(); }}
            className="-mr-1.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-textSecondary/50 active:bg-black/5 dark:active:bg-white/5"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="space-y-1.5 pb-1">{children}</div>
    </section>
  );
}
