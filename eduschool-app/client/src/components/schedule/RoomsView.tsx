import React, { memo, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UseSchedule } from '../../hooks/useSchedule';
import { weekDates, weekKey, dateKey } from '../../hooks/useSchedule';
import type { SchedGroup, TimeSlot } from './scheduleTypes';
import { doesGroupBelongToTeacherOnDay, schedViewPropsEqual } from './scheduleTypes';
import {
  dayCellBg,
  stickyFirstColHeader,
  stickyFirstColCell,
} from './scheduleTheme';
import { useContainerHeight } from '../../hooks/useContainerHeight';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { useZoomCtrlScroll } from '../../hooks/useZoomCtrlScroll';
import { useIsMobile } from '../../hooks/useIsMobile';
import DayHeaderCell from './DayHeaderCell';
import MobileDayBar from './MobileDayBar';
import MobileSlotSection from './MobileSlotSection';
import RoomBlock from './RoomBlock';
import * as S from './weekGridStyles';
import { lessonWord, classifySlotVisualState } from '../../utils/scheduleUtils';
import { scKey } from '../../hooks/schedule/scheduleKeys';
import { readCollapsedMap } from '../../hooks/schedule/scheduleStorage';
import { useMobileDayNav } from '../../hooks/schedule/useMobileDayNav';

const roomSectionHeader: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: 'var(--sch-orange)',
  background: 'var(--sch-orange-light)',
  borderTop: '2px solid var(--sch-orange)',
  position: 'sticky',
  left: 0,
};

const COLLAPSED_ROOMS_KEY = 'sch_collapsed_rooms';

// Fixed height of an empty slot's box, sized to match a single lesson card.
// ponytail: eyeballed to the card height; nudge this one number if it's off.
const CELL_MIN_HEIGHT = 96;

type Cabinet = { id: number; name: string; capacity?: number };

function readCollapsedRooms(storageKey: string): Record<string, boolean> {
  return readCollapsedMap(storageKey, COLLAPSED_ROOMS_KEY);
}

interface Props {
  sched: UseSchedule;
  viewWk: string;
  teacherFilter: string;
  groupFilter?: string;
  cabinets?: Cabinet[];
  schoolId?: number;
  hasActiveFilters?: boolean;
  onResetFilters?: () => void;
  zoom: number;
  timezone?: string;
  onCellClick: (ci: number, sid: number, room?: string, groupId?: number) => void;
  onZoomChange?: (val: number) => void;
  onDayAnnotation?: (dk: string) => void;
  onDayMenu?: (dk: string, rect: DOMRect) => void;
  /** Toolbar node (desktop) to portal the expand / empty-slot controls into. */
  toolbarSlot?: HTMLElement | null;
  isTeacher?: boolean;
  /** Mobile-only: the toolbar is hidden there, so the day bar carries these. */
  hasControlAlerts?: boolean;
  onOpenSettings?: () => void;
  onOpenControl?: () => void;
}


interface MobileRoomsProps {
  allRooms: string[];
  roomDayData: Record<string, Record<number, Array<{ g: SchedGroup; sl: TimeSlot }>>>;
  sched: UseSchedule;
  viewWk: string;
  dates: Array<Date | undefined>;
  todayKey: string;
  timezone: string;
  isArchiveWeek: boolean;
  isTeacher?: boolean;
  hasActiveFilters?: boolean;
  hasControlAlerts?: boolean;
  onOpenSettings?: () => void;
  onOpenControl?: () => void;
  onCellClick: (ci: number, sid: number, room?: string, groupId?: number) => void;
}

