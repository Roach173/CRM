import { memo, useEffect, useMemo, useState } from 'react';
import type { UseSchedule } from '../../hooks/useSchedule';
import { weekDates, weekKey, dateKey } from '../../hooks/useSchedule';
import type { SchedGroup } from './scheduleTypes';
import { schedViewPropsEqual } from './scheduleTypes';
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
import { classifySlotVisualState } from '../../utils/scheduleUtils';
import { useMobileDayNav } from '../../hooks/schedule/useMobileDayNav';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Group { id: number; name: string; level: string; }

interface Props {
  sched: UseSchedule;
  viewWk: string;
  zoom: number;
  timezone?: string;
  onCellClick: (ci: number, sid: number, room?: string, groupId?: number) => void;
  onZoomChange?: (val: number) => void;
  onDayAnnotation?: (dk: string) => void;
  onDayMenu?: (dk: string, rect: DOMRect) => void;
  /** Mobile-only: the toolbar is hidden there, so the day bar carries these. */
  hasActiveFilters?: boolean;
  hasControlAlerts?: boolean;
  onOpenSettings?: () => void;
  onOpenControl?: () => void;
}

// ─── Group section header style ───────────────────────────────────────────────

const groupSectionHeader: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: 'var(--sch-blue)',
  background: 'var(--sch-blue-light)',
  borderTop: '2px solid var(--sch-blue)',
  position: 'sticky',
  left: 0,
};

// ─── Mobile ───────────────────────────────────────────────────────────────────

interface MobileProps {
  allGroups: Group[];
  groupSlotDayData: Record<number, Record<number, Record<number, SchedGroup[]>>>;
  sched: UseSchedule;
  viewWk: string;
  dates: Array<Date | undefined>;
  todayKey: string;
  timezone: string;
  isArchiveWeek: boolean;
  hasActiveFilters?: boolean;
  hasControlAlerts?: boolean;
  onOpenSettings?: () => void;
  onOpenControl?: () => void;
  onCellClick: (ci: number, sid: number, room?: string, groupId?: number) => void;
}

