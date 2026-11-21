import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Plus, ChevronDown, ChevronRight, ChevronUp, X, Link as LinkIcon, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Link, useParams } from 'react-router';
import toast from 'react-hot-toast';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { EmptyState } from '../../../components/ui/EmptyState';
import SearchInput from '../../../components/ui/SearchInput';
import { RefundModal } from '../../../components/ui/RefundModal';
import api from '../../../lib/api';
import { useAuth } from '../../../hooks/useAuth';
import { usePermissions } from '../../../hooks/usePermissions';
import { useSalaryApi, type PaymentSummary } from '../../../hooks/useSalaryApi';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../../hooks/useBackButtonClose';
import { paymentApi, formatMoney, financeErrorMessage } from '../../../lib/financeApi';
import type { Payment, PaymentMethod, PaymentStatus } from '../../../types';
import { MonthYearPicker, currentPeriod } from '../../../components/ui/MonthYearPicker';

// ─── Month helpers ────────────────────────────────────────────────────────────

// period = 'YYYY-MM' — единый формат месяца (см. MonthYearPicker)
function paymentInMonth(p: Payment, period: string): boolean {
  const d = new Date(p.paidAt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === period;
}

// ─── Method badge ─────────────────────────────────────────────────────────────

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH:     'Наличные',
  TRANSFER: 'Перевод',
  CARD:     'Карта',
};

const METHOD_COLORS: Record<PaymentMethod, string> = {
  CASH:     'bg-primary/10 text-primary',
  TRANSFER: 'bg-blue-500/10 text-blue-600',
  CARD:     'bg-purple-500/10 text-purple-600',
};

function MethodBadge({ method }: { method: PaymentMethod }) {
  const label = METHOD_LABELS[method] ?? method;
  const color = METHOD_COLORS[method] ?? 'bg-border/30 text-textSecondary';
  return (
    <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase ${color}`}>
      {label}
    </span>
  );
}

const STATUS_LABELS: Record<PaymentStatus, string> = {
  CONFIRMED: 'Принят',
  VOIDED:    'Аннулирован',
  REFUNDED:  'Возвращён',
};

const STATUS_COLORS: Record<PaymentStatus, string> = {
  CONFIRMED: 'bg-primary/10 text-primary',
  VOIDED:    'bg-danger/10 text-danger',
  REFUNDED:  'bg-amber-500/10 text-amber-600',
};

function PaymentStatusBadge({ status, confirmedLabel }: { status: PaymentStatus; confirmedLabel?: string }) {
  const label = status === 'CONFIRMED' && confirmedLabel ? confirmedLabel : STATUS_LABELS[status] ?? status;
  return (
    <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase ${STATUS_COLORS[status] ?? 'bg-border/20 text-textSecondary'}`}>
      {label}
    </span>
  );
}

// Shared column template for the payments table. `fr` tracks fill the full
// container width (no dead space on the right) and resolve identically across
// every independent row grid since the container width is constant. The fixed
// trailing column holds always-visible row actions (same as ADMIN_GRID).
const PAY_GRID = 'grid-cols-[minmax(0,2fr)_1fr_1fr_1.2fr_0.8fr_1.1fr_84px]';

// Column template for the expanded per-admin list («Платежи по сотрудникам»).
// Same columns as PAY_GRID minus «Принял» (redundant — grouped by receiver),
// plus a fixed actions column since these rows show buttons inline.
const ADMIN_GRID = 'md:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_1.1fr_84px]';

// Payment ids and StudentPayment ids come from different tables and can collide —
// key rows and the in-flight spinner by source+id.
const rowKey = (p: Payment) => `${p.source ?? 'PAYMENT'}-${p.id}`;

// ─── Payments table sorting (same pattern as Students) ───────────────────────

type PaySortKey = 'student' | 'method' | 'status' | 'receiver' | 'date' | 'amount';

// Sort value per column. ISO dates sort correctly as strings.
function paySortVal(p: Payment, key: PaySortKey): string | number {
  switch (key) {
    case 'student':  return `${p.studentProfile?.user.firstName ?? ''} ${p.studentProfile?.user.lastName ?? ''}`.trim().toLowerCase();
    case 'method':   return p.method;
    case 'status':   return p.status;
    case 'receiver': return p.receivedBy ? `${p.receivedBy.firstName} ${p.receivedBy.lastName}`.toLowerCase() : '';
    case 'date':     return p.paidAt;
    case 'amount':   return parseFloat(p.amount ?? '0');
  }
}

function sortPaymentList(list: Payment[], sort: { key: PaySortKey; dir: 'asc' | 'desc' } | null): Payment[] {
  if (!sort) return list;
  return [...list].sort((a, b) => {
    const av = paySortVal(a, sort.key);
    const bv = paySortVal(b, sort.key);
    if (av === '' && bv !== '') return 1;
    if (bv === '' && av !== '') return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sort.dir === 'asc' ? cmp : -cmp;
  });
}

