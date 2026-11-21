import React, { useState, useEffect, useCallback, useRef, useMemo, Suspense } from 'react';
import { useSearchParams } from 'react-router';
import toast from 'react-hot-toast';
import { useSchedule, weekKey, weekLabel, addWeeks, generateSlotsFromSettings } from '../../../hooks/useSchedule';
import { useRealtimeSchedule } from '../../../hooks/useRealtimeSchedule';
import { useAuth } from '../../../hooks/useAuth';
import api from '../../../lib/api';
import type { SchedGroup, SchedView } from '../../../components/schedule/scheduleTypes';
import { type PolicyConflictAction } from '../../../components/schedule/PolicyConflictsPanel';
import CancelDialog from '../../../components/schedule/CancelDialog';
import EditSessionPanel from '../../../components/schedule/EditSessionPanel';
import WeekGrid from '../../../components/schedule/WeekGrid';
import RoomsView from '../../../components/schedule/RoomsView';
import MonthView from '../../../components/schedule/MonthView';
// Lazy: SlotPanel is the heaviest schedule chunk (~54KB gzip) and only renders
// after a cell click — a static import made it block the page's first paint.
const SlotPanel = React.lazy(() => import('../../../components/schedule/SlotPanel'));
import TeacherView from '../../../components/schedule/TeacherView';
import GroupView from '../../../components/schedule/GroupView';
import TeacherAvailabilityView from '../../../components/schedule/TeacherAvailabilityView';
import { ZoomInput, GearIcon, ActivityIcon } from './ScheduleToolbarControls';
import ScheduleDayOverlays from './ScheduleDayOverlays';
import { ScheduleControlModal, ScheduleSettingsModal } from './ScheduleModals';
import { dayIndexFromIso, policyWeekForDate, findPolicyGroup, policyEditDayForGroup, findPolicySlot } from './scheduleDeepLinkHelpers';
import { GROUP_PICK_KEY } from '../../../lib/groupPick';
import { sessionKey } from '../../../hooks/schedule/scheduleKeys';

const MN = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

export type Teacher = { id: number; firstName: string; lastName: string };
export type Cabinet = { id: number; name: string; capacity: number };
type PolicyCancelAction = Extract<PolicyConflictAction, { type: 'cancel-session' }>;
type PolicyOpenSessionAction = Extract<PolicyConflictAction, { type: 'open-session' }>;
type PolicyEditSessionState = { action: PolicyOpenSessionAction; group: SchedGroup; ci: number; wk: string; slotStart: string; slotEnd: string };
type PolicyConflictSummaryResponse = {
  success: boolean;
  data?: {
    summary?: {
      sessionsOutsideDays?: number;
      sessionsOutsideHours?: number;
      blocksOutsidePolicy?: number;
    };
  };
};

function hasPolicyConflicts(data?: PolicyConflictSummaryResponse['data']): boolean {
  const s = data?.summary;
  return Boolean(
    (s?.sessionsOutsideDays ?? 0) > 0 ||
    (s?.sessionsOutsideHours ?? 0) > 0 ||
    (s?.blocksOutsidePolicy ?? 0) > 0,
  );
}

