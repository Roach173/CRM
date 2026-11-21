/**
 * Integration tests for PR 9: Salary Correction Flow.
 *
 * Tests cover:
 *  1.  ADMIN cannot create salary correction (403)
 *  2.  OWNER can create correction with reason (200)
 *  3.  Missing Idempotency-Key returns 400
 *  4.  Same key replay returns cached response (one correction only)
 *  5.  Same key + different payload returns 409
 *  6.  TEACHER_REPLACEMENT creates REMOVE for old teacher + ADD for new teacher
 *  7.  INVALIDATED_SESSION creates REMOVE ManualLessonEntry for paid teacher
 *  8.  Audit log entry exists after correction
 *  9.  Reconciliation downgraded to WARNING after correction
 * 10.  Reconciliation still CRITICAL without correction
 * 11.  Correction does NOT delete TeacherPaymentLesson (financial history preserved)
 * 12.  Cross-tenant session correction is rejected (404)
 *
 * Uses real DB via testDb helpers. Salary router mounted with `authenticate`
 * middleware — tokens are created via JWT.
 */

import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
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
  createMembership,
  createTeacherPaymentRecord,
} from '../helpers/testDb';
import { markAttendance } from '../../services/attendanceService';
import {
  findInvalidatedWithTeacherPayment,
  findSalaryWithoutSession,
  runFullReconciliation,
} from '../../services/reconciliationService';
import salaryRouter from '../../routes/salary';

// ─── Test server setup ────────────────────────────────────────────────────────

let server: Server;
let basePort: number;

beforeAll(done => {
  const app = express();
  app.use(express.json());
  app.use('/salary', salaryRouter);
  server = app.listen(0, () => {
    basePort = (server.address() as AddressInfo).port;
    done();
  });
});

beforeEach(cleanDb);

afterAll(done => {
  // Small delay to let any pending best-effort async DB writes (audit log, idempotency)
  // complete before the server closes. Without this, the next test file's cleanDb()
  // can deadlock against an in-flight INSERT that holds a row lock on ScheduleActionLog.
  setTimeout(() => {
    server.close(() => {
      // Drain connections fully before the next test suite's cleanDb() TRUNCATE runs.
      setTimeout(done, 300);
    });
  }, 400);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-here';

function tokenFor(user: { id: number; role: string }, schoolId: number) {
  return jwt.sign({ userId: user.id, schoolId, role: user.role }, JWT_SECRET);
}

function baseUrl() {
  return `http://127.0.0.1:${basePort}`;
}

async function postCorrection(
  body: Record<string, unknown>,
  token: string,
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return fetch(`${baseUrl()}/salary/corrections`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function setupWithPaidSession() {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  await createFinanceConfig(school.id, 1);
  const owner    = await createUser(school.id, 'OWNER');
  const adminU   = await createUser(school.id, 'ADMIN');
  const t1User   = await createUser(school.id, 'TEACHER');
  const t2User   = await createUser(school.id, 'TEACHER');
  const staff1   = await createStaffProfile(t1User.id, school.id);
  const staff2   = await createStaffProfile(t2User.id, school.id);
  const stuUser  = await createUser(school.id, 'STUDENT');
  const student  = await createStudentProfile(stuUser.id, school.id, 10);
  const group    = await createGroup(school.id);
  await createMembership(group.id, student.id, school.id);
  const block    = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff1.id });

  // Create COMPLETED session with attendance
  const session = await createSession({
    blockId: block.id, schoolId: school.id, staffProfileId: staff1.id,
    date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED',
  });
  const ss = await createSessionStudent(session.id, student.id, school.id);
  await prisma.$transaction(tx =>
    markAttendance(tx, {
      sessionId: session.id, studentProfileId: student.id,
      schoolId: school.id, sessionStudentId: ss.id,
      status: 'PRESENT', sessionDate: session.date,
    })
  );

  // Create TeacherPayment for this session
  const payment = await createTeacherPaymentRecord(staff1.id, school.id, owner.id, {
    period: '2026-06', lessonsCount: 1,
  });
  const paymentLesson = await prisma.teacherPaymentLesson.create({
    data: { paymentId: payment.id, lessonSessionId: session.id },
  });

  const ownerToken = tokenFor(owner, school.id);
  const adminToken = tokenFor(adminU, school.id);

  return {
    school, owner, adminU, staff1, staff2, student, group, block,
    session, payment, paymentLesson, ownerToken, adminToken,
  };
}

// ─── Test 1: ADMIN cannot create salary correction ────────────────────────────

it('1. ADMIN cannot create salary correction — 403', async () => {
  const { session, adminToken, paymentLesson } = await setupWithPaidSession();

  // Invalidate first
  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  const res = await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'session was invalidated' },
    adminToken,
    'test-key-admin-403',
  );
  expect(res.status).toBe(403);
});

// ─── Test 2: OWNER can create correction with valid reason ────────────────────

