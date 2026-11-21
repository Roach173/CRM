import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import {
  cleanDb,
  createBlock,
  createFinanceConfig,
  createGroup,
  createSchool,
  createSession,
  createSessionStudent,
  createStaffProfile,
  createStudentProfile,
  createUser,
  prisma,
} from '../helpers/testDb';
import scheduleRouter from '../../routes/schedule';
import { GroupLifecycleService } from '../../services/groupLifecycleService';
import { syncSessionsForBlock } from '../../services/sessionService';

let server: Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/schedule', scheduleRouter);
  server = app.listen(0, done);
});

beforeEach(cleanDb);

afterAll((done) => {
  server.close(() => {
    prisma.$disconnect().finally(done);
  });
});

function baseUrl() {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function tokenFor(user: { id: number; role: string }, schoolId: number) {
  return jwt.sign(
    { userId: user.id, schoolId, role: user.role },
    process.env.JWT_SECRET || 'your-secret-key-here'
  );
}

async function setup() {
  const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4, 5] });
  await createFinanceConfig(school.id, 1);
  const owner = await createUser(school.id, 'OWNER');
  const teacherUser = await createUser(school.id, 'TEACHER');
  const staff = await createStaffProfile(teacherUser.id, school.id);
  const studentUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(studentUser.id, school.id, 10);
  const group = await createGroup(school.id);
  const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  const token = tokenFor(owner, school.id);

  return { school, owner, staff, student, group, block, token };
}

function blockForSync(block: Awaited<ReturnType<typeof createBlock>>) {
  return {
    id: block.id,
    schoolId: block.schoolId,
    days: block.days,
    startDate: block.startDate,
    endDate: block.endDate,
    studentGroupId: block.studentGroupId,
    teacherId: block.teacherId,
    cabinetId: block.cabinetId,
    startTime: block.startTime,
    endTime: block.endTime,
  };
}

describe('Phase 4 paused group semantics', () => {
  it('ACTIVE -> PAUSED and PAUSED -> ACTIVE work and create audit logs', async () => {
    const { school, owner, group } = await setup();

    await GroupLifecycleService.pauseGroup({
      groupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      reason: 'temporary freeze',
    });
    await GroupLifecycleService.resumeGroup({
      groupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      reason: 'resume classes',
    });

    await expect(prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } }))
      .resolves.toMatchObject({ status: 'ACTIVE' });
    expect(await prisma.scheduleActionLog.count({ where: { groupId: group.id, action: 'GROUP_PAUSED' } })).toBe(1);
    expect(await prisma.scheduleActionLog.count({ where: { groupId: group.id, action: 'GROUP_RESUMED' } })).toBe(1);
  });

  it('PAUSED group does not generate new future sessions', async () => {
    const { school, owner, group, block } = await setup();
    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    const result = await syncSessionsForBlock(blockForSync(block));

    expect(result).toMatchObject({ skipped: true, reason: 'Cannot create sessions for paused group' });
    expect(await prisma.lessonSession.count({ where: { lessonBlockId: block.id } })).toBe(0);
  });

  it('existing sessions are not deleted or cancelled on pause', async () => {
    const { school, owner, staff, group, block } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'UPCOMING',
    });

    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    await expect(prisma.lessonSession.findUniqueOrThrow({ where: { id: session.id } }))
      .resolves.toMatchObject({ status: 'UPCOMING', deletedAt: null });
  });

  it('attendance submit for PAUSED group is rejected and credit is not deducted', async () => {
    const { school, owner, staff, student, group, block, token } = await setup();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'UPCOMING',
    });
    await createSessionStudent(session.id, student.id, school.id);
    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    const response = await fetch(`${baseUrl()}/schedule/session/submit-attendance`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        lessonBlockId: block.id,
        date: '2030-06-03',
        attendances: [{ studentProfileId: student.id, status: 'PRESENT' }],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe('GROUP_PAUSED');
    expect(await prisma.attendance.count({ where: { lessonSessionId: session.id } })).toBe(0);
    await expect(prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } }))
      .resolves.toMatchObject({ credits: 10 });
  });

  it('resume allows future session generation again', async () => {
    const { school, owner, group, block } = await setup();
    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });
    await syncSessionsForBlock(blockForSync(block));
    await GroupLifecycleService.resumeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    const result = await syncSessionsForBlock(blockForSync(block));

    expect(result.skipped).toBe(false);
    expect(result.created).toBeGreaterThan(0);
    expect(await prisma.lessonSession.count({ where: { lessonBlockId: block.id, status: 'UPCOMING' } })).toBeGreaterThan(0);
  });

  it('completed group still cannot generate sessions', async () => {
    const { school, owner, group, block } = await setup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });

    const result = await syncSessionsForBlock(blockForSync(block));

    expect(result).toMatchObject({ skipped: true, reason: 'Cannot create sessions for completed group' });
    expect(await prisma.lessonSession.count({ where: { lessonBlockId: block.id } })).toBe(0);
  });

  it('archived group cannot generate sessions', async () => {
    const { school, owner, group, block } = await setup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });
    await GroupLifecycleService.archiveGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    const result = await syncSessionsForBlock(blockForSync(block));

    expect(result).toMatchObject({ skipped: true, reason: 'Cannot create sessions for archived group' });
    expect(await prisma.lessonSession.count({ where: { lessonBlockId: block.id } })).toBe(0);
  });
});
