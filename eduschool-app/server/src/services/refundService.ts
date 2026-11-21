import { Prisma, PrismaClient } from '@prisma/client';

import { logFinanceAction } from '../lib/auditLog';
import { recomputePaidAmount } from './paymentService';
import { reverseCreditsForIssuance } from './creditIssuanceService';
import { recomputeAndPersistPaidUntil } from '../lib/paidUntilDerivation';

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export async function createPaymentRefund(
  tx: PrismaTx,
  params: {
    schoolId: number;
    paymentId: number;
    reason: string;
    createdById: number;
    allocations: Array<{ paymentAllocationId: number; amount: string | number }>;
    idempotencyKey?: string;
  },
) {
  if (params.idempotencyKey) {
    const existing = await tx.paymentRefund.findFirst({
      where: { schoolId: params.schoolId, idempotencyKey: params.idempotencyKey },
      include: { allocations: true },
    });
    if (existing) return existing;
  }
  if (!params.reason.trim()) throw new Error('REFUND_REASON_REQUIRED');
  if (!Array.isArray(params.allocations) || params.allocations.length === 0) {
    throw new Error('REFUND_ALLOCATIONS_REQUIRED');
  }

  const payment = await tx.payment.findFirst({
    where: { id: params.paymentId, schoolId: params.schoolId },
    select: { id: true, status: true },
  });
  if (!payment) throw new Error('PAYMENT_NOT_FOUND');
  if (payment.status !== 'CONFIRMED') throw new Error('PAYMENT_NOT_CONFIRMED');

  const seen = new Set<number>();
  const normalized: Array<{ paymentAllocationId: number; amount: Prisma.Decimal }> = [];
  for (const allocation of params.allocations) {
    const paymentAllocationId = Number(allocation.paymentAllocationId);
    if (!Number.isInteger(paymentAllocationId) || paymentAllocationId <= 0) {
      throw new Error('REFUND_ALLOCATION_INVALID');
    }
    if (seen.has(paymentAllocationId)) throw new Error('REFUND_DUPLICATE_ALLOCATION');
    seen.add(paymentAllocationId);

    const amount = new Prisma.Decimal(String(allocation.amount));
    if (amount.lte(0)) throw new Error('REFUND_AMOUNT_MUST_BE_POSITIVE');
    normalized.push({ paymentAllocationId, amount });
  }

  // Acquire exclusive locks on all PaymentAllocation rows being refunded.
  // Two concurrent refund attempts on the same allocations serialize here:
  // the second blocks until the first commits, then reads the updated refund
  // totals — preventing over-refund beyond the original allocation amount.
  const lockIds = normalized.map(n => n.paymentAllocationId);
  await tx.$executeRaw(
    Prisma.sql`SELECT id FROM "PaymentAllocation" WHERE id IN (${Prisma.join(lockIds)}) FOR UPDATE`
  );

  for (const item of normalized) {
    const allocation = await tx.paymentAllocation.findFirst({
      where: {
        id: item.paymentAllocationId,
        paymentId: params.paymentId,
        payment: { schoolId: params.schoolId, status: 'CONFIRMED' },
      },
      select: { id: true, amount: true },
    });
    if (!allocation) throw new Error('REFUND_ALLOCATION_NOT_FOUND');

    // sumRefundedForAllocation runs inside the lock — no concurrent refund can sneak in
    const used = await sumRefundedForAllocation(tx, item.paymentAllocationId, ['PENDING', 'CONFIRMED']);
    const refundable = new Prisma.Decimal(allocation.amount).minus(used);
    if (item.amount.gt(refundable)) throw new Error('REFUND_EXCEEDS_REFUNDABLE_BALANCE');
  }

  const total = normalized.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
  const refund = await tx.paymentRefund.create({
    data: {
      schoolId: params.schoolId,
      paymentId: params.paymentId,
      amount: total,
      reason: params.reason,
      status: 'PENDING',
      createdById: params.createdById,
      idempotencyKey: params.idempotencyKey ?? null,
      allocations: {
        create: normalized.map(a => ({
          paymentAllocationId: a.paymentAllocationId,
          amount: a.amount,
        })),
      },
    },
    include: { allocations: true },
  });

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.createdById,
    action: 'PAYMENT_REFUND_CREATED',
    entityType: 'refund',
    entityId: refund.id,
    after: {
      paymentId: params.paymentId,
      amount: String(total),
      allocations: normalized.map(a => ({ paymentAllocationId: a.paymentAllocationId, amount: String(a.amount) })),
    },
  });

  return refund;
}

