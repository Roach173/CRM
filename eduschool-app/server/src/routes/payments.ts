import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { validateBody } from '../middleware/validate';
import { dbIdempotency } from '../middleware/dbIdempotency';
import { withSerializableRetry } from '../lib/serializableRetry';
import { createPayment, createAllocation, voidPayment } from '../services/paymentService';
import { createPaymentRefund, confirmPaymentRefund, voidPaymentRefund } from '../services/refundService';
import { createLogger } from '../lib/logger';
import { sendLifecycleError } from '../lib/routeError';
import { Role, PaymentMethod } from '@prisma/client';
import * as notificationService from '../services/notificationService';

const log = createLogger('payments');
const router = Router();

const positiveNumeric = z.union([z.number(), z.string()])
  .refine(v => Number.isFinite(Number(v)) && Number(v) > 0, 'must be a positive number');

const createPaymentSchema = z.object({
  studentProfileId: positiveNumeric,
  amount: positiveNumeric,
  method: z.nativeEnum(PaymentMethod),
  note: z.string().trim().max(1000).optional(),
  paidAt: z.string().refine(v => !Number.isNaN(Date.parse(v)), 'paidAt must be a valid date').optional(),
  allocations: z.array(z.object({
    invoiceId: positiveNumeric,
    amount: positiveNumeric,
  })).optional(),
});

// ─── POST / — create payment + optional inline allocations ───────────────────
// Idempotency-Key required: prevents duplicate Payment rows on network retry.
// withSerializableRetry: handles deadlocks from concurrent inline allocations
// that each acquire SELECT FOR UPDATE on Invoice rows.
router.post(
  '/',
  authenticate,
  dbIdempotency({ required: true }),
  requirePermission('finance:write'),
  validateBody(createPaymentSchema),
  async (req: AuthRequest, res) => {
    try {
      const schoolId = req.user!.schoolId;
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
      const { studentProfileId, amount, method, note, paidAt, allocations } = req.body;

      const result = await withSerializableRetry(() =>
        prisma.$transaction(async (tx) => {
          if (idempotencyKey) {
            const existingPayment = await tx.payment.findUnique({
              where: { schoolId_idempotencyKey: { schoolId, idempotencyKey } },
              include: {
                allocations: {
                  include: {
                    invoice: { select: { id: true, totalAmount: true, paidAmount: true, status: true, dueDate: true } },
                  },
                },
              },
            });
            if (existingPayment) {
              return { payment: existingPayment, allocations: existingPayment.allocations, isReplay: true };
            }
          }

          const payment = await createPayment(tx, {
            schoolId,
            studentProfileId: parseInt(studentProfileId, 10),
            amount:           String(amount),
            method,
            receivedById:     req.user!.userId,
            note,
            paidAt:           paidAt ? new Date(paidAt) : undefined,
            idempotencyKey,
          });

          const createdAllocations = [];
          if (Array.isArray(allocations) && allocations.length > 0) {
            for (const a of allocations) {
              const alloc = await createAllocation(tx, {
                paymentId: payment.id,
                invoiceId: parseInt(a.invoiceId, 10),
                amount:    String(a.amount),
                schoolId,
                actorId:   req.user!.userId,
              });
              createdAllocations.push(alloc);
            }
          }

          return { payment, allocations: createdAllocations };
        })
      );

      // FINAL PATCH 3: completeIdempotency called only after transaction commits.
      const body = { success: true, data: result };
      await req.completeIdempotency?.(201, body);

      // After transaction and idempotency completion succeed, we notify school admins
      try {
        const school = await prisma.school.findUnique({
          where: { id: schoolId },
          select: { slug: true }
        });
        const schoolSlug = school?.slug || '';

        const student = await prisma.user.findFirst({
          where: { studentProfile: { id: result.payment.studentProfileId } },
          select: { firstName: true, lastName: true }
        });
        const studentName = student ? `${student.firstName} ${student.lastName}`.trim() : 'Ученик';
        const amountNum = Number(result.payment.amount);
        const isHighPriority = amountNum >= 10000;

        const payload = {
          schoolId,
          type: 'PAYMENT_CREATED',
          title: 'Получена оплата',
          body: `Сумма: ${amountNum} KGS от ${studentName}.`,
          category: 'FINANCE' as const,
          priority: isHighPriority ? ('HIGH' as const) : ('NORMAL' as const),
          entityType: 'Payment',
          entityId: result.payment.id,
          data: {
            studentName,
            amount: amountNum,
            method: result.payment.method
          }
        };

        await notificationService.createForRole({
          ...payload,
          role: Role.OWNER,
          actionUrl: `/${schoolSlug}/owner/finance`
        });

        await notificationService.createForRole({
          ...payload,
          role: Role.ADMIN,
          actionUrl: `/${schoolSlug}/admin/finance`
        });
      } catch (err) {
        log.error({ err }, 'Failed to create payment created notifications');
      }

      return res.status(201).json(body);
    } catch (err: any) {
      log.error({ err }, 'payments POST / error');
      await req.failIdempotency?.();
      if (err.message === 'STUDENT_NOT_FOUND')
        return res.status(404).json({ success: false, error: 'Student not found' });
      if (err.message === 'PAYMENT_AMOUNT_MUST_BE_POSITIVE')
        return res.status(400).json({ success: false, error: 'Payment amount must be positive' });
      if (err.message === 'INVOICE_NOT_FOUND')
        return res.status(404).json({ success: false, error: 'Invoice not found' });
      if (err.message === 'INVOICE_IS_VOID')
        return res.status(409).json({ success: false, error: 'Invoice is void' });
      if (err.message === 'INVOICE_NOT_ISSUED')
        return res.status(409).json({ success: false, error: 'Invoice must be ISSUED before allocation' });
      if (err.message === 'ALLOCATION_EXCEEDS_INVOICE_BALANCE')
        return res.status(422).json({ success: false, error: 'Allocation exceeds invoice remaining balance' });
      if (err.message === 'ALLOCATION_ALREADY_EXISTS')
        return res.status(409).json({ success: false, error: 'This payment is already allocated to that invoice' });
      return sendLifecycleError(res, err, 'Failed to create payment');
    }
  }
);