function MobileRoomsView({ allRooms, roomDayData, sched, viewWk, dates, todayKey, timezone, isArchiveWeek, isTeacher = false, hasActiveFilters, hasControlAlerts, onOpenSettings, onOpenControl, onCellClick }: MobileRoomsProps) {
  const [selectedRoom, setSelectedRoom] = useState<string | null>(() => allRooms[0] ?? null);

  const { mobileDay, mobileDayIndex, setMobileDay } = useMobileDayNav(sched.aDays, dates, timezone, todayKey, viewWk);
  // The shared day bar speaks weekday indexes; useMobileDayNav stores date-keys.
  const selectDay = (ci: number) => { const d = dates[ci]; if (d) setMobileDay(dateKey(d, timezone)); };

  // The slot list owns its scroll (like WeekGrid's), so MobileSlotSection's sticky
  // time band anchors to the list top instead of the page — no offset to keep in
  // sync with MobileDayBar's height. 80px leaves room for the fixed bottom nav.
  const [listRef, listH] = useContainerHeight(80);
  useScrollRestoration(listRef, 'schedule.scroll.rooms.mobile', sched.slots.length);

  // Guard: sync selectedRoom if allRooms changes and current selection is gone
  useEffect(() => {
    if (!selectedRoom || !allRooms.includes(selectedRoom)) {
      setSelectedRoom(allRooms[0] ?? null);
    }
  }, [allRooms, selectedRoom]);

  const mobileDateIsToday = mobileDay === todayKey;
  const mobileDateIsPast = mobileDay < todayKey;

  if (selectedRoom === null) {
    return (
      <div className="flex items-center justify-center py-16 text-textSecondary text-sm">
        {isTeacher ? 'На этой неделе занятий нет.' : 'Нет кабинетов'}
      </div>
    );
  }

  const daySlots = roomDayData[selectedRoom]?.[mobileDayIndex] ?? [];
  const slotGroupMap = new Map<number, Array<{ g: SchedGroup; sl: TimeSlot }>>();
  for (const entry of daySlots) {
    const arr = slotGroupMap.get(entry.sl.id) ?? [];
    arr.push(entry);
    slotGroupMap.set(entry.sl.id, arr);
  }

  return (
    <div>
      <MobileDayBar
        aDays={sched.aDays}
        dates={dates}
        timezone={timezone}
        todayKey={todayKey}
        selectedDay={mobileDayIndex}
        onSelectDay={selectDay}
        hasActiveFilters={hasActiveFilters}
        hasControlAlerts={hasControlAlerts}
        onOpenSettings={onOpenSettings}
        onOpenControl={onOpenControl}
        selector={{
          value: selectedRoom,
          options: allRooms.map(room => ({ value: room, label: room })),
          onChange: setSelectedRoom,
        }}
      />

      {/* Slot list */}
      <div ref={listRef} className="px-4 pb-4 overflow-y-auto space-y-3" style={{ maxHeight: listH }}>
        {(isTeacher ? sched.slots.filter(sl => slotGroupMap.has(sl.id)) : sched.slots).map(sl => {
          const entries = slotGroupMap.get(sl.id);
          const slotGroups = entries ?? [];
          const isLegacy = sched.legacySlotIds.includes(sl.id);
          const mobileSlotState = classifySlotVisualState({
            isLegacySlot: isLegacy,
            isArchiveWeek,
            groupsPerDay: [{ groups: slotGroups.map(e => e.g), isPast: mobileDay < todayKey }],
          });
          const isConflict = mobileSlotState === 'conflict';
          const isHistorical = mobileSlotState === 'historical';
          const canAdd = !mobileDateIsPast && !isTeacher;
          return (
            <MobileSlotSection
              key={sl.id}
              start={sl.s}
              end={sl.e}
              count={slotGroups.length}
              state={isConflict ? 'conflict' : isHistorical ? 'historical' : 'normal'}
              onAdd={canAdd ? () => onCellClick(mobileDayIndex, sl.id, selectedRoom) : undefined}
            >
              {!entries || entries.length === 0 ? (
                <div
                  onClick={() => { if (canAdd) onCellClick(mobileDayIndex, sl.id, selectedRoom); }}
                  className={`h-11 rounded-xl border border-dashed flex items-center justify-center text-sm transition-colors ${
                    canAdd
                      ? 'border-border/50 text-textSecondary/40 hover:border-primary/40 hover:text-primary/50'
                      : 'border-border/20 text-textSecondary/20'
                  }`}
                >
                  {canAdd && '+ Добавить'}
                </div>
              ) : entries.map(({ g }) => (
                <RoomBlock
                  key={g.id}
                  group={g}
                  ci={mobileDayIndex}
                  sid={sl.id}
                  date={dates[mobileDayIndex]}
                  sched={sched}
                  timezone={timezone}
                  isPast={mobileDateIsPast}
                  isToday={mobileDateIsToday}
                  layout="mobile"
                  onCellClick={() => onCellClick(mobileDayIndex, sl.id, selectedRoom, g.id)}
                />
              ))}
            </MobileSlotSection>
          );
        })}
      </div>
    </div>
  );
}


