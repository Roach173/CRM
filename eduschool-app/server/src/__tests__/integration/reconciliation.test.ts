/**
 * Integration tests for reconciliationService (PR 8).
 *
 * Each test creates a specific violation scenario, runs the relevant check,
 * and verifies that the issue is (or is not) reported with the correct
 * issueType, severity, and entityId.
 *
 * Clean-state tests verify that correct data passes all checks.
 *
 * Tests:
 *   R1. completed without attendance                → WARNING
 *   R2. cancelled with credit deduction             → CRITICAL
 *   R3. invalidated with teacher payment            → CRITICAL
 *   R4. makeup without original link                → ERROR
 *   R5. duplicate active makeup links are prevented by DB invariant
 *   R6. salary on non-payable session               → CRITICAL
 *   R7. attendance without credit log               → CRITICAL
 *   Full report aggregation
 *   Severity mapping
 *   Clean state → no issues
 */

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
  findCompletedWithoutAttendance,
  findCancelledWithCreditDeduction,
  findInvalidatedWithTeacherPayment,
  findMakeupWithoutOriginal,
  findDuplicateMakeupLinks,
  findSalaryWithoutSession,
  findAttendanceWithoutCreditLog,
  runFullReconciliation,
  ReconciliationSeverity,
} from '../../services/reconciliationService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  await createFinanceConfig(school.id, 1);
  const owner    = await createUser(school.id, 'OWNER');
  const tUser    = await createUser(school.id, 'TEACHER');
  const staff    = await createStaffProfile(tUser.id, school.id);
  const stuUser  = await createUser(school.id, 'STUDENT');
  const student  = await createStudentProfile(stuUser.id, school.id, 10);
  const group    = await createGroup(school.id);
  await createMembership(group.id, student.id, school.id);
  const block    = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, owner, staff, student, group, block };
}

// ─── R1: COMPLETED without attendance ────────────────────────────────────────

describe('R1 — findCompletedWithoutAttendance', () => {
  it('detects COMPLETED session with enrolled students but no attendance', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED',
    });
    await createSessionStudent(session.id, student.id, school.id);

    const issues = await findCompletedWithoutAttendance(school.id, prisma);

    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('R1_COMPLETED_WITHOUT_ATTENDANCE');
    expect(issues[0].severity).toBe('WARNING' satisfies ReconciliationSeverity);
    expect(issues[0].entityId).toBe(session.id);
    expect(issues[0].entityType).toBe('session');
    expect(issues[0].schoolId).toBe(school.id);
    expect(issues[0].detectedAt).toBeInstanceOf(Date);
  });

  it('detects LOCKED session with students but no attendance', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'LOCKED',
    });
    await createSessionStudent(session.id, student.id, school.id);

    const issues = await findCompletedWithoutAttendance(school.id, prisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].entityId).toBe(session.id);
  });

  it('passes when COMPLETED session has attendance records', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
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

    const issues = await findCompletedWithoutAttendance(school.id, prisma);
    expect(issues).toHaveLength(0);
  });

  it('ignores UPCOMING sessions (only COMPLETED/LOCKED are checked)', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING',
    });
    await createSessionStudent(session.id, student.id, school.id);

    const issues = await findCompletedWithoutAttendance(school.id, prisma);
    expect(issues).toHaveLength(0);
  });
});

// ─── R2: Cancelled with credit deduction ─────────────────────────────────────

describe('R2 — findCancelledWithCreditDeduction', () => {
  it('detects credit deduction log against CANCELLED session', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED',
    });

    const log = await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        sessionId: session.id,
        amount: -1,
        type: 'DEBIT',
        reason: 'attendance on cancelled session (violation)',
      },
    });

    const issues = await findCancelledWithCreditDeduction(school.id, prisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('R2_CANCELLED_SESSION_CREDIT_DEDUCTION');
    expect(issues[0].severity).toBe('CRITICAL' satisfies ReconciliationSeverity);
    expect(issues[0].entityId).toBe(log.id);
    expect(issues[0].entityType).toBe('credit_log');
  });

  it('detects credit deduction against INVALIDATED session', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'INVALIDATED',
    });

    await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        sessionId: session.id,
        amount: -1,
        type: 'DEBIT',
        reason: 'violation',
      },
    });

    const issues = await findCancelledWithCreditDeduction(school.id, prisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('R2_CANCELLED_SESSION_CREDIT_DEDUCTION');
  });

  it('passes when deductions are against COMPLETED sessions only', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
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

    const issues = await findCancelledWithCreditDeduction(school.id, prisma);
    expect(issues).toHaveLength(0);
  });
});

