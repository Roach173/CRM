import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import toast from 'react-hot-toast';
import {
  Plus, X, Users, GraduationCap, AlertCircle,
  Phone, Mail, BookOpen, ChevronLeft, ChevronRight, Pencil, User,
  Archive, ArchiveRestore, ChevronUp, ChevronDown, Shield,
} from 'lucide-react';
import api from '../../../lib/api';
import { AddUserModal } from '../../../components/ui/AddUserModal';
import ConfirmModal from '../../../components/ui/ConfirmModal';
import { Spinner } from '../../../components/ui/Spinner';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Textarea } from '../../../components/ui/Textarea';
import SearchInput from '../../../components/ui/SearchInput';
import { MonthYearPicker } from '../../../components/ui/MonthYearPicker';
import { useAuth } from '../../../hooks/useAuth';
import { usePermissions } from '../../../hooks/usePermissions';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../../hooks/useBackButtonClose';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LessonBlock {
  id: number;
  level: string;
  days: number[];
  startTime: string;
  endTime: string;
  startDate: string;
  endDate: string;
}

interface StaffMember {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  role: 'TEACHER' | 'ADMIN' | 'OWNER';
  createdAt: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  staffProfile?: {
    workingDays: number[];
    maxLessonsPerDay: number | null;
    notes?: string | null;
    taughtBlocks?: LessonBlock[];
  };
}

type ProfileTab = 'info' | 'classes' | 'settings' | 'history';

const ROLE_LABEL: Record<'TEACHER' | 'ADMIN' | 'OWNER', string> = {
  TEACHER: 'Учитель',
  ADMIN:   'Администратор',
  OWNER:   'Владелец',
};

const ROLE_BADGE_VARIANT: Record<'TEACHER' | 'ADMIN' | 'OWNER', 'info' | 'warning' | 'danger'> = {
  TEACHER: 'info',
  ADMIN:   'warning',
  OWNER:   'danger',
};

// The only two role transitions this page can trigger — see server-side
// ROLE_CHANGE_ALLOWLIST in server/src/routes/users.ts, which is the single source
// of truth for what is actually permitted. This mirrors it purely for UI gating.
function nextRoleFor(role: StaffMember['role']): 'OWNER' | 'ADMIN' | null {
  if (role === 'ADMIN') return 'OWNER';
  if (role === 'OWNER') return 'ADMIN';
  return null;
}

const PER_PAGE = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(firstName: string, lastName: string): string {
  return `${firstName[0] ?? ''}${lastName[0] ?? ''}`.toUpperCase();
}

function getBlockCount(member: StaffMember): number {
  return member.staffProfile?.taughtBlocks?.length ?? 0;
}

function getLessonsPerWeek(member: StaffMember): number {
  return (member.staffProfile?.taughtBlocks ?? []).reduce((s, b) => {
    const days = Array.isArray(b.days) ? b.days : (b.days as string).split(',');
    return s + days.filter(Boolean).length;
  }, 0);
}

// ─── TeacherProfileModal ──────────────────────────────────────────────────────

interface TeacherProfileModalProps {
  teacher: StaffMember | null;
  isOpen: boolean;
  initialTab?: ProfileTab;
  onClose: () => void;
  onUpdate: (updated: StaffMember) => void;
  onArchiveClick: (member: StaffMember) => void;
  onRoleChangeClick: (member: StaffMember, newRole: 'OWNER' | 'ADMIN') => void;
}

