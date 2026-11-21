import { useState, useEffect, useMemo } from 'react';
import { Loader2, Printer } from 'lucide-react';
import api from '../../../lib/api';
import { useAuth } from '../../../hooks/useAuth';
import { useTeacherSalaryApi } from '../../../hooks/useTeacherSalaryApi';
import { MonthYearPicker, currentPeriod, periodLabel } from '../../../components/ui/MonthYearPicker';

// Read-only mirror of the owner "Расчетный лист" (admin/SalaryPayslip.tsx):
// month calendar on the left + calculation card on the right. Fed by the
// teacher-self endpoints (/salary/my, /schedule/teacher-lesson-calendar), so no
// pay / edit / adjustment controls — a teacher only ever views their own slip.

interface CalendarLesson {
  date: string; // YYYY-MM-DD
  time: string;
  level: string;
  cabinet: string;
  isSubstitution?: boolean;
}

const MN = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DOW_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function fmt(n: number): string { return Math.round(n).toLocaleString('ru-RU'); }
function initials(name: string): string {
  return name.split(' ').map(p => p[0] ?? '').join('').toUpperCase().slice(0, 2);
}
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getMonthWeeks(year: number, month: number): Date[][] {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const dow = firstDay.getDay();
  const monday = new Date(firstDay);
  monday.setDate(firstDay.getDate() - (dow === 0 ? 6 : dow - 1));
  const weeks: Date[][] = [];
  const cur = new Date(monday);
  while (cur <= lastDay) {
    weeks.push(Array.from({ length: 7 }, (_, i) => {
      const d = new Date(cur);
      d.setDate(cur.getDate() + i);
      return d;
    }));
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}
function weekLabel(week: Date[]): string {
  const first = week[0];
  const last = week[6];
  if (first.getMonth() === last.getMonth()) {
    return `${first.getDate()}–${last.getDate()} ${MN[first.getMonth()].toLowerCase()}`;
  }
  return `${first.getDate()} ${MN[first.getMonth()].toLowerCase()} – ${last.getDate()} ${MN[last.getMonth()].toLowerCase()}`;
}

export default function TeacherSalary() {
  const { user } = useAuth();
  const staffName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Преподаватель';

  const [period, setPeriod] = useState(currentPeriod);
  const { data: salary, loading: salaryLoading } = useTeacherSalaryApi(period);

  const [calLessons, setCalLessons] = useState<CalendarLesson[]>([]);
  const [calLoading, setCalLoading] = useState(false);

  useEffect(() => {
    const [year, month] = period.split('-').map(Number);
    setCalLessons([]);
    setCalLoading(true);
    api.get(`/schedule/teacher-lesson-calendar?year=${year}&month=${month}`)
      .then(res => setCalLessons(res.data?.data ?? []))
      .catch(() => { })
      .finally(() => setCalLoading(false));
  }, [period]);

  const monthWeeks = useMemo(() => {
    const [year, month] = period.split('-').map(Number);
    return getMonthWeeks(year, month);
  }, [period]);

  const lessonsByDate = useMemo(() => {
    const map: Record<string, CalendarLesson[]> = {};
    for (const l of calLessons) {
      if (!map[l.date]) map[l.date] = [];
      map[l.date].push(l);
    }
    return map;
  }, [calLessons]);

  const [y, m] = period.split('-').map(Number);
  const todayIso = isoDate(new Date());
  const hasAdjustments = !!salary && (salary.bonuses > 0 || salary.fines > 0 || salary.advances > 0);

  if (salaryLoading && !salary) {
    return (
      <div className="h-full flex flex-col items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-textSecondary mt-4 animate-pulse">Загрузка расчетного листа...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">

      {/* Left: payslip card */}
      <div className="order-2 lg:order-1 flex-1 w-full max-w-2xl min-w-0">
        <div className="bg-background rounded-2xl shadow-xl border border-border/40 p-4 lg:p-8">

          {/* Header */}
          <div className="flex items-start justify-between pb-6 border-b border-border/40 mb-6">
            <div>
              <h1 className="font-serif text-2xl text-textPrimary">Расчетный лист</h1>
              <div className="mt-2">
                <MonthYearPicker value={period} onChange={setPeriod} />
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 text-sm bg-background border border-border/60 rounded-lg hover:bg-surfaceLow transition-colors text-textSecondary hover:text-textPrimary"
            >
              <Printer className="w-3.5 h-3.5" />Печать
            </button>
          </div>

          {/* Staff info */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <span className="text-primary font-bold">{initials(staffName)}</span>
            </div>
            <div className="flex-1">
              <p className="font-semibold text-textPrimary text-lg">{staffName}</p>
              <p className="text-xs text-textSecondary">{periodLabel(period)}</p>
            </div>
            {salary && (
              <span className={`text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${
                salary.isPaid ? 'bg-success/10 text-success' : 'bg-surfaceLow text-textSecondary'
              }`}>
                {salary.isPaid ? 'Выплачено' : 'Ожидает'}
              </span>
            )}
          </div>

          {/* Month calendar */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-3">Расписание месяца</p>

            {calLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              </div>
            ) : calLessons.length === 0 ? (
              <div className="rounded-xl border border-border bg-surfaceLowest py-8 text-center">
                <p className="text-sm font-medium text-textSecondary">Уроков в этом периоде нет</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {monthWeeks.map((week, wi) => (
                  <div key={wi}>
                    <div className="flex items-center gap-2 px-2 py-1 mb-1.5 text-textSecondary/50">
                      <span className="text-[10px] font-bold uppercase tracking-wider">{weekLabel(week)}</span>
                    </div>
                    <div className="overflow-x-auto -mx-2">
                      <div className="grid grid-cols-7 gap-0.5 px-1">
                        {week.map((date, idx) => {
                          const iso = isoDate(date);
                          const dayLessons = (lessonsByDate[iso] ?? []).sort((a, b) => a.time.localeCompare(b.time));
                          const isToday = iso === todayIso;
                          const inMonth = date.getMonth() + 1 === m && date.getFullYear() === y;

                          return (
                            <div key={idx} className="flex flex-col">
                              {wi === 0 && (
                                <div className={`text-center pb-0.5 ${isToday ? 'text-primary' : 'text-textSecondary/50'}`}>
                                  <div className="text-[9px] font-black uppercase tracking-widest">{DOW_LABELS[idx]}</div>
                                </div>
                              )}
                              <div className={`text-center pb-1 ${isToday ? 'text-primary' : inMonth ? 'text-textSecondary' : 'text-textSecondary/30'}`}>
                                <div className={`text-[15px] font-bold w-6 h-6 rounded-full flex items-center justify-center mx-auto ${isToday ? 'bg-primary text-white' : ''}`}>
                                  {date.getDate()}
                                </div>
                                {inMonth && (
                                  <>
                                    <div className="mx-1 mt-1 mb-0.5 border-t border-border/70" />
                                    <div className="text-[9px] font-semibold text-textSecondary/60">{dayLessons.length}</div>
                                  </>
                                )}
                              </div>
                              {!inMonth ? (
                                <div className="rounded-lg bg-surfaceLowest/40 border border-border/10 min-h-[44px]" />
                              ) : dayLessons.length === 0 ? (
                                <div className="rounded-lg bg-surfaceLowest border border-border/20 min-h-[44px] flex items-center justify-center">
                                  <span className="text-[9px] text-textSecondary/30">—</span>
                                </div>
                              ) : (
                                <div className="flex flex-col gap-0.5">
                                  {dayLessons.map((lesson, li) => (
                                    <div
                                      key={li}
                                      title={`${lesson.time} · ${lesson.level} · каб. ${lesson.cabinet}${lesson.isSubstitution ? ' · замена' : ''}`}
                                      className={`rounded-lg border p-1.5 text-[9px] flex flex-col gap-0.5 ${
                                        lesson.isSubstitution ? 'border-amber-300 bg-amber-50' : 'border-border/40 bg-surfaceLowest'
                                      }`}
                                    >
                                      <span className={`font-bold leading-none ${lesson.isSubstitution ? 'text-amber-700' : 'text-textSecondary/70'}`}>
                                        {lesson.time}
                                      </span>
                                      <span className="text-textSecondary/80 truncate leading-tight">{lesson.level}</span>
                                      {lesson.isSubstitution && (
                                        <span className="text-amber-700/70 font-bold leading-none">замена</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: calculation card */}
      <div className="order-1 lg:order-2 w-full lg:w-72 lg:flex-shrink-0 lg:sticky lg:top-4">
        <div className="bg-background rounded-2xl shadow-xl border border-border/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-border/40">
            <p className="text-sm font-semibold text-textPrimary">Расчёт за период</p>
            <p className="text-[10px] text-textSecondary mt-0.5">Месяц: {periodLabel(period)}</p>
          </div>

          {!salary ? (
            <div className="p-4 text-center text-[11px] text-textSecondary/60">Нет данных за период</div>
          ) : (
            <div className="p-4 flex flex-col gap-4">

              {/* Начисление */}
              <div className="bg-surfaceLowest border border-border/40 rounded-xl px-4 py-3 space-y-2 text-sm">
                <p className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-3">Начисление</p>
                <div className="flex justify-between">
                  <span className="text-textSecondary">Проведено</span>
                  <span className="font-semibold text-textPrimary">{salary.lessonsCount} ур.</span>
                </div>
                {salary.manualDelta !== 0 && (
                  <div className="flex justify-between">
                    <span className="text-textSecondary">Корректировка уроков</span>
                    <span className={`font-semibold ${salary.manualDelta > 0 ? 'text-success' : 'text-danger'}`}>
                      {salary.manualDelta > 0 ? '+' : ''}{salary.manualDelta}
                    </span>
                  </div>
                )}
                {salary.manualEntries.length > 0 && (
                  <div className="pl-3 space-y-1 border-l-2 border-border/30">
                    {salary.manualEntries.map(e => (
                      <div key={e.id} className="flex justify-between text-xs">
                        <span className="text-textSecondary truncate">{e.label}</span>
                        <span className={e.type === 'ADD' ? 'text-success' : 'text-danger'}>
                          {e.type === 'ADD' ? '+' : '−'}{e.count}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-textSecondary">Итого уроков</span>
                  <span className="font-semibold text-textPrimary">{salary.effectiveLessons}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-textSecondary">Ставка</span>
                  <span className="font-semibold text-textPrimary">{fmt(salary.salaryRate)} сом/урок</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-border/40">
                  <span className="text-textSecondary">Заработано</span>
                  <span className="font-semibold text-textPrimary">{fmt(salary.gross)} сом</span>
                </div>
              </div>

              {/* Корректировки */}
              {hasAdjustments && (
                <div className="bg-surfaceLowest border border-border/40 rounded-xl px-4 py-3 space-y-2 text-sm">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-1">Корректировки</p>
                  {salary.bonuses > 0 && (
                    <div className="flex justify-between">
                      <span className="text-textSecondary">Бонусы</span>
                      <span className="font-semibold text-success">+{fmt(salary.bonuses)} сом</span>
                    </div>
                  )}
                  {salary.fines > 0 && (
                    <div className="flex justify-between">
                      <span className="text-textSecondary">Штрафы</span>
                      <span className="font-semibold text-danger">−{fmt(salary.fines)} сом</span>
                    </div>
                  )}
                  {salary.advances > 0 && (
                    <div className="flex justify-between">
                      <span className="text-textSecondary">Авансы</span>
                      <span className="font-semibold text-textSecondary">−{fmt(salary.advances)} сом</span>
                    </div>
                  )}
                </div>
              )}

              {/* К выплате */}
              <div className="rounded-xl border border-border/40 overflow-hidden">
                <div className="bg-primary/5 border-t border-primary/20 px-4 py-3 flex justify-between items-center">
                  <span className="font-bold text-textPrimary text-sm">К выплате</span>
                  <span className="font-bold text-xl text-primary">{fmt(salary.net)} сом</span>
                </div>
              </div>

              {/* Payment status */}
              <div className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold ${
                salary.isPaid
                  ? 'bg-success/10 border border-success/20 text-success'
                  : 'bg-surfaceLow border border-border/20 text-textSecondary'
              }`}>
                <span>{salary.isPaid ? `✓ Выплачено ${fmt(salary.paidAmount)} сом` : 'Ожидает выплаты'}</span>
              </div>

            </div>
          )}
        </div>
      </div>

    </div>
  );
}
