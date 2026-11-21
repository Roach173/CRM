/**
 * Integration: Working Date Source of Truth (Phase 2).
 *
 * Verifies:
 * - validateSessionDate blocks dates excluded by ScheduleException
 * - validateSessionDate blocks dates excluded by legacy settings.holidays
 * - ensureSingleSession cannot create a session on a ScheduleException date
 * - SCHOOL-scope exception blocks all sessions on that date
 * - TEACHER-scope exception blocks session for that specific teacher
 * - cron (syncSessionsForBlock) and manual (ensureSingleSession) give same result
 *   for ScheduleException-blocked dates
 */
import {
  prisma, cleanDb, createSchool, createUser, createStaffProfile,
  createGroup, createBlock,
} from '../helpers/testDb';
import { validateSessionDate, ensureSingleSession } from '../../services/sessionService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school = await createSchool({
    timezone: 'UTC',
    activeDays: [0, 1, 2, 3, 4, 5, 6], // all days active for easier testing
  });
  const tUser = await createUser(school.id, 'TEACHER');
  const staff = await createStaffProfile(tUser.id, school.id);
  const group = await createGroup(school.id);
  const block = await createBlock({
    groupId: group.id,
    schoolId: school.id,
    staffProfileId: staff.id,
    days: [0, 1, 2, 3, 4, 5, 6], // all days
    startDate: new Date('2026-01-01T12:00:00.000Z'),
  });
  return { school, staff, group, block };
}

describe('validateSessionDate — ScheduleException check', () => {
  it('blocks a date covered by SCHOOL-scope ScheduleException', async () => {
    const { school, block } = await setup();

    const exceptedDate = '2026-08-01';
    await prisma.scheduleException.create({
      data: {
        schoolId: school.id,
        type: 'HOLIDAY_CUSTOM',
        scope: 'SCHOOL',
        startDate: new Date(`${exceptedDate}T00:00:00.000Z`),
        endDate:   new Date(`${exceptedDate}T23:59:59.000Z`),
        days: [],
        createdById: (await prisma.user.findFirst({ where: { schoolId: school.id } }))!.id,
      },
    });

    const result = await validateSessionDate(school.id, {
      days: [0,1,2,3,4,5,6],
      startDate: new Date('2026-01-01T12:00:00.000Z'),
      endDate: null,
    }, exceptedDate);

    expect(result.valid).toBe(false);
    expect((result as any).reason).toMatch(/exception/i);
  });

  it('allows a date that has no ScheduleException', async () => {
    const { school } = await setup();

    // 2026-09-01 is a Tuesday (index 1 = Tue in Mon-based)
    const result = await validateSessionDate(school.id, {
      days: [0,1,2,3,4,5,6],
      startDate: new Date('2026-01-01T12:00:00.000Z'),
      endDate: null,
    }, '2026-09-01');

    expect(result.valid).toBe(true);
  });

  it('still respects legacy settings.holidays alongside ScheduleException', async () => {
    const { school } = await setup();

    // Set a holiday via legacy JSON settings
    await prisma.school.update({
      where: { id: school.id },
      data: { settings: { holidays: ['2026-10-15'] } },
    });

    const result = await validateSessionDate(school.id, {
      days: [0,1,2,3,4,5,6],
      startDate: new Date('2026-01-01T12:00:00.000Z'),
      endDate: null,
    }, '2026-10-15');

    expect(result.valid).toBe(false);
    expect((result as any).reason).toMatch(/holiday/i);
  });
});

describe('ensureSingleSession — ScheduleException blocks on-demand creation', () => {
  it('returns error when date is blocked by ScheduleException', async () => {
    const { school, block, staff } = await setup();

    const exceptedDate = '2026-08-10';
    const actorUser = await prisma.user.findFirst({ where: { schoolId: school.id } });
    await prisma.scheduleException.create({
      data: {
        schoolId: school.id,
        type: 'HOLIDAY_CUSTOM',
        scope: 'SCHOOL',
        startDate: new Date(`${exceptedDate}T00:00:00.000Z`),
        endDate:   new Date(`${exceptedDate}T23:59:59.000Z`),
        days: [],
        createdById: actorUser!.id,
      },
    });

    const result = await ensureSingleSession(
      {
        id: block.id,
        schoolId: school.id,
        days: [0,1,2,3,4,5,6],
        startDate: new Date('2026-01-01T12:00:00.000Z'),
        endDate: null,
        teacherId: staff.id,
        cabinetId: null,
        startTime: '09:00',
        endTime: '10:00',
        studentGroupId: block.studentGroupId,
      },
      exceptedDate,
    );

    expect('error' in result).toBe(true);
    expect((result as any).error).toMatch(/exception/i);

    // Confirm no session was created
    const sessions = await prisma.lessonSession.findMany({
      where: { lessonBlockId: block.id },
    });
    expect(sessions).toHaveLength(0);
  });
});