// ─── R3: Invalidated with teacher payment ────────────────────────────────────

describe('R3 — findInvalidatedWithTeacherPayment', () => {
  it('detects TeacherPaymentLesson for INVALIDATED session', async () => {
    const { school, owner, staff, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED',
    });

    const payment = await createTeacherPaymentRecord(staff.id, school.id, owner.id, {
      period: '2026-06', lessonsCount: 1,
    });
    const paymentLesson = await prisma.teacherPaymentLesson.create({
      data: { paymentId: payment.id, lessonSessionId: session.id },
    });

    // Now invalidate the session
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { status: 'INVALIDATED', version: { increment: 1 } },
    });

    const issues = await findInvalidatedWithTeacherPayment(school.id, prisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('R3_INVALIDATED_SESSION_TEACHER_PAYMENT');
    expect(issues[0].severity).toBe('CRITICAL' satisfies ReconciliationSeverity);
    expect(issues[0].entityId).toBe(paymentLesson.id);
    expect(issues[0].entityType).toBe('teacher_payment');
    expect(issues[0].metadata?.sessionId).toBe(session.id);
  });

  it('passes when no INVALIDATED session has a salary link', async () => {
    const { school, staff, block } = await setup();

    await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'INVALIDATED',
    });

    const issues = await findInvalidatedWithTeacherPayment(school.id, prisma);
    expect(issues).toHaveLength(0);
  });
});

// ─── R4: Makeup without original link ────────────────────────────────────────

describe('R4 — findMakeupWithoutOriginal', () => {
  it('detects isMakeup=true session with null makeupForSessionId', async () => {
    const { school, staff, block } = await setup();

    const orphan = await prisma.lessonSession.create({
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

    const issues = await findMakeupWithoutOriginal(school.id, prisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('R4_MAKEUP_WITHOUT_ORIGINAL_LINK');
    expect(issues[0].severity).toBe('ERROR' satisfies ReconciliationSeverity);
    expect(issues[0].entityId).toBe(orphan.id);
    expect(issues[0].entityType).toBe('makeup');
  });

  it('passes when all makeup sessions have a valid makeupForSessionId', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED',
    });

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
        makeupForSessionId: original.id,
      },
    });

    const issues = await findMakeupWithoutOriginal(school.id, prisma);
    expect(issues).toHaveLength(0);
  });
});

// ─── R5: Duplicate makeup links ───────────────────────────────────────────────

describe('R5 — findDuplicateMakeupLinks', () => {
  it('prevents two active makeup sessions for same original at the DB boundary', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED',
    });

    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: new Date('2026-06-12T12:00:00.000Z'), status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });

    await expect(
      prisma.lessonSession.create({
        data: {
          schoolId: school.id, lessonBlockId: block.id,
          date: new Date('2026-06-14T12:00:00.000Z'), status: 'UPCOMING',
          teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
          isMakeup: true, makeupForSessionId: original.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const issues = await findDuplicateMakeupLinks(school.id, prisma);
    expect(issues).toHaveLength(0);
  });

  it('does not flag a cancelled duplicate (one active, one cancelled)', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED',
    });

    // One active, one cancelled — no duplicate
    await prisma.lessonSession.createMany({
      data: [
        {
          schoolId: school.id, lessonBlockId: block.id,
          date: new Date('2026-06-12T12:00:00.000Z'), status: 'UPCOMING',
          teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
          isMakeup: true, makeupForSessionId: original.id,
        },
        {
          schoolId: school.id, lessonBlockId: block.id,
          date: new Date('2026-06-14T12:00:00.000Z'), status: 'CANCELLED',
          teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
          isMakeup: true, makeupForSessionId: original.id,
        },
      ],
    });

    const issues = await findDuplicateMakeupLinks(school.id, prisma);
    expect(issues).toHaveLength(0);
  });

  it('passes when each cancelled session has at most one active makeup', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED',
    });

    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: new Date('2026-06-12T12:00:00.000Z'), status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });

    const issues = await findDuplicateMakeupLinks(school.id, prisma);
    expect(issues).toHaveLength(0);
  });
});

