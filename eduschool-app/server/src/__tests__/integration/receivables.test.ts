/**
 * Integration: Phase 7.4 v1 — computed overdue and accounts receivable.
 *
 * Overdue is not persisted. Money debt comes from invoice receivables only;
 * credit debt remains an explicit FinancialAdjustment(BALANCE_DEBT) marker.
 */
import { Prisma } from '@prisma/client';
import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
} from '../helpers/testDb';
import { createDraft, addLine, issueInvoice, voidInvoice } from '../../services/invoiceService';
import { createPayment, createAllocation } from '../../services/paymentService';
import { createPaymentRefund, confirmPaymentRefund } from '../../services/refundService';
import { createFinancialAdjustment } from '../../services/financialAdjustmentService';
import {
  calculateNetPaid,
  calculateOutstanding,
  computeInvoiceReceivable,
  getSchoolReceivableSummary,
  getStudentReceivableSummary,
  isInvoiceOverdue,
  listOverdueInvoices,
} from '../../services/receivableService';
import { runChecks } from '../../services/consistencyCheckService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

const AS_OF = new Date('2026-05-24T12:00:00.000Z');
const PAST_DUE = new Date('2026-05-01T12:00:00.000Z');
const FUTURE_DUE = new Date('2026-06-01T12:00:00.000Z');

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
  dueDate?: Date;
  creditsToIssue?: number;
}) {
  const draft = await prisma.$transaction(tx =>
    createDraft(tx, {
      schoolId: opts.schoolId,
      studentProfileId: opts.studentProfileId,
      createdById: opts.actorId,
      dueDate: opts.dueDate,
    }),
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

async function refundAllocation(opts: {
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
      reason: 'Receivables refund',
      createdById: opts.actorId,
      allocations: [{ paymentAllocationId: opts.allocationId, amount: opts.amount }],
    }),
  );
  return prisma.$transaction(tx =>
    confirmPaymentRefund(tx, { schoolId: opts.schoolId, refundId: refund.id, actorId: opts.actorId }),
  );
}

describe('receivable pure math helpers', () => {
  it('calculates netPaid, outstanding, and overdue without float conversion', () => {
    const input = {
      totalAmount: new Prisma.Decimal('1000.00'),
      confirmedAllocated: new Prisma.Decimal('333.33'),
      confirmedRefunded: new Prisma.Decimal('33.33'),
      status: 'PARTIALLY_PAID' as const,
      dueDate: PAST_DUE,
    };

    expect(calculateNetPaid(input).eq(new Prisma.Decimal('300.00'))).toBe(true);
    expect(calculateOutstanding(input).eq(new Prisma.Decimal('700.00'))).toBe(true);
    expect(isInvoiceOverdue(input, AS_OF)).toBe(true);
  });
});

describe('computed overdue semantics', () => {
  it('issued invoice becomes overdue dynamically', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: PAST_DUE,
    });

    const receivable = await computeInvoiceReceivable(invoice.id, AS_OF, prisma);
    const persisted = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(receivable.isOverdue).toBe(true);
    expect(receivable.outstanding.eq(new Prisma.Decimal('1000'))).toBe(true);
    expect(persisted.status).toBe('ISSUED');
  });

  it('partially paid overdue invoice works', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: PAST_DUE,
    });
    await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '400',
    });

    const receivable = await computeInvoiceReceivable(invoice.id, AS_OF, prisma);
    expect(receivable.isOverdue).toBe(true);
    expect(receivable.netPaid.eq(new Prisma.Decimal('400'))).toBe(true);
    expect(receivable.outstanding.eq(new Prisma.Decimal('600'))).toBe(true);
  });

  it('paid invoice is not overdue', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: PAST_DUE,
    });
    await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });

    const receivable = await computeInvoiceReceivable(invoice.id, AS_OF, prisma);
    expect(receivable.status).toBe('PAID');
    expect(receivable.isOverdue).toBe(false);
    expect(receivable.outstanding.eq(new Prisma.Decimal(0))).toBe(true);
  });

  it('void invoice is not overdue and is excluded from summaries', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: PAST_DUE,
    });
    await prisma.$transaction(tx =>
      voidInvoice(tx, { invoiceId: invoice.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    const receivable = await computeInvoiceReceivable(invoice.id, AS_OF, prisma);
    const summary = await getStudentReceivableSummary(school.id, student.id, AS_OF, prisma);
    expect(receivable.isOverdue).toBe(false);
    expect(summary.activeInvoiceCount).toBe(0);
    expect(summary.moneyDebtAmount.eq(new Prisma.Decimal(0))).toBe(true);
  });
});

describe('refunds and receivable balances', () => {
  it('refund after PAID creates outstanding', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: FUTURE_DUE,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });

    await refundAllocation({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '250', actorId: ownerUser.id,
    });

    const receivable = await computeInvoiceReceivable(invoice.id, AS_OF, prisma);
    expect(receivable.netPaid.eq(new Prisma.Decimal('750'))).toBe(true);
    expect(receivable.outstanding.eq(new Prisma.Decimal('250'))).toBe(true);
    expect(receivable.isOverdue).toBe(false);
  });

  it('refund after PAID with past dueDate becomes overdue', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: PAST_DUE,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000',
    });

    await refundAllocation({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '250', actorId: ownerUser.id,
    });

    const receivable = await computeInvoiceReceivable(invoice.id, AS_OF, prisma);
    expect(receivable.status).toBe('PARTIALLY_PAID');
    expect(receivable.outstanding.eq(new Prisma.Decimal('250'))).toBe(true);
    expect(receivable.isOverdue).toBe(true);
  });
});

