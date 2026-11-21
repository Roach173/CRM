import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router';
import toast from 'react-hot-toast';
import { GROUP_PICK_KEY } from '../../lib/groupPick';
import api from '../../lib/api';
import type { TimeSlot, GMap } from '../../hooks/useSchedule';
import { LEVELS } from './scheduleTypes';
import { StudentGroup } from '../../types';
import { GroupEditorModal } from '../ui/GroupEditorModal';
import { ConflictWarningModal } from './ConflictWarningModal';
import { TeacherAvailabilitySelect } from './TeacherAvailabilitySelect';
import { CabinetAvailabilitySelect } from './CabinetAvailabilitySelect';
import { GroupAvailabilitySelect } from './GroupAvailabilitySelect';
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

type Teacher = { id: number; firstName: string; lastName: string };
type Cabinet = { id: number; name: string; capacity: number };
const SAVE_TIMEOUT_MS = 30000;

interface Props {
  ci: number;
  sid: number;
  slot: TimeSlot | undefined;
  teachers: Teacher[];
  cabinets: Cabinet[];
  activeDays: number[];
  schedGroups: GMap;
  slots: TimeSlot[];
  cellDateIso: string;
  defaultLevel?: string;
  onDone: () => void;
  onCancel: () => void;
}

type OverrideOpts = { cabinet?: boolean; student?: boolean; teacher?: boolean; newHistory?: boolean };

function StatusBadge({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      marginTop: 4, fontSize: 11, fontWeight: 600,
      color: ok ? '#2E7D32' : '#C62828',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: ok ? '#4CAF50' : '#EF5350', display: 'inline-block',
      }} />
      {text}
    </div>
  );
}