export async function confirmPaymentRefund(
  tx: PrismaTx,
  params: { schoolId: number; refundId: number; actorId: number },
) {
  const updated = await tx.paymentRefund.updateMany({
    where: { id: params.refundId, schoolId: params.schoolId, status: 'PENDING' },
    data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedById: params.actorId },
  });

  if (updated.count !== 1) {
    const existing = await tx.paymentRefund.findFirst({
      where: { id: params.refundId, schoolId: params.schoolId },
      select: { status: true },
    });
    if (!existing) throw new Error('REFUND_NOT_FOUND');
    if (existing.status === 'CONFIRMED') throw new Error('REFUND_ALREADY_CONFIRMED');
    if (existing.status === 'VOIDED') throw new Error('REFUND_ALREADY_VOIDED');
    throw new Error('REFUND_NOT_PENDING');
  }

  const refund = await tx.paymentRefund.findUniqueOrThrow({
    where: { id: params.refundId },
    include: {
      allocations: {
        include: {
          paymentAllocation: {
            select: { id: true, amount: true, invoiceId: true, paymentId: true },
          },
        },
      },
    },
  });

  for (const allocation of refund.allocations) {
    await reverseCreditsForRefundAllocation(tx, {
      refundId: refund.id,
      refundAllocationId: allocation.id,
      paymentAllocationId: allocation.paymentAllocationId,
      allocationAmount: new Prisma.Decimal(allocation.paymentAllocation.amount),
      paymentId: allocation.paymentAllocation.paymentId,
      schoolId: params.schoolId,
      actorId: params.actorId,
    });
  }

  const invoiceIds = [...new Set(refund.allocations.map(a => a.paymentAllocation.invoiceId))];
  for (const invoiceId of invoiceIds) {
    const { paidAmount, newStatus } = await recomputePaidAmount(tx, invoiceId);
    await tx.invoice.update({ where: { id: invoiceId }, data: { paidAmount, status: newStatus } });
  }

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.actorId,
    action: 'PAYMENT_REFUND_CONFIRMED',
    entityType: 'refund',
    entityId: refund.id,
    after: { paymentId: refund.paymentId, amount: String(refund.amount) },
  });

  return tx.paymentRefund.findUniqueOrThrow({ where: { id: refund.id }, include: { allocations: true } });
}

export async function voidPaymentRefund(
  tx: PrismaTx,
  params: { schoolId: number; refundId: number; actorId: number },
) {
  const refund = await tx.paymentRefund.findFirst({
    where: { id: params.refundId, schoolId: params.schoolId },
    include: {
      allocations: {
        include: { paymentAllocation: { select: { invoiceId: true } } },
      },
    },
  });
  if (!refund) throw new Error('REFUND_NOT_FOUND');
  if (refund.status === 'VOIDED') throw new Error('REFUND_ALREADY_VOIDED');

  await tx.paymentRefund.update({
    where: { id: refund.id },
    data: { status: 'VOIDED', voidedAt: new Date(), voidedById: params.actorId },
  });

  if (refund.status === 'CONFIRMED') {
    const refundAllocationIds = refund.allocations.map(a => a.id);
    const reversals = await tx.creditIssuanceReversal.findMany({
      where: { paymentRefundAllocationId: { in: refundAllocationIds }, voidedAt: null },
      include: { creditIssuance: true },
    });

    for (const reversal of reversals) {
      const voidLog = await tx.lessonCreditLog.create({
        data: {
          schoolId: params.schoolId,
          studentProfileId: reversal.creditIssuance.studentProfileId,
          amount: reversal.creditsReversed,
          type: 'CORRECTION',
          paymentId: refund.paymentId,
          reason: `Credit reversal voided for refund #${refund.id}`,
          actorId: params.actorId,
        },
      });

      await tx.studentProfile.update({
        where: { id: reversal.creditIssuance.studentProfileId },
        data: { credits: { increment: reversal.creditsReversed } },
      });

      await tx.creditIssuanceReversal.update({
        where: { id: reversal.id },
        data: { voidedAt: new Date(), voidedById: params.actorId, voidLogId: voidLog.id },
      });
    }

    // Credits were restored above (inline, not via creditIssuanceService) — refresh
    // the derived paidUntil for each affected student.
    const affectedStudentIds = [...new Set(reversals.map(r => r.creditIssuance.studentProfileId))];
    for (const sid of affectedStudentIds) {
      await recomputeAndPersistPaidUntil(tx, sid, params.schoolId);
    }

    await tx.financialAdjustment.updateMany({
      where: {
        paymentRefundId: refund.id,
        status: 'ACTIVE',
      },
      data: { status: 'VOIDED', voidedAt: new Date(), voidedById: params.actorId },
    });

    const issuanceIds = [...new Set(reversals.map(r => r.creditIssuanceId))];
    for (const issuanceId of issuanceIds) {
      await refreshCreditIssuanceReversalState(tx, issuanceId);
    }
  }

  const invoiceIds = [...new Set(refund.allocations.map(a => a.paymentAllocation.invoiceId))];
  for (const invoiceId of invoiceIds) {
    const { paidAmount, newStatus } = await recomputePaidAmount(tx, invoiceId);
    await tx.invoice.update({ where: { id: invoiceId }, data: { paidAmount, status: newStatus } });
  }

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.actorId,
    action: 'PAYMENT_REFUND_VOIDED',
    entityType: 'refund',
    entityId: refund.id,
    before: { status: refund.status },
    after: { status: 'VOIDED' },
  });

  return tx.paymentRefund.findUniqueOrThrow({ where: { id: refund.id }, include: { allocations: true } });
}

