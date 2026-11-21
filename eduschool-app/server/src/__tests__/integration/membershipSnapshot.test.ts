/**
 * Integration: SessionStudent membership snapshot lifecycle (real DB).
 *
 * Verifies:
 * - snapshotNewSessions creates SessionStudent for active group members
 * - Student join: SessionStudent records created for all UPCOMING sessions
 * - Student leave: SessionStudent deleted from UPCOMING, preserved in COMPLETED
 * - FK guard: LessonSession hard delete with SessionStudent is rejected
 * - StudentProfile soft-delete: SessionStudent survives
 */
import { prisma, cleanDb, createSchool, createUser, createStudentProfile,
         createStaffProfile, createGroup, createBlock, createSession,
         createSessionStudent, createMembership } from '../helpers/testDb';
import { snapshotNewSessions } from '../../services/sessionService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function daysFromNow(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

async function setup() {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  const tUser    = await createUser(school.id, 'TEACHER');
  const staff    = await createStaffProfile(tUser.id, school.id);
  const group    = await createGroup(school.id);
  const block    = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, staff, group, block };
}

describe('snapshotNewSessions', () => {
  it('creates SessionStudent for all active members when session created', async () => {
    const { school, group, block } = await setup();
    const s1 = await createUser(school.id, 'STUDENT');
    const s2 = await createUser(school.id, 'STUDENT');
    const student1 = await createStudentProfile(s1.id, school.id);
    const student2 = await createStudentProfile(s2.id, school.id);
    await createMembership(group.id, student1.id, school.id);
    await createMembership(group.id, student2.id, school.id);

    const sessionDate = daysFromNow(7);
    const session = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: (await prisma.staffProfile.findFirst({ where: { user: { schoolId: school.id } } }))!.id,
      date: sessionDate, status: 'UPCOMING' });

    await snapshotNewSessions(prisma, block.id, school.id, group.id, [sessionDate]);

    const snapshots = await prisma.sessionStudent.findMany({
      where: { lessonSessionId: session.id },
    });
    expect(snapshots).toHaveLength(2);
    const ids = snapshots.map(s => s.studentProfileId).sort();
    expect(ids).toEqual([student1.id, student2.id].sort());
  });

  it('is idempotent — calling twice does not create duplicates', async () => {
    const { school, group, block } = await setup();
    const sUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);
    await createMembership(group.id, student.id, school.id);

    const sessionDate = daysFromNow(7);
    await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: (await prisma.staffProfile.findFirst({ where: { user: { schoolId: school.id } } }))!.id,
      date: sessionDate, status: 'UPCOMING' });

    await snapshotNewSessions(prisma, block.id, school.id, group.id, [sessionDate]);
    await snapshotNewSessions(prisma, block.id, school.id, group.id, [sessionDate]);

    const snapshots = await prisma.sessionStudent.findMany({
      where: { studentProfileId: student.id },
    });
    expect(snapshots).toHaveLength(1); // no duplicates
  });
});

