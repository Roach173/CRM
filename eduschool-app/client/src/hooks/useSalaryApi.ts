import { useState, useCallback, useEffect } from 'react';
import api from '../lib/api';

export interface SalaryAdjustment {
  id: number;
  type: 'FINE' | 'ADVANCE' | 'BONUS';
  amount: number;
  reason: string;
  month: string;
  date: string;
  createdByName: string | null;
}

export interface ManualLessonEntry {
  id: number;
  type: 'ADD' | 'REMOVE';
  label: string;
  count: number;
  createdByName: string | null;
  createdAt?: string;
}

export interface PaymentSummary {
  id: number;
  lessonsCount: number;
  amount: number;
  adjustmentNet: number;
  paidAt: string;
  status: 'CONFIRMED' | 'VOIDED';
  note: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  createdByName: string | null;
  sessionIds: number[];
}

export interface StaffSalary {
  staffProfileId: number;
  userId: number;
  name: string;
  email: string;
  phone?: string;
  salaryRate: number;
  lessonsCount: number;
  manualDelta: number;
  effectiveLessons: number;
  rateSnapshot: number;
  gross: number;
  bonuses: number;
  fines: number;
  advances: number;
  net: number;
  adjustments: SalaryAdjustment[];
  manualEntries: ManualLessonEntry[];
  // Payment info
  paidLessonsCount: number;
  unpaidLessonsCount: number;
  totalPaidAmount: number;
  remainingAmount: number;
  isPaid: boolean;
  paidAmount: number;
  paymentId: number | null;
  paidAt: string | null;
  payments: PaymentSummary[];
}

export interface TeacherSalaryData {
  salaryRate: number;
  lessonsCount: number;
  manualDelta: number;
  manualEntries: Omit<ManualLessonEntry, 'createdByName'>[];
  effectiveLessons: number;
  gross: number;
  fines: number;
  advances: number;
  bonuses: number;
  net: number;
  isPaid: boolean;
  paidAmount: number;
}

export interface PaymentHistoryEntry {
  id: number;
  period: string;
  lessonsCount: number;
  rateSnapshot: number;
  amount: number;
  adjustmentNet: number;
  paidAt: string;
  note: string | null;
  status: 'CONFIRMED' | 'VOIDED';
  voidReason: string | null;
  voidedAt: string | null;
  createdByName: string | null;
  sessionIds: number[];
}

export function useSalaryApi(period: string) {
  const [data, setData] = useState<StaffSalary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/salary', { params: { period } });
      setData(res.data?.data ?? []);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const addAdjustment = useCallback(async (
    staffProfileId: number,
    type: 'FINE' | 'ADVANCE' | 'BONUS',
    amount: number,
    reason: string,
  ) => {
    const idempotencyKey = crypto.randomUUID();
    await api.post('/salary/adjustment', { staffProfileId, type, amount, reason, month: period }, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    await load();
  }, [period, load]);

  const deleteAdjustment = useCallback(async (adjId: number) => {
    await api.delete(`/salary/adjustment/${adjId}`);
    await load();
  }, [load]);

  const updateRate = useCallback(async (staffProfileId: number, salaryRate: number) => {
    await api.patch(`/salary/rate/${staffProfileId}`, { salaryRate });
    await load();
  }, [load]);

  const addManualEntry = useCallback(async (
    staffProfileId: number,
    type: 'ADD' | 'REMOVE',
    label: string,
    count: number,
  ) => {
    await api.post('/salary/manual-entry', { staffProfileId, type, label, count, month: period });
    await load();
  }, [period, load]);

  const deleteManualEntry = useCallback(async (entryId: number) => {
    await api.delete(`/salary/manual-entry/${entryId}`);
    await load();
  }, [load]);

  /** Выплатить за конкретные уроки (по ID сессий). Возвращает фактическую сумму выплаты. */
  const payWithSessions = useCallback(async (
    staffProfileId: number,
    sessionIds: number[],
    note?: string,
  ): Promise<number> => {
    const idempotencyKey = crypto.randomUUID();
    const res = await api.post(`/salary/pay/${staffProfileId}`, { period, sessionIds, note }, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    await load();
    return Number(res.data?.data?.amount ?? 0);
  }, [period, load]);

  /** Аннулировать выплату по ID платежа (запись остаётся со статусом VOIDED) */
  const cancelPay = useCallback(async (paymentId: number, reason: string) => {
    await api.delete(`/salary/pay/${paymentId}`, { data: { reason } });
    await load();
  }, [load]);

  /** Изменить комментарий к выплате */
  const updatePaymentNote = useCallback(async (paymentId: number, note: string | null) => {
    await api.patch(`/salary/pay/${paymentId}/note`, { note });
    await load();
  }, [load]);

  /** Загрузить полную историю выплат преподавателя */
  const fetchPaymentHistory = useCallback(async (
    staffProfileId: number,
  ): Promise<PaymentHistoryEntry[]> => {
    const res = await api.get(`/salary/history/${staffProfileId}`);
    return res.data?.data ?? [];
  }, []);

  const totalGross = data.reduce((s, d) => s + d.gross, 0);
  const totalNet   = data.reduce((s, d) => s + d.remainingAmount, 0);
  const totalPaid  = data.reduce((s, d) => s + d.totalPaidAmount, 0);
  const closedCount = data.filter(d => d.isPaid).length;

  return {
    data, loading, error,
    load,
    addAdjustment, deleteAdjustment,
    updateRate,
    addManualEntry, deleteManualEntry,
    payWithSessions, cancelPay, updatePaymentNote, fetchPaymentHistory,
    totalGross, totalNet, totalPaid, closedCount,
  };
}
