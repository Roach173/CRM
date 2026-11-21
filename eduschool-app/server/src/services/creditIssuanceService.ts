import { Prisma, PrismaClient } from '@prisma/client';
import { logFinanceAction } from '../lib/auditLog';
import { recomputeAndPersistPaidUntil } from '../lib/paidUntilDerivation';

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// ─── issueCreditsForAllocation ────────────────────────────────────────────────
// Called after createAllocation succeeds. For each TUITION InvoiceLine with
// creditsToIssue != null, issues proportional credits (floor-based).
// When newInvoiceStatus === 'PAID', reconciles the remainder to guarantee
// SUM(issued) === creditsToIssue across all partial payments.
//
// Write chain invariant (one TX enforced by caller):
//   CreditIssuance → LessonCreditLog → StudentProfile.credits

export async function issueCreditsForAllocation(
  tx: PrismaTx,
  params: {
    paymentAllocationId: number;
    invoiceId: number;
    newInvoiceStatus: string;
    schoolId: number;
    studentProfileId: number;
    actorId: number;
  },
): Promise<void> {
  const { paymentAllocationId, invoiceId, newInvoiceStatus, schoolId, studentProfileId, actorId } = params;

  // Load invoice + TUITION lines with creditsToIssue defined
  const invoice = await tx.invoice.findFirst({
    where:   { id: invoiceId, schoolId },
    select:  { totalAmount: true },
  });
  if (!invoice) return;

  const tuitionLines = await tx.invoiceLine.findMany({
    where: {
      invoiceId,
      type: 'TUITION',
      creditsToIssue: { not: null },
    },
    select: { id: true, creditsToIssue: true },
  });
  if (tuitionLines.length === 0) return;

  // Load this allocation's amount
  const allocation = await tx.paymentAllocation.findFirst({
    where:  { id: paymentAllocationId },
    select: { amount: true },
  });
  if (!allocation) return;

  const invoiceTotal = new Prisma.Decimal(invoice.totalAmount);
  if (invoiceTotal.lte(0)) return;

  for (const line of tuitionLines) {
    const creditsToIssue = line.creditsToIssue!;

    // ── Step 1: Calculate this allocation's share ─────────────────────────
    let actual: number;
    if (newInvoiceStatus === 'PAID') {
      // Reconcile: issue remaining credits so SUM === creditsToIssue
      const alreadyIssued = await sumActiveIssuedCredits(tx, line.id);
      actual = creditsToIssue - alreadyIssued;
    } else {
      // Proportional floor — never over-issues on partial payments
      const allocAmt = new Prisma.Decimal(allocation.amount);
      actual = Math.floor(
        allocAmt.mul(creditsToIssue).div(invoiceTotal).toNumber(),
      );
    }

    // ── Step 2: Zero-noise rule ───────────────────────────────────────────
    if (actual <= 0) continue;

    // ── Step 3: Idempotency pre-check ─────────────────────────────────────
    const existing = await tx.creditIssuance.findFirst({
      where: { paymentAllocationId, invoiceLineId: line.id },
    });
    if (existing) continue;

    // ── Step 4: Safety clamp — re-read alreadyIssued inside same TX ───────
    const alreadyIssuedNow = await sumActiveIssuedCredits(tx, line.id);
    const allowable = creditsToIssue - alreadyIssuedNow;
    actual = Math.min(actual, allowable);
    if (actual <= 0) continue;

    // ── Step 5: Write chain ───────────────────────────────────────────────
    const allocPayment = await tx.paymentAllocation.findFirst({
      where:  { id: paymentAllocationId },
      select: { paymentId: true },
    });

    const log = await tx.lessonCreditLog.create({
      data: {
        studentProfileId,
        schoolId,
        amount:    actual,
        type:      'PAYMENT',
        paymentId: allocPayment!.paymentId,
        reason:    `Invoice #${invoiceId} TUITION payment credit issuance`,
        actorId,
      },
    });

    await tx.creditIssuance.create({
      data: {
        schoolId,
        paymentAllocationId,
        invoiceLineId:   line.id,
        studentProfileId,
        creditsIssued:   actual,
        lessonCreditLogId: log.id,
        issuedById:      actorId,
      },
    });

    await tx.studentProfile.update({
      where: { id: studentProfileId },
      data:  { credits: { increment: actual } },
    });

    await logFinanceAction({
      client:     tx as unknown as PrismaClient,
      schoolId,
      userId:     actorId,
      action:     'CREDITS_ISSUED_FROM_PAYMENT',
      entityType: 'allocation',
      entityId:   paymentAllocationId,
      after:      { creditsIssued: actual, lineId: line.id, invoiceId },
    });
  }

  // Balance changed → re-derive the display-only paidUntil from the new balance.
  await recomputeAndPersistPaidUntil(tx, studentProfileId, schoolId);
}

