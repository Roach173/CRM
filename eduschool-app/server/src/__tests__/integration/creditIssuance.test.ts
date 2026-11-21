/**
 * Integration: Phase 7.2 — Credit Issuance from Paid Tuition Invoices (real DB).
 *
 * Verifies:
 *  1. TUITION allocation issues credits = floor(creditsToIssue × allocAmt / total)
 *  2. MATERIAL line allocation issues nothing (non-TUITION)
 *  3. Partial payment (50%) issues proportional credits via floor
 *  4. Full payment issues full creditsToIssue (floor = exact)
 *  5. Three 1/3 payments: floor+floor+reconcile → total = creditsToIssue exactly
 *  6. Idempotency: calling issueCreditsForAllocation twice → no double-issue
 *  7. Payment void reverses all issued credits, StudentProfile.credits decremented
 *  8. LessonCreditLog created with type=PAYMENT and paymentId set
 *  9. LessonCreditLog CORRECTION created on reversal
 * 10. Invoice with only MATERIAL lines → no CreditIssuance created
 * 11. Decimal-safe: 15 credits, 3×1/3 payments → floor(5)+floor(5)+reconcile(5) = 15 exactly
 * 12. creditsToIssue=null on TUITION line → no issuance
 * 13. Audit events: CREDITS_ISSUED_FROM_PAYMENT + CREDIT_ISSUANCE_REVERSED in ScheduleActionLog
 */

import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
} from '../helpers/testDb';
import { createDraft, addLine, issueInvoice } from '../../services/invoiceService';
import { createPayment, createAllocation, voidPayment } from '../../services/paymentService';
import { Prisma } from '@prisma/client';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// ─── Fixture helpers ──────────────────────────────────────────────────────────

async function setup() {
  const school    = await createSchool({ timezone: 'UTC' });
  const ownerUser = await createUser(school.id, 'OWNER');
  const stuUser   = await createUser(school.id, 'STUDENT');
  const student   = await createStudentProfile(stuUser.id, school.id, 0);
  return { school, ownerUser, student };
}

/** Create an ISSUED invoice with a single TUITION line. */
async function makeIssuedInvoice(opts: {
  school: { id: number };
  student: { id: number };
  ownerUser: { id: number };
  unitPrice: string;
  creditsToIssue?: number | null;
  lineType?: 'TUITION' | 'MATERIAL' | 'REGISTRATION' | 'CUSTOM';
}) {
  const { school, student, ownerUser, unitPrice, creditsToIssue, lineType = 'TUITION' } = opts;

  const inv = await prisma.$transaction(tx =>
    createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
  );
  await prisma.$transaction(tx =>
    addLine(tx, {
      invoiceId: inv.id, schoolId: school.id,
      type: lineType, description: 'Fee',
      quantity: '1', unitPrice,
      creditsToIssue: creditsToIssue ?? undefined,
    }),
  );
  return prisma.$transaction(tx =>
    issueInvoice(tx, { invoiceId: inv.id, schoolId: school.id, actorId: ownerUser.id }),
  );
}

/** Create payment + allocation in one transaction, return both. */
async function payInvoice(opts: {
  school: { id: number };
  student: { id: number };
  ownerUser: { id: number };
  invoiceId: number;
  amount: string;
}) {
  const { school, student, ownerUser, invoiceId, amount } = opts;
  return prisma.$transaction(async tx => {
    const payment = await createPayment(tx, {
      schoolId: school.id, studentProfileId: student.id,
      amount, method: 'CASH', receivedById: ownerUser.id,
    });
    const allocation = await createAllocation(tx, {
      paymentId: payment.id, invoiceId, amount,
      schoolId: school.id, actorId: ownerUser.id,
    });
    return { payment, allocation };
  });
}

// ─── Test 1: TUITION proportional issuance ────────────────────────────────────

describe('credit issuance — TUITION proportional floor', () => {
  it('issues floor(creditsToIssue × allocAmt / total) on partial payment', async () => {
    const { school, ownerUser, student } = await setup();
    // 10 credits, invoice = 1000, paying 700 → floor(10 × 700/1000) = 7
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '1000', creditsToIssue: 10 });
    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '700' });

    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profile.credits).toBe(7);

    const issuance = await prisma.creditIssuance.findFirst({ where: { studentProfileId: student.id } });
    expect(issuance).not.toBeNull();
    expect(issuance!.creditsIssued).toBe(7);
    expect(issuance!.reversedAt).toBeNull();
  });
});

