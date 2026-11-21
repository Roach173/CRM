import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { Role, AdjType, ManualEntryType } from '@prisma/client';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStudentProfile,
  createStaffProfile,
  createSession,
  createSessionStudent,
  createGroup,
  createBlock,
} from '../helpers/testDb';
import { createDraft, addLine, issueInvoice } from '../../services/invoiceService';
import { createPayment, createAllocation } from '../../services/paymentService';
import { markAttendance } from '../../services/attendanceService';
import { invalidateUserCache } from '../../lib/userCache';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.NODE_ENV = 'test';

async function createTestUser(schoolId: number, role: 'OWNER' | 'ADMIN' | 'TEACHER' | 'STUDENT') {
  const user = await createUser(schoolId, role);
  await invalidateUserCache(user.id);
  return user;
}

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const paymentsRoutes = require('../../routes/payments').default;
  const salaryRoutes = require('../../routes/salary').default;
  const creditsRoutes = require('../../routes/credits').default;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  app.use('/payments', paymentsRoutes);
  app.use('/salary', salaryRoutes);
  app.use('/credits', creditsRoutes);

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

async function makeIssuedInvoice(opts: {
  schoolId: number;
  studentProfileId: number;
  actorId: number;
  total: string;
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

describe('Finance Phase 2B Idempotency Hardening Integration Tests', () => {
  it('1. POST /payments/:id/refunds idempotency check', async () => {
    const school = await createSchool();
    const ownerUser = await createTestUser(school.id, 'OWNER');
    const studentUser = await createTestUser(school.id, 'STUDENT');
    const student = await createStudentProfile(studentUser.id, school.id, 0);
    const token = signAccess(ownerUser);

    const invoice = await makeIssuedInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, total: '1000' });
    const { payment, allocation } = await payInvoice({ schoolId: school.id, studentProfileId: student.id, actorId: ownerUser.id, invoiceId: invoice.id, amount: '1000' });

    const idempotencyKey = 'unique-refund-key-1';

    // 1st request creates refund
    const res1 = await requestJson(`/payments/${payment.id}/refunds`, {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        reason: 'Refund customer',
        allocations: [{ paymentAllocationId: allocation.id, amount: '500' }],
      },
    });

    expect(res1.status).toBe(201);
    const refundId = res1.body.data.id;
    expect(refundId).toBeDefined();

    // Verify exactly 1 refund in DB
    const initialCount = await prisma.paymentRefund.count({ where: { schoolId: school.id } });
    expect(initialCount).toBe(1);

    // Simulate crash scenario by making the idempotency key stale and IN_PROGRESS
    await prisma.idempotencyKey.updateMany({
      where: { key: idempotencyKey },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    // 2nd request (retry) should return the existing refund
    const res2 = await requestJson(`/payments/${payment.id}/refunds`, {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        reason: 'Refund customer',
        allocations: [{ paymentAllocationId: allocation.id, amount: '500' }],
      },
    });

    expect(res2.status).toBe(201);
    expect(res2.body.data.id).toBe(refundId);

    // Count remains 1
    const finalCount = await prisma.paymentRefund.count({ where: { schoolId: school.id } });
    expect(finalCount).toBe(1);

    // payload mismatch with same key returns 409
    const res3 = await requestJson(`/payments/${payment.id}/refunds`, {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        reason: 'Refund customer',
        allocations: [{ paymentAllocationId: allocation.id, amount: '600' }],
      },
    });
    expect(res3.status).toBe(409);
    expect(res3.body.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });

  it('2. POST /salary/pay/:staffProfileId idempotency check', async () => {
    const school = await createSchool();
    const ownerUser = await createTestUser(school.id, 'OWNER');
    const teacherUser = await createTestUser(school.id, 'TEACHER');
    const staffProfile = await createStaffProfile(teacherUser.id, school.id, 2000);
    const token = signAccess(ownerUser);

    const studentUser = await createTestUser(school.id, 'STUDENT');
    const studentProfile = await createStudentProfile(studentUser.id, school.id, 10);

    // Setup completed sessions to pay
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staffProfile.id });
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staffProfile.id,
      date: new Date(),
      status: 'COMPLETED',
    });
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: studentProfile.id,
        status: 'PRESENT',
      },
    });

    const idempotencyKey = 'unique-salary-pay-key';

    // 1st request
    const res1 = await requestJson(`/salary/pay/${staffProfile.id}`, {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        period: '2026-06',
        sessionIds: [session.id],
        note: 'June Payout',
      },
    });

    expect(res1.status).toBe(200);
    const payoutId = res1.body.data.id;
    expect(payoutId).toBeDefined();

    // Verify 1 payment and 1 payment lesson link in DB
    expect(await prisma.teacherPayment.count({ where: { schoolId: school.id } })).toBe(1);
    expect(await prisma.teacherPaymentLesson.count({ where: { paymentId: payoutId } })).toBe(1);

    // Simulate crash scenario by making the idempotency key stale and IN_PROGRESS
    await prisma.idempotencyKey.updateMany({
      where: { key: idempotencyKey },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    // 2nd request (retry)
    const res2 = await requestJson(`/salary/pay/${staffProfile.id}`, {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        period: '2026-06',
        sessionIds: [session.id],
        note: 'June Payout',
      },
    });

    expect(res2.status).toBe(200);
    expect(res2.body.data.id).toBe(payoutId);

    // Verify counts did not double
    expect(await prisma.teacherPayment.count({ where: { schoolId: school.id } })).toBe(1);
    expect(await prisma.teacherPaymentLesson.count({ where: { paymentId: payoutId } })).toBe(1);

    // payload mismatch returns 409
    const res3 = await requestJson(`/salary/pay/${staffProfile.id}`, {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        period: '2026-07',
        sessionIds: [session.id],
      },
    });
    expect(res3.status).toBe(409);
  });

  it('3. POST /salary/adjustment idempotency check', async () => {
    const school = await createSchool();
    const ownerUser = await createTestUser(school.id, 'OWNER');
    const teacherUser = await createTestUser(school.id, 'TEACHER');
    const staffProfile = await createStaffProfile(teacherUser.id, school.id, 2000);
    const token = signAccess(ownerUser);

    const idempotencyKey = 'unique-salary-adj-key';

    // 1st request
    const res1 = await requestJson('/salary/adjustment', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        staffProfileId: staffProfile.id,
        type: 'BONUS',
        amount: 500,
        reason: 'Good job',
        month: '2026-06',
      },
    });

    expect(res1.status).toBe(200);
    const adjId = res1.body.data.id;
    expect(adjId).toBeDefined();

    expect(await prisma.salaryAdjustment.count({ where: { schoolId: school.id } })).toBe(1);

    // Simulate crash scenario by making the idempotency key stale and IN_PROGRESS
    await prisma.idempotencyKey.updateMany({
      where: { key: idempotencyKey },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    // 2nd request (retry)
    const res2 = await requestJson('/salary/adjustment', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        staffProfileId: staffProfile.id,
        type: 'BONUS',
        amount: 500,
        reason: 'Good job',
        month: '2026-06',
      },
    });

    expect(res2.status).toBe(200);
    expect(res2.body.data.id).toBe(adjId);

    expect(await prisma.salaryAdjustment.count({ where: { schoolId: school.id } })).toBe(1);

    // payload mismatch returns 409
    const res3 = await requestJson('/salary/adjustment', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        staffProfileId: staffProfile.id,
        type: 'FINE',
        amount: 200,
        reason: 'Late',
        month: '2026-06',
      },
    });
    expect(res3.status).toBe(409);
  });

  it('4. POST /credits/add idempotency check', async () => {
    const school = await createSchool();
    const ownerUser = await createTestUser(school.id, 'OWNER');
    const studentUser = await createTestUser(school.id, 'STUDENT');
    const studentProfile = await createStudentProfile(studentUser.id, school.id, 10);
    const token = signAccess(ownerUser);

    const idempotencyKey = 'unique-credits-add-key';

    // 1st request
    const res1 = await requestJson('/credits/add', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        studentProfileId: studentProfile.id,
        amount: 5,
        reason: 'Manual adjustment',
      },
    });

    expect(res1.status).toBe(200);
    expect(res1.body.data.log.id).toBeDefined();

    const profileAfter = await prisma.studentProfile.findUniqueOrThrow({ where: { id: studentProfile.id } });
    expect(profileAfter.credits).toBe(15);

    expect(await prisma.lessonCreditLog.count({ where: { schoolId: school.id } })).toBe(1);

    // Simulate crash scenario by making the idempotency key stale and IN_PROGRESS
    await prisma.idempotencyKey.updateMany({
      where: { key: idempotencyKey },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    // 2nd request (retry)
    const res2 = await requestJson('/credits/add', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        studentProfileId: studentProfile.id,
        amount: 5,
        reason: 'Manual adjustment',
      },
    });

    expect(res2.status).toBe(200);
    expect(res2.body.data.log.id).toBe(res1.body.data.log.id);

    // Credits do not double (remains 15)
    const profileFinal = await prisma.studentProfile.findUniqueOrThrow({ where: { id: studentProfile.id } });
    expect(profileFinal.credits).toBe(15);

    expect(await prisma.lessonCreditLog.count({ where: { schoolId: school.id } })).toBe(1);

    // payload mismatch returns 409
    const res3 = await requestJson('/credits/add', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        studentProfileId: studentProfile.id,
        amount: 10,
        reason: 'Manual adjustment',
      },
    });
    expect(res3.status).toBe(409);
  });

  it('5. POST /salary/corrections idempotency check', async () => {
    const school = await createSchool();
    const ownerUser = await createTestUser(school.id, 'OWNER');
    const teacherUser1 = await createTestUser(school.id, 'TEACHER');
    const staffProfile1 = await createStaffProfile(teacherUser1.id, school.id, 2000);
    const teacherUser2 = await createTestUser(school.id, 'TEACHER');
    const staffProfile2 = await createStaffProfile(teacherUser2.id, school.id, 2000);
    const token = signAccess(ownerUser);

    // Setup a session and a payment lesson link
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staffProfile1.id });
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staffProfile1.id,
      date: new Date(),
      status: 'COMPLETED',
    });
    const payment = await prisma.teacherPayment.create({
      data: {
        schoolId: school.id,
        staffProfileId: staffProfile1.id,
        period: '2026-06',
        lessonsCount: 1,
        rateSnapshot: 2000,
        amount: 2000,
      },
    });
    await prisma.teacherPaymentLesson.create({
      data: {
        paymentId: payment.id,
        lessonSessionId: session.id,
      },
    });

    const idempotencyKey = 'unique-correction-key';

    // 1st request (TEACHER_REPLACEMENT)
    const res1 = await requestJson('/salary/corrections', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        correctionType: 'TEACHER_REPLACEMENT',
        sessionId: session.id,
        oldStaffProfileId: staffProfile1.id,
        newStaffProfileId: staffProfile2.id,
        reason: 'Attribution mistake correction',
      },
    });

    expect(res1.status).toBe(200);
    expect(res1.body.data.entries).toHaveLength(2);

    expect(await prisma.manualLessonEntry.count({ where: { schoolId: school.id } })).toBe(2);

    // Simulate crash scenario by making the idempotency key stale and IN_PROGRESS
    await prisma.idempotencyKey.updateMany({
      where: { key: idempotencyKey },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    // 2nd request (retry)
    const res2 = await requestJson('/salary/corrections', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        correctionType: 'TEACHER_REPLACEMENT',
        sessionId: session.id,
        oldStaffProfileId: staffProfile1.id,
        newStaffProfileId: staffProfile2.id,
        reason: 'Attribution mistake correction',
      },
    });

    expect(res2.status).toBe(200);
    expect(res2.body.data.entries).toHaveLength(2);
    expect(res2.body.data.entries.map((e: any) => e.id).sort()).toEqual(res1.body.data.entries.map((e: any) => e.id).sort());

    // Verify entries count did not increase
    expect(await prisma.manualLessonEntry.count({ where: { schoolId: school.id } })).toBe(2);
  });
});
