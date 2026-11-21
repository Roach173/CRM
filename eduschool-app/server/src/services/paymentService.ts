import { Prisma, PaymentMethod, InvoiceStatus, PrismaClient } from '@prisma/client';
import { logFinanceAction } from '../lib/auditLog';
import { issueCreditsForAllocation, reverseIssuancesForPayment } from './creditIssuanceService';

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// ─── Internal: recompute paidAmount from net confirmed allocation flow ─────────
// Source of truth =
//   SUM(PaymentAllocation.amount WHERE payment.status=CONFIRMED)
//   - SUM(PaymentRefundAllocation.amount WHERE refund.status=CONFIRMED)
// Voided payment allocations and voided refunds remain in history but are
// excluded from balance.

export async function recomputePaidAmount(
  tx: PrismaTx,
  invoiceId: number,
): Promise<{ paidAmount: Prisma.Decimal; newStatus: InvoiceStatus }> {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where:  { id: invoiceId },
    select: { totalAmount: true, status: true },
  });

  // findMany + reduce — avoids any float conversion, guaranteed Decimal arithmetic
  const confirmedAllocs = await tx.paymentAllocation.findMany({
    where:  { invoiceId, payment: { status: 'CONFIRMED' } },
    select: { amount: true },
  });
  const grossPaid = confirmedAllocs.reduce(
    (sum, a) => sum.plus(a.amount),
    new Prisma.Decimal(0),
  );
  const confirmedRefundAllocs = await tx.paymentRefundAllocation.findMany({
    where: {
      paymentAllocation: { invoiceId },
      refund: { status: 'CONFIRMED' },
    },
    select: { amount: true },
  });
  const refunded = confirmedRefundAllocs.reduce(
    (sum, r) => sum.plus(r.amount),
    new Prisma.Decimal(0),
  );
  const paidAmount = Prisma.Decimal.max(grossPaid.minus(refunded), new Prisma.Decimal(0));

  let newStatus: InvoiceStatus = invoice.status;
  if (invoice.status !== 'VOID' && invoice.status !== 'DRAFT') {
    const total = new Prisma.Decimal(invoice.totalAmount);
    if (total.gt(0) && paidAmount.gte(total)) {
      newStatus = 'PAID';
    } else if (paidAmount.gt(new Prisma.Decimal(0))) {
      newStatus = 'PARTIALLY_PAID';
    } else if (invoice.status === 'PAID' || invoice.status === 'PARTIALLY_PAID') {
      // All confirmed allocations were voided — revert to ISSUED
      newStatus = 'ISSUED';
    }
    // ISSUED / OVERDUE with zero paid amount → keep current status
  }

  return { paidAmount, newStatus };
}

// ─── createPayment ────────────────────────────────────────────────────────────

export async function createPayment(
  tx: PrismaTx,
  params: {
    schoolId: number;
    studentProfileId: number;
    amount: string | number;
    method: PaymentMethod;
    receivedById: number;
    note?: string;
    paidAt?: Date;
    idempotencyKey?: string;
  },
) {
  const amt = new Prisma.Decimal(String(params.amount));
  if (amt.lte(new Prisma.Decimal(0))) throw new Error('PAYMENT_AMOUNT_MUST_BE_POSITIVE');

  // Tenant isolation
  const profile = await tx.studentProfile.findFirst({
    where:  { id: params.studentProfileId, user: { schoolId: params.schoolId }, deletedAt: null },
    select: { id: true },
  });
  if (!profile) throw new Error('STUDENT_NOT_FOUND');

  const payment = await tx.payment.create({
    data: {
      schoolId:         params.schoolId,
      studentProfileId: params.studentProfileId,
      amount:           amt,
      method:           params.method,
      status:           'CONFIRMED',
      receivedById:     params.receivedById,
      note:             params.note,
      paidAt:           params.paidAt ?? new Date(),
      idempotencyKey:   params.idempotencyKey,
    },
  });

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.receivedById,
    action: 'PAYMENT_CREATED',
    entityType: 'payment',
    entityId: payment.id,
    after: { amount: String(amt), method: params.method, studentProfileId: params.studentProfileId },
  });

  return payment;
}

// ─── createAllocation ────────────────────────────────────────────────────────

