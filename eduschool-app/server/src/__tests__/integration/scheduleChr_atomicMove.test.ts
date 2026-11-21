import {
  prisma, cleanDb, createSchool, createUser,
  createStaffProfile, createGroup, createBlock, createSession,
  createFinanceConfig, createStudentProfile, createSessionStudent,
} from '../helpers/testDb';
import { moveSession } from '../../services/scheduleLifecycleService';
import { syncSessionsForBlock } from '../../services/sessionService';
import type { LifecycleActor } from '../../services/scheduleLifecycleTypes';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

const REASON = 'teacher is sick today';
const ORIG_DATE = new Date('2026-06-22T12:00:00.000Z'); // Monday, inside rolling window on 2026-06-21
const TARGET_DATE = new Date('2026-06-23T12:00:00.000Z'); // Tuesday

async function setup() {
  const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4, 5, 6] });
  await createFinanceConfig(school.id, 1); // freeze enforcement uses School.settings.pauseRules, not freezeWindowHours
  const owner = await createUser(school.id, 'OWNER');
  const teacher = await createUser(school.id, 'TEACHER');
  const staff = await createStaffProfile(teacher.id, school.id);
  await prisma.staffProfile.update({
    where: { id: staff.id },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  const group = await createGroup(school.id);
  const block = await createBlock({
    groupId: group.id,
    schoolId: school.id,
    staffProfileId: staff.id,
    days: [0],
  });
  const cabinet = await prisma.cabinet.create({
    data: { schoolId: school.id, name: 'Room 1', capacity: 20 },
  });
  const actor: LifecycleActor = { userId: owner.id, role: 'OWNER', schoolId: school.id };
  return { school, owner, teacher, staff, group, block, cabinet, actor };
}

describe('moveSession - update same clean session', () => {
  it('moves the same LessonSession row without creating a makeup', async () => {
    const { school, staff, block, cabinet, actor } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: ORIG_DATE,
      status: 'UPCOMING',
    });

    const result = await moveSession({
      sessionId: session.id,
      schoolId: school.id,
      actor,
      newDate: TARGET_DATE,
      newStartTime: '09:00',
      newEndTime: '10:00',
      newCabinetId: cabinet.id,
      reason: REASON,
      versionGuard: session.version,
    });

    expect(result.session.id).toBe(session.id);
    expect(result.session.isMakeup).toBe(false);
    expect(result.session.makeupForSessionId).toBeNull();

    const dbSession = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(dbSession!.status).toBe('UPCOMING');
    expect(dbSession!.date.toISOString()).toBe(TARGET_DATE.toISOString());
    expect(dbSession!.isManualDate).toBe(true);
    expect(dbSession!.dateOverrideFrom!.toISOString()).toBe(ORIG_DATE.toISOString());
    expect(dbSession!.isManualTime).toBe(true);
    expect(dbSession!.isManualCabinet).toBe(true);

    const makeups = await prisma.lessonSession.findMany({
      where: { makeupForSessionId: session.id, deletedAt: null },
    });
    expect(makeups).toHaveLength(0);

    const logs = await prisma.scheduleActionLog.findMany({
      where: { schoolId: school.id },
      select: { action: true },
    });
    expect(logs.map(l => l.action)).toEqual(['SESSION_MOVED']);
  });

  it('syncSessionsForBlock does not recreate the old planned date after a manual date move', async () => {
    const { school, staff, block, cabinet, actor } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: ORIG_DATE,
      status: 'UPCOMING',
    });

    await moveSession({
      sessionId: session.id,
      schoolId: school.id,
      actor,
      newDate: TARGET_DATE,
      newStartTime: '09:00',
      newEndTime: '10:00',
      newCabinetId: cabinet.id,
      reason: REASON,
      versionGuard: session.version,
    });

    await syncSessionsForBlock(block);

    const sessions = await prisma.lessonSession.findMany({
      where: { lessonBlockId: block.id, deletedAt: null },
      orderBy: { id: 'asc' },
    });
    expect(sessions.some(s => s.date.toISOString() === ORIG_DATE.toISOString())).toBe(false);
    const moved = sessions.find(s => s.id === session.id);
    expect(moved).toBeDefined();
    expect(moved!.date.toISOString()).toBe(TARGET_DATE.toISOString());
  });

  it('blocks move when attendance rows already exist', async () => {
    const { school, staff, block, cabinet, actor } = await setup();
    const studentUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(studentUser.id, school.id);
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: ORIG_DATE,
      status: 'UPCOMING',
    });
    const sessionStudent = await createSessionStudent(session.id, student.id, school.id);
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: student.id,
        sessionStudentId: sessionStudent.id,
        status: 'PRESENT',
      },
    });

    await expect(moveSession({
      sessionId: session.id,
      schoolId: school.id,
      actor,
      newDate: TARGET_DATE,
      newStartTime: '09:00',
      newEndTime: '10:00',
      newCabinetId: cabinet.id,
      reason: REASON,
      versionGuard: session.version,
    })).rejects.toMatchObject({ message: 'SESSION_NOT_MOVABLE', httpStatus: 409 });

    const dbSession = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(dbSession!.date.toISOString()).toBe(ORIG_DATE.toISOString());
  });
});
