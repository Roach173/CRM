/**
 * CHARACTERIZATION TESTS — Reconciliation Gaps
 * PR 1: Schedule Lifecycle — document current behavior, NO production code changes.
 *
 * These tests implement the reconciliation checks from RFC §10 and demonstrate
 * that the current system does NOT enforce these invariants automatically.
 * Each test:
 *   1. Creates a scenario that violates an invariant
 *   2. Runs the check that would catch it
 *   3. Verifies the violation EXISTS (test passes = gap is confirmed)
 *
 * None of these tests "fix" the violations. They are the regression baseline
 * for PR 8 (reconciliation report implementation).
 *
 * Invariants tested:
 *   R1. Every completed session with enrolled students has attendance OR explicit skip
 *   R2. No cancelled session has a credit deduction against it
 *   R3. No paid salary (TeacherPaymentLesson) for an invalidated session
 *   R4. Makeup session must link to a cancelled original (makeupForSessionId)
 *   R5. Every Attendance with creditDeducted=true has a matching LessonCreditLog entry
 *   R6. No LessonCreditLog deduction maps to a CANCELLED/INVALIDATED session
 *
 * TODO PR 8: Implement GET /admin/reconciliation?month=YYYY-MM that runs all checks
 *   and returns a list of violations. Run this as a daily cron.
 */

import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
  createStaffProfile, createGroup, createBlock, createSession,
  createSessionStudent, createFinanceConfig, createMembership,
  createTeacherPaymentRecord,
} from '../helpers/testDb';
import { markAttendance } from '../../services/attendanceService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school  = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  await createFinanceConfig(school.id, 1);
  const owner   = await createUser(school.id, 'OWNER');
  const teacher = await createUser(school.id, 'TEACHER');
  const staff   = await createStaffProfile(teacher.id, school.id);
  const stuUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(stuUser.id, school.id, 10);
  const group   = await createGroup(school.id);
  await createMembership(group.id, student.id, school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, owner, staff, student, group, block };
}

// ─── Helper: reconciliation check functions ───────────────────────────────────
// These are the RFC §10 checks that PR 8 will implement as API endpoints.

async function checkCompletedSessionsWithoutAttendance(schoolId: number) {
  return prisma.lessonSession.findMany({
    where: {
      schoolId,
      status: { in: ['COMPLETED', 'LOCKED'] },
      deletedAt: null,
      sessionStudents: { some: {} },   // has enrolled students
      attendances: { none: {} },        // but no attendance
    },
    select: { id: true, date: true, status: true },
  });
}

async function checkCancelledSessionsWithCreditDeductions(schoolId: number) {
  return prisma.lessonCreditLog.findMany({
    where: {
      schoolId,
      amount: { lt: 0 },   // deduction (negative amount)
      session: {
        status: { in: ['CANCELLED', 'INVALIDATED'] },
        deletedAt: null,
      },
    },
    select: { id: true, amount: true, sessionId: true },
  });
}

async function checkInvalidatedSessionsWithSalaryLinks(schoolId: number) {
  return prisma.teacherPaymentLesson.findMany({
    where: {
      lessonSession: { schoolId, status: 'INVALIDATED', deletedAt: null },
    },
    select: { id: true, lessonSessionId: true, paymentId: true },
  });
}

async function checkMakeupSessionsWithoutLink(schoolId: number) {
  return prisma.lessonSession.findMany({
    where: {
      schoolId,
      isMakeup: true,
      makeupForSessionId: null,  // should never happen — but no DB constraint prevents it
      deletedAt: null,
    },
    select: { id: true, date: true },
  });
}

async function checkAttendanceWithDeductedFlagButNoLog(schoolId: number) {
  // Attendance where creditDeducted=true but no matching LessonCreditLog exists
  const deductedAttendances = await prisma.attendance.findMany({
    where: { schoolId, creditDeducted: true },
    select: { id: true, lessonSessionId: true, studentProfileId: true },
  });

  const violations: typeof deductedAttendances = [];
  for (const att of deductedAttendances) {
    const log = await prisma.lessonCreditLog.findFirst({
      where: { attendanceId: att.id },
    });
    if (!log) violations.push(att);
  }
  return violations;
}

// ─── R1. Completed session with students but no attendance ────────────────────

