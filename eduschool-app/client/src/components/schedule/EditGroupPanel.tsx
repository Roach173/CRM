import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { GROUP_PICK_KEY } from '../../lib/groupPick';
import type { SchedGroup } from './scheduleTypes';
import { LEVELS, clubBlockIdOf, grammarBlockIdOf, relatedBlockIdsOf } from './scheduleTypes';
import api from '../../lib/api';
import { ConflictWarningModal } from './ConflictWarningModal';
import { TeacherAvailabilitySelect } from './TeacherAvailabilitySelect';
import {
  findCabinetConflicts,
  findTeacherConflicts,
  findStudentGroupConflicts,
  findIntraDayConflict,
  getConflictSeverity,
  type ScheduleConflict,
} from '../../utils/scheduleConflicts';
import { C } from './scheduleTheme';
import DaySelector from './DaySelector';
import ConflictList, { findTeacherIdInMessage, teacherCardPath } from './ConflictList';
import { useBackButtonClose } from '../../hooks/useBackButtonClose';

type Teacher = { id: number; firstName: string; lastName: string };
type Cabinet = { id: number; name: string; capacity: number };
type TimeSlotOption = { id: number; s: string; e: string };
const SAVE_TIMEOUT_MS = 30000;
const ALL_DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6];

interface Props {
  group: SchedGroup;
  teachers: Teacher[];
  cabinets: Cabinet[];
  slotId: number;
  slotStart: string;
  slotEnd: string;
  activeDays: number[];
  timeSlots?: TimeSlotOption[];
  currentDate?: string;
  schedGroups: Record<string, SchedGroup>;
  // Cell context for the "Выбрать группу" round-trip (reopen the same cell on return)
  pickContext?: { ci: number; wk: string };
  isTeacher?: boolean;
  onDone: (newBlockId?: number) => void;
  onClose: () => void;
}