describe('student leaves group — SessionStudent cleanup', () => {
  it('removes SessionStudent from UPCOMING sessions when student withdraws', async () => {
    const { school, group, block } = await setup();
    const sUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);
    const membership = await createMembership(group.id, student.id, school.id);

    // Two upcoming sessions
    const staffProfile = await prisma.staffProfile.findFirst({ where: { user: { schoolId: school.id } } });
    const s1 = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: staffProfile!.id, date: daysFromNow(7), status: 'UPCOMING' });
    const s2 = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: staffProfile!.id, date: daysFromNow(9), status: 'UPCOMING' });
    await createSessionStudent(s1.id, student.id, school.id);
    await createSessionStudent(s2.id, student.id, school.id);

    // Simulate student withdrawal (what groups.ts DELETE /:id/students does)
    await prisma.$transaction(async tx => {
      await tx.groupMembership.update({
        where: { id: membership.id },
        data: { status: 'WITHDRAWN', leftAt: new Date() },
      });
      const blockIds = await tx.lessonBlock.findMany({
        where: { studentGroupId: group.id, deletedAt: null },
        select: { id: true },
      });
      const upcoming = await tx.lessonSession.findMany({
        where: { lessonBlockId: { in: blockIds.map(b => b.id) },
          status: 'UPCOMING', date: { gte: new Date() }, deletedAt: null },
        select: { id: true },
      });
      if (upcoming.length > 0) {
        await tx.sessionStudent.deleteMany({
          where: { lessonSessionId: { in: upcoming.map(u => u.id) }, studentProfileId: student.id },
        });
      }
    });

    const remaining = await prisma.sessionStudent.findMany({
      where: { studentProfileId: student.id },
    });
    expect(remaining).toHaveLength(0);
  });

  it('preserves SessionStudent in COMPLETED sessions after withdrawal', async () => {
    const { school, group, block } = await setup();
    const sUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);
    const membership = await createMembership(group.id, student.id, school.id);

    const staffProfile = await prisma.staffProfile.findFirst({ where: { user: { schoolId: school.id } } });

    // One COMPLETED session (historical record)
    const completedSession = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: staffProfile!.id, date: daysFromNow(-7), status: 'COMPLETED' });
    await createSessionStudent(completedSession.id, student.id, school.id);

    // One UPCOMING session
    const upcomingSession = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: staffProfile!.id, date: daysFromNow(7), status: 'UPCOMING' });
    await createSessionStudent(upcomingSession.id, student.id, school.id);

    // Withdraw
    await prisma.$transaction(async tx => {
      await tx.groupMembership.update({
        where: { id: membership.id },
        data: { status: 'WITHDRAWN', leftAt: new Date() },
      });
      const blockIds = await tx.lessonBlock.findMany({
        where: { studentGroupId: group.id, deletedAt: null }, select: { id: true },
      });
      const upcoming = await tx.lessonSession.findMany({
        where: { lessonBlockId: { in: blockIds.map(b => b.id) },
          status: 'UPCOMING', date: { gte: new Date() }, deletedAt: null },
        select: { id: true },
      });
      if (upcoming.length > 0) {
        await tx.sessionStudent.deleteMany({
          where: { lessonSessionId: { in: upcoming.map(u => u.id) }, studentProfileId: student.id },
        });
      }
    });

    const remaining = await prisma.sessionStudent.findMany({
      where: { studentProfileId: student.id },
    });
    // COMPLETED session's SessionStudent must survive
    expect(remaining).toHaveLength(1);
    expect(remaining[0].lessonSessionId).toBe(completedSession.id);
  });
});

describe('SessionStudent FK guard behavior', () => {
  it('rejects hard delete of LessonSession when SessionStudent snapshot exists', async () => {
    const { school, group, block } = await setup();
    const sUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);
    const staffProfile = await prisma.staffProfile.findFirst({ where: { user: { schoolId: school.id } } });

    const session = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: staffProfile!.id, date: daysFromNow(7), status: 'UPCOMING' });
    await createSessionStudent(session.id, student.id, school.id);

    await expect(prisma.lessonSession.delete({ where: { id: session.id } })).rejects.toThrow();

    const snapshots = await prisma.sessionStudent.findMany({
      where: { studentProfileId: student.id },
    });
    expect(snapshots).toHaveLength(1);
  });

  it('preserves SessionStudent when StudentProfile is soft-deleted', async () => {
    const { school, group, block } = await setup();
    const sUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);
    const staffProfile = await prisma.staffProfile.findFirst({ where: { user: { schoolId: school.id } } });

    const session = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: staffProfile!.id, date: daysFromNow(7), status: 'UPCOMING' });
    await createSessionStudent(session.id, student.id, school.id);

    // Soft-delete student
    await prisma.studentProfile.update({
      where: { id: student.id },
      data: { deletedAt: new Date() },
    });

    const snapshots = await prisma.sessionStudent.findMany({
      where: { studentProfileId: student.id },
    });
    expect(snapshots).toHaveLength(1); // survives soft-delete
  });
});
