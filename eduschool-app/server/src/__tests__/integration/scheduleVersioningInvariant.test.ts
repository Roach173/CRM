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
  const oldSlot = await prisma.timeSlot.create({
    data: { schoolId: school.id, startTime: '08:00', endTime: '09:00', order: 0 },
  });
  await prisma.schoolSchedulePolicy.create({
    data: {
      schoolId: school.id,
      activeDays: [0, 1, 2, 3, 4, 5],
      workStart: '08:06',
      workEnd: '12:06',
      slotDuration: 60,
      effectiveFrom: new Date(`${isoDate(mondayOf(APPLY_FROM))}T00:00:00.000Z`),
      effectiveTo: null,
      createdById: owner.id,
    },
  });
  const block = await prisma.lessonBlock.create({
    data: {
      schoolId: school.id,
      cabinetId: cabinet.id,
      teacherId: teacher.id,
      studentGroupId: group.id,
      timeSlotId: oldSlot.id,
      startTime: '08:00',
      endTime: '09:00',
      days: [0, 2, 4],
      level: 'A1',
      chapter: 1,
      maxStudents: 12,
      type: BlockType.GRAMMAR,
      startDate: dayUtcNoon(-21),
    },
  });
  return { school, owner, teacherUser, teacher, cabinet, group, block };
}

// Dates are anchored to "today" (UTC): isHistoricalTargetDate() rejects any
// targetDate before Monday of the current week with HISTORICAL_POLICY_READ_ONLY,
// so hardcoded dates rot as the calendar advances.
function dayUtcNoon(offsetDays: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12));
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function mondayOf(d: Date): Date {
  const dow = d.getUTCDay() === 0 ? 6 : d.getUTCDay() - 1;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow, 12));
}
const APPLY_FROM = dayUtcNoon(0); // today — always writable
const DAY_BEFORE = dayUtcNoon(-1);
const DAY_AFTER = dayUtcNoon(1);

async function splitAtApplyFrom(seed: Awaited<ReturnType<typeof seedBase>>) {
  return request(buildScheduleApp(seed.owner))
    .put(`/api/schedule/group-pair/${seed.group.id}`)
    .send({
      grammarBlockId: seed.block.id,
      timeSlotId: 100000,
      startTime: '08:06',
      endTime: '09:06',
      targetDate: isoDate(APPLY_FROM),
      applyFrom: isoDate(APPLY_FROM),
      level: 'A1',
      cabinetId: seed.cabinet.id,
      chapter: 1,
      maxStudents: 12,
      grammarTeacherId: seed.teacherUser.id,
      grammarDays: [0, 2, 4],
      clubDays: [],
    });
}

