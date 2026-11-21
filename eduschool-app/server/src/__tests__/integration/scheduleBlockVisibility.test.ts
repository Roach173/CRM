import express from 'express';
import request from 'supertest';
import { BlockType, Role } from '@prisma/client';
import { cleanDb, prisma } from '../helpers/testDb';
import scheduleRoutes from '../../routes/schedule';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function buildScheduleApp(user: { id: number; schoolId: number | null; role: Role; tokenVersion: number }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: user.id, schoolId: user.schoolId, role: user.role, tokenVersion: user.tokenVersion };
    next();
  });
  app.use('/api/schedule', scheduleRoutes);
  return app;
}

async function seedBase(name: string) {
  const school = await prisma.school.create({
    data: {
      name,
      city: 'Bishkek',
      email: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}@test.local`,
      slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
      timezone: 'UTC',
      activeDays: [0, 1, 2, 3, 4, 5],
      workStart: '08:00',
      workEnd: '12:00',
      slotDuration: 60,
    },
  });
  const owner = await prisma.user.create({
    data: {
      schoolId: school.id,
      role: Role.OWNER,
      firstName: 'Owner',
      lastName: 'One',
      email: `owner-${Date.now()}-${Math.random()}@test.local`,
      password: 'hashed',
    },
  });
  const teacherUser = await prisma.user.create({
    data: {
      schoolId: school.id,
      role: Role.TEACHER,
      firstName: 'Teacher',
      lastName: 'One',
      email: `teacher-${Date.now()}-${Math.random()}@test.local`,
      password: 'hashed',
    },
  });
  const teacher = await prisma.staffProfile.create({
    data: { userId: teacherUser.id, salaryRate: 5000, workingDays: [0, 1, 2, 3, 4, 5] },
  });
  const cabinet = await prisma.cabinet.create({
    data: { schoolId: school.id, name: '101', capacity: 12 },
  });
  const group = await prisma.studentGroup.create({
    data: { schoolId: school.id, level: 'A1', chapter: 1, maxStudents: 12 },
  });
  const slot = await prisma.timeSlot.create({
    data: { schoolId: school.id, startTime: '08:00', endTime: '09:00', order: 0 },
  });
  return { school, owner, teacherUser, teacher, cabinet, group, slot };
}

async function makeBlock(seed: Awaited<ReturnType<typeof seedBase>>, overrides: Partial<{
  status: 'UPCOMING' | 'COMPLETED' | 'CANCELLED';
  startDate: Date;
  endDate: Date | null;
  deletedAt: Date | null;
}> = {}) {
  return prisma.lessonBlock.create({
    data: {
      schoolId: seed.school.id,
      cabinetId: seed.cabinet.id,
      teacherId: seed.teacher.id,
      studentGroupId: seed.group.id,
      timeSlotId: seed.slot.id,
      startTime: '08:00',
      endTime: '09:00',
      days: [1, 3], // Tue, Thu — inside the requested week below
      level: 'A1',
      chapter: 1,
      maxStudents: 12,
      type: BlockType.GRAMMAR,
      startDate: overrides.startDate ?? new Date('2026-06-15T00:00:00.000Z'),
      endDate: overrides.endDate ?? null,
      status: overrides.status ?? 'UPCOMING',
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

// The week under test — matches the block's [1,3] (Tue/Thu) days.
const WEEK_START = '2026-06-29';
const WEEK_END = '2026-07-05';

function findBlock(res: request.Response, blockId: number) {
  return (res.body.data as any[]).find(b => b.id === blockId);
}

describe('GET /schedule?start&end — block visibility truth display', () => {
  it('returns an ACTIVE block as ACTIVE, schedule-active, editable, and conflict-eligible', async () => {
    const seed = await seedBase('Visibility Active');
    const block = await makeBlock(seed);

    const res = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule')
      .query({ start: WEEK_START, end: WEEK_END });

    expect(res.status).toBe(200);
    const found = findBlock(res, block.id);
    expect(found).toMatchObject({
      blockVisibility: 'ACTIVE',
      visibilityReason: 'active block',
      isScheduleActive: true,
      isReadOnly: false,
      conflictEligible: true,
    });
  });

  it('returns a completed group\'s block (endDate already passed) as COMPLETED and read-only', async () => {
    const seed = await seedBase('Visibility Completed');
    // Mirrors completeGroup(): endDate + status COMPLETED together, deletedAt stays null,
    // date range still intersects the requested week.
    const block = await makeBlock(seed, {
      status: 'COMPLETED',
      endDate: new Date('2026-07-01T00:00:00.000Z'),
    });
    await prisma.studentGroup.update({ where: { id: seed.group.id }, data: { status: 'COMPLETED' } });

    const res = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule')
      .query({ start: WEEK_START, end: WEEK_END });

    expect(res.status).toBe(200);
    const found = findBlock(res, block.id);
    expect(found).toMatchObject({
      blockVisibility: 'COMPLETED',
      visibilityReason: 'status COMPLETED',
      isScheduleActive: false,
      isReadOnly: true,
      conflictEligible: false,
    });
  });

  it('returns a block closed mid-week via endDate (status still UPCOMING) as CLOSED_BY_END_DATE', async () => {
    const seed = await seedBase('Visibility Closed By End Date');
    // Reschedule/split shape: endDate set, status never transitioned.
    const block = await makeBlock(seed, {
      endDate: new Date('2026-07-01T00:00:00.000Z'),
    });

    const res = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule')
      .query({ start: WEEK_START, end: WEEK_END });

    expect(res.status).toBe(200);
    const found = findBlock(res, block.id);
    expect(found).toMatchObject({
      blockVisibility: 'CLOSED_BY_END_DATE',
      visibilityReason: 'endDate already passed',
      isReadOnly: true,
      conflictEligible: false,
    });
  });

  it('returns an undeleted CANCELLED block (via PATCH /:id/status) as CANCELLED and read-only, but still conflictEligible (known, reported gap)', async () => {
    const seed = await seedBase('Visibility Cancelled');
    const block = await makeBlock(seed);

    const patch = await request(buildScheduleApp(seed.owner))
      .patch(`/api/schedule/${block.id}/status`)
      .send({ status: 'CANCELLED' });
    expect(patch.status).toBe(200);

    const res = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule')
      .query({ start: WEEK_START, end: WEEK_END });

    expect(res.status).toBe(200);
    const found = findBlock(res, block.id);
    expect(found).toMatchObject({
      blockVisibility: 'CANCELLED',
      visibilityReason: 'status CANCELLED',
      isReadOnly: true,
      // Known, deliberately-not-fixed-here gap: none of the 5 conflict-check query
      // sites filter on `status`, only deletedAt/endDate.
      conflictEligible: true,
    });
  });
});

describe('GET /schedule?start&end — soft-deleted (tombstone) block truth display', () => {
  it('includes a soft-deleted block that has a real session dated within the requested week', async () => {
    const seed = await seedBase('Visibility Soft-Deleted With Session');
    // Mirrors the real-world reported case (block id 65): a short-lived block whose
    // own window covers the session date — isSessionInsideBlockVersion (the
    // versioning-chain guard) requires the session to fall within [startDate,endDate],
    // so this is the realistic session-backed shape, not an orphaned cross-version one.
    const block = await makeBlock(seed, {
      startDate: new Date('2026-06-25T00:00:00.000Z'),
      endDate: new Date('2026-07-01T12:00:00.000Z'),
      deletedAt: new Date('2026-07-01T09:00:00.000Z'),
      status: 'CANCELLED',
    });
    await prisma.lessonSession.create({
      data: {
        schoolId: seed.school.id,
        lessonBlockId: block.id,
        date: new Date('2026-07-01T12:00:00.000Z'), // inside WEEK_START..WEEK_END
        status: 'CANCELLED',
        teacherIdSnap: seed.teacher.id,
        cabinetIdSnap: seed.cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });

    const res = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule')
      .query({ start: WEEK_START, end: WEEK_END });

    expect(res.status).toBe(200);
    const found = findBlock(res, block.id);
    expect(found).toMatchObject({
      blockVisibility: 'SOFT_DELETED',
      isScheduleActive: false,
      isReadOnly: true,
      conflictEligible: false,
      sessionCountInRange: 1,
    });
    expect(found.visibilityReason).toContain('soft-deleted block with sessions in viewed week');
  });

  it('includes a soft-deleted block whose own lifecycle intersects the requested week, even with no sessions there', async () => {
    const seed = await seedBase('Visibility Soft-Deleted Lifecycle Only');
    const block = await makeBlock(seed, {
      startDate: new Date('2026-06-15T00:00:00.000Z'),
      endDate: new Date('2026-07-02T00:00:00.000Z'), // inside the requested week
      deletedAt: new Date('2026-07-02T00:00:00.000Z'),
      status: 'CANCELLED',
    });

    const res = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule')
      .query({ start: WEEK_START, end: WEEK_END });

    expect(res.status).toBe(200);
    const found = findBlock(res, block.id);
    expect(found).toMatchObject({ blockVisibility: 'SOFT_DELETED', isReadOnly: true, conflictEligible: false });
    expect(found.visibilityReason).not.toContain('sessions in viewed week');
  });

  it('does NOT include an unrelated old soft-deleted block whose lifecycle and sessions both fall outside the requested week', async () => {
    const seed = await seedBase('Visibility Soft-Deleted Out Of Range');
    const oldBlock = await makeBlock(seed, {
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-15T00:00:00.000Z'),
      deletedAt: new Date('2026-01-15T00:00:00.000Z'),
      status: 'CANCELLED',
    });
    await prisma.lessonSession.create({
      data: {
        schoolId: seed.school.id,
        lessonBlockId: oldBlock.id,
        date: new Date('2026-01-10T12:00:00.000Z'), // well outside WEEK_START..WEEK_END
        status: 'CANCELLED',
        teacherIdSnap: seed.teacher.id,
        cabinetIdSnap: seed.cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });

    const res = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule')
      .query({ start: WEEK_START, end: WEEK_END });

    expect(res.status).toBe(200);
    expect(findBlock(res, oldBlock.id)).toBeUndefined();
  });

  it('does NOT include soft-deleted blocks in the no-range (structural/mount) call', async () => {
    const seed = await seedBase('Visibility Soft-Deleted No Range');
    const block = await makeBlock(seed, {
      startDate: new Date('2026-06-15T00:00:00.000Z'),
      endDate: null,
      deletedAt: new Date('2026-06-20T00:00:00.000Z'),
      status: 'CANCELLED',
    });

    const res = await request(buildScheduleApp(seed.owner)).get('/api/schedule');

    expect(res.status).toBe(200);
    expect(findBlock(res, block.id)).toBeUndefined();
  });
});