// ─── reverseIssuancesForPayment ───────────────────────────────────────────────
// Called when a payment is voided. Reverses all non-reversed CreditIssuance
// records linked to this payment's allocations.
// Write chain: CreditIssuance.reversedAt + LessonCreditLog(CORRECTION) + credits decrement

export async function reverseIssuancesForPayment(
  tx: PrismaTx,
  params: { paymentId: number; schoolId: number; actorId: number },
): Promise<void> {
  const { paymentId, schoolId, actorId } = params;

  const allocations = await tx.paymentAllocation.findMany({
    where:  { paymentId },
    select: { id: true },
  });
  if (allocations.length === 0) return;

  for (const { id: allocId } of allocations) {
    const issuances = await tx.creditIssuance.findMany({
      where: {
        paymentAllocationId: allocId,
        reversedAt:          null,
        reversalLogId:       null,
        creditsIssued:       { gt: 0 },
      },
    });

    for (const issuance of issuances) {
      const result = await reverseCreditsForIssuance(tx, {
        creditIssuanceId: issuance.id,
        creditsToReverse: issuance.creditsIssued,
        schoolId,
        actorId,
        paymentId,
        reason: `Credit issuance reversed: payment voided`,
        auditEntityId: allocId,
      });

      await logFinanceAction({
        client:     tx as unknown as PrismaClient,
        schoolId,
        userId:     actorId,
        action:     'CREDIT_ISSUANCE_REVERSED',
        entityType: 'allocation',
        entityId:   allocId,
        after:      { creditsReversed: result.creditsReversed, debtCredits: result.debtCredits, issuanceId: issuance.id },
      });
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

export async function reverseCreditsForIssuance(
  tx: PrismaTx,
  params: {
    creditIssuanceId: number;
    creditsToReverse: number;
    schoolId: number;
    actorId: number;
    paymentId: number;
    reason: string;
    paymentRefundAllocationId?: number;
    paymentRefundId?: number;
    auditEntityId?: number;
  },
): Promise<{ creditsReversed: number; debtCredits: number; alreadyProcessed: boolean }> {
  if (params.creditsToReverse <= 0) {
    return { creditsReversed: 0, debtCredits: 0, alreadyProcessed: false };
  }

  if (params.paymentRefundAllocationId != null) {
    const existing = await tx.creditIssuanceReversal.findUnique({
      where: {
        creditIssuanceId_paymentRefundAllocationId: {
          creditIssuanceId: params.creditIssuanceId,
          paymentRefundAllocationId: params.paymentRefundAllocationId,
        },
      },
    });
    if (existing) {
      return { creditsReversed: existing.creditsReversed, debtCredits: 0, alreadyProcessed: true };
    }
  } else {
    // Void path (no paymentRefundAllocationId): no unique DB constraint guards against
    // concurrent reversals on the same issuance. Acquire an exclusive row lock so that
    // two concurrent void transactions serialize here — the second reads the updated
    // remaining after the first commits, and returns early when remaining=0.
    await tx.$executeRaw(
      Prisma.sql`SELECT id FROM "CreditIssuance" WHERE id = ${params.creditIssuanceId} FOR UPDATE`
    );
  }

  const issuance = await tx.creditIssuance.findFirst({
    where: { id: params.creditIssuanceId, schoolId: params.schoolId },
  });
  if (!issuance) return { creditsReversed: 0, debtCredits: 0, alreadyProcessed: false };

  const [actualReversed, debtMarked] = await Promise.all([
    sumActualReversedCredits(tx, issuance.id),
    sumDebtMarkedCredits(tx, issuance.id),
  ]);
  const remaining = Math.max(issuance.creditsIssued - actualReversed - debtMarked, 0);
  const wanted = Math.min(params.creditsToReverse, remaining);
  if (wanted <= 0) return { creditsReversed: 0, debtCredits: 0, alreadyProcessed: false };

  const profile = await tx.studentProfile.findUniqueOrThrow({
    where: { id: issuance.studentProfileId },
    select: { credits: true },
  });

  const available = Math.max(profile.credits, 0);
  const creditsReversed = Math.min(wanted, available);
  const debtCredits = wanted - creditsReversed;
  let reversalLogId: number | undefined;

  if (creditsReversed > 0) {
    const reversalLog = await tx.lessonCreditLog.create({
      data: {
        studentProfileId: issuance.studentProfileId,
        schoolId: params.schoolId,
        amount: -creditsReversed,
        type: params.paymentRefundAllocationId != null ? 'REFUND' : 'CORRECTION',
        paymentId: params.paymentId,
        reason: params.reason,
        actorId: params.actorId,
      },
    });
    reversalLogId = reversalLog.id;

    await tx.studentProfile.update({
      where: { id: issuance.studentProfileId },
      data: { credits: { decrement: creditsReversed } },
    });

    await tx.creditIssuanceReversal.create({
      data: {
        creditIssuanceId: issuance.id,
        paymentRefundAllocationId: params.paymentRefundAllocationId,
        creditsReversed,
        lessonCreditLogId: reversalLog.id,
        createdById: params.actorId,
      },
    });

    // Balance decreased → re-derive the display-only paidUntil from the new balance.
    await recomputeAndPersistPaidUntil(tx, issuance.studentProfileId, params.schoolId);
  }

  if (debtCredits > 0) {
    try {
      await tx.financialAdjustment.create({
        data: {
          schoolId: params.schoolId,
          studentProfileId: issuance.studentProfileId,
          type: 'BALANCE_DEBT',
          amountCredits: debtCredits,
          reason: `${params.reason}: ${debtCredits} consumed credit(s) converted to explicit debt`,
          createdById: params.actorId,
          paymentRefundId: params.paymentRefundId,
          paymentRefundAllocationId: params.paymentRefundAllocationId,
          creditIssuanceId: issuance.id,
        },
      });

      await logFinanceAction({
        client: tx as unknown as PrismaClient,
        schoolId: params.schoolId,
        userId: params.actorId,
        action: 'FINANCIAL_ADJUSTMENT_CREATED',
        entityType: 'adjustment',
        entityId: params.auditEntityId ?? issuance.id,
        after: {
          type: 'BALANCE_DEBT',
          amountCredits: debtCredits,
          issuanceId: issuance.id,
          refundAllocationId: params.paymentRefundAllocationId ?? null,
        },
      });
    } catch (e: any) {
      if (e.code !== 'P2002') throw e;
    }
  }

  const [actualAfter, debtAfter] = await Promise.all([
    sumActualReversedCredits(tx, issuance.id),
    sumDebtMarkedCredits(tx, issuance.id),
  ]);
  if (actualAfter + debtAfter >= issuance.creditsIssued && !issuance.reversedAt) {
    await tx.creditIssuance.update({
      where: { id: issuance.id },
      data: {
        reversedAt: new Date(),
        reversedById: params.actorId,
        ...(reversalLogId != null ? { reversalLogId } : {}),
      },
    });
  }

  return { creditsReversed, debtCredits, alreadyProcessed: false };
}

async function sumActiveIssuedCredits(tx: PrismaTx, invoiceLineId: number): Promise<number> {
  const rows = await tx.creditIssuance.findMany({
    where: { invoiceLineId },
    select: { id: true, creditsIssued: true },
  });

  let total = 0;
  for (const row of rows) {
    const reversed = await sumActualReversedCredits(tx, row.id);
    const debt = await sumDebtMarkedCredits(tx, row.id);
    total += Math.max(row.creditsIssued - reversed - debt, 0);
  }
  return total;
}

async function sumActualReversedCredits(tx: PrismaTx, creditIssuanceId: number): Promise<number> {
  const rows = await tx.creditIssuanceReversal.findMany({
    where: { creditIssuanceId, voidedAt: null },
    select: { creditsReversed: true },
  });
  return rows.reduce((sum, r) => sum + r.creditsReversed, 0);
}

async function sumDebtMarkedCredits(tx: PrismaTx, creditIssuanceId: number): Promise<number> {
  const rows = await tx.financialAdjustment.findMany({
    where: { creditIssuanceId, type: 'BALANCE_DEBT', status: 'ACTIVE' },
    select: { amountCredits: true },
  });
  return rows.reduce((sum, r) => sum + (r.amountCredits ?? 0), 0);
}