// ─── R6: Salary on non-payable session ───────────────────────────────────────

describe('R6 — findSalaryWithoutSession', () => {
  it('detects TeacherPaymentLesson for CANCELLED session', async () => {
    const { school, owner, staff, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED',
    });

    const payment = await createTeacherPaymentRecord(staff.id, school.id, owner.id, {
      period: '2026-06', lessonsCount: 1,
    });
    const paymentLesson = await prisma.teacherPaymentLesson.create({
      data: { paymentId: payment.id, lessonSessionId: session.id },
    });

    const issues = await findSalaryWithoutSession(school.id, prisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('R6_SALARY_ON_NON_PAYABLE_SESSION');
    expect(issues[0].severity).toBe('CRITICAL' satisfies ReconciliationSeverity);
    expect(issues[0].entityId).toBe(paymentLesson.id);
    expect(issues[0].metadata?.sessionStatus).toBe('CANCELLED');
  });

  it('passes when TeacherPaymentLesson links to COMPLETED/LOCKED session', async () => {
    const { school, owner, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'LOCKED',
    });

    const payment = await createTeacherPaymentRecord(staff.id, school.id, owner.id, {
      period: '2026-06', lessonsCount: 1,
    });
    await prisma.teacherPaymentLesson.create({
      data: { paymentId: payment.id, lessonSessionId: session.id },
    });

    const issues = await findSalaryWithoutSession(school.id, prisma);
    expect(issues).toHaveLength(0);
  });
});

// ─── R7: Attendance with creditDeducted=true but no credit log ────────────────

describe('R7 — findAttendanceWithoutCreditLog', () => {
  it('detects attendance with creditDeducted=true but no LessonCreditLog', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    // Plant creditDeducted=true without a credit log entry
    const att = await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: student.id,
        sessionStudentId: ss.id,
        status: 'PRESENT',
        creditDeducted: true,
      },
    });

    const issues = await findAttendanceWithoutCreditLog(school.id, prisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('R7_ATTENDANCE_WITHOUT_CREDIT_LOG');
    expect(issues[0].severity).toBe('CRITICAL' satisfies ReconciliationSeverity);
    expect(issues[0].entityId).toBe(att.id);
    expect(issues[0].entityType).toBe('attendance');
    expect(issues[0].metadata?.attendanceId).toBe(att.id);
  });

  it('passes when attendance with creditDeducted=true has a matching LessonCreditLog', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'IN_PROGRESS',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    // markAttendance creates both attendance and credit log correctly
    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'PRESENT', sessionDate: session.date,
      })
    );

    const issues = await findAttendanceWithoutCreditLog(school.id, prisma);
    expect(issues).toHaveLength(0);
  });

  it('passes when no attendance has creditDeducted=true', async () => {
    const issues = await findAttendanceWithoutCreditLog(1, prisma);
    expect(issues).toHaveLength(0);
  });
});

// ─── Full reconciliation report ───────────────────────────────────────────────