describe('receivable summaries', () => {
  it('receivable summary aggregates money debt correctly', async () => {
    const { school, ownerUser, student } = await setup();
    const overdue = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: PAST_DUE,
    });
    const future = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '500', dueDate: FUTURE_DUE,
    });
    await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: future.id, amount: '200',
    });

    const summary = await getStudentReceivableSummary(school.id, student.id, AS_OF, prisma);
    expect(summary.activeInvoiceCount).toBe(2);
    expect(summary.overdueInvoiceCount).toBe(1);
    expect(summary.totalIssued.eq(new Prisma.Decimal('1500'))).toBe(true);
    expect(summary.totalPaid.eq(new Prisma.Decimal('200'))).toBe(true);
    expect(summary.totalOutstanding.eq(new Prisma.Decimal('1300'))).toBe(true);
    expect(summary.overdueOutstanding.eq(new Prisma.Decimal('1000'))).toBe(true);
    expect(summary.moneyDebtAmount.eq(new Prisma.Decimal('1300'))).toBe(true);
    expect(summary.invoices.map(i => i.invoiceId).sort()).toEqual([overdue.id, future.id].sort());
  });

  it('FinancialAdjustment(BALANCE_DEBT) appears as creditDebtAmount but not moneyDebtAmount', async () => {
    const { school, ownerUser, student } = await setup();
    await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: FUTURE_DUE,
    });
    await prisma.$transaction(tx =>
      createFinancialAdjustment(tx, {
        schoolId: school.id,
        studentProfileId: student.id,
        type: 'BALANCE_DEBT',
        amountCredits: 7,
        reason: 'Consumed credits after refund',
        createdById: ownerUser.id,
      }),
    );

    const summary = await getStudentReceivableSummary(school.id, student.id, AS_OF, prisma);
    expect(summary.creditDebtAmount).toBe(7);
    expect(summary.moneyDebtAmount.eq(new Prisma.Decimal('1000'))).toBe(true);
  });

  it('overdue count is correct in invoice list and school summary', async () => {
    const { school, ownerUser, student } = await setup();
    await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: PAST_DUE,
    });
    await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: FUTURE_DUE,
    });

    const overdue = await listOverdueInvoices(school.id, AS_OF, prisma);
    const schoolSummary = await getSchoolReceivableSummary(school.id, AS_OF, prisma);
    expect(overdue).toHaveLength(1);
    expect(schoolSummary.overdueInvoiceCount).toBe(1);
    expect(schoolSummary.activeInvoiceCount).toBe(2);
    expect(schoolSummary.studentCountWithOutstanding).toBe(1);
  });
});

describe('receivable consistency checks', () => {
  it('check15 catches wrong status/outstanding inconsistency', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: PAST_DUE,
    });

    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'PAID' } });

    const violations = await runChecks(school.id, prisma as any);
    const check15 = violations.find(v => v.check.includes('outstanding math'));
    expect(check15).toBeDefined();
    expect(check15!.severity).toBe('CRITICAL');
    expect(check15!.ids).toContain(invoice.id);
  });

  it('no negative outstanding is exposed even if overpayment drift exists', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000', dueDate: PAST_DUE,
    });
    const payment = await prisma.payment.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        amount: '1500',
        method: 'CASH',
        status: 'CONFIRMED',
        receivedById: ownerUser.id,
      },
    });
    await prisma.paymentAllocation.create({
      data: { paymentId: payment.id, invoiceId: invoice.id, amount: '1500' },
    });

    const receivable = await computeInvoiceReceivable(invoice.id, AS_OF, prisma);
    const violations = await runChecks(school.id, prisma as any);
    const check15 = violations.find(v => v.check.includes('negative outstanding risk'));
    expect(receivable.netPaid.eq(new Prisma.Decimal('1500'))).toBe(true);
    expect(receivable.outstanding.eq(new Prisma.Decimal(0))).toBe(true);
    expect(check15).toBeDefined();
    expect(check15!.ids).toContain(invoice.id);
  });

  it('netPaid plus outstanding stays consistent for normal active invoices', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1200', dueDate: FUTURE_DUE,
    });
    const { payment, allocation } = await payInvoice({
      schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '800',
    });
    await refundAllocation({
      schoolId: school.id, paymentId: payment.id, allocationId: allocation.id, amount: '200', actorId: ownerUser.id,
    });

    const receivable = await computeInvoiceReceivable(invoice.id, AS_OF, prisma);
    expect(receivable.netPaid.plus(receivable.outstanding).eq(receivable.totalAmount)).toBe(true);
    expect(receivable.totalRefunded.eq(new Prisma.Decimal('200'))).toBe(true);
  });
});
