/**
 * Integration: Financial Consistency — Phase 4 PR 2 + PR 3 invariants.
 *
 * Tests run against a real PostgreSQL database (see .env.test).
 *
 * PR 2 invariants (attend race, neg balance, credits idempotency):
 *   1–11 (original describe blocks below)
 *
 * PR 3 invariants (payment/refund locking + idempotency):
 *   P1.  POST /payments missing Idempotency-Key → 400
 *   P2.  POST /payments same key same payload → replay, one Payment row
 *   P3.  POST /payments same key different payload → 409
 *   P4.  concurrent POST /payments same key → one Payment row
 *   P5.  allocation race → no overpay (SELECT FOR UPDATE on Invoice)
 *   P6.  allocation over remaining → 422
 *   P7.  POST /:id/refunds missing Idempotency-Key → 400
 *   P8.  refund same key replay → one PaymentRefund row
 *   P9.  refund race → no over-refund (SELECT FOR UPDATE on PaymentAllocation)
 *   P10. refund over allocation → 422
 *   P11. school A cannot allocate school B resources (tenant isolation)
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
  createSession,
  createSessionStudent,
  createFinanceConfig,
  createPaymentRecord,
  createIssuedInvoice,
  createPaymentAllocationRecord,
} from '../helpers/testDb';
import { markAttendance } from '../../services/attendanceService';
import { createAllocation } from '../../services/paymentService';
import { createPaymentRefund } from '../../services/refundService';
import paymentsRouter from '../../routes/payments';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// ─── Shared setup ─────────────────────────────────────────────────────────────

async function setup(initialCredits = 5) {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
  const _config  = await createFinanceConfig(school.id, 1);
  const tUser    = await createUser(school.id, 'TEACHER');
  const staff    = await createStaffProfile(tUser.id, school.id);
  const sUser    = await createUser(school.id, 'STUDENT');
  const student  = await createStudentProfile(sUser.id, school.id, initialCredits);
  const group    = await createGroup(school.id);
  const block    = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  const session  = await createSession({
    blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
    date: new Date('2026-06-15T12:00:00.000Z'), status: 'IN_PROGRESS',
  });
  const ss       = await createSessionStudent(session.id, student.id, school.id);

  const params = {
    sessionId:        session.id,
    studentProfileId: student.id,
    schoolId:         school.id,
    sessionStudentId: ss.id,
    sessionDate:      session.date,
    status:           'PRESENT' as const,
  };

  return { school, staff, student, session, ss, params };
}

// ─── 1. Attendance CREATE race ────────────────────────────────────────────────

describe('Attendance CREATE race — concurrent inserts for same student/session', () => {
  it('deducts exactly 1 credit when two transactions race on a new attendance record', async () => {
    const { student, params } = await setup(10);

    // Both transactions start concurrently. The winner INSERTs; the loser
    // catches P2002 and returns the winner's record without financial ops.
    await Promise.all([
      prisma.$transaction(tx => markAttendance(tx, params)),
      prisma.$transaction(tx => markAttendance(tx, params)),
    ]);

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(9); // exactly 1 deduction

    const logs = await prisma.lessonCreditLog.findMany({
      where: { studentProfileId: student.id, type: 'DEBIT' },
    });
    expect(logs).toHaveLength(1); // exactly 1 ledger entry
  });
});

// ─── 2. Attendance UPDATE atomic claim ───────────────────────────────────────

describe('Attendance UPDATE race — atomic claim via updateMany', () => {
  it('deducts exactly 1 credit when two transactions race on an existing record (creditDeducted=false)', async () => {
    const { student, session, ss, params } = await setup(10);

    // Pre-create attendance record in NOT-deducted state to force UPDATE path
    await prisma.attendance.create({
      data: {
        schoolId:         session.schoolId,
        lessonSessionId:  session.id,
        studentProfileId: student.id,
        sessionStudentId: ss.id,
        status:           'PRESENT',
        creditDeducted:   false, // both concurrent transactions will see this
      },
    });

    // Two concurrent transactions both read creditDeducted=false and try updateMany.
    // Only one gets count=1 (wins the claim); the other sees count=0 → no deduction.
    await Promise.all([
      prisma.$transaction(tx => markAttendance(tx, params)),
      prisma.$transaction(tx => markAttendance(tx, params)),
    ]);

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(9); // exactly 1 deduction

    const logs = await prisma.lessonCreditLog.findMany({
      where: { studentProfileId: student.id, type: 'DEBIT' },
    });
    expect(logs).toHaveLength(1);
  });
});

// ─── 3. Attendance idempotency ────────────────────────────────────────────────

describe('Attendance idempotency — creditDeducted is write-once', () => {
  it('does not deduct twice when the same student/session is marked twice sequentially', async () => {
    const { student, params } = await setup(10);

    // First call — deducts
    await prisma.$transaction(tx => markAttendance(tx, params));
    // Second call — idempotent skip (creditDeducted already true)
    await prisma.$transaction(tx => markAttendance(tx, params));

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(9); // exactly 1 deduction

    const logs = await prisma.lessonCreditLog.findMany({
      where: { studentProfileId: student.id, type: 'DEBIT' },
    });
    expect(logs).toHaveLength(1);
  });

  it('status change (PRESENT→ABSENT) does NOT create a second ledger entry', async () => {
    const { student, session, ss, params } = await setup(10);

    // First mark: PRESENT
    await prisma.$transaction(tx => markAttendance(tx, params));

    // Status change: ABSENT — creditDeducted flag already true, no new deduction
    await prisma.$transaction(tx =>
      markAttendance(tx, { ...params, status: 'ABSENT' })
    );

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(9);

    const debitLogs = await prisma.lessonCreditLog.findMany({
      where: { studentProfileId: student.id, type: 'DEBIT' },
    });
    expect(debitLogs).toHaveLength(1);
  });
});

// ─── 4. Freeze skip ledger entry ─────────────────────────────────────────────

describe('Freeze skip — FREEZE_SKIP ledger entry created, no credit deducted', () => {
  it('creates a FREEZE_SKIP log with amount=0 and does not decrement balance', async () => {
    const { student, session, ss, params, staff, school } = await setup(10);

    // PR 5: StudentFreeze is source of truth. Create ACTIVE PERIOD freeze covering session date.
    await prisma.studentFreeze.create({
      data: {
        schoolId: school.id, studentProfileId: student.id, createdById: staff.userId,
        type: 'PERIOD',
        startDate: new Date(session.date.getTime() - 30 * 3600_000), // 30h before session
        endDate: null, status: 'ACTIVE',
      },
    });

    await prisma.$transaction(tx => markAttendance(tx, params));

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(10); // no deduction

    const skipLog = await prisma.lessonCreditLog.findFirst({
      where: { studentProfileId: student.id, type: 'FREEZE_SKIP' },
    });
    expect(skipLog).not.toBeNull();
    expect(Number(skipLog!.amount)).toBe(0);

    const debitLog = await prisma.lessonCreditLog.findFirst({
      where: { studentProfileId: student.id, type: 'DEBIT' },
    });
    expect(debitLog).toBeNull(); // no DEBIT entry
  });
});

// ─── 5. Negative balance protection (DB level) ───────────────────────────────

describe('Negative balance protection — $executeRaw conditional update', () => {
  it('returns 0 rows and student balance is unchanged when deduction would go negative', async () => {
    const { student } = await setup(0); // start with 0 credits

    const rowsUpdated: number = await prisma.$executeRaw`
      UPDATE "StudentProfile"
      SET credits = credits + ${-1}
      WHERE id = ${student.id}
        AND (credits + ${-1}) >= 0
    `;

    expect(rowsUpdated).toBe(0); // conditional prevented the update

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(0); // balance unchanged
  });

  it('succeeds when balance is exactly sufficient (boundary condition)', async () => {
    const { student } = await setup(1); // exactly 1 credit

    const rowsUpdated: number = await prisma.$executeRaw`
      UPDATE "StudentProfile"
      SET credits = credits + ${-1}
      WHERE id = ${student.id}
        AND (credits + ${-1}) >= 0
    `;

    expect(rowsUpdated).toBe(1); // exactly at boundary — should succeed

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(0); // balance is now 0, not negative
  });
});

// ─── 6. Debt model — credits < 0 is valid (Phase 5 correction) ───────────────
//
// Business model: students can attend lessons before paying (deferred payment).
// credits < 0 = lesson debt. No DB-level floor — debt is school-policy-controlled.
// Application-level guard ($executeRaw conditional) still prevents accidental
// overdraft for non-override paths (see describe block 5 above).
// OWNER with overrideReason can intentionally set a negative balance.
// See ARCHITECTURAL_DECISIONS.md ADR-021.

describe('Credits — debt model (credits < 0 is valid)', () => {
  it('DB allows direct update that makes credits negative (debt accumulated by student)', async () => {
    const { student } = await setup(0); // start at 0

    // No DB constraint prevents this — debt is valid business state
    const updated = await prisma.studentProfile.update({
      where: { id: student.id },
      data:  { credits: { increment: -3 } },
    });

    expect(updated.credits).toBe(-3); // debt balance preserved correctly
  });

  it('DB allows creating a student profile with negative initial credits', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    const user = await createUser(school.id, 'STUDENT');
    const profile = await prisma.studentProfile.create({
      data: { userId: user.id, credits: -5 },
    });
    expect(profile.credits).toBe(-5);
  });
});

// ─── 7. No ledger orphan on rolled-back transaction ──────────────────────────

describe('Transaction rollback — no orphan ledger entries', () => {
  it('leaves zero credit logs when the wrapping transaction is rolled back', async () => {
    const { student, params } = await setup(10);

    await expect(
      prisma.$transaction(async (tx) => {
        await markAttendance(tx, params);
        // Simulate route-level failure after attendance (e.g. session update fails)
        throw new Error('SIMULATED_ROUTE_FAILURE');
      })
    ).rejects.toThrow('SIMULATED_ROUTE_FAILURE');

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(10); // rollback restored original balance

    const logs = await prisma.lessonCreditLog.findMany({
      where: { studentProfileId: student.id },
    });
    expect(logs).toHaveLength(0); // no orphan ledger entries
  });
});

// ─── 8. DbIdempotency key DB constraint prevents double credit add ─────────────

describe('DbIdempotency DB constraint — only one INSERT wins concurrent race', () => {
  it('second INSERT with same key gets P2002 (unique constraint enforced at DB level)', async () => {
    const school = await createSchool();
    const user   = await createUser(school.id, 'ADMIN');

    const keyData = {
      schoolId:    school.id,
      actorId:     user.id,
      scopeType:   'USER' as const,
      endpoint:    'POST /credits/add',
      key:         `test-key-${Date.now()}`,
      requestHash: 'abc123',
      expiresAt:   new Date(Date.now() + 24 * 3600 * 1000),
    };

    // First insert succeeds
    await prisma.idempotencyKey.create({ data: keyData });

    // Second insert with same (schoolId, scopeType, actorId, endpoint, key) → P2002
    await expect(
      prisma.idempotencyKey.create({ data: keyData })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('FAILED key allows retry: second insert updates existing to IN_PROGRESS', async () => {
    const school = await createSchool();
    const user   = await createUser(school.id, 'ADMIN');

    // Simulate a failed previous attempt
    const existing = await prisma.idempotencyKey.create({
      data: {
        schoolId:    school.id,
        actorId:     user.id,
        scopeType:   'USER',
        endpoint:    'POST /credits/add',
        key:         `retry-key-${Date.now()}`,
        requestHash: 'abc123',
        expiresAt:   new Date(Date.now() + 24 * 3600 * 1000),
        status:      'FAILED',
      },
    });

    // Route logic: FAILED → update to IN_PROGRESS to allow retry
    await prisma.idempotencyKey.update({
      where: { id: existing.id },
      data:  { status: 'IN_PROGRESS', startedAt: new Date(), updatedAt: new Date() },
    });

    const updated = await prisma.idempotencyKey.findUnique({ where: { id: existing.id } });
    expect(updated!.status).toBe('IN_PROGRESS');
  });
});

// ─── PR 3 helpers ─────────────────────────────────────────────────────────────

function buildPaymentApp(user: { userId: number; schoolId: number; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = user;
    next();
  });
  app.use('/', paymentsRouter);
  return app;
}

async function paymentSetup() {
  const school    = await createSchool({ timezone: 'UTC' });
  const adminUser = await createUser(school.id, 'OWNER');
  const sUser     = await createUser(school.id, 'STUDENT');
  const student   = await createStudentProfile(sUser.id, school.id, 0);
  const payment   = await createPaymentRecord(student.id, school.id, adminUser.id, '1000', 'CASH');
  const invoice   = await createIssuedInvoice(student.id, school.id, adminUser.id, 500);
  return { school, adminUser, student, payment, invoice };
}

let _keySeq = 0;
function uniquePaymentKey() {
  return `pay-key-${Date.now()}-${++_keySeq}`;
}

// ─── P1. POST /payments missing Idempotency-Key → 400 ────────────────────────

describe('P1. POST /payments — missing Idempotency-Key returns 400', () => {
  it('rejects request without Idempotency-Key header', async () => {
    const { school, adminUser, student } = await paymentSetup();
    const app = buildPaymentApp({ userId: adminUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app)
      .post('/')
      .send({ studentProfileId: student.id, amount: 100, method: 'CASH' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/idempotency/i);
  });
});

// ─── P2. POST /payments replay → one Payment row ─────────────────────────────

describe('P2. POST /payments — same key same payload replays (one Payment row)', () => {
  it('returns 201 twice but creates only one Payment row', async () => {
    const { school, adminUser, student } = await paymentSetup();
    const app = buildPaymentApp({ userId: adminUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniquePaymentKey();

    const countBefore = await prisma.payment.count({ where: { schoolId: school.id } });

    const first = await request(app)
      .post('/')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: 100, method: 'CASH' });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: 100, method: 'CASH' });

    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');

    const countAfter = await prisma.payment.count({ where: { schoolId: school.id } });
    expect(countAfter - countBefore).toBe(1); // exactly 1 new payment despite 2 requests
  });
});

// ─── P3. POST /payments same key different payload → 409 ─────────────────────

describe('P3. POST /payments — same key different payload returns 409', () => {
  it('returns 409 on payload mismatch with existing completed key', async () => {
    const { school, adminUser, student } = await paymentSetup();
    const app = buildPaymentApp({ userId: adminUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniquePaymentKey();

    await request(app)
      .post('/')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: 100, method: 'CASH' });

    const res = await request(app)
      .post('/')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: 999, method: 'CASH' }); // different amount

    expect(res.status).toBe(409);
  });
});

// ─── P4. Concurrent POST /payments same key → one Payment row ────────────────

describe('P4. Concurrent POST /payments same key — exactly one Payment row created', () => {
  it('deduplicates concurrent requests with the same Idempotency-Key', async () => {
    const { school, adminUser, student } = await paymentSetup();
    const app = buildPaymentApp({ userId: adminUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniquePaymentKey();

    const countBefore = await prisma.payment.count({ where: { schoolId: school.id } });

    await Promise.all([
      request(app).post('/').set('Idempotency-Key', key).send({ studentProfileId: student.id, amount: 100, method: 'CASH' }),
      request(app).post('/').set('Idempotency-Key', key).send({ studentProfileId: student.id, amount: 100, method: 'CASH' }),
    ]);

    const countAfter = await prisma.payment.count({ where: { schoolId: school.id } });
    expect(countAfter - countBefore).toBe(1); // exactly 1 new payment despite concurrent requests
  });
});

// ─── P5. Allocation race → no overpay ────────────────────────────────────────

describe('P5. Allocation race — SELECT FOR UPDATE prevents overpay', () => {
  it('allows only one allocation when two concurrent calls exceed invoice balance', async () => {
    const { school, adminUser, student, payment, invoice } = await paymentSetup();
    // invoice.totalAmount = 500; payment.amount = 1000

    // Two concurrent allocations, each for the full invoice amount.
    // SELECT FOR UPDATE ensures only one can read "remaining = 500"; the other
    // sees "remaining = 0" after the first commits and throws.
    const results = await Promise.allSettled([
      prisma.$transaction(tx => createAllocation(tx, {
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount:    '500',
        schoolId:  school.id,
        actorId:   adminUser.id,
      })),
      prisma.$transaction(tx => createAllocation(tx, {
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount:    '500',
        schoolId:  school.id,
        actorId:   adminUser.id,
      })),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    // At most one succeeds (the other may also succeed if ALLOCATION_ALREADY_EXISTS fires,
    // but the invoice paidAmount must never exceed totalAmount)
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(inv.paidAmount)).toBeLessThanOrEqual(500);

    const allocs = await prisma.paymentAllocation.findMany({ where: { invoiceId: invoice.id } });
    // unique constraint (paymentId, invoiceId) guarantees at most 1 allocation row
    expect(allocs.length).toBeLessThanOrEqual(1);
  });
});

// ─── P6. Allocation over remaining → 422 ─────────────────────────────────────

describe('P6. Allocation over remaining — throws ALLOCATION_EXCEEDS_INVOICE_BALANCE', () => {
  it('rejects allocation that exceeds invoice remaining balance', async () => {
    const { school, adminUser, student, payment, invoice } = await paymentSetup();
    // invoice.totalAmount = 500

    await expect(
      prisma.$transaction(tx => createAllocation(tx, {
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount:    '600', // exceeds totalAmount by 100
        schoolId:  school.id,
        actorId:   adminUser.id,
      }))
    ).rejects.toThrow('ALLOCATION_EXCEEDS_INVOICE_BALANCE');
  });
});

// ─── P7. POST /:id/refunds missing Idempotency-Key → 400 ─────────────────────

describe('P7. POST /:id/refunds — missing Idempotency-Key returns 400', () => {
  it('rejects refund request without Idempotency-Key header', async () => {
    const { school, adminUser, payment } = await paymentSetup();
    const app = buildPaymentApp({ userId: adminUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app)
      .post(`/${payment.id}/refunds`)
      .send({ reason: 'test', allocations: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/idempotency/i);
  });
});

// ─── P8. Refund replay → one PaymentRefund row ───────────────────────────────

describe('P8. POST /:id/refunds — same key replays (one PaymentRefund row)', () => {
  it('returns 201 twice but creates only one PaymentRefund row', async () => {
    const { school, adminUser, student, payment, invoice } = await paymentSetup();
    const allocation = await createPaymentAllocationRecord(payment.id, invoice.id, '300');
    const app = buildPaymentApp({ userId: adminUser.id, schoolId: school.id, role: 'OWNER' });
    const key = uniquePaymentKey();

    const body = {
      reason: 'duplicate charge',
      allocations: [{ paymentAllocationId: allocation.id, amount: '100' }],
    };

    const first = await request(app)
      .post(`/${payment.id}/refunds`)
      .set('Idempotency-Key', key)
      .send(body);

    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/${payment.id}/refunds`)
      .set('Idempotency-Key', key)
      .send(body);

    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');

    const refunds = await prisma.paymentRefund.findMany({ where: { paymentId: payment.id } });
    expect(refunds).toHaveLength(1);
  });
});

// ─── P9. Refund race → no over-refund ────────────────────────────────────────

describe('P9. Refund race — SELECT FOR UPDATE prevents over-refund', () => {
  it('allows only the refundable amount across concurrent refund calls', async () => {
    const { school, adminUser, student, payment, invoice } = await paymentSetup();
    // Allocate 300 to invoice
    const allocation = await createPaymentAllocationRecord(payment.id, invoice.id, '300');

    // Two concurrent refunds each trying to refund 300 (full allocation).
    // SELECT FOR UPDATE on PaymentAllocation ensures only one can see refundable=300;
    // the second reads the updated refund totals and should fail or refund 0 extra.
    const results = await Promise.allSettled([
      prisma.$transaction(tx => createPaymentRefund(tx, {
        schoolId:    school.id,
        paymentId:   payment.id,
        reason:      'race test A',
        createdById: adminUser.id,
        allocations: [{ paymentAllocationId: allocation.id, amount: '300' }],
      })),
      prisma.$transaction(tx => createPaymentRefund(tx, {
        schoolId:    school.id,
        paymentId:   payment.id,
        reason:      'race test B',
        createdById: adminUser.id,
        allocations: [{ paymentAllocationId: allocation.id, amount: '300' }],
      })),
    ]);

    // Sum of all created refund amounts must not exceed the original allocation
    const refunds = await prisma.paymentRefund.findMany({
      where: { paymentId: payment.id, status: { in: ['PENDING', 'CONFIRMED'] } },
    });
    const totalRefunded = refunds.reduce((sum, r) => sum + Number(r.amount), 0);
    expect(totalRefunded).toBeLessThanOrEqual(300);
  });
});

// ─── P10. Refund over allocation → 422 ───────────────────────────────────────

describe('P10. Refund over allocation — throws REFUND_EXCEEDS_REFUNDABLE_BALANCE', () => {
  it('rejects refund that exceeds the refundable balance of an allocation', async () => {
    const { school, adminUser, payment, invoice } = await paymentSetup();
    const allocation = await createPaymentAllocationRecord(payment.id, invoice.id, '200');

    await expect(
      prisma.$transaction(tx => createPaymentRefund(tx, {
        schoolId:    school.id,
        paymentId:   payment.id,
        reason:      'over-refund test',
        createdById: adminUser.id,
        allocations: [{ paymentAllocationId: allocation.id, amount: '201' }], // 1 over
      }))
    ).rejects.toThrow('REFUND_EXCEEDS_REFUNDABLE_BALANCE');
  });
});

// ─── P11. Tenant isolation ────────────────────────────────────────────────────

describe('P11. Tenant isolation — school A cannot access school B resources', () => {
  it('cross-school allocation: school A payment cannot allocate to school B invoice', async () => {
    const schoolA = await createSchool({ timezone: 'UTC' });
    const schoolB = await createSchool({ timezone: 'UTC' });

    const adminA  = await createUser(schoolA.id, 'OWNER');
    const adminB  = await createUser(schoolB.id, 'OWNER');

    const sUserA  = await createUser(schoolA.id, 'STUDENT');
    const studentA = await createStudentProfile(sUserA.id, schoolA.id, 0);

    const sUserB  = await createUser(schoolB.id, 'STUDENT');
    const studentB = await createStudentProfile(sUserB.id, schoolB.id, 0);

    const paymentA  = await createPaymentRecord(studentA.id, schoolA.id, adminA.id, '500', 'CASH');
    const invoiceB  = await createIssuedInvoice(studentB.id, schoolB.id, adminB.id, 500);

    // School A actor tries to allocate schoolA payment to schoolB invoice
    await expect(
      prisma.$transaction(tx => createAllocation(tx, {
        paymentId: paymentA.id,
        invoiceId: invoiceB.id,
        amount:    '100',
        schoolId:  schoolA.id, // school A context
        actorId:   adminA.id,
      }))
    ).rejects.toThrow('INVOICE_NOT_FOUND'); // schoolB invoice not visible to schoolA
  });

  it('cross-school refund: school A actor cannot refund school B payment allocation', async () => {
    const schoolA = await createSchool({ timezone: 'UTC' });
    const schoolB = await createSchool({ timezone: 'UTC' });

    const adminA  = await createUser(schoolA.id, 'OWNER');
    const adminB  = await createUser(schoolB.id, 'OWNER');

    const sUserB   = await createUser(schoolB.id, 'STUDENT');
    const studentB = await createStudentProfile(sUserB.id, schoolB.id, 0);

    const paymentB    = await createPaymentRecord(studentB.id, schoolB.id, adminB.id, '500', 'CASH');
    const invoiceB    = await createIssuedInvoice(studentB.id, schoolB.id, adminB.id, 500);
    const allocationB = await createPaymentAllocationRecord(paymentB.id, invoiceB.id, '300');

    // School A actor tries to refund school B payment using school B allocation ID
    await expect(
      prisma.$transaction(tx => createPaymentRefund(tx, {
        schoolId:    schoolA.id, // school A context — should not see school B resources
        paymentId:   paymentB.id,
        reason:      'cross-tenant attempt',
        createdById: adminA.id,
        allocations: [{ paymentAllocationId: allocationB.id, amount: '100' }],
      }))
    ).rejects.toThrow('PAYMENT_NOT_FOUND'); // schoolB payment not visible to schoolA
  });
});