function MobileGroupView({
  allGroups, groupSlotDayData, sched, viewWk, dates, todayKey, timezone, isArchiveWeek,
  hasActiveFilters, hasControlAlerts, onOpenSettings, onOpenControl, onCellClick,
}: MobileProps) {
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(allGroups[0]?.id ?? null);

  const { mobileDay, mobileDayIndex, setMobileDay } = useMobileDayNav(sched.aDays, dates, timezone, todayKey, viewWk);
  // The shared day bar speaks weekday indexes; useMobileDayNav stores date-keys.
  const selectDay = (ci: number) => { const d = dates[ci]; if (d) setMobileDay(dateKey(d, timezone)); };

  // Own scroll container so MobileSlotSection's sticky time band anchors to the
  // list top rather than the page (where it would slide under MobileDayBar).
  const [listRef, listH] = useContainerHeight(80);
  useScrollRestoration(listRef, 'schedule.scroll.group.mobile', sched.slots.length);

  useEffect(() => {
    if (!selectedGroupId || !allGroups.find(g => g.id === selectedGroupId)) {
      setSelectedGroupId(allGroups[0]?.id ?? null);
    }
  }, [allGroups, selectedGroupId]);

  const mobileDateIsToday = mobileDay === todayKey;
  const mobileDateIsPast = mobileDay < todayKey;

  const slotEntries = selectedGroupId != null
    ? sched.slots.flatMap(sl => {
        const groups = groupSlotDayData[selectedGroupId]?.[sl.id]?.[mobileDayIndex] ?? [];
        return groups.map(g => ({ sl, g }));
      })
    : [];

  return (
    <div className="flex flex-col gap-2">
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
          value: selectedGroupId ?? '',
          options: allGroups.map(g => ({ value: g.id, label: g.level })),
          onChange: v => setSelectedGroupId(Number(v)),
        }}
      />

      <div ref={listRef} className="px-2 flex flex-col gap-2 pb-4 overflow-y-auto" style={{ maxHeight: listH }}>
        {slotEntries.length === 0 ? (
          <div className="text-center text-textSecondary text-sm py-6">
            {selectedGroupId == null ? 'Выберите группу' : 'Нет занятий'}
          </div>
        ) : (
          slotEntries.map(({ sl, g }) => {
            const isLegacy = sched.legacySlotIds.includes(sl.id);
            const mobileGroupState = classifySlotVisualState({
              isLegacySlot: isLegacy,
              isArchiveWeek,
              groupsPerDay: [{ groups: [g], isPast: mobileDay < todayKey }],
            });
            const isConflict = mobileGroupState === 'conflict';
            const isHistorical = mobileGroupState === 'historical';
            return (
              <MobileSlotSection
                key={`${g.id}-${sl.id}`}
                start={sl.s}
                end={sl.e}
                state={isConflict ? 'conflict' : isHistorical ? 'historical' : 'normal'}
              >
                <RoomBlock
                  group={g}
                  ci={mobileDayIndex}
                  sid={sl.id}
                  date={dates[mobileDayIndex]}
                  sched={sched}
                  timezone={timezone}
                  isPast={mobileDateIsPast}
                  isToday={mobileDateIsToday}
                  layout="mobile"
                  onCellClick={() => onCellClick(mobileDayIndex, sl.id, undefined, g.id)}
                />
              </MobileSlotSection>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Desktop — pivot: Group → Time → Days ─────────────────────────────────────

function GroupView({
  sched, viewWk, zoom, timezone = 'Asia/Bishkek', onCellClick, onZoomChange, onDayAnnotation, onDayMenu,
  hasActiveFilters = false, hasControlAlerts = false, onOpenSettings, onOpenControl,
}: Props) {
  const isMobile = useIsMobile();
  const [containerRef, containerH] = useContainerHeight(0);
  const zoomWrapRef = useZoomCtrlScroll(containerRef, zoom, onZoomChange);
  useScrollRestoration(containerRef, 'schedule.scroll.group.desktop', sched.slots.length);

  const dates = useMemo(() => weekDates(viewWk, timezone), [viewWk, timezone]);
  const todayKey = useMemo(() => dateKey(new Date(), timezone), [timezone]);
  const currentWeekKey = useMemo(() => weekKey(new Date(), timezone), [timezone]);
  const isArchiveWeek = viewWk < currentWeekKey;

  // Unique cohort groups — dedup by studentGroupId (not by name).
  // Blocks without studentGroupId (legacy/standalone) are excluded: they have
  // no cohort and do not belong in the group-centric pivot.
  const allGroups = useMemo((): Group[] => {
    const map = new Map<number, Group>();
    for (const g of Object.values(sched.G)) {
      if (g.studentGroupId != null && !map.has(g.studentGroupId)) {
        map.set(g.studentGroupId, {
          id: g.studentGroupId,
          name: g.lv,
          level: g.lv,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const lvCmp = a.level.localeCompare(b.level, 'ru');
      return lvCmp !== 0 ? lvCmp : a.name.localeCompare(b.name, 'ru');
    });
  }, [sched.G]);

  // Pre-index: groupId → slotId → dayIndex → SchedGroup[].
  // Exclusively via getGroupsInCell — no own state, no API calls.
  const groupSlotDayData = useMemo(() => {
    const out: Record<number, Record<number, Record<number, SchedGroup[]>>> = {};
    for (const group of allGroups) {
      out[group.id] = {};
      for (const sl of sched.slots) {
        for (const ci of sched.aDays) {
          const groups = sched.getGroupsInCell(ci, sl.id, dates[ci])
            .filter(g => g.studentGroupId === group.id);
          if (groups.length > 0) {
            if (!out[group.id][sl.id]) out[group.id][sl.id] = {};
            out[group.id][sl.id][ci] = groups;
          }
        }
      }
    }
    return out;
  }, [allGroups, sched.slots, sched.aDays, sched.getGroupsInCell, dates]);

  if (isMobile) {
    return (
      <MobileGroupView
        allGroups={allGroups}
        groupSlotDayData={groupSlotDayData}
        sched={sched}
        viewWk={viewWk}
        dates={dates}
        todayKey={todayKey}
        timezone={timezone}
        isArchiveWeek={isArchiveWeek}
        hasActiveFilters={hasActiveFilters}
        hasControlAlerts={hasControlAlerts}
        onOpenSettings={onOpenSettings}
        onOpenControl={onOpenControl}
        onCellClick={onCellClick}
      />
    );
  }

  // Only show groups that have at least one block in this week
  const activeGroups = allGroups.filter(grp =>
    sched.slots.some(sl =>
      sched.aDays.some(ci => (groupSlotDayData[grp.id]?.[sl.id]?.[ci]?.length ?? 0) > 0)
    )
  );

  return (
    <div
      ref={containerRef}
      className="overflow-auto custom-scrollbar"
      style={{ height: containerH }}
    >
      <div ref={zoomWrapRef}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 600 }}>
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
            {activeGroups.map(group => {
              const relevantSlots = sched.slots.filter(sl =>
                sched.aDays.some(ci => (groupSlotDayData[group.id]?.[sl.id]?.[ci]?.length ?? 0) > 0)
              );

              return (
                <>
                  {/* ── Group section header ────────────────────────────── */}
                  <tr key={`h-${group.id}`}>
                    <td
                      colSpan={1 + sched.aDays.length}
                      style={groupSectionHeader}
                    >
                      {group.name}
                      <span style={{ fontWeight: 400, marginLeft: 8, opacity: 0.75 }}>
                        {group.level}
                      </span>
                    </td>
                  </tr>

                  {/* ── One row per time slot ───────────────────────────── */}
                  {relevantSlots.map(sl => {
                    const isLegacySlot = sched.legacySlotIds.includes(sl.id);
                    const slotState: S.SlotVisualState = classifySlotVisualState({
                      isLegacySlot,
                      isArchiveWeek,
                      groupsPerDay: sched.aDays.map(ci => ({
                        groups: groupSlotDayData[group.id]?.[sl.id]?.[ci] ?? [],
                        isPast: !dates[ci] || dateKey(dates[ci]!, timezone) < todayKey,
                      })),
                    });
                    return (
                      <tr key={`${group.id}-${sl.id}`} style={S.slotRow(slotState)}>
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
                          const groups = groupSlotDayData[group.id]?.[sl.id]?.[ci] ?? [];
                          const bg = dayCellBg(isToday, isPast);

                          return (
                            <td
                              key={ci}
                              style={{
                                padding: 4,
                                verticalAlign: 'top',
                                background: bg,
                                border: '1px solid var(--color-border)',
                                minWidth: 110,
                              }}
                            >
                              {groups.length === 0 ? (
                                <div style={{ minHeight: 28 }} />
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
                                      onCellClick={() => onCellClick(ci, sl.id, undefined, g.id)}
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
                </>
              );
            })}

            {activeGroups.length === 0 && (
              <tr>
                <td
                  colSpan={1 + sched.aDays.length}
                  style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}
                >
                  Нет групп в расписании на эту неделю
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
export default memo(GroupView, schedViewPropsEqual(['getGroupsInCell', 'slots', 'aDays', 'legacySlotIds', 'dayNotes', 'structureTick', 'groupColors', 'weekSessions', 'sessionStatuses', 'cancelledSessions']));
