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
} from '../helpers/testDb';
import { archiveLessonBlock } from '../../services/blockArchiveService';
import { markAttendance } from '../../services/attendanceService';
import { canClearAllData } from '../../routes/settings';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
  await createFinanceConfig(school.id, 1);
  const teacherUser = await createUser(school.id, 'TEACHER');
  const staff = await createStaffProfile(teacherUser.id, school.id);
  const studentUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(studentUser.id, school.id, 10);
  const group = await createGroup(school.id);
  const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, staff, student, group, block };
}

describe('Phase 1 block archive safety', () => {
  it('cannot hard delete LessonBlock with Attendance through the normal archive path', async () => {
    const { school, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'IN_PROGRESS',
    });
    const snapshot = await createSessionStudent(session.id, student.id, school.id);
    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id,
        studentProfileId: student.id,
        schoolId: school.id,
        sessionStudentId: snapshot.id,
        status: 'PRESENT',
        sessionDate: session.date,
      })
    );

    const result = await archiveLessonBlock({ blockId: block.id, schoolId: school.id, role: 'OWNER' });

    expect(result.counts.attendances).toBe(1);
    expect(await prisma.lessonBlock.findUnique({ where: { id: block.id } })).toMatchObject({ id: block.id });
    expect(await prisma.attendance.count({ where: { lessonSessionId: session.id } })).toBe(1);
    expect(await prisma.lessonSession.count({ where: { id: session.id } })).toBe(1);
  });

  it('cannot hard delete LessonBlock with TeacherPaymentLesson through the normal archive path', async () => {
    const { school, staff, block } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2026-06-03T12:00:00.000Z'),
      status: 'COMPLETED',
    });
    const payment = await prisma.teacherPayment.create({
      data: {
        schoolId: school.id,
        staffProfileId: staff.id,
        period: '2026-06',
        lessonsCount: 1,
        rateSnapshot: 5000,
        amount: 5000,
      },
    });
    await prisma.teacherPaymentLesson.create({
      data: { paymentId: payment.id, lessonSessionId: session.id },
    });

    const result = await archiveLessonBlock({ blockId: block.id, schoolId: school.id, role: 'OWNER' });

    expect(result.counts.teacherPaymentLinks).toBe(1);
    expect(await prisma.teacherPaymentLesson.count({ where: { lessonSessionId: session.id } })).toBe(1);
    expect(await prisma.lessonSession.count({ where: { id: session.id } })).toBe(1);
  });

  it('cannot hard delete LessonBlock with completed LessonSession through the normal archive path', async () => {
    const { school, staff, block } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2026-06-03T12:00:00.000Z'),
      status: 'COMPLETED',
    });

    const result = await archiveLessonBlock({ blockId: block.id, schoolId: school.id, role: 'OWNER' });
    const preserved = await prisma.lessonSession.findUnique({ where: { id: session.id } });

    expect(result.counts.historicalSessions).toBe(1);
    expect(preserved?.status).toBe('COMPLETED');
  });

  it('deleting/archive block does not remove Attendance', async () => {
    const { school, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'IN_PROGRESS',
    });
    const snapshot = await createSessionStudent(session.id, student.id, school.id);
    const attendance = await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id,
        studentProfileId: student.id,
        schoolId: school.id,
        sessionStudentId: snapshot.id,
        status: 'LATE',
        sessionDate: session.date,
      })
    );

    await archiveLessonBlock({ blockId: block.id, schoolId: school.id, role: 'OWNER' });

    expect(await prisma.attendance.findUnique({ where: { id: attendance.id } })).not.toBeNull();
  });

  it('deleting/archive block does not remove SessionStudent snapshot', async () => {
    const { school, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
    });
    const snapshot = await createSessionStudent(session.id, student.id, school.id);

    await archiveLessonBlock({ blockId: block.id, schoolId: school.id, role: 'OWNER' });

    expect(await prisma.sessionStudent.findUnique({ where: { id: snapshot.id } })).not.toBeNull();
  });

  it('safe delete/archive future empty block works', async () => {
    const { school, staff, block } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'UPCOMING',
    });

    const result = await archiveLessonBlock({ blockId: block.id, schoolId: school.id, role: 'OWNER' });
    const archivedBlock = await prisma.lessonBlock.findUnique({ where: { id: block.id } });
    const invalidatedSession = await prisma.lessonSession.findUnique({ where: { id: session.id } });

    expect(result.invalidatedFutureSessions).toBe(1);
    expect(archivedBlock?.deletedAt).not.toBeNull();
    expect(archivedBlock?.status).toBe('CANCELLED');
    expect(invalidatedSession?.status).toBe('INVALIDATED');
  });
});

describe('Phase 1 dev reset guard', () => {
  it('clear-all-data forbidden in production', () => {
    expect(canClearAllData('production')).toBe(false);
    expect(canClearAllData('test')).toBe(true);
    expect(canClearAllData('development')).toBe(true);
  });
});
