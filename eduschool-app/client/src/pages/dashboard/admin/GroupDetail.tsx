import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router';
import api from '../../../lib/api';
import { Users, X, Plus, ArrowUpRight, BookOpen, ChevronLeft, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';

import { Spinner } from '../../../components/ui/Spinner';
import StudentPicker, { ApiStudent } from '../../../components/schedule/StudentPicker';
import DaySelector from '../../../components/schedule/DaySelector';
import { DAYS_SHORT } from '../../../components/schedule/scheduleTypes';
import { useConfirm } from '../../../hooks/useConfirm';
import { usePermissions } from '../../../hooks/usePermissions';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../../hooks/useBackButtonClose';
import GroupActionModal from '../../../components/ui/GroupActionModal';
import { StudentProfileModal, Student as ModalStudent } from './Students';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Student {
  id: number;        // StudentProfile.id
  userId: number;
  level: string;
  credits: number;
  isFrozen: boolean;
  paidUntil: string | null;
  user: { id: number; firstName: string; lastName: string; email: string; phone?: string | null };
}

interface Block {
  id: number;
  type: 'GRAMMAR' | 'SPEAKING_CLUB';
  days: number[];   // 0=Пн .. 6=Вс (LessonBlock.days Int[])
  startTime: string;
  endTime: string;
  teacher?: { userId: number; user: { firstName: string; lastName: string } } | null;
  cabinet?: { id: number; name: string } | null;
}

interface Group {
  id: number;
  name: string;
  level: string;
  chapter: number;
  maxStudents: number;
  status: 'ACTIVE' | 'COMPLETED' | 'PAUSED';
  comment?: string | null;
  students: Student[];
  blocks: Block[];
  _count: { students: number };
}

const LEVELS = [
  'Beginner', 'Elementary', 'Pre-Intermediate',
  'Intermediate', 'Upper-Intermediate', 'Advanced',
];

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Активна', COMPLETED: 'Завершена', PAUSED: 'Пауза',
};
const STATUS_VARIANT: Record<string, 'success' | 'info' | 'frozen'> = {
  ACTIVE: 'success', COMPLETED: 'info', PAUSED: 'frozen',
};
const BLOCK_TYPE_LABEL: Record<string, string> = {
  GRAMMAR: 'Грамматика', SPEAKING_CLUB: 'Спикинг-клуб',
};

function initials(name: string) {
  return name.split(' ').map(p => p[0] ?? '').join('').toUpperCase().slice(0, 2);
}

function dayNames(days: number[]) {
  return [...days].sort((a, b) => a - b).map(d => DAYS_SHORT[d]).join(' ') || '—';
}

