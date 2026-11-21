import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStudentProfile,
} from '../helpers/testDb';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.NODE_ENV = 'test';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const studentsRoutes = require('../../routes/students').default;
  const paymentsRoutes = require('../../routes/payments').default;
  const settingsRoutes = require('../../routes/settings').default;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  app.use('/students', studentsRoutes);
  app.use('/payments', paymentsRoutes);
  app.use('/settings', settingsRoutes);

  server = app.listen(0, () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    done();
  });
});

beforeEach(cleanDb);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
  await prisma.$disconnect();
});

function signAccess(user: any) {
  return jwt.sign(
    {
      userId: user.id,
      schoolId: user.schoolId ?? null,
      role: user.role,
      tokenVersion: user.tokenVersion ?? 0,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );
}

async function requestJson(
  path: string,
  options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

describe('Payment Idempotency Hardening Integration Tests', () => {
  it('1. POST /payments first request creates Payment, retry with same key does not create duplicate', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const studentUser = await createUser(school.id, 'STUDENT');
    const studentProfile = await createStudentProfile(studentUser.id, school.id);
    const token = signAccess(ownerUser);

    const idempotencyKey = 'unique-payment-key-1';

    // 1st request creates payment
    const res1 = await requestJson('/payments', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        studentProfileId: studentProfile.id,
        amount: 5000,
        method: 'CASH',
        note: 'Normal Payment',
      },
    });

    expect(res1.status).toBe(201);
    const paymentId = res1.body.data.payment.id;
    expect(paymentId).toBeDefined();

    // Verify exactly 1 payment in DB
    const initialCount = await prisma.payment.count({ where: { schoolId: school.id } });
    expect(initialCount).toBe(1);

    // Simulate crash scenario: delete or set the IdempotencyKey status to IN_PROGRESS and backdate it so it is stale.
    // This replicates the scenario where the transaction committed but the server crashed before completeIdempotency.
    await prisma.idempotencyKey.updateMany({
      where: { key: idempotencyKey },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago (stale)
      },
    });

    // 2nd request (stale retry) should find the existing payment and return it instead of inserting a duplicate
    const res2 = await requestJson('/payments', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        studentProfileId: studentProfile.id,
        amount: 5000,
        method: 'CASH',
        note: 'Normal Payment',
      },
    });

    expect(res2.status).toBe(201);
    expect(res2.body.data.payment.id).toBe(paymentId);

    // Check count is STILL 1 (no duplicates!)
    const finalCount = await prisma.payment.count({ where: { schoolId: school.id } });
    expect(finalCount).toBe(1);
  });

  it('2. POST /payments payload mismatch with same key returns 409 conflict', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const studentUser = await createUser(school.id, 'STUDENT');
    const studentProfile = await createStudentProfile(studentUser.id, school.id);
    const token = signAccess(ownerUser);

    const idempotencyKey = 'unique-payment-key-2';

    // 1st request
    await requestJson('/payments', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        studentProfileId: studentProfile.id,
        amount: 5000,
        method: 'CASH',
      },
    });

    // 2nd request with different amount and same key
    const res = await requestJson('/payments', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        studentProfileId: studentProfile.id,
        amount: 7000,
        method: 'CASH',
      },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });

  it('3. PATCH /students/:id quick payment validation and idempotency', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const adminUser = await createUser(school.id, 'ADMIN');
    const studentUser = await createUser(school.id, 'STUDENT');
    const studentProfile = await createStudentProfile(studentUser.id, school.id);
    const token = signAccess(ownerUser);

    // Set lesson price in configuration
    await prisma.schoolFinanceConfig.create({
      data: {
        schoolId: school.id,
        pricePerLesson: 200,
      },
    });

    // A. Profile update without payment does NOT require Idempotency-Key
    const resA = await requestJson(`/students/${studentUser.id}`, {
      method: 'PATCH',
      token,
      body: {
        notes: 'Updated student notes',
      },
    });
    expect(resA.status).toBe(200);

    // B. Quick payment WITHOUT Idempotency-Key returns 400
    const resB = await requestJson(`/students/${studentUser.id}`, {
      method: 'PATCH',
      token,
      body: {
        paymentAmount: 1000,
        paymentMethod: 'CASH',
      },
    });
    expect(resB.status).toBe(400);
    expect(resB.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    // C. Quick payment WITH Idempotency-Key creates payment, increments credits, and adds log
    const idempotencyKey = 'quick-payment-key-test';
    const resC = await requestJson(`/students/${studentUser.id}`, {
      method: 'PATCH',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        paymentAmount: 1000, // should add 5 credits (1000 / 200)
        paymentMethod: 'CASH',
        paymentNote: 'first quick payment',
      },
    });

    expect(resC.status).toBe(200);
    
    // Verify changes
    const profileAfter = await prisma.studentProfile.findUnique({ where: { id: studentProfile.id } });
    expect(profileAfter?.credits).toBe(15);

    const paymentCount = await prisma.studentPayment.count({ where: { schoolId: school.id } });
    expect(paymentCount).toBe(1);

    const creditLogCount = await prisma.lessonCreditLog.count({ where: { schoolId: school.id } });
    expect(creditLogCount).toBe(1);

    // Verify notifications were triggered (2 notifications: OWNER and ADMIN)
    const notifications = await prisma.notification.findMany({
      where: { schoolId: school.id, type: 'PAYMENT_CREATED' },
    });
    expect(notifications).toHaveLength(2);

    // D. Quick payment retry with same key does not double credits, StudentPayment or LessonCreditLog
    const resD = await requestJson(`/students/${studentUser.id}`, {
      method: 'PATCH',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        paymentAmount: 1000,
        paymentMethod: 'CASH',
        paymentNote: 'first quick payment',
      },
    });

    expect(resD.status).toBe(200);

    // Assert that credits were NOT incremented again (still 15)
    const profileFinal = await prisma.studentProfile.findUnique({ where: { id: studentProfile.id } });
    expect(profileFinal?.credits).toBe(15);

    // Assert counts did not double
    const finalPaymentCount = await prisma.studentPayment.count({ where: { schoolId: school.id } });
    expect(finalPaymentCount).toBe(1);

    const finalCreditLogCount = await prisma.lessonCreditLog.count({ where: { schoolId: school.id } });
    expect(finalCreditLogCount).toBe(1);

    // Assert notifications did not double
    const finalNotifications = await prisma.notification.findMany({
      where: { schoolId: school.id, type: 'PAYMENT_CREATED' },
    });
    expect(finalNotifications).toHaveLength(2); // Still 2, no duplicates triggered!
  });

  it('4. PATCH /students/:id quick payment banks remainders and carries them over', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const studentUser = await createUser(school.id, 'STUDENT');
    const studentProfile = await createStudentProfile(studentUser.id, school.id);
    const token = signAccess(ownerUser);

    // basePrice/billingDays drive the accumulator math (pricePerLesson is derived);
    // 200 / 1 makes the effective per-lesson price exactly 200 for clean arithmetic.
    await prisma.schoolFinanceConfig.create({
      data: { schoolId: school.id, basePrice: 200, billingDays: 1, pricePerLesson: 200 },
    });
    const creditsBefore = studentProfile.credits;

    // A. Payment below lesson price: 0 lessons, full amount banked in moneyBalance
    const resA = await requestJson(`/students/${studentUser.id}`, {
      method: 'PATCH',
      token,
      headers: { 'idempotency-key': 'carryover-key-1' },
      body: { paymentAmount: 150, paymentMethod: 'CASH' },
    });
    expect(resA.status).toBe(200);

    let profile = await prisma.studentProfile.findUnique({ where: { id: studentProfile.id } });
    expect(profile?.credits).toBe(creditsBefore);
    expect(Number(profile?.moneyBalance)).toBe(150);

    // Money is traced in StudentPayment even with 0 credits; credit ledger stays clean
    expect(await prisma.studentPayment.count({ where: { schoolId: school.id } })).toBe(1);
    expect(await prisma.lessonCreditLog.count({ where: { schoolId: school.id } })).toBe(0);

    // B. Second small payment crosses the price: total paid 150 + 100 = 250 → 1 lesson granted.
    // moneyBalance is an accumulator (never decremented), so it holds the raw 250 and
    // billingLessonsGranted tracks the 1 lesson already granted; the API derives the som
    // still banked toward the next lesson (moneyBanked = 250 − 200 = 50).
    const resB = await requestJson(`/students/${studentUser.id}`, {
      method: 'PATCH',
      token,
      headers: { 'idempotency-key': 'carryover-key-2' },
      body: { paymentAmount: 100, paymentMethod: 'CASH' },
    });
    expect(resB.status).toBe(200);
    expect(Number(resB.body.data.moneyBanked)).toBe(50);

    profile = await prisma.studentProfile.findUnique({ where: { id: studentProfile.id } });
    expect(profile?.credits).toBe(creditsBefore + 1);
    expect(Number(profile?.moneyBalance)).toBe(250);
    expect(profile?.billingLessonsGranted).toBe(1);
    expect(await prisma.lessonCreditLog.count({ where: { schoolId: school.id } })).toBe(1);

    // C. Absurd amount is rejected before touching the wallet
    const resC = await requestJson(`/students/${studentUser.id}`, {
      method: 'PATCH',
      token,
      headers: { 'idempotency-key': 'carryover-key-3' },
      body: { paymentAmount: 99_000_000, paymentMethod: 'CASH' },
    });
    expect(resC.status).toBe(400);
  });

  it('5. PATCH /settings/finance re-derives pricePerLesson when only one input changes', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const token = signAccess(ownerUser);

    await prisma.schoolFinanceConfig.create({
      data: { schoolId: school.id, basePrice: 5000, billingDays: 26, pricePerLesson: 193 },
    });

    // Only basePrice sent — pricePerLesson must not go stale
    const resA = await requestJson('/settings/finance', {
      method: 'PATCH',
      token,
      body: { basePrice: 6000 },
    });
    expect(resA.status).toBe(200);
    let cfg = await prisma.schoolFinanceConfig.findUnique({ where: { schoolId: school.id } });
    expect(cfg?.pricePerLesson).toBe(Math.ceil(6000 / 26)); // 231

    // Only billingDays sent
    const resB = await requestJson('/settings/finance', {
      method: 'PATCH',
      token,
      body: { billingDays: 30 },
    });
    expect(resB.status).toBe(200);
    cfg = await prisma.schoolFinanceConfig.findUnique({ where: { schoolId: school.id } });
    expect(cfg?.pricePerLesson).toBe(Math.ceil(6000 / 30)); // 200
  });
});
