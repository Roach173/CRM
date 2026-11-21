/**
 * Integration: Phase 8 — Analytics services.
 *
 * Covers: receivables aging buckets, finance KPIs (refund rate, collection rate),
 * academic KPIs (student status counts, group status counts),
 * and attendance summary (cancelled vs invalidated).
 */
import { Prisma } from '@prisma/client';
import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
  createGroup, createBlock, createSession, createStaffProfile,
} from '../helpers/testDb';
import { createDraft, addLine, issueInvoice } from '../../services/invoiceService';
import { createPayment, createAllocation } from '../../services/paymentService';
import { createPaymentRefund, confirmPaymentRefund } from '../../services/refundService';
import { getReceivablesAging, getFinanceKPIs } from '../../services/financeAnalyticsService';
import {
  getStudentStatusCounts,
  getGroupStatusCounts,
  getAcademicKPIs,
} from '../../services/academicAnalyticsService';
import { getAnalyticsPeriods } from '../../services/analyticsDate';

const FIXED_NOW = new Date('2026-05-15T12:00:00.000Z');

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// Fixed reference date
const AS_OF = new Date('2026-05-24T12:00:00.000Z');

// Helpers ─────────────────────────────────────────────────────────────────────

async function setup() {
  const school = await createSchool({ timezone: 'UTC' });
  const owner = await createUser(school.id, 'OWNER');
  const stuUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(stuUser.id, school.id, 0);
  return { school, owner, student };
}

async function makeIssuedInvoice(opts: {
  schoolId: number;
  studentProfileId: number;
  actorId: number;
  total: string;
  dueDate?: Date;
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
  paidAt?: Date;
}) {
  const payment = await prisma.$transaction(tx =>
    createPayment(tx, {
      schoolId: opts.schoolId,
      studentProfileId: opts.studentProfileId,
      amount: opts.amount,
      method: 'CASH',
      receivedById: opts.actorId,
      paidAt: opts.paidAt,
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

// ─── Receivables Aging ────────────────────────────────────────────────────────

describe('getReceivablesAging', () => {
  it('returns all-zero buckets when no overdue invoices exist', async () => {
    const { school } = await setup();
    const buckets = await getReceivablesAging(school.id, AS_OF);
    expect(buckets).toHaveLength(4);
    expect(buckets.every(b => b.count === 0 && b.amount === 0)).toBe(true);
  });

  it('places invoice overdue 10 days into 0–30 bucket', async () => {
    const { school, owner, student } = await setup();
    const dueDate = new Date('2026-05-14T12:00:00.000Z'); // 10 days before AS_OF
    await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '1000', dueDate });

    const buckets = await getReceivablesAging(school.id, AS_OF);
    const bucket0_30 = buckets.find(b => b.label === '0–30 дн.')!;
    expect(bucket0_30.count).toBe(1);
    expect(bucket0_30.amount).toBe(1000);
  });

  it('places invoice overdue 45 days into 31–60 bucket', async () => {
    const { school, owner, student } = await setup();
    const dueDate = new Date('2026-04-09T12:00:00.000Z'); // ~45 days before AS_OF
    await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '2000', dueDate });

    const buckets = await getReceivablesAging(school.id, AS_OF);
    const bucket31_60 = buckets.find(b => b.label === '31–60 дн.')!;
    expect(bucket31_60.count).toBe(1);
    expect(bucket31_60.amount).toBe(2000);
  });

  it('places invoice overdue 75 days into 61–90 bucket', async () => {
    const { school, owner, student } = await setup();
    const dueDate = new Date('2026-03-10T12:00:00.000Z'); // ~75 days before AS_OF
    await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '3000', dueDate });

    const buckets = await getReceivablesAging(school.id, AS_OF);
    const bucket61_90 = buckets.find(b => b.label === '61–90 дн.')!;
    expect(bucket61_90.count).toBe(1);
    expect(bucket61_90.amount).toBe(3000);
  });

  it('places invoice overdue 120 days into 90+ bucket', async () => {
    const { school, owner, student } = await setup();
    const dueDate = new Date('2026-01-24T12:00:00.000Z'); // 120 days before AS_OF
    await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '5000', dueDate });

    const buckets = await getReceivablesAging(school.id, AS_OF);
    const bucket90plus = buckets.find(b => b.label === '90+ дн.')!;
    expect(bucket90plus.count).toBe(1);
    expect(bucket90plus.amount).toBe(5000);
  });

  it('distributes multiple invoices across correct buckets', async () => {
    const { school, owner, student } = await setup();
    await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '500', dueDate: new Date('2026-05-14T12:00:00.000Z') });
    await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '700', dueDate: new Date('2026-04-09T12:00:00.000Z') });
    await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '900', dueDate: new Date('2026-01-24T12:00:00.000Z') });

    const buckets = await getReceivablesAging(school.id, AS_OF);
    expect(buckets.find(b => b.label === '0–30 дн.')!.count).toBe(1);
    expect(buckets.find(b => b.label === '31–60 дн.')!.count).toBe(1);
    expect(buckets.find(b => b.label === '90+ дн.')!.count).toBe(1);
    const total = buckets.reduce((s, b) => s + b.amount, 0);
    expect(total).toBe(2100);
  });

  it('excludes fully-paid invoices from aging', async () => {
    const { school, owner, student } = await setup();
    const dueDate = new Date('2026-05-10T12:00:00.000Z');
    const invoice = await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '1000', dueDate });
    await payInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, invoiceId: invoice.id, amount: '1000' });

    const buckets = await getReceivablesAging(school.id, AS_OF);
    expect(buckets.every(b => b.count === 0)).toBe(true);
  });

  it('does not leak data across schools', async () => {
    const { school, owner, student } = await setup();
    const school2 = await createSchool();
    const owner2 = await createUser(school2.id, 'OWNER');
    const stu2User = await createUser(school2.id, 'STUDENT');
    const student2 = await createStudentProfile(stu2User.id, school2.id, 0);
    const dueDate = new Date('2026-05-10T12:00:00.000Z');
    await makeIssuedInvoice({ schoolId: school2.id, studentProfileId: student2.id, actorId: owner2.id, total: '9999', dueDate });

    const buckets = await getReceivablesAging(school.id, AS_OF);
    expect(buckets.every(b => b.count === 0)).toBe(true);
  });
});