// ─── GET / — paginated list for this school ──────────────────────────────────
router.get('/', authenticate, requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const { studentProfileId, status, page = '1', limit = '50', includeCredits } = req.query;

    const pageNum  = Math.max(1, parseInt(String(page), 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10)));

    const where: Record<string, unknown> = { schoolId };
    if (studentProfileId) where.studentProfileId = parseInt(String(studentProfileId), 10);
    if (status)           where.status           = String(status);

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { paidAt: 'desc' },
        skip:    (pageNum - 1) * limitNum,
        take:    limitNum,
        include: {
          studentProfile: { include: { user: { select: { firstName: true, lastName: true } } } },
          receivedBy:     { select: { firstName: true, lastName: true } },
          refundEvents:   { select: { id: true, amount: true, status: true, createdAt: true, confirmedAt: true } },
          _count:         { select: { allocations: true } },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    // Tag real payments so the client can distinguish them from credit top-ups.
    const taggedPayments = payments.map((p) => ({ ...p, source: 'PAYMENT' as const }));

    // ── Optional: merge in credit top-ups (StudentPayment) as income ──
    // The finance dashboard requests this so money entered via the quick-payment
    // flow (which writes StudentPayment, not Payment) is surfaced as income.
    // Top-ups are mapped to a Payment-shaped object with source CREDIT_TOPUP;
    // a cancelled top-up surfaces as VOIDED so it drops out of income totals.
    // user.id is included so the client can call the cancel route (keyed by user id).
    if (includeCredits === 'true' && !status) {
      const creditWhere: Record<string, unknown> = { schoolId };
      if (studentProfileId) creditWhere.studentProfileId = parseInt(String(studentProfileId), 10);

      const [topups, topupTotal] = await Promise.all([
        prisma.studentPayment.findMany({
          where:   creditWhere,
          orderBy: { createdAt: 'desc' },
          take:    limitNum,
          include: {
            studentProfile: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
            createdBy:      { select: { firstName: true, lastName: true } },
          },
        }),
        prisma.studentPayment.count({ where: creditWhere }),
      ]);

      const mappedTopups = topups.map((t) => ({
        id:               t.id,
        schoolId:         t.schoolId,
        studentProfileId: t.studentProfileId,
        amount:           t.amount,
        method:           t.method,
        status:           t.cancelledAt ? ('VOIDED' as const) : ('CONFIRMED' as const),
        paidAt:           t.createdAt,
        note:             t.note,
        voidedAt:         t.cancelledAt,
        createdAt:        t.createdAt,
        studentProfile:   t.studentProfile,
        receivedBy:       t.createdBy ?? undefined,
        source:           'CREDIT_TOPUP' as const,
      }));

      const merged = [...taggedPayments, ...mappedTopups]
        .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
        .slice(0, limitNum);

      const combinedTotal = total + topupTotal;
      return res.json({
        success: true,
        data: merged,
        meta: { total: combinedTotal, page: pageNum, limit: limitNum, pages: Math.ceil(combinedTotal / limitNum) },
      });
    }

    return res.json({
      success: true,
      data: taggedPayments,
      meta: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (err: any) {
    log.error({ err }, 'payments GET / error');
    return res.status(500).json({ success: false, error: 'Failed to fetch payments' });
  }
});

// ─── GET /:id — single payment with allocations ───────────────────────────────
router.get('/:id', authenticate, requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const id       = parseInt(req.params.id, 10);

    const payment = await prisma.payment.findFirst({
      where:   { id, schoolId },
      include: {
        allocations: {
          include: {
            invoice: {
              select: { id: true, totalAmount: true, paidAmount: true, status: true, dueDate: true },
            },
          },
        },
        studentProfile: {
          include: { user: { select: { firstName: true, lastName: true, email: true } } },
        },
        receivedBy:  { select: { firstName: true, lastName: true } },
        voidedBy:    { select: { firstName: true, lastName: true } },
        refundEvents: {
          include: {
            allocations: {
              include: {
                paymentAllocation: { select: { id: true, invoiceId: true, amount: true } },
              },
            },
          },
        },
      },
    });

    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    return res.json({ success: true, data: payment });
  } catch (err: any) {
    log.error({ err }, 'payments GET /:id error');
    return res.status(500).json({ success: false, error: 'Failed to fetch payment' });
  }
});

