import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ChevronLeft, ChevronUp, Printer, Loader2, Plus, X, Pencil, Clock } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Spinner } from '../../../components/ui/Spinner';
import { usePermissions } from '../../../hooks/usePermissions';
import { useSalaryApi, type PaymentHistoryEntry, type SalaryAdjustment } from '../../../hooks/useSalaryApi';
import { MonthYearPicker, currentPeriod, periodLabel } from '../../../components/ui/MonthYearPicker';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../../hooks/useBackButtonClose';

const MN = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function fmt(n: number): string { return Math.round(n).toLocaleString('ru-RU'); }

function initials(name: string): string {
  return name.split(' ').map(p => p[0] ?? '').join('').toUpperCase().slice(0, 2);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()}`;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type AdjType = 'FINE' | 'ADVANCE' | 'BONUS';
const ADJ_LABEL: Record<AdjType, string> = { FINE: 'Штраф', ADVANCE: 'Аванс', BONUS: 'Бонус' };

const DOW_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface CalLesson {
  id: number;
  date: string;
  time: string;
  level: string;
  groupName: string;
  cabinet: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'UPCOMING' | string;
  cancelled: boolean;
  isSubstitution: boolean;
  paymentId: number | null;
}

function getMonthWeeks(year: number, month: number): Date[][] {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const dow = firstDay.getDay();
  const monday = new Date(firstDay);
  monday.setDate(firstDay.getDate() - (dow === 0 ? 6 : dow - 1));
  const weeks: Date[][] = [];
  let cur = new Date(monday);
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

export default function SalaryPayslip() {
  const { staffId } = useParams<{ staffId: string }>();
  const navigate = useNavigate();
  const { canPaySalary } = usePermissions();

  const [period, setPeriod] = useState(currentPeriod);
  const {
    data: staffSalaries,
    loading: salaryLoading,
    payWithSessions,
    cancelPay,
    fetchPaymentHistory,
    addAdjustment,
    deleteAdjustment,
    updateRate,
  } = useSalaryApi(period);
  const [calLessons, setCalLessons] = useState<CalLesson[]>([]);
  const [calLoading, setCalLoading] = useState(false);
  const [history, setHistory] = useState<PaymentHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [mathMinimized, setMathMinimized] = useState(true); // sensitive data — collapsed by default
  const [cancelModal, setCancelModal] = useState<{ id: number; amount: number; lessonsCount: number } | null>(null);
  useBodyScrollLock(!!cancelModal);
  useBackButtonClose(!!cancelModal, () => setCancelModal(null));
  const [cancelReason, setCancelReason] = useState('');
  const [cancelLoading, setCancelLoading] = useState(false);

  // Week selection — null means monthly view
  const [selectedWeekIdx, setSelectedWeekIdx] = useState<number | null>(null);

  // Inline add-adjustment form
  const [adjForm, setAdjForm] = useState<{
    open: boolean; type: AdjType; amount: string; reason: string;
  }>({ open: false, type: 'FINE', amount: '', reason: '' });
  const [adjSaving, setAdjSaving] = useState(false);

  // Inline rate edit form
  const [rateEdit, setRateEdit] = useState<{ open: boolean; value: string; saving: boolean }>(
    { open: false, value: '', saving: false }
  );

  const staffIdNum = parseInt(staffId || '0', 10);
  const staff = staffSalaries.find(s => s.userId === staffIdNum);

  useEffect(() => {
    if (!staff) return;
    const [year, month] = period.split('-').map(Number);
    setCalLessons([]);
    setCalLoading(true);
    api.get(`/schedule/teacher-lesson-calendar-admin?teacherId=${staff.userId}&year=${year}&month=${month}&_nocache=1`)
      .then(res => setCalLessons(res.data?.data ?? []))
      .catch(() => { })
      .finally(() => setCalLoading(false));
  }, [staff?.userId, period]);

  useEffect(() => {
    if (!staff) return;
    setHistoryLoading(true);
    fetchPaymentHistory(staff.staffProfileId)
      .then(setHistory)
      .catch(() => { })
      .finally(() => setHistoryLoading(false));
  }, [staff?.staffProfileId, fetchPaymentHistory, period]);

  // Reset week selection when period changes
  useEffect(() => { setSelectedWeekIdx(null); }, [period]);

  const monthWeeks = useMemo(() => {
    const [year, month] = period.split('-').map(Number);
    return getMonthWeeks(year, month);
  }, [period]);

  const lessonsByDate = useMemo(() => {
    const map: Record<string, CalLesson[]> = {};
    for (const l of calLessons) {
      if (!map[l.date]) map[l.date] = [];
      map[l.date].push(l);
    }
    return map;
  }, [calLessons]);

  // Adjustments indexed by date (YYYY-MM-DD) for calendar chips
  const adjsByDate = useMemo(() => {
    if (!staff) return {} as Record<string, SalaryAdjustment[]>;
    const map: Record<string, SalaryAdjustment[]> = {};
    for (const adj of staff.adjustments) {
      const d = adj.date?.split('T')[0];
      if (!d) continue;
      if (!map[d]) map[d] = [];
      map[d].push(adj);
    }
    return map;
  }, [staff?.adjustments]);

  const payableLessons = useMemo(() =>
    calLessons.filter(l => (l.status === 'COMPLETED' || l.status === 'IN_PROGRESS') && l.paymentId == null),
    [calLessons]
  );

  // ── Week-scoped derived values ─────────────────────────────────────────────

  const selectedWeekRange = useMemo(() => {
    if (selectedWeekIdx === null || !monthWeeks[selectedWeekIdx]) return null;
    const week = monthWeeks[selectedWeekIdx];
    return { start: isoDate(week[0]), end: isoDate(week[6]), label: weekLabel(week) };
  }, [selectedWeekIdx, monthWeeks]);

  const isWeekView = selectedWeekIdx !== null;

  const viewLessons = useMemo(() => {
    if (!selectedWeekRange) return calLessons;
    return calLessons.filter(l => l.date >= selectedWeekRange.start && l.date <= selectedWeekRange.end);
  }, [calLessons, selectedWeekRange]);

  const viewPayableLessons = useMemo(() =>
    viewLessons.filter(l => (l.status === 'COMPLETED' || l.status === 'IN_PROGRESS') && l.paymentId == null),
    [viewLessons]
  );

  const activePayableLessons = isWeekView ? viewPayableLessons : payableLessons;

  const viewCompleted = useMemo(() =>
    viewLessons.filter(l => l.status === 'COMPLETED'), [viewLessons]);

  const viewUpcoming = useMemo(() =>
    viewLessons.filter(l => l.status === 'UPCOMING' || l.status === 'SCHEDULED'),
    [viewLessons]);

  const viewAdjustments = useMemo((): SalaryAdjustment[] => {
    if (!staff) return [];
    if (!selectedWeekRange) return staff.adjustments;
    return staff.adjustments.filter(adj => {
      const d = adj.date?.split('T')[0];
      if (!d) return false;
      return d >= selectedWeekRange.start && d <= selectedWeekRange.end;
    });
  }, [staff?.adjustments, selectedWeekRange]);

  const viewBonuses = useMemo(() =>
    viewAdjustments.filter(a => a.type === 'BONUS').reduce((s, a) => s + a.amount, 0),
    [viewAdjustments]);
  const viewFines = useMemo(() =>
    viewAdjustments.filter(a => a.type === 'FINE').reduce((s, a) => s + a.amount, 0),
    [viewAdjustments]);
  const viewAdvances = useMemo(() =>
    viewAdjustments.filter(a => a.type === 'ADVANCE').reduce((s, a) => s + a.amount, 0),
    [viewAdjustments]);

  const viewGross = isWeekView
    ? viewCompleted.length * (staff?.rateSnapshot ?? 0)
    : (staff?.gross ?? 0);

  const viewProjected = (staff?.rateSnapshot ?? 0) * viewUpcoming.length;

  const viewNet = isWeekView
    ? viewGross + viewBonuses - viewFines - viewAdvances
    : Math.max(0, staff?.remainingAmount ?? staff?.net ?? 0);

  const today = new Date();
  const todayIso = today.toISOString().split('T')[0];

  const totalHeld = calLessons.filter(l => l.status === 'COMPLETED').length;
  const totalCancelled = calLessons.filter(l => l.status === 'CANCELLED').length;

  const handleAddAdj = async () => {
    if (!staff) return;
    const amount = parseFloat(adjForm.amount);
    if (!amount || !adjForm.reason.trim()) return;
    setAdjSaving(true);
    try {
      await addAdjustment(staff.staffProfileId, adjForm.type, amount, adjForm.reason.trim());
      setAdjForm({ open: false, type: 'FINE', amount: '', reason: '' });
      toast.success('Корректировка добавлена');
    } catch {
      toast.error('Ошибка при добавлении');
    } finally {
      setAdjSaving(false);
    }
  };

  const handleDeleteAdj = async (adjId: number) => {
    try {
      await deleteAdjustment(adjId);
      toast.success('Удалено');
    } catch {
      toast.error('Ошибка при удалении');
    }
  };

  const handleSaveRate = async () => {
    if (!staff) return;
    const newRate = parseFloat(rateEdit.value);
    if (isNaN(newRate) || newRate <= 0) return;
    setRateEdit(s => ({ ...s, saving: true }));
    try {
      await updateRate(staff.staffProfileId, newRate);
      setRateEdit({ open: false, value: '', saving: false });
      toast.success('Ставка обновлена');
    } catch {
      toast.error('Ошибка при обновлении ставки');
      setRateEdit(s => ({ ...s, saving: false }));
    }
  };

  const handleCancelPay = async () => {
    if (!cancelModal || !cancelReason.trim() || !staff) return;
    setCancelLoading(true);
    try {
      await cancelPay(cancelModal.id, cancelReason.trim());
      setCancelModal(null);
      setCancelReason('');
      const [year, month] = period.split('-').map(Number);
      const res = await api.get(`/schedule/teacher-lesson-calendar-admin?teacherId=${staff.userId}&year=${year}&month=${month}&_nocache=1`);
      setCalLessons(res.data?.data ?? []);
      const h = await fetchPaymentHistory(staff.staffProfileId);
      setHistory(h);
      toast.success('Выплата аннулирована');
    } catch {
      toast.error('Ошибка при отмене выплаты');
    } finally {
      setCancelLoading(false);
    }
  };

  if (salaryLoading && !staff) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-background">
        <Spinner size="lg" />
        <p className="text-textSecondary mt-4 animate-pulse">Загрузка расчетного листа...</p>
      </div>
    );
  }

  if (!staff) {
    return (
      <div className="h-full flex flex-col bg-background p-8">
        <button onClick={() => navigate('..', { relative: 'path' })} className="flex items-center gap-2 text-primary hover:opacity-80 mb-8">
          <ChevronLeft className="w-4 h-4" /> Вернуться
        </button>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-textSecondary">Преподаватель не найден</p>
        </div>
      </div>
    );
  }

  const badgeVariant = staff.isPaid ? 'success' : staff.remainingAmount > 0 ? 'danger' : 'neutral';
  const badgeLabel = staff.isPaid ? 'Выплачено' : staff.remainingAmount > 0 ? 'Ожидает' : '—';

  // Аванс — тоже фактически выданные сотруднику деньги, просто не через
  // TeacherPayment. Сервер (salary.ts) уже вычитает авансы из «заработано»
  // при расчёте remainingAmount, поэтому здесь их нужно ТОЛЬКО прибавить к
  // выплаченному — remainingAmount трогать не нужно, иначе получится
  // двойной счёт. Тот же фикс, что и в FinanceDashboard.tsx / SalaryHistory.tsx.
  const totalPaidDisplay = staff.totalPaidAmount + staff.advances;

  const periodPayments = history.filter(h => h.period === period);
  // Voided payouts stay in the list as a trail but must not trigger the
  // «частично выплачено» banner — only confirmed money counts.
  const hasPartialPayments = periodPayments.some(p => p.status !== 'VOIDED') && !staff.isPaid;

  const handlePayAll = async () => {
    if (activePayableLessons.length === 0 || paying || calLoading) return;
    setPaying(true);
    try {
      const sessionIds = activePayableLessons.map(l => l.id);
      const amount = await payWithSessions(staff.staffProfileId, sessionIds, '');
      const [year, month] = period.split('-').map(Number);
      const res = await api.get(`/schedule/teacher-lesson-calendar-admin?teacherId=${staff.userId}&year=${year}&month=${month}&_nocache=1`);
      setCalLessons(res.data?.data ?? []);
      const h = await fetchPaymentHistory(staff.staffProfileId);
      setHistory(h);
      toast.success(`Выплачено ${fmt(amount)} сом · ${sessionIds.length} ур.`);
    } catch {
      toast.error('Ошибка при выплате');
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">

      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate('..', { relative: 'path' })}
          className="flex items-center gap-2 text-primary hover:opacity-80"
        >
          <ChevronLeft className="w-4 h-4" /> Вернуться к списку
        </button>
        <button
          onClick={() => navigate('history', { relative: 'path' })}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-background border border-border/60 rounded-lg hover:bg-surfaceLow transition-colors text-textSecondary hover:text-textPrimary"
        >
          <Clock className="w-4 h-4" />
          История
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">

        {/* Left: Main payslip card */}
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
              <Button variant="outline" size="sm" onClick={() => window.print()} className="hidden lg:flex">
                <Printer className="w-3.5 h-3.5 mr-1" />Печать
              </Button>
            </div>

            {/* Staff info */}
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                <span className="text-primary font-bold">{initials(staff.name)}</span>
              </div>
              <div className="flex-1">
                <p className="font-semibold text-textPrimary text-lg">{staff.name}</p>
                <p className="text-xs text-textSecondary">
                  {staff.isPaid && staff.paidAt ? `закрыт ${fmtDate(staff.paidAt)}` : `выдан ${fmtDate(new Date().toISOString())}`}
                </p>
              </div>
              <Badge variant={badgeVariant}>{badgeLabel}</Badge>
            </div>

            {/* Partial payment banner */}
            {hasPartialPayments && (
              <div className="mb-6 flex items-center gap-3 bg-warning/10 border border-warning/30 rounded-xl px-4 py-3">
                <span className="text-[#9c5717] text-base font-bold">◑</span>
                <div>
                  <p className="text-[#9c5717] font-semibold text-sm">Частично выплачено</p>
                  <p className="text-[#9c5717]/70 text-xs">
                    Выплачено {fmt(totalPaidDisplay)} сом · осталось {fmt(staff.remainingAmount)} сом
                  </p>
                </div>
              </div>
            )}

            {/* Fully paid banner */}
            {staff.isPaid && (
              <div className="mb-6 flex items-center gap-3 bg-primary/8 border border-primary/30 rounded-xl px-4 py-3">
                <span className="text-primary text-lg font-bold">✓</span>
                <div>
                  <p className="text-primary font-semibold text-sm">Выплачено за период</p>
                  <p className="text-primary/70 text-xs">
                    Все уроки оплачены · {fmt(totalPaidDisplay)} сом
                  </p>
                </div>
              </div>
            )}

            {/* Full month calendar */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-textSecondary">Расписание месяца</p>
                {calLessons.length > 0 && (
                  <div className="flex gap-3">
                    <span className="text-[10px] text-success font-semibold">✓ {totalHeld} проведено</span>
                    {totalCancelled > 0 && (
                      <span className="text-[10px] text-danger font-semibold">✗ {totalCancelled} отменено</span>
                    )}
                  </div>
                )}
              </div>

              {!calLoading && calLessons.length === 0 && (
                <div className="rounded-xl border border-border bg-surfaceLowest py-8 text-center mb-2">
                  <p className="text-sm font-medium text-textSecondary">Уроков в этом периоде нет</p>
                </div>
              )}

              {calLoading ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="w-4 h-4 animate-spin text-primary" />
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {monthWeeks.map((week, wi) => {
                    const [y, m] = period.split('-').map(Number);
                    const isSelected = selectedWeekIdx === wi;
                    return (
                      <div key={wi}>
                        {/* Clickable week label — selects this week in the right panel */}
                        <button
                          onClick={() => setSelectedWeekIdx(isSelected ? null : wi)}
                          className={`w-full text-left flex items-center gap-2 px-2 py-1 rounded-md mb-1.5 transition-colors group ${isSelected
                            ? 'bg-primary/10 text-primary'
                            : 'hover:bg-primary/5 text-textSecondary/50 hover:text-primary/70'
                            }`}
                        >
                          <span className="text-[10px] font-bold uppercase tracking-wider">
                            {weekLabel(week)}
                          </span>
                          {isSelected ? (
                            <span className="text-[9px] text-primary/60 font-normal normal-case tracking-normal">
                              — расчёт за неделю →
                            </span>
                          ) : (
                            <span className="text-[9px] opacity-0 group-hover:opacity-60 text-primary font-normal normal-case tracking-normal transition-opacity">
                              нажмите для расчёта
                            </span>
                          )}
                        </button>
                        <div className="overflow-x-auto -mx-2">
                          <div className="grid grid-cols-7 gap-0.5 px-1">
                            {week.map((date, idx) => {
                              const iso = isoDate(date);
                              const dayLessons = (lessonsByDate[iso] ?? []).sort((a, b) => a.time.localeCompare(b.time));
                              const dayAdjs = adjsByDate[iso] ?? [];
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
                                        <div className="text-[9px] font-semibold text-textSecondary/60">
                                          {dayLessons.length}
                                        </div>
                                      </>
                                    )}
                                  </div>
                                  {!inMonth ? (
                                    <div className="rounded-lg bg-surfaceLowest/40 border border-border/10 min-h-[44px]" />
                                  ) : (dayLessons.length === 0 && dayAdjs.length === 0) ? (
                                    <div className="rounded-lg bg-surfaceLowest border border-border/20 min-h-[44px] flex items-center justify-center">
                                      <span className="text-[9px] text-textSecondary/30">—</span>
                                    </div>
                                  ) : (
                                    <div className="flex flex-col gap-0.5">
                                      {dayLessons.map((lesson, li) => {
                                        const isCompleted = lesson.status === 'COMPLETED';
                                        const isCancelled = lesson.status === 'CANCELLED';
                                        // null AND undefined both mean "not paid" (undefined = old cache without paymentId field)
                                        const isPaidLesson = lesson.paymentId != null;

                                        const cellStyle = isCancelled
                                          ? 'border-danger/40 bg-danger/10 opacity-70'
                                          : isPaidLesson
                                            ? 'border-success/50 bg-success/10'
                                            : 'border-border/40 bg-surfaceLowest';

                                        const timeStyle = isCancelled
                                          ? 'text-danger/70 line-through'
                                          : isPaidLesson
                                            ? 'text-success'
                                            : 'text-textSecondary/70';

                                        return (
                                          <div key={li} className={`rounded-lg border p-1.5 text-[9px] flex flex-col gap-0.5 ${cellStyle}`}>
                                            <span className={`font-bold leading-none ${timeStyle}`}>
                                              {lesson.time}
                                            </span>
                                            <span className="text-textSecondary/80 truncate leading-tight" title={lesson.level}>
                                              {lesson.level}
                                            </span>
                                            {isCancelled && (
                                              <span className="text-danger/60 font-bold leading-none">отмена</span>
                                            )}
                                            {isPaidLesson && (
                                              <span className="text-textSecondary/50 font-bold leading-none">✓ опл.</span>
                                            )}
                                            {isCompleted && !isPaidLesson && (
                                              <span className="text-success font-bold leading-none">не опл.</span>
                                            )}
                                            {!isCompleted && !isCancelled && !isPaidLesson && (
                                              <span className="font-bold leading-none text-textSecondary/40">
                                                план
                                              </span>
                                            )}
                                          </div>
                                        );
                                      })}
                                      {/* Adjustment chips */}
                                      {dayAdjs.map((adj, ai) => {
                                        const isBonus = adj.type === 'BONUS';
                                        const isAdv = adj.type === 'ADVANCE';
                                        return (
                                          <div
                                            key={`adj-${ai}`}
                                            className={`rounded-lg border p-1.5 text-[9px] flex flex-col gap-0.5 ${isBonus
                                              ? 'border-success/40 bg-success/8'
                                              : isAdv
                                                ? 'border-border/40 bg-surfaceLowest'
                                                : 'border-danger/40 bg-danger/8'
                                              }`}
                                          >
                                            <span className={`font-bold leading-none ${isBonus ? 'text-success' : isAdv ? 'text-textSecondary' : 'text-danger'}`}>
                                              {ADJ_LABEL[adj.type as AdjType]}
                                            </span>
                                            <span className={`font-semibold leading-none ${isBonus ? 'text-success' : 'text-danger'}`}>
                                              {isBonus ? '+' : '−'}{fmt(adj.amount)}
                                            </span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>


            {/* Payment history */}
            {periodPayments.length > 0 && (
              <div className="mt-8 pt-6 border-t border-border/40">
                <p className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-3">
                  История выплат за {periodLabel(period)}
                </p>
                {historyLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {periodPayments.map(p => {
                      const isVoided = p.status === 'VOIDED';
                      return (
                      <div key={p.id} className={`flex items-center gap-3 bg-surfaceLowest border border-border/30 rounded-xl px-4 py-3 ${isVoided ? 'opacity-60' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-semibold text-textPrimary ${isVoided ? 'line-through' : ''}`}>{fmt(p.amount)} сом</span>
                            <span className="text-xs text-textSecondary">· {p.lessonsCount} ур.</span>
                            {isVoided && (
                              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg bg-danger/10 text-danger">Аннулирована</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-textSecondary">{fmtDate(p.paidAt)}</span>
                            {p.createdByName && (
                              <span className="text-xs text-textSecondary/60">· {p.createdByName}</span>
                            )}
                            {p.note && (
                              <span className="text-xs text-textSecondary/60 italic">· {p.note}</span>
                            )}
                            {isVoided && p.voidReason && (
                              <span className="text-xs text-danger/60 italic">· Причина: {p.voidReason}</span>
                            )}
                          </div>
                        </div>
                        {canPaySalary && !isVoided && (
                          <button
                            type="button"
                            onClick={() => { setCancelModal({ id: p.id, amount: p.amount, lessonsCount: p.lessonsCount }); setCancelReason(''); }}
                            className="text-xs text-danger/60 hover:text-danger font-medium transition-colors flex-shrink-0"
                          >
                            Отменить
                          </button>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>

        {/* Right: Calculation card (separate, sticky, collapsible) */}
        <div className="order-1 lg:order-2 w-full lg:w-72 lg:flex-shrink-0 lg:sticky lg:top-4">
          <div className="bg-background rounded-2xl shadow-xl border border-border/40 overflow-hidden">

            {/* Card header — shows month or week scope, click to collapse */}
            <button
              className="w-full flex items-center justify-between px-4 py-3 border-b border-border/40 hover:bg-surfaceLowest/60 transition-colors"
              onClick={() => setMathMinimized(v => !v)}
            >
              <div className="text-left">
                <p className="text-sm font-semibold text-textPrimary">Расчёт за период</p>
                <p className="text-[10px] text-textSecondary mt-0.5">
                  {isWeekView
                    ? `Неделя: ${selectedWeekRange!.label}`
                    : `Месяц: ${periodLabel(period)}`}
                </p>
              </div>
              <ChevronUp className={`w-4 h-4 text-textSecondary transition-transform duration-200 flex-shrink-0 ${mathMinimized ? 'rotate-180' : ''}`} />
            </button>

            {!mathMinimized && (
              <div className="p-4 flex flex-col gap-4">

                {/* Week view — scope indicator + reset link */}
                {isWeekView && (
                  <div className="flex items-center justify-between bg-primary/5 border border-primary/20 rounded-lg px-3 py-2">
                    <span className="text-[11px] text-primary font-semibold">Расчёт за неделю</span>
                    <button
                      onClick={() => setSelectedWeekIdx(null)}
                      className="text-[11px] text-primary/60 hover:text-primary underline font-medium transition-colors"
                    >
                      Показать за месяц
                    </button>
                  </div>
                )}

                {/* Начисление */}
                <div className="bg-surfaceLowest border border-border/40 rounded-xl px-4 py-3 space-y-2 text-sm">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-3">Начисление</p>
                  <div className="flex justify-between">
                    <span className="text-textSecondary">Проведено</span>
                    <span className="font-semibold text-textPrimary">
                      {isWeekView ? viewCompleted.length : staff.lessonsCount} ур.
                      {!isWeekView && staff.paidLessonsCount > 0 && (
                        <span className="text-success ml-1 text-xs">({staff.paidLessonsCount} опл.)</span>
                      )}
                    </span>
                  </div>
                  {viewUpcoming.length > 0 && (
                    <div className="flex justify-between">
                      <span className="text-textSecondary/60">Запланировано</span>
                      <span className="text-textSecondary/60 font-medium">{viewUpcoming.length} ур.</span>
                    </div>
                  )}
                  {!isWeekView && staff.manualDelta !== 0 && (
                    <div className="flex justify-between">
                      <span className="text-textSecondary">Корректировка уроков</span>
                      <span className={`font-semibold ${staff.manualDelta > 0 ? 'text-success' : 'text-danger'}`}>
                        {staff.manualDelta > 0 ? '+' : ''}{staff.manualDelta}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between items-start">
                    <span className="text-textSecondary">Ставка</span>
                    {rateEdit.open ? (
                      <div className="flex flex-col gap-1.5 items-end">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            value={rateEdit.value}
                            onChange={e => setRateEdit(s => ({ ...s, value: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleSaveRate();
                              if (e.key === 'Escape') setRateEdit({ open: false, value: '', saving: false });
                            }}
                            className="w-24 h-7 px-2 bg-background border border-border/60 rounded-lg text-xs outline-none focus:border-primary text-textPrimary text-right"
                            autoFocus
                            min="1"
                          />
                          <span className="text-xs text-textSecondary">сом/ур.</span>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={handleSaveRate}
                            disabled={rateEdit.saving || !rateEdit.value || parseFloat(rateEdit.value) <= 0}
                            className="h-6 px-2 bg-primary text-white text-[10px] font-semibold rounded-md hover:bg-primary/90 disabled:opacity-40 transition-colors"
                          >
                            {rateEdit.saving ? '...' : 'Сохранить'}
                          </button>
                          <button
                            onClick={() => setRateEdit({ open: false, value: '', saving: false })}
                            className="h-6 px-2 bg-surfaceLow text-textSecondary text-[10px] rounded-md hover:bg-border/40 transition-colors"
                          >
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-textPrimary">{fmt(staff.rateSnapshot)} сом/урок</span>
                        {canPaySalary && (
                          <button
                            onClick={() => setRateEdit({ open: true, value: String(staff.salaryRate), saving: false })}
                            className="text-textSecondary/40 hover:text-primary transition-colors"
                            title="Изменить ставку"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex justify-between pt-2 border-t border-border/40">
                    <span className="text-textSecondary">Заработано</span>
                    <span className="font-semibold text-textPrimary">{fmt(viewGross)} сом</span>
                  </div>
                  {viewProjected > 0 && (
                    <div className="flex justify-between">
                      <span className="text-textSecondary/60 text-xs">+ ожидается</span>
                      <span className="text-textSecondary/60 text-xs font-medium">~{fmt(viewProjected)} сом</span>
                    </div>
                  )}
                </div>

                {/* Корректировки section with add form */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-textSecondary">Корректировки</p>
                    {/* salary:write (not salary:pay) — ADMIN can add these too */}
                    <button
                      onClick={() => setAdjForm(f => ({ ...f, open: !f.open }))}
                      className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 font-semibold transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      Добавить
                    </button>
                  </div>

                  {/* Inline add form */}
                  {adjForm.open && (
                    <div className="mb-2 bg-surfaceLowest border border-border/40 rounded-xl p-3 flex flex-col gap-2">
                      <div className="flex gap-2">
                        <select
                          value={adjForm.type}
                          onChange={e => setAdjForm(f => ({ ...f, type: e.target.value as AdjType }))}
                          className="flex-1 h-7 px-2 bg-background border border-border/60 rounded-lg text-xs outline-none focus:border-primary text-textPrimary"
                        >
                          <option value="FINE">Штраф</option>
                          <option value="BONUS">Бонус</option>
                          <option value="ADVANCE">Аванс</option>
                        </select>
                        <input
                          type="number"
                          placeholder="Сумма"
                          value={adjForm.amount}
                          onChange={e => setAdjForm(f => ({ ...f, amount: e.target.value }))}
                          className="w-24 h-7 px-2 bg-background border border-border/60 rounded-lg text-xs outline-none focus:border-primary text-textPrimary"
                        />
                      </div>
                      <input
                        type="text"
                        placeholder="Причина / примечание"
                        value={adjForm.reason}
                        onChange={e => setAdjForm(f => ({ ...f, reason: e.target.value }))}
                        className="w-full h-7 px-2 bg-background border border-border/60 rounded-lg text-xs outline-none focus:border-primary text-textPrimary"
                        onKeyDown={e => { if (e.key === 'Enter') handleAddAdj(); }}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handleAddAdj}
                          disabled={adjSaving || !adjForm.amount || !adjForm.reason.trim()}
                          className="flex-1 h-7 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-40 transition-colors"
                        >
                          {adjSaving ? '...' : 'Сохранить'}
                        </button>
                        <button
                          onClick={() => setAdjForm(f => ({ ...f, open: false, amount: '', reason: '' }))}
                          className="h-7 px-3 bg-surfaceLow text-textSecondary text-xs rounded-lg hover:bg-border/40 transition-colors"
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  )}

                  {viewAdjustments.length > 0 ? (
                    <div className="rounded-xl border border-border/40 overflow-hidden">
                      <table className="responsive-table w-full text-xs">
                        <thead>
                          <tr className="bg-surfaceLow border-b border-border/40">
                            <th className="px-3 py-2 text-left text-textSecondary">Тип</th>
                            <th className="px-3 py-2 text-left text-textSecondary">Примечание</th>
                            <th className="px-3 py-2 text-right text-textSecondary">Сумма</th>
                            <th className="w-6" />
                          </tr>
                        </thead>
                        <tbody>
                          {viewAdjustments.map((adj) => {
                            const isBonus = adj.type === 'BONUS';
                            return (
                              <tr key={adj.id} className="border-b border-border/20 last:border-0">
                                <td data-label="Тип" className={`px-3 py-2 font-semibold ${isBonus ? 'text-success' : adj.type === 'FINE' ? 'text-danger' : 'text-textSecondary'}`}>
                                  {ADJ_LABEL[adj.type as AdjType]}
                                </td>
                                <td data-label="Примечание" className="px-3 py-2 text-textSecondary">{adj.reason}</td>
                                <td data-label="Сумма" className={`px-3 py-2 text-right font-semibold ${isBonus ? 'text-success' : 'text-danger'}`}>
                                  {isBonus ? '+' : '−'}{fmt(adj.amount)} сом
                                </td>
                                <td className="pr-2 py-2">
                                  <button
                                    onClick={() => handleDeleteAdj(adj.id)}
                                    className="text-textSecondary/30 hover:text-danger transition-colors"
                                    title="Удалить"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-[11px] text-textSecondary/50 text-center py-2">Нет корректировок</p>
                  )}
                </div>

                {/* Payment summary */}
                <div className="rounded-xl border border-border/40 overflow-hidden">
                  {!isWeekView && (
                    <div className="bg-surfaceLowest px-4 py-3 space-y-1.5 text-sm">
                      {totalPaidDisplay > 0 && (
                        <div className="flex justify-between">
                          <span className="text-textSecondary">Начислено (все уроки)</span>
                          <span className="font-semibold text-textPrimary">{fmt(staff.gross)} сом</span>
                        </div>
                      )}
                      {totalPaidDisplay > 0 && (
                        <div className="flex justify-between">
                          <span className="text-success">
                            Выплачено{staff.advances > 0 ? ' (вкл. аванс)' : ''}
                          </span>
                          <span className="font-semibold text-success">−{fmt(totalPaidDisplay)} сом</span>
                        </div>
                      )}
                      {/* Аванс уже учтён выше, в «Выплачено» — здесь он больше не
                          вычитается повторно, иначе выглядело бы как двойной счёт.
                          Эта строка — только бонусы/штрафы; сама выдача аванса
                          остаётся видна построчно в таблице корректировок ниже. */}
                      {(staff.bonuses > 0 || staff.fines > 0) && (
                        <div className="flex justify-between text-xs text-textSecondary/70 border-t border-border/20 pt-1.5">
                          <span>Корректировки (бонусы/штрафы)</span>
                          <span className={staff.bonuses - staff.fines >= 0 ? 'text-success' : 'text-danger'}>
                            {staff.bonuses - staff.fines >= 0 ? '+' : ''}{fmt(staff.bonuses - staff.fines)} сом
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  <div className={`px-4 py-3 flex justify-between items-center ${viewNet > 0 ? 'bg-primary/5 border-t border-primary/20' : viewGross > 0 ? 'bg-success/5 border-t border-success/20' : 'bg-surfaceLowest border-t border-border/40'
                    }`}>
                    <div>
                      <span className="font-bold text-textPrimary text-sm">
                        {isWeekView ? 'За неделю' : 'К выплате'}
                      </span>
                      {viewProjected > 0 && viewNet === 0 && (
                        <p className="text-[10px] text-textSecondary/60 font-normal mt-0.5">
                          ~{fmt(viewGross + viewProjected)} сом с учётом плана
                        </p>
                      )}
                    </div>
                    <span className={`font-bold text-xl ${viewNet > 0 ? 'text-primary' : viewGross > 0 ? 'text-success' : 'text-textSecondary/40'}`}>
                      {fmt(Math.max(0, viewNet))} сом
                    </span>
                  </div>
                </div>

                {/* Pay button */}
                {canPaySalary && (
                  activePayableLessons.length > 0 ? (
                    <Button variant="primary" onClick={handlePayAll} disabled={paying || calLoading} className="w-full">
                      {paying ? 'Выплата...' : 'Выплатить'}
                    </Button>
                  ) : (
                    <Button variant="outline" disabled className="w-full">
                      {payableLessons.length === 0 ? 'Все уроки оплачены ✓' : 'Нет уроков к оплате'}
                    </Button>
                  )
                )}

                {/* Legend */}
                <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                  <span className="flex items-center gap-1 text-[10px] text-success font-semibold">
                    <span className="w-2 h-2 rounded-sm bg-success/10 border border-success/50 inline-block" />
                    Оплачено
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-textSecondary/60 font-semibold">
                    <span className="w-2 h-2 rounded-sm bg-surfaceLowest border border-border/40 inline-block" />
                    Запланировано
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-textSecondary/60 font-semibold">
                    <span className="w-2 h-2 rounded-sm bg-surfaceLowest border border-border/40 inline-block" />
                    Проведено
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-danger/60 font-semibold">
                    <span className="w-2 h-2 rounded-sm bg-danger/8 border border-danger/30 inline-block" />
                    Отменено
                  </span>
                </div>

              </div>
            )}
          </div>
        </div>

      </div>

      {/* Cancel payment modal */}
      {cancelModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-background rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl border border-border/40 max-h-[90dvh] overflow-y-auto">
            <h3 className="font-semibold text-textPrimary mb-1">Аннулировать выплату?</h3>
            <p className="text-sm text-textSecondary mb-4">
              {fmt(cancelModal.amount)} сом · {cancelModal.lessonsCount} ур. — останется в истории со статусом «Аннулирована», уроки снова станут доступны к оплате.
            </p>
            <input
              type="text"
              placeholder="Причина отмены"
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCancelPay(); }}
              className="w-full h-9 px-3 bg-surfaceLowest border border-border/60 rounded-xl text-sm outline-none focus:border-primary transition text-textPrimary mb-4"
              autoFocus
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setCancelModal(null)}
                disabled={cancelLoading}
                className="px-4 py-2 text-sm text-textSecondary hover:text-textPrimary transition-colors"
              >
                Назад
              </button>
              <button
                onClick={handleCancelPay}
                disabled={cancelLoading || !cancelReason.trim()}
                className="px-4 py-2 text-sm bg-danger text-white rounded-xl hover:bg-danger/90 disabled:opacity-40 transition-colors"
              >
                {cancelLoading ? 'Аннулирование...' : 'Аннулировать выплату'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