export default function Schedule() {
  const sched = useSchedule();
  const { loadFromServer, applySchedulePolicy, loadWeekSessions, applyActiveDays, loadWeekTruth } = sched;
  const { school } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tz = school?.timezone ?? 'Asia/Bishkek';
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [cabinets, setCabinets] = useState<Cabinet[]>([]);
  const [loading, setLoading] = useState(true);

  // ponytail: view is a sticky UI pref kept in one global localStorage key; per-user/school
  // key only if cross-account bleed on a shared browser ever matters (school.id isn't ready
  // synchronously here anyway). Explicit user choice wins over the school-wide defaultView below.
  const [view, setView] = useState<SchedView>(() => {
    const saved = localStorage.getItem('schedule.view');
    const valid: SchedView[] = ['week', 'month', 'rooms', 'teacher', 'group', 'teacher-availability'];
    return saved && valid.includes(saved as SchedView) ? (saved as SchedView) : 'week';
  });

  // ponytail: month is a transient view and is never persisted (see persistView below).
  // Leaving the browser tab drops back to the last STICKY view (rooms/week/etc., whatever
  // is in localStorage) — so "По кабинетам"/"По времени" survive a month peek. Reset while
  // hidden so there's no flash on return.
  useEffect(() => {
    const onHide = () => {
      if (!document.hidden) return;
      setView(prev => prev === 'month'
        ? ((localStorage.getItem('schedule.view') as SchedView) ?? 'week')
        : prev);
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // Persist every view except month; month stays in-memory only so it never becomes the
  // permanent view and never overwrites the sticky rooms/week choice.
  const persistView = (v: SchedView) => {
    if (v !== 'month') localStorage.setItem('schedule.view', v);
    setView(v);
  };

  const reloadSchedule = useCallback(async () => {
    try {
      // Two separate timeslot calls in parallel:
      // currentPolicyRes — no date → always current school policy → safe for loadFromServer.
      //   Historical slots must never reach loadFromServer: they contain sequential fake IDs
      //   that would overwrite dbSlotIdMapRef and cause future weeks to be labelled "архив".
      // viewWkPolicyRes — with date → correct policy for the week the user is viewing →
      //   used only for applySchedulePolicy (display) and the historical banner.
      const [res, currentPolicyRes, viewWkPolicyRes, cabRes] = await Promise.all([
        api.get('/schedule'),
        api.get('/settings/timeslots'),
        api.get('/settings/timeslots', { params: { date: viewWkRef.current } }),
        api.get('/settings/cabinets'),
      ]);
      const blocks = res.data?.data ?? [];

      // Feed loadFromServer with CURRENT policy slots only.
      const currentPolicy = currentPolicyRes.data?.data ?? {};
      const dbSlots = Array.isArray(currentPolicy.slots) && currentPolicy.slots.length > 0
        ? (currentPolicy.slots as Array<{ id: number; startTime: string; endTime: string }>).map(sl => ({
            id: sl.id, s: sl.startTime, e: sl.endTime,
          }))
        : undefined;
      if (Array.isArray(blocks)) loadFromServer(blocks, dbSlots);

      // Feed applySchedulePolicy with viewWk policy (may be historical).
      const viewWkPolicy = viewWkPolicyRes.data?.data ?? {};
      if (Array.isArray(viewWkPolicy.activeDays) && Array.isArray(viewWkPolicy.slots)) {
        applySchedulePolicy({
          activeDays: viewWkPolicy.activeDays,
          slots: viewWkPolicy.slots,
          policySlotTimes: Array.isArray(viewWkPolicy.policySlotTimes) ? viewWkPolicy.policySlotTimes : undefined,
        });
      }
      setPolicyIsHistorical(Boolean(viewWkPolicy.historical));

      const cabs = cabRes.data?.data ?? [];
      if (Array.isArray(cabs)) setCabinets(cabs);

      // Refresh session lifecycle statuses (status, cancellations) for the currently
      // viewed week. Without this, GroupRow reads stale sessionStatuses after any
      // status-changing save (e.g. UPCOMING→COMPLETED) and incorrectly shows
      // "Урок ещё не начат" until the user navigates away and back.
      await loadWeekSessions(viewWkRef.current);
      // Owner/Admin backend-truth overlay for the currently viewed week (see loadWeekTruth).
      loadWeekTruth(viewWkRef.current);
    } catch {
      /* mount/refresh fetch — errors surfaced via toast above */
    }
  }, [loadFromServer, applySchedulePolicy, loadWeekSessions, loadWeekTruth]);

  useEffect(() => {
    const today = weekKey(new Date());
    // Fire the week-session lifecycle load in parallel with the structural batch
    // below. It sets an independent state slice (weekSessions/statuses), so it does
    // not need to wait for /schedule — running it here saves a serial round-trip
    // on first paint (notable over a high-latency tunnel).
    loadWeekSessions(today);
    // Owner/Admin backend-truth overlay for the current week (see loadWeekTruth).
    loadWeekTruth(today);
    // Teachers/cabinets feed SlotPanel and the filter dropdowns, not the grid —
    // they load independently so the grid's first data paint isn't gated on the
    // slowest of five requests (allSettled waits for all of them).
    api.get('/users?role=TEACHER').then(res => {
      const ts = res.data?.data ?? [];
      if (Array.isArray(ts)) setTeachers(ts);
    }).catch(() => { /* filters degrade gracefully */ });
    api.get('/settings/cabinets').then(res => {
      const cabs = res.data?.data ?? [];
      if (Array.isArray(cabs)) setCabinets(cabs);
    }).catch(() => { /* SlotPanel refetches on open */ });
    Promise.allSettled([
      api.get('/schedule'),
      api.get('/settings'),
      api.get('/settings/timeslots', { params: { date: today } }),
    ]).then(([sResult, settResult, tsResult]) => {
      const sRes = sResult.status === 'fulfilled' ? sResult.value : null;
      const settRes = settResult.status === 'fulfilled' ? settResult.value : null;
      const tsRes = tsResult.status === 'fulfilled' ? tsResult.value : null;

      const sett = settRes?.data?.data ?? {};
      const tsPolicy = tsRes?.data?.data ?? {};

      // Prefer real DB slot IDs from /settings/timeslots; fall back to computed slots.
      // Must map API format { startTime, endTime } → TimeSlot { s, e } before passing
      // to loadFromServer, which expects the { id, s, e } shape used internally.
      const dbSlots = (() => {
        const raw = tsPolicy.slots;
        if (Array.isArray(raw) && raw.length > 0) {
          return (raw as Array<{ id: number; startTime: string; endTime: string }>).map(sl => ({
            id: sl.id,
            s: sl.startTime,
            e: sl.endTime,
          }));
        }
        return sett.workStart && sett.workEnd && sett.slotDuration
          ? generateSlotsFromSettings(sett.workStart, sett.workEnd, sett.slotDuration)
          : undefined;
      })();

      const blocks = sRes?.data?.data ?? [];
      if (Array.isArray(blocks)) loadFromServer(blocks, dbSlots);
      if (!sRes) toast.error('Не удалось загрузить расписание');
      // Apply server activeDays AFTER loadFromServer so it wins over stale localStorage value.
      // Mirrors the pattern used in reloadSchedule (applySchedulePolicy after loadFromServer).
      if (Array.isArray(tsPolicy.activeDays) && Array.isArray(tsPolicy.slots)) {
        applySchedulePolicy({
          activeDays: tsPolicy.activeDays,
          slots: tsPolicy.slots,
          policySlotTimes: Array.isArray(tsPolicy.policySlotTimes) ? tsPolicy.policySlotTimes : undefined,
        });
      } else if (Array.isArray(sett.activeDays) && sett.activeDays.length > 0) {
        applyActiveDays(sett.activeDays);
      }
      // School-wide default applies only when the user has no saved view preference yet.
      const validViews: SchedView[] = ['week', 'rooms', 'teacher', 'month'];
      if (!localStorage.getItem('schedule.view') && sett.defaultView && validViews.includes(sett.defaultView as SchedView)) {
        setView(sett.defaultView as SchedView);
      }
      setPolicyIsHistorical(Boolean(tsRes?.data?.data?.historical));
    }).catch(() => { /* intentional — mount fetch */ }).finally(() => { didMountRef.current = true; setLoading(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [teacherFilter, setTeacherFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const allTeachers = useMemo(() => Array.from(new Set([
    ...teachers.map(t => `${t.firstName} ${t.lastName}`.trim()),
    ...Object.values(sched.G).flatMap(g => [g.tg, g.tk]).filter((t): t is string => !!t && t !== '—'),
  ])).sort(), [teachers, sched.G]);
  const allGroups = useMemo(() => {
    const map = new Map<number, string>();
    for (const g of Object.values(sched.G)) {
      if (g.studentGroupId != null) {
        map.set(g.studentGroupId, g.lv);
      }
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sched.G]);
  const [viewWk, setViewWk] = useState(() => weekKey(new Date()));
  // Portal target so RoomsView can render its expand/empty-slot controls into the
  // shared toolbar row instead of a second strip below it.
  const [roomsToolbarEl, setRoomsToolbarEl] = useState<HTMLDivElement | null>(null);
  const [policyIsHistorical, setPolicyIsHistorical] = useState(false);
  const [auditRefreshKey, setAuditRefreshKey] = useState(0);
  const [controlOpen, setControlOpen] = useState(false);
  const [controlHasConflicts, setControlHasConflicts] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshControlIndicator = useCallback(async () => {
    try {
      const res = await api.get<PolicyConflictSummaryResponse>('/schedule/policy-conflicts');
      setControlHasConflicts(hasPolicyConflicts(res.data?.data));
    } catch {
      setControlHasConflicts(false);
    }
  }, []);

  useEffect(() => {
    refreshControlIndicator();
  }, [refreshControlIndicator, auditRefreshKey]);

  useEffect(() => {
    // Fetch the schedule policy that was active for this week, then load sessions.
    // GET /settings/timeslots?date=<weekStart> returns historical policy for past weeks
    // and current policy for the current/future week — same endpoint handles both.
    if (!didMountRef.current) return; // mount effect handles initial load
    let active = true;
    api.get('/settings/timeslots', { params: { date: viewWk } })
      .then((res) => {
        if (!active) return;
        const d = res.data?.data ?? {};
        if (Array.isArray(d.activeDays) && Array.isArray(d.slots)) {
          applySchedulePolicy({
            activeDays: d.activeDays,
            slots: d.slots,
            policySlotTimes: Array.isArray(d.policySlotTimes) ? d.policySlotTimes : undefined,
          });
        }
        setPolicyIsHistorical(Boolean(d.historical));
      })
      .catch(() => {})
      .finally(() => {
        if (!active) return;
        loadWeekSessions(viewWk);
        // Owner/Admin backend-truth overlay for the newly-viewed week (see loadWeekTruth).
        loadWeekTruth(viewWk);
      });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewWk]);

  // Realtime refresh — stable ref so handlers don't re-register on every viewWk change
  const viewWkRef = useRef(viewWk);
  const didMountRef = useRef(false);
  useEffect(() => { viewWkRef.current = viewWk; }, [viewWk]);
  // Coalesce audit-key bumps: every realtime event fires a /schedule/policy-conflicts
  // GET via the auditRefreshKey effect. A teacher submitting attendance emits a burst
  // of events — the trailing debounce turns N requests into one. User-initiated
  // refreshes (refreshAfterPolicyAction) still bump immediately.
  const auditDebounceRef = useRef<number | undefined>(undefined);
  const bumpAuditKeyDebounced = useCallback(() => {
    window.clearTimeout(auditDebounceRef.current);
    auditDebounceRef.current = window.setTimeout(() => setAuditRefreshKey(prev => prev + 1), 1000);
  }, []);
  useEffect(() => () => window.clearTimeout(auditDebounceRef.current), []);
  const handleRealtimeRefresh = useCallback(() => {
    loadWeekSessions(viewWkRef.current);
    bumpAuditKeyDebounced();
  }, [loadWeekSessions, bumpAuditKeyDebounced]);
  const handleRealtimeStructureRefresh = useCallback(async () => {
    await reloadSchedule();
    loadWeekSessions(viewWkRef.current);
    bumpAuditKeyDebounced();
  }, [reloadSchedule, loadWeekSessions, bumpAuditKeyDebounced]);
  const resetFilters = useCallback(() => {
    setTeacherFilter('');
    setGroupFilter('');
  }, []);
  const hasActiveFilters = Boolean(teacherFilter || groupFilter);
  useRealtimeSchedule({
    onSessionStatusChanged: handleRealtimeRefresh,
    onAttendanceUpdated: handleRealtimeRefresh,
    onSessionChanged: handleRealtimeRefresh,
    onStructureChanged: handleRealtimeStructureRefresh,
  });

  // Reload policy when CrmSettings saves schedule-policy fields (cross-route sync)
  useEffect(() => {
    function onSettingsSaved() {
      if (!didMountRef.current) return;
      reloadSchedule();
    }
    window.addEventListener('schedule-policy-updated', onSettingsSaved);
    return () => window.removeEventListener('schedule-policy-updated', onSettingsSaved);
  }, [reloadSchedule]);

  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const isCurrentWk = viewWk === weekKey(new Date());

  // Overlay state
  const [slotPanel, setSlotPanel] = useState<{
    ci: number;
    sid: number;
    fromRooms?: boolean;
    roomName?: string;
    gid?: number;
    initialCreate?: boolean;
    initialEditGroupId?: number;
    editGroupCurrentDate?: string;
    wk?: string;
    policyOpenKey?: string;
    policyTimeSlots?: Array<{ id: number; s: string; e: string }>;
    policyActiveDays?: number[];
    policyHistorical?: boolean;
    policyConflictBlockId?: number;
    focusGroupOnly?: boolean;
  } | null>(null);
  const [dayAnnotCtx, setDayAnnotCtx] = useState<string | null>(null);
  const [showBulkCancel, setShowBulkCancel] = useState(false);
  const [bulkCancelInitial, setBulkCancelInitial] = useState<{ date: string; label: string } | null>(null);
  const [restoringDay, setRestoringDay] = useState(false);
  const [dayMenuCtx, setDayMenuCtx] = useState<{ dk: string; x: number; y: number } | null>(null);
  const [policyCancelAction, setPolicyCancelAction] = useState<PolicyCancelAction | null>(null);
  const [policyCancelLoading, setPolicyCancelLoading] = useState(false);
  const [policyEditSession, setPolicyEditSession] = useState<PolicyEditSessionState | null>(null);

  // Stable handlers (setters only) — memo'd grid views compare them by identity,
  // so plain re-created functions here would defeat their React.memo entirely.
  const handleCellClick = useCallback((ci: number, sid: number, room?: string, gid?: number) => {
    setSlotPanel({ ci, sid, gid, fromRooms: !!room, roomName: room });
  }, []);
  const refreshAfterPolicyAction = useCallback(async () => {
    await reloadSchedule();
    setAuditRefreshKey(prev => prev + 1);
  }, [reloadSchedule]);
  async function handlePolicyConflictAction(action: PolicyConflictAction) {
    if (action.type === 'edit-block') {
      setPolicyEditSession(null);
      setPolicyCancelAction(null);
      setControlOpen(false);
      const group = findPolicyGroup(sched, action.blockId, action.studentGroupId);
      if (!group) {
        toast.error('Не удалось открыть редактор: группа не найдена');
        return;
      }
      const focusDate = action.focusDate ?? action.applyFrom;
      const targetWk = focusDate ? policyWeekForDate(focusDate) : viewWk;
      let policyTimeSlots: Array<{ id: number; s: string; e: string }> | undefined;
      let policyActiveDays: number[] | undefined;
      let policyHistorical: boolean | undefined;
      const editDate = focusDate ?? action.applyFrom;
      if (editDate) {
        try {
          const res = await api.get('/settings/timeslots', { params: { date: editDate } });
          const data = res.data?.data ?? {};
          const policySlotTimes = new Set(Array.isArray(data.policySlotTimes) ? data.policySlotTimes : []);
          const rawSlots = Array.isArray(data.slots)
            ? data.slots as Array<{ id: number; startTime: string; endTime: string }>
            : [];
          policyTimeSlots = rawSlots
            .filter(slot => policySlotTimes.size === 0 || policySlotTimes.has(`${slot.startTime}|${slot.endTime}`))
            .map(slot => ({ id: slot.id, s: slot.startTime, e: slot.endTime }));
          policyActiveDays = Array.isArray(data.activeDays) ? data.activeDays : undefined;
          policyHistorical = Boolean(data.historical);
          if (import.meta.env.DEV) {
            console.debug('[POLICY-EDIT open]', {
              conflictFirstWorkingDate: action.applyFrom,
              passedCurrentDate: editDate,
              passedSlotId: null,
              openedBlockId: action.blockId,
              legacyStartTime: action.startTime,
              legacyEndTime: action.endTime,
              timeSlots: policyTimeSlots,
            });
          }
        } catch {
          toast.error('Не удалось загрузить сетку расписания для даты изменения');
          return;
        }
      }
      const slot = findPolicySlot(sched, action.startTime, action.endTime, policyTimeSlots);
      if (slot.id <= 0) {
        toast.error('Не удалось открыть редактор: слот не найден');
        return;
      }
      if (import.meta.env.DEV) {
        console.debug('[POLICY-EDIT open resolved]', {
          currentDate: editDate,
          applyFrom: action.applyFrom,
          slotId: slot.id,
          slotStart: slot.s,
          slotEnd: slot.e,
          targetWk,
        });
      }
      setViewWk(targetWk);
      setSlotPanel({
        ci: policyEditDayForGroup(sched, group, action.blockId, focusDate),
        sid: slot.id,
        gid: group.id,
        initialEditGroupId: group.id,
        editGroupCurrentDate: editDate ?? undefined,
        wk: targetWk,
        policyOpenKey: String(Date.now()),
        policyTimeSlots,
        policyActiveDays,
        policyHistorical,
        policyConflictBlockId: action.blockId,
        focusGroupOnly: true,
      });
      return;
    }

    if (action.type === 'reschedule-session') {
      toast.error('Откройте занятие через «Редактировать урок»');
      return;
    }
    if (action.type === 'cancel-session') {
      setPolicyCancelAction(action);
      return;
    }
    const group = findPolicyGroup(sched, action.blockId, action.studentGroupId);
    if (!group) {
      toast.error('Не удалось открыть редактор: группа не найдена');
      return;
    }
    const slot = findPolicySlot(sched, action.startTime, action.endTime);
    const ci = dayIndexFromIso(sched, action.date);
    setPolicyEditSession({
      action,
      group,
      ci,
      wk: policyWeekForDate(action.date),
      slotStart: slot.s,
      slotEnd: slot.e,
    });
  }
  // Deep-link from Settings → Policy Impact modal ("Открыть"): ?focusBlockId=&focusDate=&focusStart=&focusEnd=&focusGroupId=
  useEffect(() => {
    if (loading) return;
    const blockId = searchParams.get('focusBlockId');
    const focusDate = searchParams.get('focusDate');
    if (!blockId || !focusDate) return;
    const groupId = searchParams.get('focusGroupId');
    handlePolicyConflictAction({
      type: 'edit-block',
      blockId: Number(blockId),
      studentGroupId: groupId ? Number(groupId) : null,
      startTime: searchParams.get('focusStart') ?? '00:00',
      endTime: searchParams.get('focusEnd') ?? '00:00',
      applyFrom: focusDate,
      focusDate,
    });
    setSearchParams({}, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  // Deep-link from GroupDetail → «Расписание» tab: ?openGroupId=&openBlockId=&openStart=&openEnd=
  // Opens the block's slot with its group expanded (plain view, not the edit form).
  useEffect(() => {
    if (loading) return;
    const blockIdParam = searchParams.get('openBlockId');
    if (!blockIdParam) return;
    const blockId = Number(blockIdParam);
    const groupIdParam = searchParams.get('openGroupId');
    const group = findPolicyGroup(sched, blockId, groupIdParam ? Number(groupIdParam) : null);
    if (!group) {
      toast.error('Группа не найдена в расписании');
      setSearchParams({}, { replace: true });
      return;
    }
    const slot = findPolicySlot(sched, searchParams.get('openStart') ?? group.startTime ?? '', searchParams.get('openEnd') ?? group.endTime ?? '');
    const targetWk = weekKey(new Date());
    setViewWk(targetWk);
    setSlotPanel({ ci: policyEditDayForGroup(sched, group, blockId), sid: slot.id, gid: group.id, wk: targetWk });
    setSearchParams({}, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  // Return from the Groups page "Выбрать группу" pick (?resumeGroupPick=1):
  // reopen the same cell — the create-block form or the group's edit panel —
  // and let CreateGroupForm/EditGroupPanel consume the stash.
  useEffect(() => {
    if (loading) return;
    if (!searchParams.get('resumeGroupPick')) return;
    setSearchParams({}, { replace: true });
    try {
      const stash = JSON.parse(sessionStorage.getItem(GROUP_PICK_KEY) ?? 'null');
      if (!stash?.picked) return;
      if (stash.mode === 'edit') {
        const targetWk = stash.wk ?? viewWk;
        setViewWk(targetWk);
        setSlotPanel({
          ci: stash.ci, sid: stash.sid, gid: stash.gid,
          initialEditGroupId: stash.gid,
          editGroupCurrentDate: stash.currentDate ?? undefined,
          wk: targetWk,
        });
        return;
      }
      const targetWk = stash.cellDateIso ? policyWeekForDate(stash.cellDateIso) : viewWk;
      setViewWk(targetWk);
      setSlotPanel({ ci: stash.ci, sid: stash.sid, initialCreate: true, wk: targetWk });
    } catch {
      sessionStorage.removeItem(GROUP_PICK_KEY);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  async function handlePolicyCancelOneTime(reason: string) {
    if (!policyCancelAction || policyCancelLoading) return;
    setPolicyCancelLoading(true);
    try {
      await api.patch(`/schedule/session/${policyCancelAction.sessionId}/status`, {
        status: 'CANCELLED',
        version: policyCancelAction.sessionVersion,
        reason,
      });
      sched.markSessionCancelled?.(policyCancelAction.blockId, policyCancelAction.date, true);
      toast.success('Занятие отменено');
      setPolicyCancelAction(null);
      await refreshAfterPolicyAction();
    } catch (e: any) {
      toast.error(e?.response?.data?.error ?? 'Ошибка отмены');
    } finally {
      setPolicyCancelLoading(false);
    }
  }
  const handleDayAnnotation = useCallback((dk: string) => { setDayAnnotCtx(dk); }, []);
  const handleDayMenu = useCallback((dk: string, rect: DOMRect) => {
    setDayMenuCtx({ dk, x: rect.left, y: rect.bottom + 4 });
  }, []);
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleOpenControl = useCallback(() => setControlOpen(true), []);
  const handleMonthDayClick = useCallback((dk: string) => {
    const d = new Date(dk + 'T00:00:00');
    setViewWk(weekKey(d));
    setView('week');
  }, []);

  function dayAnnotLabel(dk: string): string {
    const d = new Date(dk + 'T00:00:00');
    return `${d.getDate()} ${MN[d.getMonth()]} ${d.getFullYear()}`;
  }

  const closeDayAnnot = useCallback(() => setDayAnnotCtx(null), []);
  const closeBulkCancel = useCallback(() => { setShowBulkCancel(false); setBulkCancelInitial(null); }, []);
  const closeDayMenu = useCallback(() => setDayMenuCtx(null), []);
  const openBulkCancelForDay = useCallback((dateKey: string) => {
    setDayAnnotCtx(null);
    setDayMenuCtx(null);
    setBulkCancelInitial({ date: dateKey, label: dayAnnotLabel(dateKey) });
    setShowBulkCancel(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openDayAnnotFromMenu = useCallback((dateKey: string) => { setDayMenuCtx(null); setDayAnnotCtx(dateKey); }, []);
  const restoreDayFromMenu = useCallback((dateKey: string) => { setDayMenuCtx(null); handleRestoreDay(dateKey); }, []);

  async function handleRestoreDay(dateISO: string) {
    setRestoringDay(true);
    try {
      const res = await api.post('/schedule/sessions/bulk-restore', { date: dateISO });
      const restored: number = res.data?.data?.restored ?? 0;
      if (restored > 0) {
        toast.success(`Восстановлено занятий: ${restored}`);
        sched.loadWeekSessions(viewWk);
      } else {
        toast('Нет отменённых занятий для восстановления');
      }
    } catch {
      toast.error('Не удалось восстановить занятия');
    } finally {
      setRestoringDay(false);
    }
  }

  const inactiveBtn = 'px-3 py-1.5 text-sm font-medium border border-border rounded bg-white text-textPrimary hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-colors cursor-pointer select-none outline-none focus:outline-none';
  const viewOptions: Array<{ value: SchedView; label: string }> = [
    { value: 'week', label: 'По времени' },
    { value: 'rooms', label: 'По кабинетам' },
    { value: 'teacher', label: 'По учителям' },
    { value: 'group', label: 'По группам' },
    { value: 'month', label: 'Месяц' },
    { value: 'teacher-availability', label: 'Кто свободен' },
  ];

  const touchStartX = React.useRef(0);
  const touchStartY = React.useRef(0);

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (view === 'month') return;
    // On mobile (single-day layout), a swipe switches the day inside WeekGrid,
    // not the week. Only the laptop touchpad (wheel) changes weeks. lg = 1024px.
    if (window.innerWidth < 1024) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
    setViewWk(prev => addWeeks(prev, dx < 0 ? 1 : -1));
  }

  return (
    <div
      className="pb-20 lg:pb-0"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      {/* On mobile every day-based view folds these actions (gear / operational control)
          into the shared MobileDayBar, so the toolbar row is desktop-only there.
          Month / «кто свободен» have no day bar and keep it. */}
      <div className={`mb-3.5 space-y-2 ${view !== 'month' && view !== 'teacher-availability' ? 'hidden lg:block' : ''}`}>
        {/* Toolbar: Zoom (desktop) · week/month navigator (centered) · Settings (gear) · operational control.
            View and filters live inside the gear panel; the week/month stepper sits here on the main screen.
            On mobile week view (no toolbar) the stepper falls back to the gear panel. */}
        <div className="relative flex flex-wrap items-center gap-2">
          {view !== 'teacher-availability' && view !== 'month' && (
            <div className="hidden lg:flex items-center border border-border rounded bg-white overflow-hidden">
              <button onClick={() => sched.changeZoom(-10)} className="px-2.5 py-1.5 text-sm text-textPrimary hover:bg-surface transition-colors cursor-pointer border-r border-border">−</button>
              <ZoomInput zoom={sched.zoom} onChange={sched.setZoomTo} />
              <button onClick={() => sched.changeZoom(10)} className="px-2.5 py-1.5 text-sm text-textPrimary hover:bg-surface transition-colors cursor-pointer border-l border-border">+</button>
            </div>
          )}

          {/* RoomsView portals its expand / empty-slot controls in here (desktop) */}
          {view === 'rooms' && (
            <div ref={setRoomsToolbarEl} className="hidden lg:flex items-center gap-1.5" />
          )}

          <div className="flex-1" />

          {/* Week / month navigator — absolutely centered on the row so toolbar side
              content (zoom, rooms controls, gear) never shifts the label off-center */}
          {view !== 'teacher-availability' && (
            <div className="lg:absolute lg:left-1/2 lg:top-1/2 lg:-translate-x-1/2 lg:-translate-y-1/2 flex items-center gap-1.5">
              <button
                type="button"
                className={inactiveBtn}
                onClick={() =>
                  view === 'month'
                    ? setViewMonth(p => { const d = new Date(p.year, p.month - 1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })
                    : setViewWk(addWeeks(viewWk, -1))
                }
              >‹</button>
              <button
                type="button"
                title={view === 'month' ? 'Перейти к недельному виду' : 'Перейти к месячному виду'}
                onClick={() => {
                  persistView(view === 'month' ? 'week' : 'month');
                }}
                className={`min-w-[150px] rounded px-2 py-1.5 text-center text-sm font-semibold transition-colors hover:bg-surface ${view !== 'month' && isCurrentWk ? 'text-primary' : 'text-textPrimary'}`}
              >
                {view === 'month' ? `${MN[viewMonth.month]} ${viewMonth.year}` : weekLabel(viewWk)}
              </button>
              <button
                type="button"
                className={inactiveBtn}
                onClick={() =>
                  view === 'month'
                    ? setViewMonth(p => { const d = new Date(p.year, p.month + 1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })
                    : setViewWk(addWeeks(viewWk, 1))
                }
              >›</button>
            </div>
          )}

          {/* Spacer balances the centered navigator and pushes the controls right */}
          <div className="flex-1" />

          <div className="flex items-center gap-2 flex-shrink-0">
            {loading && <span className="text-xs text-textSecondary">Загрузка...</span>}

            {/* Gear opens the schedule controls (view / week / filters) */}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="relative h-9 w-9 flex items-center justify-center border border-border rounded bg-white text-textSecondary hover:text-textPrimary hover:bg-surface transition-colors cursor-pointer select-none outline-none focus:outline-none dark:bg-card"
              title="Настройки расписания"
            >
              <GearIcon />
              {hasActiveFilters && (
                <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-white dark:ring-card" />
              )}
            </button>

            {/* Operational Control */}
            <button
              type="button"
              onClick={() => setControlOpen(true)}
              className="relative h-9 w-9 flex items-center justify-center border border-border rounded bg-white text-textSecondary hover:text-textPrimary hover:bg-surface transition-colors cursor-pointer select-none outline-none focus:outline-none dark:bg-card"
              title="Операционный контроль"
            >
              <ActivityIcon />
              {(controlHasConflicts) && (
                <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-orange-500 ring-2 ring-white dark:ring-card" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── Views ───────────────────────────────────────────────────────────── */}
      {view === 'week' && (
        <WeekGrid
          sched={sched}
          viewWk={viewWk}
          zoom={sched.zoom}
          teacherFilter={teacherFilter}
          groupFilter={groupFilter}
          hasActiveFilters={hasActiveFilters}
          onResetFilters={resetFilters}
          onCellClick={handleCellClick}
          onDayAnnotation={handleDayAnnotation}
          onDayMenu={handleDayMenu}
          onZoomChange={sched.setZoomTo}
          onOpenSettings={handleOpenSettings}
          onOpenControl={handleOpenControl}
          hasControlAlerts={controlHasConflicts}
        />
      )}

      {view === 'month' && (
        <MonthView
          sched={sched}
          month={viewMonth}
          onDayClick={handleMonthDayClick}
          onDayAnnotation={handleDayAnnotation}
        />
      )}

      {view === 'rooms' && (
        <RoomsView
          sched={sched}
          viewWk={viewWk}
          teacherFilter={teacherFilter}
          groupFilter={groupFilter}
          cabinets={cabinets}
          schoolId={school?.id}
          hasActiveFilters={hasActiveFilters}
          onResetFilters={resetFilters}
          zoom={sched.zoom}
          onZoomChange={sched.setZoomTo}
          onCellClick={handleCellClick}
          onDayAnnotation={handleDayAnnotation}
          onDayMenu={handleDayMenu}
          toolbarSlot={roomsToolbarEl}
          hasControlAlerts={controlHasConflicts}
          onOpenSettings={handleOpenSettings}
          onOpenControl={handleOpenControl}
        />
      )}

      {view === 'teacher' && (
        <TeacherView
          sched={sched}
          viewWk={viewWk}
          groupFilter={groupFilter}
          schoolId={school?.id}
          hasActiveFilters={hasActiveFilters}
          onResetFilters={resetFilters}
          zoom={sched.zoom}
          onZoomChange={sched.setZoomTo}
          onCellClick={handleCellClick}
          onDayAnnotation={handleDayAnnotation}
          onDayMenu={handleDayMenu}
          hasControlAlerts={controlHasConflicts}
          onOpenSettings={handleOpenSettings}
          onOpenControl={handleOpenControl}
        />
      )}

      {view === 'group' && (
        <GroupView
          sched={sched}
          viewWk={viewWk}
          zoom={sched.zoom}
          timezone={tz}
          onCellClick={handleCellClick}
          onZoomChange={sched.setZoomTo}
          onDayAnnotation={handleDayAnnotation}
          onDayMenu={handleDayMenu}
          hasActiveFilters={hasActiveFilters}
          hasControlAlerts={controlHasConflicts}
          onOpenSettings={handleOpenSettings}
          onOpenControl={handleOpenControl}
        />
      )}

      {view === 'teacher-availability' && (
        <TeacherAvailabilityView
          teachers={teachers}
          sched={sched}
          tz={tz}
        />
      )}

      <ScheduleControlModal
        open={controlOpen}
        onOpenChange={setControlOpen}
        description={view === 'week' ? weekLabel(viewWk) : 'Текущая рабочая зона расписания'}
        auditRefreshKey={auditRefreshKey}
        onAction={handlePolicyConflictAction}
        onConflictState={setControlHasConflicts}
      />

      <ScheduleSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        view={view}
        persistView={persistView}
        viewOptions={viewOptions}
        isCurrentWk={isCurrentWk}
        weekLabelText={weekLabel(viewWk)}
        onPrevWeek={() => setViewWk(addWeeks(viewWk, -1))}
        onNextWeek={() => setViewWk(addWeeks(viewWk, 1))}
        onToday={() => setViewWk(weekKey(new Date()))}
        teacherFilter={teacherFilter}
        onTeacherFilterChange={setTeacherFilter}
        groupFilter={groupFilter}
        onGroupFilterChange={setGroupFilter}
        allTeachers={allTeachers}
        allGroups={allGroups}
        hasActiveFilters={hasActiveFilters}
        onResetFilters={resetFilters}
        inactiveBtnClass={inactiveBtn}
      />

      {/* ── Overlays ─────────────────────────────────────────────────────────── */}

      {slotPanel && (
        <Suspense fallback={null}>
        <SlotPanel
          key={slotPanel.policyOpenKey}
          sched={sched}
          ci={slotPanel.ci}
          sid={slotPanel.sid}
          viewWk={slotPanel.wk ?? viewWk}
          onClose={() => setSlotPanel(null)}
          teachers={teachers}
          cabinets={cabinets}
          onReload={slotPanel.editGroupCurrentDate ? refreshAfterPolicyAction : reloadSchedule}
          isHistoricalPolicy={slotPanel.policyHistorical ?? policyIsHistorical}
          showSlotAsLabel={slotPanel.fromRooms}
          roomName={slotPanel.roomName}
          selectedGid={slotPanel.gid}
          activeDays={slotPanel.policyActiveDays}
          policyTimeSlots={slotPanel.policyTimeSlots}
          policyConflictBlockId={slotPanel.policyConflictBlockId}
          focusGroupOnly={slotPanel.focusGroupOnly}
          initialCreateMode={slotPanel.initialCreate}
          initialEditGroupId={slotPanel.initialEditGroupId}
          editGroupCurrentDate={slotPanel.editGroupCurrentDate}
        />
        </Suspense>
      )}

      <CancelDialog
        open={!!policyCancelAction}
        isCancelled={false}
        onOneTime={handlePolicyCancelOneTime}
        onRestore={() => {}}
        onClose={() => {
          if (!policyCancelLoading) setPolicyCancelAction(null);
        }}
      />

      {policyEditSession && (
        <EditSessionPanel
          group={policyEditSession.group}
          ci={policyEditSession.ci}
          wk={policyEditSession.wk}
          teachers={teachers}
          cabinets={cabinets}
          slotStart={policyEditSession.slotStart}
          slotEnd={policyEditSession.slotEnd}
          sessionMeta={sched.weekSessions[sessionKey(policyEditSession.action.blockId, policyEditSession.action.date)] ?? null}
          onDone={() => {
            setPolicyEditSession(null);
            void refreshAfterPolicyAction();
          }}
          onClose={() => setPolicyEditSession(null)}
          onReload={refreshAfterPolicyAction}
          onSessionUpdated={sched.updateWeekSession}
          onSessionCancelled={sched.markSessionCancelled}
        />
      )}

      <ScheduleDayOverlays
        sched={sched}
        tz={tz}
        viewWk={viewWk}
        policyIsHistorical={policyIsHistorical}
        formatDayLabel={dayAnnotLabel}
        dayAnnotCtx={dayAnnotCtx}
        restoringDay={restoringDay}
        onCloseDayAnnot={closeDayAnnot}
        onCancelDay={openBulkCancelForDay}
        onRestoreDay={handleRestoreDay}
        showBulkCancel={showBulkCancel}
        bulkCancelInitial={bulkCancelInitial}
        onCloseBulkCancel={closeBulkCancel}
        dayMenuCtx={dayMenuCtx}
        onCloseDayMenu={closeDayMenu}
        onDayMenuNote={openDayAnnotFromMenu}
        onDayMenuCancel={openBulkCancelForDay}
        onDayMenuRestore={restoreDayFromMenu}
      />
    </div>
  );
}
