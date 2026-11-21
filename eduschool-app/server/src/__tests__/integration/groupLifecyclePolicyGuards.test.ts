/**
 * INTEGRATION TESTS — groupLifecyclePolicy backend guards
 *
 * Tests that backend routes enforce lifecycle policy correctly:
 *   - Metadata edit allowed for COMPLETED/PAUSED (name only)
 *   - maxStudents blocked for COMPLETED
 *   - Student add/remove blocked for PAUSED/COMPLETED
 *   - createMakeupSession blocked for PAUSED/COMPLETED groups
 *   - replaceTeacher blocked for PAUSED/COMPLETED groups
 *   - rescheduleSession blocked for PAUSED/COMPLETED groups
 */

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
  createSession,
  createStaffProfile,
  createStudentProfile,
  createUser,
  prisma,
} from '../helpers/testDb';
import groupsRouter from '../../routes/groups';
import scheduleRouter from '../../routes/schedule';
import { GroupLifecycleService } from '../../services/groupLifecycleService';
import {
  createMakeupSession,
  replaceTeacher,
  rescheduleSession,
} from '../../services/scheduleLifecycleService';
import type { LifecycleActor } from '../../services/scheduleLifecycleTypes';

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

async function req(
  path: string,
  token: string,
  body: Record<string, unknown>,
  method = 'POST'
) {
  return fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

// ─── Metadata edit ─────────────────────────────────────────────────────────────

describe('PUT /groups/:id — metadata edit policy', () => {
  it('blocks maxStudents edit for COMPLETED group', async () => {
    const school = await createSchool();
    const owner  = await createUser(school.id, 'OWNER');
    const token  = tokenFor(owner, school.id);
    const group  = await createGroup(school.id);

    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });

    const res = await req(`/groups/${group.id}`, token, { maxStudents: 20 }, 'PUT');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('GROUP_COMPLETED');
  });

  it('blocks maxStudents edit for PAUSED group', async () => {
    const school = await createSchool();
    const owner  = await createUser(school.id, 'OWNER');
    const token  = tokenFor(owner, school.id);
    const group  = await createGroup(school.id);

    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    const res = await req(`/groups/${group.id}`, token, { maxStudents: 20 }, 'PUT');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('GROUP_PAUSED');
  });
});

// ─── Student mutations ─────────────────────────────────────────────────────────

describe('POST /groups/:id/students — add students', () => {
  it('blocks add for PAUSED group', async () => {
    const school       = await createSchool();
    const owner        = await createUser(school.id, 'OWNER');
    const token        = tokenFor(owner, school.id);
    const group        = await createGroup(school.id);
    const studentUser  = await createUser(school.id, 'STUDENT');
    const student      = await createStudentProfile(studentUser.id, school.id);

    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    const res = await req(`/groups/${group.id}/students`, token, { studentProfileIds: [student.id] });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('GROUP_PAUSED');
  });

  it('blocks add for COMPLETED group', async () => {
    const school       = await createSchool();
    const owner        = await createUser(school.id, 'OWNER');
    const token        = tokenFor(owner, school.id);
    const group        = await createGroup(school.id);
    const studentUser  = await createUser(school.id, 'STUDENT');
    const student      = await createStudentProfile(studentUser.id, school.id);

    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });

    const res = await req(`/groups/${group.id}/students`, token, { studentProfileIds: [student.id] });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('GROUP_COMPLETED');
  });
});

describe('DELETE /groups/:id/students/:studentId — remove students', () => {
  it('blocks remove for PAUSED group', async () => {
    const school       = await createSchool();
    const owner        = await createUser(school.id, 'OWNER');
    const token        = tokenFor(owner, school.id);
    const group        = await createGroup(school.id);
    const studentUser  = await createUser(school.id, 'STUDENT');
    const student      = await createStudentProfile(studentUser.id, school.id);
    await createMembership(group.id, student.id, school.id);

    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id });

    const res = await req(`/groups/${group.id}/students/${student.id}`, token, {}, 'DELETE');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('GROUP_PAUSED');
  });

  it('blocks remove for COMPLETED group', async () => {
    const school       = await createSchool();
    const owner        = await createUser(school.id, 'OWNER');
    const token        = tokenFor(owner, school.id);
    const group        = await createGroup(school.id);
    const studentUser  = await createUser(school.id, 'STUDENT');
    const student      = await createStudentProfile(studentUser.id, school.id);
    await createMembership(group.id, student.id, school.id);

    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: owner.id, role: 'OWNER' });

    const res = await req(`/groups/${group.id}/students/${student.id}`, token, {}, 'DELETE');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('GROUP_COMPLETED');
  });
});

// ─── Session mutations via scheduleLifecycleService ───────────────────────────

