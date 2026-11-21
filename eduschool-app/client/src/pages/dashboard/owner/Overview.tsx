import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import {
  GraduationCap, Users, BookOpen, TrendingUp,
  Wallet, AlertCircle, UserCheck, TrendingDown,
  CheckCircle, CalendarX,
} from 'lucide-react';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../../../lib/api';
import { Spinner } from '../../../components/ui/Spinner';
import { StatCard } from '../../../components/ui/StatCard';
import { Badge } from '../../../components/ui/Badge';

const CURRENCY_SYMBOLS: Record<string, string> = {
  KGS: 'с', USD: '$', EUR: '€', RUB: '₽', KZT: '₸',
};

function fmt(n: number, symbol: string) {
  return `${n.toLocaleString('ru-RU')} ${symbol}`;
}

interface WorkloadEntry {
  name: string;
  sessions: number;
  target: number;
}


export default function Overview() {
  const { slug } = useParams<{ slug: string }>();
  const [stats, setStats]   = useState<any>(null);
  const [salary, setSalary] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [workload, setWorkload] = useState<WorkloadEntry[]>([]);
  const [workloadLoading, setWorkloadLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [currencySymbol, setCurrencySymbol] = useState<string>('с');

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const period = new Date().toISOString().slice(0, 7);
    Promise.all([
      api.get('/stats/dashboard').catch(() => null),
      api.get(`/salary?period=${period}`).catch(() => null),
      api.get('/settings/general').catch(() => null),
    ]).then(([overviewRes, salaryRes, generalRes]) => {
      setStats(overviewRes?.data?.data ?? overviewRes?.data ?? null);
      setSalary(salaryRes?.data?.data ?? []);
      const code = generalRes?.data?.data?.currency ?? 'KGS';
      setCurrencySymbol(CURRENCY_SYMBOLS[code] ?? code + ' ');
    }).finally(() => setLoading(false));

    api.get('/stats/teacher-workload')
      .then(r => setWorkload(r.data.data ?? []))
      .catch(() => { /* intentional — mount fetch */ })
      .finally(() => setWorkloadLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Spinner />
        <p className="text-textSecondary mt-4 animate-pulse italic text-sm">Загрузка данных кампуса...</p>
      </div>
    );
  }

  const cur = currencySymbol;

  const totalUnpaid  = salary.filter(t => !t.isPaid).reduce((s: number, t: any) => s + (t.net ?? 0), 0);
  const unpaidCount  = salary.filter(t => !t.isPaid).length;
  const lowAttGroups = (stats?.blockAttendance ?? []).filter((b: any) => b.rate < 75);
  const lowBalance   = stats?.lowBalanceStudents ?? [];
  const base         = `/${slug}/owner`;

  return (
    <div className="space-y-14">

      {/* ── Заголовок ── */}
      <section className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="font-serif text-2xl text-textPrimary">Панель управления</h1>
          <p className="text-textSecondary text-xs mt-1 tracking-wide">
            {format(currentTime, 'EEEE, d MMMM yyyy • HH:mm:ss', { locale: ru })}
          </p>
        </div>
      </section>

      {/* ── Section 1: KPI Bar ── */}
      <section>
        {/* Row 1 — Люди */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
          <StatCard
            label="Студентов"
            value={stats?.totalStudents ?? 0}
            icon={<Users className="w-5 h-5" />}
            to={`${base}/students`}
          />
          <StatCard
            label="Преподавателей"
            value={stats?.totalTeachers ?? 0}
            icon={<GraduationCap className="w-5 h-5" />}
            to={`${base}/teachers`}
          />
          <StatCard
            label="Активных групп"
            value={stats?.activeLessons ?? 0}
            sub="занятий в расписании"
            icon={<BookOpen className="w-5 h-5" />}
            to={`${base}/groups`}
          />
        </div>

        {/* Row 2 — Деньги и риски */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <StatCard
            label="Доход (месяц)"
            value={fmt(stats?.revenue ?? 0, cur)}
            sub="поступило от студентов"
            color="text-primary"
            icon={<TrendingUp className="w-5 h-5" />}
            to={`${base}/finance-dashboard`}
          />
          <StatCard
            label="Выплаты"
            value={fmt(totalUnpaid, cur)}
            sub={unpaidCount > 0 ? `${unpaidCount} учителей ожидают` : 'все выплачены'}
            color={totalUnpaid > 0 ? 'text-amber-600' : 'text-textPrimary'}
            icon={<Wallet className="w-5 h-5" />}
            to={`${base}/salary`}
          />
          <StatCard
            label="Расписание"
            value={stats?.cancelledSessions ?? 0}
            sub={(stats?.cancelledSessions ?? 0) > 0 ? 'уроков отменено за 7 дней' : 'нет отменённых за 7 дней'}
            color={(stats?.cancelledSessions ?? 0) > 0 ? 'text-danger' : 'text-textPrimary'}
            icon={<CalendarX className="w-5 h-5" />}
            to={`${base}/schedule`}
          />
        </div>
      </section>

      {/* ── Section 4: Требует внимания ── */}
      <section>
        <div className="flex items-center gap-4 mb-6">
          <h3 className="text-2xl font-serif font-bold text-surface tracking-tight whitespace-nowrap">Требует внимания</h3>
          <div className="h-px flex-1 bg-border/30" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">

          {/* Заявки */}
          {(() => {
            const count = stats?.pendingEnrollments ?? 0;
            const has   = count > 0;
            return (
              <Link to={`${base}/students`} className="block rounded-3xl p-7 border bg-surfaceLow border-border/5 transition hover:-translate-y-0.5">
                <div className={`w-11 h-11 rounded-2xl flex items-center justify-center mb-5 ${has ? 'bg-amber-500/15' : 'bg-primary/10'}`}>
                  {has ? <UserCheck className="w-5 h-5 text-amber-400" /> : <CheckCircle className="w-5 h-5 text-primary" />}
                </div>
                <p className={`text-4xl font-serif font-bold mb-2 ${has ? 'text-amber-400' : 'text-primary'}`}>{count}</p>
                <p className="text-[11px] font-black uppercase tracking-[0.15em] text-textSecondary/60">
                  {has ? 'заявок ожидают подтверждения' : 'нет новых заявок'}
                </p>
              </Link>
            );
          })()}

          {/* Должники */}
          {(() => {
            const has = lowBalance.length > 0;
            return (
              <Link to={`${base}/students`} className="block rounded-3xl p-7 border bg-surfaceLow border-border/5 transition hover:-translate-y-0.5">
                <div className={`w-11 h-11 rounded-2xl flex items-center justify-center mb-5 ${has ? 'bg-red-500/15' : 'bg-primary/10'}`}>
                  {has ? <AlertCircle className="w-5 h-5 text-red-400" /> : <CheckCircle className="w-5 h-5 text-primary" />}
                </div>
                {has ? (
                  <div className="space-y-1.5 mb-3">
                    {lowBalance.slice(0, 4).map((s: any) => (
                      <div key={s.id} className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-surface truncate">{s.name}</span>
                        <span className="text-[10px] font-black text-red-400 flex-shrink-0">{s.credits} кр.</span>
                      </div>
                    ))}
                    {lowBalance.length > 4 && (
                      <p className="text-[10px] text-textSecondary/50 italic">+ ещё {lowBalance.length - 4}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-4xl font-serif font-bold text-primary mb-2">0</p>
                )}
                <p className="text-[11px] font-black uppercase tracking-[0.15em] text-textSecondary/60">
                  {has ? 'студентов < 3 кредитов' : 'все студенты оплачены'}
                </p>
              </Link>
            );
          })()}

          {/* Низкая посещаемость */}
          {(() => {
            const has = lowAttGroups.length > 0;
            return (
              <Link to={`${base}/schedule`} className="block rounded-3xl p-7 border bg-surfaceLow border-border/5 transition hover:-translate-y-0.5">
                <div className={`w-11 h-11 rounded-2xl flex items-center justify-center mb-5 ${has ? 'bg-red-500/15' : 'bg-primary/10'}`}>
                  {has ? <TrendingDown className="w-5 h-5 text-red-400" /> : <CheckCircle className="w-5 h-5 text-primary" />}
                </div>
                {has ? (
                  <div className="space-y-1.5 mb-3">
                    {lowAttGroups.slice(0, 4).map((b: any) => (
                      <div key={b.id} className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-surface truncate">{b.level}</span>
                        <span className="text-[10px] font-black text-red-400 flex-shrink-0">{b.rate}%</span>
                      </div>
                    ))}
                    {lowAttGroups.length > 4 && (
                      <p className="text-[10px] text-textSecondary/50 italic">+ ещё {lowAttGroups.length - 4}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-4xl font-serif font-bold text-primary mb-2">0</p>
                )}
                <p className="text-[11px] font-black uppercase tracking-[0.15em] text-textSecondary/60">
                  {has ? 'групп с посещаемостью < 75%' : 'все группы в норме'}
                </p>
              </Link>
            );
          })()}

        </div>
      </section>

      {/* ── Section 5: Посещаемость за 30 дней ── */}
      <section>
        <div className="flex items-center gap-4 mb-6">
          <h3 className="text-2xl font-serif font-bold text-surface tracking-tight whitespace-nowrap">Посещаемость за 30 дней</h3>
          <div className="h-px flex-1 bg-border/30" />
        </div>

        {stats?.attendanceStats?.total > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-surfaceLow rounded-3xl p-8 border border-border/5">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-textSecondary/60 mb-6">Распределение</p>
              <div className="flex items-center gap-6">
                <div className="w-40 h-40 flex-shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={[
                          { name: 'Присутствовал', value: stats.attendanceStats.presentCount },
                          { name: 'Отсутствовал',  value: stats.attendanceStats.absentCount  },
                          { name: 'Опоздал',       value: stats.attendanceStats.lateCount    },
                        ]}
                        cx="50%" cy="50%"
                        innerRadius={42} outerRadius={64}
                        paddingAngle={3}
                        dataKey="value"
                      >
                        <Cell fill="#2563EB" />
                        <Cell fill="#ef4444" />
                        <Cell fill="#f59e0b" />
                      </Pie>
                      <Tooltip formatter={(v: number) => [`${v} занятий`]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex-1 space-y-3">
                  <div className="text-4xl font-serif font-bold text-primary">{stats.attendanceStats.rate}%</div>
                  <p className="text-xs text-textSecondary">общая посещаемость</p>
                  {[
                    { label: 'Присутствовал', count: stats.attendanceStats.presentCount, color: 'bg-primary'   },
                    { label: 'Отсутствовал',  count: stats.attendanceStats.absentCount,  color: 'bg-danger'    },
                    { label: 'Опоздал',       count: stats.attendanceStats.lateCount,    color: 'bg-amber-400' },
                  ].map(r => (
                    <div key={r.label} className="flex items-center gap-2 text-xs text-textSecondary">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${r.color}`} />
                      <span className="flex-1">{r.label}</span>
                      <span className="font-bold text-surface">{r.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-surfaceLow rounded-3xl p-8 border border-border/5">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-textSecondary/60 mb-6">По группам</p>
              <div className="space-y-3">
                {(stats.blockAttendance ?? []).map((b: any) => (
                  <div key={b.id} className="flex items-center gap-3">
                    <div className="w-20 flex-shrink-0">
                      <p className="text-xs font-bold text-surface truncate">{b.level}</p>
                      <p className="text-[10px] text-textSecondary">{b.startTime}</p>
                    </div>
                    <div className="flex-1 bg-border/20 rounded-full h-1.5">
                      <div
                        className={`h-1.5 rounded-full transition ${b.rate >= 75 ? 'bg-primary' : b.rate >= 50 ? 'bg-amber-400' : 'bg-danger'}`}
                        style={{ width: `${b.rate}%` }}
                      />
                    </div>
                    <span className="text-xs font-bold text-surface w-9 text-right">{b.rate}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-surfaceLow rounded-3xl p-12 text-center border border-border/5">
            <p className="text-sm text-textSecondary font-serif italic">Нет данных посещаемости за последние 30 дней</p>
            <p className="text-[10px] text-textSecondary/40 uppercase tracking-widest mt-2">Посещаемость отмечается через расписание</p>
          </div>
        )}
      </section>

      {/* ── Section 6: Загруженность преподавателей ── */}
      <section>
        <div className="flex items-center gap-4 mb-2">
          <h3 className="text-2xl font-serif font-bold text-surface tracking-tight whitespace-nowrap">Загруженность преподавателей</h3>
          <div className="h-px flex-1 bg-border/30" />
        </div>
        <p className="text-[11px] text-textSecondary/50 uppercase tracking-widest font-bold mb-5">Уроков за текущую неделю</p>

        <div className="bg-surfaceLow rounded-3xl p-6 border border-border/5">
          {workloadLoading ? (
            <div className="flex items-center justify-center h-32"><Spinner /></div>
          ) : (() => {
            const active = workload.filter(w => w.sessions >= 1);
            if (active.length === 0) {
              return (
                <div className="flex flex-col items-center justify-center h-32 gap-3">
                  <div className="w-12 h-12 bg-border/10 rounded-full flex items-center justify-center">
                    <GraduationCap className="w-5 h-5 text-textSecondary/20" />
                  </div>
                  <p className="text-sm text-textSecondary/40 font-serif italic">Нет уроков на этой неделе</p>
                </div>
              );
            }
            const maxSessions = Math.max(...active.map(w => w.sessions));
            return (
              <div className="space-y-3">
                {active.map((w) => {
                  const parts = w.name.split(' ');
                  const displayName = parts.length >= 2 ? `${parts[0]} ${parts[1][0]}.` : w.name;
                  const barPct = (w.sessions / maxSessions) * 100;
                  return (
                    <div key={w.name} className="flex items-center gap-4">
                      <span className="text-xs font-medium text-surface w-28 flex-shrink-0 truncate">{displayName}</span>
                      <div className="flex-1 bg-border/20 rounded-full h-1.5">
                        <div
                          className="h-1.5 rounded-full bg-primary transition"
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold text-surface w-20 text-right flex-shrink-0 whitespace-nowrap">
                        {w.sessions} {w.sessions === 1 ? 'урок' : w.sessions < 5 ? 'урока' : 'уроков'}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </section>

      {/* ── Section 7: Последние события ── */}
      {(stats?.recentEvents ?? []).length > 0 && (
        <section>
          <div className="flex items-center gap-4 mb-6">
            <h3 className="text-2xl font-serif font-bold text-surface tracking-tight whitespace-nowrap">Последние события</h3>
            <div className="h-px flex-1 bg-border/30" />
          </div>
          <div className="bg-surfaceLow rounded-3xl border border-border/5 divide-y divide-border/10 overflow-hidden">
            {(stats.recentEvents as any[]).slice(0, 8).map((ev: any) => (
              <div key={ev.id} className="flex items-center gap-4 px-6 py-4">
                <Badge variant={ev.type === 'TOPUP' ? 'success' : 'warning'} size="sm">
                  {ev.type === 'TOPUP' ? 'Пополнение' : 'Корректировка'}
                </Badge>
                <p className="flex-1 text-sm text-surface">{ev.text}</p>
                <p className="text-[11px] text-textSecondary flex-shrink-0">
                  {new Date(ev.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}