async function reverseCreditsForRefundAllocation(
  tx: PrismaTx,
  params: {
    refundId: number;
    refundAllocationId: number;
    paymentAllocationId: number;
    allocationAmount: Prisma.Decimal;
    paymentId: number;
    schoolId: number;
    actorId: number;
  },
) {
  const issuances = await tx.creditIssuance.findMany({
    where: { paymentAllocationId: params.paymentAllocationId, schoolId: params.schoolId },
  });
  if (issuances.length === 0) return;

  const totalRefunded = await sumRefundedForAllocation(tx, params.paymentAllocationId, ['CONFIRMED']);

  for (const issuance of issuances) {
    const alreadyAccounted = await sumAccountedForIssuance(tx, issuance.id);
    const target = totalRefunded.gte(params.allocationAmount)
      ? issuance.creditsIssued
      : Math.floor(totalRefunded.mul(issuance.creditsIssued).div(params.allocationAmount).toNumber());
    const toReverse = target - alreadyAccounted;
    if (toReverse <= 0) continue;

    const result = await reverseCreditsForIssuance(tx, {
      creditIssuanceId: issuance.id,
      creditsToReverse: toReverse,
      schoolId: params.schoolId,
      actorId: params.actorId,
      paymentId: params.paymentId,
      reason: `Credit issuance reversed: payment refund #${params.refundId}`,
      paymentRefundAllocationId: params.refundAllocationId,
      paymentRefundId: params.refundId,
      auditEntityId: params.refundId,
    });

    await logFinanceAction({
      client: tx as unknown as PrismaClient,
      schoolId: params.schoolId,
      userId: params.actorId,
      action: 'CREDIT_REVERSAL_CREATED',
      entityType: 'refund',
      entityId: params.refundId,
      after: {
        issuanceId: issuance.id,
        paymentAllocationId: params.paymentAllocationId,
        refundAllocationId: params.refundAllocationId,
        creditsRequested: toReverse,
        creditsReversed: result.creditsReversed,
        debtCredits: result.debtCredits,
      },
    });
  }
}

async function sumRefundedForAllocation(
  tx: PrismaTx,
  paymentAllocationId: number,
  statuses: Array<'PENDING' | 'CONFIRMED' | 'VOIDED'>,
): Promise<Prisma.Decimal> {
  const rows = await tx.paymentRefundAllocation.findMany({
    where: { paymentAllocationId, refund: { status: { in: statuses } } },
    select: { amount: true },
  });
  return rows.reduce((sum, r) => sum.plus(r.amount), new Prisma.Decimal(0));
}

async function sumAccountedForIssuance(tx: PrismaTx, creditIssuanceId: number): Promise<number> {
  const reversals = await tx.creditIssuanceReversal.findMany({
    where: { creditIssuanceId, voidedAt: null },
    select: { creditsReversed: true },
  });
  const reversalTotal = reversals.reduce((sum, r) => sum + r.creditsReversed, 0);

  const debts = await tx.financialAdjustment.findMany({
    where: { creditIssuanceId, type: 'BALANCE_DEBT', status: 'ACTIVE' },
    select: { amountCredits: true },
  });
  const debtTotal = debts.reduce((sum, d) => sum + (d.amountCredits ?? 0), 0);
  return reversalTotal + debtTotal;
}

async function refreshCreditIssuanceReversalState(tx: PrismaTx, creditIssuanceId: number): Promise<void> {
  const issuance = await tx.creditIssuance.findUniqueOrThrow({ where: { id: creditIssuanceId } });
  const accounted = await sumAccountedForIssuance(tx, creditIssuanceId);
  if (accounted < issuance.creditsIssued && issuance.reversedAt != null) {
    await tx.creditIssuance.update({
      where: { id: creditIssuanceId },
      data: { reversedAt: null, reversedById: null, reversalLogId: null },
    });
  }
}
