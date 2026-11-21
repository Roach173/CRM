import { useEffect, useState } from 'react';
import { useAuth } from '../../../hooks/useAuth';
import api from '../../../lib/api';
import { Spinner } from '../../../components/ui/Spinner';
import { Badge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { AlertCircle, BookOpen, CreditCard, Calendar, Clock, CheckCircle, XCircle } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Block {
  id: number;
  type: 'GRAMMAR' | 'SPEAKING_CLUB';
  days: number[];
  startTime: string;
  endTime: string;
}

interface Group {
  id: number;
  level: string;
  blocks: Block[];
}

interface Child {
  studentProfileId: number;
  name: string;
  phone?: string;
  credits: number;
  level: string | null;
  isFrozen: boolean;
  atRiskSince: string | null;
  groups: Group[];
}

interface AttendanceRecord {
  id: number;
  status: 'PRESENT' | 'ABSENT' | 'LATE' | 'FROZEN';
  creditDeducted: boolean;
  createdAt: string;
  lessonSession: {
    date: string;
    startTimeSnap: string | null;
    endTimeSnap: string | null;
    lessonBlock: {
      type: string;
      studentGroup: { level: string } | null;
    };
  };
}

interface UpcomingSession {
  id: number;
  date: string;
  status: string;
  startTimeSnap: string | null;
  endTimeSnap: string | null;
  lessonBlock: {
    type: string;
    studentGroup: { level: string } | null;
    cabinet: { name: string } | null;
  };
  teacher: { user: { firstName: string; lastName: string } } | null;
}

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function statusBadge(status: string) {
  if (status === 'PRESENT') return <Badge variant="success">Присутствовал</Badge>;
  if (status === 'LATE')    return <Badge variant="warning">Опоздал</Badge>;
  if (status === 'FROZEN')  return <Badge variant="info">Заморожен</Badge>;
  return <Badge variant="danger">Отсутствовал</Badge>;
}

// ─── ChildCard ────────────────────────────────────────────────────────────────

function ChildCard({ child, selected, onClick }: { child: Child; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border-2 transition ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 bg-card'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-foreground">{child.name}</p>
          <p className="text-sm text-muted-foreground">{child.level ?? 'Уровень не задан'}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {child.atRiskSince && (
            <Badge variant="danger" className="text-xs">Риск ухода</Badge>
          )}
          {child.isFrozen && (
            <Badge variant="info" className="text-xs">Заморожен</Badge>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-1">
          <CreditCard className="w-3.5 h-3.5" />
          {child.credits} кредитов
        </span>
        <span className="flex items-center gap-1">
          <BookOpen className="w-3.5 h-3.5" />
          {child.groups.length} {child.groups.length === 1 ? 'группа' : 'групп'}
        </span>
      </div>
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ParentDashboard() {
  const { user } = useAuth();
  const [children, setChildren] = useState<Child[]>([]);
  const [selectedChild, setSelectedChild] = useState<Child | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [schedule, setSchedule] = useState<UpcomingSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'schedule' | 'attendance'>('schedule');

  useEffect(() => {
    api.get('/parent/me/children')
      .then(res => {
        const list: Child[] = res.data.data;
        setChildren(list);
        if (list.length > 0) setSelectedChild(list[0]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedChild) return;
    setDetailLoading(true);
    const id = selectedChild.studentProfileId;
    Promise.all([
      api.get(`/parent/me/children/${id}/schedule`),
      api.get(`/parent/me/children/${id}/attendance`),
    ]).then(([sRes, aRes]) => {
      setSchedule(sRes.data.data);
      setAttendance(aRes.data.data);
    }).finally(() => setDetailLoading(false));
  }, [selectedChild]);

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Spinner />
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          Добрый день, {user?.firstName}
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">Портал для родителей</p>
      </div>

      {children.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="w-10 h-10 text-muted-foreground" />}
          title="Дети не привязаны"
          description="Обратитесь к администратору школы для привязки ребёнка к вашему аккаунту"
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Список детей */}
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Мои дети</h2>
            {children.map(child => (
              <ChildCard
                key={child.studentProfileId}
                child={child}
                selected={selectedChild?.studentProfileId === child.studentProfileId}
                onClick={() => setSelectedChild(child)}
              />
            ))}
          </div>

          {/* Детальная панель */}
          <div className="lg:col-span-2 space-y-4">
            {selectedChild && (
              <>
                {/* Предупреждение о риске */}
                {selectedChild.atRiskSince && (
                  <div className="flex items-start gap-3 p-4 rounded-xl bg-red-50 border border-red-200">
                    <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-red-800">Внимание: пропуски уроков</p>
                      <p className="text-sm text-red-600 mt-0.5">
                        {selectedChild.name} пропустил(а) несколько уроков подряд. Рекомендуем связаться с администратором.
                      </p>
                    </div>
                  </div>
                )}

                {/* Группы */}
                {selectedChild.groups.length > 0 && (
                  <div className="bg-card border border-border rounded-xl p-4">
                    <h3 className="font-semibold text-foreground mb-3">Группы</h3>
                    <div className="space-y-2">
                      {selectedChild.groups.map(g => (
                        <div key={g.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                          <div>
                            <p className="font-medium text-sm">{g.level}</p>
                          </div>
                          <div className="text-xs text-muted-foreground text-right">
                            {g.blocks.map(b => (
                              <div key={b.id}>
                                {b.type === 'GRAMMAR' ? 'Грамматика' : 'Клуб'} · {b.startTime}–{b.endTime}
                                <br />
                                {b.days.map(d => DAY_NAMES[d]).join(', ')}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Табы */}
                <div className="flex gap-2 border-b border-border">
                  {(['schedule', 'attendance'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                        activeTab === tab
                          ? 'border-primary text-primary'
                          : 'border-transparent text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {tab === 'schedule' ? 'Ближайшие уроки' : 'Посещаемость'}
                    </button>
                  ))}
                </div>

                {detailLoading ? (
                  <div className="flex justify-center py-8"><Spinner /></div>
                ) : activeTab === 'schedule' ? (
                  <div className="space-y-2">
                    {schedule.length === 0 ? (
                      <EmptyState
                        icon={<Calendar className="w-8 h-8 text-muted-foreground" />}
                        title="Уроков нет"
                        description="Ближайшие 2 недели уроков не запланировано"
                      />
                    ) : schedule.map(s => (
                      <div key={s.id} className="flex items-center justify-between p-3 bg-card border border-border rounded-lg">
                        <div className="flex items-center gap-3">
                          <div className="text-center w-10">
                            <p className="text-xs text-muted-foreground">{formatDate(s.date)}</p>
                          </div>
                          <div>
                            <p className="text-sm font-medium">
                              {s.lessonBlock.studentGroup?.level ?? '—'} · {s.lessonBlock.type === 'GRAMMAR' ? 'Грамматика' : 'Клуб'}
                            </p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {s.startTimeSnap ?? '?'}–{s.endTimeSnap ?? '?'}
                              {s.lessonBlock.cabinet && ` · каб. ${s.lessonBlock.cabinet.name}`}
                              {s.teacher && ` · ${s.teacher.user.firstName} ${s.teacher.user.lastName}`}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {attendance.length === 0 ? (
                      <EmptyState
                        icon={<CheckCircle className="w-8 h-8 text-muted-foreground" />}
                        title="Записей нет"
                        description="История посещаемости пока пуста"
                      />
                    ) : attendance.map(a => (
                      <div key={a.id} className="flex items-center justify-between p-3 bg-card border border-border rounded-lg">
                        <div className="flex items-center gap-3">
                          {a.status === 'PRESENT' ? (
                            <CheckCircle className="w-4 h-4 text-green-500" />
                          ) : a.status === 'LATE' ? (
                            <Clock className="w-4 h-4 text-yellow-500" />
                          ) : a.status === 'FROZEN' ? (
                            <AlertCircle className="w-4 h-4 text-blue-500" />
                          ) : (
                            <XCircle className="w-4 h-4 text-red-500" />
                          )}
                          <div>
                            <p className="text-sm font-medium">
                              {a.lessonSession.lessonBlock.studentGroup?.level ?? '—'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatDate(a.lessonSession.date)}
                              {a.lessonSession.startTimeSnap && ` · ${a.lessonSession.startTimeSnap}`}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {/* Freeze-skipped lesson (no credit charged) keeps its real
                              present/absent status but is tagged «на паузе». Legacy FROZEN
                              rows already read as paused via statusBadge. */}
                          {a.status !== 'FROZEN' && a.creditDeducted === false && (
                            <Badge variant="info">на паузе</Badge>
                          )}
                          {statusBadge(a.status)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