// ─── Finance KPIs ─────────────────────────────────────────────────────────────

describe('getFinanceKPIs', () => {
  function makeRange(from: string, to: string) {
    return { from: new Date(from), to: new Date(to) };
  }

  it('returns zeros with no data', async () => {
    const { school } = await setup();
    const range = makeRange('2026-05-01T00:00:00.000Z', '2026-05-31T23:59:59.999Z');
    const kpis = await getFinanceKPIs(school.id, range);
    expect(kpis.collectedAmount).toBe(0);
    expect(kpis.refundedAmount).toBe(0);
    expect(kpis.refundRate).toBe(0);
    expect(kpis.collectionRate).toBe(0);
  });

  it('computes collectedAmount from confirmed payments in range', async () => {
    const { school, owner, student } = await setup();
    const invoice = await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '5000' });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { issuedAt: FIXED_NOW } });
    await payInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, invoiceId: invoice.id, amount: '5000', paidAt: FIXED_NOW });

    const range = makeRange('2026-05-01T00:00:00.000Z', '2026-05-31T23:59:59.999Z');
    const kpis = await getFinanceKPIs(school.id, range);
    expect(kpis.collectedAmount).toBe(5000);
    expect(kpis.paidInvoiceCount).toBe(1);
  });

  it('computes refundedAmount and refundRate correctly', async () => {
    const { school, owner, student } = await setup();
    const invoice = await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '10000' });
    const { payment, allocation } = await payInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, invoiceId: invoice.id, amount: '10000', paidAt: FIXED_NOW });

    // Create and confirm refund of 2000
    const refund = await prisma.$transaction(tx =>
      createPaymentRefund(tx, {
        schoolId: school.id,
        paymentId: payment.id,
        reason: 'Test refund',
        createdById: owner.id,
        allocations: [{ paymentAllocationId: allocation.id, amount: '2000' }],
      }),
    );
    await prisma.$transaction(tx =>
      confirmPaymentRefund(tx, { schoolId: school.id, refundId: refund.id, actorId: owner.id }),
    );
    await prisma.paymentRefund.update({ where: { id: refund.id }, data: { confirmedAt: FIXED_NOW } });

    const range = makeRange('2026-05-01T00:00:00.000Z', '2026-05-31T23:59:59.999Z');
    const kpis = await getFinanceKPIs(school.id, range);
    expect(kpis.collectedAmount).toBe(10000);
    expect(kpis.refundedAmount).toBe(2000);
    expect(kpis.refundRate).toBe(20); // 2000/10000 * 100 = 20%
  });

  it('collectionRate = collected / issued in period', async () => {
    const { school, owner, student } = await setup();
    const issuedAt = new Date('2026-05-15T10:00:00.000Z');
    // Issue invoice with issuedAt in range
    const invoice = await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, total: '8000' });
    // Manually set issuedAt to be in range (createDraft/issueInvoice sets it to now)
    await prisma.invoice.update({ where: { id: invoice.id }, data: { issuedAt } });
    // Pay half
    await payInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: owner.id, invoiceId: invoice.id, amount: '4000', paidAt: FIXED_NOW });

    const range = makeRange('2026-05-01T00:00:00.000Z', '2026-05-31T23:59:59.999Z');
    const kpis = await getFinanceKPIs(school.id, range);
    expect(kpis.collectedAmount).toBe(4000);
    // collectionRate = 4000 / 8000 = 50%
    expect(kpis.collectionRate).toBe(50);
  });

  it('does not leak data across schools', async () => {
    const { school } = await setup();
    const school2 = await createSchool();
    const owner2 = await createUser(school2.id, 'OWNER');
    const stu2User = await createUser(school2.id, 'STUDENT');
    const student2 = await createStudentProfile(stu2User.id, school2.id, 0);
    const invoice2 = await makeIssuedInvoice({ schoolId: school2.id, studentProfileId: student2.id, actorId: owner2.id, total: '99999' });
    await payInvoice({ schoolId: school2.id, studentProfileId: student2.id, actorId: owner2.id, invoiceId: invoice2.id, amount: '99999' });

    const range = makeRange('2026-05-01T00:00:00.000Z', '2026-05-31T23:59:59.999Z');
    const kpis = await getFinanceKPIs(school.id, range);
    expect(kpis.collectedAmount).toBe(0);
  });
});