// Teacher + the days they actually teach — same grammar(green)/club(blue) split as the schedule popup.
function BlockTeacherPill({ block }: { block: Block }) {
  const isClub = block.type === 'SPEAKING_CLUB';
  const teacherName = block.teacher
    ? `${block.teacher.user.firstName} ${block.teacher.user.lastName}`
    : 'не назначен';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-md border ${
      isClub
        ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#0369A1]'
        : 'bg-[#F0FDF4] border-[#BBF7D0] text-[#15803D]'
    }`}>
      <span className="font-semibold">{isClub ? 'Кл' : 'Гр'}: {teacherName}</span>
      <span className="opacity-70">· {dayNames(block.days)}</span>
    </span>
  );
}

// Status derived from BALANCE (credits) — single source of truth, matching the
// server filter and Students.tsx. paidUntil is display-only.
function stuStatus(s: { isFrozen: boolean; credits: number }): 'active' | 'overdue' | 'paused' {
  if (s.isFrozen) return 'paused';
  if (s.credits <= 0) return 'overdue';
  return 'active';
}

function toModalStudent(s: Student, group: Group): ModalStudent {
  const firstBlock = group.blocks[0];
  return {
    id: s.user.id,
    studentProfileId: s.id,
    name: `${s.user.firstName} ${s.user.lastName}`,
    phone: s.user.phone ?? '',
    email: s.user.email,
    level: s.level || group.level,
    cabinet: firstBlock?.cabinet?.name ?? '',
    time: firstBlock ? `${firstBlock.startTime}–${firstBlock.endTime}` : '',
    credits: s.credits ?? 0,
    paidUntil: s.paidUntil ? new Date(s.paidUntil).toISOString().slice(0, 10) : null,
    paused: s.isFrozen,
    comment: '',
    lessonType: 'all' as const,
    archivedAt: null,
    deletedAt: null,
  };
}

// ─── AddStudentModal ──────────────────────────────────────────────────────────

function AddStudentModal({ group, onClose, onAdded }: {
  group: Group; onClose: () => void; onAdded: () => void;
}) {
  const [adding, setAdding] = useState<number | null>(null);
  const existingIds = new Set(group.students.map(s => s.id));
  const { confirm, ConfirmDialog } = useConfirm();

  useBodyScrollLock();
  useBackButtonClose(true, onClose);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  async function addStudent(student: ApiStudent) {
    if (!student.studentProfile) return;
    const profileId = student.studentProfile.id;

    const existingGroups = student.studentProfile.enrolledGroups ?? [];
    if (existingGroups.length > 0) {
      const names = existingGroups.map(g => g.level).join(', ');
      const ok = await confirm({
        title: 'Студент уже в группе',
        message: `${student.firstName} ${student.lastName} уже состоит в группе: ${names}.\n\nДобавить в «${group.level}» тоже?`,
        confirmText: 'Добавить',
        isDanger: false,
      });
      if (!ok) return;
    }

    setAdding(profileId);
    const tryAdd = async (overrideCapacity = false) => {
      try {
        await api.post(`/groups/${group.id}/students`, { studentProfileIds: [profileId], overrideCapacity });
        toast.success('Добавлен');
        onAdded();
      } catch (e: any) {
        const msg = e.response?.data?.error;
        if (typeof msg === 'string' && msg.startsWith('CAPACITY_WARNING:')) {
          const cleanMsg = msg.replace('CAPACITY_WARNING:', '');
          const ok = await confirm({
            title: 'Превышение вместимости',
            message: cleanMsg + '\n\nВсё равно добавить?',
            confirmText: 'Добавить',
            isDanger: false,
          });
          if (ok) await tryAdd(true);
          return;
        }

        const data = e.response?.data;
        if (data?.conflicts?.length) {
          const detail = data.conflicts
            .map((c: { studentName: string; conflictInfo: string }) => `• ${c.studentName}: ${c.conflictInfo}`)
            .join('\n');
          toast.error(`Конфликт расписания:\n${detail}`, { duration: 6000 });
        } else {
          toast.error(data?.error || 'Ошибка');
        }
      } finally {
        if (!overrideCapacity) setAdding(null);
      }
    };
    await tryAdd();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-background rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[90dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-border flex items-center justify-between">
          <h3 className="font-serif text-lg">Добавить студентов</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surfaceLow"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 flex-1 space-y-4 min-h-[300px]">
          <p className="text-xs text-textSecondary">Выберите студента из списка или начните вводить имя:</p>
          <StudentPicker
            selectedIds={new Set()}
            excludeIds={existingIds}
            onAdd={addStudent}
            onRemove={() => {}}
          />
          {adding !== null && <div className="text-center py-2"><Spinner size="sm" /></div>}
        </div>
        <div className="p-5 border-t border-border flex justify-end">
          <Button variant="outline" onClick={onClose}>Закрыть</Button>
        </div>
      </div>
      {ConfirmDialog}
    </div>
  );
}

// ─── GroupDetail Page ─────────────────────────────────────────────────────────

export default function GroupDetail() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { canArchiveGroup } = usePermissions();

  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'students' | 'schedule'>('students');
  const [editing, setEditing] = useState(false);
  const [showAddStudent, setShowAddStudent] = useState(false);
  const [showActionModal, setShowActionModal] = useState(false);
  const [profileStudent, setProfileStudent] = useState<ModalStudent | null>(null);
  const [editMax, setEditMax] = useState('');
  const [editComment, setEditComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [teachers, setTeachers] = useState<{ id: number; firstName: string; lastName: string }[]>([]);
  const [activeDays, setActiveDays] = useState<number[]>([0, 1, 2, 3, 4, 5]);
  // Single pair editor — both teachers (grammar + club) + their days at once, like the schedule.
  // Explicit Save (No Autosave policy).
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [gTeacher, setGTeacher] = useState('');
  const [gDays, setGDays] = useState<number[]>([]);
  const [cTeacher, setCTeacher] = useState('');
  const [cDays, setCDays] = useState<number[]>([]);

  const backUrl = location.pathname.replace(/\/\d+$/, '');
  const scheduleUrl = location.pathname.replace(/\/groups\/\d+$/, '/schedule');

  // Jump to the schedule page and open the exact slot this block lives in.
  function openInSchedule(b: Block) {
    if (!group) return;
    const params = new URLSearchParams({
      openGroupId: String(group.id),
      openBlockId: String(b.id),
      openStart: b.startTime,
      openEnd: b.endTime,
    });
    navigate(`${scheduleUrl}?${params.toString()}`);
  }

  const isActive = group?.status === 'ACTIVE';
  const canMutateSchedule = isActive;
  const canMutateStudents = isActive;
  const canMutateMaxStudents = isActive;

  const fetchGroup = useCallback(async () => {
    try {
      const res = await api.get(`/groups/${groupId}`);
      const g: Group = res.data.data;
      setGroup(g);
      setEditMax(String(g.maxStudents));
      setEditComment(g.comment ?? '');
    } catch {
      toast.error('Не удалось загрузить группу');
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { fetchGroup(); }, [fetchGroup]);

  // Teacher list + school working days for the editor.
  // Working days come from the SAME source the schedule grid reads: the current active
  // SchoolSchedulePolicy via GET /settings/timeslots?date. That policy (edited only through
  // Settings → PATCH /settings) is the single source of truth — change the working days there
  // and this picker follows automatically.
  useEffect(() => {
    api.get('/users?role=TEACHER')
      .then(res => { const ts = res.data?.data; if (Array.isArray(ts)) setTeachers(ts); })
      .catch(() => { /* editor degrades to read-only names */ });
    const today = new Date().toISOString().slice(0, 10);
    api.get('/settings/timeslots', { params: { date: today } })
      .then(res => { const d = res.data?.data?.activeDays; if (Array.isArray(d) && d.length) setActiveDays(d); })
      .catch(() => { /* fall back to the initial default below */ });
  }, []);

  const grammarBlock = group?.blocks.find(b => b.type !== 'SPEAKING_CLUB');
  const clubBlock = group?.blocks.find(b => b.type === 'SPEAKING_CLUB');

  function startEditSchedule() {
    setGTeacher(String(grammarBlock?.teacher?.userId ?? ''));
    setGDays([...(grammarBlock?.days ?? [])]);
    setCTeacher(String(clubBlock?.teacher?.userId ?? ''));
    setCDays([...(clubBlock?.days ?? [])]);
    setEditingSchedule(true);
  }

  // Save BOTH teachers + their days in one go through the same group-pair endpoint the
  // schedule uses, so both views stay in sync (they read the same LessonBlocks). Cabinet,
  // time and student dimensions are unchanged so their conflicts are pre-overridden.
  // ponytail: group-owned blocks MUST go through group-pair (PUT /schedule/:id rejects them),
  // so we reconstruct the full pair payload rather than patching one field.
  async function saveSchedule(overrideTeacherConflict = false) {
    if (!group) return;
    const base = grammarBlock ?? clubBlock;
    if (!base) return;
    if (gDays.length === 0) {
      toast.error('Выберите хотя бы один день для грамматики');
      return;
    }

    setSavingSchedule(true);
    try {
      await api.put(`/schedule/group-pair/${group.id}`, {
        grammarBlockId: grammarBlock?.id,
        clubBlockId: clubBlock?.id,
        startTime: base.startTime,
        endTime: base.endTime,
        cabinetId: base.cabinet?.id ?? null,
        level: group.level,
        chapter: group.chapter,
        maxStudents: group.maxStudents,
        grammarTeacherId: gTeacher ? parseInt(gTeacher) : null,
        grammarDays: gDays,
        clubTeacherId: cTeacher ? parseInt(cTeacher) : null,
        clubDays: clubBlock ? cDays : [],
        overrideCabinetConflict: true,
        overrideStudentConflict: true,
        overrideTeacherConflict,
      });
      toast.success('Сохранено');
      setEditingSchedule(false);
      fetchGroup();
    } catch (e: any) {
      const msg = e.response?.data?.error;
      if (typeof msg === 'string' && msg.startsWith('TEACHER_CONFLICT_WARNING:')) {
        if (confirm(msg.replace('TEACHER_CONFLICT_WARNING:', '') + '\n\nВсё равно сохранить?')) {
          await saveSchedule(true);
          return;
        }
      } else if (typeof msg === 'string' && msg.includes(':')) {
        // strip server prefixes like GRAMMAR_CLUB_DAY_CONFLICT: for a clean toast
        toast.error(msg.split(':').slice(1).join(':').trim() || msg);
      } else {
        toast.error(msg || 'Не удалось сохранить');
      }
    } finally {
      setSavingSchedule(false);
    }
  }

  async function saveEdit() {
    if (!group) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { comment: editComment.trim() || null };
      // maxStudents is structural — only send for ACTIVE groups
      if (canMutateMaxStudents) payload.maxStudents = parseInt(editMax) || 15;
      await api.put(`/groups/${group.id}`, payload);
      toast.success('Сохранено');
      setEditing(false);
      fetchGroup();
    } catch (e: any) {
      toast.error(e.response?.data?.error || 'Ошибка');
    } finally { setSaving(false); }
  }

  async function removeStudent(studentProfileId: number) {
    if (!group) return;
    try {
      await api.delete(`/groups/${group.id}/students/${studentProfileId}`);
      toast.success('Студент удалён из группы');
      fetchGroup();
    } catch { toast.error('Ошибка'); }
  }

  async function promoteLevel() {
    if (!group) return;
    const idx = LEVELS.indexOf(group.level);
    if (idx >= LEVELS.length - 1) { toast.error('Это уже максимальный уровень'); return; }
    const newLevel = LEVELS[idx + 1];
    if (!confirm(`Повысить группу до ${newLevel}?\n\nТекущая группа завершится сегодня, новая группа «${newLevel}» начнётся с завтрашнего дня со всеми студентами и расписанием.`)) return;
    try {
      const res = await api.post(`/groups/${group.id}/promote`, { newLevel });
      toast.success(`Группа повышена до ${newLevel}`);
      const newGroupId = res.data?.data?.newGroup?.id;
      if (newGroupId) {
        navigate(`${backUrl}/${newGroupId}`, { replace: true });
      } else {
        fetchGroup();
      }
    } catch (e: any) { toast.error(e.response?.data?.error || 'Ошибка'); }
  }

  async function changeChapter(delta: number) {
    if (!group) return;
    const next = group.chapter + delta;
    if (next < 1) return;
    try {
      await api.patch(`/groups/${group.id}/chapter`, { chapter: next });
      fetchGroup();
    } catch { toast.error('Ошибка'); }
  }

  async function completeGroupLifecycle() {
    if (!group) return;
    try {
      await api.post(`/groups/${group.id}/lifecycle/complete`);
      toast.success('Группа завершена');
      setShowActionModal(false);
      fetchGroup();
    } catch (e: any) { toast.error(e.response?.data?.error || 'Ошибка'); }
  }

  async function pauseGroupLifecycle() {
    if (!group) return;
    try {
      await api.post(`/groups/${group.id}/lifecycle/pause`);
      toast.success('Группа приостановлена');
      setShowActionModal(false);
      fetchGroup();
    } catch (e: any) { toast.error(e.response?.data?.error || 'Ошибка'); }
  }

  async function resumeGroupLifecycle() {
    if (!group) return;
    try {
      await api.post(`/groups/${group.id}/lifecycle/resume`);
      toast.success('Группа возобновлена');
      setShowActionModal(false);
      fetchGroup();
    } catch (e: any) { toast.error(e.response?.data?.error || 'Ошибка'); }
  }

  async function archiveGroupLifecycle() {
    if (!group) return;
    try {
      await api.post(`/groups/${group.id}/lifecycle/archive`);
      toast.success('Группа архивирована');
      navigate(backUrl, { replace: true });
    } catch (e: any) { toast.error(e.response?.data?.error || 'Ошибка'); }
  }

  async function deleteGroup() {
    if (!group) return;
    try {
      await api.delete(`/groups/${group.id}`);
      toast.success('Группа удалена');
      navigate(backUrl, { replace: true });
    } catch (e: any) { toast.error(e.response?.data?.error || 'Ошибка'); }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-32">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!group) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-32 text-textSecondary gap-4">
        <Users className="w-12 h-12 opacity-20" />
        <p className="text-sm">Группа не найдена</p>
        <Button variant="outline" size="sm" onClick={() => navigate(backUrl)}>
          Вернуться к списку
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-border/40">
        <button
          onClick={() => navigate(backUrl)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border hover:bg-surfaceLow transition-colors mr-1 text-sm text-textSecondary hover:text-textPrimary"
        >
          <ChevronLeft className="w-5 h-5" />
          Назад
        </button>
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Users className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-textPrimary truncate">{group.level}</p>
          <p className="text-xs text-textSecondary">
            Глава {group.chapter} · {group._count.students}/{group.maxStudents} студ.
          </p>
          {group.blocks.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {group.blocks.map(b => <BlockTeacherPill key={b.id} block={b} />)}
            </div>
          )}
          {group.comment && (
            <p className="text-xs text-textSecondary mt-1.5 whitespace-pre-wrap break-words">{group.comment}</p>
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex gap-2 px-6 py-3 border-b border-border/40 flex-wrap items-center">
        <Button size="sm" variant="outline" className="text-xs" onClick={() => setEditing(!editing)}>
          ✎ Редактировать
        </Button>
        {canArchiveGroup && (
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={promoteLevel}
            disabled={!canMutateSchedule}
            title={!canMutateSchedule ? `Повысить уровень можно только для активной группы (сейчас: ${STATUS_LABEL[group.status]})` : undefined}
          >
            <ArrowUpRight className="w-3 h-3 mr-1" />Повысить уровень
          </Button>
        )}
        <div className={`flex items-center gap-1 border rounded-lg overflow-hidden ${canMutateSchedule ? 'border-border' : 'border-border/40 opacity-40'}`}>
          <button
            onClick={() => changeChapter(-1)}
            disabled={!canMutateSchedule || group.chapter <= 1}
            className="px-2 py-1 text-xs text-textSecondary hover:bg-surfaceLow disabled:opacity-30 transition-colors"
            title={!canMutateSchedule ? 'Недоступно для неактивной группы' : undefined}
          >−</button>
          <span className="px-2 text-xs font-semibold text-textPrimary">Гл. {group.chapter}</span>
          <button
            onClick={() => changeChapter(1)}
            disabled={!canMutateSchedule}
            className="px-2 py-1 text-xs text-textSecondary hover:bg-surfaceLow disabled:opacity-30 transition-colors"
            title={!canMutateSchedule ? 'Недоступно для неактивной группы' : undefined}
          >+</button>
        </div>
        <Badge variant={STATUS_VARIANT[group.status]}>{STATUS_LABEL[group.status]}</Badge>
        {canArchiveGroup && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto text-xs text-danger border-danger/40 hover:bg-danger/10 hover:border-danger"
            onClick={() => setShowActionModal(true)}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" />Действия с группой
          </Button>
        )}
      </div>

      {/* Edit form — comment (any status) + maxStudents (ACTIVE only) */}
      {editing && (
        <div className="px-6 py-4 border-b border-border/40 space-y-3 bg-surfaceLowest">
          {canMutateMaxStudents && (
            <Input
              type="number"
              value={editMax}
              onChange={e => setEditMax(e.target.value)}
              placeholder="Макс. студентов"
            />
          )}
          <textarea
            value={editComment}
            onChange={e => setEditComment(e.target.value)}
            placeholder="Комментарий к группе"
            rows={3}
            maxLength={2000}
            className="w-full text-sm px-3 py-2 rounded-lg border border-border bg-background text-textPrimary placeholder:text-textSecondary focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" className="flex-1" onClick={saveEdit} disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Отмена</Button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-border/40 px-6 items-center justify-between">
        <div className="flex">
          {[
            { id: 'students', label: `Студенты (${group._count.students})` },
            { id: 'schedule', label: `Расписание (${group.blocks.length})` },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as any)}
              className={`py-3 px-1 mr-6 text-sm font-semibold border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-textSecondary hover:text-textPrimary'
              }`}
            >{t.label}</button>
          ))}
        </div>
        {tab === 'students' && canMutateStudents && (
          <Button variant="outline" size="sm" onClick={() => setShowAddStudent(true)}>
            <Plus className="w-4 h-4" />Добавить
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 w-full">
        {tab === 'students' && (
          <div className="bg-surfaceLowest rounded-xl border border-border/40 overflow-hidden">
            {/* Table header */}
            <div className="hidden md:grid grid-cols-[24px_1fr_130px_100px_110px_100px_36px] gap-3 px-4 py-3 border-b border-border/50 text-[10px] font-bold uppercase tracking-widest text-textSecondary">
              <span />
              <span>Студент</span>
              <span>Кабинет · Время</span>
              <span>Уровень</span>
              <span>Оплачено до</span>
              <span>Статус</span>
              <span />
            </div>

            {group.students.length === 0 && (
              <div className="text-center py-12 text-textSecondary">
                <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">Нет студентов в группе</p>
                {canMutateStudents && (
                  <Button size="sm" variant="outline" className="mt-4" onClick={() => setShowAddStudent(true)}>
                    Добавить студента
                  </Button>
                )}
              </div>
            )}

            {group.students.map(s => {
              const name = `${s.user.firstName} ${s.user.lastName}`;
              const status = stuStatus(s);
              const ini = initials(name);
              const avatarClass =
                status === 'overdue' ? 'bg-danger/20 text-danger' :
                status === 'paused'  ? 'bg-[#EFF6FF] text-[#0284C7]' :
                'bg-success/20 text-success';
              const firstBlock = group.blocks[0];
              const cabShort = `${firstBlock?.cabinet?.name ?? '—'} · ${firstBlock?.startTime ?? '—'}`;
              const paidStr = s.paidUntil
                ? new Date(s.paidUntil).toISOString().slice(0, 10)
                : null;

              return (
                <div
                  key={s.id}
                  onClick={() => setProfileStudent(toModalStudent(s, group))}
                  className="grid md:grid-cols-[24px_1fr_130px_100px_110px_100px_36px] grid-cols-1 gap-3 px-4 py-3.5 border-b border-border/30 last:border-0 cursor-pointer hover:bg-surfaceLow transition-colors items-center"
                >
                  {/* Avatar (desktop first col) */}
                  <div className="hidden md:flex items-center justify-center">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${avatarClass}`}>
                      {ini}
                    </div>
                  </div>

                  {/* Name + email */}
                  <div className="flex items-center gap-3">
                    <div className={`md:hidden w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${avatarClass}`}>
                      {ini}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-textPrimary truncate">{name}</p>
                      <p className="text-xs text-textSecondary truncate">{s.user.email}</p>
                      {/* Mobile extra info */}
                      <div className="md:hidden flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                        {(s.level || group.level) && <span className="text-xs text-textSecondary">{s.level || group.level}</span>}
                        {paidStr && (
                          <span className={`text-xs font-medium ${status === 'overdue' ? 'text-danger' : status === 'paused' ? 'text-[#0284C7]' : 'text-success'}`}>
                            до {paidStr}
                          </span>
                        )}
                        {status === 'paused'  && <Badge variant="frozen">На паузе</Badge>}
                        {status === 'overdue' && <Badge variant="danger">Просрочка</Badge>}
                        {status === 'active'  && <Badge variant="success">Активен</Badge>}
                      </div>
                    </div>
                  </div>

                  {/* Cabinet · Time */}
                  <span className="hidden md:block text-xs text-textSecondary truncate">{cabShort}</span>

                  {/* Level */}
                  <span className="hidden md:block text-xs text-textSecondary">{s.level || group.level || '—'}</span>

                  {/* Paid until */}
                  <span className={`hidden md:block text-xs font-medium ${status === 'overdue' ? 'text-danger' : status === 'paused' ? 'text-[#0284C7]' : 'text-success'}`}>
                    {paidStr || '—'}
                  </span>

                  {/* Status badge */}
                  <div className="hidden md:flex">
                    {status === 'paused'  && <Badge variant="frozen">На паузе</Badge>}
                    {status === 'overdue' && <Badge variant="danger">Просрочка</Badge>}
                    {status === 'active'  && <Badge variant="success">Активен</Badge>}
                  </div>

                  {/* Remove — only for active groups */}
                  {canMutateStudents ? (
                    <button
                      onClick={e => { e.stopPropagation(); removeStudent(s.id); }}
                      className="hidden md:flex p-1.5 rounded-lg text-textSecondary hover:text-danger hover:bg-danger/10 transition-colors items-center justify-center"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <span className="hidden md:block" />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === 'schedule' && (
          <div className="space-y-3">
            {group.blocks.length === 0 && (
              <div className="text-center py-12 text-textSecondary">
                <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">Нет блоков расписания</p>
                <p className="text-xs mt-1 text-textSecondary/70">Добавьте блоки через страницу Расписания</p>
              </div>
            )}

            {/* One editor for both teachers + their days at once (same as the schedule). */}
            {editingSchedule ? (
              <div className="bg-surfaceLowest border border-border/40 rounded-xl p-4 space-y-4">
                {/* Grammar section */}
                <div className="rounded-lg border border-[#BBF7D0] bg-[#F0FDF4] p-3 space-y-2">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#15803D]">Грамматика</p>
                  <select
                    value={gTeacher}
                    onChange={e => setGTeacher(e.target.value)}
                    className="w-full text-xs px-2 py-1.5 rounded-md border border-[#BBF7D0] text-[#15803D] bg-background"
                  >
                    <option value="">— не назначен —</option>
                    {teachers.map(t => <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>)}
                  </select>
                  <DaySelector
                    value={gDays}
                    activeDays={activeDays}
                    variant="grammar"
                    onChange={days => { setGDays(days); setCDays(prev => prev.filter(d => !days.includes(d))); }}
                  />
                </div>

                {/* Club section — only when the group actually has a club block */}
                {clubBlock && (
                  <div className="rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] p-3 space-y-2">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-[#0369A1]">Спикинг-клуб</p>
                    <select
                      value={cTeacher}
                      onChange={e => setCTeacher(e.target.value)}
                      className="w-full text-xs px-2 py-1.5 rounded-md border border-[#BFDBFE] text-[#0369A1] bg-background"
                    >
                      <option value="">— не назначен —</option>
                      {teachers.map(t => <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>)}
                    </select>
                    <DaySelector
                      value={cDays}
                      activeDays={activeDays}
                      variant="club"
                      onChange={days => { setCDays(days); setGDays(prev => prev.filter(d => !days.includes(d))); }}
                    />
                  </div>
                )}

                <div className="flex gap-2">
                  <Button size="sm" variant="primary" className="flex-1" disabled={savingSchedule}
                    onClick={() => saveSchedule()}>
                    {savingSchedule ? 'Сохранение...' : 'Сохранить'}
                  </Button>
                  <Button size="sm" variant="outline" disabled={savingSchedule}
                    onClick={() => setEditingSchedule(false)}>
                    Отмена
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {canMutateSchedule && grammarBlock && (
                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" className="text-xs" onClick={startEditSchedule}>
                      ✎ Редактировать учителей
                    </Button>
                  </div>
                )}
                {group.blocks.map(b => {
                  const teacherName = b.teacher
                    ? `${b.teacher.user.firstName} ${b.teacher.user.lastName}` : '—';
                  const isClub = b.type === 'SPEAKING_CLUB';
                  return (
                    <div
                      key={b.id}
                      className="w-full bg-surfaceLowest border border-border/30 rounded-xl px-4 py-3"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-primary">{BLOCK_TYPE_LABEL[b.type]}</span>
                        {b.cabinet && <span className="text-xs text-textSecondary">{b.cabinet.name}</span>}
                      </div>
                      <p className="text-sm font-semibold text-textPrimary">{dayNames(b.days)}</p>
                      <p className="text-xs text-textSecondary mt-0.5">{b.startTime} – {b.endTime}</p>
                      <div className="flex items-center justify-between gap-2 mt-2">
                        <span className="text-xs text-textSecondary truncate">{isClub ? 'Кл' : 'Гр'}: {teacherName}</span>
                        <button
                          onClick={() => openInSchedule(b)}
                          className="text-xs text-textSecondary font-medium hover:underline shrink-0"
                          title="Открыть этот слот в расписании"
                        >
                          Открыть →
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {showAddStudent && (
        <AddStudentModal
          group={group}
          onClose={() => setShowAddStudent(false)}
          onAdded={fetchGroup}
        />
      )}

      <StudentProfileModal
        student={profileStudent}
        isOpen={profileStudent !== null}
        onClose={() => setProfileStudent(null)}
        onUpdate={updated => setProfileStudent(updated)}
        onPausedChanged={paused => setGroup(g => g && {
          ...g,
          students: g.students.map(s =>
            s.id === profileStudent?.studentProfileId ? { ...s, isFrozen: paused } : s,
          ),
        })}
        // The modal owns the archive PATCH + toast and closes itself via
        // onClose() on success. This refetches the group so the roster
        // (students list + _count) drops the archived student instead of
        // continuing to show them after a successful archive.
        onArchived={() => fetchGroup()}
      />

      <GroupActionModal
        open={showActionModal}
        groupName={group.level}
        groupStatus={group.status}
        canArchiveGroup={canArchiveGroup}
        onComplete={completeGroupLifecycle}
        onPause={pauseGroupLifecycle}
        onResume={resumeGroupLifecycle}
        onArchive={archiveGroupLifecycle}
        onDelete={deleteGroup}
        onClose={() => setShowActionModal(false)}
      />
    </div>
  );
}
