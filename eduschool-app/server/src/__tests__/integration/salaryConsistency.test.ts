/**
 * Integration: Salary Consistency — Phase 4 PR 4 invariants.
 *
 * Tests run against a real PostgreSQL database (see .env.test).
 *
 * S1.  POST /salary/pay — missing Idempotency-Key → 400
 * S2.  POST /salary/pay — same key same payload → replay, one TeacherPayment
 * S3.  POST /salary/pay — same key different payload → 409
 * S4.  POST /salary/pay — concurrent same key → one TeacherPayment
 * S5.  POST /salary/pay — different key same sessions → 409 SESSIONS_ALREADY_PAID
 * S6.  POST /salary/adjustment — missing Idempotency-Key → 400
 * S7.  POST /salary/adjustment — same key same payload → replay, one SalaryAdjustment
 * S8.  POST /salary/adjustment — same key different payload → 409
 * S9.  POST /salary/adjustment — concurrent same key → one SalaryAdjustment
 * S10. DELETE /salary/pay — without reason → 400
 * S11. DELETE /salary/pay — ADMIN role → 403
 * S12. DELETE /salary/pay — OWNER with reason → 200, audit log exists
 * S13. Two concurrent reverseCreditsForIssuance void-path → credits reversed once only
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStudentProfile,
  createStaffProfile,
  createGroup,
  createBlock,
  createTeacherPaymentRecord,
  createCompletedSessionWithAttendance,
  createFinanceConfig,
} from '../helpers/testDb';
import salaryRouter from '../../routes/salary';
import { reverseCreditsForIssuance } from '../../services/creditIssuanceService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// ─── App builder ──────────────────────────────────────────────────────────────

function buildSalaryApp(user: { userId: number; schoolId: number; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = user;
    next();
  });
  app.use('/', salaryRouter);
  return app;
}

let _keySeq = 0;
function uniqueKey() {
  return `salary-key-${Date.now()}-${++_keySeq}`;
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

async function setup() {
  const school = await createSchool({ timezone: 'UTC' });
  await createFinanceConfig(school.id, 1);
  const ownerUser = await createUser(school.id, 'OWNER');
  const adminUser = await createUser(school.id, 'ADMIN');
  const tUser = await createUser(school.id, 'TEACHER');
  const staff = await createStaffProfile(tUser.id, school.id, 5000);
  const sUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(sUser.id, school.id, 20);
  const group = await createGroup(school.id);
  const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, ownerUser, adminUser, staff, student, block };
}

// ─── S1. POST /salary/pay — missing Idempotency-Key → 400 ────────────────────

describe('S1. POST /salary/pay — missing Idempotency-Key returns 400', () => {
  it('rejects request without Idempotency-Key header', async () => {
    const { school, ownerUser, staff, student, block } = await setup();
    const session = await createCompletedSessionWithAttendance({
      blockId: block.id, schoolId: school.id,
      staffProfileId: staff.id, studentProfileId: student.id,
    });
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app)
      .post(`/pay/${staff.id}`)
      .send({ period: '2026-06', sessionIds: [session.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/idempotency/i);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

// ─── S2. POST /salary/pay — same key replay → one TeacherPayment ──────────────

describe('S2. POST /salary/pay — same key same payload → replay, one TeacherPayment row', () => {
  it('creates only one TeacherPayment on duplicate requests', async () => {
    const { school, ownerUser, staff, student, block } = await setup();
    const session = await createCompletedSessionWithAttendance({
      blockId: block.id, schoolId: school.id,
      staffProfileId: staff.id, studentProfileId: student.id,
    });
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniqueKey();
    const payload = { period: '2026-06', sessionIds: [session.id] };

    const countBefore = await prisma.teacherPayment.count({ where: { schoolId: school.id } });

    const first = await request(app).post(`/pay/${staff.id}`).set('Idempotency-Key', key).send(payload);
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);

    const second = await request(app).post(`/pay/${staff.id}`).set('Idempotency-Key', key).send(payload);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');

    const countAfter = await prisma.teacherPayment.count({ where: { schoolId: school.id } });
    expect(countAfter - countBefore).toBe(1);
  });
});

// ─── S3. POST /salary/pay — same key different payload → 409 ─────────────────

describe('S3. POST /salary/pay — same key different payload returns 409', () => {
  it('returns 409 on payload mismatch with completed key', async () => {
    const { school, ownerUser, staff, student, block } = await setup();
    const s1 = await createCompletedSessionWithAttendance({
      blockId: block.id, schoolId: school.id,
      staffProfileId: staff.id, studentProfileId: student.id,
      date: new Date('2026-06-02T12:00:00.000Z'),
    });
    const s2 = await createCompletedSessionWithAttendance({
      blockId: block.id, schoolId: school.id,
      staffProfileId: staff.id, studentProfileId: student.id,
      date: new Date('2026-06-04T12:00:00.000Z'),
    });
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniqueKey();

    await request(app)
      .post(`/pay/${staff.id}`)
      .set('Idempotency-Key', key)
      .send({ period: '2026-06', sessionIds: [s1.id] });

    const res = await request(app)
      .post(`/pay/${staff.id}`)
      .set('Idempotency-Key', key)
      .send({ period: '2026-06', sessionIds: [s2.id] }); // different sessionIds

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });
});

// ─── S4. Concurrent POST /salary/pay same key → one TeacherPayment ────────────

describe('S4. Concurrent POST /salary/pay same key → exactly one TeacherPayment', () => {
  it('deduplicates concurrent requests with the same Idempotency-Key', async () => {
    const { school, ownerUser, staff, student, block } = await setup();
    const session = await createCompletedSessionWithAttendance({
      blockId: block.id, schoolId: school.id,
      staffProfileId: staff.id, studentProfileId: student.id,
    });
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniqueKey();
    const payload = { period: '2026-06', sessionIds: [session.id] };

    const countBefore = await prisma.teacherPayment.count({ where: { schoolId: school.id } });

    await Promise.all([
      request(app).post(`/pay/${staff.id}`).set('Idempotency-Key', key).send(payload),
      request(app).post(`/pay/${staff.id}`).set('Idempotency-Key', key).send(payload),
    ]);

    const countAfter = await prisma.teacherPayment.count({ where: { schoolId: school.id } });
    expect(countAfter - countBefore).toBe(1);
  });
});

// ─── S5. Different key same sessions → 409 SESSIONS_ALREADY_PAID ─────────────

describe('S5. Different key same sessions → 409 SESSIONS_ALREADY_PAID', () => {
  it('rejects second payout for already-paid sessions under a different key', async () => {
    const { school, ownerUser, staff, student, block } = await setup();
    const session = await createCompletedSessionWithAttendance({
      blockId: block.id, schoolId: school.id,
      staffProfileId: staff.id, studentProfileId: student.id,
    });
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });
    const payload = { period: '2026-06', sessionIds: [session.id] };

    const first = await request(app)
      .post(`/pay/${staff.id}`)
      .set('Idempotency-Key', uniqueKey())
      .send(payload);
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/pay/${staff.id}`)
      .set('Idempotency-Key', uniqueKey()) // fresh key
      .send(payload);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SESSIONS_ALREADY_PAID');
  });
});

// ─── S6. POST /salary/adjustment — missing Idempotency-Key → 400 ─────────────

describe('S6. POST /salary/adjustment — missing Idempotency-Key returns 400', () => {
  it('rejects adjustment without Idempotency-Key header', async () => {
    const { school, ownerUser, staff } = await setup();
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app)
      .post('/adjustment')
      .send({ staffProfileId: staff.id, type: 'BONUS', amount: 1000, month: '2026-06' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

// ─── S7. POST /salary/adjustment — same key replay → one SalaryAdjustment ────

describe('S7. POST /salary/adjustment — same key replay → one SalaryAdjustment row', () => {
  it('creates only one SalaryAdjustment on duplicate requests', async () => {
    const { school, ownerUser, staff } = await setup();
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniqueKey();
    const payload = { staffProfileId: staff.id, type: 'BONUS', amount: 1000, month: '2026-06', reason: 'test bonus' };

    const countBefore = await prisma.salaryAdjustment.count({ where: { schoolId: school.id } });

    const first = await request(app).post('/adjustment').set('Idempotency-Key', key).send(payload);
    expect(first.status).toBe(200);

    const second = await request(app).post('/adjustment').set('Idempotency-Key', key).send(payload);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');

    const countAfter = await prisma.salaryAdjustment.count({ where: { schoolId: school.id } });
    expect(countAfter - countBefore).toBe(1);
  });
});

// ─── S8. POST /salary/adjustment — same key different payload → 409 ───────────

describe('S8. POST /salary/adjustment — same key different payload returns 409', () => {
  it('returns 409 on payload mismatch', async () => {
    const { school, ownerUser, staff } = await setup();
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniqueKey();

    await request(app)
      .post('/adjustment')
      .set('Idempotency-Key', key)
      .send({ staffProfileId: staff.id, type: 'BONUS', amount: 1000, month: '2026-06' });

    const res = await request(app)
      .post('/adjustment')
      .set('Idempotency-Key', key)
      .send({ staffProfileId: staff.id, type: 'BONUS', amount: 2000, month: '2026-06' }); // different amount

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });
});

// ─── S9. Concurrent POST /salary/adjustment same key → one SalaryAdjustment ──

describe('S9. Concurrent POST /salary/adjustment same key → exactly one SalaryAdjustment', () => {
  it('deduplicates concurrent adjustment requests with the same key', async () => {
    const { school, ownerUser, staff } = await setup();
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniqueKey();
    const payload = { staffProfileId: staff.id, type: 'FINE', amount: 500, month: '2026-06', reason: 'late' };

    const countBefore = await prisma.salaryAdjustment.count({ where: { schoolId: school.id } });

    await Promise.all([
      request(app).post('/adjustment').set('Idempotency-Key', key).send(payload),
      request(app).post('/adjustment').set('Idempotency-Key', key).send(payload),
    ]);

    const countAfter = await prisma.salaryAdjustment.count({ where: { schoolId: school.id } });
    expect(countAfter - countBefore).toBe(1);
  });
});

// ─── S10. DELETE /salary/pay — without reason → 400 ──────────────────────────

describe('S10. DELETE /salary/pay — without reason returns 400', () => {
  it('rejects deletion when reason is absent', async () => {
    const { school, ownerUser, staff } = await setup();
    const payment = await createTeacherPaymentRecord(staff.id, school.id, ownerUser.id);
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app)
      .delete(`/pay/${payment.id}`)
      .send({}); // no reason

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });

  it('rejects deletion when reason is empty string', async () => {
    const { school, ownerUser, staff } = await setup();
    const payment = await createTeacherPaymentRecord(staff.id, school.id, ownerUser.id);
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app)
      .delete(`/pay/${payment.id}`)
      .send({ reason: '   ' });

    expect(res.status).toBe(400);
  });
});

// ─── S11. DELETE /salary/pay — ADMIN role → 403 ───────────────────────────────

describe('S11. DELETE /salary/pay — ADMIN cannot delete salary payouts (403)', () => {
  it('returns 403 for ADMIN role (salary:pay is OWNER-only)', async () => {
    const { school, adminUser, staff } = await setup();
    const payment = await createTeacherPaymentRecord(staff.id, school.id, adminUser.id);
    const app = buildSalaryApp({ userId: adminUser.id, schoolId: school.id, role: 'ADMIN' });

    const res = await request(app)
      .delete(`/pay/${payment.id}`)
      .send({ reason: 'error correction' });

    expect(res.status).toBe(403);
  });
});

// ─── S12. DELETE /salary/pay — OWNER with reason → 200 + audit log ───────────

describe('S12. DELETE /salary/pay — OWNER with reason → 200, payment voided (not deleted), audit log exists', () => {
  it('voids payment (record stays, links removed) and writes SALARY_PAYMENT_VOIDED audit entry', async () => {
    const { school, ownerUser, staff } = await setup();
    const payment = await createTeacherPaymentRecord(staff.id, school.id, ownerUser.id);
    const app = buildSalaryApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app)
      .delete(`/pay/${payment.id}`)
      .send({ reason: 'Entered by mistake' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Payment record must survive as a VOIDED trail with who/why, lesson links removed
    const voided = await prisma.teacherPayment.findUnique({
      where: { id: payment.id },
      include: { sessions: true },
    });
    expect(voided).not.toBeNull();
    expect(voided!.status).toBe('VOIDED');
    expect(voided!.voidReason).toBe('Entered by mistake');
    expect(voided!.voidedById).toBe(ownerUser.id);
    expect(voided!.voidedAt).not.toBeNull();
    expect(voided!.sessions).toHaveLength(0);

    // Voiding twice must be rejected
    const again = await request(app)
      .delete(`/pay/${payment.id}`)
      .send({ reason: 'twice' });
    expect(again.status).toBe(409);

    // Audit log entry must exist — logFinanceAction fires async but awaited-ish
    // Give DB a tick to flush the fire-and-forget audit write
    await new Promise(r => setTimeout(r, 50));
    const auditEntry = await prisma.scheduleActionLog.findFirst({
      where: { schoolId: school.id, action: 'SALARY_PAYMENT_VOIDED' },
    });
    expect(auditEntry).not.toBeNull();
    expect((auditEntry!.after as any)?.reason).toBe('Entered by mistake');
  });
});

// ─── S13. Concurrent reverseCreditsForIssuance void-path → reversed once only ─

describe('S13. Concurrent reverseCreditsForIssuance void-path — credits reversed exactly once', () => {
  it('prevents double-reversal when two transactions concurrently reverse the same issuance', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const sUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id, 0);

    // Build the minimal DB chain: payment → invoice → allocation → issuance
    const payment = await prisma.payment.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        receivedById: ownerUser.id,
        amount: '500',
        method: 'CASH',
        status: 'CONFIRMED',
      },
    });

    const invoice = await prisma.invoice.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        createdById: ownerUser.id,
        status: 'PAID',
        totalAmount: '500',
        paidAmount: '500',
        currencyCode: 'KGS',
      },
    });

    // InvoiceLine requires quantity + unitPrice — use relational connect form
    const tuitionLine = await prisma.invoiceLine.create({
      data: {
        invoice:       { connect: { id: invoice.id } },
        type:          'TUITION',
        description:   'Test tuition',
        quantity:      '1',
        unitPrice:     '500',
        amount:        '500',
        creditsToIssue: 5,
      },
    });

    const allocation = await prisma.paymentAllocation.create({
      data: { paymentId: payment.id, invoiceId: invoice.id, amount: '500' },
    });

    // Plant issuance + credit log
    const creditLog = await prisma.lessonCreditLog.create({
      data: {
        schoolId:         school.id,
        studentProfileId: student.id,
        amount:           5,
        type:             'PAYMENT',
        reason:           'Test issuance',
        actorId:          ownerUser.id,
      },
    });

    const issuance = await prisma.creditIssuance.create({
      data: {
        schoolId:            school.id,
        paymentAllocationId: allocation.id,
        invoiceLineId:       tuitionLine.id,
        studentProfileId:    student.id,
        creditsIssued:       5,
        lessonCreditLogId:   creditLog.id,
        issuedById:          ownerUser.id,
      },
    });

    // Give student the 5 issued credits (simulates post-issuance state)
    await prisma.studentProfile.update({
      where: { id: student.id },
      data:  { credits: 5 },
    });

    // Two concurrent void-path reversals (no paymentRefundAllocationId).
    // SELECT FOR UPDATE inside reverseCreditsForIssuance serializes them:
    // the second reads remaining=0 after the first commits and returns early.
    const results = await Promise.allSettled([
      prisma.$transaction(tx => reverseCreditsForIssuance(tx, {
        creditIssuanceId: issuance.id,
        creditsToReverse: 5,
        schoolId:  school.id,
        actorId:   ownerUser.id,
        paymentId: payment.id,
        reason:    'payment voided concurrent A',
      })),
      prisma.$transaction(tx => reverseCreditsForIssuance(tx, {
        creditIssuanceId: issuance.id,
        creditsToReverse: 5,
        schoolId:  school.id,
        actorId:   ownerUser.id,
        paymentId: payment.id,
        reason:    'payment voided concurrent B',
      })),
    ]);

    expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);

    // Credits must be reversed exactly once — balance ≤ 0 (started 5, reversed ≤5)
    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBeGreaterThanOrEqual(0); // never negative from double-reversal

    // CreditIssuanceReversal total must not exceed issued amount
    const reversals = await prisma.creditIssuanceReversal.findMany({
      where: { creditIssuanceId: issuance.id },
    });
    const totalReversed = reversals.reduce((sum, r) => sum + r.creditsReversed, 0);
    expect(totalReversed).toBeLessThanOrEqual(5);
    expect(totalReversed).toBeGreaterThan(0);

    // Correction/refund ledger entries total must not exceed issued amount
    const reversalLogs = await prisma.lessonCreditLog.findMany({
      where: { studentProfileId: student.id, type: { in: ['CORRECTION', 'REFUND'] } },
    });
    const totalLogReversed = Math.abs(reversalLogs.reduce((sum, l) => sum + Number(l.amount), 0));
    expect(totalLogReversed).toBeLessThanOrEqual(5);
  });
});