export async function createAllocation(
  tx: PrismaTx,
  params: {
    paymentId: number;
    invoiceId: number;
    amount: string | number;
    schoolId: number;
    actorId: number;
  },
) {
  const allocAmt = new Prisma.Decimal(String(params.amount));
  if (allocAmt.lte(new Prisma.Decimal(0))) throw new Error('ALLOCATION_AMOUNT_MUST_BE_POSITIVE');

  // Payment must be CONFIRMED and belong to this school
  const payment = await tx.payment.findFirst({
    where:  { id: params.paymentId, schoolId: params.schoolId, status: 'CONFIRMED' },
    select: { id: true },
  });
  if (!payment) throw new Error('PAYMENT_NOT_FOUND_OR_NOT_CONFIRMED');

  // Acquire exclusive lock on the Invoice row BEFORE reading balance.
  // Two concurrent allocations to the same invoice will serialize here:
  // the second transaction blocks until the first commits, then reads the
  // already-updated remaining balance — preventing double-allocation overpay.
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${params.invoiceId} FOR UPDATE`;

  // Read invoice state INSIDE the lock (now race-safe)
  const invoice = await tx.invoice.findFirst({
    where:  { id: params.invoiceId, schoolId: params.schoolId },
    select: { id: true, status: true, totalAmount: true, studentProfileId: true },
  });
  if (!invoice)                    throw new Error('INVOICE_NOT_FOUND');
  if (invoice.status === 'VOID')   throw new Error('INVOICE_IS_VOID');
  if (invoice.status === 'PAID')   throw new Error('INVOICE_ALREADY_PAID');
  if (invoice.status === 'DRAFT')  throw new Error('INVOICE_NOT_ISSUED');

  // Overpayment guard: computed inside the lock — no concurrent write can sneak in
  const existingAllocs = await tx.paymentAllocation.findMany({
    where:  { invoiceId: params.invoiceId, payment: { status: 'CONFIRMED' } },
    select: { amount: true },
  });
  const grossExisting = existingAllocs.reduce(
    (sum, a) => sum.plus(a.amount),
    new Prisma.Decimal(0),
  );
  const existingRefunds = await tx.paymentRefundAllocation.findMany({
    where: {
      paymentAllocation: { invoiceId: params.invoiceId },
      refund: { status: 'CONFIRMED' },
    },
    select: { amount: true },
  });
  const refundedExisting = existingRefunds.reduce(
    (sum, r) => sum.plus(r.amount),
    new Prisma.Decimal(0),
  );
  const existingNet = Prisma.Decimal.max(grossExisting.minus(refundedExisting), new Prisma.Decimal(0));
  const remaining = new Prisma.Decimal(invoice.totalAmount).minus(existingNet);
  if (allocAmt.gt(remaining)) throw new Error('ALLOCATION_EXCEEDS_INVOICE_BALANCE');

  // Create allocation — unique constraint (paymentId, invoiceId) prevents double-allocation
  let allocation;
  try {
    allocation = await tx.paymentAllocation.create({
      data: { paymentId: params.paymentId, invoiceId: params.invoiceId, amount: allocAmt },
    });
  } catch (e: any) {
    if (e.code === 'P2002') throw new Error('ALLOCATION_ALREADY_EXISTS');
    throw e;
  }

  // Update invoice.paidAmount and status — always derived from allocations, never manual
  const { paidAmount, newStatus } = await recomputePaidAmount(tx, params.invoiceId);
  await tx.invoice.update({
    where: { id: params.invoiceId },
    data:  { paidAmount, status: newStatus },
  });

  // Phase 7.2: issue credits for TUITION lines where creditsToIssue is set
  await issueCreditsForAllocation(tx, {
    paymentAllocationId: allocation.id,
    invoiceId:           params.invoiceId,
    newInvoiceStatus:    newStatus,
    schoolId:            params.schoolId,
    studentProfileId:    invoice.studentProfileId,
    actorId:             params.actorId,
  });

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.actorId,
    action: 'PAYMENT_ALLOCATED',
    entityType: 'allocation',
    entityId: allocation.id,
    after: { paymentId: params.paymentId, invoiceId: params.invoiceId, amount: String(allocAmt), invoiceStatus: newStatus },
  });

  return allocation;
}

// ─── voidPayment ─────────────────────────────────────────────────────────────

export async function voidPayment(
  tx: PrismaTx,
  params: { paymentId: number; schoolId: number; actorId: number },
) {
  const payment = await tx.payment.findFirst({
    where: { id: params.paymentId, schoolId: params.schoolId },
  });
  if (!payment)                        throw new Error('PAYMENT_NOT_FOUND');
  if (payment.status !== 'CONFIRMED')  throw new Error('PAYMENT_NOT_CONFIRMED');

  // Mark VOIDED — allocations are NOT deleted, they stay as immutable audit trail
  const voided = await tx.payment.update({
    where: { id: params.paymentId },
    data:  { status: 'VOIDED', voidedAt: new Date(), voidedById: params.actorId },
  });

  // Recompute paidAmount on every invoice this payment touched
  const affected = await tx.paymentAllocation.findMany({
    where:  { paymentId: params.paymentId },
    select: { invoiceId: true },
  });
  for (const { invoiceId } of affected) {
    const { paidAmount, newStatus } = await recomputePaidAmount(tx, invoiceId);
    await tx.invoice.update({
      where: { id: invoiceId },
      data:  { paidAmount, status: newStatus },
    });
  }

  // Phase 7.2: reverse any credit issuances linked to this payment's allocations
  await reverseIssuancesForPayment(tx, {
    paymentId: params.paymentId,
    schoolId:  params.schoolId,
    actorId:   params.actorId,
  });

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.actorId,
    action: 'PAYMENT_VOIDED',
    entityType: 'payment',
    entityId: params.paymentId,
    before: { status: 'CONFIRMED', amount: String(payment.amount) },
    after:  { status: 'VOIDED' },
  });

  return voided;
}
