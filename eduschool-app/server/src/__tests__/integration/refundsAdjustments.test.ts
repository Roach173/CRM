/**
 * Integration: Phase 7.3 — Refunds, reversals, and financial adjustments.
 *
 * Refund source of truth is PaymentRefundAllocation. Confirmed invoice paidAmount
 * is net allocations minus confirmed refund allocations.
 */
import { Prisma } from '@prisma/client';
import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
} from '../helpers/testDb';
import { createDraft, addLine, issueInvoice } from '../../services/invoiceService';
import { createPayment, createAllocation } from '../../services/paymentService';
import { createPaymentRefund, confirmPaymentRefund, voidPaymentRefund } from '../../services/refundService';
import { createFinancialAdjustment } from '../../services/financialAdjustmentService';
import { runChecks } from '../../services/consistencyCheckService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school = await createSchool({ timezone: 'UTC' });
  const ownerUser = await createUser(school.id, 'OWNER');
  const stuUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(stuUser.id, school.id, 0);
  return { school, ownerUser, student };
}

async function makeIssuedInvoice(opts: {
  schoolId: number;
  studentProfileId: number;
  actorId: number;
  total: string;
  creditsToIssue?: number;
}) {
  const draft = await prisma.$transaction(tx =>
    createDraft(tx, { schoolId: opts.schoolId, studentProfileId: opts.studentProfileId, createdById: opts.actorId }),
  );
  await prisma.$transaction(tx =>
    addLine(tx, {
      invoiceId: draft.id,
      schoolId: opts.schoolId,
      type: 'TUITION',
      description: 'Tuition',
      quantity: '1',
      unitPrice: opts.total,
      creditsToIssue: opts.creditsToIssue,
    }),
  );
  return prisma.$transaction(tx =>
    issueInvoice(tx, { invoiceId: draft.id, schoolId: opts.schoolId, actorId: opts.actorId }),
  );
}

async function payInvoice(opts: {
  schoolId: number;
  studentProfileId: number;
  actorId: number;
  invoiceId: number;
  amount: string;
}) {
  const payment = await prisma.$transaction(tx =>
    createPayment(tx, {
      schoolId: opts.schoolId,
      studentProfileId: opts.studentProfileId,
      amount: opts.amount,
      method: 'CASH',
      receivedById: opts.actorId,
    }),
  );
  const allocation = await prisma.$transaction(tx =>
    createAllocation(tx, {
      paymentId: payment.id,
      invoiceId: opts.invoiceId,
      amount: opts.amount,
      schoolId: opts.schoolId,
      actorId: opts.actorId,
    }),
  );
  return { payment, allocation };
}

async function createAndConfirmRefund(opts: {
  schoolId: number;
  paymentId: number;
  allocationId: number;
  amount: string;
  actorId: number;
}) {
  const refund = await prisma.$transaction(tx =>
    createPaymentRefund(tx, {
      schoolId: opts.schoolId,
      paymentId: opts.paymentId,
      reason: 'Customer refund',
      createdById: opts.actorId,
      allocations: [{ paymentAllocationId: opts.allocationId, amount: opts.amount }],
    }),
  );
  const confirmed = await prisma.$transaction(tx =>
    confirmPaymentRefund(tx, { schoolId: opts.schoolId, refundId: refund.id, actorId: opts.actorId }),
  );
  return confirmed;
}

