import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import toast from 'react-hot-toast';
import {
  Plus, ChevronLeft, ChevronRight, X,
  User, Phone, Mail, BookOpen, AlertCircle, Pencil,
} from 'lucide-react';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Spinner } from '../../../components/ui/Spinner';
import { AddUserModal } from '../../../components/ui/AddUserModal';
import SearchInput from '../../../components/ui/SearchInput';
import { MonthYearPicker } from '../../../components/ui/MonthYearPicker';
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

interface Teacher {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  staffProfile?: {
    workingDays: number[];
    maxLessonsPerDay: number | null;
    taughtBlocks?: LessonBlock[];
  };
}

type ProfileTab = 'info' | 'classes' | 'settings' | 'history';

// ─── Constants ────────────────────────────────────────────────────────────────

const TCH_PER_PAGE = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(firstName: string, lastName: string): string {
  return `${firstName[0] ?? ''}${lastName[0] ?? ''}`.toUpperCase();
}

function getBlockCount(teacher: Teacher): number {
  return teacher.staffProfile?.taughtBlocks?.length ?? 0;
}

function getLessonsPerWeek(teacher: Teacher): number {
  return (teacher.staffProfile?.taughtBlocks ?? []).reduce((s, b) => {
    const days = Array.isArray(b.days) ? b.days : (b.days as string).split(',');
    return s + days.filter(Boolean).length;
  }, 0);
}

// ─── TeacherProfileModal ──────────────────────────────────────────────────────

interface TeacherProfileModalProps {
  teacher: Teacher | null;
  isOpen: boolean;
  initialTab?: ProfileTab;
  onClose: () => void;
  onUpdate: (updated: Teacher) => void;
}