// ─── Academic KPIs ────────────────────────────────────────────────────────────

describe('getStudentStatusCounts', () => {
  it('returns zeros for empty school', async () => {
    const { school } = await setup();
    const counts = await getStudentStatusCounts(school.id);
    // setup() creates 1 student with no membership
    expect(counts.active).toBe(0);
    expect(counts.paused).toBe(0);
    expect(counts.frozen).toBe(0);
  });

  it('counts active student with ACTIVE membership', async () => {
    const { school, student } = await setup();
    const group = await createGroup(school.id);
    await prisma.groupMembership.create({
      data: { schoolId: school.id, studentProfileId: student.id, studentGroupId: group.id, status: 'ACTIVE' },
    });

    const counts = await getStudentStatusCounts(school.id);
    expect(counts.active).toBe(1);
    expect(counts.paused).toBe(0);
  });

  it('counts paused student with PAUSED membership', async () => {
    const { school, student } = await setup();
    const group = await createGroup(school.id);
    await prisma.groupMembership.create({
      data: { schoolId: school.id, studentProfileId: student.id, studentGroupId: group.id, status: 'PAUSED' },
    });

    const counts = await getStudentStatusCounts(school.id);
    expect(counts.paused).toBe(1);
    expect(counts.active).toBe(0);
  });

  it('counts frozen student independently', async () => {
    const { school, student } = await setup();
    await prisma.studentProfile.update({ where: { id: student.id }, data: { isFrozen: true } });

    const counts = await getStudentStatusCounts(school.id);
    expect(counts.frozen).toBe(1);
  });

  it('does not mix students from other schools', async () => {
    const { school } = await setup();
    const school2 = await createSchool();
    const stu2User = await createUser(school2.id, 'STUDENT');
    const student2 = await createStudentProfile(stu2User.id, school2.id, 0);
    const group2 = await createGroup(school2.id);
    await prisma.groupMembership.create({
      data: { schoolId: school2.id, studentProfileId: student2.id, studentGroupId: group2.id, status: 'ACTIVE' },
    });

    const counts = await getStudentStatusCounts(school.id);
    expect(counts.active).toBe(0);
  });
});