export default function CreateGroupForm({
  ci, sid, slot, teachers, cabinets, activeDays,
  schedGroups, slots, cellDateIso, defaultLevel, onDone, onCancel,
}: Props) {
  const selfRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    setTimeout(() => selfRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }, []);

  const [newGrp, setNewGrp] = useState({
    studentGroupId: '',
    cabinetId: '',
    lv: defaultLevel || LEVELS[2],
    grammarTeacherId: '',
    grammarDays: [ci] as number[],
    clubTeacherId: '',
    clubDays: [] as number[],
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflictWarning, setConflictWarning] = useState<{ message: string; confirmLabel?: string; onConfirm: () => void; extraAction?: { label: string; onClick: () => void } } | null>(null);
  const [studentGroups, setStudentGroups] = useState<StudentGroup[]>([]);
  const [showGroupModal, setShowGroupModal] = useState(false);

  useEffect(() => {
    api.get('/groups?status=ACTIVE').then(res => {
      if (mountedRef.current) setStudentGroups(res.data?.data ?? []);
    });
  }, []);

  const navigate = useNavigate();
  const location = useLocation();

  // Resume after the "Выбрать группу" round-trip: restore the stashed draft and
  // apply the picked group + its teachers. Only consume a stash that was
  // confirmed (has .picked) and belongs to this exact cell.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(GROUP_PICK_KEY);
      if (!raw) return;
      const stash = JSON.parse(raw);
      if (!stash?.picked || stash.mode === 'edit' || stash.ci !== ci || stash.sid !== sid) return;
      sessionStorage.removeItem(GROUP_PICK_KEY);
      const pickedDays = (v: unknown): number[] | null =>
        Array.isArray(v) && v.length > 0 ? v : null;
      const grammarDays: number[] = pickedDays(stash.picked.grammarDays) ?? stash.form.grammarDays;
      const clubDays: number[] = (pickedDays(stash.picked.clubDays) ?? stash.form.clubDays)
        .filter((d: number) => !grammarDays.includes(d));
      setNewGrp({
        ...stash.form,
        studentGroupId: String(stash.picked.id),
        lv: stash.picked.level || stash.form.lv,
        cabinetId: stash.picked.cabinetId != null ? String(stash.picked.cabinetId) : stash.form.cabinetId,
        grammarTeacherId: stash.picked.grammarTeacherId != null ? String(stash.picked.grammarTeacherId) : stash.form.grammarTeacherId,
        clubTeacherId: stash.picked.clubTeacherId != null ? String(stash.picked.clubTeacherId) : stash.form.clubTeacherId,
        grammarDays,
        clubDays,
      });
    } catch {
      sessionStorage.removeItem(GROUP_PICK_KEY);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goPickGroup = useCallback(() => {
    sessionStorage.setItem(GROUP_PICK_KEY, JSON.stringify({ mode: 'create', ci, sid, cellDateIso, form: newGrp }));
    navigate(`${location.pathname.replace(/\/schedule$/, '/groups')}?pick=1`);
  }, [ci, sid, cellDateIso, newGrp, navigate, location.pathname]);

  const lbl: React.CSSProperties = { fontSize: 11, color: C.mid, display: 'block', marginBottom: 3 };

  const selectedCabinet = newGrp.cabinetId ? cabinets.find(c => String(c.id) === newGrp.cabinetId) : null;
  const selectedGroup = newGrp.studentGroupId ? studentGroups.find(g => String(g.id) === newGrp.studentGroupId) : null;

  const existingBlocks = Object.values(schedGroups).filter(
    g => g.studentGroupId === (newGrp.studentGroupId ? parseInt(newGrp.studentGroupId) : null)
  );

  let capacityStatus: 'ok' | 'warning' | 'danger' | null = null;
  let capacityText = '';
  if (selectedCabinet && selectedGroup) {
    const realStudents = selectedGroup._count?.students || 0;
    const capacity = selectedCabinet.capacity;
    if (realStudents > capacity) {
      capacityStatus = 'danger';
      capacityText = `Мест не хватает (${realStudents}/${capacity})`;
    } else if (realStudents === capacity) {
      capacityStatus = 'warning';
      capacityText = `Впритык (${realStudents}/${capacity})`;
    } else {
      capacityStatus = 'ok';
      capacityText = `Вместимость в норме (${realStudents}/${capacity})`;
    }
  }

  const allFormDays = useMemo(() => {
    const d = new Set([...newGrp.grammarDays, ...newGrp.clubDays]);
    return [...d].sort();
  }, [newGrp.grammarDays, newGrp.clubDays]);
  const conflictDateOptions = useMemo(() => ({ targetStartDate: cellDateIso }), [cellDateIso]);

  const cabinetConflicts = useMemo((): ScheduleConflict[] => {
    const cid = newGrp.cabinetId ? parseInt(newGrp.cabinetId) : 0;
    if (!cid || allFormDays.length === 0 || !slot?.s || !slot?.e) return [];
    return findCabinetConflicts(cid, allFormDays, slot.s, slot.e, schedGroups, [], conflictDateOptions);
  }, [newGrp.cabinetId, allFormDays, slot, schedGroups, conflictDateOptions]);

  const grammarTeacherConflicts = useMemo((): ScheduleConflict[] => {
    const tid = newGrp.grammarTeacherId ? parseInt(newGrp.grammarTeacherId) : 0;
    if (!tid || newGrp.grammarDays.length === 0 || !slot?.s || !slot?.e) return [];
    return findTeacherConflicts(tid, newGrp.grammarDays, slot.s, slot.e, schedGroups, [], conflictDateOptions)
      .filter(c => c.severity === 'critical');
  }, [newGrp.grammarTeacherId, newGrp.grammarDays, slot, schedGroups, conflictDateOptions]);

  const clubTeacherConflicts = useMemo((): ScheduleConflict[] => {
    const tid = newGrp.clubTeacherId ? parseInt(newGrp.clubTeacherId) : 0;
    if (!tid || newGrp.clubDays.length === 0 || !slot?.s || !slot?.e) return [];
    return findTeacherConflicts(tid, newGrp.clubDays, slot.s, slot.e, schedGroups, [], conflictDateOptions)
      .filter(c => c.severity === 'critical');
  }, [newGrp.clubTeacherId, newGrp.clubDays, slot, schedGroups, conflictDateOptions]);

  const studentGroupConflicts = useMemo((): ScheduleConflict[] => {
    const gid = newGrp.studentGroupId ? parseInt(newGrp.studentGroupId) : 0;
    if (!gid || allFormDays.length === 0 || !slot?.s || !slot?.e) return [];
    return findStudentGroupConflicts(gid, allFormDays, slot.s, slot.e, schedGroups, [], conflictDateOptions);
  }, [newGrp.studentGroupId, allFormDays, slot, schedGroups, conflictDateOptions]);

  const intraDayConflictCreate = useMemo(() =>
    findIntraDayConflict(newGrp.grammarDays, newGrp.clubDays),
  [newGrp.grammarDays, newGrp.clubDays]);

  const hasCriticalConflict = useMemo(() => {
    if (intraDayConflictCreate !== null) return true;
    const all = [...cabinetConflicts, ...grammarTeacherConflicts, ...clubTeacherConflicts, ...studentGroupConflicts];
    return getConflictSeverity(all) === 'critical';
  }, [intraDayConflictCreate, cabinetConflicts, grammarTeacherConflicts, clubTeacherConflicts, studentGroupConflicts]);

  const freeCabinetsInSlot = useMemo(() => {
    if (!cabinetConflicts.length || allFormDays.length === 0 || !slot) return [];
    const currentCabId = newGrp.cabinetId ? parseInt(newGrp.cabinetId) : 0;
    return cabinets.filter(cab => {
      if (cab.id === currentCabId) return false;
      return findCabinetConflicts(cab.id, allFormDays, slot.s, slot.e, schedGroups, [], conflictDateOptions).length === 0;
    });
  }, [cabinetConflicts.length, cabinets, allFormDays, slot, schedGroups, newGrp.cabinetId, conflictDateOptions]);

  type SlotSuggestion = { slot: TimeSlot; cabinet: Cabinet; teacherNote: string };
  const crossSlotSuggestions = useMemo((): SlotSuggestion[] => {
    if (!hasCriticalConflict || allFormDays.length === 0) return [];
    const preferCabId = newGrp.cabinetId ? parseInt(newGrp.cabinetId) : 0;
    const grammarTid = newGrp.grammarTeacherId ? parseInt(newGrp.grammarTeacherId) : 0;
    const clubTid = newGrp.clubTeacherId ? parseInt(newGrp.clubTeacherId) : 0;
    const sgid = newGrp.studentGroupId ? parseInt(newGrp.studentGroupId) : 0;

    const results: SlotSuggestion[] = [];
    for (const s of slots) {
      if (s.id === sid) continue;
      const cabsToTry = preferCabId
        ? [cabinets.find(c => c.id === preferCabId), ...cabinets.filter(c => c.id !== preferCabId)].filter((c): c is Cabinet => Boolean(c))
        : cabinets;
      for (const cab of cabsToTry) {
        if (findCabinetConflicts(cab.id, allFormDays, s.s, s.e, schedGroups, [], conflictDateOptions).length > 0) continue;
        const gDays = newGrp.grammarDays.length ? newGrp.grammarDays : allFormDays;
        const cDays = newGrp.clubDays.length ? newGrp.clubDays : allFormDays;
        const gFree = !grammarTid || findTeacherConflicts(grammarTid, gDays, s.s, s.e, schedGroups, [], conflictDateOptions).filter(c => c.severity === 'critical').length === 0;
        const cFree = !clubTid || findTeacherConflicts(clubTid, cDays, s.s, s.e, schedGroups, [], conflictDateOptions).filter(c => c.severity === 'critical').length === 0;
        const sgFree = !sgid || findStudentGroupConflicts(sgid, allFormDays, s.s, s.e, schedGroups, [], conflictDateOptions).filter(c => c.severity === 'critical').length === 0;
        if (!gFree || !cFree || !sgFree) continue;
        const notes = [grammarTid && 'учитель гр. свободен', clubTid && 'учитель кл. свободен'].filter(Boolean).join(', ');
        results.push({ slot: s, cabinet: cab, teacherNote: notes || 'кабинет свободен' });
        break;
      }
      if (results.length >= 3) break;
    }
    return results;
  }, [hasCriticalConflict, allFormDays, slots, sid, cabinets, schedGroups,
      newGrp.cabinetId, newGrp.grammarTeacherId, newGrp.grammarDays, newGrp.clubTeacherId, newGrp.clubDays, newGrp.studentGroupId, conflictDateOptions]);

  const createGroup = useCallback(async (overrides: OverrideOpts = {}) => {
    if (!slot) return;
    const hasGrammar = newGrp.grammarDays.length > 0;
    if (!hasGrammar) {
      setSaveError('Выберите хотя бы один день для Грамматики');
      return;
    }
    if (!newGrp.cabinetId) {
      setSaveError('Выберите кабинет');
      return;
    }
    if (!newGrp.grammarTeacherId) {
      setSaveError('Укажите учителя для Грамматики');
      return;
    }
    if (!newGrp.studentGroupId) {
      setSaveError('Выберите группу из списка');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const cab = newGrp.cabinetId ? cabinets.find(c => String(c.id) === newGrp.cabinetId) : null;
      await api.post('/schedule/group-pair', {
        studentGroupId: parseInt(newGrp.studentGroupId),
        timeSlotId: sid > 0 ? sid : undefined,
        startTime: slot.s,
        endTime: slot.e,
        targetDate: cellDateIso,
        cabinetId: parseInt(newGrp.cabinetId),
        level: newGrp.lv,
        chapter: 1,
        maxStudents: cab?.capacity ?? 15,
        grammarTeacherId: newGrp.grammarTeacherId ? parseInt(newGrp.grammarTeacherId) : null,
        grammarDays: newGrp.grammarDays,
        clubTeacherId: newGrp.clubTeacherId ? parseInt(newGrp.clubTeacherId) : null,
        clubDays: newGrp.clubDays,
        startDate: cellDateIso,
        overrideCabinetConflict: overrides.cabinet,
        overrideTeacherConflict: overrides.teacher,
        overrideStudentConflict: overrides.student,
        confirmNewHistory: overrides.newHistory,
      }, { timeout: SAVE_TIMEOUT_MS });
      if (mountedRef.current) onDone();
    } catch (err: any) {
      if (!mountedRef.current) return;
      if (err.code === 'ECONNABORTED') {
        setSaveError('Сервер слишком долго сохраняет расписание. Проверьте backend и попробуйте ещё раз.');
        return;
      }
      const msg = err.response?.data?.error ?? err.message ?? 'Ошибка создания группы';
      const code = err.response?.data?.code;
      if (code === 'HISTORICAL_POLICY_READ_ONLY' || code === 'TIME_SLOT_NOT_WRITABLE') {
        setSaveError('Историческая сетка доступна только для просмотра.');
        return;
      }
      if (code === 'TIME_SLOT_TIME_MISMATCH' || code === 'TIME_SLOT_NOT_FOUND' || code === 'TIME_SLOT_SCHOOL_MISMATCH') {
        setSaveError('Сетка расписания обновилась. Выберите слот заново.');
        return;
      }
      if (code === 'GROUP_ALREADY_IN_SCHEDULE') {
        setSaveError(msg);
        return;
      }
      if (code === 'GROUP_HAS_ARCHIVED_HISTORY') {
        setConflictWarning({
          message: err.response?.data?.message ?? msg,
          confirmLabel: 'Создать новую историю',
          onConfirm: () => createGroup({ ...overrides, newHistory: true }),
        });
        return;
      }
      if (typeof msg === 'string' && msg.startsWith('GRAMMAR_CLUB_DAY_CONFLICT:')) {
        setSaveError(msg.replace('GRAMMAR_CLUB_DAY_CONFLICT:', ''));
        return;
      }
      if (typeof msg === 'string' && (msg.includes('слот') || msg.includes('СЃР»РѕС‚'))) {
        setSaveError('Сетка расписания обновилась. Выберите слот заново.');
        return;
      }
      const WARNING_PREFIXES = ['CAPACITY_WARNING:', 'TEACHER_CONFLICT_WARNING:'];
      const matchedPrefix = typeof msg === 'string' ? WARNING_PREFIXES.find(p => msg.startsWith(p)) : null;
      if (matchedPrefix) {
        const conflictMessage = msg.replace(matchedPrefix, '');
        const teacherId = matchedPrefix === 'TEACHER_CONFLICT_WARNING:'
          ? findTeacherIdInMessage(conflictMessage, teachers)
          : null;
        setConflictWarning({
          message: conflictMessage,
          confirmLabel: 'Всё равно сохранить',
          onConfirm: () => createGroup({ ...overrides, cabinet: true, student: true, teacher: true }),
          extraAction: teacherId ? {
            label: 'Открыть карточку учителя',
            onClick: () => {
              onCancel();
              navigate(teacherCardPath(location.pathname, teacherId));
            },
          } : undefined,
        });
        return;
      }
      setSaveError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, newGrp, sid, cabinets, cellDateIso, onDone]);

  return (
    <>
      <div ref={selfRef} style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, background: C.bgOff }}>
        <div style={{ display: 'grid', gap: 10 }}>
          {/* Cabinet */}
          <div style={{ background: '#fff', borderRadius: 8, padding: '10px 12px', border: `1px solid ${C.border}` }}>
            <label style={lbl}>Кабинет *</label>
            <CabinetAvailabilitySelect
              value={newGrp.cabinetId}
              onChange={v => setNewGrp(p => ({ ...p, cabinetId: v }))}
              cabinets={cabinets}
              days={allFormDays}
              startTime={slot?.s ?? ''}
              endTime={slot?.e ?? ''}
              schedGroups={schedGroups}
              conflictOptions={conflictDateOptions}
            />
            {cabinetConflicts.length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <ConflictList conflicts={cabinetConflicts} />
                {freeCabinetsInSlot.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, color: C.mid, flexShrink: 0 }}>Свободно в этом слоте:</span>
                    {freeCabinetsInSlot.map(cab => (
                      <button
                        key={cab.id}
                        type="button"
                        onClick={() => setNewGrp(p => ({ ...p, cabinetId: String(cab.id) }))}
                        style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                          background: '#E8F5E9', color: '#2D6A4F',
                          border: '1px solid #A5D6A7', fontWeight: 700,
                        }}
                      >
                        {cab.name} ({cab.capacity} мест)
                      </button>
                    ))}
                  </div>
                )}
                {freeCabinetsInSlot.length === 0 && (
                  <div style={{ fontSize: 10, color: C.mid, fontStyle: 'italic' }}>
                    Нет свободных кабинетов в это время
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Grammar */}
          <div style={{ background: C.greenLight, borderRadius: 8, padding: '10px 12px', border: '1px solid #a5d6a7' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.green, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Грамматика</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center' }}>
              <TeacherAvailabilitySelect
                value={newGrp.grammarTeacherId}
                onChange={v => setNewGrp(p => ({ ...p, grammarTeacherId: v }))}
                teachers={teachers}
                days={newGrp.grammarDays}
                startTime={slot?.s ?? ''}
                endTime={slot?.e ?? ''}
                schedGroups={schedGroups}
                targetDate={cellDateIso}
                placeholder="— Выберите учителя —"
              />
              <DaySelector
                value={newGrp.grammarDays}
                onChange={v => setNewGrp(p => ({
                  ...p,
                  grammarDays: v,
                  clubDays: p.clubDays.filter(d => !v.includes(d)),
                }))}
                activeDays={activeDays}
                variant="grammar"
              />
            </div>
            <ConflictList conflicts={grammarTeacherConflicts} style={{ marginTop: 8 }} />
          </div>

          {/* Club */}
          <div style={{ background: C.blueLight, borderRadius: 8, padding: '10px 12px', border: '1px solid #90caf9' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.blue, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Разговорный клуб (необязательно)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center' }}>
              <TeacherAvailabilitySelect
                value={newGrp.clubTeacherId}
                onChange={v => setNewGrp(p => ({ ...p, clubTeacherId: v }))}
                teachers={teachers}
                days={newGrp.clubDays}
                startTime={slot?.s ?? ''}
                endTime={slot?.e ?? ''}
                schedGroups={schedGroups}
                targetDate={cellDateIso}
                allowEmpty
                placeholder="— Без учителя —"
              />
              <DaySelector
                value={newGrp.clubDays}
                onChange={v => setNewGrp(p => ({
                  ...p,
                  clubDays: v,
                  grammarDays: p.grammarDays.filter(d => !v.includes(d)),
                }))}
                activeDays={activeDays}
                variant="club"
              />
            </div>
            <ConflictList conflicts={clubTeacherConflicts} style={{ marginTop: 8 }} />
            {intraDayConflictCreate && (
              <ConflictList conflicts={[intraDayConflictCreate]} style={{ marginTop: 8 }} />
            )}
          </div>

          {/* Student group */}
          <div style={{ background: '#fff', borderRadius: 8, padding: '10px 12px', border: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <label style={{ ...lbl, marginBottom: 0 }}>Группа *</label>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" onClick={goPickGroup} style={{ background: 'none', border: 'none', color: C.primary, fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: 0 }}>Выбрать группу</button>
                <button type="button" onClick={() => setShowGroupModal(true)} style={{ background: 'none', border: 'none', color: C.primary, fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: 0 }}>+ Создать новую</button>
              </div>
            </div>
            <GroupAvailabilitySelect
              value={newGrp.studentGroupId}
              onChange={(gid, grp) => setNewGrp(p => ({ ...p, studentGroupId: gid, lv: grp ? grp.level : p.lv }))}
              groups={studentGroups}
              days={allFormDays}
              startTime={slot?.s ?? ''}
              endTime={slot?.e ?? ''}
              schedGroups={schedGroups}
              conflictOptions={conflictDateOptions}
            />
            {newGrp.studentGroupId && selectedGroup && (
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                <div style={{ fontSize: 11, color: C.primary }}>✓ {selectedGroup._count?.students || 0} студентов · {selectedGroup.level}</div>
                {capacityStatus && (
                  <div style={{
                    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                    background: capacityStatus === 'danger' ? '#ffebee' : capacityStatus === 'warning' ? '#fff8e1' : '#e8f5e9',
                    color: capacityStatus === 'danger' ? '#d32f2f' : capacityStatus === 'warning' ? '#f57f17' : '#2e7d32',
                  }}>
                    {capacityText}
                  </div>
                )}
              </div>
            )}
            <ConflictList conflicts={studentGroupConflicts} style={{ marginTop: 8 }} />
            {newGrp.studentGroupId && slot && allFormDays.length > 0 && studentGroupConflicts.length === 0 && (
              existingBlocks.length > 0 ? (
                <div style={{ marginTop: 4, fontSize: 11, color: C.mid, background: C.bgLight, borderRadius: 6, padding: '5px 8px' }}>
                  ℹ Группа уже в расписании в другое время — конфликта нет
                </div>
              ) : (
                <StatusBadge ok text="Группа свободна" />
              )
            )}
          </div>

          {saveError && (
            <div style={{ fontSize: 12, color: C.red, background: C.redLight, borderRadius: 6, padding: '6px 10px' }}>
              {saveError}
            </div>
          )}
        </div>

        {crossSlotSuggestions.length > 0 && (
          <div style={{ background: '#E3F2FD', border: '1px solid #90CAF9', borderRadius: 8, padding: '8px 12px', marginTop: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#1565C0', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Попробуйте другой слот
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {crossSlotSuggestions.map((sg, i) => (
                <div key={i} style={{ fontSize: 11, color: '#1565C0', display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontWeight: 700, background: '#BBDEFB', borderRadius: 3, padding: '1px 5px' }}>{sg.slot.s}–{sg.slot.e}</span>
                  <span style={{ color: '#1976D2' }}>·</span>
                  <span style={{ fontWeight: 600 }}>{sg.cabinet.name}</span>
                  <span style={{ color: '#1976D2' }}>·</span>
                  <span style={{ opacity: 0.75 }}>{sg.teacherNote}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            onClick={() => createGroup()}
            disabled={saving || hasCriticalConflict}
            title={hasCriticalConflict ? 'Устраните конфликты перед сохранением' : undefined}
            style={{
              flex: 1, padding: '7px 0', border: 'none', borderRadius: 7,
              fontSize: 13, fontWeight: 700,
              cursor: saving || hasCriticalConflict ? 'not-allowed' : 'pointer',
              background: saving || hasCriticalConflict
                ? C.bgLight
                : capacityStatus === 'danger'
                  ? '#d32f2f'
                  : existingBlocks.length > 0
                    ? '#F57F17'
                    : C.primary,
              color: saving || hasCriticalConflict ? C.mid : '#fff',
              opacity: hasCriticalConflict ? 0.6 : 1,
            }}
          >
            {saving ? 'Сохранение...' : hasCriticalConflict ? 'Конфликт — нельзя сохранить' : existingBlocks.length > 0 ? 'Все равно добавить' : 'Добавить блок'}
          </button>
          <button
            onClick={onCancel}
            style={{ padding: '7px 14px', background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, cursor: 'pointer', color: C.mid }}
          >
            Отмена
          </button>
        </div>
      </div>

      <GroupEditorModal
        open={showGroupModal}
        onClose={() => setShowGroupModal(false)}
        defaultLevel={newGrp.lv}
        onSuccess={(newGroup) => {
          if (!mountedRef.current) return;
          setStudentGroups(prev => [newGroup, ...prev]);
          setNewGrp(p => ({ ...p, studentGroupId: String(newGroup.id), lv: newGroup.level }));
          toast.success(`Создана группа "${newGroup.level}" — выбрана для блока. Сейчас в ней 0 студентов.`);
        }}
      />
      {conflictWarning && (
        <ConflictWarningModal
          message={conflictWarning.message}
          confirmLabel={conflictWarning.confirmLabel}
          onConfirm={() => { setConflictWarning(null); conflictWarning.onConfirm(); }}
          onCancel={() => setConflictWarning(null)}
          extraAction={conflictWarning.extraAction}
        />
      )}
    </>
  );
}