describe('CHARACTERIZATION R1 — completed session with students but no attendance [GAP]', () => {
  /**
   * CHARACTERIZATION: A COMPLETED session can exist with enrolled students
   * and no attendance records. The system does not enforce "you must submit
   * attendance before marking a session complete."
   *
   * The session can be moved to COMPLETED via PATCH /session/:id/status
   * without any attendance having been submitted.
   *
   * TODO PR 8: Reconciliation report must flag these sessions.
   *   Consider adding attendanceSkipped: Boolean field for explicit "no-show policy" sessions.
   */
  it('COMPLETED session with SessionStudent but no Attendance is not caught by any current check', async () => {
    const { school, staff, student, block } = await setup();

    // Create a completed session with an enrolled student but NO attendance
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED' });
    await createSessionStudent(session.id, student.id, school.id);
    // No markAttendance call — intentionally left without attendance

    const violations = await checkCompletedSessionsWithoutAttendance(school.id);

    // CURRENT BEHAVIOR: violation exists and is NOT caught automatically
    expect(violations).toHaveLength(1);
    expect(violations[0].id).toBe(session.id);
  });

  it('completed session WITH attendance passes the check', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED' });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate: session.date })
    );

    const violations = await checkCompletedSessionsWithoutAttendance(school.id);
    expect(violations).toHaveLength(0);
  });
});

// ─── R2. Cancelled session with credit deduction ──────────────────────────────

describe('CHARACTERIZATION R2 — cancelled session with credit deduction [GAP]', () => {
  /**
   * CHARACTERIZATION: A LessonCreditLog deduction record can exist pointing to
   * a CANCELLED session. This is a financial integrity violation.
   *
   * The current system prevents this via attendanceService (blocks CANCELLED sessions),
   * but the DB has no constraint enforcing it. A direct Prisma insert can create
   * this violation, as can a sequence where attendance was submitted before the
   * session was cancelled (if IN_PROGRESS → CANCELLED transition happens after
   * attendance was already submitted for that session).
   *
   * TODO PR 8: Reconciliation report must flag these as financial integrity violations.
   *   PR 3: cancelSession() must check for existing attendance and handle it.
   */
  it('credit deduction against a CANCELLED session is not caught automatically', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });

    // Plant a deduction directly (bypassing the service guard)
    await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        sessionId: session.id,
        amount: -1,
        type: 'DEBIT',
        reason: 'attendance on cancelled session (test)',
      },
    });

    // Also update the credit balance as the service would
    await prisma.studentProfile.update({ where: { id: student.id }, data: { credits: { decrement: 1 } } });

    const violations = await checkCancelledSessionsWithCreditDeductions(school.id);

    // CURRENT BEHAVIOR: violation exists and is NOT caught by any automated check
    expect(violations).toHaveLength(1);
    expect(violations[0].sessionId).toBe(session.id);
  });

  it('R2 check passes when no cancelled session has credit deductions', async () => {
    const { school, staff, student, block } = await setup();

    const completedSession = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED' });
    const ss = await createSessionStudent(completedSession.id, student.id, school.id);

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: completedSession.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate: completedSession.date })
    );

    const violations = await checkCancelledSessionsWithCreditDeductions(school.id);
    expect(violations).toHaveLength(0);
  });
});

// ─── R3. Salary record for an INVALIDATED session ────────────────────────────

describe('CHARACTERIZATION R3 — TeacherPaymentLesson for INVALIDATED session [GAP]', () => {
  /**
   * CHARACTERIZATION: A TeacherPaymentLesson record can point to an INVALIDATED
   * session. The DB has no constraint preventing this. If a session is marked
   * INVALIDATED after a salary payment was already created, the payment link remains.
   *
   * TODO PR 8: Reconciliation report must flag TeacherPaymentLesson entries where
   *   session.status = 'INVALIDATED'. These must be voided via correction flow (RFC §8.5).
   */
  it('TeacherPaymentLesson for INVALIDATED session is not caught automatically', async () => {
    const { school, owner, staff, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED' });

    const payment = await createTeacherPaymentRecord(staff.id, school.id, owner.id, { period: '2026-06', lessonsCount: 1 });
    await prisma.teacherPaymentLesson.create({
      data: { paymentId: payment.id, lessonSessionId: session.id },
    });

    // Now invalidate the session (simulating a data integrity discovery)
    await prisma.lessonSession.update({ where: { id: session.id }, data: { status: 'INVALIDATED', version: { increment: 1 } } });

    const violations = await checkInvalidatedSessionsWithSalaryLinks(school.id);

    // CURRENT BEHAVIOR: violation exists — salary record still points to invalidated session
    expect(violations).toHaveLength(1);
    expect(violations[0].lessonSessionId).toBe(session.id);
  });

  it('R3 check passes when no INVALIDATED session has a salary link', async () => {
    const { school, staff, block } = await setup();

    // Create an INVALIDATED session with no TeacherPaymentLesson
    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'INVALIDATED' });
    // Intentionally no TeacherPaymentLesson — clean state

    const violations = await checkInvalidatedSessionsWithSalaryLinks(school.id);
    expect(violations).toHaveLength(0);
  });
});

