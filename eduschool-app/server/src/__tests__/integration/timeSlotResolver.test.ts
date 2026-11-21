import express from 'express';
import request from 'supertest';
import { BlockType, Role } from '@prisma/client';
import { cleanDb, prisma } from '../helpers/testDb';
import { resolveWritableTimeSlot } from '../../routes/schedule';
import scheduleRoutes from '../../routes/schedule';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Anchor on a Monday strictly in the future. Tests that rely on session
// projection / future-policy lookups must use dates >= today, and on a Monday
// so weekday-scoped blocks (e.g. days [0, 2]) land a session on the anchor day.
// Computed once per run so all references within a test stay consistent.
const ANCHOR_MONDAY = (() => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const daysUntilMonday = ((8 - d.getUTCDay()) % 7) || 7; // strictly future
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d;
})();
function anchorStr(offsetDays = 0) {
  const d = new Date(ANCHOR_MONDAY);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function anchorNoon(offsetDays = 0) {
  return new Date(`${anchorStr(offsetDays)}T12:00:00.000Z`);
}

async function createSchool(name: string) {
  return prisma.school.create({
    data: {
      name,
      city: 'Bishkek',
      email: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}@test.local`,
      slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
      timezone: 'UTC',
      activeDays: [0, 1, 2, 3, 4, 5],
      workStart: '09:00',
      workEnd: '18:00',
      slotDuration: 60,
    },
  });
}

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

async function createPolicy(schoolId: number, userId: number, start = '08:06') {
  return prisma.schoolSchedulePolicy.create({
    data: {
      schoolId,
      activeDays: [0, 1, 2, 3, 4, 5],
      workStart: start,
      workEnd: '12:06',
      slotDuration: 60,
      effectiveFrom: new Date('2026-06-22T00:00:00.000Z'),
      effectiveTo: null,
      createdById: userId,
    },
  });
}

describe('resolveWritableTimeSlot', () => {
  it('accepts a valid current DB timeSlotId for the same school', async () => {
    const school = await createSchool('Slot Resolver Valid');
    const slot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '10:00', endTime: '11:00', order: 1 },
    });

    const result = await resolveWritableTimeSlot({
      schoolId: school.id,
      timeSlotId: slot.id,
      startTime: '10:00',
      endTime: '11:00',
      targetDate: isoDate(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slot.id).toBe(slot.id);
  });

  it('rejects a negative synthetic slot id when no time range is provided', async () => {
    const school = await createSchool('Slot Resolver Synthetic');

    const result = await resolveWritableTimeSlot({
      schoolId: school.id,
      timeSlotId: -1,
      targetDate: isoDate(),
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: 'TIME_SLOT_NOT_WRITABLE' });
  });

  it('resolves a stale/deleted timeSlotId by current school time range', async () => {
    const school = await createSchool('Slot Resolver Stale');
    const stale = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '09:00', endTime: '10:00', order: 1 },
    });
    await prisma.timeSlot.delete({ where: { id: stale.id } });
    const replacement = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '09:00', endTime: '10:00', order: 1 },
    });

    const result = await resolveWritableTimeSlot({
      schoolId: school.id,
      timeSlotId: stale.id,
      startTime: '09:00',
      endTime: '10:00',
      targetDate: isoDate(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slot.id).toBe(replacement.id);
  });

  it('rejects a cross-school timeSlotId', async () => {
    const school = await createSchool('Slot Resolver Own');
    const otherSchool = await createSchool('Slot Resolver Other');
    const otherSlot = await prisma.timeSlot.create({
      data: { schoolId: otherSchool.id, startTime: '12:00', endTime: '13:00', order: 1 },
    });

    const result = await resolveWritableTimeSlot({
      schoolId: school.id,
      timeSlotId: otherSlot.id,
      startTime: '12:00',
      endTime: '13:00',
      targetDate: isoDate(),
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: 'TIME_SLOT_SCHOOL_MISMATCH' });
  });

  it('rejects a DB timeSlotId whose time differs from the submitted range', async () => {
    const school = await createSchool('Slot Resolver Mismatch');
    const slot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '14:00', endTime: '15:00', order: 1 },
    });

    const result = await resolveWritableTimeSlot({
      schoolId: school.id,
      timeSlotId: slot.id,
      startTime: '14:30',
      endTime: '15:30',
      targetDate: isoDate(),
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: 'TIME_SLOT_TIME_MISMATCH' });
  });

  it('blocks writes to historical policy dates', async () => {
    const school = await createSchool('Slot Resolver Historical');
    const slot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '16:00', endTime: '17:00', order: 1 },
    });

    const result = await resolveWritableTimeSlot({
      schoolId: school.id,
      timeSlotId: slot.id,
      startTime: '16:00',
      endTime: '17:00',
      targetDate: isoDate(-14),
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: 'HISTORICAL_POLICY_READ_ONLY' });
  });

  it('creates a real TimeSlot for a synthetic future policy slot', async () => {
    const school = await createSchool('Slot Resolver Future Policy');
    const owner = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.OWNER,
        firstName: 'Owner',
        lastName: 'Policy',
        email: `owner-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    await createPolicy(school.id, owner.id);

    const result = await resolveWritableTimeSlot({
      schoolId: school.id,
      timeSlotId: 100000,
      startTime: '08:06',
      endTime: '09:06',
      targetDate: anchorStr(0),
    });

    expect(result.ok).toBe(true);
    const saved = await prisma.timeSlot.findUnique({
      where: { schoolId_startTime_endTime: { schoolId: school.id, startTime: '08:06', endTime: '09:06' } },
    });
    expect(saved).toBeTruthy();
    if (result.ok) {
      expect(result.slot).toMatchObject({ id: saved!.id, startTime: '08:06', endTime: '09:06', order: 0 });
    }
  });

  it('rejects arbitrary synthetic times that do not exactly match the policy grid', async () => {
    const school = await createSchool('Slot Resolver Arbitrary Synthetic');
    const owner = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.OWNER,
        firstName: 'Owner',
        lastName: 'Policy',
        email: `owner-arbitrary-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    await createPolicy(school.id, owner.id);

    const result = await resolveWritableTimeSlot({
      schoolId: school.id,
      timeSlotId: 100000,
      startTime: '08:07',
      endTime: '09:07',
      targetDate: anchorStr(0),
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: 'TIME_SLOT_NOT_FOUND' });
    await expect(prisma.timeSlot.findFirst({
      where: { schoolId: school.id, startTime: '08:07', endTime: '09:07' },
    })).resolves.toBeNull();
  });

  it('rejects a legacy real TimeSlot when it is outside the target date policy', async () => {
    const school = await createSchool('Slot Resolver Legacy Outside Policy');
    const owner = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.OWNER,
        firstName: 'Owner',
        lastName: 'Policy',
        email: `owner-legacy-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    await createPolicy(school.id, owner.id);
    const legacy = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:00', endTime: '09:00', order: 0 },
    });

    const result = await resolveWritableTimeSlot({
      schoolId: school.id,
      timeSlotId: legacy.id,
      startTime: '08:00',
      endTime: '09:00',
      targetDate: anchorStr(0),
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: 'TIME_SLOT_NOT_FOUND' });
  });

  it('splits a group pair onto a synthetic future policy slot and stores the real TimeSlot on the child blocks', async () => {
    const school = await createSchool('Slot Resolver Pair Split');
    const owner = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.OWNER,
        firstName: 'Owner',
        lastName: 'Policy',
        email: `owner-pair-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const teacherUser = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.TEACHER,
        firstName: 'Teacher',
        lastName: 'One',
        email: `teacher-pair-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const teacher = await prisma.staffProfile.create({
      data: { userId: teacherUser.id, salaryRate: 5000, workingDays: [0, 1, 2, 3, 4, 5] },
    });
    const cabinet = await prisma.cabinet.create({
      data: { schoolId: school.id, name: '1', capacity: 12 },
    });
    const studentGroup = await prisma.studentGroup.create({
      data: { schoolId: school.id, level: 'A1', chapter: 1, maxStudents: 12 },
    });
    const legacySlot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:00', endTime: '09:00', order: 0 },
    });
    await createPolicy(school.id, owner.id);

    const grammar = await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        cabinetId: cabinet.id,
        teacherId: teacher.id,
        studentGroupId: studentGroup.id,
        timeSlotId: legacySlot.id,
        startTime: '08:00',
        endTime: '09:00',
        days: [0, 2],
        level: 'A1',
        chapter: 1,
        maxStudents: 12,
        type: BlockType.GRAMMAR,
        startDate: anchorNoon(-7),
      },
    });
    const club = await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        cabinetId: cabinet.id,
        teacherId: teacher.id,
        studentGroupId: studentGroup.id,
        timeSlotId: legacySlot.id,
        startTime: '08:00',
        endTime: '09:00',
        days: [1],
        level: 'A1',
        chapter: 1,
        maxStudents: 12,
        type: BlockType.SPEAKING_CLUB,
        startDate: anchorNoon(-7),
      },
    });
    const parentFutureSession = await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: grammar.id,
        date: anchorNoon(0),
        status: 'UPCOMING',
        teacherIdSnap: teacher.id,
        cabinetIdSnap: cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });
    const parentBeforeApplyFromSession = await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: grammar.id,
        date: anchorNoon(-7),
        status: 'UPCOMING',
        teacherIdSnap: teacher.id,
        cabinetIdSnap: cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });

    const res = await request(buildScheduleApp(owner))
      .put(`/api/schedule/group-pair/${studentGroup.id}`)
      .send({
        grammarBlockId: grammar.id,
        clubBlockId: club.id,
        timeSlotId: 100000,
        startTime: '08:06',
        endTime: '09:06',
        targetDate: anchorStr(0),
        applyFrom: anchorStr(0),
        level: 'A1',
        cabinetId: cabinet.id,
        chapter: 1,
        maxStudents: 12,
        grammarTeacherId: teacherUser.id,
        grammarDays: [0, 2],
        clubTeacherId: teacherUser.id,
        clubDays: [1],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.grammarBlockId).not.toBe(grammar.id);
    expect(res.body.data.clubBlockId).not.toBe(club.id);

    const realSlot = await prisma.timeSlot.findUniqueOrThrow({
      where: { schoolId_startTime_endTime: { schoolId: school.id, startTime: '08:06', endTime: '09:06' } },
    });
    const [oldGrammar, newGrammar, newClub] = await Promise.all([
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: grammar.id } }),
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: res.body.data.grammarBlockId } }),
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: res.body.data.clubBlockId } }),
    ]);
    const [futureParentAfter, beforeParentAfter] = await Promise.all([
      prisma.lessonSession.findUniqueOrThrow({ where: { id: parentFutureSession.id } }),
      prisma.lessonSession.findUniqueOrThrow({ where: { id: parentBeforeApplyFromSession.id } }),
    ]);
    const activeParentFutureSessions = await prisma.lessonSession.findMany({
      where: {
        schoolId: school.id,
        lessonBlockId: grammar.id,
        date: { gte: new Date(`${anchorStr(0)}T00:00:00.000Z`) },
        status: { not: 'INVALIDATED' },
        deletedAt: null,
      },
    });
    const childSessions = await prisma.lessonSession.findMany({
      where: {
        schoolId: school.id,
        lessonBlockId: newGrammar.id,
        date: { gte: new Date(`${anchorStr(0)}T00:00:00.000Z`), lte: new Date(`${anchorStr(0)}T23:59:59.999Z`) },
        status: 'UPCOMING',
        deletedAt: null,
      },
    });

    expect(oldGrammar.endDate?.toISOString().slice(0, 10)).toBe(anchorStr(-1));
    expect(beforeParentAfter.status).toBe('UPCOMING');
    expect(futureParentAfter.status).toBe('INVALIDATED');
    expect(activeParentFutureSessions).toHaveLength(0);
    expect(childSessions).toHaveLength(1);
    expect(childSessions[0]).toMatchObject({ startTimeSnap: '08:06', endTimeSnap: '09:06' });
    expect(newGrammar).toMatchObject({
      parentBlockId: grammar.id,
      timeSlotId: realSlot.id,
      startTime: '08:06',
      endTime: '09:06',
    });
    expect(newClub).toMatchObject({
      parentBlockId: club.id,
      timeSlotId: realSlot.id,
      startTime: '08:06',
      endTime: '09:06',
    });
  });

  it('rejects applyFrom split when superseded future sessions have attendance', async () => {
    const school = await createSchool('Slot Resolver Protected Split');
    const owner = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.OWNER,
        firstName: 'Owner',
        lastName: 'Policy',
        email: `owner-protected-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const teacherUser = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.TEACHER,
        firstName: 'Teacher',
        lastName: 'One',
        email: `teacher-protected-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const studentUser = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.STUDENT,
        firstName: 'Student',
        lastName: 'One',
        email: `student-protected-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const [teacher, student] = await Promise.all([
      prisma.staffProfile.create({ data: { userId: teacherUser.id, salaryRate: 5000, workingDays: [0, 1, 2, 3, 4, 5] } }),
      prisma.studentProfile.create({ data: { userId: studentUser.id, credits: 10 } }),
    ]);
    const cabinet = await prisma.cabinet.create({
      data: { schoolId: school.id, name: '1', capacity: 12 },
    });
    const studentGroup = await prisma.studentGroup.create({
      data: { schoolId: school.id, level: 'A1', chapter: 1, maxStudents: 12 },
    });
    const legacySlot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:00', endTime: '09:00', order: 0 },
    });
    await createPolicy(school.id, owner.id);
    const grammar = await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        cabinetId: cabinet.id,
        teacherId: teacher.id,
        studentGroupId: studentGroup.id,
        timeSlotId: legacySlot.id,
        startTime: '08:00',
        endTime: '09:00',
        days: [0],
        level: 'A1',
        chapter: 1,
        maxStudents: 12,
        type: BlockType.GRAMMAR,
        startDate: anchorNoon(-7),
      },
    });
    const protectedSession = await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: grammar.id,
        date: anchorNoon(0),
        status: 'UPCOMING',
        teacherIdSnap: teacher.id,
        cabinetIdSnap: cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: protectedSession.id,
        studentProfileId: student.id,
        status: 'PRESENT',
      },
    });

    const res = await request(buildScheduleApp(owner))
      .put(`/api/schedule/group-pair/${studentGroup.id}`)
      .send({
        grammarBlockId: grammar.id,
        timeSlotId: 100000,
        startTime: '08:06',
        endTime: '09:06',
        targetDate: anchorStr(0),
        applyFrom: anchorStr(0),
        level: 'A1',
        cabinetId: cabinet.id,
        chapter: 1,
        maxStudents: 12,
        grammarTeacherId: teacherUser.id,
        grammarDays: [0],
        clubDays: [],
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPLIT_PROTECTED_FUTURE_SESSIONS');
    const [blockAfter, sessionAfter, childCount] = await Promise.all([
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: grammar.id } }),
      prisma.lessonSession.findUniqueOrThrow({ where: { id: protectedSession.id } }),
      prisma.lessonBlock.count({ where: { schoolId: school.id, parentBlockId: grammar.id, deletedAt: null } }),
    ]);
    expect(blockAfter.endDate).toBeNull();
    expect(sessionAfter.status).toBe('UPCOMING');
    expect(childCount).toBe(0);
  });

  it('updates clean future session snapshots when an active group block time changes in place', async () => {
    const school = await createSchool('Slot Resolver Snapshot Heal');
    const owner = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.OWNER,
        firstName: 'Owner',
        lastName: 'Policy',
        email: `owner-snapshot-heal-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const teacherUser = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.TEACHER,
        firstName: 'Teacher',
        lastName: 'Policy',
        email: `teacher-snapshot-heal-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const staff = await prisma.staffProfile.create({ data: { userId: teacherUser.id, salaryRate: 1000, workingDays: [0, 1, 2, 3, 4, 5, 6] } });
    const studentGroup = await prisma.studentGroup.create({
      data: { schoolId: school.id, level: 'Intermediate', chapter: 1, maxStudents: 12 },
    });
    const cabinet = await prisma.cabinet.create({ data: { schoolId: school.id, name: '101', capacity: 20 } });
    const legacySlot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:00', endTime: '09:00', order: 1 },
    });
    const policySlot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:06', endTime: '09:06', order: 2 },
    });
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id,
        activeDays: [0, 1, 2, 3, 4, 5, 6],
        workStart: '08:06',
        workEnd: '12:06',
        slotDuration: 60,
        effectiveFrom: new Date(`${isoDate(0)}T00:00:00.000Z`),
        effectiveTo: null,
        createdById: owner.id,
      },
    });
    const block = await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        studentGroupId: studentGroup.id,
        teacherId: staff.id,
        cabinetId: cabinet.id,
        timeSlotId: legacySlot.id,
        days: [0, 1, 2, 3, 4, 5, 6],
        startDate: anchorNoon(0),
        endDate: anchorNoon(6),
        type: BlockType.GRAMMAR,
        startTime: '08:00',
        endTime: '09:00',
        level: 'Intermediate',
        chapter: 1,
        maxStudents: 12,
      },
    });
    const sessionDates = [0, 1, 2, 3, 4, 5, 6].map(o => anchorStr(o));
    await prisma.lessonSession.createMany({
      data: sessionDates.map(date => ({
        schoolId: school.id,
        lessonBlockId: block.id,
        date: new Date(`${date}T12:00:00.000Z`),
        status: 'UPCOMING' as const,
        teacherIdSnap: staff.id,
        cabinetIdSnap: cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      })),
    });

    const res = await request(buildScheduleApp(owner))
      .put(`/api/schedule/group-pair/${studentGroup.id}`)
      .send({
        grammarBlockId: block.id,
        timeSlotId: policySlot.id,
        startTime: '08:06',
        endTime: '09:06',
        targetDate: anchorStr(0),
        applyFrom: anchorStr(0),
        level: 'Intermediate',
        cabinetId: cabinet.id,
        chapter: 1,
        maxStudents: 12,
        grammarTeacherId: teacherUser.id,
        grammarDays: [0, 1, 2, 3, 4, 5, 6],
        clubDays: [],
      });

    expect(res.status).toBe(200);
    const updatedBlock = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(updatedBlock).toMatchObject({ startTime: '08:06', endTime: '09:06', timeSlotId: policySlot.id });

    const sessions = await prisma.lessonSession.findMany({
      where: { lessonBlockId: block.id, deletedAt: null },
      orderBy: { date: 'asc' },
      select: { startTimeSnap: true, endTimeSnap: true, teacherIdSnap: true, cabinetIdSnap: true, isManualTime: true },
    });
    expect(sessions).toHaveLength(7);
    expect(sessions.every(s =>
      s.startTimeSnap === '08:06'
      && s.endTimeSnap === '09:06'
      && s.teacherIdSnap === staff.id
      && s.cabinetIdSnap === cabinet.id
      && s.isManualTime === false
    )).toBe(true);

    const conflicts = await request(buildScheduleApp(owner)).get('/api/schedule/policy-conflicts');
    expect(conflicts.status).toBe(200);
    expect(conflicts.body.data.sessionsOutsideHours).toHaveLength(0);
    expect(JSON.stringify(conflicts.body.data)).not.toContain('08:00');
  });

  it('GET /policy-conflicts ignores superseded blocks and their out-of-range future sessions', async () => {
    const school = await createSchool('Policy Conflicts Superseded Blocks');
    const owner = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.OWNER,
        firstName: 'Owner',
        lastName: 'Policy',
        email: `owner-policy-conflicts-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const teacherUser = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.TEACHER,
        firstName: 'Teacher',
        lastName: 'Policy',
        email: `teacher-policy-conflicts-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const staff = await prisma.staffProfile.create({ data: { userId: teacherUser.id, salaryRate: 1000 } });
    const studentGroup = await prisma.studentGroup.create({
      data: { schoolId: school.id, level: 'Intermediate', chapter: 1 },
    });
    const cabinet = await prisma.cabinet.create({ data: { schoolId: school.id, name: '101', capacity: 20 } });
    const staleSlot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:00', endTime: '09:00', order: 1 },
    });
    const policySlot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:06', endTime: '09:06', order: 2 },
    });
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id,
        activeDays: [0, 1, 2, 3, 4, 5, 6],
        workStart: '08:06',
        workEnd: '12:06',
        slotDuration: 60,
        effectiveFrom: new Date(`${isoDate(0)}T00:00:00.000Z`),
        effectiveTo: null,
        createdById: owner.id,
      },
    });

    const staleBlock = await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        studentGroupId: studentGroup.id,
        teacherId: staff.id,
        cabinetId: cabinet.id,
        timeSlotId: staleSlot.id,
        days: [0, 1, 2, 3, 4, 5, 6],
        startDate: new Date(`${isoDate(-14)}T12:00:00.000Z`),
        endDate: new Date(`${isoDate(-1)}T12:00:00.000Z`),
        type: BlockType.GRAMMAR,
        startTime: '08:00',
        endTime: '09:00',
        level: 'Intermediate',
        chapter: 1,
      },
    });
    const staleFutureSession = await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: staleBlock.id,
        date: new Date(`${isoDate(1)}T12:00:00.000Z`),
        status: 'UPCOMING',
        teacherIdSnap: staff.id,
        cabinetIdSnap: cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });
    await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        studentGroupId: studentGroup.id,
        teacherId: staff.id,
        cabinetId: cabinet.id,
        timeSlotId: policySlot.id,
        days: [0, 1, 2, 3, 4, 5, 6],
        startDate: new Date(`${isoDate(0)}T12:00:00.000Z`),
        endDate: null,
        type: BlockType.GRAMMAR,
        startTime: '08:06',
        endTime: '09:06',
        level: 'Intermediate',
        chapter: 1,
      },
    });

    const res = await request(buildScheduleApp(owner)).get('/api/schedule/policy-conflicts');

    expect(res.status).toBe(200);
    expect(res.body.data.sessionsOutsideHours).toHaveLength(0);
    expect(res.body.data.blocksOutsidePolicy).toHaveLength(0);
    expect(JSON.stringify(res.body.data)).not.toContain('08:00');
    expect(res.body.data.sessionsOutsideHours).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: staleFutureSession.id })]),
    );
  });

  it('GET /policy-conflicts ignores older duplicate active blocks when a newer block is policy-compliant for the same group/date', async () => {
    const school = await createSchool('Policy Conflicts Duplicate Active Blocks');
    const owner = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.OWNER,
        firstName: 'Owner',
        lastName: 'Duplicate',
        email: `owner-policy-duplicates-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const teacherUser = await prisma.user.create({
      data: {
        schoolId: school.id,
        role: Role.TEACHER,
        firstName: 'Teacher',
        lastName: 'Duplicate',
        email: `teacher-policy-duplicates-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const staff = await prisma.staffProfile.create({ data: { userId: teacherUser.id, salaryRate: 1000 } });
    const studentGroup = await prisma.studentGroup.create({
      data: { schoolId: school.id, level: 'Advanced', chapter: 1 },
    });
    const cabinet = await prisma.cabinet.create({ data: { schoolId: school.id, name: '102', capacity: 20 } });
    const staleSlot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:00', endTime: '09:00', order: 1 },
    });
    const policySlot = await prisma.timeSlot.create({
      data: { schoolId: school.id, startTime: '08:06', endTime: '09:06', order: 2 },
    });
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id,
        activeDays: [0, 1, 2, 3, 4, 5, 6],
        workStart: '08:06',
        workEnd: '12:06',
        slotDuration: 60,
        effectiveFrom: new Date(`${isoDate(0)}T00:00:00.000Z`),
        effectiveTo: null,
        createdById: owner.id,
      },
    });

    const staleBlock = await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        studentGroupId: studentGroup.id,
        teacherId: staff.id,
        cabinetId: cabinet.id,
        timeSlotId: staleSlot.id,
        days: [0, 1, 2, 3, 4, 5, 6],
        startDate: new Date(`${isoDate(-7)}T12:00:00.000Z`),
        endDate: null,
        type: BlockType.GRAMMAR,
        startTime: '08:00',
        endTime: '09:00',
        level: 'Advanced',
        chapter: 1,
      },
    });
    const staleSession = await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: staleBlock.id,
        date: new Date(`${isoDate(1)}T12:00:00.000Z`),
        status: 'UPCOMING',
        teacherIdSnap: staff.id,
        cabinetIdSnap: cabinet.id,
        startTimeSnap: '08:00',
        endTimeSnap: '09:00',
      },
    });
    await prisma.lessonBlock.create({
      data: {
        schoolId: school.id,
        studentGroupId: studentGroup.id,
        teacherId: staff.id,
        cabinetId: cabinet.id,
        timeSlotId: policySlot.id,
        days: [0, 1, 2, 3, 4, 5, 6],
        startDate: new Date(`${isoDate(0)}T12:00:00.000Z`),
        endDate: null,
        type: BlockType.GRAMMAR,
        startTime: '08:06',
        endTime: '09:06',
        level: 'Advanced',
        chapter: 1,
      },
    });

    const res = await request(buildScheduleApp(owner)).get('/api/schedule/policy-conflicts');

    expect(res.status).toBe(200);
    expect(res.body.data.sessionsOutsideHours).toHaveLength(0);
    expect(res.body.data.blocksOutsidePolicy).toHaveLength(0);
    expect(JSON.stringify(res.body.data)).not.toContain('08:00');
    expect(res.body.data.sessionsOutsideHours).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: staleSession.id })]),
    );
  });
});
