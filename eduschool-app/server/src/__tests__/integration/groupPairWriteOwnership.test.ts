import express from 'express';
import request from 'supertest';
import { Role } from '@prisma/client';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStaffProfile,
  createGroup,
  createBlock,
} from '../helpers/testDb';
import scheduleRoutes from '../../routes/schedule';

process.env.NODE_ENV = 'test';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function buildScheduleApp(user: { id: number; schoolId: number | null; role: Role; tokenVersion?: number }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: user.id, schoolId: user.schoolId, role: user.role, tokenVersion: user.tokenVersion ?? 1 };
    next();
  });
  app.use('/api/schedule', scheduleRoutes);
  return app;
}

async function setup() {
  const school = await createSchool({ timezone: 'UTC' });
  const owner = await createUser(school.id, 'OWNER');
  const teacherUser = await createUser(school.id, 'TEACHER');
  const staff = await createStaffProfile(teacherUser.id, school.id);
  const cabinet = await prisma.cabinet.create({ data: { schoolId: school.id, name: '101', capacity: 12 } });
  const slot = await prisma.timeSlot.create({ data: { schoolId: school.id, startTime: '09:00', endTime: '10:00', order: 0 } });
  const group = await createGroup(school.id);
  return { school, owner, teacherUser, staff, cabinet, slot, group };
}

describe('PUT /schedule/:id — group pair write ownership guard', () => {
  it('rejects editing an active grouped block (409 GROUP_PAIR_OWNED, no mutation)', async () => {
    const { school, owner, staff, group } = await setup();
    const grammar = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR' });

    const res = await request(buildScheduleApp(owner))
      .put(`/api/schedule/${grammar.id}`)
      .send({ maxStudents: 20 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GROUP_PAIR_OWNED');

    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: grammar.id } });
    expect(after.maxStudents).toBe(grammar.maxStudents);
  });

  it('rejects saving a standalone block without binding it to a group (400 STUDENT_GROUP_REQUIRED, no mutation)', async () => {
    const { school, owner, staff, cabinet } = await setup();
    const block = await createBlock({ schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR' });
    await prisma.lessonBlock.update({ where: { id: block.id }, data: { cabinetId: cabinet.id } });

    const res = await request(buildScheduleApp(owner))
      .put(`/api/schedule/${block.id}`)
      .send({ maxStudents: 20 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STUDENT_GROUP_REQUIRED');
    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(after.maxStudents).toBe(block.maxStudents);
  });

  it('allows fixing a standalone block by binding it to an unscheduled group', async () => {
    const { school, owner, staff, cabinet, group } = await setup();
    const block = await createBlock({ schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR' });
    await prisma.lessonBlock.update({ where: { id: block.id }, data: { cabinetId: cabinet.id } });

    const res = await request(buildScheduleApp(owner))
      .put(`/api/schedule/${block.id}`)
      .send({ maxStudents: 20, studentGroupId: group.id });

    expect(res.status).toBe(200);
    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(after.studentGroupId).toBe(group.id);
  });

  it('rejects binding a standalone block to a group that already has an active pair (409 GROUP_ALREADY_IN_SCHEDULE)', async () => {
    const { school, owner, staff, cabinet, group } = await setup();
    await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR' });
    const orphan = await createBlock({ schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR' });
    await prisma.lessonBlock.update({ where: { id: orphan.id }, data: { cabinetId: cabinet.id } });

    const res = await request(buildScheduleApp(owner))
      .put(`/api/schedule/${orphan.id}`)
      .send({ studentGroupId: group.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GROUP_ALREADY_IN_SCHEDULE');
    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(after.studentGroupId).toBeNull();
  });

  it('rejects unbinding a closed historical grouped block (400 STUDENT_GROUP_REQUIRED)', async () => {
    const { school, owner, staff, cabinet, group } = await setup();
    const closed = await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR',
      startDate: new Date('2026-01-01T12:00:00.000Z'), endDate: new Date('2026-01-31T12:00:00.000Z'),
    });
    await prisma.lessonBlock.update({ where: { id: closed.id }, data: { cabinetId: cabinet.id } });

    const res = await request(buildScheduleApp(owner))
      .put(`/api/schedule/${closed.id}`)
      .send({ studentGroupId: null });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STUDENT_GROUP_REQUIRED');
    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: closed.id } });
    expect(after.studentGroupId).toBe(group.id);
  });

  it('does not block editing a closed historical grouped block (endDate set, not the active pair)', async () => {
    const { school, owner, staff, cabinet, group } = await setup();
    const closed = await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR',
      startDate: new Date('2026-01-01T12:00:00.000Z'), endDate: new Date('2026-01-31T12:00:00.000Z'),
    });
    await prisma.lessonBlock.update({ where: { id: closed.id }, data: { cabinetId: cabinet.id } });

    const res = await request(buildScheduleApp(owner))
      .put(`/api/schedule/${closed.id}`)
      .send({ maxStudents: 20 });

    expect(res.status).toBe(200);
    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: closed.id } });
    expect(after.maxStudents).toBe(20);
  });
});

