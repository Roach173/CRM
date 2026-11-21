/**
 * Integration: rosterService — SessionStudent amendment policy (real DB).
 *
 * Verifies:
 * - reconcileRosterOnMemberAdd adds student to UPCOMING sessions
 * - reconcileRosterOnMemberAdd is idempotent
 * - reconcileRosterOnMemberRemove removes from UPCOMING without attendance
 * - reconcileRosterOnMemberRemove protects sessions where attendance exists
 * - reconcileRosterOnMemberRemove does NOT touch COMPLETED sessions
 * - No ghost students after membership changes
 */
import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
  createStaffProfile, createGroup, createBlock, createSession,
  createSessionStudent, createMembership,
} from '../helpers/testDb';
import { reconcileRosterOnMemberAdd, reconcileRosterOnMemberRemove } from '../../services/rosterService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

async function setup() {
  const school  = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  const tUser   = await createUser(school.id, 'TEACHER');
  const staff   = await createStaffProfile(tUser.id, school.id);
  const group   = await createGroup(school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, staff, group, block };
}

// ─── reconcileRosterOnMemberAdd ───────────────────────────────────────────────

describe('reconcileRosterOnMemberAdd', () => {
  it('adds student to all UPCOMING future sessions of the group', async () => {
    const { school, group, block, staff } = await setup();
    const sUser   = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);

    // Two upcoming sessions
    const s1 = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: daysFromNow(3) });
    const s2 = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: daysFromNow(7) });

    await reconcileRosterOnMemberAdd(group.id, school.id, [student.id]);

    const rows = await prisma.sessionStudent.findMany({ where: { studentProfileId: student.id } });
    expect(rows).toHaveLength(2);
    const sessionIds = rows.map(r => r.lessonSessionId).sort();
    expect(sessionIds).toEqual([s1.id, s2.id].sort());
  });

  it('is idempotent — calling twice does not duplicate', async () => {
    const { school, group, block, staff } = await setup();
    const sUser   = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);

    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: daysFromNow(5) });

    await reconcileRosterOnMemberAdd(group.id, school.id, [student.id]);
    await reconcileRosterOnMemberAdd(group.id, school.id, [student.id]);

    const rows = await prisma.sessionStudent.findMany({ where: { studentProfileId: student.id } });
    expect(rows).toHaveLength(1); // no duplicates
  });

  it('does not add to COMPLETED sessions', async () => {
    const { school, group, block, staff } = await setup();
    const sUser   = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);

    // Completed (historical) session
    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: daysFromNow(-5), status: 'COMPLETED' });

    await reconcileRosterOnMemberAdd(group.id, school.id, [student.id]);

    const rows = await prisma.sessionStudent.findMany({ where: { studentProfileId: student.id } });
    expect(rows).toHaveLength(0); // historical sessions not touched
  });
});

// ─── reconcileRosterOnMemberRemove ────────────────────────────────────────────

describe('reconcileRosterOnMemberRemove', () => {
  it('removes student from UPCOMING sessions that have no attendance', async () => {
    const { school, group, block, staff } = await setup();
    const sUser   = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);

    const s1 = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: daysFromNow(3) });
    const s2 = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: daysFromNow(7) });
    await createSessionStudent(s1.id, student.id, school.id);
    await createSessionStudent(s2.id, student.id, school.id);

    const result = await reconcileRosterOnMemberRemove(group.id, school.id, student.id);

    expect(result.removed).toBe(2);
    expect(result.protected).toBe(0);
    const remaining = await prisma.sessionStudent.findMany({ where: { studentProfileId: student.id } });
    expect(remaining).toHaveLength(0);
  });

  it('keeps SessionStudent when attendance already exists for that session', async () => {
    const { school, group, block, staff } = await setup();
    const sUser   = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);

    // Session with attendance already submitted (should be protected)
    const attended = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: staff.id, date: daysFromNow(3) });
    const ss = await createSessionStudent(attended.id, student.id, school.id);
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: attended.id,
        studentProfileId: student.id,
        status: 'PRESENT',
        creditDeducted: true,
        sessionStudentId: ss.id,
      },
    });

    // Session without attendance (safe to remove)
    const clean = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: staff.id, date: daysFromNow(7) });
    await createSessionStudent(clean.id, student.id, school.id);

    const result = await reconcileRosterOnMemberRemove(group.id, school.id, student.id);

    expect(result.removed).toBe(1);   // clean session removed
    expect(result.protected).toBe(1); // attended session protected

    const remaining = await prisma.sessionStudent.findMany({ where: { studentProfileId: student.id } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].lessonSessionId).toBe(attended.id);
  });

  it('does NOT touch COMPLETED historical sessions', async () => {
    const { school, group, block, staff } = await setup();
    const sUser   = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(sUser.id, school.id);

    // COMPLETED (historical) session
    const completedSession = await createSession({ blockId: block.id, schoolId: school.id,
      staffProfileId: staff.id, date: daysFromNow(-7), status: 'COMPLETED' });
    await createSessionStudent(completedSession.id, student.id, school.id);

    await reconcileRosterOnMemberRemove(group.id, school.id, student.id);

    const remaining = await prisma.sessionStudent.findMany({ where: { studentProfileId: student.id } });
    expect(remaining).toHaveLength(1); // historical record preserved
    expect(remaining[0].lessonSessionId).toBe(completedSession.id);
  });
});