function TeacherProfileModal({ teacher, isOpen, initialTab, onClose, onUpdate }: TeacherProfileModalProps) {
  const { canManageStaff } = usePermissions();
  const [activeTab, setActiveTab] = useState<ProfileTab>('info');

  // Edit profile state — must be declared before any early return
  const [isEditing, setIsEditing] = useState(false);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Settings state — must be declared before any early return
  const [workingDays, setWorkingDays] = useState<number[]>([0,1,2,3,4,5]);
  const [maxLessons, setMaxLessons] = useState<string>('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [saveError, setSaveError] = useState('');

  // History state — must be declared before any early return
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
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!teacher) return;
    setWorkingDays(teacher.staffProfile?.workingDays ?? [0,1,2,3,4,5]);
    setMaxLessons(teacher.staffProfile?.maxLessonsPerDay ? String(teacher.staffProfile.maxLessonsPerDay) : '');
    setEditFirstName(teacher.firstName);
    setEditLastName(teacher.lastName);
    setEditPhone(teacher.phone ?? '');
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

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useBodyScrollLock(isOpen);
  useBackButtonClose(isOpen, onClose);

  // Early return after all hooks
  if (!isOpen || !teacher) return null;

  const initials = getInitials(teacher.firstName, teacher.lastName);
  const blockCount = getBlockCount(teacher);
  const lpw = getLessonsPerWeek(teacher);
  const taughtBlocks = teacher.staffProfile?.taughtBlocks ?? [];

  const tabs: { id: ProfileTab; label: string }[] = [
    { id: 'info', label: 'Информация' },
    { id: 'classes', label: 'Группы' },
    { id: 'settings', label: 'Настройки' },
    { id: 'history', label: 'История' },
  ];

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

  const saveSettings = async () => {
    setSavingSettings(true);
    setSaveError('');
    try {
      await api.patch(`/users/${teacher.id}/staff-profile`, {
        workingDays,
        maxLessonsPerDay: maxLessons ? parseInt(maxLessons) : null
      });
      if (teacher.staffProfile) {
        teacher.staffProfile.workingDays = workingDays;
        teacher.staffProfile.maxLessonsPerDay = maxLessons ? parseInt(maxLessons) : null;
      }
      toast.success('Настройки сохранены');
    } catch (err: any) {
      setSaveError('Ошибка при сохранении настроек');
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-surfaceLowest rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
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
              <Badge variant="info">{blockCount} гр.</Badge>
              <span className="text-xs text-textSecondary font-medium">{lpw} ур/нед</span>
            </div>
            <p className="text-xs text-textSecondary mt-0.5">
              {teacher.email}
              {teacher.phone ? ` · ${teacher.phone}` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-textSecondary hover:text-textPrimary transition-colors rounded-lg p-1 hover:bg-surfaceLow shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border/30 px-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`py-3 px-1 mr-6 text-sm font-semibold border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-textSecondary hover:text-textPrimary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'info' && (
            <div>
              {!isEditing ? (
                <div className="space-y-1">
                  {[
                    { icon: <User className="w-4 h-4" />, label: 'Имя', value: `${teacher.firstName} ${teacher.lastName}` },
                    { icon: <Phone className="w-4 h-4" />, label: 'Телефон', value: teacher.phone || '—' },
                    { icon: <Mail className="w-4 h-4" />, label: 'Email', value: teacher.email },
                    { icon: <BookOpen className="w-4 h-4" />, label: 'Групп всего', value: String(blockCount) },
                    { icon: <BookOpen className="w-4 h-4" />, label: 'Уроков/нед', value: String(lpw) },
                  ].map(({ icon, label, value }) => (
                    <div key={label} className="flex items-center gap-3 py-2.5 border-b border-border/30 last:border-0">
                      <span className="text-textSecondary w-4 shrink-0">{icon}</span>
                      <span className="text-xs font-semibold uppercase tracking-wider text-textSecondary w-28 shrink-0">{label}</span>
                      <span className="text-sm font-medium text-textPrimary">{value}</span>
                    </div>
                  ))}
                  {canManageStaff && (
                    <div className="pt-4">
                      <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                        <Pencil className="w-4 h-4" />
                        Редактировать
                      </Button>
                    </div>
                  )}
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
              {taughtBlocks.length > 0 && (
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
              )}

              {taughtBlocks.length === 0 && (
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
                        className={`w-10 h-10 rounded-lg text-sm font-bold transition-colors ${
                          isSelected ? 'bg-primary text-white border-primary' : 'bg-surfaceLow text-textSecondary border-border/40 hover:border-primary'
                        } border`}
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
                          h.status === 'CANCELLED' ? 'text-danger' : 'text-primary'
                        }`}>
                          {h.status === 'COMPLETED' ? 'Отработан' : 
                           h.status === 'CANCELLED' ? 'Отменен' : 'Ожидается'}
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

// ─── Main: Teachers page ───────────────────────────────────────────────────────

export default function Teachers() {
  const { canManageStaff } = usePermissions();
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [addOpen, setAddOpen] = useState(false);
  const [profileTeacher, setProfileTeacher] = useState<Teacher | null>(null);
  const [profileInitialTab, setProfileInitialTab] = useState<ProfileTab | undefined>(undefined);
  const [searchParams, setSearchParams] = useSearchParams();

  const handleTeacherUpdate = useCallback((updated: Teacher) => {
    setTeachers(prev => prev.map(t => t.id === updated.id ? { ...t, ...updated } : t));
    setProfileTeacher(prev => prev ? { ...prev, ...updated } : null);
  }, []);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchTeachers = useCallback(async () => {
    try {
      const res = await api.get('/users?role=TEACHER');
      const data = res.data?.data ?? res.data ?? [];
      setTeachers(Array.isArray(data) ? data : []);
      setError(null);
    } catch {
      setError('Не удалось загрузить список учителей');
      setTeachers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTeachers();
  }, [fetchTeachers]);

  // Deep-link from a schedule conflict ("Открыть карточку учителя") — open the
  // teacher straight on the Настройки tab so working days can be fixed right away.
  useEffect(() => {
    const openStaffId = searchParams.get('openStaffId');
    if (!openStaffId || loading) return;
    const found = teachers.find(t => t.id === parseInt(openStaffId));
    if (found) {
      setProfileTeacher(found);
      setProfileInitialTab('settings');
    }
    setSearchParams(prev => { prev.delete('openStaffId'); return prev; }, { replace: true });
  }, [searchParams, teachers, loading, setSearchParams]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const q = search.toLowerCase();
  const filtered = teachers.filter((t) => {
    if (!q) return true;
    const full = `${t.firstName} ${t.lastName} ${t.email} ${t.phone ?? ''}`.toLowerCase();
    return full.includes(q);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / TCH_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * TCH_PER_PAGE;
  const pageItems = filtered.slice(pageStart, pageStart + TCH_PER_PAGE);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="text-textPrimary">

      {/* Page header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div>
          <h1 className="font-serif text-2xl text-textPrimary">Учителя</h1>
          <p className="text-textSecondary text-sm mt-0.5">Управление преподавательским составом</p>
        </div>
        {canManageStaff && (
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4" />
            Новый учитель
          </Button>
        )}
      </div>


      {/* ── Tabs + Search ────────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <div className="flex items-center gap-1 bg-surfaceLow rounded-xl p-1 flex-shrink-0">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-surfaceLowest text-textPrimary shadow-sm">
            Учителя
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
              {teachers.length}
            </span>
          </div>
        </div>

        <SearchInput
          value={search}
          onChange={v => { setSearch(v); setPage(1); }}
          placeholder="Поиск по имени или email..."
          className="flex-1 max-w-sm"
        />
      </div>

      {/* ── Teacher list ─────────────────────────────────────────────────────── */}
      <div className="bg-surfaceLowest rounded-xl border border-border overflow-hidden">

        {/* Table header (desktop) */}
        <div className="hidden md:grid grid-cols-[32px_1fr_180px_80px] gap-3 px-4 py-3 border-b border-border/50 text-[10px] font-bold uppercase tracking-widest text-textSecondary">
          <span />
          <span>Учитель</span>
          <span>Контакт</span>
          <span className="text-right">Групп</span>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center gap-3 py-20 text-textSecondary">
            <Spinner size="md" />
            <span className="text-sm">Загрузка...</span>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="flex flex-col items-center gap-3 py-20 text-danger">
            <AlertCircle className="w-10 h-10 opacity-60" />
            <p className="text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchTeachers}>
              Повторить
            </Button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-20 text-textSecondary">
            <User className="w-12 h-12 opacity-30" />
            <p className="text-sm">
              {teachers.length === 0 ? 'Учителей пока нет' : 'Нет учителей по запросу'}
            </p>
          </div>
        )}

        {/* Rows */}
        {!loading && !error && pageItems.map((teacher) => {
          const initials = getInitials(teacher.firstName, teacher.lastName);
          const blockCount = getBlockCount(teacher);
          const lpw = getLessonsPerWeek(teacher);

          return (
            <div
              key={teacher.id}
              onClick={() => setProfileTeacher(teacher)}
              className="grid md:grid-cols-[32px_1fr_180px_80px] grid-cols-1 gap-3 px-4 py-3.5 border-b border-border/30 last:border-0 cursor-pointer hover:bg-surfaceLow transition-colors items-center border-l-2 border-l-transparent hover:border-l-primary"
            >
              {/* Avatar (desktop) */}
              <div className="hidden md:flex items-center justify-center">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-black shrink-0 border border-primary/10">
                  {initials}
                </div>
              </div>

              {/* Name + email */}
              <div className="flex items-center gap-3">
                <div className="md:hidden w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-black shrink-0 border border-primary/10">
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-textPrimary truncate">
                    {teacher.firstName} {teacher.lastName}
                  </p>
                  <p className="text-xs text-textSecondary truncate">{teacher.email}</p>
                  {/* Mobile-only extras */}
                  <div className="md:hidden flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                    {teacher.phone && (
                      <span className="text-xs text-textSecondary">{teacher.phone}</span>
                    )}
                    <Badge variant="info">{blockCount} гр.</Badge>
                    <span className="text-xs text-textSecondary">{lpw} ур/нед</span>
                  </div>
                </div>
              </div>

              {/* Phone (desktop) */}
              <span className="hidden md:block text-xs text-textSecondary truncate">
                {teacher.phone || '—'}
              </span>

              {/* Block count + lessons/week (desktop) */}
              <div className="hidden md:flex flex-col items-end gap-0.5">
                <Badge variant="info">{blockCount} гр.</Badge>
                <span className="text-[10px] text-textSecondary">{lpw} ур/нед</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Pagination ───────────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 px-1">
          <span className="text-xs text-textSecondary">
            {pageStart + 1}–{Math.min(pageStart + TCH_PER_PAGE, filtered.length)} из {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={safePage === 1}
              onClick={() => setPage((p) => p - 1)}
              className="p-2 rounded-lg border border-border/40 text-textSecondary hover:bg-surfaceLow disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {(() => {
              const pages: (number | 'ellipsis')[] = [];
              for (let i = 1; i <= totalPages; i++) {
                if (i === 1 || i === totalPages || Math.abs(i - safePage) <= 2) {
                  pages.push(i);
                } else if (pages[pages.length - 1] !== 'ellipsis') {
                  pages.push('ellipsis');
                }
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
              onClick={() => setPage((p) => p + 1)}
              className="p-2 rounded-lg border border-border/40 text-textSecondary hover:bg-surfaceLow disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Modals ───────────────────────────────────────────────────────────── */}
      <AddUserModal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        role="TEACHER"
        onSuccess={fetchTeachers}
      />

      <TeacherProfileModal
        teacher={profileTeacher}
        isOpen={profileTeacher !== null}
        initialTab={profileInitialTab}
        onClose={() => { setProfileTeacher(null); setProfileInitialTab(undefined); }}
        onUpdate={handleTeacherUpdate}
      />
    </div>
  );
}