describe('DELETE /schedule/:id — group pair write ownership guard', () => {
  it('rejects deleting an active grouped block (409 GROUP_PAIR_OWNED, no mutation)', async () => {
    const { school, owner, staff, group } = await setup();
    const grammar = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR' });

    const res = await request(buildScheduleApp(owner)).delete(`/api/schedule/${grammar.id}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GROUP_PAIR_OWNED');

    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: grammar.id } });
    expect(after.deletedAt).toBeNull();
  });

  it('still allows deleting a standalone block (no studentGroupId)', async () => {
    const { school, owner, staff } = await setup();
    const block = await createBlock({ schoolId: school.id, staffProfileId: staff.id });

    const res = await request(buildScheduleApp(owner)).delete(`/api/schedule/${block.id}`);

    expect(res.status).toBe(200);
    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(after.deletedAt).not.toBeNull();
  });
});

describe('POST /schedule — group-already-scheduled guard', () => {
  it('rejects creating a block for a studentGroup that already has an active pair (409 GROUP_ALREADY_IN_SCHEDULE, no new block)', async () => {
    const { school, owner, teacherUser, staff, cabinet, slot, group } = await setup();
    await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR' });

    const before = await prisma.lessonBlock.count({ where: { schoolId: school.id } });

    const res = await request(buildScheduleApp(owner))
      .post('/api/schedule')
      .send({
        studentGroupId: group.id,
        cabinetId: cabinet.id,
        timeSlotId: slot.id,
        days: [1, 3],
        teacherId: teacherUser.id,
        level: 'A1',
        chapter: 1,
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GROUP_ALREADY_IN_SCHEDULE');

    const after = await prisma.lessonBlock.count({ where: { schoolId: school.id } });
    expect(after).toBe(before);
  });

  it('allows creating a block for a studentGroup whose only existing blocks are closed/deleted history', async () => {
    const { school, owner, teacherUser, staff, cabinet, slot, group } = await setup();
    await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR',
      startDate: new Date('2026-01-01T12:00:00.000Z'), endDate: new Date('2026-01-31T12:00:00.000Z'),
    });
    await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'SPEAKING_CLUB',
      deletedAt: new Date('2026-02-01T00:00:00.000Z'), status: 'CANCELLED',
    });

    const res = await request(buildScheduleApp(owner))
      .post('/api/schedule')
      .send({
        studentGroupId: group.id,
        cabinetId: cabinet.id,
        timeSlotId: slot.id,
        days: [1, 3],
        teacherId: teacherUser.id,
        level: 'A1',
        chapter: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects creating a standalone block without studentGroupId (400 STUDENT_GROUP_REQUIRED, no new block)', async () => {
    const { school, owner, teacherUser, cabinet, slot } = await setup();
    const before = await prisma.lessonBlock.count({ where: { schoolId: school.id } });

    const res = await request(buildScheduleApp(owner))
      .post('/api/schedule')
      .send({
        cabinetId: cabinet.id,
        timeSlotId: slot.id,
        days: [1, 3],
        teacherId: teacherUser.id,
        level: 'A1',
        chapter: 1,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STUDENT_GROUP_REQUIRED');
    const after = await prisma.lessonBlock.count({ where: { schoolId: school.id } });
    expect(after).toBe(before);
  });
});