describe('runFullReconciliation', () => {
  it('returns empty report for a clean school with no violations', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
    await createFinanceConfig(school.id, 1);

    const report = await runFullReconciliation(school.id, prisma);

    expect(report.schoolId).toBe(school.id);
    expect(report.checkedAt).toBeInstanceOf(Date);
    expect(report.issues).toHaveLength(0);
    expect(report.summary).toContain('no issues found');
    expect(report.countsBySeverity.CRITICAL).toBe(0);
    expect(report.countsBySeverity.ERROR).toBe(0);
    expect(report.countsBySeverity.WARNING).toBe(0);
    expect(report.countsBySeverity.INFO).toBe(0);
    expect(Object.keys(report.countsByType)).toHaveLength(0);
  });

  it('report aggregation: multiple issues from different checks', async () => {
    const { school, owner, staff, student, block } = await setup();

    // Violation R1: COMPLETED session without attendance
    const completedSession = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED',
    });
    await createSessionStudent(completedSession.id, student.id, school.id);

    // Violation R4: orphan makeup
    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: new Date('2026-06-12T12:00:00.000Z'), status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: null,
      },
    });

    // Violation R3: invalidated session with salary link
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-13T12:00:00.000Z'), status: 'COMPLETED',
    });
    const payment = await createTeacherPaymentRecord(staff.id, school.id, owner.id, {
      period: '2026-06', lessonsCount: 1,
    });
    await prisma.teacherPaymentLesson.create({
      data: { paymentId: payment.id, lessonSessionId: session.id },
    });
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { status: 'INVALIDATED', version: { increment: 1 } },
    });

    const report = await runFullReconciliation(school.id, prisma);

    expect(report.issues.length).toBeGreaterThanOrEqual(3);
    expect(report.countsBySeverity.WARNING).toBeGreaterThanOrEqual(1);  // R1
    expect(report.countsBySeverity.ERROR).toBeGreaterThanOrEqual(1);    // R4
    expect(report.countsBySeverity.CRITICAL).toBeGreaterThanOrEqual(1); // R3

    // countsByType should include all violated invariants
    expect(report.countsByType['R1_COMPLETED_WITHOUT_ATTENDANCE']).toBeGreaterThanOrEqual(1);
    expect(report.countsByType['R4_MAKEUP_WITHOUT_ORIGINAL_LINK']).toBeGreaterThanOrEqual(1);
    expect(report.countsByType['R3_INVALIDATED_SESSION_TEACHER_PAYMENT']).toBeGreaterThanOrEqual(1);

    expect(report.summary).toContain('issue(s)');
    expect(report.summary).toContain('CRITICAL');
  });

  it('report structure contains all required fields', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
    await createFinanceConfig(school.id, 1);

    const report = await runFullReconciliation(school.id, prisma);

    expect(report).toMatchObject({
      schoolId: expect.any(Number),
      checkedAt: expect.any(Date),
      summary: expect.any(String),
      issues: expect.any(Array),
      countsBySeverity: {
        INFO: expect.any(Number),
        WARNING: expect.any(Number),
        ERROR: expect.any(Number),
        CRITICAL: expect.any(Number),
      },
      countsByType: expect.any(Object),
    });
  });

  it('severity mapping: each check uses the documented severity', async () => {
    const { school, owner, staff, student, block } = await setup();

    // Plant one of each violation type
    // R1: WARNING
    const c1 = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED',
    });
    await createSessionStudent(c1.id, student.id, school.id);

    // R2: CRITICAL
    const c2 = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-11T12:00:00.000Z'), status: 'CANCELLED',
    });
    await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id, studentProfileId: student.id,
        sessionId: c2.id, amount: -1, type: 'DEBIT', reason: 'violation',
      },
    });

    // R4: ERROR
    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: new Date('2026-06-12T12:00:00.000Z'), status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: null,
      },
    });

    const report = await runFullReconciliation(school.id, prisma);

    const byType = new Map(report.issues.map(i => [i.issueType, i]));
    expect(byType.get('R1_COMPLETED_WITHOUT_ATTENDANCE')?.severity).toBe('WARNING');
    expect(byType.get('R2_CANCELLED_SESSION_CREDIT_DEDUCTION')?.severity).toBe('CRITICAL');
    expect(byType.get('R4_MAKEUP_WITHOUT_ORIGINAL_LINK')?.severity).toBe('ERROR');
  });
});