it('2. OWNER can create INVALIDATED_SESSION correction with reason', async () => {
  const { session, ownerToken, paymentLesson, school, staff1 } = await setupWithPaidSession();

  // Invalidate the session
  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  const res = await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'session was invalidated erroneously' },
    ownerToken,
    'test-key-owner-valid',
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.correctionType).toBe('INVALIDATED_SESSION');
  expect(body.data.sessionId).toBe(session.id);
  expect(body.data.entries).toHaveLength(1);
  expect(body.data.entries[0].type).toBe('REMOVE');
  expect(body.data.entries[0].staffProfileId).toBe(staff1.id);
});

// ─── Test 3: Missing Idempotency-Key → 400 ───────────────────────────────────

it('3. Missing Idempotency-Key returns 400', async () => {
  const { session, ownerToken, paymentLesson } = await setupWithPaidSession();

  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  // No Idempotency-Key header
  const res = await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'test reason here' },
    ownerToken,
    undefined, // no key
  );
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.success).toBe(false);
});

// ─── Test 4: Same key replay → only one correction ───────────────────────────

it('4. Same Idempotency-Key replays without creating duplicate entries', async () => {
  const { session, ownerToken, paymentLesson, staff1, school } = await setupWithPaidSession();

  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  const key = 'test-key-replay-idempotency';
  const body = { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'valid correction reason' };

  const res1 = await postCorrection(body, ownerToken, key);
  expect(res1.status).toBe(200);

  const res2 = await postCorrection(body, ownerToken, key);
  expect(res2.status).toBe(200);

  // Verify only ONE ManualLessonEntry was created
  const entries = await prisma.manualLessonEntry.findMany({
    where: { schoolId: school.id, staffProfileId: staff1.id, month: '2026-06' },
  });
  expect(entries).toHaveLength(1);
  expect(entries[0].type).toBe('REMOVE');
});

// ─── Test 5: Same key + different payload → 409 ──────────────────────────────

it('5. Same Idempotency-Key with different payload returns 409', async () => {
  const { session, ownerToken, paymentLesson } = await setupWithPaidSession();

  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  const key = 'test-key-conflict-409';

  const res1 = await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'first reason here' },
    ownerToken, key,
  );
  expect(res1.status).toBe(200);

  // Same key, different payload
  const res2 = await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'different reason here' },
    ownerToken, key,
  );
  expect(res2.status).toBe(409);
});

// ─── Test 6: TEACHER_REPLACEMENT creates REMOVE + ADD entries ─────────────────

it('6. TEACHER_REPLACEMENT creates REMOVE for old teacher + ADD for new teacher', async () => {
  const { session, staff1, staff2, school, ownerToken, paymentLesson } = await setupWithPaidSession();

  const res = await postCorrection(
    {
      correctionType: 'TEACHER_REPLACEMENT',
      sessionId: session.id,
      oldStaffProfileId: staff1.id,
      newStaffProfileId: staff2.id,
      reason: 'session was taught by wrong teacher',
    },
    ownerToken,
    'test-key-teacher-replacement',
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.correctionType).toBe('TEACHER_REPLACEMENT');
  expect(body.data.entries).toHaveLength(2);

  const removeEntry = body.data.entries.find((e: any) => e.type === 'REMOVE');
  const addEntry    = body.data.entries.find((e: any) => e.type === 'ADD');

  expect(removeEntry).toBeDefined();
  expect(removeEntry.staffProfileId).toBe(staff1.id);
  expect(addEntry).toBeDefined();
  expect(addEntry.staffProfileId).toBe(staff2.id);

  // Verify DB state
  const dbEntries = await prisma.manualLessonEntry.findMany({
    where: { schoolId: school.id, month: '2026-06' },
  });
  expect(dbEntries).toHaveLength(2);
  expect(dbEntries.find(e => e.type === 'REMOVE')).toBeTruthy();
  expect(dbEntries.find(e => e.type === 'ADD')).toBeTruthy();
});

// ─── Test 7: INVALIDATED_SESSION creates REMOVE ManualLessonEntry ─────────────

it('7. INVALIDATED_SESSION correction creates REMOVE ManualLessonEntry', async () => {
  const { session, ownerToken, paymentLesson, staff1, school } = await setupWithPaidSession();

  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  const res = await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'session data was corrupted' },
    ownerToken,
    'test-key-invalidated-session',
  );
  expect(res.status).toBe(200);

  // TeacherPaymentLesson must still exist (immutable)
  const stillExists = await prisma.teacherPaymentLesson.findUnique({
    where: { id: paymentLesson.id },
  });
  expect(stillExists).not.toBeNull();

  // ManualLessonEntry REMOVE created
  const entries = await prisma.manualLessonEntry.findMany({
    where: { schoolId: school.id, staffProfileId: staff1.id, month: '2026-06' },
  });
  expect(entries).toHaveLength(1);
  expect(entries[0].type).toBe('REMOVE');
  expect(entries[0].label).toContain(`SALARY_CORRECTION:session:${session.id}`);
});

