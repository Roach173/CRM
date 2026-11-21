import React, { memo, useEffect, useMemo, useState } from 'react';
import type { UseSchedule } from '../../hooks/useSchedule';
import { weekDates, weekKey, dateKey } from '../../hooks/useSchedule';
import type { SchedGroup } from './scheduleTypes';
import { lessonBlockIdForDay, schedViewPropsEqual } from './scheduleTypes';
import { scKey, sessionKey } from '../../hooks/schedule/scheduleKeys';
import { readCollapsedMap } from '../../hooks/schedule/scheduleStorage';
import { useMobileDayNav } from '../../hooks/schedule/useMobileDayNav';
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface Teacher { id: number; name: string; }

interface Props {
  sched: UseSchedule;
  viewWk: string;
  zoom: number;
  timezone?: string;
  groupFilter?: string;
  schoolId?: number;
  hasActiveFilters?: boolean;
  onResetFilters?: () => void;
  onCellClick: (ci: number, sid: number, room?: string, groupId?: number) => void;
  onZoomChange?: (val: number) => void;
  onDayAnnotation?: (dk: string) => void;
  onDayMenu?: (dk: string, rect: DOMRect) => void;
  /** Mobile-only: the toolbar is hidden there, so the day bar carries these. */
  hasControlAlerts?: boolean;
  onOpenSettings?: () => void;
  onOpenControl?: () => void;
}

// ─── Teacher section header style ─────────────────────────────────────────────

const teacherSectionHeader: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: 'var(--sch-primary)',
  background: 'var(--sch-primary-light)',
  borderTop: '2px solid var(--sch-primary)',
  position: 'sticky',
  left: 0,
};

const COLLAPSED_TEACHERS_KEY = 'sch_collapsed_teachers';

function readCollapsedTeachers(storageKey: string): Record<string, boolean> {
  return readCollapsedMap(storageKey, COLLAPSED_TEACHERS_KEY);
}

// Returns the User.id of the teacher who will actually conduct this session on this date.
// If a substitute is assigned (weekSessions.subTeacherId > 0), returns the substitute's id.
// Otherwise returns the block-level grammar or club teacher id based on the day type.
function getEffectiveTeacherId(
  g: SchedGroup, ci: number, dk: string,
  weekSessions: UseSchedule['weekSessions'],
): number | null {
  const blockId = lessonBlockIdForDay(g, ci);
  const session = weekSessions[sessionKey(blockId, dk)];
  if (session?.subTeacherId && session.subTeacherId > 0) return session.subTeacherId;
  const isClubDay = g.clubDays.includes(ci);
  return isClubDay ? (g.tkId ?? null) : (g.tgId ?? null);
}

// ─── Mobile ───────────────────────────────────────────────────────────────────

