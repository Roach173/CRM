import { memo, useState, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import type { UseSchedule } from '../../hooks/useSchedule';
import { weekDatesInTz, dateInTz, timeInTz } from '../../lib/tzUtils';
import { useAuth } from '../../hooks/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import type { SchedGroup } from './scheduleTypes';
import { DAYS_SHORT, clubBlockIdOf, grammarBlockIdOf, lessonBlockIdForDay } from './scheduleTypes';
import api from '../../lib/api';
import StudentPicker, { type ApiStudent } from './StudentPicker';
import { ConflictWarningModal } from './ConflictWarningModal';
import CancelDialog from './CancelDialog';
import EditGroupPanel from './EditGroupPanel';
import EditSessionPanel from './EditSessionPanel';
import { hasLessonStarted as computeHasLessonStarted } from './sessionStatusUx';
import { C } from './scheduleTheme';
import { timeRangesOverlap } from '../../utils/scheduleConflicts';
import { formatSessionDate, matchesStudentQuery } from '../../utils/scheduleUtils';
import * as GRS from './groupRowStyles';
import StudentProfileModalLoader from './StudentProfileModalLoader';
import {
  DayBadge, TeacherPill, GroupStatusBanner,
  attLabel, attBtnStyle, bookBtnStyle,
} from './GroupRowBadges';
import { StudentRow, chapterCtl, chapterNum, chapterBtn } from './GroupRowStudentRow';
import { GroupActionsMenu } from './GroupActionsMenu';
import { computeGroupRowActionState } from './groupRowActionState';
import { GroupRowAttendancePanel } from './GroupRowAttendancePanel';
import { useGroupRowActions, type AttendanceReadModel } from './useGroupRowActions';

type Teacher = { id: number; firstName: string; lastName: string };
type Cabinet = { id: number; name: string; capacity: number };
// ─── GroupRow ─────────────────────────────────────────────────────────────────
interface GroupRowProps {
  group: SchedGroup;
  ci: number;
  sid: number;
  sched: UseSchedule;
  wk: string;
  onRemoveFromCell: (group: SchedGroup) => void;
  onToggle: (gid: number) => void;
  onReload?: () => void;
  expanded?: boolean;
  teachers: Teacher[];
  cabinets: Cabinet[];
  slotStart: string;
  slotEnd: string;
  activeDays: number[];
  timeSlots?: import('./scheduleTypes').TimeSlot[];
  /** Room-filter popup: every row shares the same cabinet, so show the time range instead of the redundant room pill. */
  showTimeInsteadOfRoom?: boolean;
  isTeacher?: boolean;
  scheduleReadOnly?: boolean;
  scheduleReadOnlyReason?: string;
  allowGroupEditWhenReadOnly?: boolean;
  autoOpenEditGroup?: boolean;
  editGroupCurrentDate?: string;
  onAutoOpenEditGroupConsumed?: () => void;
  isMobile?: boolean;
  /** Display-only roster filter from SlotPanel's search box. Never touches
   *  group.stu itself, so mark-all / unmarked-count / submit stay whole-group. */
  studentFilter?: string;
}

const GroupRow = memo(function GroupRow({
  group, ci, sid, sched, wk, onRemoveFromCell, onToggle,
  onReload, expanded = false, teachers = [], cabinets = [], slotStart, slotEnd, activeDays,
  timeSlots, showTimeInsteadOfRoom = false, isTeacher = false, scheduleReadOnly = false, scheduleReadOnlyReason,
  allowGroupEditWhenReadOnly = false,
  autoOpenEditGroup = false, editGroupCurrentDate, onAutoOpenEditGroupConsumed,
  isMobile = false, studentFilter = '',
}: GroupRowProps) {
  const { school } = useAuth();
  const { canDeleteSchedule } = usePermissions();
  const tz = school?.timezone ?? 'Asia/Bishkek';
  // Combined read-only truth: panel-level lock (historical/stale grid) OR this
  // specific block's own tombstone (group.isReadOnly — COMPLETED/CANCELLED/closed/
  // soft-deleted, see classifyBlockVisibility()). Every read-only gate in this file
  // must check both, not just the panel-level prop.
  const effectiveReadOnly = scheduleReadOnly || !!group.isReadOnly;
  const [showSearch, setShowSearch] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showEditGrp, setShowEditGrp] = useState(false);
  const [conflictWarning, setConflictWarning] = useState<{ message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
  const [showEditSession, setShowEditSession] = useState(false);
  const [selectedStuId, setSelectedStuId] = useState<number | null>(null);
  const [profileModalId, setProfileModalId] = useState<number | null>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);

  useEffect(() => {
    if (!autoOpenEditGroup) return;
    const groupEditLocked = effectiveReadOnly && !allowGroupEditWhenReadOnly;
    if (groupEditLocked) {
      onAutoOpenEditGroupConsumed?.();
      return;
    }

    setShowMenu(false);
    setShowEditSession(false);
    if (!expanded) onToggle(group.id);
    setShowEditGrp(true);
    onAutoOpenEditGroupConsumed?.();
  }, [autoOpenEditGroup, effectiveReadOnly, allowGroupEditWhenReadOnly, expanded, onToggle, group.id, onAutoOpenEditGroupConsumed]);

  const rowRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  // Attendance data-loading + attendance/cancel/lifecycle API handlers live in one
  // hook — this card's JSX only reads state and calls handlers, it never inlines
  // the API calls itself. See useGroupRowActions.ts.
  const {
    attSaving, attLoading, submittedInfo, attendanceReadModel, frozenStudentIds,
    partialErrors,
    reopenLoading,
    showCancelDialog, setShowCancelDialog, cancelSessionIsCancelled, cancelLoading,
    lifecycleLoading, lifecycleConfirm, setLifecycleConfirm,
    openCancelDialog, handlePauseGroup, handleResumeGroup, handleStandaloneComplete,
    handleCancelOneTime, handleRestore, handleRestoreInvalidated,
    handleSubmitAttendance, reopenThenSubmit,
  } = useGroupRowActions({ group, ci, wk, tz, sched, expanded, isTeacher, onReload });

  useEffect(() => {
    // Skip while a search is active: search force-expands every matching group at
    // once, and ten simultaneous scrollIntoView calls fight each other — the list
    // ends up jumped to whichever group resolved last.
    if (expanded && !studentFilter) {
      setTimeout(() => rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
    }
  }, [expanded, studentFilter]);

  useEffect(() => {
    if (expanded) return;
    setShowEditGrp(false);
    setShowEditSession(false);
    setShowSearch(false);
    setShowMenu(false);
  }, [expanded]);

  function toggleMenu() {
    if (!showMenu && menuBtnRef.current) {
      const r = menuBtnRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setShowMenu(p => !p);
  }

  const isClubDay = group.clubDays.includes(ci);
  const isGrammarDay = group.grammarDays.includes(ci);
  const mainTeacher = isClubDay ? group.tk : group.tg;

  const grammarClubTimesOverlap = timeRangesOverlap(
    group.grammarStartTime ?? '',
    group.grammarEndTime ?? '',
    group.clubStartTime ?? '',
    group.clubEndTime ?? '',
  );
  const groupDayConflictDays = grammarClubTimesOverlap
    ? group.grammarDays.filter(d => group.clubDays.includes(d))
    : [];
  const hasCurrentDayConflict = group.grammarDays.includes(ci) && group.clubDays.includes(ci) && grammarClubTimesOverlap;
  const groupDayConflictLabel = groupDayConflictDays.map(d => DAYS_SHORT[d]).join(' ');

  const noTeacherAssigned = !mainTeacher || mainTeacher === '—';

  const dateISO = weekDatesInTz(wk, tz)[ci];
  const currentBlockId = lessonBlockIdForDay(group, ci);
  const grammarBlockId = grammarBlockIdOf(group);
  const clubBlockId = clubBlockIdOf(group);
  const grammarSub = isGrammarDay ? sched.getSessionSubstitute(grammarBlockId, dateISO) : null;
  const clubSub = isClubDay && clubBlockId ? sched.getSessionSubstitute(clubBlockId, dateISO) : null;
  const sessionMeta = sched.getWeekSession(currentBlockId, dateISO);
  // Prefer live sessionMeta (refreshed by loadWeekSessions on every onReload) over the
  // local attendanceReadModel snapshot taken once on expand — otherwise a stale snapshot
  // permanently shadows a correctly-updated backend state after a status-change mutation.
  const attendanceModel = (sessionMeta as AttendanceReadModel | null) ?? attendanceReadModel;
  const backendCanEditAttendance = attendanceModel?.canEditAttendance === true;
  const backendCanReopenAttendance = attendanceModel?.canReopenAttendance === true;
  const attendanceReopenedAt = attendanceModel?.attendanceReopenedAt ?? null;
  const attendanceIsFinalized = backendCanReopenAttendance;
  const attendanceIsReopened = Boolean(attendanceReopenedAt && backendCanEditAttendance);

  const currentGroupColor = sched.groupColors[String(group.id)] || '';

  const sessionStatus = sched.getSessionStatus(currentBlockId, dateISO);

  // Started-lesson convenience: an UPCOMING lesson is markable directly once its
  // start time has passed — whether that's today (after start) or an earlier date
  // still stuck as UPCOMING — without first switching it to «Идёт сейчас» via the
  // lesson menu. Mirrors the backend rule in sessionStateMachine.isAttendanceAllowed.
  // Credit deduction still only happens on Submit Attendance.
  const effectiveSessionStart = sessionMeta?.startTimeSnap ?? slotStart;
  const todayStr = dateInTz(new Date(), tz);
  const hasLessonStarted = computeHasLessonStarted(dateISO, todayStr, timeInTz(new Date(), tz), effectiveSessionStart);
  // P0-1: attendance only allowed by backend for IN_PROGRESS and COMPLETED
  // (plus a started UPCOMING lesson — see hasLessonStarted above).
  const isAttendanceAllowed = sessionStatus === 'IN_PROGRESS' || sessionStatus === 'COMPLETED'
    || (hasLessonStarted && sessionStatus === 'UPCOMING');

  // Lifecycle/action availability lives in one pure helper (groupRowActionState.ts) —
  // this card's JSX only reads the result; it never re-derives lifecycle rules itself.
  const {
    isLocked, isInProgress, isCompleted, isCancelled, isInvalidated,
    isGroupPaused, isGroupCompleted, isGroupArchived, isGroupActive,
    scheduleWriteLocked, groupEditLocked,
    canEditAttendanceNow, unmarkedCount, markAllDisabled,
    canBook, canChapter,
    canEditGroup, canDeleteGroup, canPauseGroup, canCompleteGroup, canRestoreSession, canCancelSession,
    primaryActionLabel: attendancePrimaryLabel,
    primaryActionDisabled: attendancePrimaryDisabled,
    disabledReason: attendancePrimaryTitle,
  } = computeGroupRowActionState({
    group,
    sessionStatus,
    isMakeup: Boolean(sessionMeta?.isMakeup),
    isBlockCancelled: sched.isBlockCancelled(currentBlockId, dateISO),
    hasLessonStarted,
    backendCanEditAttendance,
    backendCanReopenAttendance,
    // group.isReadOnly (backend truth-display: block is COMPLETED/CANCELLED/closed)
    // locks group-pair-level actions (delete/edit/pause/complete) regardless of
    // this row's specific session — those are structural actions on the whole
    // block, not this one date. Session-level gates (cancel/restore/attendance)
    // are untouched, driven by their own sessionStatus/isBlockCancelled inputs above.
    scheduleReadOnly: effectiveReadOnly,
    allowGroupEditWhenReadOnly,
    isTeacher,
    canDeleteSchedule,
    hasCurrentDayConflict,
    cancelLoading,
    lifecycleLoading,
    attSaving,
    reopenLoading,
  });
  const canResumeGroup = !isTeacher && !effectiveReadOnly && !!group.studentGroupId && !lifecycleLoading;

  // Out-of-policy badges: visible when UPCOMING session falls outside school's configured days/hours.
  const parseMinGR = (t: string | null | undefined): number => {
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const schoolActiveDays = school?.activeDays;
  const schoolWsMin = parseMinGR(school?.workStart ?? null);
  const schoolWeMin = school?.workEnd ? parseMinGR(school.workEnd) : 1440;
  const policyBadgeVisible = sessionMeta !== null && !isCompleted && !isCancelled && !isInvalidated && !isGroupArchived && !isGroupCompleted;
  const sessionOutsideDays = policyBadgeVisible && !!schoolActiveDays && schoolActiveDays.length > 0 && !schoolActiveDays.includes(ci);
  const effectiveSessionEnd = sessionMeta?.endTimeSnap ?? slotEnd;
  const sessionOutsideHours = policyBadgeVisible && (school?.workStart != null) && (school?.workEnd != null)
    && (parseMinGR(effectiveSessionStart) < schoolWsMin || parseMinGR(effectiveSessionEnd) > schoolWeMin);

  function handleAttendancePrimaryAction() {
    if (attendancePrimaryDisabled) return;
    if (isInvalidated) {
      void handleRestoreInvalidated();
      return;
    }
    // Finalized session: reopen silently then re-submit the draft in one action.
    if (backendCanReopenAttendance) {
      void reopenThenSubmit(unmarkedCount);
      return;
    }
    void handleSubmitAttendance(canEditAttendanceNow, unmarkedCount);
  }

  const allHaveBook = group.stu.length > 0 && group.stu.every(s => s.book);

  // Display-only. Every bulk action below (markAllPresent, unmarkedCount, submit)
  // still reads group.stu, so a filtered view never narrows what gets submitted.
  const stuQuery = studentFilter.trim();
  const visibleStu = stuQuery ? group.stu.filter(s => matchesStudentQuery(s, stuQuery)) : group.stu;
  const chapterSavingRef = useRef(false);

  // Optimistic chapter bumps with revert; in-flight guard prevents out-of-order saves.
  // Header (bulk): group chapter + every student. Row: one student only.
  async function persistChapter(delta: number) {
    if (!group.studentGroupId || chapterSavingRef.current) return;
    const prevCc = group.cc || 1;
    const next = Math.max(1, prevCc + delta);
    if (next === prevCc) return;
    chapterSavingRef.current = true;
    const prevStu = group.stu;
    sched.updateGroup(group.id, { cc: next, chapter: next, stu: prevStu.map(s => ({ ...s, ch: next })) });
    try {
      await api.patch(`/groups/${group.studentGroupId}/chapter`, { chapter: next });
    } catch (e: any) {
      sched.updateGroup(group.id, { cc: prevCc, chapter: prevCc, stu: prevStu });
      toast.error(e?.response?.data?.error ?? 'Не удалось обновить главу');
    } finally {
      chapterSavingRef.current = false;
    }
  }

  async function persistStudentChapter(stuId: number, delta: number) {
    if (!group.studentGroupId || chapterSavingRef.current) return;
    const current = group.stu.find(s => s.id === stuId)?.ch || 1;
    const next = Math.max(1, current + delta);
    if (next === current) return;
    chapterSavingRef.current = true;
    sched.updateStudent(group.id, stuId, { ch: next });
    try {
      await api.patch(`/groups/${group.studentGroupId}/chapter`, { studentProfileIds: [stuId], chapter: next });
    } catch (e: any) {
      sched.updateStudent(group.id, stuId, { ch: current });
      toast.error(e?.response?.data?.error ?? 'Не удалось обновить главу');
    } finally {
      chapterSavingRef.current = false;
    }
  }

  // Optimistic «Книга» toggle (one student or whole roster) with exact revert on error
  async function persistBook(studentIds: number[] | null, next: boolean) {
    if (!group.studentGroupId) return;
    const affected = studentIds ?? group.stu.map(s => s.id);
    const prevBook = new Map(group.stu.map(s => [s.id, s.book]));
    affected.forEach(id => sched.updateStudent(group.id, id, { book: next }));
    try {
      await api.patch(`/groups/${group.studentGroupId}/students/book`, {
        ...(studentIds ? { studentProfileIds: studentIds } : {}),
        bookIssued: next,
      });
    } catch {
      affected.forEach(id => sched.updateStudent(group.id, id, { book: prevBook.get(id) ?? false }));
      toast.error('Не удалось сохранить отметку о книге');
    }
  }

  return (
    <div ref={rowRef} style={GRS.groupRowContainer(expanded, currentGroupColor)}>
      <div
        onClick={() => onToggle(group.id)}
        style={GRS.groupRowHeader(isMobile, expanded, colorPickerOpen || showMenu)}
        onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = C.bgOff; }}
        onMouseLeave={e => { if (!expanded) e.currentTarget.style.background = ''; }}
      >
        <div style={GRS.groupInfo(isMobile)}>
          <div style={GRS.groupInfoRow(isMobile)}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap' }}>
              {group.lv}
            </span>
            {showTimeInsteadOfRoom ? (
              <span style={{ fontSize: 11, background: C.bgLight, padding: '2px 6px', borderRadius: 4, color: C.mid, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {slotStart}–{slotEnd}
              </span>
            ) : group.n && (
              <span style={{ fontSize: 11, background: C.bgLight, padding: '2px 6px', borderRadius: 4, color: C.mid, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {group.n}
              </span>
            )}
            <span style={{ color: C.border, fontSize: 12 }}>|</span>
            {/* Only render a variant's badge/pill if that block exists in this payload.
                Teacher view returns only the blocks this teacher teaches, so a sibling
                block (e.g. club taught by someone else) is absent — don't show a phantom
                "не назначен". An existing block with no teacher still shows "не назначен". */}
            {group.grammarBlockId != null && <TeacherPill name={group.tg} variant="grammar" sub={grammarSub} />}
            {group.grammarBlockId != null && <DayBadge days={group.grammarDays} variant="grammar" onClick={() => {}} />}
            {group.clubBlockId != null && <TeacherPill name={group.tk} variant="club" sub={clubSub} />}
            {group.clubBlockId != null && <DayBadge days={group.clubDays} variant="club" onClick={() => {}} />}
            {attendanceIsFinalized && <span style={{ fontSize: 11, color: C.green, fontWeight: 700, whiteSpace: 'nowrap' }}>✓ Посещаемость сдана</span>}
            {attendanceIsReopened && <span style={{ fontSize: 10, background: '#FFF8E1', color: '#5D4037', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>Посещаемость переоткрыта</span>}
            {isInProgress && <span style={{ fontSize: 10, background: C.primary, color: '#fff', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>● Идёт сейчас</span>}
            {isLocked && <span style={{ fontSize: 10, background: '#EEF2FF', color: '#3730A3', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>🔒 Зафиксирован</span>}
            {sessionMeta?.isMakeup && <span style={{ fontSize: 10, background: '#E8F5E9', color: '#2D6A4F', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>↩ Доп. урок</span>}
            {isCancelled && sessionMeta?.makeupSession && <span style={{ fontSize: 10, background: '#FFF8E1', color: '#5D4037', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>Доп. урок: {formatSessionDate(sessionMeta.makeupSession.date)}</span>}
            {group.status === 'PAUSED' && <span style={{ fontSize: 10, background: '#F0F9FF', color: '#0284C7', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>⏸ Пауза</span>}
            {group.status === 'COMPLETED' && <span style={{ fontSize: 10, background: '#F5F5F5', color: '#757575', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>✓ Завершена</span>}
            {isGroupArchived && <span style={{ fontSize: 10, background: '#ECEFF1', color: '#546E7A', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>🗃 Архив</span>}
            {isCancelled && !isGroupArchived && !isGroupCompleted && <span style={{ fontSize: 10, background: '#FFF3CD', color: '#92400E', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap', border: '1px solid #FBBF24' }}>⊘ Отменено</span>}
            {isInvalidated && <span style={{ fontSize: 10, background: '#FCE4EC', color: '#B71C1C', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>⊘ Аннулирован</span>}
            {sessionOutsideDays && <span title="Этот день больше не является рабочим по настройкам школы" style={{ fontSize: 10, background: '#FFF3E0', color: '#E65100', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>⚠ Вне рабочих дней</span>}
            {sessionOutsideHours && <span title="Время занятия выходит за рамки рабочих часов школы" style={{ fontSize: 10, background: '#FFF3E0', color: '#E65100', borderRadius: 4, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>⚠ Вне рабочих часов</span>}
          </div>
        </div>

        <span style={GRS.groupSpacer} />

        <span style={GRS.groupCapacityText(group.stu.length >= group.cap)}>
          {group.stu.length}/{group.cap}
        </span>

        {/* Color swatch button */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            ref={colorBtnRef}
            onClick={e => { e.stopPropagation(); setColorPickerOpen(v => !v); }}
            title="Цвет группы"
            style={{
              // Circle on mobile: as a rounded square this read as an unchecked
              // checkbox sitting next to the capacity count.
              width: isMobile ? 30 : 22, height: isMobile ? 30 : 22, borderRadius: isMobile ? '50%' : 5, flexShrink: 0,
              border: `2px solid ${currentGroupColor ? 'transparent' : C.border}`,
              background: currentGroupColor || C.bgLight,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: currentGroupColor ? '0 0 0 1px rgba(0,0,0,0.12)' : undefined,
            }}
          />
          {colorPickerOpen && (
            <>
              <div onClick={e => { e.stopPropagation(); setColorPickerOpen(false); }} style={{ position: 'fixed', inset: 0, zIndex: 299 }} />
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  position: 'absolute', right: 0, top: 28, zIndex: 300,
                  background: C.bg, borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.18)',
                  border: `1px solid ${C.border}`, padding: '10px 12px', minWidth: 180,
                }}
              >
                <div style={{ fontSize: 11, color: C.mid, fontWeight: 600, marginBottom: 8 }}>Цвет группы</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginBottom: 8 }}>
                  {[
                    '#fde68a','#bbf7d0','#bfdbfe','#fecaca','#e9d5ff','#fed7aa',
                    '#fcd34d','#6ee7b7','#93c5fd','#f87171','#c4b5fd','#fdba74',
                    '#86efac','#60a5fa','#fb923c','#f472b6','#34d399','#a78bfa',
                  ].map(c => (
                    <button
                      key={c}
                      onClick={() => { sched.setGroupColor(group.id, currentGroupColor === c ? '' : c); setColorPickerOpen(false); }}
                      style={{
                        width: 22, height: 22, borderRadius: 5, background: c, border: 'none', cursor: 'pointer',
                        boxShadow: currentGroupColor === c ? '0 0 0 2px #000' : '0 0 0 1px rgba(0,0,0,0.1)',
                      }}
                    />
                  ))}
                </div>
                {currentGroupColor && (
                  <button
                    onClick={() => { sched.setGroupColor(group.id, ''); setColorPickerOpen(false); }}
                    style={{ width: '100%', padding: '5px 0', fontSize: 11, color: C.red, background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer' }}
                  >
                    Сбросить цвет
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <button
          ref={menuBtnRef}
          onClick={e => { e.stopPropagation(); toggleMenu(); }}
          style={GRS.groupMenuBtnStyle(isMobile)}
          onMouseEnter={e => (e.currentTarget.style.background = C.bgLight)}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}
        >⋮</button>
      </div>

      {showMenu && menuPos && (
        <GroupActionsMenu
          top={menuPos.top}
          right={menuPos.right}
          isMobile={isMobile}
          isInvalidated={isInvalidated}
          isCancelled={isCancelled}
          isTeacher={isTeacher}
          isGroupActive={isGroupActive}
          isGroupPaused={isGroupPaused}
          isGroupCompleted={isGroupCompleted}
          isGroupArchived={isGroupArchived}
          scheduleReadOnly={effectiveReadOnly}
          scheduleReadOnlyReason={scheduleReadOnlyReason}
          scheduleWriteLocked={scheduleWriteLocked}
          canEditGroup={canEditGroup}
          canDeleteGroup={canDeleteGroup}
          canPauseGroup={canPauseGroup}
          canCompleteGroup={canCompleteGroup}
          canCancelSession={canCancelSession}
          canRestoreSession={canRestoreSession}
          canResumeGroup={canResumeGroup}
          cancelLoading={cancelLoading}
          onEditSession={() => { if (scheduleWriteLocked) return; setShowMenu(false); if (!expanded) onToggle(group.id); setShowEditSession(true); }}
          onCancelSession={() => { setShowMenu(false); void openCancelDialog(); }}
          onRestoreCancelledSession={() => { setShowMenu(false); void openCancelDialog(); }}
          onRestoreInvalidatedSession={() => { setShowMenu(false); void handleRestoreInvalidated(); }}
          onEditGroup={() => { if (groupEditLocked) return; setShowMenu(false); if (!expanded) onToggle(group.id); setShowEditGrp(true); }}
          onPauseGroup={() => { setShowMenu(false); handlePauseGroup(); }}
          onResumeGroup={() => { setShowMenu(false); handleResumeGroup(); }}
          onCompleteGroup={() => { setShowMenu(false); handleStandaloneComplete(); }}
          onDeleteFromCell={() => { setShowMenu(false); onRemoveFromCell(group); }}
          onClose={() => setShowMenu(false)}
        />
      )}

      {showEditGrp && (
        <EditGroupPanel
          group={group} teachers={teachers} cabinets={cabinets}
          slotId={sid} slotStart={slotStart} slotEnd={slotEnd} activeDays={activeDays}
          timeSlots={timeSlots}
          currentDate={editGroupCurrentDate ?? weekDatesInTz(wk, tz)[ci]}
          schedGroups={sched.G}
          pickContext={{ ci, wk }}
          isTeacher={isTeacher}
          onDone={() => { setShowEditGrp(false); onReload?.(); }}
          onClose={() => setShowEditGrp(false)}
        />
      )}

      {showEditSession && (
        <EditSessionPanel
          group={group} ci={ci} wk={wk}
          teachers={teachers} cabinets={cabinets}
          slotStart={slotStart} slotEnd={slotEnd}
          timeSlots={timeSlots}
          schedGroups={sched.G}
          onDone={() => setShowEditSession(false)}
          onClose={() => setShowEditSession(false)}
          onReload={onReload}
          onSessionUpdated={sched.updateWeekSession}
          onSessionCancelled={sched.markSessionCancelled}
          sessionMeta={sessionMeta}
        />
      )}
      <CancelDialog
        open={showCancelDialog}
        isCancelled={cancelSessionIsCancelled}
        onOneTime={handleCancelOneTime}
        onRestore={handleRestore}
        onClose={() => setShowCancelDialog(false)}
      />
      {expanded && (
        <div style={GRS.expandedSection}>
          <GroupStatusBanner
            status={group.status}
            blockVisibility={!sessionMeta ? group.blockVisibility : undefined}
            visibilityReason={group.visibilityReason}
          />
          {attendanceIsFinalized && submittedInfo && (
            <div style={GRS.lessonTypeHeader}>
              <span style={{ fontSize: 10, color: C.mid, whiteSpace: 'nowrap' as const }}>
                Сдал: {submittedInfo.name} · {submittedInfo.at}
              </span>
            </div>
          )}

          {/* Bulk row — mirrors the StudentRow column layout exactly:
              same 16px side padding, 8px gaps, 44px tail matching the ⋮ button,
              and fixed-width pills (attBtnStyle.minWidth) so columns can't drift. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: isMobile ? 'wrap' : 'nowrap',
            padding: isMobile ? '8px 12px' : '6px 16px', borderLeft: '3px solid transparent',
            // Mobile: stronger tint + the «Вся группа» label below, because with the
            // controls on their own line this row was indistinguishable from a student.
            background: isMobile ? C.bgOff : 'rgba(0,0,0,0.035)',
            borderBottom: `1px solid ${isMobile ? C.border : C.borderSoft}`,
          }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              {isMobile && (
                <span style={{ fontSize: 11, fontWeight: 800, color: C.mid, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Вся группа
                </span>
              )}
              {!effectiveReadOnly && !isGroupArchived && !isGroupCompleted && (
                <button onClick={() => setShowSearch(true)} style={GRS.addStudentBtn}>+ Добавить студента</button>
              )}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
              ...(isMobile ? { flexWrap: 'wrap' as const, flexBasis: '100%', justifyContent: 'flex-end' } : {}),
            }}>
              {canChapter && (
                <div style={chapterCtl(isMobile)} title="Глава всей группы">
                  <button onClick={() => persistChapter(-1)} style={chapterBtn(isMobile)}>−</button>
                  <span style={chapterNum(isMobile)}>{group.cc || 1}</span>
                  <button onClick={() => persistChapter(1)} style={chapterBtn(isMobile)}>+</button>
                </div>
              )}
              {canBook && group.stu.length > 0 && (
                <button
                  onClick={() => persistBook(null, !allHaveBook)}
                  title={allHaveBook ? 'Снять отметку о книге у всех' : 'Отметить книгу у всех'}
                  style={bookBtnStyle(allHaveBook, isMobile)}
                >Книга</button>
              )}
              {group.stu.length > 0 && (
                <button
                  onClick={markAllDisabled ? undefined : () => sched.markAllPresent(group.id)}
                  disabled={markAllDisabled}
                  title="Отметить всю группу разом"
                  style={{
                    ...attBtnStyle(group.gta, isMobile),
                    opacity: markAllDisabled ? 0.5 : 1,
                    cursor: markAllDisabled ? 'not-allowed' : 'pointer',
                  }}
                >{attLabel(group.gta)}</button>
              )}
              <span style={{ width: 44, flexShrink: 0 }} />
            </div>
          </div>

          {showSearch && (
            <div style={GRS.studentPickerWrapper}>
              <StudentPicker
                selectedIds={new Set(group.stu.map(s => s.id))}
                onAdd={(stu: ApiStudent) => {
                  const profileId = stu.studentProfile?.id;
                  if (!profileId) return;

                  const tryAdd = async (overrideCapacity = false, overrideStudentConflict = false) => {
                    try {
                      if (group.studentGroupId) {
                        await api.post(`/groups/${group.studentGroupId}/students`, {
                          studentProfileIds: [profileId],
                          overrideCapacity,
                          overrideStudentConflict,
                        });
                      } else {
                        toast.error('Добавление студента недоступно: группа без cohort-привязки. Обратитесь к администратору.');
                        return;
                      }
                      setShowSearch(false);
                      // Local patch, not a full onReload(): avoids resetting this group's
                      // shared stu.ta (draft attendance for other students, other day-cells
                      // of the same group) to null. New student starts unmarked (ta: null).
                      sched.addStudent(group.id, {
                        id: profileId,
                        n: `${stu.firstName} ${stu.lastName}`.trim(),
                        ph: '', em: stu.email, ch: group.cc, pd: '',
                        ta: null, st: 'ok', cm: '', lt: 'all', book: false,
                      });
                      toast.success('Добавлен');
                    } catch (e: any) {
                      const msg = e.response?.data?.error;
                      if (typeof msg === 'string' && msg.startsWith('CAPACITY_WARNING:')) {
                        setConflictWarning({
                          message: msg.replace('CAPACITY_WARNING:', ''),
                          confirmLabel: 'Всё равно добавить',
                          onConfirm: () => tryAdd(true, overrideStudentConflict),
                        });
                        return;
                      }
                      if (typeof msg === 'string' && msg.startsWith('STUDENT_CONFLICT_WARNING:')) {
                        setConflictWarning({
                          message: msg.replace('STUDENT_CONFLICT_WARNING:', ''),
                          confirmLabel: 'Всё равно добавить',
                          onConfirm: () => tryAdd(overrideCapacity, true),
                        });
                        return;
                      }
                      toast.error(msg || 'Ошибка добавления');
                    }
                  };
                  tryAdd();
                }}
                onRemove={() => {}}
                showChips={false}
              />
            </div>
          )}

          {attendanceIsReopened && (
            <div style={{ margin: '0 12px 8px', padding: '8px 10px', background: '#FFF8E1', border: '1px solid #FFE082', borderRadius: 7 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#5D4037' }}>
                Посещаемость открыта для редактирования — нажмите «Сохранить изменения»
              </div>
            </div>
          )}

          <div style={GRS.studentsList}>
            {visibleStu.map(s => {
              // The «на паузе» badge tracks the student's CURRENT freeze state (st==='ho')
              // and stays visible no matter how the lesson is marked — only unpausing
              // removes it. frozenStudentIds still lights it for legacy FROZEN attendance
              // rows (students paused at lesson time, since unpaused). Marking a paused
              // student present/absent changes the pill, never the badge.
              const showPaused = s.st === 'ho' || frozenStudentIds.has(s.id);
              return (
                <StudentRow
                  key={s.id} stu={s} gid={group.id} sched={sched}
                  selected={selectedStuId === s.id}
                  onSelect={() => setSelectedStuId(selectedStuId === s.id ? null : s.id)}
                  onOpenProfile={() => setProfileModalId(s.id)}
                  onToggleBook={canBook ? () => persistBook([s.id], !s.book) : undefined}
                  onChapterDelta={canChapter ? (delta) => persistStudentChapter(s.id, delta) : undefined}
                  attendanceEditable={canEditAttendanceNow}
                  paused={showPaused}
                  isTeacher={isTeacher}
                  attLoading={attLoading}
                  isMobile={isMobile}
                />
              );
            })}
            {group.stu.length === 0 && (
              <div style={{ padding: '12px 16px', fontSize: 12, color: C.mid, background: C.bgLight, borderBottom: `1px solid ${C.borderSoft}`, lineHeight: 1.45 }}>
                В группе пока нет студентов. Добавьте студентов, чтобы отметить посещаемость.
              </div>
            )}
            {group.stu.length > 0 && visibleStu.length === 0 && (
              <div style={{ padding: '12px 16px', fontSize: 12, color: C.mid, background: C.bgLight, borderBottom: `1px solid ${C.borderSoft}` }}>
                Никто не найден по запросу «{studentFilter.trim()}».
              </div>
            )}
          </div>

          {partialErrors.length > 0 && (
            <div style={{ margin: '6px 12px', padding: '8px 10px', background: C.redLight, borderRadius: 7, border: `1px solid ${C.red}30` }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: C.red, margin: '0 0 4px 0' }}>
                ⚠ Не сохранено: {partialErrors.length} студент(ов)
              </p>
              {partialErrors.map(pe => {
                const peStu = group.stu.find(s => s.id === pe.studentProfileId);
                return (
                  <div key={pe.studentProfileId} style={{ fontSize: 10, color: C.red, lineHeight: 1.4 }}>
                    · {peStu?.n ?? `#${pe.studentProfileId}`}:{' '}
                    {pe.error === 'STUDENT_FROZEN' ? 'студент заморожен' : pe.error}
                  </div>
                );
              })}
            </div>
          )}

          <GroupRowAttendancePanel
            isLocked={isLocked}
            isGroupPaused={isGroupPaused}
            isGroupCompleted={isGroupCompleted}
            isGroupArchived={isGroupArchived}
            isInvalidated={isInvalidated}
            isCancelled={isCancelled}
            noTeacherAssigned={noTeacherAssigned}
            hasCurrentDayConflict={hasCurrentDayConflict}
            groupDayConflictLabel={groupDayConflictLabel}
            isAttendanceAllowed={isAttendanceAllowed}
            hasStudents={group.stu.length > 0}
            primaryLabel={attendancePrimaryLabel}
            primaryDisabled={attendancePrimaryDisabled}
            primaryTitle={attendancePrimaryTitle}
            primarySaving={attSaving || reopenLoading}
            onPrimaryAction={handleAttendancePrimaryAction}
          />
        </div>
      )}
      {conflictWarning && (
        <ConflictWarningModal
          message={conflictWarning.message}
          confirmLabel={conflictWarning.confirmLabel}
          onConfirm={() => { setConflictWarning(null); conflictWarning.onConfirm(); }}
          onCancel={() => setConflictWarning(null)}
        />
      )}
      {lifecycleConfirm && (
        <ConflictWarningModal
          message={lifecycleConfirm.message}
          confirmLabel={lifecycleConfirm.confirmLabel}
          onConfirm={lifecycleConfirm.onConfirm}
          onCancel={() => setLifecycleConfirm(null)}
        />
      )}
      <StudentProfileModalLoader
        profileId={profileModalId}
        onClose={() => setProfileModalId(null)}
        onNotesSaved={(notes) => { if (profileModalId != null) sched.updateStudent(group.id, profileModalId, { cm: notes }); }}
        onFinancialsChanged={({ credits, paidUntil }) => {
          if (profileModalId == null) return;
          // pd is DD.MM.YYYY (parsePd); callback gives ISO YYYY-MM-DD (or null).
          sched.updateStudent(group.id, profileModalId, {
            cr: credits,
            pd: paidUntil ? paidUntil.split('-').reverse().join('.') : '',
          });
        }}
        onPausedChanged={(paused) => { if (profileModalId != null) sched.updateStudent(group.id, profileModalId, { st: paused ? 'ho' : 'ok' }); }}
      />
    </div>
  );
}, (prev, next) =>
  // Per-group comparison instead of `sched.G === sched.G`: a click on one student
  // used to re-render EVERY GroupRow in the popup. getGroupsInCell may return a
  // shallow copy of the group (session overrides), so fall back to the fields that
  // in-place G mutations actually touch (stu/gta/cc); override-derived fields
  // (times, teacher, cabinet) change only with weekSessions, compared below.
  (prev.group === next.group || (
    prev.group.id === next.group.id &&
    prev.group.stu === next.group.stu &&
    prev.group.gta === next.group.gta &&
    prev.group.cc === next.group.cc &&
    prev.group.lv === next.group.lv &&
    prev.group.status === next.group.status &&
    prev.group.blockStatus === next.group.blockStatus &&
    prev.group.blockVisibility === next.group.blockVisibility &&
    prev.group.isReadOnly === next.group.isReadOnly
  )) &&
  prev.ci === next.ci &&
  prev.sid === next.sid &&
  prev.expanded === next.expanded &&
  prev.slotStart === next.slotStart &&
  prev.slotEnd === next.slotEnd &&
  prev.sched.groupColors === next.sched.groupColors &&
  prev.sched.weekSessions === next.sched.weekSessions &&
  prev.sched.sessionStatuses === next.sched.sessionStatuses &&
  prev.teachers === next.teachers &&
  prev.cabinets === next.cabinets &&
  prev.activeDays === next.activeDays &&
  prev.timeSlots === next.timeSlots &&
  prev.showTimeInsteadOfRoom === next.showTimeInsteadOfRoom &&
  prev.isMobile === next.isMobile &&
  prev.studentFilter === next.studentFilter &&
  prev.scheduleReadOnly === next.scheduleReadOnly &&
  prev.scheduleReadOnlyReason === next.scheduleReadOnlyReason &&
  prev.allowGroupEditWhenReadOnly === next.allowGroupEditWhenReadOnly &&
  prev.autoOpenEditGroup === next.autoOpenEditGroup &&
  prev.editGroupCurrentDate === next.editGroupCurrentDate &&
  prev.onAutoOpenEditGroupConsumed === next.onAutoOpenEditGroupConsumed
);

export default GroupRow;
export type { GroupRowProps };
