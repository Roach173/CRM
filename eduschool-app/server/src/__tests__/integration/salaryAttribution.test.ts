/**
 * Integration: salary attribution rules (real DB).
 *
 * Verifies countLessonsForStaff logic via direct DB queries
 * mirroring the salary route's attribution pattern.
 *
 * A session counts for teacher T if:
 *   teacherId = T (substitute) OR (teacherIdSnap = T AND teacherId IS NULL)
 * AND status NOT IN [CANCELLED, INVALIDATED]
 * AND attendances.some()
 */
import { prisma, cleanDb, createSchool, createUser, createStudentProfile,
         createStaffProfile, createGroup, createBlock, createSession,
         createSessionStudent, createFinanceConfig } from '../helpers/testDb';
import { markAttendance } from '../../services/attendanceService';
import { countLessonsForStaff } from '../../routes/salary';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// Exercise the PRODUCTION counting function directly (not a re-implementation),
// so any drift in salary.ts's "payable session" definition is caught here.
const countLessons = (staffProfileId: number, schoolId: number, period: string) =>
  countLessonsForStaff(staffProfileId, schoolId, period);

async function setup() {
  const school    = await createSchool({ timezone: 'UTC' });
  await createFinanceConfig(school.id, 1);
  const t1User    = await createUser(school.id, 'TEACHER');
  const t2User    = await createUser(school.id, 'TEACHER');
  const staff1    = await createStaffProfile(t1User.id, school.id);
  const staff2    = await createStaffProfile(t2User.id, school.id);
  const sUser     = await createUser(school.id, 'STUDENT');
  const student   = await createStudentProfile(sUser.id, school.id, 20);
  const group     = await createGroup(school.id);
  const block     = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff1.id });
  return { school, staff1, staff2, student, group, block };
}

async function withAttendance(session: { id: number; schoolId: number; date: Date },
                              student: { id: number }) {
  const ss = await createSessionStudent(session.id, student.id, session.schoolId);
  await prisma.$transaction(tx =>
    markAttendance(tx, { sessionId: session.id, studentProfileId: student.id,
      schoolId: session.schoolId, sessionStudentId: ss.id,
      status: 'PRESENT', sessionDate: session.date })
  );
}

// Bypasses service-level guard — used to plant attendance on CANCELLED/INVALIDATED sessions
// to verify that the salary query's own status filter is the last line of defense.
async function withAttendanceRaw(session: { id: number; schoolId: number },
                                  student: { id: number }) {
  const ss = await createSessionStudent(session.id, student.id, session.schoolId);
  await prisma.attendance.create({
    data: {
      schoolId: session.schoolId,
      lessonSessionId: session.id,
      studentProfileId: student.id,
      sessionStudentId: ss.id,
      status: 'PRESENT',
      creditDeducted: false,
    },
  });
}

describe('salary attribution — teacher identification', () => {
  it('counts session for regular teacher (teacherIdSnap, teacherId = null)', async () => {
    const { school, staff1, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id,
      date: new Date('2026-06-02T12:00:00.000Z'), status: 'COMPLETED' });
    await withAttendance(session, student);

    expect(await countLessons(staff1.id, school.id, '2026-06')).toBe(1);
  });

  it('counts session for substitute teacher (teacherId override)', async () => {
    const { school, staff1, staff2, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id,
      date: new Date('2026-06-02T12:00:00.000Z'), status: 'COMPLETED' });
    // Assign substitute
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { teacherId: staff2.id },
    });
    await withAttendance(session, student);

    expect(await countLessons(staff2.id, school.id, '2026-06')).toBe(1); // substitute gets credit
    expect(await countLessons(staff1.id, school.id, '2026-06')).toBe(0); // regular teacher does NOT
  });
});

describe('salary attribution — status exclusions', () => {
  it('does NOT count CANCELLED session', async () => {
    const { school, staff1, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id,
      date: new Date('2026-06-02T12:00:00.000Z'), status: 'CANCELLED' });
    // Raw insert bypasses the service-level SESSION_NOT_SUBMITTABLE guard to verify
    // that the salary query's own status filter is an independent line of defense.
    await withAttendanceRaw(session, student);

    expect(await countLessons(staff1.id, school.id, '2026-06')).toBe(0);
  });

  it('does NOT count INVALIDATED session', async () => {
    const { school, staff1, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id,
      date: new Date('2026-06-02T12:00:00.000Z'), status: 'INVALIDATED' });
    await withAttendanceRaw(session, student);

    expect(await countLessons(staff1.id, school.id, '2026-06')).toBe(0);
  });

  it('does NOT count session without any attendance', async () => {
    const { school, staff1, block } = await setup();

    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id,
      date: new Date('2026-06-02T12:00:00.000Z'), status: 'COMPLETED' });
    // No attendance created

    expect(await countLessons(staff1.id, school.id, '2026-06')).toBe(0);
  });

  it('counts LOCKED session (terminal status, salary-eligible)', async () => {
    const { school, staff1, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id,
      date: new Date('2026-06-02T12:00:00.000Z'), status: 'LOCKED' });
    // LOCKED sessions are terminal — use raw insert to bypass isAttendanceAllowed gate
    await withAttendanceRaw(session, student);

    expect(await countLessons(staff1.id, school.id, '2026-06')).toBe(1);
  });
});

describe('salary attribution — block split scenario', () => {
  it('after split: old teacher credited for pre-split COMPLETED sessions only', async () => {
    const { school, staff1, staff2, student, block } = await setup();

    // Pre-split: 2 completed sessions with staff1
    const s1 = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id,
      date: new Date('2026-06-01T12:00:00.000Z'), status: 'COMPLETED' });
    const s2 = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id,
      date: new Date('2026-06-03T12:00:00.000Z'), status: 'COMPLETED' });
    await withAttendance(s1, student);
    await withAttendance(s2, student);

    // Post-split: 1 session with staff2 (new block, teacherIdSnap = staff2)
    const block2 = await createBlock({ groupId: block.studentGroupId!, schoolId: school.id, staffProfileId: staff2.id });
    const s3 = await prisma.lessonSession.create({
      data: { schoolId: school.id, lessonBlockId: block2.id,
        date: new Date('2026-06-05T12:00:00.000Z'), status: 'COMPLETED',
        teacherIdSnap: staff2.id, startTimeSnap: '09:00', endTimeSnap: '10:00' },
    });
    await withAttendance(s3, student);

    expect(await countLessons(staff1.id, school.id, '2026-06')).toBe(2); // only pre-split sessions
    expect(await countLessons(staff2.id, school.id, '2026-06')).toBe(1); // only post-split session
  });
});