// ─── Test 2: non-TUITION line → no issuance ───────────────────────────────────

describe('credit issuance — non-TUITION lines', () => {
  it('issues nothing for MATERIAL line even if creditsToIssue were hypothetically set', async () => {
    const { school, ownerUser, student } = await setup();
    // MATERIAL line — creditsToIssue is irrelevant; issueCreditsForAllocation skips non-TUITION
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '500', lineType: 'MATERIAL' });
    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '500' });

    const issuanceCount = await prisma.creditIssuance.count({ where: { studentProfileId: student.id } });
    expect(issuanceCount).toBe(0);

    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profile.credits).toBe(0);
  });
});

// ─── Test 3: 50% partial payment ─────────────────────────────────────────────

describe('credit issuance — 50% partial payment', () => {
  it('issues floor(10 × 500/1000) = 5 credits on 50% payment', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '1000', creditsToIssue: 10 });
    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '500' });

    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profile.credits).toBe(5);
  });
});

// ─── Test 4: full payment issues all credits ──────────────────────────────────

describe('credit issuance — full payment', () => {
  it('issues exactly creditsToIssue credits on full payment (reconcile path)', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '1000', creditsToIssue: 10 });
    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '1000' });

    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profile.credits).toBe(10);
  });
});

// ─── Test 5: three 1/3 payments → total = creditsToIssue ─────────────────────

describe('credit issuance — rounding reconcile on PAID', () => {
  it('3 × 1/3 payments sum to exactly creditsToIssue (floor + floor + reconcile remainder)', async () => {
    const { school, ownerUser, student } = await setup();
    // 9 credits, invoice = 900, 3 × 300 → floor(9×300/900)=3 + 3 + reconcile(9-6)=3 = 9
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '900', creditsToIssue: 9 });

    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '300' });
    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '300' });
    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '300' });

    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profile.credits).toBe(9);

    const issuances = await prisma.creditIssuance.findMany({ where: { studentProfileId: student.id } });
    expect(issuances.length).toBe(3);
    const total = issuances.reduce((s, i) => s + i.creditsIssued, 0);
    expect(total).toBe(9);
  });
});

// ─── Test 6: idempotency ──────────────────────────────────────────────────────

describe('credit issuance — idempotency', () => {
  it('calling issueCreditsForAllocation twice for same (allocId, lineId) → no double-issue', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '1000', creditsToIssue: 10 });

    const { allocation } = await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '500' });

    // Manually call issueCreditsForAllocation a second time (simulates concurrent retry)
    const { issueCreditsForAllocation } = await import('../../services/creditIssuanceService');
    await prisma.$transaction(tx =>
      issueCreditsForAllocation(tx, {
        paymentAllocationId: allocation.id,
        invoiceId:           invoice.id,
        newInvoiceStatus:    'PARTIALLY_PAID',
        schoolId:            school.id,
        studentProfileId:    student.id,
        actorId:             ownerUser.id,
      }),
    );

    const issuanceCount = await prisma.creditIssuance.count({ where: { studentProfileId: student.id } });
    expect(issuanceCount).toBe(1);

    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profile.credits).toBe(5); // no double-issue
  });
});

// ─── Test 7: payment void reverses credits ────────────────────────────────────

describe('credit issuance — payment void reversal', () => {
  it('voiding payment reverses all issued credits and decrements StudentProfile.credits', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '1000', creditsToIssue: 10 });
    const { payment } = await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '1000' });

    // Confirm credits were issued
    const profileBefore = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profileBefore.credits).toBe(10);

    await prisma.$transaction(tx =>
      voidPayment(tx, { paymentId: payment.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    const profileAfter = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profileAfter.credits).toBe(0);

    const issuance = await prisma.creditIssuance.findFirst({ where: { studentProfileId: student.id } });
    expect(issuance!.reversedAt).not.toBeNull();
    expect(issuance!.reversalLogId).not.toBeNull();
  });
});

// ─── Test 8: LessonCreditLog type=PAYMENT ─────────────────────────────────────

describe('credit issuance — LessonCreditLog type=PAYMENT', () => {
  it('creates LessonCreditLog with type=PAYMENT and paymentId set', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '1000', creditsToIssue: 8 });
    const { payment } = await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '1000' });

    const log = await prisma.lessonCreditLog.findFirst({
      where: { studentProfileId: student.id, type: 'PAYMENT' },
    });
    expect(log).not.toBeNull();
    expect(log!.amount).toBe(8);
    expect(log!.paymentId).toBe(payment.id);
  });
});

