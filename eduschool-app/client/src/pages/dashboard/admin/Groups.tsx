import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router';
import { GROUP_PICK_KEY } from '../../../lib/groupPick';
import api from '../../../lib/api';
import { Plus, Users, Search, AlertCircle, ChevronUp, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Spinner } from '../../../components/ui/Spinner';
import { EmptyState } from '../../../components/ui/EmptyState';
import { GroupEditorModal } from '../../../components/ui/GroupEditorModal';
import SearchInput from '../../../components/ui/SearchInput';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Student {
  id: number;
  paidUntil?: string | null;
  isFrozen?: boolean;
  user: { id: number; firstName: string; lastName: string; email: string; phone?: string };
}

interface Block {
  id: number;
  type: 'GRAMMAR' | 'SPEAKING_CLUB';
  days: number[];
  startTime: string;
  endTime: string;
  teacher?: { userId: number; user: { firstName: string; lastName: string } } | null;
  cabinet?: { id: number; name: string } | null;
}

interface Group {
  id: number;
  level: string;
  chapter: number;
  maxStudents: number;
  status: 'ACTIVE' | 'COMPLETED' | 'PAUSED';
  comment?: string | null;
  startDate?: string;
  endDate?: string;
  students: Student[];
  blocks: Block[];
  _count: { students: number };
}