describe('schedule versioning invariant', () => {
  it('GET schedule for the applyFrom day returns only the child version', async () => {
    const seed = await seedBase('Versioning One Active');
    const split = await splitAtApplyFrom(seed);
    expect(split.status).toBe(200);

    const res = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule')
      .query({ start: isoDate(APPLY_FROM), end: isoDate(APPLY_FROM) });

    expect(res.status).toBe(200);
    const blocks = res.body.data.filter((b: any) => b.studentGroupId === seed.group.id && b.type === BlockType.GRAMMAR);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: split.body.data.grammarBlockId,
      parentBlockId: seed.block.id,
      startTime: '08:06',
      endTime: '09:06',
    });
  });

  it('old parent future UPCOMING sessions after applyFrom are not visible', async () => {
    const seed = await seedBase('Versioning Parent Sessions');
    const parentFuture = await prisma.lessonSession.create({
      data: {
        schoolId: seed.school.id,
        lessonBlockId: seed.block.id,
        date: DAY_AFTER,
        status: 'UPCOMING',
        teacherIdSnap: seed.teacher.id,
        cabinetIdSnap: seed.cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });

    const split = await splitAtApplyFrom(seed);
    expect(split.status).toBe(200);

    const after = await prisma.lessonSession.findUniqueOrThrow({ where: { id: parentFuture.id } });
    expect(after.status).toBe('INVALIDATED');

    const week = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule/sessions/week')
      .query({ weekStart: isoDate(mondayOf(DAY_AFTER)) });
    expect(week.status).toBe(200);
    const visibleParent = week.body.data.filter((s: any) => s.lessonBlockId === seed.block.id && s.date.startsWith(isoDate(DAY_AFTER)));
    expect(visibleParent).toHaveLength(0);
  });

  it('changing time with applyFrom does not create duplicate active cards', async () => {
    const seed = await seedBase('Versioning No Duplicate Cards');
    const split = await splitAtApplyFrom(seed);
    expect(split.status).toBe(200);

    const res = await request(buildScheduleApp(seed.owner))
      .get('/api/schedule')
      .query({ start: isoDate(APPLY_FROM), end: isoDate(APPLY_FROM) });
    const keys = res.body.data
      .filter((b: any) => b.studentGroupId === seed.group.id)
      .map((b: any) => `${b.studentGroupId}:${b.type}`);
    expect(keys).toEqual([`${seed.group.id}:${BlockType.GRAMMAR}`]);
  });

  it('past parent sessions before applyFrom remain unchanged', async () => {
    const seed = await seedBase('Versioning Past Parent');
    const parentBefore = await prisma.lessonSession.create({
      data: {
        schoolId: seed.school.id,
        lessonBlockId: seed.block.id,
        date: DAY_BEFORE,
        status: 'UPCOMING',
        teacherIdSnap: seed.teacher.id,
        cabinetIdSnap: seed.cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });

    const split = await splitAtApplyFrom(seed);
    expect(split.status).toBe(200);

    const after = await prisma.lessonSession.findUniqueOrThrow({ where: { id: parentBefore.id } });
    expect(after).toMatchObject({
      lessonBlockId: seed.block.id,
      status: 'UPCOMING',
      startTimeSnap: '08:00',
      endTimeSnap: '09:00',
    });
  });

  it('unsafe future sessions with attendance, credits, or payment are not silently mutated', async () => {
    const seed = await seedBase('Versioning Unsafe Sessions');
    const studentUser = await prisma.user.create({
      data: {
        schoolId: seed.school.id,
        role: Role.STUDENT,
        firstName: 'Student',
        lastName: 'One',
        email: `student-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const student = await prisma.studentProfile.create({ data: { userId: studentUser.id, credits: 10 } });
    const attendanceSession = await prisma.lessonSession.create({
      data: {
        schoolId: seed.school.id,
        lessonBlockId: seed.block.id,
        date: dayUtcNoon(1),
        status: 'UPCOMING',
        teacherIdSnap: seed.teacher.id,
        cabinetIdSnap: seed.cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });
    const creditSession = await prisma.lessonSession.create({
      data: {
        schoolId: seed.school.id,
        lessonBlockId: seed.block.id,
        date: dayUtcNoon(2),
        status: 'UPCOMING',
        teacherIdSnap: seed.teacher.id,
        cabinetIdSnap: seed.cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });
    const paidSession = await prisma.lessonSession.create({
      data: {
        schoolId: seed.school.id,
        lessonBlockId: seed.block.id,
        date: dayUtcNoon(3),
        status: 'UPCOMING',
        teacherIdSnap: seed.teacher.id,
        cabinetIdSnap: seed.cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });
    await prisma.attendance.create({
      data: { schoolId: seed.school.id, lessonSessionId: attendanceSession.id, studentProfileId: student.id, status: 'PRESENT' },
    });
    await prisma.lessonCreditLog.create({
      data: { schoolId: seed.school.id, studentProfileId: student.id, sessionId: creditSession.id, amount: -1, reason: 'test debit', type: 'DEBIT' },
    });
    const payment = await prisma.teacherPayment.create({
      data: {
        schoolId: seed.school.id,
        staffProfileId: seed.teacher.id,
        period: isoDate(dayUtcNoon(3)).slice(0, 7),
        lessonsCount: 1,
        rateSnapshot: '5000',
        amount: '5000',
      },
    });
    await prisma.teacherPaymentLesson.create({ data: { paymentId: payment.id, lessonSessionId: paidSession.id } });

    const res = await splitAtApplyFrom(seed);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPLIT_PROTECTED_FUTURE_SESSIONS');

    const unchanged = await prisma.lessonSession.findMany({
      where: { id: { in: [attendanceSession.id, creditSession.id, paidSession.id] } },
      orderBy: { id: 'asc' },
    });
    expect(unchanged.map(s => s.status)).toEqual(['UPCOMING', 'UPCOMING', 'UPCOMING']);
    expect(await prisma.lessonBlock.count({ where: { parentBlockId: seed.block.id, deletedAt: null } })).toBe(0);
  });

  it('real external teacher and cabinet conflicts still fail', async () => {
    const seed = await seedBase('Versioning External Conflicts');
    const otherGroup = await prisma.studentGroup.create({
      data: { schoolId: seed.school.id, level: 'A1', chapter: 1, maxStudents: 12 },
    });
    const conflictSlot = await prisma.timeSlot.create({
      data: { schoolId: seed.school.id, startTime: '08:06', endTime: '09:06', order: 1 },
    });
    await prisma.lessonBlock.create({
      data: {
        schoolId: seed.school.id,
        cabinetId: seed.cabinet.id,
        teacherId: seed.teacher.id,
        studentGroupId: otherGroup.id,
        timeSlotId: conflictSlot.id,
        startTime: '08:06',
        endTime: '09:06',
        days: [0, 2, 4],
        level: 'A1',
        chapter: 1,
        maxStudents: 12,
        type: BlockType.GRAMMAR,
        startDate: APPLY_FROM,
      },
    });

    const res = await splitAtApplyFrom(seed);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Conflict|Конфликт|РљРѕРЅС„Р»РёРєС‚/);
  });

  it('GET /schedule (no params) does not return parent block whose endDate is before today', async () => {
    const seed = await seedBase('Versioning No Expired Parent');

    // Directly set parent endDate to yesterday (simulates a split that already happened)
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    await prisma.lessonBlock.update({
      where: { id: seed.block.id },
      data: { endDate: yesterday },
    });

    // Create child block starting today
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const child = await prisma.lessonBlock.create({
      data: {
        schoolId: seed.school.id,
        cabinetId: seed.cabinet.id,
        teacherId: seed.teacher.id,
        studentGroupId: seed.group.id,
        timeSlotId: seed.block.timeSlotId,
        startTime: seed.block.startTime,
        endTime: seed.block.endTime,
        days: seed.block.days,
        level: seed.block.level,
        chapter: seed.block.chapter,
        maxStudents: seed.block.maxStudents,
        type: seed.block.type,
        startDate: today,
        parentBlockId: seed.block.id,
      },
    });

    const res = await request(buildScheduleApp(seed.owner)).get('/api/schedule');
    expect(res.status).toBe(200);

    const groupBlocks = res.body.data.filter(
      (b: any) => b.studentGroupId === seed.group.id && b.type === BlockType.GRAMMAR,
    );
    // Only the active child should be returned; expired parent must be excluded
    expect(groupBlocks).toHaveLength(1);
    expect(groupBlocks[0].id).toBe(child.id);
  });
});