export default function EditGroupPanel({
  group, teachers, cabinets, slotId, slotStart, slotEnd, activeDays,
  timeSlots, currentDate, schedGroups, pickContext, isTeacher = false, onDone, onClose,
}: Props) {
  // A teacher gets the same read-only rendering as a COMPLETED/ARCHIVED group: view the
  // group's composition/schedule, but every field and the Save action stay disabled — see
  // GroupActionsMenu.tsx, which shows «👁 Просмотр группы» instead of «✎ Редактировать
  // группу» for isTeacher for the same reason (teachers can only mark attendance).
  const isReadOnly = group.status === 'COMPLETED' || group.status === 'ARCHIVED' || isTeacher;
  const selectableDays = useMemo(
    () => (activeDays.length > 0 ? activeDays : ALL_DAY_INDEXES),
    [activeDays],
  );
  const selectableDayKey = selectableDays.join(',');
  const sanitizeSelectedDays = (days: number[]) => days.filter(d => selectableDays.includes(d));
  const [lv, setLv] = useState(group.lv);

  // true when the block's current slot is no longer in the current policy (legacy time)
  const isSlotOutsidePolicy = !!(timeSlots && timeSlots.length > 0 && !timeSlots.find(s => s.id === slotId));

  // Selected time slot — cleared when current slot is outside policy to force a valid pick
  const [selectedSlotId, setSelectedSlotId] = useState(() => isSlotOutsidePolicy ? 0 : slotId);
  const [selectedSlotStart, setSelectedSlotStart] = useState(() => isSlotOutsidePolicy ? '' : slotStart);
  const [selectedSlotEnd, setSelectedSlotEnd] = useState(() => isSlotOutsidePolicy ? '' : slotEnd);
  const slotMustBeSelected = isSlotOutsidePolicy && (selectedSlotId === 0 || !timeSlots?.find(s => s.id === selectedSlotId));
  const slotChanged = !isSlotOutsidePolicy && (
    selectedSlotId !== slotId
    || selectedSlotStart !== group.startTime
    || selectedSlotEnd !== group.endTime
  );

  const [cabinetId, setCabinetId] = useState(String(group.cabinetId ?? ''));
  const [grammarTeacherId, setGrammarTeacherId] = useState(String(group.tgId ?? ''));
  const [grammarDays, setGrammarDays] = useState<number[]>(() => sanitizeSelectedDays(group.grammarDays));
  const [clubTeacherId, setClubTeacherId] = useState(String(group.tkId ?? ''));
  const [clubDays, setClubDays] = useState<number[]>(() => {
    const initialGrammarDays = sanitizeSelectedDays(group.grammarDays);
    return sanitizeSelectedDays(group.clubDays).filter(d => !initialGrammarDays.includes(d));
  });
  const showClub = Boolean(clubBlockIdOf(group)) || group.clubDays.length > 0;
  const [studentGroupId, setStudentGroupId] = useState(String(group.studentGroupId ?? ''));
  const chapter = String(group.chapter ?? '1');
  const maxStudents = String(group.maxStudents ?? '15');
  const [studentGroups, setStudentGroups] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showSplitDialog, setShowSplitDialog] = useState(false);
  const [conflictWarning, setConflictWarning] = useState<{ message: string; confirmLabel?: string; onConfirm: () => void; extraAction?: { label: string; onClick: () => void } } | null>(null);
  useBackButtonClose(showSplitDialog, () => setShowSplitDialog(false));

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Clear stale slot error when user picks a different slot OR when timeSlots
  // list refreshes and the currently selected slot is now present (valid).
  useEffect(() => {
    setError('');
  }, [selectedSlotId]);

  useEffect(() => {
    if (selectedSlotId > 0 && timeSlots?.some(s => s.id === selectedSlotId)) {
      setError('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSlots]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.debug('[EditGroupPanel open]', {
      currentDate,
      applyFrom: currentDate,
      slotIdProp: slotId,
      slotStart,
      slotEnd,
      groupStartTime: group.startTime,
      groupEndTime: group.endTime,
      selectedSlotId,
      selectedSlotStart,
      selectedSlotEnd,
      timeSlots,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setGrammarDays(prev => sanitizeSelectedDays(prev));
    setClubDays(prev => sanitizeSelectedDays(prev));
  }, [selectableDayKey]);

  const excludeEditIds = useMemo(() => relatedBlockIdsOf(group), [group]);
  const conflictDateOptions = useMemo(
    () => (currentDate ? { targetStartDate: currentDate } : undefined),
    [currentDate],
  );
  const allSelectedDays = useMemo(() => {
    const days = new Set([...grammarDays, ...clubDays]);
    return [...days].sort((a, b) => a - b);
  }, [grammarDays, clubDays]);

  const cabinetConflicts = useMemo((): ScheduleConflict[] => {
    const cid = cabinetId ? parseInt(cabinetId) : 0;
    if (!cid || allSelectedDays.length === 0 || !selectedSlotStart || !selectedSlotEnd) return [];
    return findCabinetConflicts(cid, allSelectedDays, selectedSlotStart, selectedSlotEnd, schedGroups, excludeEditIds, conflictDateOptions);
  }, [cabinetId, allSelectedDays, selectedSlotStart, selectedSlotEnd, schedGroups, excludeEditIds, conflictDateOptions]);

  const grammarTeacherConflicts = useMemo((): ScheduleConflict[] => {
    const tid = grammarTeacherId ? parseInt(grammarTeacherId) : 0;
    if (!tid || grammarDays.length === 0) return [];
    return findTeacherConflicts(tid, grammarDays, selectedSlotStart, selectedSlotEnd, schedGroups, excludeEditIds, conflictDateOptions)
      .filter(c => c.severity === 'critical');
  }, [grammarTeacherId, grammarDays, selectedSlotStart, selectedSlotEnd, schedGroups, excludeEditIds, conflictDateOptions]);

  const clubTeacherConflicts = useMemo((): ScheduleConflict[] => {
    const tid = clubTeacherId ? parseInt(clubTeacherId) : 0;
    if (!tid || clubDays.length === 0) return [];
    return findTeacherConflicts(tid, clubDays, selectedSlotStart, selectedSlotEnd, schedGroups, excludeEditIds, conflictDateOptions)
      .filter(c => c.severity === 'critical');
  }, [clubTeacherId, clubDays, selectedSlotStart, selectedSlotEnd, schedGroups, excludeEditIds, conflictDateOptions]);

  const clubNeedsTeacher = clubDays.length > 0 && !clubTeacherId;
  const intraDayConflict = findIntraDayConflict(grammarDays, clubDays);
  const studentGroupConflicts = useMemo((): ScheduleConflict[] => {
    const gid = studentGroupId ? parseInt(studentGroupId) : 0;
    if (!gid || allSelectedDays.length === 0 || !selectedSlotStart || !selectedSlotEnd) return [];
    return findStudentGroupConflicts(gid, allSelectedDays, selectedSlotStart, selectedSlotEnd, schedGroups, excludeEditIds, conflictDateOptions);
  }, [studentGroupId, allSelectedDays, selectedSlotStart, selectedSlotEnd, schedGroups, excludeEditIds, conflictDateOptions]);
  const editConflicts = useMemo(() => [
    ...cabinetConflicts,
    ...grammarTeacherConflicts,
    ...clubTeacherConflicts,
    ...studentGroupConflicts,
    ...(intraDayConflict ? [intraDayConflict] : []),
  ], [cabinetConflicts, grammarTeacherConflicts, clubTeacherConflicts, studentGroupConflicts, intraDayConflict]);
  const editHasCritical = clubNeedsTeacher || getConflictSeverity(editConflicts) === 'critical';

  // Field look/focus/hover live in the .sch-field class (index.css)
  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: C.mid, display: 'block', marginBottom: 4 };
  const warn: React.CSSProperties = {
    fontSize: 11, color: C.orange, background: C.orangeLight,
    padding: '6px 10px', borderRadius: 6, marginTop: 6, lineHeight: 1.45,
  };

  useEffect(() => {
    api.get('/groups?status=ACTIVE').then(res => setStudentGroups(res.data?.data ?? []));
  }, []);

  const navigate = useNavigate();
  const location = useLocation();

  // Resume after the "Выбрать группу" round-trip: restore the stashed draft and
  // apply the picked group + its teachers/cabinet. Only consume an edit stash
  // that was confirmed (has .picked) and belongs to this exact group.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(GROUP_PICK_KEY);
      if (!raw) return;
      const stash = JSON.parse(raw);
      if (!stash?.picked || stash.mode !== 'edit' || stash.gid !== group.id) return;
      sessionStorage.removeItem(GROUP_PICK_KEY);
      const f = stash.form;
      setLv(stash.picked.level || f.lv);
      setCabinetId(stash.picked.cabinetId != null ? String(stash.picked.cabinetId) : f.cabinetId);
      setGrammarTeacherId(stash.picked.grammarTeacherId != null ? String(stash.picked.grammarTeacherId) : f.grammarTeacherId);
      setClubTeacherId(stash.picked.clubTeacherId != null ? String(stash.picked.clubTeacherId) : f.clubTeacherId);
      const pickedDays = (v: unknown): number[] | null =>
        Array.isArray(v) && v.length > 0 ? v : null;
      const gDays = sanitizeSelectedDays(pickedDays(stash.picked.grammarDays) ?? f.grammarDays);
      const cDays = sanitizeSelectedDays(pickedDays(stash.picked.clubDays) ?? f.clubDays)
        .filter(d => !gDays.includes(d));
      setGrammarDays(gDays);
      setClubDays(cDays);
      setStudentGroupId(String(stash.picked.id));
      setSelectedSlotId(f.selectedSlotId);
      setSelectedSlotStart(f.selectedSlotStart);
      setSelectedSlotEnd(f.selectedSlotEnd);
    } catch {
      sessionStorage.removeItem(GROUP_PICK_KEY);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function goPickGroup() {
    if (!pickContext) return;
    sessionStorage.setItem(GROUP_PICK_KEY, JSON.stringify({
      mode: 'edit',
      gid: group.id,
      ci: pickContext.ci,
      sid: slotId,
      wk: pickContext.wk,
      currentDate,
      form: {
        lv, cabinetId, grammarTeacherId, grammarDays, clubTeacherId, clubDays,
        studentGroupId, selectedSlotId, selectedSlotStart, selectedSlotEnd,
      },
    }));
    navigate(`${location.pathname.replace(/\/schedule$/, '/groups')}?pick=1`);
  }

  function save() {
    if (saving || editHasCritical || slotMustBeSelected) return;
    if (currentDate) {
      setShowSplitDialog(true);
    } else {
      performSave(undefined);
    }
  }

  async function performSave(applyFrom: string | undefined, overrideCabinetConflict = false, overrideStudentConflict = false, overrideTeacherConflict = false) {
    setSaving(true); setError('');
    try {
      if (!studentGroupId) {
        setError('Группа не привязана к справочнику групп.');
        return;
      }

      // Derive accurate slot times from the timeSlots list to avoid stale selectedSlotStart/End
      // state that may have been initialized from a mismatched cell slot (inject path bug).
      const resolvedSlot = selectedSlotId > 0 ? timeSlots?.find(s => s.id === selectedSlotId) : undefined;
      if (selectedSlotId > 0 && timeSlots && timeSlots.length > 0 && !resolvedSlot) {
        setError('Сетка расписания обновилась. Выберите слот заново.');
        return;
      }
      const payloadStartTime = resolvedSlot?.s ?? selectedSlotStart;
      const payloadEndTime = resolvedSlot?.e ?? selectedSlotEnd;

      // targetDate drives slot-policy validation in the backend.
      // When the block's startDate is after the clicked cell (policy-transition boundary:
      // e.g. new policy "08:06" starts Monday but user clicked Sunday still on "08:00"),
      // use startDate so the validator sees the correct new policy instead of the old one.
      // applyFrom is sent separately and controls which sessions actually get updated.
      const rawTargetDate = applyFrom ?? currentDate;
      const blockStartDate = group.startDate?.slice(0, 10);
      const slotPolicyDate =
        blockStartDate && rawTargetDate && rawTargetDate < blockStartDate
          ? blockStartDate
          : rawTargetDate;

      const payload = {
        grammarBlockId: grammarBlockIdOf(group),
        clubBlockId: clubBlockIdOf(group),
        // IDs ≥ 100000 are server-synthetic (settings.ts fallback when DB key format mismatch).
        // Omit them so the backend uses time-based resolution (resolvePolicySlotForTime + upsert).
        timeSlotId: (selectedSlotId > 0 && selectedSlotId < 100000) ? selectedSlotId : undefined,
        startTime: payloadStartTime, endTime: payloadEndTime,
        targetDate: slotPolicyDate,
        level: lv,
        cabinetId: cabinetId ? parseInt(cabinetId) : null,
        chapter: parseInt(chapter) || 1,
        maxStudents: parseInt(maxStudents) || 15,
        grammarTeacherId: grammarTeacherId ? parseInt(grammarTeacherId) : null,
        grammarDays: grammarDays.length > 0 ? grammarDays : [0],
        clubTeacherId: clubTeacherId ? parseInt(clubTeacherId) : null,
        clubDays: (showClub || clubDays.length > 0) ? clubDays : [],
        overrideCabinetConflict,
        overrideStudentConflict,
        overrideTeacherConflict,
        ...(applyFrom ? { applyFrom } : {}),
      };

      if (import.meta.env.DEV) {
        console.debug('[EditGroupPanel] save payload', payload);
      }

      const res = await api.put(`/schedule/group-pair/${studentGroupId}`, payload, { timeout: SAVE_TIMEOUT_MS });

      if (!mountedRef.current) return;
      onDone(res.data?.data?.grammarBlockId);
    } catch (err: any) {
      if (!mountedRef.current) return;
      if (err.code === 'ECONNABORTED') {
        setError('Сервер слишком долго сохраняет расписание. Проверьте backend и попробуйте ещё раз.');
        return;
      }
      const msg = err.response?.data?.error;
      const code = err.response?.data?.code;
      if (code === 'HISTORICAL_POLICY_READ_ONLY' || code === 'TIME_SLOT_NOT_WRITABLE') {
        setError('Историческая сетка доступна только для просмотра.');
        return;
      }
      if (code === 'TIME_SLOT_TIME_MISMATCH' || code === 'TIME_SLOT_NOT_FOUND' || code === 'TIME_SLOT_SCHOOL_MISMATCH') {
        setError('Сетка расписания обновилась. Выберите слот заново.');
        return;
      }
      if (code === 'SPLIT_PROTECTED_FUTURE_SESSIONS') {
        setError('Нельзя применить с этой даты: будущие уроки уже содержат посещаемость или выплаты. Выберите дату позже или примените ко всем урокам блока.');
        return;
      }
      if (typeof msg === 'string' && msg.startsWith('CAPACITY_WARNING:')) {
        setConflictWarning({
          message: msg.replace('CAPACITY_WARNING:', ''),
          confirmLabel: 'Всё равно сохранить',
          onConfirm: () => performSave(applyFrom, true, overrideStudentConflict, overrideTeacherConflict),
        });
        return;
      }
      if (typeof msg === 'string' && msg.startsWith('STUDENT_CONFLICT_WARNING:')) {
        setConflictWarning({
          message: msg.replace('STUDENT_CONFLICT_WARNING:', ''),
          confirmLabel: 'Всё равно сохранить',
          onConfirm: () => performSave(applyFrom, overrideCabinetConflict, true, overrideTeacherConflict),
        });
        return;
      }
      if (typeof msg === 'string' && msg.startsWith('TEACHER_CONFLICT_WARNING:')) {
        const conflictMessage = msg.replace('TEACHER_CONFLICT_WARNING:', '');
        const teacherId = findTeacherIdInMessage(conflictMessage, teachers);
        setConflictWarning({
          message: conflictMessage,
          confirmLabel: 'Всё равно сохранить',
          onConfirm: () => performSave(applyFrom, overrideCabinetConflict, overrideStudentConflict, true),
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
      setError(msg ?? 'Ошибка сохранения');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <div style={{ padding: '16px 20px', background: C.bgOff, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: C.text, whiteSpace: 'nowrap' }}>
            {isReadOnly ? 'Просмотр группы' : 'Редактировать группу'}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.green, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {studentGroupId
              ? (studentGroups.find(sg => String(sg.id) === studentGroupId)?.level ?? group.lv)
              : '— Без привязки —'}
          </span>
        </div>
        <button onClick={onClose} className="sch-icon-btn" aria-label="Закрыть">✕</button>
      </div>

      {pickContext && !isReadOnly && (
        <div style={{ marginBottom: 12 }}>
          <button type="button" onClick={goPickGroup} className="sch-btn sch-btn--tinted">
            Выбрать группу
          </button>
        </div>
      )}

      {/* Read-only banner for COMPLETED / ARCHIVED */}
      {isReadOnly && (
        <div style={{
          marginBottom: 12, padding: '8px 12px', borderRadius: 8,
          background: C.bgLight,
          border: `1px solid ${C.border}`,
          fontSize: 11, color: C.mid, lineHeight: 1.5,
        }}>
          {group.status === 'ARCHIVED'
            ? '🗃 Группа архивирована. Расписание и состав недоступны для изменения.'
            : group.status === 'COMPLETED'
            ? '✓ Группа завершена. Расписание и состав недоступны для изменения.'
            : '👁 Просмотр группы. Изменение расписания и состава доступно администратору школы.'}
        </div>
      )}

      <div style={{ display: 'grid', gap: 12, opacity: isReadOnly ? 0.7 : 1, pointerEvents: isReadOnly ? 'none' : undefined }}>

        {/* Bound group name + "Выбрать группу" live in the header now */}
        {!isReadOnly && <ConflictList conflicts={studentGroupConflicts} />}

        {/* Time slot selector */}
        {timeSlots && (timeSlots.length > 1 || isSlotOutsidePolicy) && (
          <div>
            <label style={lbl}>Время занятия</label>
            <select
              className="sch-field"
              value={selectedSlotId}
              onChange={e => {
                const newId = parseInt(e.target.value, 10);
                const found = timeSlots.find(s => s.id === newId);
                if (found) {
                  setSelectedSlotId(found.id);
                  setSelectedSlotStart(found.s);
                  setSelectedSlotEnd(found.e);
                }
              }}
            >
              {isSlotOutsidePolicy && <option value={0} disabled>— Выберите новый слот —</option>}
              {timeSlots.map(s => (
                <option key={s.id} value={s.id}>{s.s}–{s.e}</option>
              ))}
            </select>
            {isSlotOutsidePolicy && slotMustBeSelected && (
              <p style={warn}>
                ⚠ Текущее время вне новой политики. Выберите новый слот.
              </p>
            )}
            {slotChanged && (
              <p style={warn}>
                ⚠ Изменение времени обновит снимки всех будущих уроков без ручного переопределения
              </p>
            )}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label style={lbl}>Кабинет *</label>
            <select className="sch-field" value={cabinetId} onChange={e => setCabinetId(e.target.value)}>
              <option value="" disabled>— Выберите кабинет —</option>
              {cabinets.map(c => <option key={c.id} value={String(c.id)}>{c.name} ({c.capacity} мест)</option>)}
            </select>
            {!isReadOnly && <ConflictList conflicts={cabinetConflicts} style={{ marginTop: 8 }} />}
          </div>
          <div><label style={lbl}>Уровень</label>
            <select className="sch-field" value={lv} onChange={e => setLv(e.target.value)}>
              {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
        </div>

        <div style={{ background: C.greenLight, borderRadius: 10, padding: '12px 14px', border: `1px solid ${C.greenBorder}`, borderLeft: `3px solid ${C.green}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.green, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Грамматика</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center' }}>
            <TeacherAvailabilitySelect
              value={grammarTeacherId}
              onChange={setGrammarTeacherId}
              teachers={teachers}
              days={grammarDays}
              startTime={selectedSlotStart}
              endTime={selectedSlotEnd}
              schedGroups={schedGroups}
              excludeBlockIds={excludeEditIds}
              targetDate={currentDate}
              placeholder="— Выберите учителя —"
            />
            <DaySelector
              value={grammarDays}
              onChange={(days) => {
                setGrammarDays(days);
                setClubDays(prev => prev.filter(d => !days.includes(d)));
              }}
              activeDays={activeDays}
              variant="grammar"
            />
          </div>
          {!isReadOnly && <ConflictList conflicts={grammarTeacherConflicts} style={{ marginTop: 8 }} />}
        </div>

        <div style={{ background: C.blueLight, borderRadius: 10, padding: '12px 14px', border: `1px solid ${C.blueBorder}`, borderLeft: `3px solid ${C.blue}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            Разговорный клуб <span style={{ fontWeight: 400, opacity: 0.7 }}>(необязательно)</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center' }}>
            <TeacherAvailabilitySelect
              value={clubTeacherId}
              onChange={setClubTeacherId}
              teachers={teachers}
              days={clubDays}
              startTime={selectedSlotStart}
              endTime={selectedSlotEnd}
              schedGroups={schedGroups}
              excludeBlockIds={excludeEditIds}
              targetDate={currentDate}
              allowEmpty
              placeholder="— Без учителя —"
            />
            <DaySelector
              value={clubDays}
              onChange={(days) => {
                setClubDays(days);
                setGrammarDays(prev => prev.filter(d => !days.includes(d)));
              }}
              activeDays={activeDays}
              variant="club"
            />
          </div>
          {!isReadOnly && (
            <>
              <ConflictList conflicts={clubTeacherConflicts} style={{ marginTop: 8 }} />
              {clubNeedsTeacher && (
                <ConflictList conflicts={[{ type: 'teacher', message: 'Укажите учителя — без учителя зарплата не начисляется', severity: 'critical' }]} style={{ marginTop: 8 }} />
              )}
              {intraDayConflict && (
                <ConflictList conflicts={[intraDayConflict]} style={{ marginTop: 8 }} />
              )}
            </>
          )}
        </div>

        {group.status && group.status !== 'ACTIVE' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, background: group.status === 'PAUSED' ? C.pausedLight : C.bgLight, border: `1px solid ${group.status === 'PAUSED' ? `color-mix(in srgb, ${C.paused} 30%, transparent)` : C.border}` }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: C.mid }}>Статус группы:</span>
            {group.status === 'PAUSED' && <span style={{ fontSize: 11, fontWeight: 700, color: C.paused }}>⏸ На паузе</span>}
            {group.status === 'COMPLETED' && <span style={{ fontSize: 11, fontWeight: 700, color: C.mid }}>✓ Завершена</span>}
            {group.status === 'ARCHIVED' && <span style={{ fontSize: 11, fontWeight: 700, color: C.mid }}>🗃 Архив</span>}
          </div>
        )}

        {error && !(
          error === 'Сетка расписания обновилась. Выберите слот заново.' &&
          selectedSlotId > 0 &&
          timeSlots?.some(s => s.id === selectedSlotId)
        ) && (
          <div style={{ fontSize: 12, color: C.red, background: C.redLight, borderRadius: 8, padding: '8px 12px', lineHeight: 1.45 }}>{error}</div>
        )}
      </div>
      {/* Action bar: status hint left, actions right (primary in the corner).
          Save keeps a stable label — the block reason lives in the hint. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.borderSoft}` }}>
        {isReadOnly ? (
          <button onClick={onClose} className="sch-btn sch-btn--secondary" style={{ minWidth: 120 }}>
            Закрыть
          </button>
        ) : (
          <>
            {(slotMustBeSelected || editHasCritical) && (
              <span style={{ marginRight: 'auto', minWidth: 0, fontSize: 12, color: C.orange, lineHeight: 1.4 }}>
                {slotMustBeSelected
                  ? '⚠ Выберите время занятия из новой сетки'
                  : '⚠ Устраните конфликты перед сохранением'}
              </span>
            )}
            <button onClick={onClose} className="sch-btn sch-btn--ghost">
              Отмена
            </button>
            <button onClick={save} disabled={saving || editHasCritical || slotMustBeSelected}
              className="sch-btn sch-btn--primary"
              title={
                slotMustBeSelected ? 'Выберите слот времени из новой политики' :
                editHasCritical ? 'Устраните конфликты перед сохранением' : undefined
              }>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </>
        )}
      </div>

      {showSplitDialog && currentDate && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: C.bg, borderRadius: 12, padding: 24, paddingBottom: 'calc(24px + env(safe-area-inset-bottom))', maxWidth: 360, width: '90%', maxHeight: '90dvh', overflowY: 'auto', boxShadow: C.modalShadow }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 10 }}>Применить изменения</div>
            <div style={{ fontSize: 13, color: C.mid, marginBottom: 16, lineHeight: 1.5 }}>
              Начиная с <strong>{currentDate}</strong> — прошлые уроки останутся без изменений.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                onClick={() => { setShowSplitDialog(false); performSave(currentDate); }}
                className="sch-btn sch-btn--primary"
                style={{ width: '100%' }}>
                С {currentDate}
              </button>
              <button
                onClick={() => setShowSplitDialog(false)}
                className="sch-btn sch-btn--ghost"
                style={{ width: '100%', height: 36 }}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
      {conflictWarning && (
        <ConflictWarningModal
          message={conflictWarning.message}
          confirmLabel={conflictWarning.confirmLabel}
          onConfirm={() => { setConflictWarning(null); conflictWarning.onConfirm(); }}
          onCancel={() => setConflictWarning(null)}
          extraAction={conflictWarning.extraAction}
        />
      )}
    </div>
  );
}
