import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ChevronLeft, Clock } from 'lucide-react';
import { Spinner } from '../../../components/ui/Spinner';
import { EmptyState } from '../../../components/ui/EmptyState';
import api from '../../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StaffInfo {
  id: number;
  name: string;
  position: string | null;
  salaryRate: string | null;
}

interface Payment {
  id: number;
  period: string;
  lessonsCount: number;
  rateSnapshot: string;
  amount: string;
  adjustmentNet: string;
  paidAt: string;
  note: string | null;
  status: 'CONFIRMED' | 'VOIDED';
  voidReason: string | null;
  createdBy: { firstName: string; lastName: string } | null;
}

interface Adjustment {
  id: number;
  type: 'FINE' | 'ADVANCE' | 'BONUS';
  amount: string;
  reason: string;
  month: string;
  date: string;
  createdBy: { firstName: string; lastName: string } | null;
}

interface ManualEntry {
  id: number;
  type: 'ADD' | 'REMOVE';
  count: number;
  label: string;
  month: string;
  createdAt: string;
  createdBy: { firstName: string; lastName: string } | null;
}

type EventKind = 'payment' | 'adjustment' | 'manual';

interface TimelineEvent {
  kind: EventKind;
  period: string;   // "2026-05"
  sortDate: Date;
  data: Payment | Adjustment | ManualEntry;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MN = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
             'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function periodLabel(period: string): string {
  const [year, mon] = period.split('-').map(Number);
  return `${MN[mon - 1]} ${year}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}`;
}

function fmt(n: number | string): string {
  return Math.round(Number(n)).toLocaleString('ru-RU');
}

function creatorName(u: { firstName: string; lastName: string } | null): string {
  if (!u) return '';
  const last = u.lastName ? u.lastName[0] + '.' : '';
  return `${u.firstName} ${last}`.trim();
}

// ─── Event row components ─────────────────────────────────────────────────────

function PaymentRow({ p }: { p: Payment }) {
  const rate = Number(p.rateSnapshot);
  const amount = Number(p.amount);
  const adjNet = Number(p.adjustmentNet ?? 0);
  const isVoided = p.status === 'VOIDED';
  return (
    <div className={`flex items-start gap-3 py-2.5 px-3 rounded-xl hover:bg-surfaceLow/60 transition-colors ${isVoided ? 'opacity-60' : ''}`}>
      <div className="mt-0.5 w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center flex-shrink-0 text-sm">
        💰
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-xs text-textSecondary w-10 flex-shrink-0">{fmtDate(p.paidAt)}</span>
          <span className="font-medium text-textPrimary text-sm">Выплата</span>
          <span className="text-sm text-textSecondary">
            {p.lessonsCount} ур. × {fmt(rate)}
            {adjNet !== 0 && (
              <span className={adjNet > 0 ? 'text-emerald-700' : 'text-red-600'}>
                {' '}{adjNet > 0 ? '+' : '−'}{fmt(Math.abs(adjNet))} корр.
              </span>
            )}
            {' '}= <span className={`font-semibold ${isVoided ? 'text-textSecondary line-through' : 'text-emerald-700'}`}>{fmt(amount)} сом</span>
          </span>
          {isVoided && (
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg bg-red-500/10 text-red-600">Аннулирована</span>
          )}
          {p.note && <span className="text-xs text-textSecondary italic truncate max-w-[200px]">"{p.note}"</span>}
          {isVoided && p.voidReason && (
            <span className="text-xs text-red-600/60 italic truncate max-w-[200px]">Причина: {p.voidReason}</span>
          )}
        </div>
        {p.createdBy && (
          <span className="text-xs text-textSecondary/60 mt-0.5 block">{creatorName(p.createdBy)}</span>
        )}
      </div>
    </div>
  );
}

const ADJ_CONFIG = {
  FINE:    { emoji: '🔴', label: 'Штраф',  amountClass: 'text-red-600',  sign: '−' },
  BONUS:   { emoji: '🟢', label: 'Бонус',  amountClass: 'text-emerald-700', sign: '+' },
  ADVANCE: { emoji: '🟡', label: 'Аванс',  amountClass: 'text-amber-700', sign: '−' },
} as const;

function AdjustmentRow({ a }: { a: Adjustment }) {
  const cfg = ADJ_CONFIG[a.type];
  return (
    <div className="flex items-start gap-3 py-2.5 px-3 rounded-xl hover:bg-surfaceLow/60 transition-colors">
      <div className="mt-0.5 w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0 text-sm">
        {cfg.emoji}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-xs text-textSecondary w-10 flex-shrink-0">{fmtDate(a.date)}</span>
          <span className="font-medium text-textPrimary text-sm">{cfg.label}</span>
          <span className={`text-sm font-semibold ${cfg.amountClass}`}>{cfg.sign}{fmt(a.amount)} сом</span>
          {a.reason && <span className="text-xs text-textSecondary italic truncate max-w-[220px]">"{a.reason}"</span>}
        </div>
        {a.createdBy && (
          <span className="text-xs text-textSecondary/60 mt-0.5 block">{creatorName(a.createdBy)}</span>
        )}
      </div>
    </div>
  );
}