describe('refunds — allocation-aware net paid', () => {
  it('full refund preserves payment/allocation history and returns invoice to ISSUED', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', creditsToIssue: 10,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });

    await createAndConfirmRefund({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '1000', actorId: ownerUser.id,
    });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(new Prisma.Decimal(updated.paidAmount).eq(new Prisma.Decimal(0))).toBe(true);
    expect(updated.status).toBe('ISSUED');
    expect(await prisma.payment.count({ where: { id: payment.id } })).toBe(1);
    expect(await prisma.paymentAllocation.count({ where: { id: allocation.id } })).toBe(1);
    expect(await prisma.paymentRefundAllocation.count({ where: { paymentAllocationId: allocation.id } })).toBe(1);
  });

  it('partial refund subtracts only refunded allocation amount and reverses proportional unused credits', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', creditsToIssue: 10,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });

    await createAndConfirmRefund({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '400', actorId: ownerUser.id,
    });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(new Prisma.Decimal(updated.paidAmount).eq(new Prisma.Decimal('600'))).toBe(true);
    expect(updated.status).toBe('PARTIALLY_PAID');
    expect(profile.credits).toBe(6);
  });

  it('refund cannot exceed refundable allocation balance', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', creditsToIssue: 10,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });

    await expect(
      prisma.$transaction(tx =>
        createPaymentRefund(tx, {
          schoolId: school.id,
          paymentId: payment.id,
          reason: 'Too much',
          createdById: ownerUser.id,
          allocations: [{ paymentAllocationId: allocation.id, amount: '1000.01' }],
        }),
      ),
    ).rejects.toThrow('REFUND_EXCEEDS_REFUNDABLE_BALANCE');
  });

  it('refund one allocation from a payment split across many invoices', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice1 = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '300', creditsToIssue: 3,
    });
    const invoice2 = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '700', creditsToIssue: 7,
    });
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id, amount: '1000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    const allocation1 = await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: payment.id, invoiceId: invoice1.id, amount: '300', schoolId: school.id, actorId: ownerUser.id }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: payment.id, invoiceId: invoice2.id, amount: '700', schoolId: school.id, actorId: ownerUser.id }),
    );

    await createAndConfirmRefund({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation1.id, amount: '300', actorId: ownerUser.id,
    });

    const [updated1, updated2] = await Promise.all([
      prisma.invoice.findUniqueOrThrow({ where: { id: invoice1.id } }),
      prisma.invoice.findUniqueOrThrow({ where: { id: invoice2.id } }),
    ]);
    expect(new Prisma.Decimal(updated1.paidAmount).eq(new Prisma.Decimal(0))).toBe(true);
    expect(updated1.status).toBe('ISSUED');
    expect(new Prisma.Decimal(updated2.paidAmount).eq(new Prisma.Decimal('700'))).toBe(true);
    expect(updated2.status).toBe('PAID');
  });

  it('refund after partial payment updates net paid and partial credit issuance safely', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', creditsToIssue: 10,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '500',
    });

    await createAndConfirmRefund({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '250', actorId: ownerUser.id,
    });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(new Prisma.Decimal(updated.paidAmount).eq(new Prisma.Decimal('250'))).toBe(true);
    expect(updated.status).toBe('PARTIALLY_PAID');
    expect(profile.credits).toBe(3);
  });
});

