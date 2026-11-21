import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useDebounce } from '../../../hooks/useDebounce';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../../hooks/useBackButtonClose';
import {
  Search, Plus, ChevronLeft, ChevronRight, X,
  Phone, Mail, Key, BookOpen, Home, Clock, Calendar,
  PauseCircle, AlertCircle, Banknote, Archive, ArchiveRestore,
  ChevronUp, ChevronDown, Eye, EyeOff, Copy, RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../../lib/api';
import { queueNote, clearQueuedNote } from '../../../lib/notesQueue';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';
import { Textarea } from '../../../components/ui/Textarea';
import { Spinner } from '../../../components/ui/Spinner';
import { EmptyState } from '../../../components/ui/EmptyState';
import SearchInput from '../../../components/ui/SearchInput';
import { CreditStatement } from '../../../components/ui/CreditStatement';
import { generateReadablePassword } from '../../../lib/passwordGenerator';
import { MIN_PASSWORD_LENGTH, passwordMinLengthHint, passwordTooShortMessage } from '../../../lib/passwordPolicy';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Student {
  id: number;
  studentProfileId: number | null;
  name: string;
  phone: string;
  email: string;
  username?: string;
  level: string;
  cabinet: string;
  time: string;
  credits: number;
  paidUntil: string | null;
  paused: boolean;
  comment: string;
  lessonType: 'all' | 'grammar' | 'club';
  archivedAt: string | null;
  deletedAt: string | null;
}

type FilterType = 'all' | 'active' | 'overdue' | 'paused';
type ProfileTab = 'info' | 'payment' | 'lesson';

interface PayRecord {
  id: number;
  amount: number;
  method: 'cash' | 'transfer';
  note: string;
  createdAt: string;
  cancelledAt: string | null;
}
type SortKey = 'name' | 'cabinet' | 'level' | 'paidUntil' | 'status';

// Sort value per column. ISO dates ('2026-06-18') sort correctly as strings.
function sortVal(s: Student, key: SortKey): string {
  switch (key) {
    case 'name': return (s.name || '').toLowerCase();
    case 'cabinet': return (s.cabinet || '').toLowerCase();
    case 'level': return (s.level || '').toLowerCase();
    case 'paidUntil': return s.paidUntil || '';
    case 'status': return stuStatus(s);
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STU_PER_PAGE = 50;

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'Elementary', 'Pre-Intermediate', 'Intermediate', 'Upper-Intermediate', 'Advanced'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Status is derived from BALANCE (credits) — the single source of truth —
// matching the server filter in students.ts (overdue = credits <= 0, not frozen).
// `paidUntil` is a derived, display-only date and is never used for status.
function stuStatus(s: Student): 'active' | 'overdue' | 'paused' {
  if (s.paused) return 'paused';
  if (s.credits <= 0) return 'overdue';
  return 'active';
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// ─── AddStudentModal ──────────────────────────────────────────────────────────

interface AddStudentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (created: any) => void;
}

function AddStudentModal({ isOpen, onClose, onSuccess }: AddStudentModalProps) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    password: '',
    level: LEVELS[0],
  });
  const [noEmail, setNoEmail] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  // Fills the password field with a readable, crypto-random password (see
  // lib/passwordGenerator.ts) and reveals it immediately — the admin needs to
  // actually read it to pass it on to the student, so a masked field here
  // would defeat the point.
  function handleGeneratePassword() {
    set('password', generateReadablePassword());
    setShowPassword(true);
  }

  async function handleCopyPassword() {
    if (!form.password) return;
    try {
      await navigator.clipboard.writeText(form.password);
      toast.success('Пароль скопирован');
    } catch {
      toast.error('Не удалось скопировать пароль');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.firstName.trim() || !form.password.trim()) {
      toast.error('Заполните имя и пароль.');
      return;
    }
    if (form.password.trim().length < MIN_PASSWORD_LENGTH) {
      toast.error(passwordTooShortMessage());
      return;
    }
    if (!noEmail && !form.email.trim() && !form.phone.trim()) {
      toast.error('Укажите email или телефон — нужен хотя бы один способ входа.');
      return;
    }
    if (noEmail && !form.phone.trim()) {
      toast.error('Без email нужен телефон — по нему выдаётся логин.');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await api.post('/students', {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: noEmail ? undefined : (form.email.trim() || undefined),
        password: form.password.trim(),
        phone: form.phone.trim() || undefined,
        level: form.level,
      });
      setForm({ firstName: '', lastName: '', phone: '', email: '', password: '', level: LEVELS[0] });
      setNoEmail(false);
      setShowPassword(false);
      onSuccess(data?.data);
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Не удалось добавить студента');
    } finally {
      setSubmitting(false);
    }
  }

  useBodyScrollLock(isOpen);
  useBackButtonClose(isOpen, onClose);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-surfaceLowest rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[90dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-textPrimary">Новый студент</h2>
          <button
            onClick={onClose}
            className="text-textSecondary hover:text-textPrimary transition-colors rounded-lg p-1 hover:bg-surfaceLow"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Имя"
              placeholder="Анна"
              value={form.firstName}
              onChange={(e) => set('firstName', e.target.value)}
              required
            />
            <Input
              label="Фамилия"
              placeholder="Белова"
              value={form.lastName}
              onChange={(e) => set('lastName', e.target.value)}
            />
            <Input
              label="Телефон"
              placeholder="+996 700 000 000"
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
            {!noEmail && (
              <Input
                label="Email"
                type="email"
                placeholder="anna@mail.com"
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
              />
            )}
            <div className={`flex items-center justify-between py-2 ${noEmail ? '' : 'sm:col-span-2'}`}>
              <span className="text-xs font-semibold uppercase tracking-wider text-textSecondary">Без email</span>
              <button
                type="button"
                onClick={() => { setNoEmail(v => !v); if (!noEmail) set('email', ''); }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${noEmail ? 'bg-primary' : 'bg-border'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${noEmail ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </div>
            <div className="sm:col-span-2">
              <Input
                label="Пароль"
                type={showPassword ? 'text' : 'password'}
                placeholder="Временный пароль"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                required
                minLength={MIN_PASSWORD_LENGTH}
                helpText={passwordMinLengthHint()}
                suffix={
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                      className="p-1.5 rounded-md text-textSecondary hover:text-textPrimary hover:bg-surfaceLow transition-colors"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyPassword}
                      title="Скопировать пароль"
                      className="p-1.5 rounded-md text-textSecondary hover:text-textPrimary hover:bg-surfaceLow transition-colors"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={handleGeneratePassword}
                      title="Сгенерировать пароль"
                      className="p-1.5 rounded-md text-textSecondary hover:text-textPrimary hover:bg-surfaceLow transition-colors"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-textSecondary">Уровень</label>
            <select
              value={form.level}
              onChange={(e) => set('level', e.target.value)}
              className="flex h-12 w-full bg-surfaceLowest px-3 py-2 text-sm border-b-2 border-transparent focus:border-primary transition-colors outline-none text-textPrimary"
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1">
              Отмена
            </Button>
            <Button type="submit" variant="primary" isLoading={submitting} className="flex-1">
              Добавить студента
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── InfoTab ──────────────────────────────────────────────────────────────────

interface InfoTabProps {
  student: Student;
  onCommentChange: (comment: string) => void;
  onCommentSave: () => void;
  commentDirty: boolean;
  commentSaving: boolean;
  onFreezeToggle: (reason: string) => void;
  freezeSaving: boolean;
}

function InfoTab({ student, onCommentChange, onCommentSave, commentDirty, commentSaving, onFreezeToggle, freezeSaving }: InfoTabProps) {
  const status = stuStatus(student);

  const rows: { icon: React.ReactNode; label: string; value: string | null; colored?: boolean }[] = [
    { icon: <Phone className="w-4 h-4" />, label: 'Телефон', value: student.phone || '—' },
    { icon: <Mail className="w-4 h-4" />, label: 'Email', value: student.email || '—' },
    ...(student.username ? [{ icon: <Key className="w-4 h-4" />, label: 'Логин', value: student.username }] : []),
    { icon: <BookOpen className="w-4 h-4" />, label: 'Уровень', value: student.level || '—' },
    { icon: <Home className="w-4 h-4" />, label: 'Кабинет', value: student.cabinet || '—' },
    { icon: <Clock className="w-4 h-4" />, label: 'Время', value: student.time || '—' },
    { icon: <Calendar className="w-4 h-4" />, label: 'Оплачено до', value: student.paidUntil ? student.paidUntil.split('-').reverse().join('-') : '—', colored: true },
  ];

  return (
    <div className="space-y-1">
      {rows.map(({ icon, label, value, colored }) => (
        <div key={label} className="flex items-center gap-3 py-2.5 border-b border-border/30">
          <span className="text-textSecondary w-4 shrink-0">{icon}</span>
          <span className="text-xs font-semibold uppercase tracking-wider text-textSecondary w-28 shrink-0">{label}</span>
          <span className={`text-sm font-medium ${colored && status === 'overdue' ? 'text-danger' : colored && status === 'paused' ? 'text-[#0284C7]' : colored ? 'text-success' : 'text-textPrimary'}`}>
            {value}
          </span>
        </div>
      ))}

      {/* На паузе — toggle fires immediately */}
      <div className="border-b border-border/30">
        <div className="flex items-center gap-3 py-2.5">
          <span className="text-textSecondary w-4 shrink-0"><PauseCircle className="w-4 h-4" /></span>
          <span className="text-xs font-semibold uppercase tracking-wider text-textSecondary w-28 shrink-0">На паузе</span>
          <button
            onClick={() => onFreezeToggle('')}
            disabled={freezeSaving}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${student.paused ? 'bg-[#0284C7]' : 'bg-border'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${student.paused ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      <div className="pt-4">
        <Textarea
          label="Заметки"
          defaultValue={student.comment}
          rows={3}
          placeholder="Заметки об этом студенте..."
          onChange={(e) => onCommentChange(e.target.value)}
          className="bg-surfaceLow border-border/30 resize-none"
        />
        <div className="flex justify-end mt-2">
          <Button size="sm" onClick={onCommentSave} disabled={!commentDirty || commentSaving}>
            {commentSaving ? 'Сохранение...' : 'Сохранить заметку'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── PaymentTab ───────────────────────────────────────────────────────────────

interface FinanceConfig { basePrice: number; billingDays: number; }

const METHOD_LABELS: Record<string, string> = { cash: '💵 Нал', transfer: '📱 Перевод' };

function parsePayRecord(p: any): PayRecord | null {
  if (p == null || p.amount == null) return null;
  return {
    id: p.id,
    amount: Number(p.amount),
    method: String(p.method).toUpperCase() === 'TRANSFER' ? 'transfer' : 'cash',
    note: p.note ?? '',
    createdAt: p.createdAt,
    cancelledAt: p.cancelledAt ?? null,
  };
}

interface PaymentTabProps {
  student: Student;
  onUpdate: (fields: { credits: number; paidUntil: string | null }) => void;
}

function plural(n: number) {
  if (n === 1) return '1 урок';
  if (n >= 2 && n <= 4) return `${n} урока`;
  return `${n} уроков`;
}

function PaymentTab({ student, onUpdate }: PaymentTabProps) {
  const status = stuStatus(student);
  const [config, setConfig] = useState<FinanceConfig>({ basePrice: 5000, billingDays: 26 });
  const [amount, setAmount] = useState<number | ''>('');
  const [method, setMethod] = useState<'CASH' | 'TRANSFER'>('CASH');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<PayRecord[]>([]);
  const [histLoading, setHistLoading] = useState(true);
  const [monthlyFee, setMonthlyFee] = useState<number | ''>('');
  const [initialMonthlyFee, setInitialMonthlyFee] = useState<number | ''>('');
  const [paidThisMonth, setPaidThisMonth] = useState(0);
  // Carry-over wallet (сом): banked money that hasn't bought a full lesson yet
  const [wallet, setWallet] = useState(0);
  const [gifting, setGifting] = useState(false);
  const [cancelingId, setCancelingId] = useState<number | null>(null);
  const mountedRef = useRef(true);
  // One key per submission attempt: stable across retries of the same amount
  // (server replays instead of double-charging), fresh when the amount changes.
  const payKeyRef = useRef<string>(crypto.randomUUID());
  useEffect(() => { payKeyRef.current = crypto.randomUUID(); }, [amount]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    api.get('/settings/finance').then(res => {
      const d = res.data?.data;
      if (d) setConfig({ basePrice: Number(d.basePrice) || 5000, billingDays: Number(d.billingDays) || 26 });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!student.id) { setHistLoading(false); return; }
    setHistLoading(true);
    api.get(`/students/${student.id}/payment-history`)
      .then(res => {
        if (!mountedRef.current) return;
        const raw: any[] = res.data?.data ?? [];
        setHistory(raw.map(parsePayRecord).filter(Boolean) as PayRecord[]);
        const m = res.data?.monthly;
        if (m) {
          const fee = m.monthlyFee != null ? Number(m.monthlyFee) : '';
          setMonthlyFee(fee);
          setInitialMonthlyFee(fee);
          setPaidThisMonth(Number(m.paidThisMonth ?? 0));
          setWallet(Number(m.moneyBalance ?? 0));
        }
      })
      .catch(() => { /* intentional — mount fetch */ })
      .finally(() => { if (mountedRef.current) setHistLoading(false); });
  }, [student.id]);

  // Flexible monthly fee (if set) drives this student's per-lesson price, mirroring
  // the server. Uses the live input value so the preview reflects an unsaved fee.
  const effectiveFee = monthlyFee === '' ? config.basePrice : monthlyFee;
  // Exact fractional price (no rounding) so the preview matches the server's Decimal
  // math: lessons = floor((banked + amount) / (fee / billingDays)).
  const priceExact = effectiveFee / (config.billingDays || 1);
  const pricePerLesson = Math.round(priceExact);
  const creditsPreview = typeof amount === 'number' && amount > 0 ? Math.floor((wallet + amount) / priceExact) : 0;

  async function handleApply(feeOnly = false) {
    setSaving(true);
    try {
      const body: Record<string, any> = {};
      const headers: Record<string, string> = {};
      const hasPayment = !feeOnly && typeof amount === 'number' && amount > 0;
      // null clears the override → falls back to school basePrice
      body.monthlyFee = monthlyFee === '' ? null : monthlyFee;
      if (hasPayment) {
        body.paymentAmount = amount;
        body.paymentMethod = method.toUpperCase();
        body.paymentNote = note.trim();
        headers['Idempotency-Key'] = payKeyRef.current;
      }
      const res = await api.patch(`/students/${student.id}`, body, { headers });
      toast.success(hasPayment ? `Оплата записана — +${creditsPreview} уроков` : 'Оплата сохранена');
      setInitialMonthlyFee(monthlyFee);

      // Propagate the fresh balance/date from the server so the status badge
      // updates immediately — no page reload needed.
      const p = res.data?.data;
      if (p) {
        onUpdate({
          credits: typeof p.credits === 'number' ? p.credits : student.credits,
          paidUntil: p.paidUntil ? new Date(p.paidUntil).toISOString().slice(0, 10) : null,
        });
        if (p.moneyBanked != null) setWallet(Number(p.moneyBanked));
      }

      if (hasPayment) {
        const newEntry: PayRecord = {
          id: p?.paymentId ?? Date.now(),
          amount,
          method: method.toLowerCase() as PayRecord['method'],
          note: note.trim(),
          createdAt: new Date().toISOString(),
          cancelledAt: null,
        };
        setHistory(prev => [newEntry, ...prev]);
        setPaidThisMonth(prev => prev + amount);
        setAmount('');
        setNote('');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  }

  const monthPct = effectiveFee > 0 ? Math.min(100, Math.round((paidThisMonth / effectiveFee) * 100)) : 0;
  const monthRemainder = Math.max(0, effectiveFee - paidThisMonth);
  const monthLabel = new Date().toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  async function handleGift() {
    setGifting(true);
    try {
      const res = await api.patch(`/students/${student.id}`, { giftLesson: true });
      const p = res.data?.data;
      onUpdate({
        credits: typeof p?.credits === 'number' ? p.credits : student.credits + 1,
        paidUntil: p?.paidUntil ? new Date(p.paidUntil).toISOString().slice(0, 10) : student.paidUntil,
      });
      toast.success('Подарок записан — +1 урок');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Не удалось подарить урок');
    } finally {
      setGifting(false);
    }
  }

  async function handleCancelPayment(p: PayRecord) {
    if (!window.confirm(`Отменить оплату ${p.amount.toLocaleString()} с? С баланса будут списаны начисленные уроки (баланс может уйти в минус).`)) return;
    setCancelingId(p.id);
    try {
      const res = await api.post(`/students/${student.id}/payments/${p.id}/cancel`);
      const d = res.data?.data;
      onUpdate({
        credits: typeof d?.credits === 'number' ? d.credits : student.credits,
        paidUntil: d?.paidUntil ? new Date(d.paidUntil).toISOString().slice(0, 10) : student.paidUntil,
      });
      setHistory(prev => prev.map(x => x.id === p.id ? { ...x, cancelledAt: new Date().toISOString() } : x));
      setPaidThisMonth(prev => Math.max(0, prev - p.amount));
      toast.success('Оплата отменена');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Не удалось отменить оплату');
    } finally {
      setCancelingId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Оплата за месяц — прогресс относительно месячной суммы */}
      <div className="p-4 bg-surfaceLow rounded-xl border border-border/30 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-textSecondary">Оплата за {monthLabel}</div>
          <div className="flex items-center gap-1.5">
            <input
              type="number" min="0" value={monthlyFee}
              onChange={e => setMonthlyFee(e.target.value === '' ? '' : Number(e.target.value))}
              onWheel={e => e.currentTarget.blur()}
              placeholder={String(config.basePrice)}
              title="Месячная сумма студента"
              className="w-24 bg-white border border-border/40 rounded-lg px-2 py-1 text-sm text-right outline-none focus:border-primary placeholder:text-textSecondary/40"
            />
            <span className="text-xs text-textSecondary">сом/мес</span>
            <button
              onClick={() => handleApply(true)}
              disabled={saving || monthlyFee === initialMonthlyFee}
              className="text-xs font-bold px-2.5 py-1 rounded-lg bg-primary text-white hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {saving ? '...' : 'Сохранить'}
            </button>
          </div>
        </div>
        {effectiveFee > 0 ? (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-lg font-bold text-primary">{paidThisMonth.toLocaleString()} с</span>
              <span className="text-xs text-textSecondary">из {effectiveFee.toLocaleString()} с · {monthPct}%</span>
            </div>
            <div className="w-full bg-border/40 h-2 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-[width] ${monthPct >= 100 ? 'bg-success' : 'bg-primary'}`} style={{ width: `${monthPct}%` }} />
            </div>
            <div className="text-xs text-textSecondary">
              Остаток: <span className={`font-bold ${monthRemainder > 0 ? 'text-danger' : 'text-success'}`}>{monthRemainder.toLocaleString()} с</span>
            </div>
          </>
        ) : (
          <div className="text-xs text-textSecondary">
            Оплачено: <span className="font-bold text-primary">{paidThisMonth.toLocaleString()} с</span>. Задайте месячную сумму, чтобы видеть %.
          </div>
        )}
      </div>

      {/* Комментарий к оплате — сохраняется только вместе с оплатой (см. handleApply/hasPayment) */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-1.5">Комментарий к оплате</div>
        <input
          type="text"
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Апрель 2026..."
          className="w-full bg-surfaceLow border border-border/40 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-primary transition-colors text-textPrimary placeholder:text-textSecondary/50"
        />
      </div>

      {/* Способ */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-1.5">Способ оплаты</div>
        <div className="flex gap-2">
          {(['CASH', 'TRANSFER'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`flex-1 py-2 text-sm font-bold rounded-lg border transition-colors ${method === m ? 'bg-primary text-white border-primary' : 'bg-surfaceLow text-textSecondary border-border/40 hover:border-primary/40'}`}
            >
              {m === 'CASH' ? '💵 Нал' : '📱 Перевод'}
            </button>
          ))}
        </div>
      </div>

      {/* Быстрые суммы + инпут */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-2">Сумма оплаты</div>
        <div className="relative">
          <input
            type="number"
            min="0"
            value={amount}
            onChange={e => setAmount(e.target.value === '' ? '' : Number(e.target.value))}
            onWheel={e => e.currentTarget.blur()}
            placeholder="Или введите вручную..."
            className="w-full bg-surfaceLow border border-border/40 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-primary transition-colors text-textPrimary placeholder:text-textSecondary/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          {creditsPreview > 0 && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-primary">= {creditsPreview} ур.</span>
          )}
        </div>
      </div>

      {/* Применить */}
      <button
        onClick={() => handleApply()}
        disabled={saving || (!(typeof amount === 'number' && amount > 0) && monthlyFee === initialMonthlyFee)}
        className="w-full bg-primary text-white font-bold py-3 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        {saving ? 'Сохранение...' : creditsPreview > 0 ? `Записать оплату (+${creditsPreview} уроков)` : 'Сохранить'}
      </button>

      {/* Баланс */}
      <div className="flex items-center justify-between p-4 bg-surfaceLow rounded-xl border border-border/30">
        <div className="flex items-center gap-3">
          <Banknote className="w-5 h-5 text-textSecondary shrink-0" />
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-0.5">Баланс уроков</div>
            <div className={`text-lg font-bold ${status === 'overdue' ? 'text-danger' : status === 'paused' ? 'text-[#0284C7]' : 'text-success'}`}>
              {plural(student.credits)}
            </div>
            {wallet > 0 && (
              <div className="text-[11px] text-textSecondary mt-0.5">
                Накоплено: <span className="font-bold">{wallet.toLocaleString()} с</span> из {pricePerLesson.toLocaleString()} с за урок
              </div>
            )}
          </div>
        </div>
        <button
          onClick={handleGift}
          disabled={gifting}
          className="text-xs font-bold px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-40"
        >
          {gifting ? '...' : '+1 подарок'}
        </button>
      </div>

      {/* History */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-3">История оплат</div>
        {histLoading ? (
          <div className="flex justify-center py-6"><Spinner size="sm" /></div>
        ) : history.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-textSecondary/40 border border-dashed border-border/40 rounded-xl gap-2">
            <Calendar className="w-7 h-7" />
            <p className="text-sm">История оплат пуста</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {history.slice(0, 10).map(p => (
              <div key={p.id} className={`flex items-center justify-between px-3 py-2.5 rounded-lg ${p.cancelledAt ? 'bg-danger/5' : 'bg-surfaceLow'}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-textSecondary shrink-0">
                    {new Date(p.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                  </span>
                  {p.cancelledAt && (
                    <span className="text-[10px] font-bold uppercase text-danger bg-danger/10 px-1.5 py-0.5 rounded shrink-0">Отменено</span>
                  )}
                  {p.note && (
                    <span className="text-xs text-textSecondary/60 truncate">{p.note}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <span className="text-xs text-textSecondary">{METHOD_LABELS[p.method]}</span>
                  <span className={`text-sm font-bold ${p.cancelledAt ? 'text-textSecondary/50 line-through' : 'text-primary'}`}>{p.amount.toLocaleString()} с</span>
                  {!p.cancelledAt && (
                    <button
                      onClick={() => handleCancelPayment(p)}
                      disabled={cancelingId === p.id}
                      title="Отменить оплату"
                      className="text-textSecondary/40 hover:text-danger transition-colors disabled:opacity-40"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Выписка по урокам (roll-forward по журналу кредитов) */}
      {student.studentProfileId != null && (
        <CreditStatement studentProfileId={student.studentProfileId} />
      )}
    </div>
  );
}

// ─── LessonTypeTab ────────────────────────────────────────────────────────────

interface LessonTypeTabProps {
  student: Student;
  onLessonTypeChange: (lt: 'all' | 'grammar' | 'club') => void;
  saving: boolean;
}

function LessonTypeTab({ student, onLessonTypeChange, saving }: LessonTypeTabProps) {
  const options: { value: 'all' | 'grammar' | 'club'; label: string }[] = [
    { value: 'all', label: 'Все уроки' },
    { value: 'grammar', label: 'Грамматика' },
    { value: 'club', label: 'Разговорный клуб' },
  ];

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-3">
          Тематика занятий
        </div>
        <div className="flex gap-2 flex-wrap">
          {options.map((opt) => (
            <button
              key={opt.value}
              disabled={saving}
              onClick={() => onLessonTypeChange(opt.value)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                student.lessonType === opt.value
                  ? 'bg-primary text-white border-primary'
                  : 'bg-surfaceLow text-textPrimary border-border/40 hover:border-primary/40'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {saving && (
        <div className="flex items-center gap-2 text-sm text-textSecondary">
          <Spinner size="sm" />
          Сохранение...
        </div>
      )}
    </div>
  );
}


// ─── ConfirmArchiveModal ──────────────────────────────────────────────────────

interface ConfirmArchiveModalProps {
  isOpen: boolean;
  studentName: string;
  /** True while the archive request is in flight — disables both buttons so a
   *  double-tap (or an Escape/backdrop dismiss) cannot fire a second request or
   *  abandon the in-flight one. */
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmArchiveModal({ isOpen, studentName, confirming, onConfirm, onCancel }: ConfirmArchiveModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !confirming) onCancel(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, confirming, onCancel]);

  useBodyScrollLock(isOpen);
  // Back closes unconditionally (unlike Esc, which waits out `confirming`): a
  // swallowed back-press would consume the history entry and leave the next one
  // navigating off the page.
  useBackButtonClose(isOpen, onCancel);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/50 p-4" onClick={() => { if (!confirming) onCancel(); }}>
      <div className="bg-surfaceLowest rounded-2xl shadow-xl w-full max-w-sm p-6 max-h-[90dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center shrink-0">
            <Archive className="w-5 h-5 text-warning" />
          </div>
          <div>
            <h3 className="font-bold text-textPrimary">Архивировать студента</h3>
            <p className="text-xs text-textSecondary mt-0.5">Данные сохранятся, студент пропадёт из активного списка</p>
          </div>
        </div>
        <p className="text-sm text-textSecondary mb-6">
          Студент <span className="font-semibold text-textPrimary">{studentName}</span> будет перемещён в архив.
          Вы сможете восстановить его в любой момент.
        </p>
        <div className="flex gap-3">
          <Button type="button" variant="outline" onClick={onCancel} disabled={confirming} className="flex-1">
            Отмена
          </Button>
          <Button type="button" variant="primary" onClick={onConfirm} isLoading={confirming} className="flex-1 !bg-warning !hover:bg-warning/90 !border-warning">
            Архивировать
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── StudentProfileModal ──────────────────────────────────────────────────────

interface StudentProfileModalProps {
  student: Student | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (updated: Student) => void;
  /**
   * Fired once, after the student has been archived server-side. This is a
   * post-success notification only — callers use it purely to refresh their
   * own view (list refetch, roster update, schedule row sync). The archive
   * PATCH request, success/error toasts, and the confirm button's in-flight
   * state are all owned by this modal and ALWAYS run when the user confirms,
   * whether or not a caller supplies this callback — archiving can no longer
   * be silently stubbed out at a call site.
   */
  onArchived?: (student: Student) => void;
  /** Fired only when the note is saved — lets callers (e.g. schedule popup) sync it live. */
  onNotesSaved?: (notes: string) => void;
  /** Fired when a payment/gift/cancel changes the balance — lets the schedule popup sync cr/pd live. */
  onFinancialsChanged?: (fields: { credits: number; paidUntil: string | null }) => void;
  /** Fired when the student is paused/unpaused — lets the schedule popup sync the "на паузе" state live. */
  onPausedChanged?: (paused: boolean) => void;
}

export function StudentProfileModal({ student, isOpen, onClose, onUpdate, onArchived, onNotesSaved, onFinancialsChanged, onPausedChanged }: StudentProfileModalProps) {
  const [activeTab, setActiveTab] = useState<ProfileTab>('info');
  const [freezeSaving, setFreezeSaving] = useState(false);
  const [ltSaving, setLtSaving] = useState(false);
  const [notesSaving, setNotesSaving] = useState(false);
  const [localStudent, setLocalStudent] = useState<Student | null>(null);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (student) setLocalStudent(student);
  }, [student]);

  // Only reset to the Info tab when a DIFFERENT student is opened — not when the
  // current student's fields are updated in place (e.g. after a payment).
  useEffect(() => {
    if (student?.id) setActiveTab('info');
  }, [student?.id]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  useBodyScrollLock(isOpen);
  useBackButtonClose(isOpen, onClose);

  if (!isOpen || !localStudent) return null;

  const status = stuStatus(localStudent);
  const initials = getInitials(localStudent.name);

  const avatarClass =
    status === 'overdue'
      ? 'bg-danger/20 text-danger'
      : status === 'paused'
      ? 'bg-[#EFF6FF] text-[#0284C7]'
      : 'bg-success/20 text-success';

  const tabs: { id: ProfileTab; label: string }[] = [
    { id: 'info', label: 'Информация' },
    { id: 'payment', label: 'Оплата' },
    { id: 'lesson', label: 'Тип урока' },
  ];

  async function handleLessonTypeChange(lt: 'all' | 'grammar' | 'club') {
    if (!localStudent) return;
    setLtSaving(true);
    try {
      await api.patch(`/students/${localStudent.id}`, { lessonType: lt });
      const updated = { ...localStudent, lessonType: lt };
      setLocalStudent(updated);
      onUpdate(updated);
      toast.success('Тип урока обновлён');
    } catch {
      toast.error('Не удалось сохранить изменения');
    } finally {
      setLtSaving(false);
    }
  }

  async function handleFreezeToggle(reason: string) {
    if (!localStudent) return;
    setFreezeSaving(true);
    const newFrozen = !localStudent.paused;
    try {
      await api.patch(`/students/${localStudent.id}`, { isFrozen: newFrozen, reason });
      const updated = { ...localStudent, paused: newFrozen };
      setLocalStudent(updated);
      onUpdate(updated);
      onPausedChanged?.(newFrozen);
      toast.success(newFrozen ? 'Студент поставлен на паузу' : 'Пауза снята');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Не удалось изменить статус');
    } finally {
      setFreezeSaving(false);
    }
  }

  function handleCommentChange(comment: string) {
    setLocalStudent((prev) => prev ? { ...prev, comment } : prev);
  }

  async function handleCommentSave() {
    if (!localStudent) return;
    const notes = localStudent.comment;
    setNotesSaving(true);
    try {
      await api.patch(`/students/${localStudent.id}`, { notes });
      clearQueuedNote(localStudent.id);
      onUpdate(localStudent);
      onNotesSaved?.(notes);
      toast.success('Заметка сохранена');
    } catch (err: any) {
      if (!navigator.onLine) {
        queueNote(localStudent.id, notes);
        onUpdate(localStudent); // optimistic — flushNotes() will persist when back online
        onNotesSaved?.(notes);
        toast('Нет сети — заметка сохранится при подключении');
      } else {
        toast.error(err?.response?.data?.error || 'Не удалось сохранить заметку');
      }
    } finally {
      setNotesSaving(false);
    }
  }

  function handlePaymentUpdate(fields: { credits: number; paidUntil: string | null }) {
    if (!localStudent) return;
    const updated = { ...localStudent, credits: fields.credits, paidUntil: fields.paidUntil };
    setLocalStudent(updated);
    onUpdate(updated);
    onFinancialsChanged?.(fields);
  }

  // Owns the entire archive action: the API call, the toasts, and the
  // in-flight/disabled state — a call site can no longer "confirm" archiving
  // without it actually happening. `archiving` both disables the confirm
  // button (isLoading) and short-circuits re-entrancy if this ever fires twice.
  async function handleArchiveConfirm() {
    if (!localStudent || archiving) return;
    setArchiving(true);
    try {
      await api.patch(`/students/${localStudent.id}/archive`);
      toast.success(`${localStudent.name} перемещён в архив`);
      setArchiveConfirmOpen(false);
      onArchived?.(localStudent);
      onClose();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Не удалось архивировать студента');
      setArchiveConfirmOpen(false);
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-surfaceLowest rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-4 p-6 border-b border-border/30">
          <div
            className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold shrink-0 ${avatarClass}`}
          >
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-textPrimary truncate">{localStudent.name}</h2>
              {status === 'paused' && <Badge variant="frozen">На паузе</Badge>}
              {status === 'overdue' && <Badge variant="danger">Просрочка</Badge>}
              {status === 'active' && <Badge variant="success">Активен</Badge>}
            </div>
            <p className="text-xs text-textSecondary mt-0.5">Студент</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setArchiveConfirmOpen(true)}
              title="Архивировать студента"
              className="text-textSecondary hover:text-warning transition-colors rounded-lg p-1.5 hover:bg-warning/10"
            >
              <Archive className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="text-textSecondary hover:text-textPrimary transition-colors rounded-lg p-1 hover:bg-surfaceLow"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
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
            <InfoTab
              student={localStudent}
              onCommentChange={handleCommentChange}
              onCommentSave={handleCommentSave}
              commentDirty={localStudent.comment !== (student?.comment ?? '')}
              commentSaving={notesSaving}
              onFreezeToggle={handleFreezeToggle}
              freezeSaving={freezeSaving}
            />
          )}
          {activeTab === 'payment' && (
            <PaymentTab student={localStudent} onUpdate={handlePaymentUpdate} />
          )}
          {activeTab === 'lesson' && (
            <LessonTypeTab
              student={localStudent}
              onLessonTypeChange={handleLessonTypeChange}
              saving={ltSaving}
            />
          )}
        </div>
      </div>

      <ConfirmArchiveModal
        isOpen={archiveConfirmOpen}
        studentName={localStudent.name}
        confirming={archiving}
        onCancel={() => { if (!archiving) setArchiveConfirmOpen(false); }}
        onConfirm={handleArchiveConfirm}
      />
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapStudent(s: any): Student {
  const name = `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim();
  // Server maps memberships → enrolledGroups (each already unwrapped to studentGroup).
  const firstGroup = s.studentProfile?.enrolledGroups?.[0];
  const firstBlock = firstGroup?.blocks?.[0];
  const cabinet = firstBlock?.cabinet?.name ?? '';
  const time = firstBlock ? `${firstBlock.startTime ?? ''}–${firstBlock.endTime ?? ''}` : '';
  const level =
    s.studentProfile?.level
    ?? firstGroup?.level
    ?? (firstBlock as any)?.level
    ?? '';
  return {
    id: s.id,
    studentProfileId: s.studentProfile?.id ?? null,
    name,
    phone: s.phone ?? '',
    email: s.email ?? '',
    username: s.username ?? '',
    level,
    cabinet,
    time,
    credits: s.studentProfile?.credits ?? 0,
    paidUntil: s.studentProfile?.paidUntil
      ? new Date(s.studentProfile.paidUntil).toISOString().slice(0, 10)
      : null,
    paused: s.studentProfile?.isFrozen ?? false,
    comment: '',
    lessonType: 'all' as const,
    archivedAt: s.archivedAt ?? null,
    deletedAt: s.deletedAt ?? null,
  };
}

// ─── Sortable column header ───────────────────────────────────────────────────

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

// ─── Main: Students page ──────────────────────────────────────────────────────

export default function Students() {
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [archiveView, setArchiveView] = useState(false);
  const [archivedStudents, setArchivedStudents] = useState<Student[]>([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveSearchInput, setArchiveSearchInput] = useState('');
  const debouncedArchiveSearch = useDebounce(archiveSearchInput, 300);

  const [searchParams, setSearchParams] = useSearchParams();
  // Seed from the URL only — filters intentionally reset when you navigate away.
  const [searchInput, setSearchInput] = useState(() => searchParams.get('q') ?? '');
  const debouncedSearch = useDebounce(searchInput, 300);
  const filter = (searchParams.get('status') ?? 'all') as FilterType;
  const page = parseInt(searchParams.get('page') ?? '1', 10);

  // Sync debounced search input → URL. Skip the initial mount run: the box is
  // already seeded from the URL, and this write would clobber a ?page= deep-link.
  const searchSyncMounted = useRef(false);
  useEffect(() => {
    if (!searchSyncMounted.current) { searchSyncMounted.current = true; return; }
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (debouncedSearch) next.set('q', debouncedSearch); else next.delete('q');
      next.delete('page');
      return next;
    }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  function setPage(n: number) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (n > 1) next.set('page', String(n)); else next.delete('page');
      return next;
    }, { replace: true });
  }

  const [addOpen, setAddOpen] = useState(false);
  const [profileStudent, setProfileStudent] = useState<Student | null>(null);
  const sortParam = searchParams.get('sort');
  const sort = sortParam
    ? { key: sortParam.split(':')[0] as SortKey, dir: sortParam.split(':')[1] as 'asc' | 'desc' }
    : null;

  // Cycle asc → desc → off, persisted in the URL so it survives refresh.
  function toggleSort(key: SortKey) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      const [ck, cd] = (prev.get('sort') ?? '').split(':');
      const val = ck !== key ? `${key}:asc` : cd === 'asc' ? `${key}:desc` : null;
      if (val) next.set('sort', val); else next.delete('sort');
      next.delete('page');
      return next;
    }, { replace: true });
  }

  // ── Fetch ────────────────────────────────────────────────────────────────

  const fetchStudents = useCallback(async () => {
    try {
      const res = await api.get('/students?limit=3000');
      const raw = res.data?.data ?? res.data ?? [];
      setStudents(Array.isArray(raw) ? raw.map(mapStudent) : []);
      setError(null);
    } catch {
      setError('Не удалось загрузить список студентов');
      setStudents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchArchivedStudents = useCallback(async (search: string) => {
    setArchiveLoading(true);
    setArchiveError(null);
    try {
      // 3000 matches the server cap — after clear-data the archive can hold the whole school.
      const params = new URLSearchParams({ archived: 'true', limit: '3000' });
      if (search) params.set('search', search);
      const res = await api.get(`/students?${params}`);
      const raw = res.data?.data ?? [];
      setArchivedStudents(Array.isArray(raw) ? raw.map(mapStudent) : []);
      setArchivedTotal(res.data?.meta?.total ?? raw.length);
    } catch {
      setArchiveError('Не удалось загрузить архив');
      setArchivedStudents([]);
    } finally {
      setArchiveLoading(false);
    }
  }, []);

  // The archive PATCH + toast now live inside StudentProfileModal itself (it
  // always runs on confirm, whether or not this callback exists). This is
  // purely the post-success refresh for this page's active list; closing the
  // modal is handled by the modal's own onClose() call.
  function handleArchived() {
    fetchStudents();
  }

  async function handleUnarchive(student: Student) {
    try {
      await api.patch(`/students/${student.id}/unarchive`);
      toast.success(`${student.name} восстановлен из архива`);
      fetchArchivedStudents(debouncedArchiveSearch);
    } catch {
      toast.error('Не удалось восстановить студента');
    }
  }

  useEffect(() => {
    fetchStudents();
  }, [fetchStudents]);

  useEffect(() => {
    if (archiveView) fetchArchivedStudents(debouncedArchiveSearch);
  }, [archiveView, debouncedArchiveSearch, fetchArchivedStudents]);

  // ── Derived counts ───────────────────────────────────────────────────────

  // ── Filtered list ────────────────────────────────────────────────────────

  const q = debouncedSearch.toLowerCase();
  const filtered = useMemo(() => students.filter((s) => {
    if (filter !== 'all' && stuStatus(s) !== filter) return false;
    if (q && !`${s.name} ${s.phone} ${s.email} ${s.level} ${s.cabinet}`.toLowerCase().includes(q))
      return false;
    return true;
  }), [students, filter, q]);

  // ── Sort ─────────────────────────────────────────────────────────────────
  // Click a header: asc → desc → off. Empty values always sort last.
  const sorted = useMemo(() => sort
    ? [...filtered].sort((a, b) => {
        const av = sortVal(a, sort.key);
        const bv = sortVal(b, sort.key);
        if (!av && bv) return 1;
        if (av && !bv) return -1;
        const cmp = av.localeCompare(bv);
        return sort.dir === 'asc' ? cmp : -cmp;
      })
    : filtered, [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / STU_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * STU_PER_PAGE;
  const pageItems = sorted.slice(pageStart, pageStart + STU_PER_PAGE);

  function handleUpdate(updated: Student) {
    setStudents((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setProfileStudent(updated);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="text-textPrimary">

      {/* Page header — search + actions in one row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-4">
        {!archiveView && (
          <SearchInput value={searchInput} onChange={setSearchInput} className="flex-1" />
        )}
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setArchiveView(v => !v); setArchiveSearchInput(''); }}
            className={archiveView ? 'border-warning text-warning bg-warning/10' : ''}
          >
            <Archive className="w-4 h-4" />
            {archiveView ? 'Активные студенты' : 'Архив'}
          </Button>
          {!archiveView && (
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="w-4 h-4" />
              Новый студент
            </Button>
          )}
        </div>
      </div>

      {/* ── Archive view ───────────────────────────────────────────────────── */}
      {archiveView && (
        <div>
          {/* Search in archive */}
          <div className="bg-surfaceLowest rounded-xl border border-border p-4 mb-4">
            <SearchInput value={archiveSearchInput} onChange={setArchiveSearchInput} placeholder="Поиск в архиве..." className="max-w-sm" />
          </div>

          <div className="text-xs text-textSecondary mb-3 px-1">{archivedTotal} студентов в архиве</div>

          <div className="bg-surfaceLowest rounded-xl border border-border overflow-hidden">
            {archiveLoading && (
              <div className="flex items-center justify-center gap-3 py-20 text-textSecondary">
                <Spinner size="md" />
                <span className="text-sm">Загрузка архива...</span>
              </div>
            )}
            {!archiveLoading && archiveError && (
              <EmptyState title="Ошибка" description={archiveError} icon={<AlertCircle size={40} />} />
            )}
            {!archiveLoading && !archiveError && archivedStudents.length === 0 && (
              <EmptyState title="Архив пуст" description="Нет архивированных студентов" icon={<Archive size={40} />} />
            )}
            {!archiveLoading && !archiveError && archivedStudents.map(student => {
              const initials = getInitials(student.name);
              // deletedAt takes precedence: a soft-deleted record is "Удалён" even if also archived.
              const isDeleted = !!student.deletedAt;
              const stateLabel = isDeleted ? 'Удалён' : 'Архивирован';
              const stateDateRaw = student.deletedAt ?? student.archivedAt;
              const stateDate = stateDateRaw
                ? new Date(stateDateRaw).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
                : '—';
              return (
                <div
                  key={student.id}
                  className="grid md:grid-cols-[32px_1fr_140px_120px] grid-cols-1 gap-3 px-4 py-3.5 border-b border-border/30 last:border-0 items-center"
                >
                  <div className="hidden md:flex items-center justify-center">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold bg-surfaceLow text-textSecondary">
                      {initials}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-textPrimary truncate">{student.name}</p>
                    <p className="text-xs text-textSecondary truncate">{student.email}</p>
                    {student.level && <p className="text-xs text-textSecondary">{student.level}</p>}
                  </div>
                  <div className="hidden md:block text-xs text-textSecondary">
                    <span className={`text-[10px] uppercase tracking-widest font-bold block mb-0.5 ${isDeleted ? 'text-warning' : ''}`}>{stateLabel}</span>
                    {stateDate}
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => handleUnarchive(student)}
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
        </div>
      )}

      {/* ── Active view ─────────────────────────────────────────────────────── */}
      {!archiveView && (
      <>

      {/* ── Student list ───────────────────────────────────────────────────── */}
      <div className="bg-surfaceLowest rounded-xl border border-border overflow-hidden">

        {/* Table header (desktop) — sortable columns */}
        <div className="hidden md:grid grid-cols-[28px_minmax(0,2.2fr)_1.3fr_0.8fr_1fr_0.9fr] gap-3 px-4 py-3 border-b border-border/50 text-[10px] font-bold uppercase tracking-widest text-textSecondary">
          <span />
          <SortHeader label="Студент" col="name" sort={sort} onSort={toggleSort} />
          <SortHeader label="Кабинет · Время" col="cabinet" sort={sort} onSort={toggleSort} />
          <SortHeader label="Уровень" col="level" sort={sort} onSort={toggleSort} />
          <SortHeader label="Кредиты" col="paidUntil" sort={sort} onSort={toggleSort} />
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
          <EmptyState
            title="Произошла ошибка"
            description={error}
            icon={<AlertCircle size={40} />}
          />
        )}

        {/* Empty */}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState
            title="Студенты не найдены"
            description={students.length === 0 ? 'Студентов пока нет' : 'Нет студентов по выбранным фильтрам'}
            icon={<Search size={40} />}
          />
        )}

        {/* Rows */}
        {!loading && !error && pageItems.map((student) => {
          const status = stuStatus(student);
          const initials = getInitials(student.name);
          const avatarClass =
            status === 'overdue'
              ? 'bg-danger/20 text-danger'
              : status === 'paused'
              ? 'bg-[#EFF6FF] text-[#0284C7]'
              : 'bg-success/20 text-success';
          const leftBorder =
            status === 'overdue'
              ? 'border-l-2 border-l-danger'
              : status === 'paused'
              ? 'border-l-2 border-l-[#0284C7]'
              : 'border-l-2 border-l-transparent';
          const cabShort = `${String(student.cabinet || '—').replace('Кабинет ', 'Каб.')} · ${
            String(student.time || '—').split('–')[0]
          }`;

          return (
            <div
              key={student.id}
              onClick={() => setProfileStudent(student)}
              className={`grid md:grid-cols-[28px_minmax(0,2.2fr)_1.3fr_0.8fr_1fr_0.9fr] grid-cols-1 gap-3 px-4 py-3.5 border-b border-border/30 last:border-0 cursor-pointer hover:bg-surfaceLow transition-colors items-center ${leftBorder}`}
            >
              {/* Avatar (desktop only in first col) */}
              <div className="hidden md:flex items-center justify-center">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${avatarClass}`}
                >
                  {initials}
                </div>
              </div>

              {/* Name + email */}
              <div className="flex items-center gap-3">
                <div
                  className={`md:hidden w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${avatarClass}`}
                >
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-textPrimary truncate">{student.name}</p>
                  <p className="text-xs text-textSecondary truncate">{student.email}</p>
                  {/* Mobile-only: extra info inline */}
                  <div className="md:hidden flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                    {student.level && (
                      <span className="text-xs text-textSecondary">{student.level}</span>
                    )}
                    {student.paidUntil && (
                      <span
                        className={`text-xs font-medium ${
                          status === 'overdue' ? 'text-danger' : status === 'paused' ? 'text-[#0284C7]' : 'text-success'
                        }`}
                      >
                        до {student.paidUntil}
                      </span>
                    )}
                    {status === 'paused' && <Badge variant="frozen">На паузе</Badge>}
                    {status === 'overdue' && <Badge variant="danger">Просрочка</Badge>}
                    {status === 'active' && <Badge variant="success">Активен</Badge>}
                  </div>
                </div>
              </div>

              {/* Cabinet + time (desktop) */}
              <span className="hidden md:block text-xs text-textSecondary truncate">{cabShort}</span>

              {/* Level (desktop) */}
              <span className="hidden md:block text-xs text-textSecondary">{student.level || '—'}</span>

              {/* Credits (desktop) */}
              <span
                className={`hidden md:block text-xs font-medium ${
                  status === 'overdue' ? 'text-danger' : status === 'paused' ? 'text-[#0284C7]' : 'text-success'
                }`}
              >
                {plural(student.credits)}
              </span>

              {/* Badge (desktop) */}
              <div className="hidden md:flex justify-start">
                {status === 'paused' && <Badge variant="frozen">На паузе</Badge>}
                {status === 'overdue' && <Badge variant="danger">Просрочка</Badge>}
                {status === 'active' && <Badge variant="success">Активен</Badge>}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Pagination ─────────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 px-1">
          <span className="text-xs text-textSecondary">
            {pageStart + 1}–{Math.min(pageStart + STU_PER_PAGE, filtered.length)} из {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={safePage === 1}
              onClick={() => setPage(safePage - 1)}
              className="p-2 rounded-lg border border-border/40 text-textSecondary hover:bg-surfaceLow disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {/* Page buttons */}
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
              onClick={() => setPage(safePage + 1)}
              className="p-2 rounded-lg border border-border/40 text-textSecondary hover:bg-surfaceLow disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      </>
      )}

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      <AddStudentModal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        onSuccess={(created) => {
          fetchStudents();
          if (created) setProfileStudent(mapStudent(created));
        }}
      />

      <StudentProfileModal
        student={profileStudent}
        isOpen={profileStudent !== null}
        onClose={() => setProfileStudent(null)}
        onUpdate={handleUpdate}
        onArchived={handleArchived}
      />
    </div>
  );
}