describe('createMakeupSession — group lifecycle guard', () => {
  async function setup() {
    const school     = await createSchool();
    const owner      = await createUser(school.id, 'OWNER');
    const staffUser  = await createUser(school.id, 'TEACHER');
    const staff      = await createStaffProfile(staffUser.id, school.id);
    const group      = await createGroup(school.id);
    const block      = await createBlock({ schoolId: school.id, groupId: group.id, staffProfileId: staff.id });
    const session    = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'CANCELLED',
    });
    const actor: LifecycleActor = { userId: owner.id, role: 'OWNER' as any, schoolId: school.id };
    return { school, owner, group, block, session, actor };
  }

  it('blocks makeup for PAUSED group', async () => {
    const { school, group, session, actor } = await setup();
    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: actor.userId });

    await expect(createMakeupSession({
      originalSessionId: session.id,
      schoolId: school.id,
      actor,
      newDate: new Date(Date.now() + 7 * 86400000),
      reason: 'test makeup',
    })).rejects.toMatchObject({ code: 'GROUP_PAUSED' });
  });

  it('blocks makeup for COMPLETED group', async () => {
    const { school, group, session, actor } = await setup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: actor.userId, role: 'OWNER' });

    await expect(createMakeupSession({
      originalSessionId: session.id,
      schoolId: school.id,
      actor,
      newDate: new Date(Date.now() + 7 * 86400000),
      reason: 'test makeup',
    })).rejects.toMatchObject({ code: 'GROUP_COMPLETED' });
  });
});

describe('replaceTeacher — group lifecycle guard', () => {
  async function setup() {
    const school      = await createSchool();
    const owner       = await createUser(school.id, 'OWNER');
    const staff1User  = await createUser(school.id, 'TEACHER');
    const staff1      = await createStaffProfile(staff1User.id, school.id);
    const staff2User  = await createUser(school.id, 'TEACHER');
    const staff2      = await createStaffProfile(staff2User.id, school.id);
    const group       = await createGroup(school.id);
    const block       = await createBlock({ schoolId: school.id, groupId: group.id, staffProfileId: staff1.id });
    const session     = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff1.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'UPCOMING',
    });
    const actor: LifecycleActor = { userId: owner.id, role: 'OWNER' as any, schoolId: school.id };
    return { school, group, session, staff2, actor };
  }

  it('blocks replaceTeacher for PAUSED group', async () => {
    const { school, group, session, staff2, actor } = await setup();
    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: actor.userId });

    await expect(replaceTeacher({
      sessionId: session.id,
      schoolId: school.id,
      actor,
      substituteStaffProfileId: staff2.id,
      reason: 'sub needed',
    })).rejects.toMatchObject({ code: 'GROUP_PAUSED' });
  });

  it('blocks replaceTeacher for COMPLETED group', async () => {
    const { school, group, session, staff2, actor } = await setup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: actor.userId, role: 'OWNER' });

    await expect(replaceTeacher({
      sessionId: session.id,
      schoolId: school.id,
      actor,
      substituteStaffProfileId: staff2.id,
      reason: 'sub needed',
    })).rejects.toMatchObject({ code: 'GROUP_COMPLETED' });
  });
});

describe('rescheduleSession — group lifecycle guard', () => {
  async function setup() {
    const school    = await createSchool();
    const owner     = await createUser(school.id, 'OWNER');
    const staffUser = await createUser(school.id, 'TEACHER');
    const staff     = await createStaffProfile(staffUser.id, school.id);
    const group     = await createGroup(school.id);
    const block     = await createBlock({ schoolId: school.id, groupId: group.id, staffProfileId: staff.id });
    const session   = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2030-06-03T12:00:00.000Z'),
      status: 'UPCOMING',
    });
    const actor: LifecycleActor = { userId: owner.id, role: 'OWNER' as any, schoolId: school.id };
    return { school, group, session, block, actor };
  }

  it('blocks rescheduleSession for PAUSED group', async () => {
    const { school, group, session, actor } = await setup();
    await GroupLifecycleService.pauseGroup({ groupId: group.id, schoolId: school.id, actorId: actor.userId });

    await expect(rescheduleSession({
      sessionId: session.id,
      schoolId: school.id,
      actor,
      reason: 'room change',
    })).rejects.toMatchObject({ code: 'GROUP_PAUSED' });
  });

  it('blocks rescheduleSession for COMPLETED group', async () => {
    const { school, group, session, actor } = await setup();
    await GroupLifecycleService.completeGroup({ groupId: group.id, schoolId: school.id, actorId: actor.userId, role: 'OWNER' });

    await expect(rescheduleSession({
      sessionId: session.id,
      schoolId: school.id,
      actor,
      reason: 'room change',
    })).rejects.toMatchObject({ code: 'GROUP_COMPLETED' });
  });
});