function PaySortHeader<K extends string>({
  label, col, sort, onSort, className = '',
}: {
  label: string;
  col: K;
  sort: { key: K; dir: 'asc' | 'desc' } | null;
  onSort: (key: K) => void;
  className?: string;
}) {
  const active = sort?.key === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={`flex items-center gap-1 text-[10px] font-bold uppercase transition-colors hover:text-textPrimary ${
        active ? 'text-textPrimary' : 'text-textSecondary/60'
      } ${className}`}
    >
      {label}
      {active && (sort!.dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
    </button>
  );
}

// ─── Salary payouts table (mirrors the income table) ─────────────────────────

type SalaryRow = PaymentSummary & { staffName: string };

type SalarySortKey = 'teacher' | 'lessons' | 'status' | 'payer' | 'date' | 'amount';

function salarySortVal(r: SalaryRow, key: SalarySortKey): string | number {
  switch (key) {
    case 'teacher': return r.staffName.toLowerCase();
    case 'lessons': return r.lessonsCount;
    case 'status':  return r.status;
    case 'payer':   return (r.createdByName ?? '').toLowerCase();
    case 'date':    return r.paidAt;
    case 'amount':  return r.amount;
  }
}

// ─── Add Payment Modal ────────────────────────────────────────────────────────

interface StudentOption { id: number; profileId: number; name: string }

function AddPaymentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  useBodyScrollLock();
  useBackButtonClose(true, onClose);

  const [students, setStudents]         = useState<StudentOption[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [amount, setAmount]             = useState('');
  const [method, setMethod]             = useState<PaymentMethod>('CASH');
  const [note, setNote]                 = useState('');
  const [date, setDate]                 = useState(new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting]     = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchQuery, setSearchQuery]   = useState('');
  // One key per submission attempt: stable across retries of the same payment
  // (server replays instead of double-charging), fresh when the inputs change.
  const payKeyRef = useRef<string>(crypto.randomUUID());
  useEffect(() => { payKeyRef.current = crypto.randomUUID(); }, [selectedUserId, amount, method, date]);

  useEffect(() => {
    setStudentsLoading(true);
    api.get('/students').then(res => {
      if (res.data?.success && Array.isArray(res.data.data)) {
        const opts: StudentOption[] = res.data.data
          .filter((s: { studentProfile?: { id?: number } }) => s.studentProfile?.id)
          .map((s: { id: number; firstName: string; lastName: string; studentProfile: { id: number } }) => ({
            id:        s.id,
            profileId: s.studentProfile.id,
            name:      `${s.firstName} ${s.lastName}`,
          }));
        setStudents(opts);
      }
    }).catch(() => toast.error('Не удалось загрузить студентов')).finally(() => setStudentsLoading(false));
  }, []);

  const filtered = students.filter(s => s.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const submit = async () => {
    if (!selectedUserId) { toast.error('Выберите студента'); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast.error('Введите корректную сумму'); return; }

    setSubmitting(true);
    try {
      // Same quick-payment flow as the student card: money lands in the student's
      // wallet and converts to lesson credits at their rate — not a bare Payment row.
      await api.patch(`/students/${selectedUserId}`, {
        paymentAmount: amt,
        paymentMethod: method,
        paymentNote:   note.trim() || undefined,
        paymentDate:   date || undefined,
      }, { headers: { 'Idempotency-Key': payKeyRef.current } });
      toast.success('Платёж записан');
      onCreated();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(financeErrorMessage(msg));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background rounded shadow-2xl w-full max-w-sm mx-4 p-6 max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg text-textPrimary">Добавить платёж</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface transition-colors">
            <X className="w-4 h-4 text-textSecondary" />
          </button>
        </div>

        <div className="space-y-3">
          {/* Student dropdown */}
          <div>
            <label className="text-xs text-textSecondary mb-1 block">Студент</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDropdown(v => !v)}
                className="w-full text-left px-3 py-2 border border-border rounded text-sm bg-surfaceLowest"
              >
                {selectedName || <span className="text-textSecondary">Выберите студента...</span>}
              </button>
              {showDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-surfaceLowest border border-border rounded shadow-lg z-10">
                  <div className="p-2 border-b border-border/30">
                    <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Поиск..." className="w-full" autoFocus />
                  </div>
                  <div className="max-h-40 overflow-y-auto">
                    {studentsLoading ? (
                      <div className="py-4 text-center text-sm text-textSecondary flex items-center justify-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin" /> Загрузка...
                      </div>
                    ) : filtered.length === 0 ? (
                      <div className="py-4 text-center text-sm text-textSecondary">Не найдено</div>
                    ) : filtered.map(s => (
                      <button
                        key={s.profileId}
                        type="button"
                        onClick={() => {
                          setSelectedUserId(s.id);
                          setSelectedName(s.name);
                          setShowDropdown(false);
                          setSearchQuery('');
                        }}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-surfaceLow transition-colors"
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Amount */}
          <div>
            <label className="text-xs text-textSecondary mb-1 block">Сумма (KGS)</label>
            <Input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
            />
          </div>

          {/* Method */}
          <div>
            <label className="text-xs text-textSecondary mb-1 block">Способ оплаты</label>
            <div className="flex gap-2">
              {(['CASH', 'TRANSFER', 'CARD'] as PaymentMethod[]).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={`px-3 py-1.5 rounded text-xs font-bold uppercase border transition ${
                    method === m
                      ? 'bg-primary text-white border-primary'
                      : 'border-border text-textSecondary hover:border-primary/50'
                  }`}
                >
                  {METHOD_LABELS[m]}
                </button>
              ))}
            </div>
          </div>

          {/* Date */}
          <div>
            <label className="text-xs text-textSecondary mb-1 block">Дата</label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>

          {/* Note */}
          <div>
            <label className="text-xs text-textSecondary mb-1 block">Примечание (необязательно)</label>
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Например: за апрель" />
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <Button variant="secondary" onClick={onClose} className="flex-1">Отмена</Button>
          <Button variant="primary" onClick={submit} disabled={submitting} className="flex-1">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Сохранить'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FinanceDashboard() {
  const { slug }  = useParams<{ slug: string }>();
  const { user }  = useAuth();
  // finance:write (refund/void a regular payment) is OWNER/SUPERADMIN-only. Adding a
  // payment, cancelling a credit top-up, and salary-note edits only need students:write
  // / salary:write, which ADMIN also holds — those stay ungated below (any role that can
  // reach this page already has them). canPaySalary (salary:pay) stays OWNER-only for
  // voiding a salary payout, same as it always was.
  const { canWriteFinance, canPaySalary } = usePermissions();

  // ── Payments state ────────────────────────────────────────────────────────
  const [payments, setPayments]       = useState<Payment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [paymentsError, setPaymentsError]     = useState(false);

  // ── UI state ─────────────────────────────────────────────────────────────
  const [selectedMonth, setSelectedMonth] = useState(currentPeriod);
  const [showAddModal, setShowAddModal]   = useState(false);
  const [paymentsOpen, setPaymentsOpen]   = useState(true);
  const [salaryOpen, setSalaryOpen]       = useState(true);
  const [expandedAdmin, setExpandedAdmin] = useState<string | null>(null);
  const [voidingId, setVoidingId]         = useState<string | null>(null);
  const [refundPaymentId, setRefundPaymentId] = useState<number | null>(null);
  const [paySort, setPaySort]             = useState<{ key: PaySortKey; dir: 'asc' | 'desc' } | null>(null);
  const [noteEditKey, setNoteEditKey]     = useState<string | null>(null);
  const [noteDraft, setNoteDraft]         = useState('');
  const [noteSaving, setNoteSaving]       = useState(false);

  const rolePrefix = user?.role?.toLowerCase() ?? 'admin';

  const {
    data: salaryData,
    loading: salaryLoading,
    cancelPay: cancelSalaryPay,
    updatePaymentNote: updateSalaryNote,
  } = useSalaryApi(selectedMonth);
  const [salarySort, setSalarySort] = useState<{ key: SalarySortKey; dir: 'asc' | 'desc' } | null>(null);

  // ── Fetch payments from backend ───────────────────────────────────────────
  const fetchPayments = useCallback(async () => {
    setPaymentsLoading(true);
    setPaymentsError(false);
    try {
      const res = await paymentApi.list({ limit: 200, includeCredits: true });
      setPayments(res.data);
    } catch {
      setPaymentsError(true);
      toast.error('Не удалось загрузить платежи');
    } finally {
      setPaymentsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  // ── Filter payments by selected month (client-side, data already fetched) ─
  // Cancelled/voided rows stay in the list (greyed, «Аннулирован») as a visible
  // trail; every money total is computed from confirmedPayments only.
  const monthPayments = useMemo(
    () => payments.filter(p => paymentInMonth(p, selectedMonth)),
    [payments, selectedMonth],
  );

  const confirmedPayments = useMemo(
    () => monthPayments.filter(p => p.status !== 'VOIDED'),
    [monthPayments],
  );

  // Click a header: asc → desc → off (server order = date desc). Empty values last.
  const toggleSort = (key: PaySortKey) =>
    setPaySort(prev => prev?.key !== key ? { key, dir: 'asc' } : prev.dir === 'asc' ? { key, dir: 'desc' } : null);

  const sortedPayments = useMemo(() => sortPaymentList(monthPayments, paySort), [monthPayments, paySort]);

  // Sort state for the expanded per-admin payment list («Платежи по сотрудникам»).
  // One state is enough — only one admin row is expanded at a time.
  const [adminSort, setAdminSort] = useState<{ key: PaySortKey; dir: 'asc' | 'desc' } | null>(null);
  const toggleAdminSort = (key: PaySortKey) =>
    setAdminSort(prev => prev?.key !== key ? { key, dir: 'asc' } : prev.dir === 'asc' ? { key, dir: 'desc' } : null);

  const totalIncome = useMemo(
    () => confirmedPayments.reduce((sum, p) => sum + parseFloat(p.amount ?? '0'), 0),
    [confirmedPayments],
  );

  const incomeByMethod = useMemo(() => {
    const map: Partial<Record<PaymentMethod, number>> = {};
    confirmedPayments.forEach(p => {
      map[p.method] = (map[p.method] ?? 0) + parseFloat(p.amount ?? '0');
    });
    return map;
  }, [confirmedPayments]);

  // Groups are built from ALL month rows so a voided payment never vanishes from
  // the expanded per-admin list (it shows greyed, «Аннулирован») — but the money
  // total and the payment count only add non-VOIDED rows.
  const incomeByAdmin = useMemo(() => {
    const map: Record<string, { name: string; total: number; count: number; lastDate: string; payments: Payment[] }> = {};
    monthPayments.forEach(p => {
      const key   = String(p.receivedBy ? `${p.receivedBy.firstName} ${p.receivedBy.lastName}` : 'Неизвестно');
      if (!map[key]) map[key] = { name: key, total: 0, count: 0, lastDate: p.paidAt, payments: [] };
      if (p.status !== 'VOIDED') {
        map[key].total += parseFloat(p.amount ?? '0');
        map[key].count += 1;
      }
      if (p.paidAt > map[key].lastDate) map[key].lastDate = p.paidAt;
      map[key].payments.push(p);
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [monthPayments]);

  // ── Salary payouts — flat list of TeacherPayment rows for the period.
  // Voided rows stay visible (greyed, «Аннулирован»); totals count confirmed only.
  const salaryRows = useMemo<SalaryRow[]>(
    () => salaryData.flatMap(s => s.payments.map(p => ({ ...p, staffName: s.name }))),
    [salaryData],
  );

  const toggleSalarySort = (key: SalarySortKey) =>
    setSalarySort(prev => prev?.key !== key ? { key, dir: 'asc' } : prev.dir === 'asc' ? { key, dir: 'desc' } : null);

  const sortedSalaryRows = useMemo(() => {
    const base = [...salaryRows].sort((a, b) => b.paidAt.localeCompare(a.paidAt));
    if (!salarySort) return base;
    return base.sort((a, b) => {
      const av = salarySortVal(a, salarySort.key);
      const bv = salarySortVal(b, salarySort.key);
      if (av === '' && bv !== '') return 1;
      if (bv === '' && av !== '') return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return salarySort.dir === 'asc' ? cmp : -cmp;
    });
  }, [salaryRows, salarySort]);

  // «Итого выплачено» = подтверждённые выплаты (TeacherPayment, не VOIDED) за
  // период + авансы (ADVANCE-корректировки) за тот же период. Аванс — это тоже
  // фактически выданные сотруднику деньги, просто не через TeacherPayment.
  // server/src/routes/salary.ts уже вычитает авансы из «заработано» при расчёте
  // remainingAmount (см. monthNet), поэтому здесь их нужно ТОЛЬКО прибавить к
  // выплаченному — remainingAmount трогать не нужно, иначе получится двойной счёт.
  // Both totalPaidAmount and advances are already period/schoolId-scoped server
  // totals (GET /salary), so this composes two already-correct numbers instead
  // of re-deriving from the raw payments list.
  const totalSalaryPaid = useMemo(
    () => salaryData.reduce((sum, s) => sum + s.totalPaidAmount + s.advances, 0),
    [salaryData],
  );

  const totalSalaryRemaining = useMemo(
    () => salaryData.reduce((sum, s) => sum + Math.max(0, s.remainingAmount), 0),
    [salaryData],
  );

  // ── Void payment ──────────────────────────────────────────────────────────
  const handleVoidPayment = async (p: Payment) => {
    if (!canWriteFinance) return;
    if (!confirm('Аннулировать платёж? Действие необратимо.')) return;
    setVoidingId(rowKey(p));
    try {
      await paymentApi.void(p.id);
      toast.success('Платёж аннулирован');
      fetchPayments();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(financeErrorMessage(msg));
    } finally {
      setVoidingId(null);
    }
  };

  // ── Payment comment — single editable note per row, saved to the right API
  // per source (Payment.note vs StudentPayment.note). Clicking the row toggles
  // the editor — same gesture in all three transaction tables on this page.
  const toggleNoteEditor = (key: string, note: string | null | undefined) => {
    if (noteEditKey === key) { setNoteEditKey(null); return; }
    setNoteEditKey(key);
    setNoteDraft(note ?? '');
  };

  const saveNote = async (p: Payment) => {
    setNoteSaving(true);
    try {
      const note = noteDraft.trim() || null;
      if (p.source === 'CREDIT_TOPUP') {
        const studentUserId = p.studentProfile?.user?.id;
        if (!studentUserId) { toast.error('Не удалось определить студента'); return; }
        await api.patch(`/students/${studentUserId}/payments/${p.id}/note`, { note });
      } else {
        await paymentApi.updateNote(p.id, note);
      }
      setNoteEditKey(null);
      fetchPayments();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(financeErrorMessage(msg));
    } finally {
      setNoteSaving(false);
    }
  };

  // ── Cancel credit top-up — full reversal via the students API: removes the
  // lessons this payment granted (student balance may go negative), REFUND ledger.
  const handleCancelTopup = async (p: Payment) => {
    const studentUserId = p.studentProfile?.user?.id;
    if (!studentUserId) { toast.error('Не удалось определить студента'); return; }
    if (!confirm('Отменить платёж? Начисленные за него уроки будут списаны у студента (баланс может уйти в минус). Действие необратимо.')) return;
    setVoidingId(rowKey(p));
    try {
      await api.post(`/students/${studentUserId}/payments/${p.id}/cancel`);
      toast.success('Платёж отменён, уроки списаны');
      fetchPayments();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(financeErrorMessage(msg));
    } finally {
      setVoidingId(null);
    }
  };

  // ── Salary payout row actions — void keeps the record (status VOIDED),
  // note is saved via the salary API. Row keys are `SALARY-{id}` so the shared
  // voiding/note-editing state never collides with income rows.
  const salaryRowKey = (r: SalaryRow) => `SALARY-${r.id}`;

  const handleVoidSalaryPayment = async (r: SalaryRow) => {
    if (!canPaySalary) return;
    const reason = prompt('Аннулировать выплату? Укажите причину:');
    if (!reason?.trim()) return;
    setVoidingId(salaryRowKey(r));
    try {
      await cancelSalaryPay(r.id, reason.trim());
      toast.success('Выплата аннулирована');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(financeErrorMessage(msg));
    } finally {
      setVoidingId(null);
    }
  };

  const saveSalaryNote = async (r: SalaryRow) => {
    setNoteSaving(true);
    try {
      await updateSalaryNote(r.id, noteDraft.trim() || null);
      setNoteEditKey(null);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(financeErrorMessage(msg));
    } finally {
      setNoteSaving(false);
    }
  };

  return (
    <div className="text-textPrimary">
      <div className="space-y-8">

        {/* Header — controls in one row */}
        <div className="flex items-center justify-end mb-8 gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <MonthYearPicker value={selectedMonth} onChange={setSelectedMonth} />

            <Button variant="outline" size="sm" onClick={() => setShowAddModal(true)}>
              <Plus className="w-4 h-4" />
              Платёж
            </Button>
          </div>
        </div>

        {/* Error state */}
        {paymentsError && (
          <div className="flex items-center gap-3 px-4 py-3 bg-danger/5 border border-danger/20 rounded text-danger text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Не удалось загрузить платежи. Проверьте соединение.
          </div>
        )}

        {/* Method breakdown */}
        {monthPayments.length > 0 && (
          <div className="bg-surfaceLowest border border-border rounded px-5 py-4">
            <p className="text-[10px] font-bold uppercase text-textSecondary mb-3">По способам оплаты</p>
            <div className="flex flex-wrap gap-3">
              {(['CASH', 'TRANSFER', 'CARD'] as PaymentMethod[]).map(m => {
                const val = incomeByMethod[m];
                if (!val) return null;
                return (
                  <div key={m} className="flex items-center gap-2">
                    <MethodBadge method={m} />
                    <span className="text-sm font-bold text-textPrimary">{formatMoney(val.toFixed(2))}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* All payments list */}
        <div className="bg-surfaceLowest border border-border rounded overflow-hidden">
          <button
            onClick={() => setPaymentsOpen(p => !p)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface/30 transition-colors"
          >
            <div className="flex items-center gap-3">
              {paymentsOpen
                ? <ChevronDown className="w-4 h-4 text-textSecondary" />
                : <ChevronRight className="w-4 h-4 text-textSecondary" />
              }
              <p className="text-[10px] font-bold uppercase text-textSecondary">
                Поступления
              </p>
            </div>
            <span className="text-xs text-textSecondary">{monthPayments.length} записей</span>
          </button>

          {paymentsOpen && (
            paymentsLoading ? (
              <div className="px-5 py-8 flex items-center justify-center gap-2 text-textSecondary text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Загрузка...
              </div>
            ) : monthPayments.length === 0 ? (
              <div className="px-5 pb-6">
                <EmptyState icon={<span className="text-2xl">📋</span>} title="Нет платежей в этом месяце" />
              </div>
            ) : (
              <div className="divide-y divide-border/30 border-t border-border">
                {/* Table header — hidden on mobile where rows become stacked cards. */}
                <div className={`hidden md:grid ${PAY_GRID} gap-3 items-center px-5 py-2`}>
                  <PaySortHeader label="Студент" col="student" sort={paySort} onSort={toggleSort} />
                  <PaySortHeader label="Метод" col="method" sort={paySort} onSort={toggleSort} className="justify-center" />
                  <PaySortHeader label="Статус" col="status" sort={paySort} onSort={toggleSort} className="justify-center" />
                  <PaySortHeader label="Принял" col="receiver" sort={paySort} onSort={toggleSort} />
                  <PaySortHeader label="Дата" col="date" sort={paySort} onSort={toggleSort} />
                  <PaySortHeader label="Сумма" col="amount" sort={paySort} onSort={toggleSort} className="justify-end" />
                  <span />
                </div>
                {sortedPayments.map(p => {
                  const studentName = `${p.studentProfile?.user.firstName ?? ''} ${p.studentProfile?.user.lastName ?? ''}`.trim();
                  const receiver = p.receivedBy ? `${p.receivedBy.firstName} ${p.receivedBy.lastName}` : '—';
                  const dateStr = new Date(p.paidAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
                  const isEditingNote = noteEditKey === rowKey(p);
                  // Cancelling/note-editing a credit top-up only needs students:write
                  // (ADMIN has it); voiding or refunding a regular payment needs
                  // finance:write/finance:refund (OWNER-only).
                  const canEditThisRow = p.source === 'CREDIT_TOPUP' || canWriteFinance;
                  const actions = canEditThisRow && p.status === 'CONFIRMED' ? (
                    <div className="flex items-center gap-0.5">
                      {p.source !== 'CREDIT_TOPUP' && (
                        <button
                          onClick={e => { e.stopPropagation(); setRefundPaymentId(p.id); }}
                          className="p-1.5 rounded-lg hover:bg-amber-500/10 text-textSecondary hover:text-amber-600 transition-colors"
                          title="Оформить возврат"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); if (p.source === 'CREDIT_TOPUP') { handleCancelTopup(p); } else { handleVoidPayment(p); } }}
                        disabled={voidingId === rowKey(p)}
                        className="p-1.5 rounded-lg hover:bg-danger/10 text-textSecondary hover:text-danger transition-colors disabled:opacity-40"
                        title={p.source === 'CREDIT_TOPUP' ? 'Отменить платёж (уроки будут списаны)' : 'Аннулировать'}
                      >
                        {voidingId === rowKey(p)
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <X className="w-3.5 h-3.5" />
                        }
                      </button>
                    </div>
                  ) : null;

                  return (
                    <div key={`${p.source ?? 'PAYMENT'}-${p.id}`} className={p.status !== 'CONFIRMED' ? 'opacity-60' : ''}>
                      {/* Mobile card — the 7-column grid can't fit a phone, so stack it.
                          Tapping the card toggles the comment editor. */}
                      <div
                        onClick={() => toggleNoteEditor(rowKey(p), p.note)}
                        className={`md:hidden px-5 py-3 space-y-2 hover:bg-surface/30 transition-colors ${canEditThisRow ? 'cursor-pointer' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-sm text-textPrimary font-medium">{studentName}</span>
                          <span className="font-bold text-sm text-textPrimary whitespace-nowrap">{formatMoney(p.amount)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-textSecondary/80">
                          <MethodBadge method={p.method} />
                          <PaymentStatusBadge status={p.status} />
                          <span>{receiver}</span>
                          <span aria-hidden>·</span>
                          <span>{dateStr}</span>
                          {p.note && <span className="italic text-textSecondary/60">· {p.note}</span>}
                          {actions && <div className="ml-auto">{actions}</div>}
                        </div>
                      </div>

                      {/* Desktop grid row — click toggles the comment editor */}
                      <div
                        onClick={() => toggleNoteEditor(rowKey(p), p.note)}
                        className={`hidden md:grid ${PAY_GRID} gap-3 items-center px-5 py-3 hover:bg-surface/30 transition-colors ${canEditThisRow ? 'cursor-pointer' : ''}`}
                      >
                        <div>
                          <span className="text-sm text-textPrimary font-medium">{studentName}</span>
                          {p.note && (
                            <p className="text-xs text-textSecondary/60 italic mt-0.5">{p.note}</p>
                          )}
                        </div>
                        <MethodBadge method={p.method} />
                        <PaymentStatusBadge status={p.status} />
                        <span className="text-xs text-textSecondary">{receiver}</span>
                        <span className="text-xs text-textSecondary/60">{dateStr}</span>
                        <span className="font-bold text-sm text-textPrimary text-right">{formatMoney(p.amount)}</span>
                        <div className="flex items-center justify-end gap-0.5">{actions}</div>
                      </div>

                      {/* Inline comment editor — under the row */}
                      {isEditingNote && (
                        <div className="px-5 pb-3 flex items-center gap-2">
                          <Input
                            value={noteDraft}
                            onChange={e => setNoteDraft(e.target.value)}
                            placeholder="Комментарий к платежу..."
                            maxLength={500}
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveNote(p);
                              if (e.key === 'Escape') setNoteEditKey(null);
                            }}
                          />
                          <Button variant="primary" size="sm" onClick={() => saveNote(p)} disabled={noteSaving}>
                            {noteSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Сохранить'}
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setNoteEditKey(null)}>Отмена</Button>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Total row */}
                <div className="flex items-center justify-between px-5 py-3 bg-primary/5">
                  <span className="text-xs font-bold uppercase text-primary">Итого</span>
                  <span className="font-bold text-base text-primary">{formatMoney(totalIncome.toFixed(2))}</span>
                </div>
              </div>
            )
          )}
        </div>

        {/* Admin accountability table */}
        <div className="bg-surfaceLowest border border-border rounded overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <p className="text-[10px] font-bold uppercase text-textSecondary">Платежи по сотрудникам</p>
          </div>

          {paymentsLoading ? (
            <div className="px-5 py-8 flex items-center justify-center gap-2 text-textSecondary text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Загрузка...
            </div>
          ) : incomeByAdmin.length === 0 ? (
            <div className="px-5 py-8">
              <EmptyState icon={<span className="text-2xl">💳</span>} title="Платежей в этом месяце пока нет" />
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {incomeByAdmin.map(admin => {
                const isExpanded    = expandedAdmin === admin.name;
                const adminPayments = admin.payments;

                return (
                  <div key={admin.name}>
                    <button
                      onClick={() => setExpandedAdmin(isExpanded ? null : admin.name)}
                      className="w-full flex items-center gap-4 px-5 py-4 hover:bg-surface/50 transition-colors text-left"
                    >
                      <span className="flex-shrink-0 w-2 h-2 rounded-full bg-primary" />
                      <span className="flex-1 min-w-0 truncate font-medium text-sm text-textPrimary">{admin.name}</span>
                      <span className="flex-shrink-0 text-xs text-textSecondary">{admin.count} платежей</span>
                      <span className="font-bold text-sm text-primary min-w-[100px] text-right">
                        {formatMoney(admin.total.toFixed(2))}
                      </span>
                      <span className="text-xs text-textSecondary/60 min-w-[60px] text-right">
                        {new Date(admin.lastDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                      </span>
                      {isExpanded
                        ? <ChevronDown className="w-4 h-4 text-textSecondary flex-shrink-0" />
                        : <ChevronRight className="w-4 h-4 text-textSecondary flex-shrink-0" />
                      }
                    </button>

                    {isExpanded && (
                      <div className="bg-background/50 border-t border-border px-5 py-3 space-y-1">
                        {/* Column headers — desktop only, mobile rows wrap freely */}
                        <div className={`hidden md:grid ${ADMIN_GRID} gap-3 items-center py-1`}>
                          <PaySortHeader label="Студент" col="student" sort={adminSort} onSort={toggleAdminSort} />
                          <PaySortHeader label="Метод" col="method" sort={adminSort} onSort={toggleAdminSort} className="justify-center" />
                          <PaySortHeader label="Статус" col="status" sort={adminSort} onSort={toggleAdminSort} className="justify-center" />
                          <PaySortHeader label="Дата" col="date" sort={adminSort} onSort={toggleAdminSort} />
                          <PaySortHeader label="Сумма" col="amount" sort={adminSort} onSort={toggleAdminSort} className="justify-end" />
                          <span />
                        </div>
                        {sortPaymentList(adminPayments, adminSort).map(p => {
                          const isEditingNote = noteEditKey === rowKey(p);
                          const canEditThisRow = p.source === 'CREDIT_TOPUP' || canWriteFinance;
                          return (
                          <div key={`${p.source ?? 'PAYMENT'}-${p.id}`}>
                            {/* Click toggles the comment editor — same gesture as the other tables */}
                            <div
                              onClick={() => toggleNoteEditor(rowKey(p), p.note)}
                              className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm md:grid ${ADMIN_GRID} md:gap-3 ${p.status !== 'CONFIRMED' ? 'opacity-60' : ''} ${canEditThisRow ? 'cursor-pointer' : ''}`}
                            >
                              <div className="flex-1 min-w-0">
                                <span className="text-textPrimary">
                                  {p.studentProfile?.user.firstName} {p.studentProfile?.user.lastName}
                                </span>
                                {p.note && (
                                  <p className="text-xs text-textSecondary/60 italic mt-0.5 truncate">{p.note}</p>
                                )}
                              </div>
                              <MethodBadge method={p.method} />
                              <PaymentStatusBadge status={p.status} />
                              <span className="text-xs text-textSecondary/60">
                                {new Date(p.paidAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                              </span>
                              <span className="font-bold text-textPrimary min-w-[90px] md:min-w-0 text-right">
                                {formatMoney(p.amount)}
                              </span>
                              <div className="flex items-center justify-end gap-0.5 flex-shrink-0">
                                {canEditThisRow && p.status === 'CONFIRMED' && (
                                  <>
                                    {p.source !== 'CREDIT_TOPUP' && (
                                      <button
                                        onClick={e => { e.stopPropagation(); setRefundPaymentId(p.id); }}
                                        className="p-1 rounded-lg hover:bg-amber-500/10 text-textSecondary hover:text-amber-600 transition-colors"
                                        title="Оформить возврат"
                                      >
                                        <RefreshCw className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                    <button
                                      onClick={e => { e.stopPropagation(); if (p.source === 'CREDIT_TOPUP') { handleCancelTopup(p); } else { handleVoidPayment(p); } }}
                                      disabled={voidingId === rowKey(p)}
                                      className="p-1 rounded-lg hover:bg-danger/10 text-textSecondary hover:text-danger transition-colors disabled:opacity-40"
                                      title={p.source === 'CREDIT_TOPUP' ? 'Отменить платёж (уроки будут списаны)' : 'Аннулировать платёж'}
                                    >
                                      {voidingId === rowKey(p)
                                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        : <X className="w-3.5 h-3.5" />
                                      }
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>

                            {/* Inline comment editor — under the row */}
                            {isEditingNote && (
                              <div className="pb-2 flex items-center gap-2">
                                <Input
                                  value={noteDraft}
                                  onChange={e => setNoteDraft(e.target.value)}
                                  placeholder="Комментарий к платежу..."
                                  maxLength={500}
                                  autoFocus
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') saveNote(p);
                                    if (e.key === 'Escape') setNoteEditKey(null);
                                  }}
                                />
                                <Button variant="primary" size="sm" onClick={() => saveNote(p)} disabled={noteSaving}>
                                  {noteSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Сохранить'}
                                </Button>
                                <Button variant="secondary" size="sm" onClick={() => setNoteEditKey(null)}>Отмена</Button>
                              </div>
                            )}
                          </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Salary summary — data from backend salary module */}
        <div className="bg-surfaceLowest border border-border rounded overflow-hidden">
          <button
            onClick={() => setSalaryOpen(p => !p)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface/30 transition-colors"
          >
            <div className="flex items-center gap-3">
              {salaryOpen
                ? <ChevronDown className="w-4 h-4 text-textSecondary" />
                : <ChevronRight className="w-4 h-4 text-textSecondary" />
              }
              <p className="text-[10px] font-bold uppercase text-textSecondary">
                Зарплаты
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-textSecondary">{salaryRows.length} записей</span>
              <Link
                to={`/${slug}/${rolePrefix}/salary`}
                onClick={e => e.stopPropagation()}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <LinkIcon className="w-3 h-3" />
                Подробнее
              </Link>
            </div>
          </button>

          {salaryOpen && (
            salaryLoading ? (
              <div className="px-5 py-8 flex items-center justify-center gap-2 text-textSecondary text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Загрузка...
              </div>
            ) : salaryRows.length === 0 ? (
              <div className="px-5 pb-6">
                <EmptyState icon={<span className="text-2xl">👤</span>} title="Нет выплат в этом месяце" />
              </div>
            ) : (
              <div className="divide-y divide-border/30 border-t border-border">
                {/* Table header — hidden on mobile where rows become stacked cards. */}
                <div className={`hidden md:grid ${PAY_GRID} gap-3 items-center px-5 py-2`}>
                  <PaySortHeader label="Преподаватель" col="teacher" sort={salarySort} onSort={toggleSalarySort} />
                  <PaySortHeader label="Уроки" col="lessons" sort={salarySort} onSort={toggleSalarySort} className="justify-center" />
                  <PaySortHeader label="Статус" col="status" sort={salarySort} onSort={toggleSalarySort} className="justify-center" />
                  <PaySortHeader label="Выплатил" col="payer" sort={salarySort} onSort={toggleSalarySort} />
                  <PaySortHeader label="Дата" col="date" sort={salarySort} onSort={toggleSalarySort} />
                  <PaySortHeader label="Сумма" col="amount" sort={salarySort} onSort={toggleSalarySort} className="justify-end" />
                  <span />
                </div>
                {sortedSalaryRows.map(r => {
                  const payer = r.createdByName ?? '—';
                  const dateStr = new Date(r.paidAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
                  const isVoided = r.status === 'VOIDED';
                  const isEditingNote = noteEditKey === salaryRowKey(r);
                  const actions = canPaySalary && !isVoided ? (
                    <button
                      onClick={e => { e.stopPropagation(); handleVoidSalaryPayment(r); }}
                      disabled={voidingId === salaryRowKey(r)}
                      className="p-1.5 rounded-lg hover:bg-danger/10 text-textSecondary hover:text-danger transition-colors disabled:opacity-40"
                      title="Аннулировать выплату"
                    >
                      {voidingId === salaryRowKey(r)
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <X className="w-3.5 h-3.5" />
                      }
                    </button>
                  ) : null;
                  const noteLine = r.note ?? (isVoided && r.voidReason ? `Причина: ${r.voidReason}` : null);

                  return (
                    <div key={r.id} className={isVoided ? 'opacity-60' : ''}>
                      {/* Mobile card — tapping toggles the comment editor (salary:write, ADMIN included) */}
                      <div
                        onClick={() => toggleNoteEditor(salaryRowKey(r), r.note)}
                        className="md:hidden px-5 py-3 space-y-2 hover:bg-surface/30 transition-colors cursor-pointer"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-sm text-textPrimary font-medium">{r.staffName}</span>
                          <span className="font-bold text-sm text-textPrimary whitespace-nowrap">{formatMoney(String(r.amount))}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-textSecondary/80">
                          <span>{r.lessonsCount} ур.</span>
                          <PaymentStatusBadge status={r.status} confirmedLabel="Выплачен" />
                          <span>{payer}</span>
                          <span aria-hidden>·</span>
                          <span>{dateStr}</span>
                          {noteLine && <span className="italic text-textSecondary/60">· {noteLine}</span>}
                          {actions && <div className="ml-auto">{actions}</div>}
                        </div>
                      </div>

                      {/* Desktop grid row — click toggles the comment editor (salary:write, ADMIN included) */}
                      <div
                        onClick={() => toggleNoteEditor(salaryRowKey(r), r.note)}
                        className={`hidden md:grid ${PAY_GRID} gap-3 items-center px-5 py-3 hover:bg-surface/30 transition-colors cursor-pointer`}
                      >
                        <div>
                          <span className="text-sm text-textPrimary font-medium">{r.staffName}</span>
                          {noteLine && (
                            <p className="text-xs text-textSecondary/60 italic mt-0.5">{noteLine}</p>
                          )}
                        </div>
                        <span className="text-xs text-textSecondary text-center">{r.lessonsCount} ур.</span>
                        <PaymentStatusBadge status={r.status} confirmedLabel="Выплачен" />
                        <span className="text-xs text-textSecondary">{payer}</span>
                        <span className="text-xs text-textSecondary/60">{dateStr}</span>
                        <span className="font-bold text-sm text-textPrimary text-right">{formatMoney(String(r.amount))}</span>
                        <div className="flex items-center justify-end gap-0.5">{actions}</div>
                      </div>

                      {/* Inline comment editor — under the row */}
                      {isEditingNote && (
                        <div className="px-5 pb-3 flex items-center gap-2">
                          <Input
                            value={noteDraft}
                            onChange={e => setNoteDraft(e.target.value)}
                            placeholder="Комментарий к выплате..."
                            maxLength={500}
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveSalaryNote(r);
                              if (e.key === 'Escape') setNoteEditKey(null);
                            }}
                          />
                          <Button variant="primary" size="sm" onClick={() => saveSalaryNote(r)} disabled={noteSaving}>
                            {noteSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Сохранить'}
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setNoteEditKey(null)}>Отмена</Button>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Total rows */}
                <div className="px-5 py-3 bg-[#9c5717]/5 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase text-[#9c5717]">Итого выплачено</span>
                    <span className="font-bold text-base text-[#9c5717]">{formatMoney(totalSalaryPaid.toFixed(2))}</span>
                  </div>
                  {totalSalaryRemaining > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase text-textSecondary">Осталось к выплате</span>
                      <span className="text-sm font-semibold text-textSecondary">{formatMoney(totalSalaryRemaining.toFixed(2))}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          )}
        </div>

      </div>

      {/* Add Payment Modal */}
      {showAddModal && (
        <AddPaymentModal
          onClose={() => setShowAddModal(false)}
          onCreated={fetchPayments}
        />
      )}

      {/* Refund Modal */}
      {refundPaymentId !== null && (
        <RefundModal
          paymentId={refundPaymentId}
          isOpen={true}
          onClose={() => setRefundPaymentId(null)}
          onSuccess={fetchPayments}
        />
      )}
    </div>
  );
}