// ─── Test 8: Audit log entry exists after correction ─────────────────────────

it('8. Audit log entry is created after correction', async () => {
  const { session, ownerToken, paymentLesson, school } = await setupWithPaidSession();

  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'invalidated after payment error' },
    ownerToken,
    'test-key-audit',
  );

  // Give the best-effort audit log a moment (it's async catch-swallowed)
  await new Promise(r => setTimeout(r, 200));

  const auditEntry = await prisma.scheduleActionLog.findFirst({
    where: {
      schoolId: school.id,
      action:   'SALARY_CORRECTION_INVALIDATED_SESSION',
      sessionId: session.id,
    },
  });
  expect(auditEntry).not.toBeNull();
  expect(auditEntry!.action).toBe('SALARY_CORRECTION_INVALIDATED_SESSION');
});

// ─── Test 9: Reconciliation downgraded after correction ──────────────────────

it('9. Reconciliation R3 is WARNING (not CRITICAL) after correction applied', async () => {
  const { session, ownerToken, paymentLesson, school } = await setupWithPaidSession();

  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  // Before correction — should be CRITICAL
  const beforeIssues = await findInvalidatedWithTeacherPayment(school.id, prisma);
  expect(beforeIssues).toHaveLength(1);
  expect(beforeIssues[0].severity).toBe('CRITICAL');

  // Apply correction
  await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'correction applied by owner' },
    ownerToken,
    'test-key-reconciliation-after',
  );

  // After correction — should be WARNING
  const afterIssues = await findInvalidatedWithTeacherPayment(school.id, prisma);
  expect(afterIssues).toHaveLength(1);
  expect(afterIssues[0].severity).toBe('WARNING');
  expect(afterIssues[0].metadata?.corrected).toBe(true);
});

// ─── Test 10: Reconciliation still CRITICAL without correction ────────────────

it('10. Reconciliation R3 remains CRITICAL when no correction has been applied', async () => {
  const { session, school, paymentLesson } = await setupWithPaidSession();

  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  const issues = await findInvalidatedWithTeacherPayment(school.id, prisma);
  expect(issues).toHaveLength(1);
  expect(issues[0].severity).toBe('CRITICAL');
  expect(issues[0].metadata?.corrected).toBe(false);
});

// ─── Test 11: Correction does NOT delete TeacherPaymentLesson ─────────────────

it('11. TeacherPaymentLesson is preserved (financial history immutable)', async () => {
  const { session, ownerToken, paymentLesson, school } = await setupWithPaidSession();

  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'preserve payment history' },
    ownerToken,
    'test-key-immutable',
  );

  const link = await prisma.teacherPaymentLesson.findUnique({ where: { id: paymentLesson.id } });
  expect(link).not.toBeNull();
  expect(link!.id).toBe(paymentLesson.id);
  expect(link!.paymentId).toBe(paymentLesson.paymentId);
});

// ─── Test 12: Cross-tenant session correction rejected ───────────────────────

it('12. Cross-tenant correction is rejected with 404', async () => {
  // School A has the paid session, School B owner tries to correct it
  const { paymentLesson } = await setupWithPaidSession();

  const schoolB = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  await createFinanceConfig(schoolB.id, 1);
  const ownerB = await createUser(schoolB.id, 'OWNER');
  const tokenB = tokenFor(ownerB, schoolB.id);

  // Invalidate the session first (in school A's session)
  const link = await prisma.teacherPaymentLesson.findUnique({
    where: { id: paymentLesson.id },
    select: { lessonSessionId: true },
  });
  await prisma.lessonSession.update({
    where: { id: link!.lessonSessionId },
    data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  const res = await postCorrection(
    {
      correctionType: 'INVALIDATED_SESSION',
      paymentLessonId: paymentLesson.id, // belongs to School A
      reason: 'cross-tenant correction attempt',
    },
    tokenB, // School B token
    'test-key-cross-tenant',
  );
  expect(res.status).toBe(404);
});

// ─── Full reconciliation integration ─────────────────────────────────────────

it('runFullReconciliation includes corrected session as WARNING in report', async () => {
  const { session, ownerToken, paymentLesson, school } = await setupWithPaidSession();

  await prisma.lessonSession.update({
    where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } },
  });

  await postCorrection(
    { correctionType: 'INVALIDATED_SESSION', paymentLessonId: paymentLesson.id, reason: 'reconciliation test correction' },
    ownerToken,
    'test-key-full-report',
  );

  const report = await runFullReconciliation(school.id, prisma);
  const r3Issues = report.issues.filter(i => i.issueType === 'R3_INVALIDATED_SESSION_TEACHER_PAYMENT');
  expect(r3Issues).toHaveLength(1);
  expect(r3Issues[0].severity).toBe('WARNING');
  // CRITICAL count should be 0 for R3 specifically
  const r3Criticals = r3Issues.filter(i => i.severity === 'CRITICAL');
  expect(r3Criticals).toHaveLength(0);
});
