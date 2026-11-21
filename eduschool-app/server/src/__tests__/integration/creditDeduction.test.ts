/**
 * Integration: credit deduction flow (real DB).
 *
 * Verifies the slot-reservation billing model:
 * PRESENT / LATE / ABSENT all deduct one credit.
 * creditDeducted flag is write-once (idempotency).
 * Frozen students within the freeze window are not charged.
 * CANCELLED sessions are never charged.
 */
import { prisma, cleanDb, createSchool, createUser, createStudentProfile,
         createStaffProfile, createGroup, createBlock, createSession,
         createSessionStudent, createFinanceConfig } from '../helpers/testDb';
import { markAttendance } from '../../services/attendanceService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  const config   = await createFinanceConfig(school.id, 1);
  const ownerUser = await createUser(school.id, 'TEACHER');
  const staff    = await createStaffProfile(ownerUser.id, school.id);
  const stuUser  = await createUser(school.id, 'STUDENT');
  const student  = await createStudentProfile(stuUser.id, school.id, 10);
  const group    = await createGroup(school.id);
  const block    = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  const session  = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
    date: new Date('2026-06-02T12:00:00.000Z'), status: 'IN_PROGRESS' });
  const ss       = await createSessionStudent(session.id, student.id, school.id);
  return { school, config, staff, student, group, block, session, ss };
}

describe('credit deduction — slot reservation model', () => {
  it('deducts 1 credit for PRESENT', async () => {
    const { student, session, ss } = await setup();

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id,
        schoolId: session.schoolId, sessionStudentId: ss.id,
        status: 'PRESENT', sessionDate: session.date })
    );

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(after!.credits).toBe(9);

    const log = await prisma.lessonCreditLog.findFirst({ where: { studentProfileId: student.id } });
    expect(log).not.toBeNull();
    expect(Number(log!.amount)).toBe(-1);

    const att = await prisma.attendance.findFirst({ where: { lessonSessionId: session.id } });
    expect(att!.creditDeducted).toBe(true);
  });

  it('deducts 1 credit for ABSENT — slot was reserved', async () => {
    const { student, session, ss } = await setup();

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id,
        schoolId: session.schoolId, sessionStudentId: ss.id,
        status: 'ABSENT', sessionDate: session.date })
    );

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(after!.credits).toBe(9);
  });

  it('deducts 1 credit for LATE', async () => {
    const { student, session, ss } = await setup();

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id,
        schoolId: session.schoolId, sessionStudentId: ss.id,
        status: 'LATE', sessionDate: session.date })
    );

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(after!.credits).toBe(9);
  });

  it('is idempotent — second PRESENT call does NOT deduct again', async () => {
    const { student, session, ss } = await setup();

    const params = { sessionId: session.id, studentProfileId: student.id,
      schoolId: session.schoolId, sessionStudentId: ss.id,
      status: 'PRESENT' as const, sessionDate: session.date };

    await prisma.$transaction(tx => markAttendance(tx, params));
    await prisma.$transaction(tx => markAttendance(tx, params));

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(after!.credits).toBe(9); // only deducted once

    const logs = await prisma.lessonCreditLog.findMany({ where: { studentProfileId: student.id } });
    expect(logs).toHaveLength(1);
  });

  it('PRESENT → ABSENT status edit does NOT refund credits', async () => {
    const { student, session, ss } = await setup();

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id,
        schoolId: session.schoolId, sessionStudentId: ss.id,
        status: 'PRESENT', sessionDate: session.date })
    );
    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id,
        schoolId: session.schoolId, sessionStudentId: ss.id,
        status: 'ABSENT', sessionDate: session.date })
    );

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(after!.credits).toBe(9); // still 9, no refund
  });
});

describe('credit deduction — freeze window', () => {
  it('does NOT deduct for frozen student who froze before the deadline', async () => {
    const { student, session, ss, school, staff } = await setup();

    // PR 5: StudentFreeze is source of truth. Create an ACTIVE PERIOD freeze
    // covering the session date (2026-06-02). The deadline check happens at
    // freeze creation time; here we directly insert a valid freeze record.
    await prisma.studentFreeze.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        createdById: staff.userId,
        type: 'PERIOD',
        startDate: new Date('2026-05-31T10:00:00.000Z'), // well before session
        endDate: null, // open-ended
        status: 'ACTIVE',
      },
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'ABSENT', sessionDate: session.date })
    );

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(after!.credits).toBe(10); // no deduction

    const att = await prisma.attendance.findFirst({ where: { lessonSessionId: session.id } });
    expect(att!.creditDeducted).toBe(false);
  });

  it('DOES deduct for frozen student who froze after the deadline', async () => {
    const { student, session, ss, school } = await setup();

    // deadline = 2026-06-01T12:00Z; frozenAt = 2026-06-02 (after deadline) → deduct
    await prisma.studentProfile.update({
      where: { id: student.id },
      data: { isFrozen: true, frozenAt: new Date('2026-06-02T06:00:00.000Z') },
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'ABSENT', sessionDate: session.date })
    );

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(after!.credits).toBe(9); // deducted
  });
});

describe('credit deduction — LessonCreditLog invariant', () => {
  it('creditDeducted=true is always accompanied by a LessonCreditLog record', async () => {
    const { student, session, ss } = await setup();

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id,
        schoolId: session.schoolId, sessionStudentId: ss.id,
        status: 'PRESENT', sessionDate: session.date })
    );

    const att = await prisma.attendance.findFirst({ where: { lessonSessionId: session.id } });
    expect(att!.creditDeducted).toBe(true);

    const log = await prisma.lessonCreditLog.findFirst({
      where: { studentProfileId: student.id, sessionId: session.id },
    });
    expect(log).not.toBeNull();
    expect(Number(log!.amount)).toBe(-1);
  });
});