describe('getGroupStatusCounts', () => {
  it('returns zeros for school with no groups', async () => {
    const { school } = await setup();
    const counts = await getGroupStatusCounts(school.id);
    expect(counts.active).toBe(0);
    expect(counts.paused).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.total).toBe(0);
  });

  it('counts groups by status correctly', async () => {
    const { school } = await setup();
    await prisma.studentGroup.createMany({
      data: [
        { schoolId: school.id, level: 'A1', chapter: 1, status: 'ACTIVE' },
        { schoolId: school.id, level: 'A2', chapter: 1, status: 'ACTIVE' },
        { schoolId: school.id, level: 'B1', chapter: 1, status: 'PAUSED' },
        { schoolId: school.id, level: 'B2', chapter: 1, status: 'COMPLETED' },
      ],
    });

    const counts = await getGroupStatusCounts(school.id);
    expect(counts.active).toBe(2);
    expect(counts.paused).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.total).toBe(4);
  });
});

// ─── Attendance Analytics ────────────────────────────────────────────────────

describe('getAcademicKPIs attendance summary', () => {
  it('computes attendance rate from present + late over total', async () => {
    const { school, owner, student } = await setup();
    const teacher = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacher.id, school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });

    const date = new Date('2026-05-20T12:00:00.000Z');
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date, status: 'COMPLETED' });

    // 2 present, 1 absent
    await prisma.attendance.createMany({
      data: [
        { schoolId: school.id, lessonSessionId: session.id, studentProfileId: student.id, status: 'PRESENT', creditDeducted: false },
      ],
    });
    // Create two more students for absent
    const stuUser2 = await createUser(school.id, 'STUDENT');
    const student2 = await createStudentProfile(stuUser2.id, school.id, 0);
    const stuUser3 = await createUser(school.id, 'STUDENT');
    const student3 = await createStudentProfile(stuUser3.id, school.id, 0);
    await prisma.attendance.createMany({
      data: [
        { schoolId: school.id, lessonSessionId: session.id, studentProfileId: student2.id, status: 'LATE', creditDeducted: false },
        { schoolId: school.id, lessonSessionId: session.id, studentProfileId: student3.id, status: 'ABSENT', creditDeducted: false },
      ],
    });

    const { currentPeriod } = getAnalyticsPeriods({ period: 'month' }, FIXED_NOW);
    const kpis = await getAcademicKPIs(school.id, currentPeriod);

    // present=1, late=1, absent=1, total=3 → rate=66%
    expect(kpis.attendance.present).toBe(1);
    expect(kpis.attendance.late).toBe(1);
    expect(kpis.attendance.absent).toBe(1);
    expect(kpis.attendance.total).toBe(3);
    expect(kpis.attendance.rate).toBe(67); // round(2/3 * 100)
  });

  it('distinguishes CANCELLED vs INVALIDATED sessions', async () => {
    const { school, owner } = await setup();
    const teacher = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacher.id, school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });

    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-05-20T12:00:00.000Z'), status: 'CANCELLED' });
    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-05-21T12:00:00.000Z'), status: 'CANCELLED' });
    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-05-22T12:00:00.000Z'), status: 'INVALIDATED' });

    const { currentPeriod } = getAnalyticsPeriods({ period: 'month' }, FIXED_NOW);
    const kpis = await getAcademicKPIs(school.id, currentPeriod);

    expect(kpis.attendance.cancelled).toBe(2);
    expect(kpis.attendance.invalidated).toBe(1);
  });

  it('returns zero attendance rate when no attendance records exist', async () => {
    const { school } = await setup();
    const { currentPeriod } = getAnalyticsPeriods({ period: 'month' }, FIXED_NOW);
    const kpis = await getAcademicKPIs(school.id, currentPeriod);

    expect(kpis.attendance.rate).toBe(0);
    expect(kpis.attendance.total).toBe(0);
  });
});
