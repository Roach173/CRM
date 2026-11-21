import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import jwt from 'jsonwebtoken';
import {
  cleanDb,
  createBlock,
  createGroup,
  createMembership,
  createSchool,
  createStaffProfile,
  createStudentProfile,
  createUser,
  createSession,
  prisma,
} from '../helpers/testDb';
import groupsRouter from '../../routes/groups';
import scheduleRouter from '../../routes/schedule';
import { GroupLifecycleService } from '../../services/groupLifecycleService';

let server: Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/groups', groupsRouter);
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

async function setupGroup() {
  const school = await createSchool({ timezone: 'UTC' });
  const owner = await createUser(school.id, 'OWNER');
  const group = await createGroup(school.id);
  return { school, owner, group };
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

describe('Phase 2 group lifecycle service', () => {
  it('ACTIVE -> PAUSED allowed and creates audit log', async () => {
    const { school, owner, group } = await setupGroup();

    await GroupLifecycleService.pauseGroup({
      groupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      reason: 'winter break',
    });

    const updated = await prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } });
    const audit = await prisma.scheduleActionLog.findFirstOrThrow({
      where: { groupId: group.id, action: 'GROUP_PAUSED' },
    });

    expect(updated.status).toBe('PAUSED');
    expect(audit.userId).toBe(owner.id);
    expect(audit.reason).toBe('winter break');
  });

  it('PAUSED -> ACTIVE allowed', async () => {
    const { school, owner, group } = await setupGroup();
    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    await GroupLifecycleService.resumeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    const updated = await prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(updated.status).toBe('ACTIVE');
    expect(await prisma.scheduleActionLog.count({ where: { groupId: group.id, action: 'GROUP_RESUMED' } })).toBe(1);
  });

  it('ACTIVE -> COMPLETED allowed', async () => {
    const { school, owner, group } = await setupGroup();

    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });

    const updated = await prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(updated.status).toBe('COMPLETED');
    expect(await prisma.scheduleActionLog.count({ where: { groupId: group.id, action: 'GROUP_COMPLETED' } })).toBe(1);
  });

  it('COMPLETED -> PAUSED forbidden', async () => {
    const { school, owner, group } = await setupGroup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });

    await expect(GroupLifecycleService.pauseGroup({
      groupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
    })).rejects.toMatchObject({ code: 'GROUP_TRANSITION_FORBIDDEN' });
  });

  it('COMPLETED -> ACTIVE forbidden through resume', async () => {
    const { school, owner, group } = await setupGroup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });

    await expect(GroupLifecycleService.resumeGroup({
      groupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
    })).rejects.toMatchObject({ code: 'GROUP_TRANSITION_FORBIDDEN' });
  });

  it('archive requires completed group', async () => {
    const { school, owner, group } = await setupGroup();

    await expect(GroupLifecycleService.archiveGroup({
      groupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      reason: 'duplicate group',
    })).rejects.toMatchObject({ code: 'GROUP_ARCHIVE_REQUIRES_COMPLETED' });
  });

  it('archive completed group uses lifecycle service and creates audit log', async () => {
    const { school, owner, group } = await setupGroup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });

    await GroupLifecycleService.archiveGroup({
      groupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      reason: 'old intake',
    });

    const updated = await prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } });
    const audit = await prisma.scheduleActionLog.findFirstOrThrow({
      where: { groupId: group.id, action: 'GROUP_ARCHIVED' },
    });

    expect(updated.deletedAt).not.toBeNull();
    expect(audit.reason).toBe('old intake');
  });

  it('archiving a group withdraws its active memberships (no dead ACTIVE links to a deleted group)', async () => {
    const { school, owner, group } = await setupGroup();
    const studentUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(studentUser.id, school.id);
    const membership = await createMembership(group.id, student.id, school.id);

    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });
    await GroupLifecycleService.archiveGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, reason: 'old intake' });

    const updatedGroup = await prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } });
    const updatedMembership = await prisma.groupMembership.findUniqueOrThrow({ where: { id: membership.id } });

    expect(updatedGroup.deletedAt).not.toBeNull();
    // Invariant: status=ACTIVE => studentGroup.deletedAt IS NULL
    expect(updatedMembership.status).toBe('WITHDRAWN');
    // completeGroup() closes active memberships itself now (so a COMPLETED-but-not-yet-
    // archived group stops feeding live schedule/roster queries) — archiveGroup()'s own
    // membership-closing update matches nothing here and leaves the earlier, true reason.
    expect(updatedMembership.leftReason).toBe('GROUP_COMPLETED');
    expect(updatedMembership.leftAt).not.toBeNull();
    expect(updatedMembership.leftAt!.getTime()).toBeLessThanOrEqual(updatedGroup.deletedAt!.getTime());

    // No ACTIVE membership in the school points to a soft-deleted group.
    const orphaned = await prisma.groupMembership.count({
      where: { schoolId: school.id, status: 'ACTIVE', studentGroup: { deletedAt: { not: null } } },
    });
    expect(orphaned).toBe(0);
  });

  it('archiving one group does not touch a student\'s membership in another live group', async () => {
    const { school, owner, group } = await setupGroup();
    const liveGroup = await createGroup(school.id);
    const studentUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(studentUser.id, school.id);
    const archivedMembership = await createMembership(group.id, student.id, school.id);
    const liveMembership = await createMembership(liveGroup.id, student.id, school.id);

    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });
    await GroupLifecycleService.archiveGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    expect((await prisma.groupMembership.findUniqueOrThrow({ where: { id: archivedMembership.id } })).status).toBe('WITHDRAWN');
    expect((await prisma.groupMembership.findUniqueOrThrow({ where: { id: liveMembership.id } })).status).toBe('ACTIVE');
  });
});

