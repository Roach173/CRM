import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type { UseSchedule } from '../../hooks/useSchedule';
import { weekDatesInTz } from '../../lib/tzUtils';
import api from '../../lib/api';
import type { SchedGroup } from './scheduleTypes';
import { lessonBlockIdForDay } from './scheduleTypes';
import { fmtPaidUntil } from '../../hooks/schedule/scheduleBlockMerge';
import { type AttendanceActor, dbStatusToTa, formatAttendanceActor, formatAttendanceDateTime } from './GroupRowBadges';

const SAVE_TIMEOUT_MS = 30000;

type AttendanceApiRow = {
  studentProfileId: number;
  status: unknown;
  creditDeducted?: boolean;
};

export type AttendanceReadModel = {
  attendanceFinalizedAt?: string | null;
  attendanceFinalizedById?: number | null;
  attendanceFinalizedBy?: AttendanceActor;
  attendanceReopenedAt?: string | null;
  attendanceReopenedById?: number | null;
  attendanceReopenedBy?: AttendanceActor;
  attendanceReopenReason?: string | null;
  canEditAttendance?: boolean;
  canReopenAttendance?: boolean;
};

interface UseGroupRowActionsArgs {
  group: SchedGroup;
  ci: number;
  wk: string;
  tz: string;
  sched: UseSchedule;
  expanded: boolean;
  isTeacher?: boolean;
  onReload?: () => void;
}