type SortKey = 'name' | 'schedule' | 'level' | 'cabinet' | 'students' | 'status';

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Активна', COMPLETED: 'Завершена', PAUSED: 'Пауза',
};
const STATUS_VARIANT: Record<string, 'success' | 'info' | 'frozen'> = {
  ACTIVE: 'success', COMPLETED: 'info', PAUSED: 'frozen',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Mirror the Students page status→colour mapping so groups read the same way.
function statusAvatarClass(status: Group['status']): string {
  return status === 'COMPLETED'
    ? 'bg-[#EFF6FF] text-[#0284C7]'
    : status === 'PAUSED'
    ? 'bg-warning/20 text-warning'
    : 'bg-success/20 text-success';
}
function statusLeftBorder(status: Group['status']): string {
  return status === 'COMPLETED'
    ? 'border-l-2 border-l-[#0284C7]'
    : status === 'PAUSED'
    ? 'border-l-2 border-l-warning'
    : 'border-l-2 border-l-success';
}

// First block's time window, shown like the student "Кабинет · Время" column.
function scheduleSummary(g: Group): string {
  const b = g.blocks[0];
  if (!b) return '—';
  return `${b.startTime ?? ''}–${b.endTime ?? ''}`.trim() || '—';
}

// First block's cabinet name.
function cabinetSummary(g: Group): string {
  return g.blocks[0]?.cabinet?.name || '—';
}

// Assigned teachers per block (grammar green / club blue) — same split as GroupDetail.
function blockTeachers(g: Group): { isClub: boolean; name: string }[] {
  return g.blocks
    .filter(b => b.teacher)
    .map(b => ({
      isClub: b.type === 'SPEAKING_CLUB',
      name: `${b.teacher!.user.firstName} ${b.teacher!.user.lastName}`,
    }));
}

function TeacherPills({ g }: { g: Group }) {
  const ts = blockTeachers(g);
  if (ts.length === 0) return <span className="text-xs text-textSecondary">—</span>;
  return (
    <div className="flex flex-wrap gap-1 min-w-0">
      {ts.map((t, i) => (
        <span
          key={i}
          className={`text-[10px] px-1.5 py-0.5 rounded border truncate ${
            t.isClub
              ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#0369A1]'
              : 'bg-[#F0FDF4] border-[#BBF7D0] text-[#15803D]'
          }`}
        >
          {t.isClub ? 'Кл' : 'Гр'}: {t.name}
        </span>
      ))}
    </div>
  );
}

function sortVal(g: Group, key: SortKey): string | number {
  switch (key) {
    case 'name': return (g.level || '').toLowerCase();
    case 'schedule': return g.blocks[0]?.startTime ?? '';
    case 'level': return (g.level || '').toLowerCase();
    case 'cabinet': return (g.blocks[0]?.cabinet?.name || '').toLowerCase();
    case 'students': return g._count.students ?? 0;
    case 'status': return g.status;
  }
}

// ─── Sortable column header (same behaviour as Students) ──────────────────────

function SortHeader({
  label, col, sort, onSort, className = '',
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort?.key === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={`flex items-center gap-1 uppercase tracking-widest transition-colors hover:text-textPrimary ${
        active ? 'text-textPrimary' : ''
      } ${className}`}
    >
      {label}
      {active && (sort!.dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
    </button>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Groups() {
  const navigate = useNavigate();
  const location = useLocation();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Search + sort live in the URL so they survive refresh (and are shareable).
  // They intentionally reset when you navigate away — no sticky persistence.
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Pick mode (experimental): reached via "Выбрать группу" on the schedule
  // create-block form. ?pick=1 is only valid while the form's stash exists —
  // a stray pick param (e.g. from a stale URL) is stripped.
  const pickMode = Boolean(searchParams.get('pick')) && sessionStorage.getItem(GROUP_PICK_KEY) != null;
  const [pickedId, setPickedId] = useState<number | null>(null);
  useEffect(() => {
    if (searchParams.get('pick') && !pickMode) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('pick');
        return next;
      }, { replace: true });
    }
  }, [searchParams, pickMode, setSearchParams]);

  function confirmPick() {
    const g = groups.find(x => x.id === pickedId);
    const raw = sessionStorage.getItem(GROUP_PICK_KEY);
    if (!g || !raw) return;
    let stash: Record<string, unknown>;
    try { stash = JSON.parse(raw); } catch { return; }
    const grammar = g.blocks.find(b => b.type === 'GRAMMAR' && b.teacher) ?? g.blocks.find(b => b.type === 'GRAMMAR');
    const club = g.blocks.find(b => b.type === 'SPEAKING_CLUB' && b.teacher) ?? g.blocks.find(b => b.type === 'SPEAKING_CLUB');
    stash.picked = {
      id: g.id,
      level: g.level,
      grammarTeacherId: grammar?.teacher?.userId ?? null,
      clubTeacherId: club?.teacher?.userId ?? null,
      grammarDays: grammar?.days ?? null,
      clubDays: club?.days ?? null,
      cabinetId: g.blocks.find(b => b.cabinet)?.cabinet?.id ?? null,
    };
    sessionStorage.setItem(GROUP_PICK_KEY, JSON.stringify(stash));
    navigate(`${location.pathname.replace(/\/groups$/, '/schedule')}?resumeGroupPick=1`);
  }

  function cancelPick() {
    sessionStorage.removeItem(GROUP_PICK_KEY);
    setPickedId(null);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('pick');
      return next;
    }, { replace: true });
  }
  const search = searchParams.get('q') ?? '';
  const sortParam = searchParams.get('sort');
  const sort = sortParam
    ? { key: sortParam.split(':')[0] as SortKey, dir: sortParam.split(':')[1] as 'asc' | 'desc' }
    : null;

  function setSearch(v: string) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (v) next.set('q', v); else next.delete('q');
      return next;
    }, { replace: true });
  }

  const fetchGroups = useCallback(async () => {
    try {
      const res = await api.get('/groups');
      setGroups(res.data?.data ?? []);
      setError(null);
    } catch {
      setError('Не удалось загрузить группы');
      setGroups([]);
      toast.error('Не удалось загрузить группы');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  // Cycle asc → desc → off, persisted in the URL so it survives refresh.
  function toggleSort(key: SortKey) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      const [ck, cd] = (prev.get('sort') ?? '').split(':');
      const val = ck !== key ? `${key}:asc` : cd === 'asc' ? `${key}:desc` : null;
      if (val) next.set('sort', val); else next.delete('sort');
      return next;
    }, { replace: true });
  }

  // ── Filter ──────────────────────────────────────────────────────────────
  const q = search.toLowerCase();
  const filtered = groups.filter(g =>
    !q || `${g.level} ${g.chapter}`.toLowerCase().includes(q),
  );

  // ── Sort (asc → desc → off). Empty values last. ───────────────────────────
  const sorted = sort
    ? [...filtered].sort((a, b) => {
        const av = sortVal(a, sort.key);
        const bv = sortVal(b, sort.key);
        let cmp: number;
        if (typeof av === 'number' && typeof bv === 'number') {
          cmp = av - bv;
        } else {
          const as = String(av), bs = String(bv);
          if (!as && bs) return 1;
          if (as && !bs) return -1;
          cmp = as.localeCompare(bs);
        }
        return sort.dir === 'asc' ? cmp : -cmp;
      })
    : filtered;

  return (
    <div className={`text-textPrimary ${pickMode ? 'pb-24' : ''}`}>

      {/* Pick-mode bar (experimental "Выбрать группу" flow from the schedule) —
          anchored to the bottom of the viewport so it stays visible while scrolling */}
      {pickMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-xl border border-primary/30 bg-surfaceLowest shadow-lg max-w-[calc(100vw-2rem)]">
          <p className="text-sm whitespace-nowrap overflow-hidden text-ellipsis">
            {pickedId
              ? <>Выбрана группа: <span className="font-semibold">{groups.find(g => g.id === pickedId)?.level ?? ''}</span></>
              : 'Выберите активную группу для блока расписания'}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            {pickedId && (
              <Button size="sm" onClick={confirmPick}>Подтвердить</Button>
            )}
            <Button variant="outline" size="sm" onClick={cancelPick}>Отмена</Button>
          </div>
        </div>
      )}

      {/* Header — search + actions in one row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-4">
        <SearchInput value={search} onChange={setSearch} className="flex-1" />
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4" />Новая группа
          </Button>
        </div>
      </div>

      {/* ── Group list ─────────────────────────────────────────────────────── */}
      <div className="bg-surfaceLowest rounded-xl border border-border overflow-hidden">

        {/* Table header (desktop) — sortable columns */}
        <div className="hidden md:grid grid-cols-[28px_minmax(0,1.6fr)_1.4fr_1fr_0.9fr_1.9fr_0.9fr_1fr] gap-3 px-4 py-3 border-b border-border/50 text-[10px] font-bold uppercase tracking-widest text-textSecondary">
          <span />
          <SortHeader label="Группа" col="name" sort={sort} onSort={toggleSort} />
          <span>Заметка</span>
          <SortHeader label="Расписание" col="schedule" sort={sort} onSort={toggleSort} />
          <SortHeader label="Кабинет" col="cabinet" sort={sort} onSort={toggleSort} />
          <span>Учителя</span>
          <SortHeader label="Студенты" col="students" sort={sort} onSort={toggleSort} />
          <SortHeader label="Статус" col="status" sort={sort} onSort={toggleSort} className="justify-start" />
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
          <EmptyState title="Произошла ошибка" description={error} icon={<AlertCircle size={40} />} />
        )}

        {/* Empty */}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState
            title="Группы не найдены"
            description={groups.length === 0 ? 'Групп пока нет' : 'Нет групп по выбранным фильтрам'}
            icon={<Search size={40} />}
          />
        )}

        {/* Rows */}
        {!loading && !error && sorted.map(group => {
          const avatarClass = statusAvatarClass(group.status);
          const leftBorder = statusLeftBorder(group.status);
          const schedule = scheduleSummary(group);
          const cabinet = cabinetSummary(group);

          const pickable = !pickMode || group.status === 'ACTIVE';
          return (
            <div
              key={group.id}
              onClick={() => {
                if (!pickMode) { navigate(String(group.id)); return; }
                if (group.status === 'ACTIVE') setPickedId(group.id);
              }}
              className={`grid md:grid-cols-[28px_minmax(0,1.6fr)_1.4fr_1fr_0.9fr_1.9fr_0.9fr_1fr] grid-cols-1 gap-3 px-4 py-3.5 border-b border-border/30 last:border-0 transition-colors items-center ${leftBorder} ${
                pickable ? 'cursor-pointer hover:bg-surfaceLow' : 'cursor-not-allowed opacity-50'
              } ${pickMode && pickedId === group.id ? 'bg-primary/10 hover:bg-primary/10' : ''}`}
            >
              {/* Avatar (desktop only in first col) */}
              <div className="hidden md:flex items-center justify-center">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${avatarClass}`}>
                  <Users className="w-3.5 h-3.5" />
                </div>
              </div>

              {/* Name + level */}
              <div className="flex items-center gap-3">
                <div className={`md:hidden w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${avatarClass}`}>
                  <Users className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-textPrimary truncate">{group.level || '—'}</p>
                  <p className="text-xs text-textSecondary truncate">Глава {group.chapter}</p>
                  {/* Mobile-only: extra info inline */}
                  <div className="md:hidden flex flex-wrap gap-x-3 gap-y-0.5 mt-1 items-center">
                    <span className="text-xs text-textSecondary">{schedule}</span>
                    {cabinet !== '—' && (
                      <span className="text-xs text-textSecondary">{cabinet}</span>
                    )}
                    <span className="text-xs text-textSecondary">{group._count.students}/{group.maxStudents} студ.</span>
                    <Badge variant={STATUS_VARIANT[group.status]}>{STATUS_LABEL[group.status]}</Badge>
                  </div>
                  <div className="md:hidden mt-1"><TeacherPills g={group} /></div>
                </div>
              </div>

              {/* Comment (desktop) */}
              <span className="hidden md:block text-xs text-textSecondary truncate" title={group.comment || undefined}>
                {group.comment}
              </span>

              {/* Schedule (desktop) */}
              <span className="hidden md:block text-xs text-textSecondary truncate">{schedule}</span>

              {/* Cabinet (desktop) */}
              <span className="hidden md:block text-xs text-textSecondary">{cabinet}</span>

              {/* Teachers (desktop) */}
              <div className="hidden md:block"><TeacherPills g={group} /></div>

              {/* Students (desktop) */}
              <span className="hidden md:block text-xs text-textSecondary">{group._count.students}/{group.maxStudents} студ.</span>

              {/* Badge (desktop) */}
              <div className="hidden md:flex justify-start">
                <Badge variant={STATUS_VARIANT[group.status]}>{STATUS_LABEL[group.status]}</Badge>
              </div>
            </div>
          );
        })}
      </div>

      <GroupEditorModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={() => { fetchGroups(); }}
      />
    </div>
  );
}
