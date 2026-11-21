import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { History } from 'lucide-react';
import toast from 'react-hot-toast';
import type { SchedGroup } from './scheduleTypes';
import { lessonBlockIdForDay, grammarBlockIdOf, relatedBlockIdsOf } from './scheduleTypes';
import api from '../../lib/api';
import { useAuth } from '../../hooks/useAuth';
import { weekDatesInTz, dateInTz } from '../../lib/tzUtils';
import { ConflictWarningModal } from './ConflictWarningModal';
import { C } from './scheduleTheme';
import CancelDialog from './CancelDialog';
import type { WeekSessionMeta } from '../../hooks/useSchedule';
import {
  canSubmitLessonStatus,
  isReadOnlyLessonStatus,
  lessonStatusOptionsFor,
  statusTransitionHelper,
} from './sessionStatusUx';
import {
  findCabinetConflicts,
  findTeacherConflicts,
  findStudentGroupConflicts,
  getConflictSeverity,
  type ScheduleConflict,
} from '../../utils/scheduleConflicts';
import ConflictList, { teacherCardPath } from './ConflictList';
import { formatSessionDate } from '../../utils/scheduleUtils';
import { EditSessionChangeLog } from './EditSessionChangeLog';
import { EditSessionTeacherReasonField } from './EditSessionTeacherReasonField';
import { EditSessionStatusField } from './EditSessionStatusField';
import { EditSessionMakeupSection } from './EditSessionMakeupSection';
import { EditSessionFooterActions } from './EditSessionFooterActions';

type Teacher = { id: number; firstName: string; lastName: string };
type Cabinet = { id: number; name: string; capacity: number };
type TimeSlotOption = { id: number; s: string; e: string };
const SAVE_TIMEOUT_MS = 30000;

function getTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

interface Props {
  group: SchedGroup;
  ci: number;
  wk: string;
  teachers: Teacher[];
  cabinets: Cabinet[];
  slotStart?: string;
  slotEnd?: string;
  sessionMeta?: WeekSessionMeta | null;
  timeSlots?: TimeSlotOption[];
  schedGroups?: Record<string, SchedGroup>;
  onDone: () => void;
  onClose: () => void;
  onReload?: () => void;
  onSessionUpdated?: (blockId: number, dateISO: string, data: {
    subTeacherId?: number;
    subTeacherName?: string;
    startTimeSnap?: string | null;
    endTimeSnap?: string | null;
    cabinetIdSnap?: number | null;
  }) => void;
  onSessionCancelled?: (blockId: number, dateISO: string, cancelled: boolean) => void;
}