// ─── Test 9: LessonCreditLog CORRECTION on reversal ──────────────────────────

describe('credit issuance — LessonCreditLog CORRECTION on reversal', () => {
  it('creates LessonCreditLog with type=CORRECTION and negative amount on void', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '1000', creditsToIssue: 8 });
    const { payment } = await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '1000' });

    await prisma.$transaction(tx =>
      voidPayment(tx, { paymentId: payment.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    const correctionLog = await prisma.lessonCreditLog.findFirst({
      where: { studentProfileId: student.id, type: 'CORRECTION' },
    });
    expect(correctionLog).not.toBeNull();
    expect(correctionLog!.amount).toBe(-8);
    expect(correctionLog!.paymentId).toBe(payment.id);
  });
});

// ─── Test 10: invoice with only MATERIAL/REGISTRATION lines ──────────────────

describe('credit issuance — non-TUITION invoice', () => {
  it('does not create CreditIssuance for invoice with only MATERIAL lines', async () => {
    const { school, ownerUser, student } = await setup();

    // Create invoice with MATERIAL + REGISTRATION lines only
    const inv = await prisma.$transaction(tx =>
      createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
    );
    await prisma.$transaction(tx =>
      addLine(tx, { invoiceId: inv.id, schoolId: school.id, type: 'MATERIAL', description: 'Books', quantity: '1', unitPrice: '200' }),
    );
    await prisma.$transaction(tx =>
      addLine(tx, { invoiceId: inv.id, schoolId: school.id, type: 'REGISTRATION', description: 'Reg fee', quantity: '1', unitPrice: '300' }),
    );
    const issued = await prisma.$transaction(tx =>
      issueInvoice(tx, { invoiceId: inv.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    await payInvoice({ school, student, ownerUser, invoiceId: issued.id, amount: '500' });

    const issuanceCount = await prisma.creditIssuance.count({ where: { studentProfileId: student.id } });
    expect(issuanceCount).toBe(0);
    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profile.credits).toBe(0);
  });
});

// ─── Test 11: Decimal-safe 15 credits, 3×1/3 payments ────────────────────────

describe('credit issuance — Decimal-safe rounding', () => {
  it('15 credits, 3 × 1/3 payments → floor(5)+floor(5)+reconcile(5) = 15 exactly', async () => {
    const { school, ownerUser, student } = await setup();
    // 15 credits, invoice = 300, 3 × 100
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '300', creditsToIssue: 15 });

    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '100' });
    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '100' });
    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '100' });

    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profile.credits).toBe(15);

    const issuances = await prisma.creditIssuance.findMany({ where: { studentProfileId: student.id } });
    const total = issuances.reduce((s, i) => s + i.creditsIssued, 0);
    expect(total).toBe(15);
  });
});

// ─── Test 12: creditsToIssue=null on TUITION → no issuance ───────────────────

describe('credit issuance — creditsToIssue null', () => {
  it('does not issue credits when TUITION line has creditsToIssue=null', async () => {
    const { school, ownerUser, student } = await setup();
    // Pass creditsToIssue: null explicitly
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '1000', creditsToIssue: null });
    await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '1000' });

    const issuanceCount = await prisma.creditIssuance.count({ where: { studentProfileId: student.id } });
    expect(issuanceCount).toBe(0);
    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    expect(profile.credits).toBe(0);
  });
});

// ─── Test 13: audit events in ScheduleActionLog ───────────────────────────────

describe('credit issuance — audit events', () => {
  it('writes CREDITS_ISSUED_FROM_PAYMENT and CREDIT_ISSUANCE_REVERSED to ScheduleActionLog', async () => {
    const { school, ownerUser, student } = await setup();
    const invoice = await makeIssuedInvoice({ school, student, ownerUser, unitPrice: '1000', creditsToIssue: 5 });
    const { payment } = await payInvoice({ school, student, ownerUser, invoiceId: invoice.id, amount: '1000' });

    const issuedLog = await prisma.scheduleActionLog.findFirst({
      where: { schoolId: school.id, action: 'CREDITS_ISSUED_FROM_PAYMENT' },
    });
    expect(issuedLog).not.toBeNull();

    await prisma.$transaction(tx =>
      voidPayment(tx, { paymentId: payment.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    const reversedLog = await prisma.scheduleActionLog.findFirst({
      where: { schoolId: school.id, action: 'CREDIT_ISSUANCE_REVERSED' },
    });
    expect(reversedLog).not.toBeNull();
  });
});
