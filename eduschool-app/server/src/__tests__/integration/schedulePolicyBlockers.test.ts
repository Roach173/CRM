import express from 'express';
import request from 'supertest';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStaffProfile,
  createGroup,
  createBlock,
  createSession,
} from '../helpers/testDb';
import settingsRoutes from '../../routes/settings';
import { getNextMondayDateInTz, getTodayDateInTz } from '../../lib/tzUtils';
import { syncSessionsForBlock } from '../../services/sessionService';
import { validateSessionTimeBounds } from '../../services/scheduleValidation';

process.env.NODE_ENV = 'test';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function buildApp(user?: { id: number; schoolId: number | null; role: any; tokenVersion: number }) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req: any, _res, next) => {
      req.user = { userId: user.id, schoolId: user.schoolId, role: user.role, tokenVersion: user.tokenVersion };
      next();
    });
  }
  app.use('/api/settings', settingsRoutes);
  return app;
}

function nextSchemaDayDate(schemaDay: number): Date {
  const date = new Date();
  const currentSchemaDay = (date.getUTCDay() + 6) % 7;
  let delta = (schemaDay - currentSchemaDay + 7) % 7;
  if (delta === 0) delta = 7;
  date.setUTCDate(date.getUTCDate() + delta);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

describe('schedule policy blockers', () => {
  it('PATCH /settings creates a policy without mutating TimeSlot, LessonBlock, LessonSession, or School schedule columns', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4], workStart: '08:00', workEnd: '20:00', slotDuration: 60 });
    const owner = await createUser(school.id, 'OWNER');
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, days: [0] });
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: nextSchemaDayDate(0) });
    const beforeSlot = await prisma.timeSlot.findFirstOrThrow({ where: { schoolId: school.id } });

    const res = await request(buildApp(owner))
      .patch('/api/settings')
      .send({ activeDays: [1, 2, 3, 4], workStart: '10:00', workEnd: '19:00', slotDuration: 60 });

    expect(res.status).toBe(200);
    expect(res.body.data.policyEffectiveFrom).toBeTruthy();

    const [afterSchool, afterSlot, afterBlock, afterSession, policies] = await Promise.all([
      prisma.school.findUniqueOrThrow({ where: { id: school.id } }),
      prisma.timeSlot.findUniqueOrThrow({ where: { id: beforeSlot.id } }),
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: block.id } }),
      prisma.lessonSession.findUniqueOrThrow({ where: { id: session.id } }),
      prisma.schoolSchedulePolicy.findMany({ where: { schoolId: school.id } }),
    ]);

    expect(afterSchool.activeDays).toEqual([0, 1, 2, 3, 4]);
    expect(afterSchool.workStart).toBe('08:00');
    expect(afterSchool.workEnd).toBe('20:00');
    expect(afterSlot).toMatchObject({ startTime: beforeSlot.startTime, endTime: beforeSlot.endTime, order: beforeSlot.order });
    expect(afterBlock).toMatchObject({ startTime: block.startTime, endTime: block.endTime, timeSlotId: block.timeSlotId });
    expect(afterSession).toMatchObject({ status: 'UPCOMING', startTimeSnap: '09:00', endTimeSnap: '10:00' });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ activeDays: [1, 2, 3, 4], workStart: '10:00', workEnd: '19:00' });
  });

  it('PATCH /settings updates an existing pending policy with the same effectiveFrom instead of duplicating it', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const owner = await createUser(school.id, 'OWNER');

    // First save: bootstrap → effectiveFrom = today
    await request(buildApp(owner))
      .patch('/api/settings')
      .send({ activeDays: [0, 1, 2, 3], workStart: '09:00', workEnd: '18:00' });

    // Second save: non-bootstrap → effectiveFrom = nextMonday
    const second = await request(buildApp(owner))
      .patch('/api/settings')
      .send({ activeDays: [1, 2, 3], workStart: '10:00', workEnd: '17:00' });

    // Third save: same window as second → same effectiveFrom = nextMonday → must UPDATE, not duplicate
    const third = await request(buildApp(owner))
      .patch('/api/settings')
      .send({ activeDays: [0, 1], workStart: '11:00', workEnd: '16:00' });

    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(third.body.data.policyEffectiveFrom).toBe(second.body.data.policyEffectiveFrom);

    const effectiveFrom = new Date(second.body.data.policyEffectiveFrom);
    const policies = await prisma.schoolSchedulePolicy.findMany({ where: { schoolId: school.id, effectiveFrom } });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ activeDays: [0, 1], workStart: '11:00', workEnd: '16:00' });
  });

  it('/settings/timeslots?date renders the policy grid for that date, ignoring School cache columns', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [6], workStart: '06:00', workEnd: '07:00', slotDuration: 30 });
    const owner = await createUser(school.id, 'OWNER');
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id,
        activeDays: [0, 1, 2, 3, 4],
        workStart: '08:00',
        workEnd: '10:00',
        slotDuration: 60,
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-06-22T00:00:00.000Z'),
        createdById: owner.id,
      },
    });
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id,
        activeDays: [1, 2, 3],
        workStart: '10:00',
        workEnd: '12:00',
        slotDuration: 60,
        effectiveFrom: new Date('2026-06-22T00:00:00.000Z'),
        effectiveTo: null,
        createdById: owner.id,
      },
    });

    const oldWeek = await request(buildApp(owner))
      .get('/api/settings/timeslots?date=2026-06-15');
    const newWeek = await request(buildApp(owner))
      .get('/api/settings/timeslots?date=2026-06-22');

    expect(oldWeek.status).toBe(200);
    expect(newWeek.status).toBe(200);
    expect(oldWeek.body.data.activeDays).toEqual([0, 1, 2, 3, 4]);
    expect(oldWeek.body.data.slots.map((s: any) => s.startTime)).toContain('08:00');
    expect(newWeek.body.data.activeDays).toEqual([1, 2, 3]);
    expect(newWeek.body.data.slots.map((s: any) => s.startTime)).toContain('10:00');
    expect(newWeek.body.data.slots.map((s: any) => s.startTime)).not.toContain('06:00');
  });

  it('/settings/timeslots?date excludes empty stale TimeSlot rows and adds occupied legacy block times for the viewed week', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4], workStart: '08:00', workEnd: '20:00', slotDuration: 60 });
    const owner = await createUser(school.id, 'OWNER');
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const group = await createGroup(school.id);
    const staleSlot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:00', endTime: '09:00', order: 0 },
    });
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id,
        activeDays: [0, 1, 2, 3, 4],
        workStart: '08:06',
        workEnd: '10:06',
        slotDuration: 60,
        effectiveFrom: new Date('2026-06-22T00:00:00.000Z'),
        effectiveTo: null,
        createdById: owner.id,
      },
    });
    const oldLegacyBlock = await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        studentGroupId: group.id,
        teacherId: staff.id,
        timeSlotId: staleSlot.id,
        days: [0],
        startDate: new Date('2026-06-15T12:00:00.000Z'),
        endDate: new Date('2026-06-15T12:00:00.000Z'),
        type: 'GRAMMAR',
        startTime: '08:00',
        endTime: '09:00',
        level: 'A1',
        chapter: 1,
      },
    });
    const leakedOldSession = await createSession({
      blockId: oldLegacyBlock.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2026-06-22T12:00:00.000Z'),
      status: 'INVALIDATED',
    });
    await prisma.lessonSession.update({
      where: { id: leakedOldSession.id },
      data: { startTimeSnap: '08:00', endTimeSnap: '09:00' },
    });

    const withoutLegacyItem = await request(buildApp(owner))
      .get('/api/settings/timeslots?date=2026-06-22');
    expect(withoutLegacyItem.status).toBe(200);
    expect(withoutLegacyItem.body.data.slots.map((s: any) => s.startTime)).toEqual(['08:06', '09:06']);

    await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        studentGroupId: group.id,
        teacherId: staff.id,
        timeSlotId: staleSlot.id,
        days: [0],
        startDate: new Date('2026-06-22T12:00:00.000Z'),
        endDate: null,
        type: 'GRAMMAR',
        startTime: '08:00',
        endTime: '09:00',
        level: 'A1',
        chapter: 1,
      },
    });

    const withLegacyBlock = await request(buildApp(owner))
      .get('/api/settings/timeslots?date=2026-06-22');
    expect(withLegacyBlock.status).toBe(200);
    expect(withLegacyBlock.body.data.slots.map((s: any) => s.startTime)).toEqual(['08:00', '08:06', '09:06']);
  });

  it('validateSessionTimeBounds uses policy for the target date, not School workStart/workEnd', async () => {
    const school = await createSchool({ timezone: 'UTC', workStart: '08:00', workEnd: '20:00' });
    const owner = await createUser(school.id, 'OWNER');
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id,
        activeDays: [0, 1, 2, 3, 4],
        workStart: '10:00',
        workEnd: '19:00',
        slotDuration: 60,
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        createdById: owner.id,
      },
    });

    const result = await validateSessionTimeBounds(prisma as any, school.id, '09:00', '10:00', new Date('2026-06-15T12:00:00.000Z'));
    expect(result).toMatchObject({ valid: false });
  });

  it('syncSessionsForBlock does not invalidate an existing session merely because it conflicts with current policy', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [1, 2, 3, 4] });
    const owner = await createUser(school.id, 'OWNER');
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, days: [0] });
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: nextSchemaDayDate(0) });
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id,
        activeDays: [1, 2, 3, 4],
        workStart: '10:00',
        workEnd: '19:00',
        slotDuration: 60,
        effectiveFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
        createdById: owner.id,
      },
    });

    await syncSessionsForBlock({
      id: block.id,
      schoolId: school.id,
      days: block.days,
      startDate: block.startDate,
      endDate: block.endDate,
      studentGroupId: block.studentGroupId,
      teacherId: block.teacherId,
      cabinetId: block.cabinetId,
      startTime: block.startTime,
      endTime: block.endTime,
      status: block.status,
    });

    const after = await prisma.lessonSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.status).toBe('UPCOMING');
  });

  it('getNextMondayDateInTz fixture sanity: PATCH tests target the same effectiveFrom within a run', () => {
    const first = getNextMondayDateInTz('UTC').date.toISOString();
    const second = getNextMondayDateInTz('UTC').date.toISOString();
    expect(second).toBe(first);
  });

  // ── bootstrap: first policy for a new school is effective today ─────────────

  it('bootstrap: first PATCH creates policy effective today, not next Monday', async () => {
    const school = await createSchool({
      timezone: 'UTC', activeDays: [6], workStart: '06:00', workEnd: '07:00',
    });
    const owner = await createUser(school.id, 'OWNER');

    const res = await request(buildApp(owner))
      .patch('/api/settings')
      .send({ activeDays: [0, 1, 2, 3, 4], workStart: '08:00', workEnd: '18:00' });

    expect(res.status).toBe(200);
    expect(res.body.data.policyEffectiveFrom).toBeTruthy();

    const { date: nextMon } = getNextMondayDateInTz('UTC');
    const { date: today } = getTodayDateInTz('UTC');
    const effectiveFrom = new Date(res.body.data.policyEffectiveFrom);

    // effectiveFrom must be today (midnight UTC), not next Monday
    expect(effectiveFrom.getTime()).toBeGreaterThanOrEqual(today.getTime());
    expect(effectiveFrom.getTime()).toBeLessThan(nextMon.getTime());

    // The DB row must reflect the new settings
    const policy = await prisma.schoolSchedulePolicy.findFirstOrThrow({ where: { schoolId: school.id } });
    expect(policy.activeDays).toEqual([0, 1, 2, 3, 4]);
    expect(policy.workStart).toBe('08:00');
    expect(new Date(policy.effectiveFrom).getTime()).toBe(effectiveFrom.getTime());
  });

  it('bootstrap: second PATCH after bootstrap targets next Monday', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const owner = await createUser(school.id, 'OWNER');

    // Bootstrap save — effectiveFrom = today
    const first = await request(buildApp(owner))
      .patch('/api/settings')
      .send({ activeDays: [0, 1, 2, 3, 4] });
    expect(first.status).toBe(200);

    // Second save — effectiveFrom = nextMonday
    const second = await request(buildApp(owner))
      .patch('/api/settings')
      .send({ activeDays: [0, 1, 2, 3] });
    expect(second.status).toBe(200);

    const { date: nextMon } = getNextMondayDateInTz('UTC');
    const secondEffective = new Date(second.body.data.policyEffectiveFrom);

    expect(secondEffective.getTime()).toBe(nextMon.getTime());
    expect(second.body.data.policyEffectiveFrom).not.toBe(first.body.data.policyEffectiveFrom);
  });

  it('bootstrap: GET /settings/timeslots returns new policy immediately after first save', async () => {
    const school = await createSchool({
      timezone: 'UTC', activeDays: [6], workStart: '06:00', workEnd: '07:00', slotDuration: 30,
    });
    const owner = await createUser(school.id, 'OWNER');

    await request(buildApp(owner))
      .patch('/api/settings')
      .send({ activeDays: [0, 1, 2, 3, 4], workStart: '09:00', workEnd: '17:00', slotDuration: 60 });

    const res = await request(buildApp(owner)).get('/api/settings/timeslots');
    expect(res.status).toBe(200);
    // Must return the new policy (Mon–Fri, 09:00–17:00), not school default (Sun, 06:00–07:00)
    expect(res.body.data.activeDays).toEqual([0, 1, 2, 3, 4]);
    expect(res.body.data.slots.map((s: any) => s.startTime)).toContain('09:00');
    expect(res.body.data.slots.map((s: any) => s.startTime)).not.toContain('06:00');
  });

  it('bootstrap: GET /settings/policy-impact shows today as effectiveFrom for new school', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const owner = await createUser(school.id, 'OWNER');

    const res = await request(buildApp(owner))
      .get('/api/settings/policy-impact?activeDays=0,1,2,3,4');
    expect(res.status).toBe(200);

    const { date: nextMon } = getNextMondayDateInTz('UTC');
    const { date: today } = getTodayDateInTz('UTC');
    const effectiveFrom = new Date(res.body.data.policyEffectiveFrom);

    expect(effectiveFrom.getTime()).toBeGreaterThanOrEqual(today.getTime());
    expect(effectiveFrom.getTime()).toBeLessThan(nextMon.getTime());
  });

  it('/settings/timeslots historical flag: false for current/future weeks, true only for past weeks', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const owner = await createUser(school.id, 'OWNER');

    const now = new Date();
    const daysFromMonday = now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1;
    const currentMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday));
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const currentMondayStr = fmt(currentMonday);
    const pastMondayStr = fmt(new Date(currentMonday.getTime() - 7 * 24 * 60 * 60 * 1000));
    const futureMondayStr = fmt(new Date(currentMonday.getTime() + 7 * 24 * 60 * 60 * 1000));

    const [resCurrent, resPast, resFuture, resNoDate] = await Promise.all([
      request(buildApp(owner)).get(`/api/settings/timeslots?date=${currentMondayStr}`),
      request(buildApp(owner)).get(`/api/settings/timeslots?date=${pastMondayStr}`),
      request(buildApp(owner)).get(`/api/settings/timeslots?date=${futureMondayStr}`),
      request(buildApp(owner)).get('/api/settings/timeslots'),
    ]);

    expect(resCurrent.status).toBe(200);
    expect(resPast.status).toBe(200);
    expect(resFuture.status).toBe(200);
    expect(resNoDate.status).toBe(200);

    expect(resCurrent.body.data.historical).toBe(false);  // current week → not historical
    expect(resPast.body.data.historical).toBe(true);      // past week → historical
    expect(resFuture.body.data.historical).toBe(false);   // future week → not historical
    expect(resNoDate.body.data.historical).toBe(false);   // no date param → not historical
  });
});