describe('refunds — consumed credits and idempotency', () => {
  it('consumed credits create explicit debt marker and never negative StudentProfile.credits', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '2000', creditsToIssue: 20,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '2000',
    });

    await prisma.lessonCreditLog.createMany({
      data: Array.from({ length: 15 }, () => ({
        schoolId: school.id,
        studentProfileId: student.id,
        amount: -1,
        type: 'DEBIT',
        reason: 'Attendance debit consumed before refund',
        actorId: ownerUser.id,
      })),
    });
    await prisma.studentProfile.update({ where: { id: student.id }, data: { credits: { decrement: 15 } } });

    await createAndConfirmRefund({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '2000', actorId: ownerUser.id,
    });

    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    const debt = await prisma.financialAdjustment.findFirstOrThrow({
      where: { studentProfileId: student.id, type: 'BALANCE_DEBT' },
    });
    const reversalLogs = await prisma.lessonCreditLog.findMany({ where: { studentProfileId: student.id, type: 'REFUND' } });
    expect(profile.credits).toBe(0);
    expect(debt.amountCredits).toBe(15);
    expect(reversalLogs.reduce((sum, l) => sum + l.amount, 0)).toBe(-5);
  });

  it('double-confirm is blocked and does not duplicate reversals, adjustments, or ledger logs', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', creditsToIssue: 10,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });
    const refund = await prisma.$transaction(tx =>
      createPaymentRefund(tx, {
        schoolId: school.id,
        paymentId: payment.id,
        reason: 'Idempotency',
        createdById: ownerUser.id,
        allocations: [{ paymentAllocationId: allocation.id, amount: '1000' }],
      }),
    );

    await prisma.$transaction(tx =>
      confirmPaymentRefund(tx, { schoolId: school.id, refundId: refund.id, actorId: ownerUser.id }),
    );
    const countsBefore = {
      reversals: await prisma.creditIssuanceReversal.count(),
      adjustments: await prisma.financialAdjustment.count(),
      refundLogs: await prisma.lessonCreditLog.count({ where: { type: 'REFUND' } }),
    };

    await expect(
      prisma.$transaction(tx =>
        confirmPaymentRefund(tx, { schoolId: school.id, refundId: refund.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('REFUND_ALREADY_CONFIRMED');

    expect(await prisma.creditIssuanceReversal.count()).toBe(countsBefore.reversals);
    expect(await prisma.financialAdjustment.count()).toBe(countsBefore.adjustments);
    expect(await prisma.lessonCreditLog.count({ where: { type: 'REFUND' } })).toBe(countsBefore.refundLogs);
  });

  it('voiding a confirmed refund restores invoice net paid and creates counter-ledger credit restore', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', creditsToIssue: 10,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });
    const refund = await createAndConfirmRefund({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '400', actorId: ownerUser.id,
    });

    await prisma.$transaction(tx =>
      voidPaymentRefund(tx, { schoolId: school.id, refundId: refund.id, actorId: ownerUser.id }),
    );

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    const voidedReversal = await prisma.creditIssuanceReversal.findFirstOrThrow();
    expect(new Prisma.Decimal(updated.paidAmount).eq(new Prisma.Decimal('1000'))).toBe(true);
    expect(updated.status).toBe('PAID');
    expect(profile.credits).toBe(10);
    expect(voidedReversal.voidedAt).not.toBeNull();
    expect(voidedReversal.voidLogId).not.toBeNull();
  });
});

describe('financial adjustments and reconciliation', () => {
  it('controlled credit adjustment creates ledger and updates StudentProfile.credits', async () => {
    const { school, ownerUser, student } = await setup();

    await prisma.$transaction(tx =>
      createFinancialAdjustment(tx, {
        schoolId: school.id,
        studentProfileId: student.id,
        type: 'CREDIT_GRANT',
        amountCredits: 3,
        reason: 'Manager correction',
        createdById: ownerUser.id,
      }),
    );

    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    const log = await prisma.lessonCreditLog.findFirstOrThrow({ where: { studentProfileId: student.id } });
    expect(profile.credits).toBe(3);
    expect(log.amount).toBe(3);
    expect(log.type).toBe('MANUAL_ADD');
  });

  it('check14 reconciles paidAmount against confirmed allocations minus confirmed refund allocations', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', creditsToIssue: 10,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });
    await createAndConfirmRefund({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '250', actorId: ownerUser.id,
    });

    const violations = await runChecks(school.id, prisma as any);
    const check14 = violations.find(v => v.check.includes('paidAmount'));
    expect(check14).toBeUndefined();

    await prisma.invoice.update({ where: { id: invoice.id }, data: { paidAmount: '999' } });
    const afterCorruption = await runChecks(school.id, prisma as any);
    const failedCheck14 = afterCorruption.find(v => v.check.includes('paidAmount'));
    expect(failedCheck14).toBeDefined();
    expect(failedCheck14!.severity).toBe('CRITICAL');
  });

  it('refund writes audit events and preserves all immutable source rows', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', creditsToIssue: 10,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });
    await createAndConfirmRefund({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '1000', actorId: ownerUser.id,
    });

    const actions = (await prisma.scheduleActionLog.findMany({
      where: { schoolId: school.id },
      select: { action: true },
    })).map(l => l.action);
    expect(actions).toContain('PAYMENT_REFUND_CREATED');
    expect(actions).toContain('PAYMENT_REFUND_CONFIRMED');
    expect(actions).toContain('CREDIT_REVERSAL_CREATED');
    expect(await prisma.payment.count({ where: { id: payment.id } })).toBe(1);
    expect(await prisma.paymentAllocation.count({ where: { id: allocation.id } })).toBe(1);
    expect(await prisma.creditIssuance.count()).toBe(1);
  });
});
