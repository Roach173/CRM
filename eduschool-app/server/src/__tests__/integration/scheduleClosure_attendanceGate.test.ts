/**
 * Integration — F-01 fix: isAttendanceAllowed() enforced in markAttendance()
 *
 * Before this fix markAttendance() only blocked CANCELLED and INVALIDATED.
 * UPCOMING and LOCKED sessions could have attendance submitted, deducting credits
 * before a lesson started or after salary was locked.
 *
 * After fix: isAttendanceAllowed(status) gates the function. Only IN_PROGRESS
 * and COMPLETED sessions accept attendance. All other statuses throw SESSION_NOT_SUBMITTABLE.
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
} from '../helpers/testDb';
import { markAttendance } from '../../services/attendanceService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
  await createFinanceConfig(school.id, 1);
  const teacher  = await createUser(school.id, 'TEACHER');
  const staff    = await createStaffProfile(teacher.id, school.id);
  const stuUser  = await createUser(school.id, 'STUDENT');
  const student  = await createStudentProfile(stuUser.id, school.id, 10);
  const group    = await createGroup(school.id);
  await createMembership(group.id, student.id, school.id);
  const block    = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, staff, student, block };
}

// ─── 1. Blocked statuses ──────────────────────────────────────────────────────

describe('F-01 — markAttendance blocks non-eligible session statuses', () => {
  it('throws SESSION_NOT_SUBMITTABLE for UPCOMING session', async () => {
    const { school, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-20T12:00:00.000Z'), status: 'UPCOMING',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    await expect(
      prisma.$transaction(tx =>
        markAttendance(tx, {
          sessionId: session.id, studentProfileId: student.id,
          schoolId: school.id, sessionStudentId: ss.id,
          status: 'PRESENT', sessionDate: session.date,
        })
      )
    ).rejects.toThrow('SESSION_NOT_SUBMITTABLE');
  });

  it('throws SESSION_NOT_SUBMITTABLE for LOCKED session', async () => {
    const { school, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-20T12:00:00.000Z'), status: 'LOCKED',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    await expect(
      prisma.$transaction(tx =>
        markAttendance(tx, {
          sessionId: session.id, studentProfileId: student.id,
          schoolId: school.id, sessionStudentId: ss.id,
          status: 'PRESENT', sessionDate: session.date,
        })
      )
    ).rejects.toThrow('SESSION_NOT_SUBMITTABLE');
  });

  it('throws SESSION_NOT_SUBMITTABLE for CANCELLED session (regression — still blocked)', async () => {
    const { school, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-20T12:00:00.000Z'), status: 'CANCELLED',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    await expect(
      prisma.$transaction(tx =>
        markAttendance(tx, {
          sessionId: session.id, studentProfileId: student.id,
          schoolId: school.id, sessionStudentId: ss.id,
          status: 'PRESENT', sessionDate: session.date,
        })
      )
    ).rejects.toThrow('SESSION_NOT_SUBMITTABLE');
  });

  it('throws SESSION_NOT_SUBMITTABLE for INVALIDATED session (regression — still blocked)', async () => {
    const { school, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-20T12:00:00.000Z'), status: 'INVALIDATED',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    await expect(
      prisma.$transaction(tx =>
        markAttendance(tx, {
          sessionId: session.id, studentProfileId: student.id,
          schoolId: school.id, sessionStudentId: ss.id,
          status: 'PRESENT', sessionDate: session.date,
        })
      )
    ).rejects.toThrow('SESSION_NOT_SUBMITTABLE');
  });
});

// ─── 2. Allowed statuses ──────────────────────────────────────────────────────

describe('F-01 — markAttendance allows eligible session statuses', () => {
  it('accepts attendance on IN_PROGRESS session and deducts credit', async () => {
    const { school, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-20T12:00:00.000Z'), status: 'IN_PROGRESS',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    const creditsBefore = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;

    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'PRESENT', sessionDate: session.date,
      })
    );

    const creditsAfter = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;
    expect(Number(creditsAfter)).toBe(Number(creditsBefore) - 1);
  });

  it('accepts attendance on COMPLETED session and deducts credit', async () => {
    const { school, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-20T12:00:00.000Z'), status: 'COMPLETED',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    const creditsBefore = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;

    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'PRESENT', sessionDate: session.date,
      })
    );

    const creditsAfter = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;
    expect(Number(creditsAfter)).toBe(Number(creditsBefore) - 1);
  });
});