// ─── PATCH /:id/note — set/replace the payment's comment ─────────────────────
// Note is display-only metadata (no financial impact), so a plain update — no
// transaction, no idempotency. Allowed on any status (annotating a voided
// payment with the cancellation reason is a valid use).
router.patch('/:id/note', authenticate, requirePermission('finance:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const id       = parseInt(req.params.id, 10);
    const raw      = req.body?.note;

    if (raw != null && typeof raw !== 'string') {
      return res.status(400).json({ success: false, error: 'note must be a string or null' });
    }
    const note = raw?.trim() ? raw.trim().slice(0, 500) : null;

    const { count } = await prisma.payment.updateMany({ where: { id, schoolId }, data: { note } });
    if (count === 0) return res.status(404).json({ success: false, error: 'Payment not found' });
    return res.json({ success: true, data: { id, note } });
  } catch (err: any) {
    log.error({ err }, 'payments PATCH /:id/note error');
    return res.status(500).json({ success: false, error: 'Failed to update note' });
  }
});

// ─── POST /:id/void — void a confirmed payment ────────────────────────────────
router.post('/:id/void', authenticate, requirePermission('finance:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const id       = parseInt(req.params.id, 10);

    const result = await prisma.$transaction((tx) =>
      voidPayment(tx, { paymentId: id, schoolId, actorId: req.user!.userId }),
    );

    return res.json({ success: true, data: result });
  } catch (err: any) {
    log.error({ err }, 'payments POST /:id/void error');
    if (err.message === 'PAYMENT_NOT_FOUND')
      return res.status(404).json({ success: false, error: 'Payment not found' });
    if (err.message === 'PAYMENT_NOT_CONFIRMED')
      return res.status(409).json({ success: false, error: 'Only CONFIRMED payments can be voided' });
    return sendLifecycleError(res, err, 'Failed to void payment');
  }
});

// ─── POST /:id/refunds — create allocation-aware refund draft ─────────────────
// Idempotency-Key required: prevents duplicate PaymentRefund on network retry.
// withSerializableRetry: handles deadlocks on SELECT FOR UPDATE of allocations.
router.post(
  '/:id/refunds',
  authenticate,
  dbIdempotency({ required: true }),
  requirePermission('finance:write'),
  async (req: AuthRequest, res) => {
    try {
      const schoolId  = req.user!.schoolId;
      const paymentId = parseInt(req.params.id, 10);
      const { reason, allocations } = req.body;
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim();

      if (idempotencyKey) {
        const existing = await prisma.paymentRefund.findFirst({
          where: { schoolId, idempotencyKey },
          include: { allocations: true },
        });
        if (existing) {
          const body = { success: true, data: existing };
          await req.completeIdempotency?.(201, body);
          return res.status(201).json(body);
        }
      }

      const result = await withSerializableRetry(() =>
        prisma.$transaction((tx) =>
          createPaymentRefund(tx, {
            schoolId,
            paymentId,
            reason:      String(reason ?? ''),
            createdById: req.user!.userId,
            allocations,
            idempotencyKey,
          })
        )
      );

      const body = { success: true, data: result };
      await req.completeIdempotency?.(201, body);
      return res.status(201).json(body);
    } catch (err: any) {
      log.error({ err }, 'payments POST /:id/refunds error');
      await req.failIdempotency?.();
      if (err.message === 'PAYMENT_NOT_FOUND')
        return res.status(404).json({ success: false, error: 'Payment not found' });
      if (err.message === 'PAYMENT_NOT_CONFIRMED')
        return res.status(409).json({ success: false, error: 'Only CONFIRMED payments can be refunded' });
      if (err.message === 'REFUND_EXCEEDS_REFUNDABLE_BALANCE')
        return res.status(422).json({ success: false, error: 'Refund exceeds refundable allocation balance' });
      if (err.message?.startsWith('REFUND_'))
        return res.status(400).json({ success: false, error: err.message });
      return sendLifecycleError(res, err, 'Failed to create refund');
    }
  }
);

