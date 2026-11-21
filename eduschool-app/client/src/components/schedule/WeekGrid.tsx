import { memo, useMemo, useState, useEffect, useRef } from 'react';
import type { SchedGroup } from './scheduleTypes';
import { doesGroupBelongToTeacherOnDay, schedViewPropsEqual } from './scheduleTypes';
import type { UseSchedule } from '../../hooks/useSchedule';
import { weekDates, weekKey, dateKey } from '../../hooks/useSchedule';
import * as S from './weekGridStyles';
import { dayCellBg } from './scheduleTheme';
import { useContainerHeight } from '../../hooks/useContainerHeight';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useScrollDirection } from '../../hooks/useScrollDirection';
import { useZoomCtrlScroll } from '../../hooks/useZoomCtrlScroll';
import { useMobileChrome } from '../../context/MobileChromeContext';
import DayHeaderCell from './DayHeaderCell';
import MobileDayBar from './MobileDayBar';
import MobileSlotSection from './MobileSlotSection';
import RoomBlock from './RoomBlock';
import { classifySlotVisualState } from '../../utils/scheduleUtils';
import { scKey } from '../../hooks/schedule/scheduleKeys';

interface Props {
  sched: UseSchedule;
  viewWk: string;
  zoom: number;
  timezone?: string;
  teacherFilter?: string;
  groupFilter?: string;
  hasActiveFilters?: boolean;
  hasControlAlerts?: boolean;
  onResetFilters?: () => void;
  isTeacher?: boolean;
  onCellClick: (ci: number, sid: number, room?: string, gid?: number) => void;
  onDayAnnotation: (dk: string) => void;
  onDayMenu?: (dk: string, rect: DOMRect) => void;
  onZoomChange?: (val: number) => void;
  /** Mobile-only: open the schedule settings (view / week / filters) panel. */
  onOpenSettings?: () => void;
  /** Mobile-only: open the operational control panel. */
  onOpenControl?: () => void;
}

// Pure so the isTeacher branch is unit-testable without mounting the grid (see
// WeekGrid.visibleSlots.test.ts). Teachers can't book empty slots — the "planning
// mode" full-day grid is clutter for them, so they only get rows they actually
// teach this week. Staff keep the existing behaviour: every current-policy slot,
// plus any legacy slot that still has a lesson in it.
export function computeVisibleSlots<T extends { id: number }>(
  slots: T[],
  legacySlotIds: number[],
  isTeacher: boolean,
  hasGroupsInSlot: (slotId: number) => boolean,
): T[] {
  if (isTeacher) return slots.filter(slot => hasGroupsInSlot(slot.id));
  const filtered = slots.filter(slot => !legacySlotIds.includes(slot.id) || hasGroupsInSlot(slot.id));
  return filtered.length > 0 || slots.length === 0 ? filtered : slots;
}

function detectCellConflict(groups: SchedGroup[], ci: number): 'teacher' | 'student' | null {
  const teacherIds: number[] = [];
  for (const g of groups) {
    if (g.grammarDays.includes(ci) && g.tgId) teacherIds.push(g.tgId);
    if (g.clubDays.includes(ci) && g.tkId) teacherIds.push(g.tkId);
  }
  if (teacherIds.length > new Set(teacherIds).size) return 'teacher';

  const groupIds = groups.map(g => g.studentGroupId).filter((id): id is number => id != null);
  if (groupIds.length > new Set(groupIds).size) return 'student';

  return null;
}

function EmptyCell({ isPast, isTeacher }: { isPast: boolean; isTeacher?: boolean }) {
  const inactive = isPast || isTeacher;
  return (
    <div
      className={inactive ? undefined : 'sch-empty-slot'}
      style={{
        minHeight: 54,
        ...(inactive ? { border: '1px dashed rgba(0,0,0,0.08)', color: 'rgba(0,0,0,0.1)' } : {}),
        borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 16,
        cursor: inactive ? 'default' : undefined,
      }}
    >
      {inactive ? '' : '+'}
    </div>
  );
}