function ManualRow({ m }: { m: ManualEntry }) {
  const isAdd = m.type === 'ADD';
  return (
    <div className="flex items-start gap-3 py-2.5 px-3 rounded-xl hover:bg-surfaceLow/60 transition-colors">
      <div className="mt-0.5 w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0 text-sm">
        📝
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-xs text-textSecondary w-10 flex-shrink-0">{fmtDate(m.createdAt)}</span>
          <span className={`text-sm font-semibold ${isAdd ? 'text-emerald-700' : 'text-red-600'}`}>
            {isAdd ? `+${m.count}` : `−${m.count}`} ур.
          </span>
          {m.label && <span className="text-xs text-textSecondary italic truncate max-w-[220px]">"{m.label}"</span>}
        </div>
        {m.createdBy && (
          <span className="text-xs text-textSecondary/60 mt-0.5 block">{creatorName(m.createdBy)}</span>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SalaryHistory() {
  const { staffId } = useParams<{ staffId: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [staff, setStaff] = useState<StaffInfo | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [manualEntries, setManualEntries] = useState<ManualEntry[]>([]);
  const [yearFilter, setYearFilter] = useState<string>('all');

  useEffect(() => {
    if (!staffId) return;
    api.get(`/salary/user/${staffId}/full-history`)
      .then(r => {
        const d = r.data?.data;
        setStaff(d?.staff ?? null);
        setPayments(d?.payments ?? []);
        setAdjustments(d?.adjustments ?? []);
        setManualEntries(d?.manualEntries ?? []);
      })
      .catch(e => {
        const status = e?.response?.status;
        const msg = e?.response?.data?.error ?? e?.message ?? 'Unknown error';
        setError(`HTTP ${status ?? '?'}: ${msg}`);
      })
      .finally(() => setLoading(false));
  }, [staffId]);

  // Build timeline events
  const allEvents = useMemo<TimelineEvent[]>(() => {
    const evts: TimelineEvent[] = [
      ...payments.map(p => ({
        kind: 'payment' as EventKind,
        period: p.period,
        sortDate: new Date(p.paidAt),
        data: p,
      })),
      ...adjustments.map(a => ({
        kind: 'adjustment' as EventKind,
        period: a.month,
        sortDate: new Date(a.date),
        data: a,
      })),
      ...manualEntries.map(m => ({
        kind: 'manual' as EventKind,
        period: m.month,
        sortDate: new Date(m.createdAt),
        data: m,
      })),
    ];
    return evts.sort((a, b) => b.sortDate.getTime() - a.sortDate.getTime());
  }, [payments, adjustments, manualEntries]);

  // Available years from data
  const years = useMemo(() => {
    const yrs = new Set<string>();
    allEvents.forEach(e => yrs.add(e.period.split('-')[0]));
    return Array.from(yrs).sort((a, b) => Number(b) - Number(a));
  }, [allEvents]);

  // Filter by year
  const filteredEvents = useMemo(() => {
    if (yearFilter === 'all') return allEvents;
    return allEvents.filter(e => e.period.startsWith(yearFilter));
  }, [allEvents, yearFilter]);

  // Group by period (month)
  const groupedByPeriod = useMemo(() => {
    const map = new Map<string, TimelineEvent[]>();
    filteredEvents.forEach(e => {
      const arr = map.get(e.period) ?? [];
      arr.push(e);
      map.set(e.period, arr);
    });
    // Sort periods descending
    return Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a));
  }, [filteredEvents]);

  // Summary stats (all-time, not filtered). Voided payouts stay in the
  // timeline as a trail but never count toward money/lesson totals.
  // Итого выплачено = подтверждённые выплаты + авансы (ADVANCE). Аванс — это тоже
  // фактически выданные сотруднику деньги, просто не через TeacherPayment; сервер
  // (salary.ts) уже вычитает авансы из «заработано» при расчёте remainingAmount,
  // поэтому здесь их нужно только прибавить к выплаченному, не пересчитывать остаток.
  const totalPaid = useMemo(() => {
    const fromPayments = payments.reduce((s, p) => s + (p.status !== 'VOIDED' ? Number(p.amount) : 0), 0);
    const fromAdvances = adjustments.reduce((s, a) => s + (a.type === 'ADVANCE' ? Number(a.amount) : 0), 0);
    return fromPayments + fromAdvances;
  }, [payments, adjustments]);
  const totalLessons = useMemo(() => payments.reduce((s, p) => s + (p.status !== 'VOIDED' ? p.lessonsCount : 0), 0), [payments]);
  const totalRecords = allEvents.length;

  function periodPaymentSum(events: TimelineEvent[]): { amount: number; lessons: number } {
    let amount = 0;
    let lessons = 0;
    events.forEach(e => {
      if (e.kind === 'payment') {
        const p = e.data as Payment;
        if (p.status === 'VOIDED') return;
        amount += Number(p.amount);
        lessons += p.lessonsCount;
      } else if (e.kind === 'adjustment') {
        // Аванс — фактическая выдача денег за этот период; считаем его как
        // «выплачено» наравне с TeacherPayment (см. totalPaid выше).
        const a = e.data as Adjustment;
        if (a.type === 'ADVANCE') amount += Number(a.amount);
      }
    });
    return { amount, lessons };
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4 max-w-3xl">
        <button onClick={() => navigate('..', { relative: 'path' })} className="flex items-center gap-2 text-primary hover:opacity-80 text-sm w-fit">
          <ChevronLeft className="w-4 h-4" /> Расчётный лист
        </button>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm font-mono">{error}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">

      {/* Top nav */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate('..', { relative: 'path' })}
          className="flex items-center gap-2 text-primary hover:opacity-80 text-sm"
        >
          <ChevronLeft className="w-4 h-4" />
          Расчётный лист
        </button>

        {years.length > 0 && (
          <select
            value={yearFilter}
            onChange={e => setYearFilter(e.target.value)}
            className="h-8 px-2 bg-surfaceLowest border border-border/40 rounded-lg text-sm outline-none focus:border-primary transition text-textPrimary"
          >
            <option value="all">Все годы</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        )}
      </div>

      {/* Page title */}
      <div>
        <h1 className="font-serif text-2xl text-textPrimary">
          {staff?.name ?? 'Преподаватель'} — История
        </h1>
        {staff?.position && (
          <p className="text-sm text-textSecondary mt-1">{staff.position}</p>
        )}
      </div>

      {/* Summary */}
      {totalRecords > 0 && (
        <div className="flex flex-wrap gap-6 bg-surfaceLow rounded-2xl px-5 py-4 border border-border/30">
          <div>
            <p className="text-xs text-textSecondary mb-1">Итого выплачено</p>
            <p className="text-lg font-bold text-textPrimary">{fmt(totalPaid)} сом</p>
          </div>
          <div className="w-px bg-border/30 self-stretch hidden sm:block" />
          <div>
            <p className="text-xs text-textSecondary mb-1">Уроков оплачено</p>
            <p className="text-lg font-bold text-textPrimary">{totalLessons}</p>
          </div>
          <div className="w-px bg-border/30 self-stretch hidden sm:block" />
          <div>
            <p className="text-xs text-textSecondary mb-1">Всего записей</p>
            <p className="text-lg font-bold text-textPrimary">{totalRecords}</p>
          </div>
        </div>
      )}

      {/* Timeline */}
      {groupedByPeriod.length === 0 ? (
        <EmptyState
          icon={<Clock className="w-8 h-8" />}
          title="История пуста"
          description="Выплаты, корректировки и ручные записи появятся здесь"
        />
      ) : (
        <div className="flex flex-col gap-4">
          {groupedByPeriod.map(([period, events]) => {
            const { amount, lessons } = periodPaymentSum(events);
            return (
              <div key={period} className="bg-background rounded-2xl border border-border/40 overflow-hidden">

                {/* Period header */}
                <div className="flex items-center justify-between px-4 py-3 bg-surfaceLow/50 border-b border-border/30">
                  <span className="font-semibold text-sm text-textPrimary">{periodLabel(period)}</span>
                  {amount > 0 ? (
                    <span className="text-xs text-textSecondary">
                      Выплачено: <span className="font-semibold text-textPrimary">{fmt(amount)} сом</span>
                      {lessons > 0 && <span> / {lessons} ур.</span>}
                    </span>
                  ) : (
                    <span className="text-xs text-textSecondary">Нет выплат</span>
                  )}
                </div>

                {/* Events */}
                <div className="px-1 py-1">
                  {events.map((evt, i) => (
                    <div key={i}>
                      {evt.kind === 'payment'    && <PaymentRow    p={evt.data as Payment} />}
                      {evt.kind === 'adjustment' && <AdjustmentRow a={evt.data as Adjustment} />}
                      {evt.kind === 'manual'     && <ManualRow     m={evt.data as ManualEntry} />}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