function RoomsView({ sched, viewWk, teacherFilter, groupFilter, cabinets = [], schoolId, hasActiveFilters = false, onResetFilters, zoom, timezone = 'Asia/Bishkek', onCellClick, onZoomChange, onDayAnnotation, onDayMenu, toolbarSlot, isTeacher = false, hasControlAlerts = false, onOpenSettings, onOpenControl }: Props) {
  const isMobile = useIsMobile();

  const [containerRef, containerH] = useContainerHeight(0);
  const zoomWrapRef = useZoomCtrlScroll(containerRef, zoom, onZoomChange);
  useScrollRestoration(containerRef, 'schedule.scroll.rooms.desktop', sched.slots.length);

  // TEMP DEBUG — remove after diagnosing the tab-switch scroll reset.
  useEffect(() => {
    console.log('[scroll-debug] RoomsView MOUNTED');
    return () => console.log('[scroll-debug] RoomsView UNMOUNTED');
  }, []);
  useEffect(() => {
    const onVis = () => {
      console.log('[scroll-debug] visibility=', document.visibilityState,
        'containerScrollTop=', containerRef.current?.scrollTop,
        'containerScrollHeight=', containerRef.current?.scrollHeight,
        'stored=', sessionStorage.getItem('schedule.scroll.rooms.desktop'));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ── Stable derived data — recomputed only when schedule data changes, NOT on zoom ──
  const dates = useMemo(() => weekDates(viewWk, timezone), [viewWk, timezone]);
  const todayKey = useMemo(() => dateKey(new Date(), timezone), [timezone]);
  const currentWeekKey = useMemo(() => weekKey(new Date(), timezone), [timezone]);
  const isArchiveWeek = viewWk < currentWeekKey;
  const groupFilterId = groupFilter ? Number(groupFilter) : null;
  const collapsedStorageKey = schoolId ? `${COLLAPSED_ROOMS_KEY}_${schoolId}` : COLLAPSED_ROOMS_KEY;

  const groupMatchesFiltersForDay = useMemo(() => {
    return (g: SchedGroup, ci: number) => {
      if (groupFilterId != null && g.studentGroupId !== groupFilterId) return false;
      if (teacherFilter && !doesGroupBelongToTeacherOnDay(g, teacherFilter, ci)) return false;
      return true;
    };
  }, [teacherFilter, groupFilterId]);

  const cellGroupsByKey = useMemo(() => {
    const out: Record<string, SchedGroup[]> = {};
    for (const sl of sched.slots) {
      for (const ci of sched.aDays) {
        out[scKey(ci, sl.id)] = sched.getGroupsInCell(ci, sl.id, dates[ci]);
      }
    }
    return out;
  }, [sched.slots, sched.aDays, sched.getGroupsInCell, dates]);

  const allRooms = useMemo(() => {
    const roomsWithLessons = new Set(
      Object.values(sched.G)
        .filter(g => g.n && sched.aDays.some(ci => groupMatchesFiltersForDay(g, ci)))
        .map(g => g.n!)
    );

    const masterRooms = cabinets.length > 0
      ? cabinets.map(cab => cab.name).filter(Boolean)
      : Object.values(sched.G).map(g => g.n).filter(Boolean);

    const rooms = Array.from(new Set(masterRooms))
      .sort((a, b) => {
        const diff = (roomsWithLessons.has(a!) ? 0 : 1) - (roomsWithLessons.has(b!) ? 0 : 1);
        return diff !== 0 ? diff : a!.localeCompare(b!);
      }) as string[];

    // Teachers only ever see their own groups in sched.G (server-scoped to them), so
    // a cabinet with no lessons here is simply one they don't teach in this week —
    // hide it instead of listing every cabinet in the school as a dead accordion.
    return isTeacher ? rooms.filter(r => roomsWithLessons.has(r)) : rooms;
  }, [cabinets, sched.G, sched.aDays, groupMatchesFiltersForDay, isTeacher]);

  // Pre-index for mobile: room → ci → [{g, sl}]
  const roomDayData = useMemo(() => {
    const map: Record<string, Record<number, Array<{ g: SchedGroup; sl: TimeSlot }>>> = {};
    for (const room of allRooms) {
      map[room] = {};
      for (const ci of sched.aDays) {
        map[room][ci] = sched.slots.flatMap(sl =>
          (cellGroupsByKey[scKey(ci, sl.id)] ?? [])
            .filter(g => g.n === room && groupMatchesFiltersForDay(g, ci))
            .map(g => ({ g, sl }))
        );
      }
    }
    return map;
  }, [allRooms, sched.aDays, sched.slots, cellGroupsByKey, groupMatchesFiltersForDay]);

  // Pre-index for desktop pivot (Room → Time → Days): room → slotId → ci → SchedGroup[]
  const roomSlotDayData = useMemo(() => {
    const out: Record<string, Record<number, Record<number, SchedGroup[]>>> = {};
    for (const room of allRooms) {
      out[room] = {};
      for (const sl of sched.slots) {
        for (const ci of sched.aDays) {
          const groups = (cellGroupsByKey[scKey(ci, sl.id)] ?? [])
            .filter(g => g.n === room && groupMatchesFiltersForDay(g, ci));
          if (groups.length > 0) {
            if (!out[room][sl.id]) out[room][sl.id] = {};
            out[room][sl.id][ci] = groups;
          }
        }
      }
    }
    return out;
  }, [allRooms, sched.aDays, sched.slots, cellGroupsByKey, groupMatchesFiltersForDay]);

  const [collapsedRooms, setCollapsedRooms] = useState<Record<string, boolean>>(() => readCollapsedRooms(collapsedStorageKey));

  useEffect(() => {
    setCollapsedRooms(readCollapsedRooms(collapsedStorageKey));
  }, [collapsedStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(collapsedStorageKey, JSON.stringify(collapsedRooms));
    } catch { /* ignore storage errors */ }
  }, [collapsedRooms, collapsedStorageKey]);

  const roomLessonCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const room of allRooms) {
      let count = 0;
      for (const sl of sched.slots) {
        for (const ci of sched.aDays) {
          count += roomSlotDayData[room]?.[sl.id]?.[ci]?.length ?? 0;
        }
      }
      counts[room] = count;
    }
    return counts;
  }, [allRooms, sched.slots, sched.aDays, roomSlotDayData]);

  if (isMobile) {
    return (
      <MobileRoomsView
        allRooms={allRooms}
        roomDayData={roomDayData}
        sched={sched}
        viewWk={viewWk}
        dates={dates}
        todayKey={todayKey}
        timezone={timezone}
        isArchiveWeek={isArchiveWeek}
        isTeacher={isTeacher}
        hasActiveFilters={hasActiveFilters}
        hasControlAlerts={hasControlAlerts}
        onOpenSettings={onOpenSettings}
        onOpenControl={onOpenControl}
        onCellClick={onCellClick}
      />
    );
  }

  // Always show all rooms and all slots (planning mode) so empty slots are addable.
  const activeRooms = allRooms;
  const noFilteredLessons = hasActiveFilters && activeRooms.length > 0 && Object.values(roomLessonCounts).every(count => count === 0);

  function toggleRoom(room: string) {
    setCollapsedRooms(prev => ({ ...prev, [room]: !prev[room] }));
  }

  function expandAllRooms() {
    setCollapsedRooms(prev => {
      const next = { ...prev };
      for (const room of activeRooms) delete next[room];
      return next;
    });
  }

  function collapseAllRooms() {
    setCollapsedRooms(prev => {
      const next = { ...prev };
      for (const room of activeRooms) next[room] = true;
      return next;
    });
  }

  // Single toggle: collapses everything when anything is open, expands when all closed.
  const allCollapsed = activeRooms.length > 0 && activeRooms.every(room => collapsedRooms[room]);

  // Match the toolbar button design (Schedule.tsx `inactiveBtn`).
  const toolbarBtn = 'px-3 py-1.5 text-sm font-medium border border-border rounded bg-white text-textPrimary hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-colors cursor-pointer select-none outline-none focus:outline-none';

  const controls = (
    <button onClick={() => (allCollapsed ? expandAllRooms() : collapseAllRooms())} className={toolbarBtn}>
      {allCollapsed ? 'Развернуть всё' : 'Свернуть всё'}
    </button>
  );

  return (
    <div
      ref={containerRef}
      className="overflow-y-auto overflow-x-hidden custom-scrollbar"
      style={{ height: containerH }}
    >
      <div ref={zoomWrapRef}>
        {/* Controls portal into the shared toolbar; fall back to an inline row if absent. */}
        {toolbarSlot
          ? createPortal(controls, toolbarSlot)
          : <div className="flex items-center gap-1.5 mb-1.5">{controls}</div>}

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

        {/* ── Pivot table: Room → Time → Days ─────────────────────────────── */}
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 480, tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ ...stickyFirstColHeader, width: 90 }}>Время</th>
              {sched.aDays.map(ci => {
                const date = dates[ci];
                const dk = dateKey(date, timezone);
                return (
                  <DayHeaderCell
                    key={ci}
                    ci={ci}
                    date={date}
                    isToday={dk === todayKey}
                    isPast={dk < todayKey}
                    showArchiveBadge={isArchiveWeek}
                    hasNote={Boolean(sched.dayNotes[dk])}
                    onClick={onDayAnnotation ? () => onDayAnnotation(dk) : undefined}
                    onMenu={onDayMenu ? (rect) => onDayMenu(dk, rect) : undefined}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {activeRooms.map(room => {
              const relevantSlots = isTeacher
                ? sched.slots.filter(sl => sched.aDays.some(ci => (roomSlotDayData[room]?.[sl.id]?.[ci]?.length ?? 0) > 0))
                : sched.slots;
              const isCollapsed = Boolean(collapsedRooms[room]);
              const lessonCount = roomLessonCounts[room] ?? 0;

              return (
                <React.Fragment key={room}>
                  {/* Room section header */}
                  <tr>
                    <td colSpan={1 + sched.aDays.length} style={roomSectionHeader}>
                      <button
                        onClick={(e) => (e.altKey ? (allCollapsed ? expandAllRooms() : collapseAllRooms()) : toggleRoom(room))}
                        title="Alt+клик — свернуть/развернуть все кабинеты"
                        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 0, background: 'transparent', color: 'inherit', font: 'inherit', letterSpacing: 'inherit', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                      >
                        <span>{isCollapsed ? '▶' : '▼'}</span>
                        <span>{room} · {lessonCount} {lessonWord(lessonCount)}</span>
                      </button>
                    </td>
                  </tr>

                  {/* One row per time slot */}
                  {!isCollapsed && relevantSlots.map(sl => {
                    const isLegacySlot = sched.legacySlotIds.includes(sl.id);
                    const slotState: S.SlotVisualState = classifySlotVisualState({
                      isLegacySlot,
                      isArchiveWeek,
                      groupsPerDay: sched.aDays.map(ci => ({
                        groups: roomSlotDayData[room]?.[sl.id]?.[ci] ?? [],
                        isPast: !dates[ci] || dateKey(dates[ci]!, timezone) < todayKey,
                      })),
                    });
                    return (
                      <tr key={`${room}-${sl.id}`} style={S.slotRow(slotState)}>
                        <td style={{
                          ...stickyFirstColCell,
                          fontSize: 11,
                          color: slotState === 'conflict' ? '#EA580C' : (slotState === 'historical' || slotState === 'archive') ? '#AAA' : 'var(--sch-mid)',
                          fontWeight: 600,
                        }}>
                          {sl.s}–{sl.e}
                          {slotState === 'conflict' && <div style={{ ...S.legacySlotLabel, color: '#EA580C', fontWeight: 600 }}>вне сетки</div>}
                          {slotState === 'historical' && <div style={S.legacySlotLabel}>история</div>}
                          {slotState === 'archive' && <div style={S.legacySlotLabel}>архив</div>}
                        </td>

                        {sched.aDays.map(ci => {
                          const date = dates[ci];
                          const dk = dateKey(date, timezone);
                          const isToday = dk === todayKey;
                          const isPast = dk < todayKey;
                          const groups = roomSlotDayData[room]?.[sl.id]?.[ci] ?? [];
                          const bg = dayCellBg(isToday, isPast);

                          return (
                            <td
                              key={ci}
                              style={{
                                padding: 4,
                                verticalAlign: 'top',
                                background: bg,
                                border: '1px solid var(--color-border)',
                              }}
                            >
                              {groups.length === 0 ? (
                                !isPast && !isTeacher ? (
                                  <div
                                    onClick={() => onCellClick(ci, sl.id, room)}
                                    style={{
                                      // Fixed height + marginBottom mirror a single lesson card's
                                      // box so an empty slot is exactly the same size as a card.
                                      height: CELL_MIN_HEIGHT,
                                      marginBottom: 4,
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      cursor: 'pointer',
                                      borderRadius: 8,
                                      fontSize: 16,
                                      color: 'var(--sch-border)',
                                    }}
                                    className="sch-empty-slot"
                                  >
                                    +
                                  </div>
                                ) : (
                                  <div style={{ height: CELL_MIN_HEIGHT, marginBottom: 4 }} />
                                )
                              ) : (
                                groups.map(g => (
                                  <div key={g.id} style={{ marginBottom: 4 }}>
                                    <RoomBlock
                                      group={g}
                                      ci={ci}
                                      sid={sl.id}
                                      date={dates[ci]}
                                      sched={sched}
                                      timezone={timezone}
                                      isPast={isPast}
                                      isToday={isToday}
                                      slotTime={`${sl.s}–${sl.e}`}
                                      onCellClick={() => onCellClick(ci, sl.id, room, g.id)}
                                    />
                                  </div>
                                ))
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}

            {activeRooms.length === 0 && (
              <tr>
                <td
                  colSpan={sched.aDays.length + 1}
                  style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}
                >
                  {hasActiveFilters ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                      <span>Нет занятий по выбранным фильтрам</span>
                      <button
                        onClick={onResetFilters}
                        style={{ border: 0, background: 'transparent', color: 'var(--sch-primary)', cursor: 'pointer', fontWeight: 700 }}
                      >
                        Сбросить фильтры
                      </button>
                    </div>
                  ) : isTeacher ? (
                    <span>На этой неделе занятий нет.</span>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <span>Нет занятий по кабинетам</span>
                      <span style={{ fontSize: 12 }}>Включите показ пустых слотов, чтобы планировать расписание</span>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// structureTick stands in for sched.G: G changes on every ta/book toggle, none of
// which this view renders. See schedViewPropsEqual docs.
export default memo(RoomsView, schedViewPropsEqual(['getGroupsInCell', 'slots', 'aDays', 'legacySlotIds', 'dayNotes', 'structureTick', 'groupColors', 'weekSessions', 'sessionStatuses', 'cancelledSessions']));