function WeekGrid({ sched, viewWk, zoom, timezone = 'Asia/Bishkek', teacherFilter, groupFilter, hasActiveFilters = false, hasControlAlerts = false, onResetFilters, isTeacher = false, onCellClick, onDayAnnotation, onDayMenu, onZoomChange, onOpenSettings, onOpenControl }: Props) {
  // Mount only the active layout: both trees were always rendered (CSS-hidden),
  // doubling React work and DOM size. The lg: classes stay as a paint-safety net
  // at the exact breakpoint (resize event fires after layout).
  const isMobile = useIsMobile();
  const dates = useMemo(() => weekDates(viewWk, timezone), [viewWk, timezone]);
  const todayKey = useMemo(() => dateKey(new Date(), timezone), [timezone]);
  const currentWeekKey = useMemo(() => weekKey(new Date(), timezone), [timezone]);
  const isArchiveWeek = viewWk < currentWeekKey;
  const groupFilterId = groupFilter ? Number(groupFilter) : null;

  const cellGroups = useMemo(() => {
    const grid: Record<string, SchedGroup[]> = {};
    for (const slot of sched.slots) {
      for (const ci of sched.aDays) {
        let groups = sched.getGroupsInCell(ci, slot.id, dates[ci]);
        if (teacherFilter) {
          groups = groups.filter(g => doesGroupBelongToTeacherOnDay(g, teacherFilter, ci));
        }
        if (groupFilterId != null) {
          groups = groups.filter(g => g.studentGroupId === groupFilterId);
        }
        grid[scKey(ci, slot.id)] = groups;
      }
    }
    return grid;
  }, [sched.getGroupsInCell, sched.slots, sched.aDays, dates, teacherFilter, groupFilterId]);
  const visibleSlots = useMemo(
    () => computeVisibleSlots(
      sched.slots,
      sched.legacySlotIds,
      isTeacher,
      slotId => sched.aDays.some(ci => (cellGroups[scKey(ci, slotId)] ?? []).length > 0),
    ),
    [sched.slots, sched.legacySlotIds, sched.aDays, cellGroups, isTeacher],
  );
  const noLessonsThisWeek = isTeacher && visibleSlots.length === 0;
  const noFilteredLessons = hasActiveFilters && Object.values(cellGroups).every(groups => groups.length === 0);

  // ── Mobile chrome (collapses on scroll-down to give the grid the full screen) ─
  const { navHidden, setNavHidden } = useMobileChrome();

  // ── Dynamic height ─────────────────────────────────────────────────────────
  const [desktopRef, desktopH]     = useContainerHeight(0);
  // Imperative Ctrl+scroll zoom (shared hook — was an inline duplicate here)
  const zoomWrapRef = useZoomCtrlScroll(desktopRef, zoom, onZoomChange);
  // Mobile reserves room for the fixed bottom nav (~80px, matching the page's
  // pb-20) so the slot list fills down to just above it instead of running under
  // it or stopping short. When the nav is hidden on scroll, the list reclaims
  // that space (offset drops to ~16px).
  const [mobileListRef, mobileListH] = useContainerHeight(navHidden ? 16 : 80);

  // Survive a background-tab reload (Chrome discards inactive tabs and remounts
  // the app on return): restore scrollTop from sessionStorage, re-applying as
  // sched.slots grows so an early restore isn't clamped before data loads.
  useScrollRestoration(desktopRef, 'schedule.scroll.week.desktop', sched.slots.length);
  useScrollRestoration(mobileListRef, 'schedule.scroll.week.mobile', sched.slots.length);

  // TEMP DEBUG — remove after diagnosing the tab-switch scroll reset.
  useEffect(() => {
    console.log('[scroll-debug] WeekGrid MOUNTED');
    return () => console.log('[scroll-debug] WeekGrid UNMOUNTED');
  }, []);
  useEffect(() => {
    const onVis = () => {
      console.log('[scroll-debug] visibility=', document.visibilityState,
        'desktopScrollTop=', desktopRef.current?.scrollTop,
        'desktopScrollHeight=', desktopRef.current?.scrollHeight,
        'stored=', sessionStorage.getItem('schedule.scroll.week.desktop'));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Hide the day bar + bottom nav while scrolling the slot list down, reveal on
  // scroll up. Reset on unmount so other pages never inherit a hidden nav.
  const mobileScrollDir = useScrollDirection(mobileListRef);
  useEffect(() => { setNavHidden(mobileScrollDir === 'down'); }, [mobileScrollDir, setNavHidden]);
  useEffect(() => () => setNavHidden(false), [setNavHidden]);

  // ── Mobile day state ───────────────────────────────────────────────────────
  function defaultMobileDay() {
    const todayIdx = sched.aDays.find(ci => dates[ci] && dateKey(dates[ci], timezone) === todayKey);
    return todayIdx ?? sched.aDays[0] ?? 0;
  }
  const [mobileDay, setMobileDay] = useState<number>(defaultMobileDay);

  // Re-run when aDays _values_ change (detected via stable string), not when array reference changes.
  // String identity stays stable if day values are unchanged → no reset on Socket.IO reloads.
  // But transitions from empty [] to populated values (e.g. [] → [0,1,2,3,4]) change the string → re-run once.
  const aDaysKey = sched.aDays.join(',');
  useEffect(() => { setMobileDay(defaultMobileDay()); }, [viewWk, aDaysKey]);

  const mobileDate = dates[mobileDay];
  const mobileDk = mobileDate ? dateKey(mobileDate, timezone) : '';
  const mobileDateIsToday = mobileDk === todayKey;
  const mobileDateIsPast = mobileDk < todayKey;

  function prevDay() {
    const idx = sched.aDays.indexOf(mobileDay);
    if (idx > 0) setMobileDay(sched.aDays[idx - 1]);
  }
  function nextDay() {
    const idx = sched.aDays.indexOf(mobileDay);
    if (idx < sched.aDays.length - 1) setMobileDay(sched.aDays[idx + 1]);
  }

  // ── Mobile swipe / touchpad slide → switch day (Mon→Tue), never the week ────
  const swipeStartX = useRef(0);
  const swipeStartY = useRef(0);
  const dayWheelCooldown = useRef(false);
  const dayWheelCooldownTimer = useRef<number | null>(null);
  // Clear the cooldown timer on unmount so it can't fire into an unmounted tree.
  useEffect(() => () => {
    if (dayWheelCooldownTimer.current !== null) window.clearTimeout(dayWheelCooldownTimer.current);
  }, []);
  function handleDaySwipeStart(e: React.TouchEvent) {
    swipeStartX.current = e.touches[0].clientX;
    swipeStartY.current = e.touches[0].clientY;
  }
  function handleDaySwipeEnd(e: React.TouchEvent) {
    const dx = e.changedTouches[0].clientX - swipeStartX.current;
    const dy = e.changedTouches[0].clientY - swipeStartY.current;
    // Ignore vertical scrolls and small drags; only act on a deliberate horizontal swipe.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) nextDay(); else prevDay();
  }
  // Laptop touchpad two-finger slide fires wheel events (deltaX), not touch events.
  function handleDayWheel(e: React.WheelEvent) {
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) return; // vertical scroll → let the list scroll
    if (Math.abs(e.deltaX) < 30) return;
    if (dayWheelCooldown.current) return;
    dayWheelCooldown.current = true;
    dayWheelCooldownTimer.current = window.setTimeout(() => { dayWheelCooldown.current = false; }, 600);
    if (e.deltaX > 0) nextDay(); else prevDay();
  }

  // ── Slide transition direction ──────────────────────────────────────────────
  // Computed *during render* (not in an effect) so the new content and its slide
  // animation commit in the same frame — otherwise the page visibly switches a
  // frame before the animation starts. The class is cleared again ~340ms later:
  // it carries `will-change: transform` (plus an in-flight `transform` while the
  // keyframe runs), and a transformed ancestor becomes the containing block for
  // any `position: sticky` descendant — the day-header row, the mobile slot time
  // bands. Left on permanently (as it was before), the very first day/week
  // navigation would silently break their stickiness for the rest of the
  // session. A timeout — not `onAnimationEnd` — clears it, so it still resolves
  // under `prefers-reduced-motion`, where the animation itself is skipped.
  const prevDayRef = useRef(mobileDay);
  const dayDirRef = useRef<'next' | 'prev'>('next');
  const [dayAnimating, setDayAnimating] = useState(false);
  if (mobileDay !== prevDayRef.current) {
    dayDirRef.current = sched.aDays.indexOf(mobileDay) >= sched.aDays.indexOf(prevDayRef.current) ? 'next' : 'prev';
    prevDayRef.current = mobileDay;
    setDayAnimating(true);
  }
  const dayAnimClass = dayAnimating ? `sch-slide-${dayDirRef.current}` : '';
  useEffect(() => {
    if (!dayAnimating) return;
    const t = setTimeout(() => setDayAnimating(false), 340);
    return () => clearTimeout(t);
  }, [dayAnimating]);

  const prevWeekRef = useRef(viewWk);
  const weekDirRef = useRef<'next' | 'prev'>('next');
  const [weekAnimating, setWeekAnimating] = useState(false);
  if (viewWk !== prevWeekRef.current) {
    weekDirRef.current = viewWk > prevWeekRef.current ? 'next' : 'prev';
    prevWeekRef.current = viewWk;
    setWeekAnimating(true);
  }
  const weekAnimClass = weekAnimating ? `sch-slide-${weekDirRef.current}` : '';
  useEffect(() => {
    if (!weekAnimating) return;
    const t = setTimeout(() => setWeekAnimating(false), 340);
    return () => clearTimeout(t);
  }, [weekAnimating]);

  return (
    <>
      {noFilteredLessons && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded border border-border bg-white px-3 py-2 text-sm text-textSecondary">
          <span>Нет занятий по выбранным фильтрам</span>
          <button
            onClick={onResetFilters}
            className="text-primary font-semibold hover:underline"
          >
            Сбросить фильтры
          </button>
        </div>
      )}
      {noLessonsThisWeek && (
        <div className="mb-3 rounded border border-border bg-white px-3 py-2 text-sm text-textSecondary">
          На этой неделе занятий нет.
        </div>
      )}
      {/* ── Mobile (hidden on desktop) ─────────────────────────────────────── */}
      {isMobile && (
      <div className="block lg:hidden" onTouchStart={handleDaySwipeStart} onTouchEnd={handleDaySwipeEnd} onWheel={handleDayWheel}>

        {/* Shared mobile header (day tabs + action icons) — same bar in every view */}
        <MobileDayBar
          aDays={sched.aDays}
          dates={dates}
          timezone={timezone}
          todayKey={todayKey}
          selectedDay={mobileDay}
          onSelectDay={setMobileDay}
          collapsed={navHidden}
          hasActiveFilters={hasActiveFilters}
          hasControlAlerts={hasControlAlerts}
          onOpenSettings={onOpenSettings}
          onOpenControl={onOpenControl}
        />

        {/* Slot rows for selected mobile day */}
        <div ref={mobileListRef} className="px-4 pb-4 overflow-y-auto" style={{ maxHeight: mobileListH }}>
          <div className={`space-y-3 ${dayAnimClass}`}>
          {visibleSlots.map(slot => {
            const groups = cellGroups[scKey(mobileDay, slot.id)] ?? [];
            const isLegacyMobile = sched.legacySlotIds.includes(slot.id);
            const mobileDk = dates[mobileDay] ? dateKey(dates[mobileDay], timezone) : '';
            const mobileSlotState = classifySlotVisualState({
              isLegacySlot: isLegacyMobile,
              isArchiveWeek,
              groupsPerDay: [{ groups, isPast: mobileDk < todayKey }],
            });
            const conflictMobile = mobileSlotState === 'conflict';
            const historicalMobile = mobileSlotState === 'historical';
            const canAdd = !mobileDateIsPast && !isTeacher;
            return (
              <MobileSlotSection
                key={slot.id}
                start={slot.s}
                end={slot.e}
                count={groups.length}
                state={conflictMobile ? 'conflict' : historicalMobile ? 'historical' : 'normal'}
                onAdd={canAdd ? () => onCellClick(mobileDay, slot.id) : undefined}
              >
                {groups.length === 0 ? (
                  <div
                    onClick={() => { if (canAdd) onCellClick(mobileDay, slot.id); }}
                    className={`h-11 rounded-xl border border-dashed flex items-center justify-center text-sm transition-colors ${
                      canAdd
                        ? 'border-border/50 text-textSecondary/40 hover:border-primary/40 hover:text-primary/50'
                        : 'border-border/20 text-textSecondary/20'
                    }`}
                  >
                    {canAdd && '+ Добавить'}
                  </div>
                ) : groups.map(g => (
                  <RoomBlock
                    key={g.id}
                    group={g}
                    ci={mobileDay}
                    sid={slot.id}
                    date={dates[mobileDay]}
                    sched={sched}
                    timezone={timezone}
                    isPast={mobileDateIsPast}
                    isToday={mobileDateIsToday}
                    layout="mobile"
                    onCellClick={() => onCellClick(mobileDay, slot.id, undefined, g.id)}
                  />
                ))}
              </MobileSlotSection>
            );
          })}
          </div>
        </div>
      </div>
      )}

      {/* ── Desktop table (hidden on mobile) ──────────────────────────────────── */}
      {!isMobile && (
      <div
        ref={desktopRef}
        className="hidden lg:block custom-scrollbar"
        style={{ overflowX: 'auto', overflowY: 'auto', height: desktopH }}
      >
        <div ref={zoomWrapRef}>
        <div className={weekAnimClass}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 480, tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={S.timeHeader}>Время</th>
              {sched.aDays.map(ci => {
                const date = dates[ci];
                const dk = dateKey(date, timezone);
                const isToday = dk === todayKey;
                const isPast = dk < todayKey;
                const hasNote = Boolean(sched.dayNotes[dk]);

                return (
                  <DayHeaderCell
                    key={ci}
                    ci={ci}
                    date={date}
                    isToday={isToday}
                    isPast={isPast}
                    showArchiveBadge={isArchiveWeek}
                    hasNote={hasNote}
                    onClick={() => onDayAnnotation(dk)}
                    onMenu={onDayMenu ? (rect) => onDayMenu(dk, rect) : undefined}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleSlots.map(slot => {
              const isLegacySlot = sched.legacySlotIds.includes(slot.id);
              const slotState: S.SlotVisualState = classifySlotVisualState({
                isLegacySlot,
                isArchiveWeek,
                groupsPerDay: sched.aDays.map(ci => ({
                  groups: cellGroups[scKey(ci, slot.id)] ?? [],
                  isPast: !dates[ci] || dateKey(dates[ci], timezone) < todayKey,
                })),
              });
              return (
                <tr key={slot.id} style={S.slotRow(slotState)}>
                  <td style={S.timeCell(slotState)}>
                    <div style={slotState === 'conflict' ? { ...S.slotStartTime, color: '#EA580C' } : S.slotStartTime}>{slot.s}</div>
                    <div style={S.slotEndTime}>{slot.e}</div>
                    {slotState === 'archive' && <div style={S.legacySlotLabel}>архив</div>}
                    {slotState === 'conflict' && <div style={{ ...S.legacySlotLabel, color: '#EA580C', fontWeight: 600 }}>вне сетки</div>}
                    {slotState === 'historical' && <div style={S.legacySlotLabel}>история</div>}
                  </td>

                  {sched.aDays.map(ci => {
                    const date = dates[ci];
                    const groups = cellGroups[scKey(ci, slot.id)] ?? [];
                    const bgColor = sched.cellColors[scKey(ci, slot.id)];
                    const cellConflict = groups.length > 1 ? detectCellConflict(groups, ci) : null;

                    const dk = dateKey(date, timezone);
                    const isToday = dk === todayKey;
                    const isPast = dk < todayKey;

                    const columnBg = dayCellBg(isToday, isPast, bgColor);

                    return (
                      <td key={ci} style={S.tableCell(columnBg)} onClick={() => { if (!isTeacher || groups.length > 0) onCellClick(ci, slot.id); }}>
                        {cellConflict && (
                          <div
                            title={cellConflict === 'teacher'
                              ? 'Конфликт учителя: один учитель в двух группах'
                              : 'Конфликт студентов: одна группа на двух уроках'}
                            style={S.cellConflict(false)}
                          >⚠</div>
                        )}

                        {groups.length === 0 ? (
                          <EmptyCell isPast={isPast} isTeacher={isTeacher} />
                        ) : (
                          groups.map(g => (
                            <RoomBlock
                              key={g.id}
                              group={g}
                              ci={ci}
                              sid={slot.id}
                              date={dates[ci]}
                              sched={sched}
                              timezone={timezone}
                              isPast={isPast}
                              isToday={isToday}
                              onCellClick={() => onCellClick(ci, slot.id, undefined, g.id)}
                            />
                          ))
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
        </div>
      </div>
      )}
    </>
  );
}

// Skip re-renders from parent Schedule state churn (e.g. attendance clicks in the
// popup): compare only the sched fields this grid (and its RoomBlock chips) renders.
// sched.G is NOT read here — per-student ta/book changes never repaint the grid.
export default memo(WeekGrid, schedViewPropsEqual(['getGroupsInCell', 'slots', 'aDays', 'legacySlotIds', 'dayNotes', 'cellColors', 'groupColors', 'weekSessions', 'sessionStatuses', 'cancelledSessions']));
