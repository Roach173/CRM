import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import {
  cleanDb,
  createBlock,
  createFinanceConfig,
  createGroup,
  createMembership,
  createSchool,
  createSession,
  createSessionStudent,
  createStaffProfile,
  createStudentProfile,
  createUser,
  prisma,
} from '../helpers/testDb';
import scheduleRouter from '../../routes/schedule';
import settingsRouter from '../../routes/settings';

let server: Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/schedule', scheduleRouter);
  app.use('/settings', settingsRouter);
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

async function requestJson(path: string, token: string, body: Record<string, unknown>, method = 'POST') {
  return fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
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

async function completeGroup(blockId: number, token: string) {
  return requestJson(
    `/schedule/blocks/${blockId}/complete-group`,
    token,
    { fromDate: '2030-06-01' }
  );
}

describe('Phase 3 group completion semantics', () => {
  it('complete-group does not mark future sessions as CANCELLED and marks them INVALIDATED', async () => {
    const { school, staff, block, token } = await setup();
    const future = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'UPCOMING',
    });
    const inProgress = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-04T12:00:00.000Z'),
      status: 'IN_PROGRESS',
    });

    const response = await completeGroup(block.id, token);

    expect(response.status).toBe(200);
    await expect(prisma.lessonSession.findUniqueOrThrow({ where: { id: future.id } }))
      .resolves.toMatchObject({ status: 'INVALIDATED' });
    await expect(prisma.lessonSession.findUniqueOrThrow({ where: { id: inProgress.id } }))
      .resolves.toMatchObject({ status: 'INVALIDATED' });
    expect(await prisma.lessonSession.count({
      where: { id: { in: [future.id, inProgress.id] }, status: 'CANCELLED' },
    })).toBe(0);
    await expect(prisma.lessonBlock.findUniqueOrThrow({ where: { id: block.id } }))
      .resolves.toMatchObject({ status: 'COMPLETED', endDate: expect.any(Date) });
  });

  it('real cancelled lesson remains CANCELLED but completed group blocks new makeup', async () => {
    const { school, staff, block, token } = await setup();
    const cancelled = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-05T12:00:00.000Z'),
      status: 'CANCELLED',
    });

    const completeResponse = await completeGroup(block.id, token);
    const makeupResponse = await requestJson(
      `/schedule/session/${cancelled.id}/makeup`,
      token,
      { date: '2030-06-12', reason: 'makeup for cancelled session' }
    );

    expect(completeResponse.status).toBe(200);
    expect(makeupResponse.status).toBe(422);
    await expect(prisma.lessonSession.findUniqueOrThrow({ where: { id: cancelled.id } }))
      .resolves.toMatchObject({ status: 'CANCELLED' });
    expect(await prisma.lessonSession.count({
      where: { makeupForSessionId: cancelled.id, status: 'UPCOMING' },
    })).toBe(0);
  });

  it('makeup cannot be created for GROUP_COMPLETED invalidated lesson', async () => {
    const { school, staff, block, token } = await setup();
    const future = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-06T12:00:00.000Z'),
      status: 'UPCOMING',
    });
    await completeGroup(block.id, token);

    const response = await requestJson(
      `/schedule/session/${future.id}/makeup`,
      token,
      { date: '2030-06-13', reason: 'makeup for invalidated session' }
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe('GROUP_COMPLETED');
  });

  it('cancellation metrics do not count group completion invalidations', async () => {
    const { school, staff, block, token } = await setup();
    await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-07T12:00:00.000Z'),
      status: 'UPCOMING',
    });
    await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-08T12:00:00.000Z'),
      status: 'CANCELLED',
    });

    await completeGroup(block.id, token);

    expect(await prisma.lessonSession.count({
      where: { schoolId: school.id, status: 'CANCELLED' },
    })).toBe(1);
    expect(await prisma.lessonSession.count({
      where: { schoolId: school.id, status: 'INVALIDATED' },
    })).toBe(1);
  });

  it('complete-group uses lifecycle audit and writes invalidation audit', async () => {
    const { school, staff, group, block, token } = await setup();
    await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-09T12:00:00.000Z'),
      status: 'UPCOMING',
    });

    await completeGroup(block.id, token);

    expect(await prisma.scheduleActionLog.count({
      where: { groupId: group.id, action: 'GROUP_COMPLETED' },
    })).toBe(1);
    const invalidationAudit = await prisma.scheduleActionLog.findFirstOrThrow({
      where: { groupId: group.id, action: 'GROUP_COMPLETION_INVALIDATED_FUTURE_SESSIONS' },
    });
    expect(invalidationAudit.reason).toBe('GROUP_COMPLETED');
    expect(invalidationAudit.after).toMatchObject({ invalidatedSessions: 1, blockIds: [block.id] });
  });

  it('timeslot policy does not add legacy rows for group-completion INVALIDATED sessions', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4, 5], workStart: '10:00', workEnd: '18:00', slotDuration: 60 });
    await createFinanceConfig(school.id, 1);
    const owner = await createUser(school.id, 'OWNER');
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
    const token = tokenFor(owner, school.id);
    await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'UPCOMING',
    });

    const completeResponse = await completeGroup(block.id, token);
    const slotsResponse = await fetch(`${baseUrl()}/settings/timeslots?date=2030-06-03`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await slotsResponse.json();
    const slotTimes = body.data.slots.map((slot: { startTime: string; endTime: string }) => `${slot.startTime}|${slot.endTime}`);

    expect(completeResponse.status).toBe(200);
    expect(slotsResponse.status).toBe(200);
    expect(slotTimes).not.toContain('09:00|10:00');
  });

  it('completed group history remains readable and past attendance/credits are unchanged', async () => {
    const { school, staff, student, group, block, token } = await setup();
    const past = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2026-05-20T12:00:00.000Z'),
      status: 'COMPLETED',
    });
    const snapshot = await createSessionStudent(past.id, student.id, school.id);
    const attendance = await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: past.id,
        studentProfileId: student.id,
        sessionStudentId: snapshot.id,
        status: 'PRESENT',
        creditDeducted: true,
      },
    });
    const creditsAfterAttendance = (await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } })).credits;

    await completeGroup(block.id, token);

    const completedGroup = await prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } });
    const preservedAttendance = await prisma.attendance.findUniqueOrThrow({ where: { id: attendance.id } });
    const preservedSession = await prisma.lessonSession.findUniqueOrThrow({ where: { id: past.id } });
    const studentAfterCompletion = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });

    expect(completedGroup.status).toBe('COMPLETED');
    expect(completedGroup.deletedAt).toBeNull();
    expect(preservedSession.status).toBe('COMPLETED');
    expect(preservedAttendance).toMatchObject({ status: 'PRESENT', creditDeducted: true });
    expect(studentAfterCompletion.credits).toBe(creditsAfterAttendance);
  });

  it('completing a group withdraws its active memberships (regression: a COMPLETED-but-not-archived group kept feeding the student\'s live schedule)', async () => {
    const { school, student, group, block, token } = await setup();
    const membership = await createMembership(group.id, student.id, school.id);

    const response = await completeGroup(block.id, token);

    expect(response.status).toBe(200);
    const updatedMembership = await prisma.groupMembership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(updatedMembership.status).toBe('WITHDRAWN');
    expect(updatedMembership.leftReason).toBe('GROUP_COMPLETED');
    expect(updatedMembership.leftAt).not.toBeNull();

    // The exact query /schedule/student uses to decide "is this block on the student's
    // live schedule" — must no longer match the completed group's block.
    const stillActive = await prisma.lessonBlock.findFirst({
      where: {
        id: block.id,
        studentGroup: { memberships: { some: { studentProfileId: student.id, status: 'ACTIVE' } } },
      },
    });
    expect(stillActive).toBeNull();
  });
});