// ─── R4. Makeup session without link to original ──────────────────────────────

describe('CHARACTERIZATION R4 — makeup session without makeupForSessionId [GAP]', () => {
  /**
   * CHARACTERIZATION: The schema allows isMakeup=true with makeupForSessionId=null.
   * There is no DB constraint requiring makeupForSessionId when isMakeup=true.
   * An orphaned makeup session cannot be linked back to its original cancelled session.
   *
   * TODO PR 6: Add DB constraint: if isMakeup=true then makeupForSessionId MUST be set.
   *   Until then, reconciliation report must flag isMakeup=true sessions with null link.
   */
  it('isMakeup=true session with null makeupForSessionId can be created at DB level', async () => {
    const { school, staff, block } = await setup();

    const orphanMakeup = await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: block.id,
        date: new Date('2026-06-12T12:00:00.000Z'),
        status: 'UPCOMING',
        teacherIdSnap: staff.id,
        startTimeSnap: '09:00',
        endTimeSnap: '10:00',
        isMakeup: true,
        makeupForSessionId: null, // no link — orphaned
      },
    });

    expect(orphanMakeup.isMakeup).toBe(true);
    expect(orphanMakeup.makeupForSessionId).toBeNull();
  });

  it('reconciliation check R4 catches orphaned makeup sessions', async () => {
    const { school, staff, block } = await setup();

    await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: block.id,
        date: new Date('2026-06-12T12:00:00.000Z'),
        status: 'UPCOMING',
        teacherIdSnap: staff.id,
        startTimeSnap: '09:00',
        endTimeSnap: '10:00',
        isMakeup: true,
        makeupForSessionId: null,
      },
    });

    const violations = await checkMakeupSessionsWithoutLink(school.id);
    // CURRENT BEHAVIOR: violation exists — DB doesn't prevent it
    expect(violations).toHaveLength(1);
  });
});

// ─── R5. Attendance.creditDeducted=true with no matching LessonCreditLog ──────

describe('CHARACTERIZATION R5 — creditDeducted=true with no log entry [GAP]', () => {
  /**
   * CHARACTERIZATION: Attendance.creditDeducted=true signals that a credit was
   * consumed. The matching LessonCreditLog entry is created by attendanceService.
   * If the log entry is missing (manual DB edit, buggy import, partial transaction
   * rollback), the credit balance appears correct to the student but the audit
   * trail is broken.
   *
   * The current system has no periodic check that verifies this link.
   *
   * TODO PR 8: Daily reconciliation cron must verify every creditDeducted=true
   *   Attendance record has a matching LessonCreditLog (attendanceId FK).
   */
  it('Attendance with creditDeducted=true but no LessonCreditLog is not caught automatically', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED' });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    // Plant an attendance with creditDeducted=true but NO credit log
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: student.id,
        sessionStudentId: ss.id,
        status: 'PRESENT',
        creditDeducted: true, // flag says deducted, but no log entry below
        // intentionally no LessonCreditLog created
      },
    });

    const violations = await checkAttendanceWithDeductedFlagButNoLog(school.id);

    // CURRENT BEHAVIOR: violation exists — no check catches this automatically
    expect(violations).toHaveLength(1);
  });

  it('R5 check passes when attendance with creditDeducted=true has a matching log', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'IN_PROGRESS' });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    // Use the service — it creates both attendance and log correctly
    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate: session.date })
    );

    const violations = await checkAttendanceWithDeductedFlagButNoLog(school.id);
    expect(violations).toHaveLength(0);
  });
});

// ─── R6. Credit log deduction pointing to cancelled/invalidated session ────────

describe('CHARACTERIZATION R6 — credit deduction on CANCELLED/INVALIDATED session [GAP]', () => {
  /**
   * This is similar to R2 but covers the inverse check: LessonCreditLog itself.
   * A DEBIT entry should never point to a session in a terminal-cancelled state.
   *
   * The attendanceService guard (throws SESSION_NOT_SUBMITTABLE) prevents this
   * in normal flow. But the DB itself has no such constraint.
   * A direct insert or a sequence where cancel happens after attendance bypasses
   * the guard.
   */
  it('direct DEBIT log against a CANCELLED session passes at the DB level', async () => {
    const { school, staff, student, block } = await setup();

    const cancelled = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });

    // Direct insert — bypasses service guard
    await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        sessionId: cancelled.id,
        amount: -1,
        type: 'DEBIT',
        reason: 'test violation',
      },
    });

    const violations = await checkCancelledSessionsWithCreditDeductions(school.id);
    // Violation exists — DB allowed the insert
    expect(violations).toHaveLength(1);
  });
});