export default function EditSessionPanel({
  group, ci, wk, teachers, cabinets, slotStart = '', slotEnd = '',
  sessionMeta = null, timeSlots, schedGroups,
  onDone, onClose, onReload, onSessionUpdated, onSessionCancelled,
}: Props) {
  const { school } = useAuth();
  const tz = school?.timezone ?? 'Asia/Bishkek';
  const isClubDay = group.clubDays.includes(ci);
  // When a Grammar session is moved to a Club day at a different time, slotStart
  // will match the Grammar block's time, not the Club block's time. In that case,
  // load the Grammar session (not Club) so the user edits the correct session.
  const grammarSlotTime = (group.grammarStartTime ?? group.startTime ?? '').slice(0, 5);
  const clubSlotTime = (group.clubStartTime ?? group.startTime ?? '').slice(0, 5);
  const slotStartTime = slotStart.slice(0, 5);
  const slotIsMovedGrammar = isClubDay
    && Boolean(slotStartTime) && Boolean(grammarSlotTime) && Boolean(clubSlotTime)
    && slotStartTime === grammarSlotTime && slotStartTime !== clubSlotTime;
  const blockId = slotIsMovedGrammar ? grammarBlockIdOf(group) : lessonBlockIdForDay(group, ci);
  const mainTeacher = slotIsMovedGrammar ? group.tg : (isClubDay ? group.tk : group.tg);
  const lessonDate = weekDatesInTz(wk, tz)[ci];

  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionVersion, setSessionVersion] = useState<number>(0);
  const [status, setStatus] = useState('UPCOMING');
  const isLocked = status === 'LOCKED';
  const [subTeacherId, setSubTeacherId] = useState('');
  const [moveTeacherId, setMoveTeacherId] = useState(''); // teacher for the moved session (User.id, '' = use block teacher)
  const [cabinetId, setCabinetId] = useState('');
  const [sessionStartTime, setSessionStartTime] = useState('');
  const [sessionEndTime, setSessionEndTime] = useState('');

  // Slot dropdown
  const [selectedSlotId, setSelectedSlotId] = useState(0);
  const [selectedSlotStart, setSelectedSlotStart] = useState('');
  const [selectedSlotEnd, setSelectedSlotEnd] = useState('');

  // Date (for moving to a different day)
  const [selectedDate, setSelectedDate] = useState(lessonDate);
  const [dateChangeReason, setDateChangeReason] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [showMakeup, setShowMakeup] = useState(false);
  const [makeupDate, setMakeupDate] = useState('');
  const [makeupReason, setMakeupReason] = useState('');
  const [makeupSaving, setMakeupSaving] = useState(false);
  const [teacherReplaceReason, setTeacherReplaceReason] = useState('');
  const [conflictWarning, setConflictWarning] = useState<{ message: string; confirmLabel?: string; onConfirm: () => void; extraAction?: { label: string; onClick: () => void } } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const initialSessionRef = useRef<{
    teacherId: string;
    status: string;
    cabinetId: string;
  } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const inp: React.CSSProperties = {
    width: '100%', fontSize: 12, padding: '5px 8px',
    border: `1px solid ${C.border}`, borderRadius: 6,
    background: C.bg, color: C.text, boxSizing: 'border-box', outline: 'none',
  };
  const lbl: React.CSSProperties = { fontSize: 11, color: C.mid, display: 'block', marginBottom: 3 };
  const makeupReasonTrimmed = makeupReason.trim();
  const canCreateMakeup = Boolean(makeupDate) && makeupReasonTrimmed.length >= 5 && !makeupSaving;
  const showMakeupReasonError = showMakeup && makeupReasonTrimmed.length < 5;

  const teacherChanged = Boolean(initialSessionRef.current) && subTeacherId !== initialSessionRef.current!.teacherId;
  const teacherReasonTrimmed = teacherReplaceReason.trim();
  const teacherReasonInvalid = teacherChanged && teacherReasonTrimmed.length < 5;
  const savedStatus = initialSessionRef.current?.status ?? status;
  const statusOptions = lessonStatusOptionsFor(savedStatus);
  const statusHelper = statusTransitionHelper(savedStatus);
  const statusReadOnly = isReadOnlyLessonStatus(savedStatus);

  // Date change
  const dateChanged = selectedDate !== lessonDate;
  const dateReasonTrimmed = dateChangeReason.trim();
  const dateReasonInvalid = dateChanged && dateReasonTrimmed.length < 5;

  // Effective current session times (snap override if present, else block default)
  const effectiveCurrentStart = sessionStartTime || slotStart;
  const effectiveCurrentEnd = sessionEndTime || slotEnd;

  // Whether policy slots are available
  const hasTimeSlots = !!(timeSlots && timeSlots.length > 0);

  // When current session time doesn't match any policy slot, user must pick one
  const isSlotOutsidePolicy = hasTimeSlots && selectedSlotId === 0;
  const slotMustBeSelected = isSlotOutsidePolicy;

  // Detect if selected slot differs from current session times
  const slotTimeChanged = hasTimeSlots && selectedSlotId > 0 && !dateChanged && (
    selectedSlotStart.slice(0, 5) !== effectiveCurrentStart.slice(0, 5) ||
    selectedSlotEnd.slice(0, 5) !== effectiveCurrentEnd.slice(0, 5)
  );

  // Conflict preview — only when a valid slot is selected, not moving date, and schedGroups available
  const excludeBlockIds = useMemo(() => relatedBlockIdsOf(group), [group]);
  const conflictDateOptions = useMemo(() => ({ targetStartDate: lessonDate }), [lessonDate]);
  const showConflictPreview = hasTimeSlots && selectedSlotId > 0 && !dateChanged && !!schedGroups;

  const cabinetConflicts = useMemo((): ScheduleConflict[] => {
    if (!showConflictPreview || !cabinetId) return [];
    const cid = parseInt(cabinetId);
    if (!cid) return [];
    return findCabinetConflicts(cid, [ci], selectedSlotStart, selectedSlotEnd, schedGroups!, excludeBlockIds, conflictDateOptions);
  }, [showConflictPreview, cabinetId, ci, selectedSlotStart, selectedSlotEnd, schedGroups, excludeBlockIds, conflictDateOptions]);

  const teacherConflicts = useMemo((): ScheduleConflict[] => {
    if (!showConflictPreview || !subTeacherId) return [];
    const tid = parseInt(subTeacherId);
    if (!tid) return [];
    return findTeacherConflicts(tid, [ci], selectedSlotStart, selectedSlotEnd, schedGroups!, excludeBlockIds, conflictDateOptions)
      .filter(c => c.severity === 'critical');
  }, [showConflictPreview, subTeacherId, ci, selectedSlotStart, selectedSlotEnd, schedGroups, excludeBlockIds, conflictDateOptions]);

  const studentGroupConflicts = useMemo((): ScheduleConflict[] => {
    if (!showConflictPreview || !group.studentGroupId) return [];
    return findStudentGroupConflicts(group.studentGroupId, [ci], selectedSlotStart, selectedSlotEnd, schedGroups!, excludeBlockIds, conflictDateOptions);
  }, [showConflictPreview, group.studentGroupId, ci, selectedSlotStart, selectedSlotEnd, schedGroups, excludeBlockIds, conflictDateOptions]);

  const slotConflicts = useMemo(
    () => [...cabinetConflicts, ...teacherConflicts, ...studentGroupConflicts],
    [cabinetConflicts, teacherConflicts, studentGroupConflicts],
  );
  const slotHasCritical = showConflictPreview && getConflictSeverity(slotConflicts) === 'critical';

  useEffect(() => {
    api.post('/schedule/session/ensure', { lessonBlockId: blockId, date: lessonDate })
      .then(res => {
        const s = res.data.data;
        const teacherId = s.teacher?.id ? String(s.teacher.id) : '';
        const nextStatus = s.status ?? 'UPCOMING';
        const nextCabinetId = String(s.cabinetIdSnap ?? group.cabinetId ?? '');
        const nextStartTime = s.startTimeSnap ?? '';
        const nextEndTime = s.endTimeSnap ?? '';
        setSessionId(s.id);
        setSessionVersion(s.version ?? 0);
        setStatus(nextStatus);
        setSubTeacherId(teacherId);
        setCabinetId(nextCabinetId);
        setSessionStartTime(nextStartTime);
        setSessionEndTime(nextEndTime);
        initialSessionRef.current = {
          teacherId,
          status: nextStatus,
          cabinetId: nextCabinetId,
        };

        // Init slot dropdown to match current effective session time
        if (timeSlots && timeSlots.length > 0) {
          const effStart = (nextStartTime || slotStart).slice(0, 5);
          const effEnd = (nextEndTime || slotEnd).slice(0, 5);
          const match = timeSlots.find(sl => sl.s.slice(0, 5) === effStart && sl.e.slice(0, 5) === effEnd);
          if (match) {
            setSelectedSlotId(match.id);
            setSelectedSlotStart(match.s);
            setSelectedSlotEnd(match.e);
          }
          // else stays at 0 → slotMustBeSelected = true
        }
      })
      .catch((err) => setError(err.response?.data?.error ?? 'Не удалось загрузить урок'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchLogs = useCallback(async () => {
    if (!sessionId) return;
    setLoadingLogs(true);
    try {
      const res = await api.get(`/schedule/session/${sessionId}/logs`);
      setLogs(res.data.data);
    } catch (e) {
      console.error(e);
      toast.error('Ошибка загрузки логов');
    } finally {
      setLoadingLogs(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (showLogs) fetchLogs();
  }, [showLogs, fetchLogs]);

  useEffect(() => {
    if (!teacherChanged) setTeacherReplaceReason('');
  }, [teacherChanged]);

  // Reset move-specific fields when date is restored to original
  useEffect(() => {
    if (!dateChanged) {
      setDateChangeReason('');
      setMoveTeacherId('');
    }
  }, [dateChanged]);

  async function createMakeup() {
    if (!sessionId || !makeupDate) return;
    if (sessionMeta?.makeupSession) {
      toast.error('Доп. урок уже существует для этого занятия');
      return;
    }
    if (makeupReasonTrimmed.length < 5) {
      toast.error('Укажите причину не менее 5 символов');
      return;
    }
    setMakeupSaving(true);
    try {
      await api.post(`/schedule/session/${sessionId}/makeup`, { date: makeupDate, reason: makeupReasonTrimmed });
      if (!mountedRef.current) return;
      toast.success('Доп. урок создан');
      setShowMakeup(false);
      setMakeupDate('');
      setMakeupReason('');
      onReload?.();
    } catch (e: any) {
      if (!mountedRef.current) return;
      const errorCode = e?.response?.data?.error;
      if (e?.response?.status === 409 && errorCode === 'MAKEUP_ALREADY_EXISTS') {
        toast.error('Доп. урок уже существует для этого занятия');
      } else if (errorCode === 'MAKEUP_LOCKED_SESSION') {
        toast.error('Нельзя создать доп. урок: занятие зафиксировано');
      } else if (errorCode === 'MAKEUP_INVALIDATED_SESSION') {
        toast.error('Нельзя создать доп. урок: занятие аннулировано');
      } else {
        toast.error(e?.response?.data?.message ?? errorCode ?? 'Ошибка создания доп. урока');
      }
    } finally {
      if (mountedRef.current) setMakeupSaving(false);
    }
  }

  async function handleCancelOneTime(reason: string) {
    if (!sessionId) return;
    setCancelLoading(true);
    try {
      const res = await api.patch(`/schedule/session/${sessionId}/status`, { status: 'CANCELLED', version: sessionVersion, reason });
      const nextVersion = res?.data?.data?.version;
      if (typeof nextVersion === 'number') setSessionVersion(nextVersion);
      setStatus('CANCELLED');
      if (initialSessionRef.current) initialSessionRef.current.status = 'CANCELLED';
      onSessionCancelled?.(blockId, lessonDate, true);
      toast.success('Занятие отменено');
      setShowCancelDialog(false);
      onReload?.();
      onDone();
    } catch (e: any) {
      toast.error(e?.response?.data?.error ?? 'Ошибка отмены');
    } finally {
      setCancelLoading(false);
    }
  }

  async function handleRestore() {
    if (!sessionId) return;
    setCancelLoading(true);
    try {
      const res = await api.patch(`/schedule/session/${sessionId}/status`, { status: 'UPCOMING', version: sessionVersion });
      const nextVersion = res?.data?.data?.version;
      if (typeof nextVersion === 'number') setSessionVersion(nextVersion);
      setStatus('UPCOMING');
      if (initialSessionRef.current) initialSessionRef.current.status = 'UPCOMING';
      onSessionCancelled?.(blockId, lessonDate, false);
      toast.success('Занятие восстановлено');
      onReload?.();
      onDone();
    } catch (e: any) {
      const errCode = e?.response?.data?.error;
      if (errCode === 'SESSION_HAS_DEDUCTED_CREDITS' || errCode === 'RESTORE_BLOCKED_IF_DEDUCTED_CREDITS' || errCode === 'SESSION_HAS_FINANCIAL_DATA') {
        toast.error('Нельзя восстановить урок: по нему уже есть финансовые операции. Сначала нужна корректировка кредитов.');
      } else {
        toast.error(errCode ?? 'Ошибка восстановления');
      }
    } finally {
      setCancelLoading(false);
    }
  }

  async function save() {
    if (!sessionId) return;
    setSaving(true); setError('');

    const trySave = async (overrideTeacher = false, overrideCabinet = false) => {
      let currentVersion = sessionVersion;
      const syncVersion = (res: any) => {
        const nextVersion = res?.data?.data?.version;
        currentVersion = typeof nextVersion === 'number' ? nextVersion : currentVersion + 1;
        setSessionVersion(currentVersion);
      };

      try {
        // ── Move to different date (POST /move) ────────────────────────────────
        if (dateChanged) {
          const reschedStartTime = selectedSlotId > 0 ? selectedSlotStart : effectiveCurrentStart;
          const reschedEndTime = selectedSlotId > 0 ? selectedSlotEnd : effectiveCurrentEnd;
          await api.post(`/schedule/session/${sessionId}/move`, {
            date: selectedDate,
            startTime: reschedStartTime || slotStart,
            endTime: reschedEndTime || slotEnd,
            cabinetId: cabinetId ? parseInt(cabinetId) : undefined,
            // teacherId: if user explicitly selected a teacher for the moved session, send it (User.id);
            // otherwise omit → backend defaults to block's original teacher.
            ...(moveTeacherId ? { teacherId: parseInt(moveTeacherId) } : {}),
            reason: dateReasonTrimmed,
            version: currentVersion,
            overrideCabinetConflict: overrideCabinet,
            overrideTeacherConflict: overrideTeacher,
          });
          if (!mountedRef.current) return;
          toast.success('Занятие перенесено');
          onReload?.();
          onDone();
          return;
        }

        // ── Same-date changes ─────────────────────────────────────────────────
        const initial = initialSessionRef.current;
        const teacherChangedNow = Boolean(initial) && subTeacherId !== initial!.teacherId;
        const statusChanged = !initial || status !== initial.status;
        const cabinetChangedNow = initial !== null && cabinetId !== initial.cabinetId;
        const slotOrCabinetChanged = slotTimeChanged || cabinetChangedNow;

        if (teacherChangedNow) {
          const res = await api.patch(`/schedule/session/${sessionId}/teacher`, {
            teacherId: subTeacherId ? parseInt(subTeacherId) : null,
            overrideTeacherConflict: overrideTeacher,
            version: currentVersion,
            reason: teacherReasonTrimmed,
          }, { timeout: SAVE_TIMEOUT_MS });
          syncVersion(res);
          if (initialSessionRef.current) initialSessionRef.current.teacherId = subTeacherId;
          setTeacherReplaceReason('');
        }

        if (statusChanged) {
          if (!canSubmitLessonStatus(initial?.status, status)) {
            setError('Сначала переведите урок в статус «Идёт сейчас», затем можно завершить его как «Проведён».');
            return;
          }
          const res = await api.patch(`/schedule/session/${sessionId}/status`, {
            status,
            version: currentVersion,
          }, { timeout: SAVE_TIMEOUT_MS });
          syncVersion(res);
          if (initialSessionRef.current) initialSessionRef.current.status = status;
        }

        if (slotOrCabinetChanged) {
          const reschedStartTime = selectedSlotId > 0 ? selectedSlotStart : effectiveCurrentStart;
          const reschedEndTime = selectedSlotId > 0 ? selectedSlotEnd : effectiveCurrentEnd;
          if (reschedStartTime && reschedEndTime) {
            const autoReason = slotTimeChanged
              ? `Изменение урока: слот ${reschedStartTime.slice(0, 5)}–${reschedEndTime.slice(0, 5)}`
              : 'Изменение урока: кабинет';
            const res = await api.patch(`/schedule/session/${sessionId}/reschedule`, {
              startTime: reschedStartTime,
              endTime: reschedEndTime,
              cabinetId: cabinetId ? parseInt(cabinetId) : undefined,
              reason: autoReason,
              version: currentVersion,
              overrideTeacherConflict: overrideTeacher,
              overrideCabinetConflict: overrideCabinet,
            }, { timeout: SAVE_TIMEOUT_MS });
            syncVersion(res);
            const data = res.data?.data;
            if (data?.startTimeSnap) setSessionStartTime(data.startTimeSnap);
            if (data?.endTimeSnap) setSessionEndTime(data.endTimeSnap);
            if (initialSessionRef.current) {
              initialSessionRef.current.cabinetId = cabinetId;
            }
          }
        }

        if (!mountedRef.current) return;
        const teacher = teachers.find(t => String(t.id) === subTeacherId);
        const cabinetOverride = cabinetId && parseInt(cabinetId) !== group.cabinetId ? parseInt(cabinetId) : null;
        onSessionUpdated?.(blockId, lessonDate, {
          subTeacherId: subTeacherId ? parseInt(subTeacherId) : 0,
          subTeacherName: teacher ? `${teacher.firstName} ${teacher.lastName}` : '',
          startTimeSnap: slotTimeChanged && selectedSlotId > 0 ? selectedSlotStart : null,
          endTimeSnap: slotTimeChanged && selectedSlotId > 0 ? selectedSlotEnd : null,
          cabinetIdSnap: cabinetOverride,
        });
        onSessionCancelled?.(blockId, lessonDate, status === 'CANCELLED');

        onReload?.();
        onDone();
      } catch (err: any) {
        if (!mountedRef.current) return;
        const httpStatus = err.response?.status;
        const msg: string = err.response?.data?.error ?? '';

        if (err.code === 'ECONNABORTED') {
          setError('Сервер слишком долго сохраняет урок. Проверьте backend и попробуйте ещё раз.');
          return;
        }
        if (httpStatus === 409 && msg === 'STALE_DATA') {
          toast.error('Данные устарели, перезагрузите страницу');
          return;
        }
        if (msg === 'LESSON_DATE_CONFLICT') {
          setError('У этого урока уже есть занятие в выбранный день');
          return;
        }
        if (msg === 'LESSON_TARGET_GROUP_CONFLICT') {
          setError('У этой группы уже есть другой урок в выбранное время');
          return;
        }
        if (msg === 'SESSION_NOT_MOVABLE') {
          setError('Нельзя перенести урок: по нему уже есть посещаемость, финансы или он уже не ожидает проведения');
          return;
        }
        if (httpStatus === 409 && (msg === 'MAKEUP_ALREADY_EXISTS' || msg === 'ACTIVE_MAKEUP_EXISTS')) {
          setError('Для этого занятия уже существует перенос');
          return;
        }
        if (msg === 'TIME_OUTSIDE_WORKING_HOURS') {
          setError('Время занятия выходит за пределы рабочего дня школы');
          return;
        }
        if (msg === 'Group is paused. Resume it before performing this action.') {
          setError('Группа на паузе — сначала возобновите группу');
          return;
        }
        if (msg === 'INVALID_STATUS_TRANSITION' || msg === 'FORBIDDEN_TRANSITION' ||
            (typeof msg === 'string' && msg.startsWith('TRANSITION_'))) {
          toast.error('Переход в этот статус невозможен для данного урока.');
          setError('');
          return;
        }
        if (msg.startsWith('TEACHER_CONFLICT_WARNING:')) {
          const teacherId = subTeacherId ? parseInt(subTeacherId) : null;
          setConflictWarning({
            message: msg.replace('TEACHER_CONFLICT_WARNING:', ''),
            confirmLabel: 'Всё равно назначить',
            onConfirm: () => trySave(true, overrideCabinet),
            extraAction: teacherId ? {
              label: 'Открыть карточку учителя',
              onClick: () => {
                onClose();
                navigate(teacherCardPath(location.pathname, teacherId));
              },
            } : undefined,
          });
          return;
        }
        if (msg.startsWith('CAPACITY_WARNING:')) {
          setConflictWarning({
            message: msg.replace('CAPACITY_WARNING:', ''),
            confirmLabel: 'Всё равно сохранить',
            onConfirm: () => trySave(overrideTeacher, true),
          });
          return;
        }
        if (msg.includes('TEACHER_REPLACED') && msg.includes('reason')) {
          setError('Укажите причину замены преподавателя минимум 5 символов.');
          return;
        }
        setError(msg || 'Ошибка сохранения');
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    };

    await trySave();
  }

  const dateLabel = new Date(lessonDate + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

  const alreadyMoved = !!sessionMeta?.makeupSession && !sessionMeta?.isMakeup;
  // When dateChanged: statusReadOnly/teacherReasonInvalid don't apply (teacher/status hidden)
  const saveBtnDisabled = saving || loading || isLocked || dateReasonInvalid
    || (!dateChanged && (statusReadOnly || teacherReasonInvalid))
    || slotMustBeSelected || slotHasCritical;
  const saveBtnLabel = dateReasonInvalid ? 'Укажите причину переноса'
    : slotMustBeSelected ? 'Выберите время'
    : slotHasCritical ? 'Конфликт — нельзя сохранить'
    : saving ? 'Сохранение...'
    : isLocked ? '🔒 Зафиксирован — сохранение недоступно'
    : savedStatus === 'COMPLETED' ? '✓ Проведён — сохранение недоступно'
    : savedStatus === 'CANCELLED' ? '⊘ Отменён — сохранение недоступно'
    : dateChanged ? 'Перенести занятие'
    : 'Сохранить';

  const fieldDisabled = status === 'COMPLETED' || isLocked;

  return (
    <div style={{ padding: '14px 16px', background: C.bgOff, borderBottom: `1px solid ${C.border}` }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Редактировать урок</span>
          <button
            onClick={() => setShowLogs(!showLogs)}
            title="История изменений"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 4,
              borderRadius: 4, display: 'flex', alignItems: 'center', color: showLogs ? C.primary : C.mid,
              transition: 'all 0.2s',
            }}
          >
            <History size={15} />
          </button>
        </div>
        <button onClick={onClose} style={{ fontSize: 16, background: 'none', border: 'none', cursor: 'pointer', color: C.mid }}>✕</button>
      </div>

      {/* ── Change log ── */}
      <EditSessionChangeLog show={showLogs} loading={loadingLogs} logs={logs} />

      {/* ── Meta row ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 11, color: C.mid }}>
        <span>📅 {dateLabel}</span>
        <span>·</span>
        <span>{isClubDay ? 'Разговорный клуб' : 'Грамматика'}</span>
        <span>·</span>
        <span>Основной: <strong style={{ color: C.text }}>{mainTeacher || '—'}</strong></span>
      </div>
      {sessionMeta?.isMakeup && sessionMeta.makeupForSession && (
        <div style={{ fontSize: 12, color: '#2D6A4F', background: '#E8F5E9', borderRadius: 6, padding: '6px 10px', marginBottom: 10, fontWeight: 700 }}>
          ↩ Доп. урок за {formatSessionDate(sessionMeta.makeupForSession.date)}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 12, color: C.light, padding: '8px 0' }}>Загрузка...</div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>

          {/* ── Lock / Completed banners ── */}
          {isLocked && (
            <div style={{ background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 8, padding: '8px 12px' }}>
              <span style={{ fontSize: 12, color: '#3730A3', fontWeight: 700 }}>🔒 Урок зафиксирован — редактирование недоступно</span>
            </div>
          )}
          {status === 'COMPLETED' && !isLocked && (
            <div style={{ background: '#F5F5F5', border: '1px solid #E0E0E0', borderRadius: 8, padding: '8px 12px' }}>
              <span style={{ fontSize: 12, color: '#757575', fontWeight: 700 }}>✓ Урок проведён — изменение кабинета и замены недоступно</span>
            </div>
          )}

          {/* ── Дата + Время занятия ── */}
          <div style={{ display: 'grid', gridTemplateColumns: hasTimeSlots ? '1fr 1fr' : '1fr', gap: 8 }}>
            <div>
              <label style={lbl}>Дата</label>
              <input
                type="date"
                style={{
                  ...inp,
                  opacity: fieldDisabled || alreadyMoved ? 0.6 : 1,
                  cursor: fieldDisabled || alreadyMoved ? 'not-allowed' : 'pointer',
                }}
                value={selectedDate}
                min={getTomorrow()}
                disabled={fieldDisabled || alreadyMoved}
                onChange={e => { setSelectedDate(e.target.value); setError(''); }}
              />
            </div>
            {hasTimeSlots && (
              <div>
                <label style={lbl}>Время занятия</label>
                <select
                  style={inp}
                  value={selectedSlotId}
                  disabled={fieldDisabled}
                  onChange={e => {
                    const newId = parseInt(e.target.value, 10);
                    const found = timeSlots?.find(s => s.id === newId);
                    if (found) {
                      setSelectedSlotId(found.id);
                      setSelectedSlotStart(found.s);
                      setSelectedSlotEnd(found.e);
                    }
                  }}
                >
                  {isSlotOutsidePolicy && <option value={0} disabled>— Выберите новый слот —</option>}
                  {timeSlots!.map(s => (
                    <option key={s.id} value={s.id}>{s.s}–{s.e}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Already moved banner */}
          {alreadyMoved && sessionMeta?.makeupSession && (
            <div style={{ fontSize: 11, color: '#5D4037', background: '#FFF8E1', borderRadius: 6, padding: '6px 10px', fontWeight: 600 }}>
              ↪ Занятие уже перенесено на {formatSessionDate(sessionMeta.makeupSession.date)} — повторный перенос недоступен
            </div>
          )}

          {/* Outside-policy warning */}
          {isSlotOutsidePolicy && !dateChanged && (
            <p style={{ fontSize: 11, color: '#E65100', margin: '-4px 0 0', lineHeight: 1.4 }}>
              ⚠ Текущее время вне сетки расписания. Выберите новый слот.
            </p>
          )}

          {/* Slot-changed hint */}
          {slotTimeChanged && (
            <p style={{ fontSize: 11, color: '#E65100', margin: '-4px 0 0', lineHeight: 1.4 }}>
              ⚠ Изменение времени применится только к этому уроку — другие занятия не затронуты
            </p>
          )}

          {/* Date-changed hint */}
          {dateChanged && (
            <p style={{ fontSize: 11, color: '#0284C7', margin: '-4px 0 0', lineHeight: 1.4 }}>
              ↪ Урок будет перенесён на другую дату — другие занятия группы не затронуты
            </p>
          )}

          {/* Conflict preview (only for same-date slot change) */}
          {showConflictPreview && slotConflicts.length > 0 && (
            <ConflictList conflicts={slotConflicts} style={{ marginTop: -4 }} />
          )}

          {/* ── Причина переноса (показывается при смене даты) ── */}
          {dateChanged && (
            <div>
              <label style={lbl}>Причина переноса *</label>
              <input
                autoFocus
                style={inp}
                value={dateChangeReason}
                placeholder="Например: болезнь преподавателя, праздник, просьба группы"
                onChange={e => { setDateChangeReason(e.target.value); setError(''); }}
              />
              {dateChangeReason.length > 0 && dateReasonInvalid && (
                <div style={{ marginTop: 3, fontSize: 11, color: C.red }}>
                  Укажите причину (минимум 5 символов)
                </div>
              )}
            </div>
          )}

          {/* ── Кабинет + Учитель ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label style={lbl}>Кабинет</label>
              <select style={inp} value={cabinetId} onChange={e => setCabinetId(e.target.value)} disabled={fieldDisabled}>
                <option value="" disabled>— Выберите кабинет —</option>
                {cabinets.map(c => <option key={c.id} value={String(c.id)}>{c.name} ({c.capacity} мест)</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>{dateChanged ? 'Учитель на перенос' : 'Учитель на замену'}</label>
              {dateChanged ? (
                <select
                  style={inp}
                  value={moveTeacherId}
                  onChange={e => setMoveTeacherId(e.target.value)}
                >
                  <option value="">— {mainTeacher || 'Из блока'} —</option>
                  {teachers.map(t => <option key={t.id} value={String(t.id)}>{t.firstName} {t.lastName}</option>)}
                </select>
              ) : (
                <select style={inp} value={subTeacherId} onChange={e => setSubTeacherId(e.target.value)} disabled={fieldDisabled}>
                  <option value="">— Без замены —</option>
                  {teachers.map(t => <option key={t.id} value={String(t.id)}>{t.firstName} {t.lastName}</option>)}
                </select>
              )}
            </div>
          </div>

          {/* ── Причина замены учителя (только без переноса даты) ── */}
          <EditSessionTeacherReasonField
            show={!dateChanged && teacherChanged}
            value={teacherReplaceReason}
            invalid={teacherReasonInvalid}
            onChange={setTeacherReplaceReason}
            inputStyle={inp}
            labelStyle={lbl}
          />

          {/* ── Статус (скрыт при переносе даты — новый урок всегда UPCOMING) ── */}
          {!dateChanged && (
            <EditSessionStatusField
              status={status}
              isLocked={isLocked}
              statusOptions={statusOptions}
              statusHelper={statusHelper}
              statusReadOnly={statusReadOnly}
              cancelLoading={cancelLoading}
              onStatusChange={setStatus}
              onRestore={handleRestore}
              inputStyle={inp}
              labelStyle={lbl}
            />
          )}

          {/* ── Доп. урок (при отмене) ── */}
          {status === 'CANCELLED' && (
            <EditSessionMakeupSection
              existingMakeupDate={sessionMeta?.makeupSession?.date ?? null}
              showForm={showMakeup}
              makeupDate={makeupDate}
              makeupReason={makeupReason}
              makeupSaving={makeupSaving}
              canCreate={canCreateMakeup}
              showReasonError={showMakeupReasonError}
              minDate={dateInTz(new Date(), tz)}
              onShowForm={() => setShowMakeup(true)}
              onMakeupDateChange={setMakeupDate}
              onMakeupReasonChange={setMakeupReason}
              onCreate={createMakeup}
              onCancelForm={() => { setShowMakeup(false); setMakeupDate(''); setMakeupReason(''); }}
              inputStyle={inp}
              labelStyle={lbl}
            />
          )}

          {error && <div style={{ fontSize: 12, color: C.red, background: C.redLight, borderRadius: 6, padding: '6px 10px' }}>{error}</div>}
        </div>
      )}

      {/* ── Кнопки ── */}
      <EditSessionFooterActions
        saveBtnDisabled={saveBtnDisabled}
        saveBtnLabel={saveBtnLabel}
        dateChanged={dateChanged}
        onSave={save}
        onClose={onClose}
        showCancelLesson={!loading && !dateChanged && status !== 'CANCELLED' && status !== 'COMPLETED'}
        onCancelLesson={() => setShowCancelDialog(true)}
      />

      {/* ── Modals ── */}
      {conflictWarning && (
        <ConflictWarningModal
          message={conflictWarning.message}
          confirmLabel={conflictWarning.confirmLabel}
          onConfirm={() => { setConflictWarning(null); conflictWarning.onConfirm(); }}
          onCancel={() => setConflictWarning(null)}
          extraAction={conflictWarning.extraAction}
        />
      )}
      <CancelDialog
        open={showCancelDialog}
        isCancelled={status === 'CANCELLED'}
        onOneTime={handleCancelOneTime}
        onRestore={handleRestore}
        onClose={() => setShowCancelDialog(false)}
      />
    </div>
  );
}