// Attendance data-loading + attendance/cancel/lifecycle API handlers for GroupRow,
// extracted so the component's render/JSX isn't interleaved with ~15 async actions.
// Derived render-only flags (attendanceModel, backendCanEditAttendance, etc.) stay in
// GroupRow itself — that derivation has a known stale-snapshot-shadowing pitfall
// (see GroupRow.tsx) and is deliberately not touched here.
export function useGroupRowActions({ group, ci, wk, tz, sched, expanded, isTeacher = false, onReload }: UseGroupRowActionsArgs) {
  const [cancelLoading, setCancelLoading] = useState(false);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleConfirm, setLifecycleConfirm] = useState<{
    message: string; confirmLabel: string; onConfirm: () => void;
  } | null>(null);

  const [attSaving, setAttSaving] = useState(false);
  const [attLoading, setAttLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
  const [submittedInfo, setSubmittedInfo] = useState<{ name: string; at: string } | null>(null);
  const [attendanceReadModel, setAttendanceReadModel] = useState<AttendanceReadModel | null>(null);
  const [submittedStudentIds, setSubmittedStudentIds] = useState<Set<number>>(new Set());
  // Legacy: studentProfileIds with a FROZEN attendance row for THIS session. New records
  // no longer store FROZEN (a paused student keeps the admin's present/absent mark), so
  // this only lights the «на паузе» badge for older rows. Current pause state (st==='ho')
  // is the primary badge driver — see showPaused in GroupRow.
  const [frozenStudentIds, setFrozenStudentIds] = useState<Set<number>>(new Set());
  const [reopenLoading, setReopenLoading] = useState(false);
  const [partialErrors, setPartialErrors] = useState<Array<{ studentProfileId: number; error: string }>>([]);

  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelSessionId, setCancelSessionId] = useState<number | null>(null);
  const [cancelSessionVersion, setCancelSessionVersion] = useState(0);
  const [cancelSessionIsCancelled, setCancelSessionIsCancelled] = useState(false);

  // Key tracks which (wk, ci, group) was last loaded — prevents stale data when week/day changes
  const attLoadedKeyRef = useRef<string | null>(null);
  const creditDeductedStudentIds = useRef<Set<number>>(new Set());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const applyAttendanceReadModel = useCallback((session: AttendanceReadModel | null | undefined, blockId: number, sessionDate: string) => {
    if (!session) {
      setAttendanceReadModel(null);
      setSubmittedInfo(null);
      return;
    }

    const next: AttendanceReadModel = {
      attendanceFinalizedAt: session.attendanceFinalizedAt ?? null,
      attendanceFinalizedById: session.attendanceFinalizedById ?? null,
      attendanceFinalizedBy: session.attendanceFinalizedBy ?? null,
      attendanceReopenedAt: session.attendanceReopenedAt ?? null,
      attendanceReopenedById: session.attendanceReopenedById ?? null,
      attendanceReopenedBy: session.attendanceReopenedBy ?? null,
      attendanceReopenReason: session.attendanceReopenReason ?? null,
      canEditAttendance: session.canEditAttendance === true,
      canReopenAttendance: session.canReopenAttendance === true,
    };

    setAttendanceReadModel(next);
    sched.updateWeekSession?.(blockId, sessionDate, next);

    if (next.attendanceFinalizedAt) {
      const name = formatAttendanceActor(next.attendanceFinalizedBy, next.attendanceFinalizedById);
      const at = formatAttendanceDateTime(next.attendanceFinalizedAt);
      setSubmittedInfo(name || at ? { name: name || '—', at } : null);
    } else {
      setSubmittedInfo(null);
    }
  }, [sched]);

  const applyAttendanceRows = useCallback((rows: AttendanceApiRow[]) => {
    const nextSubmitted = new Set<number>();
    const nextCreditDeductedStudentIds = new Set<number>();
    const nextFrozen = new Set<number>();

    for (const att of rows) {
      nextSubmitted.add(att.studentProfileId);
      if (att.creditDeducted) {
        nextCreditDeductedStudentIds.add(att.studentProfileId);
      }
      if (att.status === 'FROZEN') {
        nextFrozen.add(att.studentProfileId);
      }
      sched.updateStudent(group.id, att.studentProfileId, { ta: dbStatusToTa(att.status) });
    }

    creditDeductedStudentIds.current = nextCreditDeductedStudentIds;
    setSubmittedStudentIds(nextSubmitted);
    setFrozenStudentIds(nextFrozen);
  }, [group.id, sched]);

  const resetCurrentAttendanceMarks = useCallback(() => {
    for (const stu of group.stu) {
      if (stu.ta !== null) {
        sched.updateStudent(group.id, stu.id, { ta: null });
      }
    }
  }, [group.id, group.stu, sched]);

  // Fetches /session/for-date and applies attendance statuses to G.
  // Used both by the expand effect (initial load) and explicitly after
  // submit/reopen (called AFTER await onReload so loadFromServer has completed).
  // preserveMarks=true keeps current optimistic state on screen while the fetch
  // is in flight (no flash to «Не отмечен»); the response still overwrites it
  // with server truth. Use false when the day/group actually changed.
  const loadAttendanceForCurrentRow = useCallback(async (preserveMarks = false) => {
    const dateISO = weekDatesInTz(wk, tz)[ci];
    const blockId = lessonBlockIdForDay(group, ci);

    if (!preserveMarks) {
      setCurrentSessionId(null);
      setSubmittedInfo(null);
      setAttendanceReadModel(null);
      setSubmittedStudentIds(new Set());
      setFrozenStudentIds(new Set());
      setPartialErrors([]);
      creditDeductedStudentIds.current = new Set();
      resetCurrentAttendanceMarks();
      setAttLoading(true);
    }

    try {
      const res = await api.get('/schedule/session/for-date', {
        params: { lessonBlockId: blockId, date: dateISO },
      });
      if (!mountedRef.current) return;
      const { session, attendances } = res.data.data;
      setCurrentSessionId(session ? session.id : null);
      if (session?.status && blockId && dateISO) {
        sched.updateSessionStatus(blockId, dateISO, session.status);
      }
      applyAttendanceReadModel(session, blockId, dateISO);
      if (attendances && attendances.length > 0) {
        applyAttendanceRows(attendances as AttendanceApiRow[]);
      } else {
        setSubmittedStudentIds(new Set());
        setFrozenStudentIds(new Set());
        creditDeductedStudentIds.current = new Set();
        resetCurrentAttendanceMarks();
      }
    } catch {
    } finally {
      if (mountedRef.current) setAttLoading(false);
    }
  }, [applyAttendanceReadModel, applyAttendanceRows, ci, group, resetCurrentAttendanceMarks, sched, tz, wk]);

  useEffect(() => {
    const attKey = `${wk}_${ci}_${group.id}`;
    if (!expanded || attLoadedKeyRef.current === attKey) return;
    attLoadedKeyRef.current = attKey;
    loadAttendanceForCurrentRow();
  }, [expanded, ci, group.clubDays, group.id, group.linkedIds, sched, wk, loadAttendanceForCurrentRow]);

  async function openCancelDialog() {
    setCancelLoading(true);
    try {
      const blockId = lessonBlockIdForDay(group, ci);
      const lessonDate = weekDatesInTz(wk, tz)[ci];
      const res = await api.post('/schedule/session/ensure', { lessonBlockId: blockId, date: lessonDate });
      const session = res.data.data;
      setCancelSessionId(session.id);
      setCancelSessionVersion(session.version ?? 0);
      setCancelSessionIsCancelled(session.status === 'CANCELLED');
      setShowCancelDialog(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.error ?? 'Не удалось загрузить занятие');
    } finally {
      setCancelLoading(false);
    }
  }

  function triggerLifecycle(message: string, confirmLabel: string, action: () => Promise<void>) {
    setLifecycleConfirm({
      message,
      confirmLabel,
      onConfirm: () => {
        setLifecycleConfirm(null);
        setLifecycleLoading(true);
        action()
          .then(() => setLifecycleLoading(false))
          .catch((e: any) => {
            toast.error(e?.response?.data?.error ?? 'Ошибка операции');
            setLifecycleLoading(false);
          });
      },
    });
  }

  function handlePauseGroup() {
    if (!group.studentGroupId) return;
    triggerLifecycle(
      'Поставить группу на паузу? Новые занятия не будут генерироваться, посещаемость будет недоступна.',
      'Поставить на паузу',
      async () => {
        await api.post(`/groups/${group.studentGroupId}/lifecycle/pause`);
        toast.success('Группа поставлена на паузу');
        onReload?.();
      },
    );
  }

  function handleResumeGroup() {
    if (!group.studentGroupId) return;
    triggerLifecycle(
      'Возобновить группу? Будущие занятия снова будут генерироваться.',
      'Возобновить',
      async () => {
        await api.post(`/groups/${group.studentGroupId}/lifecycle/resume`);
        toast.success('Группа возобновлена');
        onReload?.();
      },
    );
  }

  function handleStandaloneComplete() {
    const blockId = lessonBlockIdForDay(group, ci);
    const fromDate = weekDatesInTz(wk, tz)[ci];
    triggerLifecycle(
      'Завершить группу с этой даты? Будущие занятия будут скрыты, финансово защищённые занятия не изменятся.',
      'Завершить группу',
      async () => {
        await api.post(`/schedule/blocks/${blockId}/complete-group`, { fromDate });
        toast.success('Группа завершена');
        onReload?.();
      },
    );
  }

  async function handleCancelOneTime(reason: string) {
    if (!cancelSessionId) return;
    setCancelLoading(true);
    try {
      await api.patch(`/schedule/session/${cancelSessionId}/status`, { status: 'CANCELLED', version: cancelSessionVersion, reason });
      const lessonDate = weekDatesInTz(wk, tz)[ci];
      sched.markSessionCancelled?.(lessonBlockIdForDay(group, ci), lessonDate, true);
      toast.success('Занятие отменено');
      setShowCancelDialog(false);
      onReload?.();
    } catch (e: any) {
      const errMsg: string = e?.response?.data?.error ?? '';
      if (errMsg === 'Group is paused. Resume it before performing this action.') {
        toast.error('Группа на паузе — сначала возобновите группу');
      } else if (errMsg === 'SESSION_LOCKED' || errMsg === 'LOCKED') {
        toast.error('Занятие зафиксировано — отмена недоступна');
      } else {
        toast.error(errMsg || 'Ошибка отмены');
      }
    } finally {
      setCancelLoading(false);
    }
  }

  async function handleRestore() {
    if (!cancelSessionId) return;
    setCancelLoading(true);
    try {
      await api.patch(`/schedule/session/${cancelSessionId}/status`, { status: 'UPCOMING', version: cancelSessionVersion });
      const lessonDate = weekDatesInTz(wk, tz)[ci];
      sched.markSessionCancelled?.(lessonBlockIdForDay(group, ci), lessonDate, false);
      toast.success('Занятие восстановлено');
      setShowCancelDialog(false);
      onReload?.();
    } catch (e: any) {
      const errCode = e?.response?.data?.error;
      if (errCode === 'SESSION_HAS_DEDUCTED_CREDITS' || errCode === 'RESTORE_BLOCKED_IF_DEDUCTED_CREDITS' || errCode === 'SESSION_HAS_FINANCIAL_DATA') {
        toast.error('Нельзя восстановить урок: по нему уже есть финансовые операции. Сначала нужна корректировка кредитов.');
      } else if (errCode === 'GROUP_ARCHIVED') {
        toast.error('Группа архивирована. Действие недоступно.');
      } else {
        toast.error(errCode ?? 'Ошибка восстановления');
      }
    } finally {
      setCancelLoading(false);
    }
  }

  async function handleRestoreInvalidated() {
    setCancelLoading(true);
    try {
      const blockId = lessonBlockIdForDay(group, ci);
      const lessonDate = weekDatesInTz(wk, tz)[ci];
      const ensureRes = await api.post('/schedule/session/ensure', { lessonBlockId: blockId, date: lessonDate });
      const session = ensureRes.data.data;

      if (!session?.id) {
        toast.error('Не удалось найти аннулированный урок');
        return;
      }
      if (session.status !== 'INVALIDATED') {
        sched.updateSessionStatus(blockId, lessonDate, session.status ?? 'UPCOMING');
        toast.success('Урок уже восстановлен');
        onReload?.();
        return;
      }

      await api.patch(`/schedule/session/${session.id}/status`, { status: 'UPCOMING', version: session.version });
      sched.updateSessionStatus(blockId, lessonDate, 'UPCOMING');
      sched.markSessionCancelled?.(blockId, lessonDate, false);
      toast.success('Аннулированный урок восстановлен');
      onReload?.();
    } catch (e: any) {
      const errCode = e?.response?.data?.error;
      if (e?.response?.status === 403) {
        toast.error('Восстановить аннулированный урок может только владелец');
      } else if (errCode === 'STALE_DATA') {
        toast.error('Данные урока устарели. Обновите расписание и попробуйте снова.');
      } else if (errCode === 'SESSION_HAS_FINANCIAL_DATA' || errCode === 'SESSION_HAS_ATTENDANCE') {
        toast.error('Нельзя восстановить: у урока уже есть финансовые записи или посещаемость');
      } else if (errCode === 'ACTIVE_MAKEUP_EXISTS') {
        toast.error('Нельзя восстановить: уже есть активный дополнительный урок');
      } else {
        toast.error(errCode ?? 'Не удалось восстановить урок');
      }
    } finally {
      setCancelLoading(false);
    }
  }

  async function handleSubmitAttendance(canEditAttendanceNow: boolean, unmarkedCount: number) {
    if (attSaving) return;
    if (!canEditAttendanceNow) {
      toast.error('Посещаемость сейчас недоступна для редактирования');
      return;
    }

    // Guard: block submission if any student is not explicitly marked
    if (unmarkedCount > 0) {
      toast.error(`Отметьте всех студентов: осталось ${unmarkedCount}`);
      return;
    }

    const dateISO = weekDatesInTz(wk, tz)[ci];
    const blockId = lessonBlockIdForDay(group, ci);
    // Only send explicitly marked students — ta === null is never sent as ABSENT
    const data = group.stu
      .filter(s => s.ta !== null)
      .map(s => ({
        studentProfileId: s.id,
        status: s.ta === 'pr' ? 'PRESENT' : 'ABSENT',
      }));

    if (data.length === 0) {
      toast.error('В группе нет студентов — добавьте студентов перед сдачей посещаемости');
      return;
    }

    setAttSaving(true);
    setPartialErrors([]);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await api.post('/schedule/session/submit-attendance', {
        lessonBlockId: blockId,
        date: dateISO,
        attendances: data,
      }, { timeout: SAVE_TIMEOUT_MS, headers: { 'Idempotency-Key': idempotencyKey } });
      const responseData = res.data.data ?? {};
      const { saved, errors: attErrors, sessionId: returnedSessionId, balances } = responseData;
      if (!mountedRef.current) return;
      if (returnedSessionId) setCurrentSessionId(returnedSessionId);
      // Reflect the new (possibly negative) credit balance immediately — no reload needed.
      if (Array.isArray(balances)) {
        for (const b of balances as Array<{ studentProfileId: number; credits: number; paidUntil?: string | null }>) {
          // Only touch pd when the server actually sent paidUntil. An absent field
          // (undefined) means "unknown here" — blanking the whole roster's date on a
          // response that omits it (mirrors the correction path's guard below).
          sched.updateStudent(group.id, b.studentProfileId, {
            cr: b.credits,
            ...(b.paidUntil !== undefined ? { pd: fmtPaidUntil(b.paidUntil) } : {}),
          });
        }
      }
      const failedStudentIds = new Set((attErrors ?? []).map((err: { studentProfileId: number }) => err.studentProfileId));
      applyAttendanceRows(data.filter(att => !failedStudentIds.has(att.studentProfileId)));
      applyAttendanceReadModel(responseData, blockId, dateISO);
      if (attErrors?.length > 0) {
        setPartialErrors(attErrors);
        toast.error(`Сдано ${saved ?? 0} из ${data.length}, ошибок: ${attErrors.length}`);
      } else {
        toast.success('Посещаемость сдана');
      }

      // The submit itself is done — release the button now. What follows is a
      // background consistency pass. Submit changes nothing structural, so a
      // full schedule reload (policy + all blocks + cabinets) is NOT needed —
      // week-scoped session read models cover the grid (finalized badges,
      // session statuses), and attendance rows are re-fetched below past the
      // expand-effect guard (attLoadedKeyRef) — same dance as reopen.
      setAttSaving(false);
      // GET /schedule/sessions/week returns the whole school's week (every group,
      // every teacher) and requires schedule:write — TEACHER only has session:write /
      // attendance:write, so this always 403ed for teachers (silently, but still
      // logged as PERMISSION_DENIED on every attendance submit). This row's own status
      // is refreshed below via /session/for-date (schedule:read), which is enough.
      if (!isTeacher) await sched.loadWeekSessions(wk);
      if (!mountedRef.current) return;
      attLoadedKeyRef.current = null;
      await loadAttendanceForCurrentRow(true);
      if (mountedRef.current) attLoadedKeyRef.current = `${wk}_${ci}_${group.id}`;
    } catch (err: any) {
      if (err.code === 'ECONNABORTED') {
        toast.error('Сервер слишком долго сохраняет посещаемость. Проверьте backend и попробуйте еще раз.');
        return;
      }
      if (!mountedRef.current) return;
      const errCode = err.response?.data?.code ?? err.response?.data?.error;
      if (errCode === 'ATTENDANCE_INCOMPLETE') {
        const missing = err.response?.data?.missingCount ?? unmarkedCount;
        toast.error(`Отметьте всех студентов: осталось ${missing}`);
        return;
      }
      if (errCode === 'SESSION_NOT_SUBMITTABLE') {
        toast.error('Посещаемость доступна только для урока в статусе «Идёт сейчас» или «Проведён».');
        return;
      }
      if (errCode === 'GROUP_ARCHIVED') {
        toast.error('Группа архивирована. Действие недоступно.');
        return;
      }
      toast.error(errCode || 'Ошибка сохранения');
    } finally {
      if (mountedRef.current) setAttSaving(false);
    }
  }

  // Save edits to an already-finalized session: silently reopen (no reason), then
  // re-run the normal batch submit against the current DRAFT marks. Two calls, but
  // credit-safe — markAttendance's creditDeducted flag is write-once, so re-submitting
  // is idempotent (no double deduction). handleSubmitAttendance owns the reload + toast.
  async function reopenThenSubmit(unmarkedCount: number) {
    if (!currentSessionId || attSaving || reopenLoading) return;
    setReopenLoading(true);
    try {
      await api.post(`/schedule/session/${currentSessionId}/attendance/reopen`,
        {},
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      );
    } catch (err: any) {
      // ATTENDANCE_NOT_FINALIZED = already reopened (e.g. a retry after submit failed) —
      // fall through and submit. Any other error is real: surface it and stop.
      if (err.response?.data?.code !== 'ATTENDANCE_NOT_FINALIZED') {
        if (mountedRef.current) setReopenLoading(false);
        toast.error(err.response?.data?.error ?? 'Не удалось сохранить изменения');
        return;
      }
    }
    if (!mountedRef.current) return;
    setReopenLoading(false);
    await handleSubmitAttendance(true, unmarkedCount);
  }

  return {
    // Attendance state
    attSaving, attLoading, currentSessionId, submittedInfo, attendanceReadModel, submittedStudentIds, frozenStudentIds,
    partialErrors, creditDeductedStudentIds,
    // Reopen
    reopenLoading,
    // Cancel dialog
    showCancelDialog, setShowCancelDialog, cancelSessionId, cancelSessionVersion, cancelSessionIsCancelled, cancelLoading,
    // Lifecycle
    lifecycleLoading, lifecycleConfirm, setLifecycleConfirm,
    // Handlers
    openCancelDialog, handlePauseGroup, handleResumeGroup, handleStandaloneComplete,
    handleCancelOneTime, handleRestore, handleRestoreInvalidated,
    handleSubmitAttendance, reopenThenSubmit,
  };
}
