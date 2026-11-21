/**
 * Phase 5 — Database Invariants
 *
 * Verifies that the CHECK constraints and partial unique indexes added by
 * migration 20260527030000_phase5_db_invariants are actually enforced by the DB.
 *
 * Requirements:
 *   - Migration must be applied to the test DB before running these tests.
 *   - Run: npx prisma migrate deploy (from server/) before npm run test:integration.
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
  createPaymentRecord,
} from '../helpers/testDb';
import { runDbInvariantPrecheck } from '../../services/dbInvariantService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeSchoolWithOwner() {
  const school = await createSchool();
  const owner = await createUser(school.id, 'OWNER');
  return { school, owner };
}

async function makeStudentInSchool(schoolId: number) {
  const user = await createUser(schoolId, 'STUDENT');
  const profile = await createStudentProfile(user.id, schoolId, 10);
  return { user, profile };
}

async function makeStaffInSchool(schoolId: number) {
  const user = await createUser(schoolId, 'TEACHER');
  const profile = await createStaffProfile(user.id, schoolId, 5000);
  return { user, profile };
}

// ─── Phase 5.2 — CHECK constraints ───────────────────────────────────────────

describe('Phase 5.2 — CHECK constraints', () => {
  beforeEach(async () => { await cleanDb(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('DB allows StudentProfile.credits < 0 (debt model — deferred payment)', async () => {
    const { school } = await makeSchoolWithOwner();
    const studentUser = await createUser(school.id, 'STUDENT');
    // Negative credits = lesson debt — valid by business design (see ADR-021)
    await expect(
      prisma.studentProfile.create({ data: { userId: studentUser.id, credits: -1 } })
    ).resolves.toBeDefined();
  });

  it('DB allows StudentProfile.credits = 0', async () => {
    const { school } = await makeSchoolWithOwner();
    const studentUser = await createUser(school.id, 'STUDENT');
    await expect(
      prisma.studentProfile.create({ data: { userId: studentUser.id, credits: 0 } })
    ).resolves.toBeDefined();
  });

  it('DB allows update that makes StudentProfile.credits negative (debt accumulated)', async () => {
    const { school } = await makeSchoolWithOwner();
    const { profile } = await makeStudentInSchool(school.id); // starts with 10 credits
    const updated = await prisma.studentProfile.update({
      where: { id: profile.id },
      data: { credits: -5 },
    });
    expect(updated.credits).toBe(-5);
  });

  it('DB rejects StaffProfile.salaryRate < 0', async () => {
    const { school } = await makeSchoolWithOwner();
    const teacherUser = await createUser(school.id, 'TEACHER');
    await expect(
      prisma.staffProfile.create({ data: { userId: teacherUser.id, salaryRate: -100 } })
    ).rejects.toThrow('23514');
  });

  it('DB allows StaffProfile.salaryRate = null', async () => {
    const { school } = await makeSchoolWithOwner();
    const teacherUser = await createUser(school.id, 'TEACHER');
    await expect(
      prisma.staffProfile.create({ data: { userId: teacherUser.id, salaryRate: null } })
    ).resolves.toBeDefined();
  });

  it('DB allows StaffProfile.salaryRate = 0', async () => {
    const { school } = await makeSchoolWithOwner();
    const teacherUser = await createUser(school.id, 'TEACHER');
    await expect(
      prisma.staffProfile.create({ data: { userId: teacherUser.id, salaryRate: 0 } })
    ).resolves.toBeDefined();
  });

  it('DB rejects Payment.amount = 0', async () => {
    const { school, owner } = await makeSchoolWithOwner();
    const { profile: student } = await makeStudentInSchool(school.id);
    await expect(
      prisma.payment.create({
        data: {
          schoolId: school.id,
          studentProfileId: student.id,
          receivedById: owner.id,
          amount: '0',
          method: 'CASH',
          status: 'CONFIRMED',
        },
      })
    ).rejects.toThrow('23514');
  });

  it('DB rejects Payment.amount negative', async () => {
    const { school, owner } = await makeSchoolWithOwner();
    const { profile: student } = await makeStudentInSchool(school.id);
    await expect(
      prisma.payment.create({
        data: {
          schoolId: school.id,
          studentProfileId: student.id,
          receivedById: owner.id,
          amount: '-500',
          method: 'CASH',
          status: 'CONFIRMED',
        },
      })
    ).rejects.toThrow('23514');
  });

  it('DB rejects StudentPayment.amount = 0', async () => {
    const { school, owner } = await makeSchoolWithOwner();
    const { profile: student } = await makeStudentInSchool(school.id);
    await expect(
      prisma.studentPayment.create({
        data: {
          schoolId: school.id,
          studentProfileId: student.id,
          creditsAdded: 5,
          amount: '0',
          pricePerCredit: '0',
          method: 'CASH',
          createdById: owner.id,
        },
      })
    ).rejects.toThrow('23514');
  });

  it('DB rejects TeacherPayment.amount = 0', async () => {
    const { school, owner } = await makeSchoolWithOwner();
    const { profile: staff } = await makeStaffInSchool(school.id);
    await expect(
      prisma.teacherPayment.create({
        data: {
          schoolId: school.id,
          staffProfileId: staff.id,
          period: '2026-05',
          lessonsCount: 0,
          rateSnapshot: '5000',
          amount: '0',
          createdById: owner.id,
        },
      })
    ).rejects.toThrow('23514');
  });

  it('DB rejects PaymentRefund.amount = 0', async () => {
    const { school, owner } = await makeSchoolWithOwner();
    const { profile: student } = await makeStudentInSchool(school.id);
    const payment = await createPaymentRecord(student.id, school.id, owner.id, '1000');
    await expect(
      prisma.paymentRefund.create({
        data: {
          schoolId: school.id,
          paymentId: payment.id,
          amount: '0',
          reason: 'test refund',
          status: 'PENDING',
          createdById: owner.id,
        },
      })
    ).rejects.toThrow('23514');
  });

  it('SalaryAdjustment.amount can be negative (FINE)', async () => {
    const { school, owner } = await makeSchoolWithOwner();
    const { profile: staff } = await makeStaffInSchool(school.id);
    await expect(
      prisma.salaryAdjustment.create({
        data: {
          schoolId: school.id,
          staffProfileId: staff.id,
          type: 'FINE',
          amount: '-200',
          reason: 'late',
          month: '2026-05',
          createdById: owner.id,
        },
      })
    ).resolves.toBeDefined();
  });
});

// ─── Phase 5.3 — Partial unique indexes ──────────────────────────────────────

describe('Phase 5.3 — Partial unique indexes', () => {
  beforeEach(async () => { await cleanDb(); });

  it('DB rejects duplicate DEBIT LessonCreditLog for same attendanceId', async () => {
    const { school } = await makeSchoolWithOwner();
    const { profile: staff } = await makeStaffInSchool(school.id);
    const { profile: student } = await makeStudentInSchool(school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2026-06-10T12:00:00.000Z'),
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);
    const attendance = await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: student.id,
        sessionStudentId: ss.id,
        status: 'PRESENT',
        creditDeducted: true,
      },
    });

    // First DEBIT — must succeed
    await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        attendanceId: attendance.id,
        type: 'DEBIT',
        amount: -1,
        reason: 'lesson deduction',
      },
    });

    // Second DEBIT for same attendance — must be rejected
    await expect(
      prisma.lessonCreditLog.create({
        data: {
          schoolId: school.id,
          studentProfileId: student.id,
          attendanceId: attendance.id,
          type: 'DEBIT',
          amount: -1,
          reason: 'duplicate deduction',
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows multiple non-DEBIT logs for the same attendanceId', async () => {
    const { school } = await makeSchoolWithOwner();
    const { profile: staff } = await makeStaffInSchool(school.id);
    const { profile: student } = await makeStudentInSchool(school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2026-06-11T12:00:00.000Z'),
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);
    const attendance = await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: student.id,
        sessionStudentId: ss.id,
        status: 'PRESENT',
        creditDeducted: true,
      },
    });

    // REFUND logs for same attendance — allowed (partial index only blocks DEBIT type)
    await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        attendanceId: attendance.id,
        type: 'REFUND',
        amount: 1,
        reason: 'refund 1',
      },
    });
    await expect(
      prisma.lessonCreditLog.create({
        data: {
          schoolId: school.id,
          studentProfileId: student.id,
          attendanceId: attendance.id,
          type: 'REFUND',
          amount: 1,
          reason: 'refund 2',
        },
      })
    ).resolves.toBeDefined();
  });

  it('DB rejects duplicate PENDING EnrollmentRequest for same student/group', async () => {
    const { school } = await makeSchoolWithOwner();
    const { profile: student } = await makeStudentInSchool(school.id);
    const group = await createGroup(school.id);

    // First PENDING — must succeed
    await prisma.enrollmentRequest.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        studentGroupId: group.id,
        status: 'PENDING',
      },
    });

    // Second PENDING for same student+group — must be rejected
    await expect(
      prisma.enrollmentRequest.create({
        data: {
          schoolId: school.id,
          studentProfileId: student.id,
          studentGroupId: group.id,
          status: 'PENDING',
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows a new PENDING enrollment after the previous one is REJECTED', async () => {
    const { school } = await makeSchoolWithOwner();
    const { profile: student } = await makeStudentInSchool(school.id);
    const group = await createGroup(school.id);

    const first = await prisma.enrollmentRequest.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        studentGroupId: group.id,
        status: 'PENDING',
      },
    });

    // Reject the first
    await prisma.enrollmentRequest.update({
      where: { id: first.id },
      data: { status: 'REJECTED' },
    });

    // New PENDING is now allowed (partial index only blocks status=PENDING)
    await expect(
      prisma.enrollmentRequest.create({
        data: {
          schoolId: school.id,
          studentProfileId: student.id,
          studentGroupId: group.id,
          status: 'PENDING',
        },
      })
    ).resolves.toBeDefined();
  });

  it('allows two PENDING enrollments for different groups', async () => {
    const { school } = await makeSchoolWithOwner();
    const { profile: student } = await makeStudentInSchool(school.id);
    const groupA = await createGroup(school.id);
    const groupB = await createGroup(school.id);

    await prisma.enrollmentRequest.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        studentGroupId: groupA.id,
        status: 'PENDING',
      },
    });

    await expect(
      prisma.enrollmentRequest.create({
        data: {
          schoolId: school.id,
          studentProfileId: student.id,
          studentGroupId: groupB.id,
          status: 'PENDING',
        },
      })
    ).resolves.toBeDefined();
  });
});

// ─── Phase 5.1 — Precheck script ─────────────────────────────────────────────

describe('Phase 5.1 — Precheck script', () => {
  beforeEach(async () => { await cleanDb(); });

  it('precheck passes on clean DB (0 violations)', async () => {
    const violations = await runDbInvariantPrecheck(prisma);
    // Only BLOCKER violations should fail the pre-migration gate.
    // WARNING violations (e.g. debt students) do not block migration.
    const blockers = violations.filter(v => v.severity === 'BLOCKER');
    expect(blockers).toHaveLength(0);
  });

  it('precheck reports debt students as WARNING, not BLOCKER', async () => {
    const { school } = await makeSchoolWithOwner();
    const { profile } = await makeStudentInSchool(school.id); // 10 credits
    // Set negative balance (debt) directly at DB level
    await prisma.studentProfile.update({
      where: { id: profile.id },
      data: { credits: -3 },
    });

    const violations = await runDbInvariantPrecheck(prisma);
    const debtViolation = violations.find(v =>
      v.check === 'StudentProfile.credits < 0 (debt report)'
    );
    expect(debtViolation).toBeDefined();
    expect(debtViolation!.severity).toBe('WARNING'); // not BLOCKER — debt is valid
    expect(debtViolation!.count).toBeGreaterThanOrEqual(1);
    expect(debtViolation!.sampleIds).toContain(profile.id);
  });

  it('precheck detects Attendance.schoolId != LessonSession.schoolId', async () => {
    // School A contains the lesson; School B "owns" the attendance — cross-tenant violation
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const ownerA = await createUser(schoolA.id, 'OWNER');
    const { profile: staffA } = await makeStaffInSchool(schoolA.id);
    const groupA = await createGroup(schoolA.id);
    const blockA = await createBlock({
      groupId: groupA.id,
      schoolId: schoolA.id,
      staffProfileId: staffA.id,
    });
    const sessionA = await createSession({
      blockId: blockA.id,
      schoolId: schoolA.id,
      staffProfileId: staffA.id,
      date: new Date('2026-06-15T12:00:00.000Z'),
    });

    const studentUserB = await createUser(schoolB.id, 'STUDENT');
    const studentB = await createStudentProfile(studentUserB.id, schoolB.id, 5);

    // Insert attendance with schoolId=B but lessonSessionId from school A — cross-tenant violation
    // Neither FK constraint nor CHECK constraint blocks this; only the precheck detects it
    await prisma.attendance.create({
      data: {
        schoolId: schoolB.id,        // ← wrong school
        lessonSessionId: sessionA.id, // ← session belongs to school A
        studentProfileId: studentB.id,
        status: 'PRESENT',
        creditDeducted: false,
      },
    });

    const violations = await runDbInvariantPrecheck(prisma);
    const ctViolation = violations.find(v =>
      v.check === 'Attendance.schoolId != LessonSession.schoolId'
    );
    expect(ctViolation).toBeDefined();
    expect(ctViolation!.count).toBeGreaterThanOrEqual(1);
    expect(ctViolation!.severity).toBe('BLOCKER');
  });

  it('precheck detects duplicate DEBIT logs for same attendanceId', async () => {
    // To seed duplicate DEBIT logs we must temporarily drop the partial unique index,
    // insert the duplicates, run the precheck, then clean up BEFORE recreating.
    const { school } = await makeSchoolWithOwner();
    const { profile: staff } = await makeStaffInSchool(school.id);
    const { profile: student } = await makeStudentInSchool(school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2026-06-16T12:00:00.000Z'),
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);
    const attendance = await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: student.id,
        sessionStudentId: ss.id,
        status: 'PRESENT',
        creditDeducted: true,
      },
    });

    // Step 1: Drop partial unique indexes to allow seeding legacy duplicates.
    // Older migrations used credit_log_debit_attendance_unique; Phase 5 uses
    // LessonCreditLog_debit_per_attendance.
    await prisma.$executeRaw`DROP INDEX IF EXISTS "credit_log_debit_attendance_unique"`;
    await prisma.$executeRaw`DROP INDEX IF EXISTS "LessonCreditLog_debit_per_attendance"`;

    await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id, studentProfileId: student.id,
        attendanceId: attendance.id, type: 'DEBIT', amount: -1, reason: 'first deduction',
      },
    });
    const dup = await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id, studentProfileId: student.id,
        attendanceId: attendance.id, type: 'DEBIT', amount: -1, reason: 'duplicate deduction',
      },
    });

    // Step 2: Run precheck — must detect the violation
    const violations = await runDbInvariantPrecheck(prisma);
    const dupViolation = violations.find(v =>
      v.check === 'Duplicate DEBIT LessonCreditLog per attendanceId'
    );
    expect(dupViolation).toBeDefined();
    expect(dupViolation!.count).toBeGreaterThanOrEqual(1);

    // Step 3: Clean up duplicates BEFORE recreating the index (order matters)
    await prisma.lessonCreditLog.delete({ where: { id: dup.id } });

    // Step 4: Recreate the index (can now succeed — no duplicates)
    await prisma.$executeRaw`
      CREATE UNIQUE INDEX IF NOT EXISTS "LessonCreditLog_debit_per_attendance"
        ON "LessonCreditLog" ("attendanceId")
        WHERE "attendanceId" IS NOT NULL AND "type" = 'DEBIT'::"CreditLogType"`;
  });
});