// ─── POST /refunds/:refundId/confirm ─────────────────────────────────────────
router.post('/refunds/:refundId/confirm', authenticate, requirePermission('finance:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId  = req.user!.schoolId;
    const refundId  = parseInt(req.params.refundId, 10);

    const result = await prisma.$transaction((tx) =>
      confirmPaymentRefund(tx, { schoolId, refundId, actorId: req.user!.userId }),
    );

    return res.json({ success: true, data: result });
  } catch (err: any) {
    log.error({ err }, 'payments refund confirm error');
    if (err.message === 'REFUND_NOT_FOUND')
      return res.status(404).json({ success: false, error: 'Refund not found' });
    if (err.message === 'REFUND_ALREADY_CONFIRMED' || err.message === 'REFUND_ALREADY_VOIDED')
      return res.status(409).json({ success: false, error: err.message });
    return sendLifecycleError(res, err, 'Failed to confirm refund');
  }
});

// ─── POST /refunds/:refundId/void ────────────────────────────────────────────
router.post('/refunds/:refundId/void', authenticate, requirePermission('finance:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId  = req.user!.schoolId;
    const refundId  = parseInt(req.params.refundId, 10);

    const result = await prisma.$transaction((tx) =>
      voidPaymentRefund(tx, { schoolId, refundId, actorId: req.user!.userId }),
    );

    return res.json({ success: true, data: result });
  } catch (err: any) {
    log.error({ err }, 'payments refund void error');
    if (err.message === 'REFUND_NOT_FOUND')
      return res.status(404).json({ success: false, error: 'Refund not found' });
    if (err.message === 'REFUND_ALREADY_VOIDED')
      return res.status(409).json({ success: false, error: 'Refund already voided' });
    return sendLifecycleError(res, err, 'Failed to void refund');
  }
});

// ─── POST /:id/allocate — allocate existing payment to invoice ────────────────
// Idempotency-Key required: prevents duplicate PaymentAllocation on network retry.
router.post(
  '/:id/allocate',
  authenticate,
  dbIdempotency({ required: true }),
  requirePermission('finance:write'),
  async (req: AuthRequest, res) => {
    try {
      const schoolId  = req.user!.schoolId;
      const paymentId = parseInt(req.params.id, 10);
      const { invoiceId, amount } = req.body;

      if (!invoiceId || amount == null) {
        return res.status(400).json({ success: false, error: 'invoiceId and amount are required' });
      }

      const result = await withSerializableRetry(() =>
        prisma.$transaction((tx) =>
          createAllocation(tx, {
            paymentId,
            invoiceId: parseInt(invoiceId, 10),
            amount:    String(amount),
            schoolId,
            actorId:   req.user!.userId,
          })
        )
      );

      const body = { success: true, data: result };
      await req.completeIdempotency?.(201, body);
      return res.status(201).json(body);
    } catch (err: any) {
      log.error({ err }, 'payments POST /:id/allocate error');
      await req.failIdempotency?.();
      if (err.message === 'PAYMENT_NOT_FOUND_OR_NOT_CONFIRMED')
        return res.status(404).json({ success: false, error: 'Payment not found or not confirmed' });
      if (err.message === 'INVOICE_NOT_FOUND')
        return res.status(404).json({ success: false, error: 'Invoice not found' });
      if (err.message === 'INVOICE_IS_VOID')
        return res.status(409).json({ success: false, error: 'Invoice is void' });
      if (err.message === 'INVOICE_ALREADY_PAID')
        return res.status(409).json({ success: false, error: 'Invoice is already fully paid' });
      if (err.message === 'INVOICE_NOT_ISSUED')
        return res.status(409).json({ success: false, error: 'Invoice must be ISSUED before allocation' });
      if (err.message === 'ALLOCATION_EXCEEDS_INVOICE_BALANCE')
        return res.status(422).json({ success: false, error: 'Allocation exceeds invoice remaining balance' });
      if (err.message === 'ALLOCATION_ALREADY_EXISTS')
        return res.status(409).json({ success: false, error: 'This payment is already allocated to that invoice' });
      return sendLifecycleError(res, err, 'Failed to create allocation');
    }
  }
);

export default router;