function TeacherProfileModal({ teacher, isOpen, initialTab, onClose, onUpdate, onArchiveClick, onRoleChangeClick }: TeacherProfileModalProps) {
  const { user: currentUser } = useAuth();
  const permissions = usePermissions();
  const [activeTab, setActiveTab] = useState<ProfileTab>('info');

  const [isEditing, setIsEditing] = useState(false);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const [workingDays, setWorkingDays] = useState<number[]>([0, 1, 2, 3, 4, 5]);
  const [maxLessons, setMaxLessons] = useState<string>('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [notes, setNotes] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);

  const now = new Date();
  const [histYear, setHistYear] = useState(now.getFullYear());
  const [histMonth, setHistMonth] = useState(now.getMonth() + 1);
  const [history, setHistory] = useState<any[]>([]);
  const [loadingHist, setLoadingHist] = useState(false);

  useEffect(() => {
    if (teacher) setActiveTab(initialTab ?? 'info');
  }, [teacher, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!teacher) return;
    setWorkingDays(teacher.staffProfile?.workingDays ?? [0, 1, 2, 3, 4, 5]);
    setMaxLessons(teacher.staffProfile?.maxLessonsPerDay ? String(teacher.staffProfile.maxLessonsPerDay) : '');
    setEditFirstName(teacher.firstName);
    setEditLastName(teacher.lastName);
    setEditPhone(teacher.phone ?? '');
    setNotes(teacher.staffProfile?.notes ?? '');
    setIsEditing(false);
  }, [teacher]);

  const fetchHistory = useCallback(async () => {
    if (!teacher || activeTab !== 'history') return;
    setLoadingHist(true);
    try {
      const res = await api.get(`/schedule/teacher-lesson-calendar-admin?teacherId=${teacher.id}&year=${histYear}&month=${histMonth}`);
      setHistory(res.data?.data ?? []);
    } catch (e) {
      console.error(e);
      toast.error('Ошибка загрузки истории');
    } finally {
      setLoadingHist(false);
    }
  }, [teacher, histYear, histMonth, activeTab]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  useBodyScrollLock(isOpen);
  useBackButtonClose(isOpen, onClose);

  if (!isOpen || !teacher) return null;

  const notesDirty = notes !== (teacher.staffProfile?.notes ?? '');
  const isTeacher   = teacher.role === 'TEACHER';
  const initials    = getInitials(teacher.firstName, teacher.lastName);
  const blockCount  = getBlockCount(teacher);
  const lpw         = getLessonsPerWeek(teacher);
  const taughtBlocks = teacher.staffProfile?.taughtBlocks ?? [];

  // Visibility is gated on usePermissions() (canManageStaff = OWNER/SUPERADMIN),
  // never a hand-rolled role comparison. The server (users.ts PATCH /:id/role) is
  // the actual authority — this only decides whether to show the button. Self is
  // excluded here too so an OWNER can never even attempt to change their own role
  // from this UI (server also rejects it — guard 3).
  const nextRole = nextRoleFor(teacher.role);
  const canChangeRole = permissions.canManageStaff && nextRole !== null && teacher.id !== currentUser?.id;

  // Admins have no groups/schedule — only the Info tab applies to them.
  const tabs: { id: ProfileTab; label: string }[] = isTeacher
    ? [
        { id: 'info',     label: 'Информация' },
        { id: 'classes',  label: 'Группы'     },
        { id: 'settings', label: 'Настройки'  },
        { id: 'history',  label: 'История'    },
      ]
    : [{ id: 'info', label: 'Информация' }];

  const saveProfile = async () => {
    if (!editFirstName.trim() || !editLastName.trim()) {
      toast.error('Имя и фамилия обязательны');
      return;
    }
    setSavingProfile(true);
    try {
      const res = await api.patch(`/users/${teacher!.id}/profile`, {
        firstName: editFirstName.trim(),
        lastName: editLastName.trim(),
        phone: editPhone.trim() || null,
      });
      const updated = res.data.data;
      onUpdate({ ...teacher!, firstName: updated.firstName, lastName: updated.lastName, phone: updated.phone });
      setIsEditing(false);
      toast.success('Данные сохранены');
    } catch {
      toast.error('Ошибка при сохранении');
    } finally {
      setSavingProfile(false);
    }
  };

  const saveNotes = async () => {
    setNotesSaving(true);
    try {
      await api.patch(`/users/${teacher!.id}/staff-profile`, { notes });
      onUpdate({
        ...teacher!,
        staffProfile: {
          workingDays: [0, 1, 2, 3, 4, 5],
          maxLessonsPerDay: null,
          ...teacher!.staffProfile,
          notes,
        },
      });
      toast.success('Заметка сохранена');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Не удалось сохранить заметку');
    } finally {
      setNotesSaving(false);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    setSaveError('');
    try {
      await api.patch(`/users/${teacher.id}/staff-profile`, {
        workingDays,
        maxLessonsPerDay: maxLessons ? parseInt(maxLessons) : null,
      });
      if (teacher.staffProfile) {
        teacher.staffProfile.workingDays = workingDays;
        teacher.staffProfile.maxLessonsPerDay = maxLessons ? parseInt(maxLessons) : null;
      }
      toast.success('Настройки сохранены');
    } catch {
      setSaveError('Ошибка при сохранении настроек');
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-surfaceLowest rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center gap-4 p-6 border-b border-border/30">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-black text-lg shrink-0 border border-primary/10">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-textPrimary truncate">
                {teacher.firstName} {teacher.lastName}
              </h2>
              {isTeacher && (
                <>
                  <Badge variant="info">{blockCount} гр.</Badge>
                  <span className="text-xs text-textSecondary font-medium">{lpw} ур/нед</span>
                </>
              )}
            </div>
            <p className="text-xs text-textSecondary mt-0.5">
              {isTeacher ? 'Преподаватель' : ROLE_LABEL[teacher.role]}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* Archive only ever applied to TEACHER/ADMIN server-side (see
               PATCH /:id/archive) — hidden for OWNER rows so a click can't just
               bounce off a 404. */}
            {teacher.role !== 'OWNER' && (
              <button
                onClick={() => onArchiveClick(teacher)}
                title="Архивировать сотрудника"
                className="text-textSecondary hover:text-warning transition-colors rounded-lg p-1.5 hover:bg-warning/10"
              >
                <Archive className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onClose}
              className="text-textSecondary hover:text-textPrimary transition-colors rounded-lg p-1 hover:bg-surfaceLow"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border/30 px-6 overflow-x-auto flex-nowrap">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`py-3 px-1 mr-6 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-textSecondary hover:text-textPrimary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">

          {activeTab === 'info' && (
            <div>
              {!isEditing ? (
                <div className="space-y-1">
                  {[
                    { icon: <User className="w-4 h-4" />,    label: 'Имя',        value: `${teacher.firstName} ${teacher.lastName}` },
                    { icon: <Phone className="w-4 h-4" />,   label: 'Телефон',    value: teacher.phone || '—' },
                    { icon: <Mail className="w-4 h-4" />,    label: 'Email',      value: teacher.email },
                    { icon: <Shield className="w-4 h-4" />,  label: 'Роль',       value: ROLE_LABEL[teacher.role] },
                    ...(isTeacher ? [
                      { icon: <BookOpen className="w-4 h-4" />, label: 'Групп всего', value: String(blockCount) },
                      { icon: <BookOpen className="w-4 h-4" />, label: 'Уроков/нед',  value: String(lpw) },
                    ] : []),
                  ].map(({ icon, label, value }) => (
                    <div key={label} className="flex items-center gap-3 py-2.5 border-b border-border/30 last:border-0">
                      <span className="text-textSecondary w-4 shrink-0">{icon}</span>
                      <span className="text-xs font-semibold uppercase tracking-wider text-textSecondary w-28 shrink-0">{label}</span>
                      <span className="text-sm font-medium text-textPrimary">{value}</span>
                    </div>
                  ))}
                  <div className="pt-4 flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                      <Pencil className="w-4 h-4" />
                      Редактировать
                    </Button>
                    {/* No Autosave: this only opens the Confirm modal (Modal → Edit →
                       Confirm → Save) — it never changes the role by itself. Visibility
                       is gated by usePermissions().canManageStaff + self-exclusion above;
                       the server enforces the real authorization (all seven guards). */}
                    {canChangeRole && nextRole && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onRoleChangeClick(teacher, nextRole)}
                        className={nextRole === 'OWNER' ? 'border-danger/40 text-danger hover:bg-danger/10' : ''}
                      >
                        <Shield className="w-4 h-4" />
                        {nextRole === 'OWNER' ? 'Повысить до владельца' : 'Понизить до администратора'}
                      </Button>
                    )}
                  </div>
                  <div className="pt-4">
                    <Textarea
                      label="Заметки"
                      value={notes}
                      rows={3}
                      placeholder="Заметки об этом сотруднике..."
                      onChange={(e) => setNotes(e.target.value)}
                      className="bg-surfaceLow border-border/30 resize-none"
                    />
                    <div className="flex justify-end mt-2">
                      <Button size="sm" onClick={saveNotes} disabled={!notesDirty || notesSaving}>
                        {notesSaving ? 'Сохранение...' : 'Сохранить заметку'}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-textSecondary uppercase tracking-widest mb-2">Имя</label>
                      <input
                        value={editFirstName}
                        onChange={e => setEditFirstName(e.target.value)}
                        className="w-full h-10 px-3 bg-surfaceLow rounded-lg border border-border/40 focus:border-primary outline-none text-textPrimary text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-textSecondary uppercase tracking-widest mb-2">Фамилия</label>
                      <input
                        value={editLastName}
                        onChange={e => setEditLastName(e.target.value)}
                        className="w-full h-10 px-3 bg-surfaceLow rounded-lg border border-border/40 focus:border-primary outline-none text-textPrimary text-sm"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-textSecondary uppercase tracking-widest mb-2">Телефон</label>
                    <input
                      value={editPhone}
                      onChange={e => setEditPhone(e.target.value)}
                      className="w-full h-10 px-3 bg-surfaceLow rounded-lg border border-border/40 focus:border-primary outline-none text-textPrimary text-sm"
                      placeholder="+7..."
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-textSecondary uppercase tracking-widest mb-2">Email</label>
                    <div className="h-10 px-3 bg-surfaceLow/50 rounded-lg border border-border/20 flex items-center text-textSecondary text-sm select-none">
                      {teacher.email}
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button onClick={saveProfile} disabled={savingProfile}>
                      {savingProfile ? <Spinner size="sm" /> : 'Сохранить'}
                    </Button>
                    <Button variant="outline" onClick={() => setIsEditing(false)} disabled={savingProfile}>
                      Отмена
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'classes' && (
            <div className="space-y-5">
              {taughtBlocks.length > 0 ? (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-2">
                    Ведёт группы ({taughtBlocks.length})
                  </div>
                  <div className="space-y-2">
                    {taughtBlocks.map((b) => (
                      <div key={b.id} className="flex items-center gap-3 p-3 bg-surfaceLow rounded-xl border border-border/30">
                        <BookOpen className="w-4 h-4 text-primary shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-textPrimary">{b.level}</p>
                          <p className="text-xs text-textSecondary truncate">
                            {Array.isArray(b.days) ? b.days.join(', ') : b.days} · {b.startTime} – {b.endTime}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 py-10 text-textSecondary/50 border border-dashed border-border/40 rounded-xl">
                  <BookOpen className="w-8 h-8" />
                  <p className="text-sm">Нет привязанных групп</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-textSecondary uppercase tracking-widest mb-2">
                  Рабочие дни учителя
                </label>
                <div className="flex flex-wrap gap-2">
                  {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day, idx) => {
                    const isSelected = workingDays.includes(idx);
                    return (
                      <button
                        key={idx}
                        onClick={() => {
                          if (isSelected) setWorkingDays(wd => wd.filter(d => d !== idx));
                          else setWorkingDays(wd => [...wd, idx].sort());
                        }}
                        className={`w-10 h-10 rounded-lg text-sm font-bold transition-colors border ${
                          isSelected
                            ? 'bg-primary text-white border-primary'
                            : 'bg-surfaceLow text-textSecondary border-border/40 hover:border-primary'
                        }`}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-textSecondary uppercase tracking-widest mb-2">
                  Максимум уроков в день (пусто = без лимита)
                </label>
                <input
                  type="number"
                  min="1"
                  value={maxLessons}
                  onChange={e => setMaxLessons(e.target.value)}
                  className="w-full h-10 px-3 bg-surfaceLow rounded-lg border border-border/40 focus:border-primary outline-none text-textPrimary"
                  placeholder="Без лимита"
                />
              </div>
              {saveError && <p className="text-sm text-danger">{saveError}</p>}
              <Button onClick={saveSettings} disabled={savingSettings}>
                {savingSettings ? <Spinner size="sm" /> : 'Сохранить настройки'}
              </Button>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-4">
              <div className="mb-4">
                <MonthYearPicker
                  value={`${histYear}-${String(histMonth).padStart(2, '0')}`}
                  onChange={p => {
                    const [y, m] = p.split('-').map(Number);
                    setHistYear(y);
                    setHistMonth(m);
                  }}
                />
              </div>

              {loadingHist ? (
                <div className="flex justify-center py-10"><Spinner size="md" /></div>
              ) : history.length > 0 ? (
                <div className="space-y-2">
                  {history.map((h) => (
                    <div key={h.id} className="p-3 bg-surfaceLow rounded-xl border border-border/30 flex justify-between items-center">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-textSecondary">{h.date}</span>
                          <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium">{h.time}</span>
                        </div>
                        <p className="text-sm font-semibold text-textPrimary truncate">{h.groupName}</p>
                        <p className="text-[10px] text-textSecondary">{h.cabinet} · {h.level}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {h.isSubstitution && (
                          <Badge variant="warning" className="text-[9px] px-1.5 py-0">Замена</Badge>
                        )}
                        <span className={`text-[10px] font-bold uppercase ${
                          h.status === 'COMPLETED' ? 'text-success' :
                          h.status === 'CANCELLED' ? 'text-danger'  : 'text-primary'
                        }`}>
                          {h.status === 'COMPLETED' ? 'Отработан' :
                           h.status === 'CANCELLED' ? 'Отменен'   : 'Ожидается'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-10 text-textSecondary text-sm">
                  Нет уроков за этот месяц
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── Sortable column header ───────────────────────────────────────────────────

type SortKey = 'name' | 'phone' | 'role' | 'createdAt';

// ROLE_LABEL ('Администратор' < 'Учитель') and ISO createdAt sort correctly as strings.
function sortVal(s: StaffMember, key: SortKey): string {
  switch (key) {
    case 'name':      return `${s.firstName} ${s.lastName}`.toLowerCase();
    case 'phone':     return s.phone || '';
    case 'role':      return ROLE_LABEL[s.role];
    case 'createdAt': return s.createdAt;
  }
}

function SortHeader({
  label, col, sort, onSort,
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null;
  onSort: (key: SortKey) => void;
}) {
  const active = sort?.key === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={`flex items-center gap-1 text-left uppercase tracking-widest transition-colors hover:text-textPrimary ${
        active ? 'text-textPrimary' : ''
      }`}
    >
      {label}
      {active && (sort!.dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
    </button>
  );
}

// ─── Main: Staff page ─────────────────────────────────────────────────────────

export default function Staff() {
  const [staff, setStaff]             = useState<StaffMember[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [search, setSearch]           = useState('');
  const [addRole, setAddRole]         = useState<'TEACHER' | 'ADMIN' | null>(null);
  const [profileMember, setProfileMember] = useState<StaffMember | null>(null);
  const [profileInitialTab, setProfileInitialTab] = useState<ProfileTab | undefined>(undefined);
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage]               = useState(1);
  const [sort, setSort]               = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  function toggleSort(key: SortKey) {
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
    setPage(1);
  }

  // ── Archive view state ────────────────────────────────────────────────────
  const [archiveView, setArchiveView]     = useState(false);
  const [archivedStaff, setArchivedStaff] = useState<StaffMember[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError]   = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<StaffMember | null>(null);
  // Promote ADMIN -> OWNER / demote OWNER -> ADMIN. Holds the pending change until
  // the ConfirmModal below is explicitly confirmed — No Autosave: nothing is sent
  // to the server until the user clicks Save/Confirm.
  const [confirmRoleChange, setConfirmRoleChange] = useState<{ member: StaffMember; newRole: 'OWNER' | 'ADMIN' } | null>(null);

  const handleStaffUpdate = useCallback((updated: StaffMember) => {
    setStaff(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s));
    setProfileMember(prev => prev ? { ...prev, ...updated } : null);
  }, []);

  const fetchStaff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // OWNER is fetched alongside TEACHER/ADMIN so a promoted-to-OWNER staff
      // member (and any other owner) stays visible here for demotion — a
      // promote-only list would make the demote path built for guard 6 (last-owner
      // protection) unreachable from this page.
      const [teachersRes, adminsRes, ownersRes] = await Promise.all([
        api.get('/users?role=TEACHER'),
        api.get('/users?role=ADMIN'),
        api.get('/users?role=OWNER'),
      ]);
      const teachers: StaffMember[] = (teachersRes.data?.data ?? []).map((u: any) => ({ ...u, role: 'TEACHER' as const }));
      const admins: StaffMember[]   = (adminsRes.data?.data   ?? []).map((u: any) => ({ ...u, role: 'ADMIN'   as const }));
      const owners: StaffMember[]   = (ownersRes.data?.data   ?? []).map((u: any) => ({ ...u, role: 'OWNER'   as const }));
      setStaff([...owners, ...admins, ...teachers]);
    } catch {
      setError('Не удалось загрузить список сотрудников');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchArchivedStaff = useCallback(async () => {
    setArchiveLoading(true);
    setArchiveError(null);
    try {
      // limit=3000 matches the server cap — after clear-data the archive can hold the whole school.
      const [teachersRes, adminsRes] = await Promise.all([
        api.get('/users?role=TEACHER&archived=true&limit=3000'),
        api.get('/users?role=ADMIN&archived=true&limit=3000'),
      ]);
      const teachers: StaffMember[] = (teachersRes.data?.data ?? []).map((u: any) => ({ ...u, role: 'TEACHER' as const }));
      const admins: StaffMember[]   = (adminsRes.data?.data   ?? []).map((u: any) => ({ ...u, role: 'ADMIN'   as const }));
      setArchivedStaff([...admins, ...teachers]);
    } catch {
      setArchiveError('Не удалось загрузить архив');
      setArchivedStaff([]);
    } finally {
      setArchiveLoading(false);
    }
  }, []);

  async function handleArchive(member: StaffMember) {
    try {
      await api.patch(`/users/${member.id}/archive`);
      toast.success(`${member.firstName} ${member.lastName} перемещён в архив`);
      setProfileMember(null);
      fetchStaff();
    } catch {
      toast.error('Не удалось архивировать сотрудника');
    }
  }

  async function handleUnarchive(member: StaffMember) {
    try {
      await api.patch(`/users/${member.id}/unarchive`);
      toast.success(`${member.firstName} ${member.lastName} восстановлен из архива`);
      fetchArchivedStaff();
    } catch {
      toast.error('Не удалось восстановить сотрудника');
    }
  }

  // Fires only after explicit ConfirmModal confirmation (see confirmRoleChange
  // below) — the actual PATCH /users/:id/role call, which the server re-validates
  // against all seven guards regardless of what the client sent.
  async function handleRoleChange(member: StaffMember, newRole: 'OWNER' | 'ADMIN') {
    try {
      await api.patch(`/users/${member.id}/role`, { role: newRole });
      toast.success(
        newRole === 'OWNER'
          ? `${member.firstName} ${member.lastName} назначен(а) владельцем`
          : `${member.firstName} ${member.lastName} понижен(а) до администратора`
      );
      setProfileMember(null);
      fetchStaff();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Не удалось изменить роль');
    }
  }

  useEffect(() => { fetchStaff(); }, [fetchStaff]);

  // Deep-link from a schedule conflict ("Открыть карточку учителя") — open the
  // teacher straight on the Настройки tab so working days can be fixed right away.
  useEffect(() => {
    const openStaffId = searchParams.get('openStaffId');
    if (!openStaffId || loading) return;
    const member = staff.find(s => s.id === parseInt(openStaffId));
    if (member) {
      setProfileMember(member);
      setProfileInitialTab('settings');
    }
    setSearchParams(prev => { prev.delete('openStaffId'); return prev; }, { replace: true });
  }, [searchParams, staff, loading, setSearchParams]);

  useEffect(() => {
    if (archiveView) fetchArchivedStaff();
  }, [archiveView, fetchArchivedStaff]);

  const q = search.trim().toLowerCase();
  const matchSearch = (s: StaffMember) =>
    !q || `${s.firstName} ${s.lastName} ${s.email}`.toLowerCase().includes(q);
  const filtered = staff.filter(matchSearch);
  const filteredArchived = archivedStaff.filter(matchSearch);

  // Click a header: asc → desc → off. Empty values always sort last.
  const sorted = sort
    ? [...filtered].sort((a, b) => {
        const av = sortVal(a, sort.key);
        const bv = sortVal(b, sort.key);
        if (!av && bv) return 1;
        if (av && !bv) return -1;
        const cmp = av.localeCompare(bv);
        return sort.dir === 'asc' ? cmp : -cmp;
      })
    : filtered;

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const safePage   = Math.min(page, totalPages);
  const pageStart  = (safePage - 1) * PER_PAGE;
  const pageItems  = sorted.slice(pageStart, pageStart + PER_PAGE);

  return (
    <div className="animate-in fade-in duration-500 text-textPrimary">

      {/* Header — search + actions in one row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-4">
        <SearchInput
          value={search}
          onChange={v => { setSearch(v); setPage(1); }}
          placeholder="Поиск по имени или email..."
          className="flex-1"
        />
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setArchiveView(v => !v); setSearch(''); setPage(1); }}
            className={archiveView ? 'border-warning text-warning bg-warning/10' : ''}
          >
            <Archive className="w-4 h-4" />
            {archiveView ? 'Активные сотрудники' : 'Архив'}
          </Button>
          {!archiveView && (
            <>
              <Button variant="outline" size="sm" onClick={() => setAddRole('TEACHER')}>
                <GraduationCap className="w-4 h-4" />Учитель
              </Button>
              <Button variant="outline" size="sm" onClick={() => setAddRole('ADMIN')}>
                <Plus className="w-4 h-4" />Администратор
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ── Archive view ───────────────────────────────────────────────────── */}
      {archiveView && (
        <>
          <div className="bg-surfaceLowest rounded-xl border border-border overflow-hidden">
            {archiveLoading && (
              <div className="flex items-center justify-center gap-3 py-20 text-textSecondary">
                <Spinner size="md" />
                <span className="text-sm">Загрузка архива...</span>
              </div>
            )}
            {!archiveLoading && archiveError && (
              <div className="flex flex-col items-center gap-3 py-20 text-danger">
                <AlertCircle className="w-10 h-10 opacity-60" />
                <p className="text-sm">{archiveError}</p>
                <button onClick={fetchArchivedStaff} className="text-xs text-primary underline">Повторить</button>
              </div>
            )}
            {!archiveLoading && !archiveError && filteredArchived.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-20 text-textSecondary">
                <Archive className="w-12 h-12 opacity-30" />
                <p className="text-sm">{search ? 'Никого не найдено.' : 'Архив пуст.'}</p>
              </div>
            )}
            {!archiveLoading && !archiveError && filteredArchived.map(member => {
              const initials = getInitials(member.firstName, member.lastName);
              // deletedAt takes precedence: a soft-deleted record is "Удалён" even if also archived.
              const isDeleted = !!member.deletedAt;
              const stateLabel = isDeleted ? 'Удалён' : 'Архивирован';
              const stateDateRaw = member.deletedAt ?? member.archivedAt;
              const stateDate = stateDateRaw
                ? new Date(stateDateRaw).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
                : '—';
              return (
                <div
                  key={`${member.role}-${member.id}`}
                  className="grid md:grid-cols-[32px_1fr_140px_140px_120px] grid-cols-1 gap-3 px-4 py-3.5 border-b border-border/30 last:border-0 items-center"
                >
                  <div className="hidden md:flex items-center justify-center">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold bg-surfaceLow text-textSecondary">
                      {initials}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-textPrimary truncate">{member.firstName} {member.lastName}</p>
                    <p className="text-xs text-textSecondary truncate">{member.email}</p>
                    <div className="md:hidden mt-1">
                      <Badge variant={member.role === 'TEACHER' ? 'info' : 'warning'}>{ROLE_LABEL[member.role]}</Badge>
                    </div>
                  </div>
                  <div className="hidden md:block">
                    <Badge variant={member.role === 'TEACHER' ? 'info' : 'warning'}>{ROLE_LABEL[member.role]}</Badge>
                  </div>
                  <div className="hidden md:block text-xs text-textSecondary">
                    <span className={`text-[10px] uppercase tracking-widest font-bold block mb-0.5 ${isDeleted ? 'text-warning' : ''}`}>{stateLabel}</span>
                    {stateDate}
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => handleUnarchive(member)}
                      className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 border border-primary/30 hover:border-primary/60 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      <ArchiveRestore className="w-3.5 h-3.5" />
                      Восстановить
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {!archiveView && (
      <>
      {/* List */}
      <div className="bg-surfaceLowest rounded-xl border border-border overflow-hidden">

        {/* Desktop header — sortable columns */}
        <div className="hidden md:grid grid-cols-[32px_1fr_180px_110px_100px] gap-3 px-4 py-3 border-b border-border/50 text-[10px] font-bold uppercase tracking-widest text-textSecondary">
          <span />
          <SortHeader label="Сотрудник" col="name" sort={sort} onSort={toggleSort} />
          <SortHeader label="Номер телефона" col="phone" sort={sort} onSort={toggleSort} />
          <SortHeader label="Роль" col="role" sort={sort} onSort={toggleSort} />
          <div className="flex justify-end">
            <SortHeader label="Добавлен" col="createdAt" sort={sort} onSort={toggleSort} />
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-3 py-20 text-textSecondary">
            <Spinner size="md" />
            <span className="text-sm">Загрузка...</span>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center gap-3 py-20 text-danger">
            <AlertCircle className="w-10 h-10 opacity-60" />
            <p className="text-sm">{error}</p>
            <button onClick={fetchStaff} className="text-xs text-primary underline">Повторить</button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-20 text-textSecondary">
            <Users className="w-12 h-12 opacity-30" />
            <p className="text-sm">{search ? 'Никого не найдено.' : 'Сотрудников пока нет.'}</p>
          </div>
        )}

        {!loading && !error && pageItems.map(member => {
          const initials   = getInitials(member.firstName, member.lastName);
          const isTeacher  = member.role === 'TEACHER';
          const blockCount = isTeacher ? getBlockCount(member) : null;
          const lpw        = isTeacher ? getLessonsPerWeek(member) : null;

          return (
            <div
              key={`${member.role}-${member.id}`}
              onClick={() => setProfileMember(member)}
              className="grid md:grid-cols-[32px_1fr_180px_110px_100px] grid-cols-1 gap-3 px-4 py-3.5 border-b border-border/30 last:border-0 transition-colors items-center border-l-2 border-l-transparent cursor-pointer hover:bg-surfaceLow hover:border-l-primary"
            >
              {/* Avatar — desktop */}
              <div className="hidden md:flex items-center justify-center">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black shrink-0 border ${
                  isTeacher
                    ? 'bg-primary/10 text-primary border-primary/10'
                    : 'bg-warning/10 text-warning border-warning/10'
                }`}>
                  {initials}
                </div>
              </div>

              {/* Name + email */}
              <div className="flex items-center gap-3">
                <div className={`md:hidden w-9 h-9 rounded-full flex items-center justify-center text-xs font-black shrink-0 border ${
                  isTeacher
                    ? 'bg-primary/10 text-primary border-primary/10'
                    : 'bg-warning/10 text-warning border-warning/10'
                }`}>
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-textPrimary truncate">
                    {member.firstName} {member.lastName}
                  </p>
                  <p className="text-xs text-textSecondary truncate">{member.email}</p>
                  {/* Mobile extras */}
                  <div className="md:hidden flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                    {member.phone && <span className="text-xs text-textSecondary">{member.phone}</span>}
                    <Badge variant={ROLE_BADGE_VARIANT[member.role]}>{ROLE_LABEL[member.role]}</Badge>
                    {isTeacher && blockCount !== null && (
                      <span className="text-xs text-textSecondary">{blockCount} гр. · {lpw} ур/нед</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Phone — desktop */}
              <span className="hidden md:block text-xs text-textSecondary truncate">
                {member.phone || '—'}
              </span>

              {/* Role + group count — desktop */}
              <div className="hidden md:flex items-center gap-1.5 flex-wrap">
                <Badge variant={ROLE_BADGE_VARIANT[member.role]}>{ROLE_LABEL[member.role]}</Badge>
                {isTeacher && blockCount !== null && (
                  <span className="text-[10px] text-textSecondary">{blockCount} гр.</span>
                )}
              </div>

              {/* Date + lessons/week — desktop */}
              <div className="hidden md:flex flex-col items-end gap-0.5">
                <span className="text-xs text-textSecondary">
                  {new Date(member.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
                {isTeacher && lpw !== null && (
                  <span className="text-[10px] text-textSecondary">{lpw} ур/нед</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 px-1">
          <span className="text-xs text-textSecondary">
            {pageStart + 1}–{Math.min(pageStart + PER_PAGE, filtered.length)} из {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={safePage === 1}
              onClick={() => setPage(p => p - 1)}
              className="p-2 rounded-lg border border-border/40 text-textSecondary hover:bg-surfaceLow disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {(() => {
              const pages: (number | 'ellipsis')[] = [];
              for (let i = 1; i <= totalPages; i++) {
                if (i === 1 || i === totalPages || Math.abs(i - safePage) <= 2) pages.push(i);
                else if (pages[pages.length - 1] !== 'ellipsis') pages.push('ellipsis');
              }
              return pages.map((p, idx) =>
                p === 'ellipsis' ? (
                  <span key={`e-${idx}`} className="px-1 text-textSecondary text-xs">…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`w-8 h-8 rounded-lg text-xs font-bold transition-colors ${
                      p === safePage
                        ? 'bg-primary text-white'
                        : 'border border-border/40 text-textSecondary hover:bg-surfaceLow'
                    }`}
                  >
                    {p}
                  </button>
                )
              );
            })()}

            <button
              disabled={safePage === totalPages}
              onClick={() => setPage(p => p + 1)}
              className="p-2 rounded-lg border border-border/40 text-textSecondary hover:bg-surfaceLow disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
      </>
      )}

      <AddUserModal
        isOpen={addRole !== null}
        role={addRole ?? 'TEACHER'}
        onClose={() => setAddRole(null)}
        onSuccess={fetchStaff}
      />

      <TeacherProfileModal
        teacher={profileMember}
        isOpen={profileMember !== null}
        initialTab={profileInitialTab}
        onClose={() => { setProfileMember(null); setProfileInitialTab(undefined); }}
        onUpdate={handleStaffUpdate}
        onArchiveClick={(member) => setConfirmArchive(member)}
        onRoleChangeClick={(member, newRole) => setConfirmRoleChange({ member, newRole })}
      />

      <ConfirmModal
        isOpen={confirmArchive !== null}
        onClose={() => setConfirmArchive(null)}
        onConfirm={() => { if (confirmArchive) handleArchive(confirmArchive); }}
        title="Архивировать сотрудника?"
        message={confirmArchive
          ? `${confirmArchive.firstName} ${confirmArchive.lastName} будет перемещён в архив. Данные сохранятся, аккаунт можно восстановить.`
          : ''}
        confirmText="Архивировать"
        isDanger={false}
      />

      {/* No Autosave: role only changes when this is explicitly confirmed. Copy
         states plainly what OWNER grants — salary payment, finances, school
         settings, data deletion — per the security requirement that the person
         clicking Confirm knows exactly what they're handing over. */}
      <ConfirmModal
        isOpen={confirmRoleChange !== null}
        onClose={() => setConfirmRoleChange(null)}
        onConfirm={() => { if (confirmRoleChange) handleRoleChange(confirmRoleChange.member, confirmRoleChange.newRole); }}
        title={confirmRoleChange?.newRole === 'OWNER' ? 'Повысить до владельца?' : 'Понизить до администратора?'}
        message={confirmRoleChange
          ? (confirmRoleChange.newRole === 'OWNER'
              ? `${confirmRoleChange.member.firstName} ${confirmRoleChange.member.lastName} получит роль «Владелец»: доступ к выплате зарплаты сотрудникам, финансам школы, настройкам школы и полному удалению данных школы. Роль можно понизить обратно в любой момент.`
              : `${confirmRoleChange.member.firstName} ${confirmRoleChange.member.lastName} потеряет роль «Владелец»: доступ к выплате зарплаты, финансам школы, настройкам школы и удалению данных школы будет закрыт. Останется роль «Администратор».`)
          : ''}
        confirmText={confirmRoleChange?.newRole === 'OWNER' ? 'Повысить' : 'Понизить'}
        isDanger
      />
    </div>
  );
}