describe('Phase 2 group lifecycle routes', () => {
  it('PUT /groups/:id with status returns error', async () => {
    const { school, owner, group } = await setupGroup();
    const response = await requestJson(
      `/groups/${group.id}`,
      tokenFor(owner, school.id),
      { status: 'PAUSED' },
      'PUT'
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Use lifecycle endpoints to change group status');
    expect(await prisma.scheduleActionLog.count({
      where: { groupId: group.id, action: 'GROUP_STATUS_CHANGE_REJECTED' },
    })).toBe(1);
  });

  it('active group with no history can edit level/chapter', async () => {
    const { school, owner, group } = await setupGroup();
    const response = await requestJson(
      `/groups/${group.id}`,
      tokenFor(owner, school.id),
      { level: 'A2', chapter: 2, maxStudents: 12 },
      'PUT'
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ level: 'A2', chapter: 2, maxStudents: 12 });
  });

  it('group with blocks cannot edit level/chapter directly', async () => {
    const { school, owner, group } = await setupGroup();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });

    const response = await requestJson(
      `/groups/${group.id}`,
      tokenFor(owner, school.id),
      { level: 'A2' },
      'PUT'
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Level/chapter cannot be changed after group history exists. Use promotion flow.');
    await expect(prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } }))
      .resolves.toMatchObject({ level: 'A1' });
  });

  it('group with memberships cannot edit level/chapter directly', async () => {
    const { school, owner, group } = await setupGroup();
    const studentUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(studentUser.id, school.id);
    await createMembership(group.id, student.id, school.id);

    const response = await requestJson(
      `/groups/${group.id}`,
      tokenFor(owner, school.id),
      { chapter: 2 },
      'PUT'
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Level/chapter cannot be changed after group history exists. Use promotion flow.');
    await expect(prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } }))
      .resolves.toMatchObject({ chapter: 1 });
  });

  it('completed group cannot edit level/chapter directly', async () => {
    const { school, owner, group } = await setupGroup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });

    const response = await requestJson(
      `/groups/${group.id}`,
      tokenFor(owner, school.id),
      { level: 'A2' },
      'PUT'
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe('GROUP_COMPLETED');
  });

  it('lifecycle archive endpoint uses lifecycle service', async () => {
    const { school, owner, group } = await setupGroup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });
    const response = await requestJson(
      `/groups/${group.id}/lifecycle/archive`,
      tokenFor(owner, school.id),
      { reason: 'old intake' }
    );

    expect(response.status).toBe(200);
    expect(await prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } }))
      .toMatchObject({ deletedAt: expect.any(Date) });
    expect(await prisma.scheduleActionLog.count({ where: { groupId: group.id, action: 'GROUP_ARCHIVED' } })).toBe(1);
  });

  it('complete-group uses GroupLifecycleService for group status', async () => {
    const { school, owner, group } = await setupGroup();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });

    const response = await requestJson(
      `/schedule/blocks/${block.id}/complete-group`,
      tokenFor(owner, school.id),
      { fromDate: '2026-06-01' }
    );

    expect(response.status).toBe(200);
    expect(await prisma.studentGroup.findUniqueOrThrow({ where: { id: group.id } }))
      .toMatchObject({ status: 'COMPLETED' });
    expect(await prisma.scheduleActionLog.count({ where: { groupId: group.id, action: 'GROUP_COMPLETED' } })).toBe(1);
  });

  it('paused group cannot edit schedule or students', async () => {
    const { school, owner, group } = await setupGroup();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
    const cabinet = await prisma.cabinet.create({ data: { schoolId: school.id, name: '101', capacity: 12 } });
    const studentUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(studentUser.id, school.id);
    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });
    const token = tokenFor(owner, school.id);

    // block belongs to an active group-pair — the old single-block endpoint is no
    // longer the write path for grouped blocks (see group-pair write ownership
    // guard) and must reject with 409 GROUP_PAIR_OWNED before it ever reaches the
    // paused-group check.
    const legacyEndpointResponse = await requestJson(`/schedule/${block.id}`, token, { days: [1] }, 'PUT');
    const legacyEndpointBody = await legacyEndpointResponse.json();
    expect(legacyEndpointResponse.status).toBe(409);
    expect(legacyEndpointBody).toMatchObject({ code: 'GROUP_PAIR_OWNED' });

    // The official grouped-schedule write path does enforce the paused-group rule.
    const groupPairResponse = await requestJson(`/schedule/group-pair/${group.id}`, token, {
      cabinetId: cabinet.id,
      grammarDays: [1],
    }, 'PUT');
    expect(groupPairResponse.status).toBe(400);

    const studentResponse = await requestJson(`/groups/${group.id}/students`, token, { studentProfileIds: [student.id] });
    expect(studentResponse.status).toBe(422);
  });

  it('completed group cannot edit schedule or students', async () => {
    const { school, owner, group } = await setupGroup();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
    const studentUser = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(studentUser.id, school.id);
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });
    const token = tokenFor(owner, school.id);

    const scheduleResponse = await requestJson(`/schedule/${block.id}`, token, { days: [1] }, 'PUT');
    const studentResponse = await requestJson(`/groups/${group.id}/students`, token, { studentProfileIds: [student.id] });

    expect(scheduleResponse.status).toBe(400);
    expect(studentResponse.status).toBe(422);
  });

  it('archived group cannot mutate', async () => {
    const { school, owner, group } = await setupGroup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });
    await GroupLifecycleService.archiveGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    const response = await requestJson(
      `/groups/${group.id}`,
      tokenFor(owner, school.id),
      { name: 'Archived Rename' },
      'PUT'
    );

    expect(response.status).toBe(404);
  });

  it('schedule complete route and lifecycle complete route produce the same cascade', async () => {
    const { school, owner } = await setupGroup();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const scheduleGroup = await createGroup(school.id);
    const lifecycleGroup = await createGroup(school.id);
    const scheduleBlock = await createBlock({ groupId: scheduleGroup.id, schoolId: school.id, staffProfileId: staff.id });
    const lifecycleBlock = await createBlock({ groupId: lifecycleGroup.id, schoolId: school.id, staffProfileId: staff.id });
    await createSession({
      blockId: scheduleBlock.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'UPCOMING',
    });
    await createSession({
      blockId: lifecycleBlock.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'UPCOMING',
    });
    const token = tokenFor(owner, school.id);

    const scheduleResponse = await requestJson(
      `/schedule/blocks/${scheduleBlock.id}/complete-group`,
      token,
      { fromDate: '2030-06-01' }
    );
    const lifecycleResponse = await requestJson(
      `/groups/${lifecycleGroup.id}/lifecycle/complete`,
      token,
      { reason: 'complete from lifecycle route' }
    );

    expect(scheduleResponse.status).toBe(200);
    expect(lifecycleResponse.status).toBe(200);
    await expect(prisma.studentGroup.findUniqueOrThrow({ where: { id: scheduleGroup.id } }))
      .resolves.toMatchObject({ status: 'COMPLETED' });
    await expect(prisma.studentGroup.findUniqueOrThrow({ where: { id: lifecycleGroup.id } }))
      .resolves.toMatchObject({ status: 'COMPLETED' });
    expect(await prisma.lessonBlock.count({ where: { id: { in: [scheduleBlock.id, lifecycleBlock.id] }, status: 'COMPLETED' } })).toBe(2);
    expect(await prisma.lessonSession.count({
      where: { lessonBlockId: { in: [scheduleBlock.id, lifecycleBlock.id] }, status: 'INVALIDATED' },
    })).toBe(2);
  });
});