interface MobileProps {
  allTeachers: Teacher[];
  // teacherId → slotId → ci → groups
  teacherSlotDayData: Record<number, Record<number, Record<number, SchedGroup[]>>>;
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

function MobileTeacherView({
  allTeachers, teacherSlotDayData, sched, viewWk, dates, todayKey, timezone, isArchiveWeek,
  hasActiveFilters, hasControlAlerts, onOpenSettings, onOpenControl, onCellClick,
}: MobileProps) {
  const [selectedTeacherId, setSelectedTeacherId] = useState<number | null>(
    allTeachers[0]?.id ?? null
  );

  const { mobileDay, mobileDayIndex, setMobileDay } = useMobileDayNav(sched.aDays, dates, timezone, todayKey, viewWk);
  // The shared day bar speaks weekday indexes; useMobileDayNav stores date-keys.
  const selectDay = (ci: number) => { const d = dates[ci]; if (d) setMobileDay(dateKey(d, timezone)); };

  // Own scroll container so MobileSlotSection's sticky time band anchors to the
  // list top rather than the page (where it would slide under MobileDayBar).
  const [listRef, listH] = useContainerHeight(80);
  useScrollRestoration(listRef, 'schedule.scroll.teacher.mobile', sched.slots.length);

  useEffect(() => {
    if (!selectedTeacherId || !allTeachers.find(t => t.id === selectedTeacherId)) {
      setSelectedTeacherId(allTeachers[0]?.id ?? null);
    }
  }, [allTeachers, selectedTeacherId]);

  const mobileDateIsToday = mobileDay === todayKey;
  const mobileDateIsPast = mobileDay < todayKey;

  // For selected teacher + day: slots with groups, ordered by slot
  const slotEntries = selectedTeacherId != null
    ? sched.slots.flatMap(sl => {
        const groups = teacherSlotDayData[selectedTeacherId]?.[sl.id]?.[mobileDayIndex] ?? [];
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
          value: selectedTeacherId ?? '',
          options: allTeachers.map(t => ({ value: t.id, label: t.name })),
          onChange: v => setSelectedTeacherId(Number(v)),
        }}
      />

      <div ref={listRef} className="px-2 flex flex-col gap-2 pb-4 overflow-y-auto" style={{ maxHeight: listH }}>
        {slotEntries.length === 0 ? (
          <div className="text-center text-textSecondary text-sm py-6">
            {selectedTeacherId == null ? 'Выберите учителя' : 'Нет занятий'}
          </div>
        ) : (
          slotEntries.map(({ sl, g }) => {
            const blockId = lessonBlockIdForDay(g, mobileDayIndex);
            const session = sched.weekSessions[sessionKey(blockId, mobileDay)];
            const isSubstituting = selectedTeacherId != null && (session?.subTeacherId ?? 0) > 0 && session?.subTeacherId === selectedTeacherId;
            const originalTeacher = isSubstituting
              ? (g.clubDays.includes(mobileDayIndex) ? g.tk : g.tg) ?? ''
              : '';
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
                {isSubstituting && (
                  <div style={{ fontSize: 11, color: '#E65100', fontWeight: 700 }}>
                    ⇄ замена за {originalTeacher}
                  </div>
                )}
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

// ─── Desktop — pivot: Teacher → Time → Days ───────────────────────────────────

function TeacherView({
  sched, viewWk, zoom, timezone = 'Asia/Bishkek', groupFilter, schoolId, hasActiveFilters = false, onResetFilters, onCellClick, onZoomChange, onDayAnnotation, onDayMenu,
  hasControlAlerts = false, onOpenSettings, onOpenControl,
}: Props) {
  const isMobile = useIsMobile();
  const [containerRef, containerH] = useContainerHeight(0);
  const zoomWrapRef = useZoomCtrlScroll(containerRef, zoom, onZoomChange);
  useScrollRestoration(containerRef, 'schedule.scroll.teacher.desktop', sched.slots.length);
  const collapsedStorageKey = schoolId ? `${COLLAPSED_TEACHERS_KEY}_${schoolId}` : COLLAPSED_TEACHERS_KEY;
  const [collapsedTeachers, setCollapsedTeachers] = useState<Record<string, boolean>>(() => readCollapsedTeachers(collapsedStorageKey));

  useEffect(() => {
    setCollapsedTeachers(readCollapsedTeachers(collapsedStorageKey));
  }, [collapsedStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(collapsedStorageKey, JSON.stringify(collapsedTeachers));
    } catch { /* ignore storage errors */ }
  }, [collapsedTeachers, collapsedStorageKey]);

  const dates = useMemo(() => weekDates(viewWk, timezone), [viewWk, timezone]);
  const todayKey = useMemo(() => dateKey(new Date(), timezone), [timezone]);
  const currentWeekKey = useMemo(() => weekKey(new Date(), timezone), [timezone]);
  const isArchiveWeek = viewWk < currentWeekKey;
  const groupFilterId = groupFilter ? Number(groupFilter) : null;

  // Unique teachers dedup by ID (not name).
  // Includes substitute teachers from weekSessions so they appear in the pivot even
  // if they have no regular blocks of their own this week.
  const allTeachers = useMemo((): Teacher[] => {
    const map = new Map<number, string>();
    for (const g of Object.values(sched.G)) {
      if (groupFilterId != null && g.studentGroupId !== groupFilterId) continue;
      if (g.tgId && g.tg && g.tg !== '—') map.set(g.tgId, g.tg);
      if (g.tkId && g.tk && g.tk !== '—') map.set(g.tkId, g.tk);
    }
    // Substitute teachers active this week (subTeacherId > 0 only when isSubstitute was true)
    for (const session of Object.values(sched.weekSessions)) {
      if (session.subTeacherId > 0 && session.subTeacherName) {
        if (!map.has(session.subTeacherId)) map.set(session.subTeacherId, session.subTeacherName);
      }
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [sched.G, sched.weekSessions, groupFilterId]);

  const cellGroupsByKey = useMemo(() => {
    const out: Record<string, SchedGroup[]> = {};
    for (const sl of sched.slots) {
      for (const ci of sched.aDays) {
        out[scKey(ci, sl.id)] = sched.getGroupsInCell(ci, sl.id, dates[ci]);
      }
    }
    return out;
  }, [sched.slots, sched.aDays, sched.getGroupsInCell, dates]);

  // Pre-index: teacherId → slotId → dayIndex → SchedGroup[].
  // Uses effective teacher per session: substitute takes the lesson, original teacher loses it.
  const teacherSlotDayData = useMemo(() => {
    const out: Record<number, Record<number, Record<number, SchedGroup[]>>> = {};
    for (const teacher of allTeachers) {
      out[teacher.id] = {};
      for (const sl of sched.slots) {
        for (const ci of sched.aDays) {
          const date = dates[ci];
          const dk = date ? dateKey(date, timezone) : '';
          const groups = (cellGroupsByKey[scKey(ci, sl.id)] ?? [])
            .filter(g => getEffectiveTeacherId(g, ci, dk, sched.weekSessions) === teacher.id)
            .filter(g => groupFilterId == null || g.studentGroupId === groupFilterId);
          if (groups.length > 0) {
            if (!out[teacher.id][sl.id]) out[teacher.id][sl.id] = {};
            out[teacher.id][sl.id][ci] = groups;
          }
        }
      }
    }
    return out;
  }, [allTeachers, sched.slots, sched.aDays, cellGroupsByKey, groupFilterId, dates, timezone, sched.weekSessions]);

  const teacherLessonCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const teacher of allTeachers) {
      let count = 0;
      for (const sl of sched.slots) {
        for (const ci of sched.aDays) {
          count += teacherSlotDayData[teacher.id]?.[sl.id]?.[ci]?.length ?? 0;
        }
      }
      counts[teacher.id] = count;
    }
    return counts;
  }, [allTeachers, sched.slots, sched.aDays, teacherSlotDayData]);

  // Teachers with no groups in this week are hidden (pivot stays compact)
  const activeTeachers = allTeachers.filter(t =>
    sched.slots.some(sl =>
      sched.aDays.some(ci => (teacherSlotDayData[t.id]?.[sl.id]?.[ci]?.length ?? 0) > 0)
    )
  );

  if (isMobile) {
    return (
      <MobileTeacherView
        allTeachers={allTeachers}
        teacherSlotDayData={teacherSlotDayData}
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

  function toggleTeacher(teacherId: number) {
    const key = String(teacherId);
    setCollapsedTeachers(prev => ({ ...prev, [key]: !prev[key] }));
  }

  function expandAllTeachers() {
    setCollapsedTeachers(prev => {
      const next = { ...prev };
      for (const teacher of activeTeachers) delete next[String(teacher.id)];
      return next;
    });
  }

  function collapseAllTeachers() {
    setCollapsedTeachers(prev => {
      const next = { ...prev };
      for (const teacher of activeTeachers) next[String(teacher.id)] = true;
      return next;
    });
  }

  return (
    <div
      ref={containerRef}
      className="overflow-auto custom-scrollbar"
      style={{ height: containerH }}
    >
      <div ref={zoomWrapRef}>
        <div style={{ display: 'flex', justifyContent: 'flex-start', gap: 6, marginBottom: 6 }}>
          <button
            onClick={expandAllTeachers}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--sch-border)', background: 'var(--sch-bg)', color: 'var(--sch-mid)' }}
          >
            Развернуть всё
          </button>
          <button
            onClick={collapseAllTeachers}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--sch-border)', background: 'var(--sch-bg)', color: 'var(--sch-mid)' }}
          >
            Свернуть всё
          </button>
        </div>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 600 }}>
          <thead>
            <tr>
              {/* "Время" sticky header — first column */}
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
            {activeTeachers.map(teacher => {
              // Slots where this teacher has at least one group in any day this week
              const relevantSlots = sched.slots.filter(sl =>
                sched.aDays.some(ci => (teacherSlotDayData[teacher.id]?.[sl.id]?.[ci]?.length ?? 0) > 0)
              );
              const isCollapsed = Boolean(collapsedTeachers[String(teacher.id)]);
              const lessonCount = teacherLessonCounts[teacher.id] ?? 0;

              return (
                <React.Fragment key={teacher.id}>
                  {/* ── Teacher section header ──────────────────────────── */}
                  <tr key={`h-${teacher.id}`}>
                    <td
                      colSpan={1 + sched.aDays.length}
                      style={teacherSectionHeader}
                    >
                      <button
                        onClick={() => toggleTeacher(teacher.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 0, background: 'transparent', color: 'inherit', font: 'inherit', letterSpacing: 'inherit', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                      >
                        <span>{isCollapsed ? '▶' : '▼'}</span>
                        <span>{teacher.name} · {lessonCount} {lessonWord(lessonCount)}</span>
                      </button>
                    </td>
                  </tr>

                  {/* ── One row per time slot ───────────────────────────── */}
                  {!isCollapsed && relevantSlots.map(sl => {
                    const isLegacySlot = sched.legacySlotIds.includes(sl.id);
                    const slotState: S.SlotVisualState = classifySlotVisualState({
                      isLegacySlot,
                      isArchiveWeek,
                      groupsPerDay: sched.aDays.map(ci => ({
                        groups: teacherSlotDayData[teacher.id]?.[sl.id]?.[ci] ?? [],
                        isPast: !dates[ci] || dateKey(dates[ci]!, timezone) < todayKey,
                      })),
                    });
                    return (
                      <tr key={`${teacher.id}-${sl.id}`} style={S.slotRow(slotState)}>
                        {/* Time label — sticky */}
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

                        {/* Day cells */}
                        {sched.aDays.map(ci => {
                          const date = dates[ci];
                          const dk = dateKey(date, timezone);
                          const isToday = dk === todayKey;
                          const isPast = dk < todayKey;
                          const groups = teacherSlotDayData[teacher.id]?.[sl.id]?.[ci] ?? [];
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
                                groups.map(g => {
                                  const blockId = lessonBlockIdForDay(g, ci);
                                  const session = sched.weekSessions[sessionKey(blockId, dk)];
                                  const isSubstituting = (session?.subTeacherId ?? 0) > 0 && session?.subTeacherId === teacher.id;
                                  const originalTeacher = isSubstituting
                                    ? (g.clubDays.includes(ci) ? g.tk : g.tg) ?? ''
                                    : '';
                                  return (
                                    <div key={g.id} style={{ marginBottom: 4 }}>
                                      {isSubstituting && (
                                        <div style={{ fontSize: 10, color: '#E65100', fontWeight: 700, marginBottom: 2 }}>
                                          ⇄ замена за {originalTeacher}
                                        </div>
                                      )}
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
                                  );
                                })
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

            {activeTeachers.length === 0 && (
              <tr>
                <td
                  colSpan={1 + sched.aDays.length}
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
                  ) : (
                    'Нет учителей в расписании на эту неделю'
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
export default memo(TeacherView, schedViewPropsEqual(['getGroupsInCell', 'slots', 'aDays', 'legacySlotIds', 'dayNotes', 'weekSessions', 'structureTick', 'groupColors', 'sessionStatuses', 'cancelledSessions']));
