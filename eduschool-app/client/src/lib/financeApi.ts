import api from './api';
import type {
  Invoice,
  InvoiceLine,
  Payment,
  PaymentRefund,
  ReceivableSummary,
  OverdueInvoice,
  StudentReceivableSummary,
} from '../types';

// ─── Money formatting ─────────────────────────────────────────────────────────

export function formatMoney(value: string | number | null | undefined, currency = 'KGS'): string {
  if (value == null || value === '') return `0 ${currency}`;
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return `0 ${currency}`;
  return `${num.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;
}

// ─── Error message mapping ────────────────────────────────────────────────────

const FINANCE_ERRORS: Record<string, string> = {
  INVOICE_NOT_EDITABLE:              'Инвойс нельзя редактировать (не в статусе DRAFT)',
  INVOICE_NOT_FOUND:                 'Инвойс не найден',
  INVOICE_NOT_DRAFT:                 'Инвойс уже выставлен (не DRAFT)',
  INVOICE_HAS_NO_LINES:              'Добавьте хотя бы одну строку в инвойс',
  INVOICE_ALREADY_VOID:              'Инвойс уже аннулирован',
  INVOICE_PAID_CANNOT_VOID:          'Нельзя аннулировать оплаченный инвойс',
  INVOICE_HAS_CONFIRMED_ALLOCATIONS: 'Сначала аннулируйте платёж, привязанный к этому инвойсу',
  INVOICE_IS_VOID:                   'Инвойс аннулирован',
  INVOICE_NOT_ISSUED:                'Инвойс должен быть выставлен до распределения платежа',
  INVOICE_ALREADY_PAID:              'Инвойс уже полностью оплачен',
  PAYMENT_NOT_FOUND:                 'Платёж не найден',
  PAYMENT_NOT_CONFIRMED:             'Только подтверждённый платёж можно аннулировать',
  PAYMENT_AMOUNT_MUST_BE_POSITIVE:   'Сумма платежа должна быть положительной',
  PAYMENT_NOT_FOUND_OR_NOT_CONFIRMED:'Платёж не найден или не подтверждён',
  OVERPAYMENT:                       'Сумма превышает остаток по инвойсу',
  CROSS_SCHOOL:                      'Операция между разными школами запрещена',
  PAYMENT_VOIDED:                    'Платёж уже аннулирован',
  ALLOCATION_EXCEEDS_INVOICE_BALANCE:'Распределение превышает остаток по инвойсу',
  ALLOCATION_ALREADY_EXISTS:         'Платёж уже распределён на этот инвойс',
  STUDENT_NOT_FOUND:                 'Студент не найден',
  REFUND_EXCEEDS_BALANCE:            'Возврат превышает доступный остаток',
  REFUND_EXCEEDS_REFUNDABLE_BALANCE: 'Сумма возврата превышает доступный остаток для возврата',
  REFUND_NOT_FOUND:                  'Возврат не найден',
  REFUND_ALREADY_CONFIRMED:          'Возврат уже подтверждён',
  REFUND_ALREADY_VOIDED:             'Возврат уже аннулирован',
};

export function financeErrorMessage(raw: string | undefined): string {
  if (!raw) return 'Неизвестная ошибка';
  return FINANCE_ERRORS[raw] ?? raw;
}

// ─── Pagination meta ──────────────────────────────────────────────────────────

export interface PaginatedMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginatedMeta;
}

// ─── Invoice API ──────────────────────────────────────────────────────────────

export interface CreateInvoiceInput {
  studentProfileId: number;
  dueDate?: string;
  note?: string;
  currencyCode?: string;
  periodStart?: string;
  periodEnd?: string;
  lines?: CreateInvoiceLineInput[];
}

export interface CreateInvoiceLineInput {
  type: string;
  description: string;
  quantity: number;
  unitPrice: number;
  creditsToIssue?: number;
  groupId?: number;
  lessonBlockId?: number;
  periodStart?: string;
  periodEnd?: string;
}

export const invoiceApi = {
  async list(params?: {
    studentProfileId?: number;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResponse<Invoice>> {
    const res = await api.get('/invoices', { params });
    return { data: res.data.data, meta: res.data.meta };
  },

  async get(id: number): Promise<Invoice> {
    const res = await api.get(`/invoices/${id}`);
    return res.data.data;
  },

  async create(input: CreateInvoiceInput): Promise<Invoice> {
    const res = await api.post('/invoices', input);
    return res.data.data;
  },

  async addLine(invoiceId: number, line: CreateInvoiceLineInput): Promise<InvoiceLine> {
    const res = await api.post(`/invoices/${invoiceId}/lines`, line);
    return res.data.data;
  },

  async issue(invoiceId: number): Promise<Invoice> {
    const res = await api.post(`/invoices/${invoiceId}/issue`);
    return res.data.data;
  },

  async void(invoiceId: number): Promise<Invoice> {
    const res = await api.post(`/invoices/${invoiceId}/void`);
    return res.data.data;
  },
};

// ─── Payment API ──────────────────────────────────────────────────────────────

export interface CreatePaymentInput {
  studentProfileId: number;
  amount: number;
  method: 'CASH' | 'CARD' | 'TRANSFER';
  note?: string;
  paidAt?: string;
  allocations?: { invoiceId: number; amount: number }[];
}

export const paymentApi = {
  async list(params?: {
    studentProfileId?: number;
    status?: string;
    page?: number;
    limit?: number;
    includeCredits?: boolean;
  }): Promise<PaginatedResponse<Payment>> {
    const res = await api.get('/payments', { params });
    return { data: res.data.data, meta: res.data.meta };
  },

  async get(id: number): Promise<Payment> {
    const res = await api.get(`/payments/${id}`);
    return res.data.data;
  },

  // Server rejects these financial writes without an Idempotency-Key header —
  // callers must pass a key that is stable across retries of the same attempt.
  async create(input: CreatePaymentInput, idempotencyKey: string): Promise<{ payment: Payment; allocations: PaymentAllocationResult[] }> {
    const res = await api.post('/payments', input, { headers: { 'Idempotency-Key': idempotencyKey } });
    return res.data.data;
  },

  async allocate(paymentId: number, invoiceId: number, amount: number, idempotencyKey: string): Promise<unknown> {
    const res = await api.post(`/payments/${paymentId}/allocate`, { invoiceId, amount }, { headers: { 'Idempotency-Key': idempotencyKey } });
    return res.data.data;
  },

  async void(paymentId: number): Promise<Payment> {
    const res = await api.post(`/payments/${paymentId}/void`);
    return res.data.data;
  },

  async updateNote(paymentId: number, note: string | null): Promise<void> {
    await api.patch(`/payments/${paymentId}/note`, { note });
  },
};

interface PaymentAllocationResult {
  id: number;
  paymentId: number;
  invoiceId: number;
  amount: string;
}

// ─── Refund API ───────────────────────────────────────────────────────────────

export interface CreateRefundInput {
  reason: string;
  allocations: { paymentAllocationId: number; amount: number }[];
}

export const refundApi = {
  async create(paymentId: number, input: CreateRefundInput, idempotencyKey: string): Promise<PaymentRefund> {
    const res = await api.post(`/payments/${paymentId}/refunds`, input, { headers: { 'Idempotency-Key': idempotencyKey } });
    return res.data.data;
  },

  async confirm(refundId: number): Promise<PaymentRefund> {
    const res = await api.post(`/payments/refunds/${refundId}/confirm`);
    return res.data.data;
  },

  async void(refundId: number): Promise<PaymentRefund> {
    const res = await api.post(`/payments/refunds/${refundId}/void`);
    return res.data.data;
  },
};

// ─── Receivable API ───────────────────────────────────────────────────────────

export const receivableApi = {
  async summary(): Promise<ReceivableSummary> {
    const res = await api.get('/receivables/summary');
    return res.data.data;
  },

  async overdue(): Promise<OverdueInvoice[]> {
    const res = await api.get('/receivables/overdue');
    return res.data.data;
  },

  async byStudent(studentProfileId: number): Promise<StudentReceivableSummary> {
    const res = await api.get(`/receivables/student/${studentProfileId}`);
    return res.data.data;
  },
};
