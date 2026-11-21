/**
 * Integration — Phase 1: Makeup & Move date validation via validateSessionDate
 *
 * Verifies that createMakeupSession() and moveSession() enforce Working Date SOT:
 *   - MAKEUP_DATE_INVALID thrown when makeup date is blocked by ScheduleException
 *   - MAKEUP_DATE_INVALID thrown when makeup date falls on an inactive school day
 *   - MOVE_DATE_INVALID thrown when move target is blocked by ScheduleException
 *   - MOVE_DATE_INVALID thrown when move target falls on an inactive school day
 *   - moveSession allows a target working day outside the recurring block pattern
 */

import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStaffProfile,
  createGroup,
  createBlock,
  createSession,
  createFinanceConfig,
} from '../helpers/testDb';
import {
  createMakeupSession,
  moveSession,
} from '../../services/scheduleLifecycleService';
import type { LifecycleActor } from '../../services/scheduleLifecycleTypes';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// School: Mon–Fri active (index 0–4). Block: Mon, Wed, Fri (index 0,2,4).
// All sessions anchored at UTC noon to be timezone-safe.
const CANCELLED_DATE = new Date('2026-06-10T12:00:00.000Z'); // Wednesday — valid for block
const UPCOMING_DATE  = new Date('2026-06-10T12:00:00.000Z'); // Wednesday — valid for block
const SATURDAY_DATE  = new Date('2026-06-13T12:00:00.000Z'); // Saturday  — not in activeDays
const TUESDAY_DATE   = new Date('2026-06-16T12:00:00.000Z'); // Tuesday   — in activeDays but not block.days
const EXCEPTION_DATE = new Date('2026-07-06T12:00:00.000Z'); // Monday    — will be covered by ScheduleException

async function setup() {
  const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
  await createFinanceConfig(school.id, 1);
  const ownerUser  = await createUser(school.id, 'OWNER');
  const teachUser  = await createUser(school.id, 'TEACHER');
  const staff      = await createStaffProfile(teachUser.id, school.id);
  await prisma.staffProfile.update({
    where: { id: staff.id },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  const group   = await createGroup(school.id);
  // Default block days: [0,2,4] — Mon, Wed, Fri
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  const cabinet = await prisma.cabinet.create({
    data: { schoolId: school.id, name: 'Room A', capacity: 20 },
  });
  const actor: LifecycleActor = { userId: ownerUser.id, role: 'OWNER', schoolId: school.id };
  return { school, ownerUser, staff, group, block, cabinet, actor };
}

async function addSchoolException(schoolId: number, date: Date, createdById: number) {
  const dateStr = date.toISOString().slice(0, 10);
  return prisma.scheduleException.create({
    data: {
      schoolId,
      type: 'HOLIDAY_CUSTOM',
      scope: 'SCHOOL',
      startDate: new Date(`${dateStr}T00:00:00.000Z`),
      endDate:   new Date(`${dateStr}T23:59:59.000Z`),
      days: [],
      createdById,
    },
  });
}

// ─── createMakeupSession — date validation ────────────────────────────────────

describe('createMakeupSession — date validation', () => {
  it('throws MAKEUP_DATE_INVALID when makeup date is blocked by ScheduleException', async () => {
    const { school, staff, block, actor, ownerUser } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: CANCELLED_DATE, status: 'CANCELLED',
    });
    await addSchoolException(school.id, EXCEPTION_DATE, ownerUser.id);

    await expect(
      createMakeupSession({
        originalSessionId: original.id,
        schoolId: school.id,
        actor,
        newDate: EXCEPTION_DATE,
        reason: 'makeup for cancelled class',
      }),
    ).rejects.toMatchObject({
      message: 'MAKEUP_DATE_INVALID',
    });

    // No makeup session created
    const makeups = await prisma.lessonSession.findMany({
      where: { makeupForSessionId: original.id },
    });
    expect(makeups).toHaveLength(0);
  });

  it('throws MAKEUP_DATE_INVALID when makeup date falls on an inactive school day', async () => {
    const { school, staff, block, actor } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: CANCELLED_DATE, status: 'CANCELLED',
    });

    // Saturday is index 5 — not in activeDays [0,1,2,3,4]
    await expect(
      createMakeupSession({
        originalSessionId: original.id,
        schoolId: school.id,
        actor,
        newDate: SATURDAY_DATE,
        reason: 'makeup for cancelled class',
      }),
    ).rejects.toMatchObject({
      message: 'MAKEUP_DATE_INVALID',
    });

    const makeups = await prisma.lessonSession.findMany({
      where: { makeupForSessionId: original.id },
    });
    expect(makeups).toHaveLength(0);
  });

  it('creates makeup successfully on a valid working day', async () => {
    const { school, staff, block, actor } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: CANCELLED_DATE, status: 'CANCELLED',
    });

    // Monday (index 0) is in activeDays [0,1,2,3,4] and no exception — valid
    const validMakeupDate = new Date('2026-06-22T12:00:00.000Z');
    const result = await createMakeupSession({
      originalSessionId: original.id,
      schoolId: school.id,
      actor,
      newDate: validMakeupDate,
      reason: 'makeup for cancelled class',
    });

    expect(result.isMakeup).toBe(true);
    expect(result.makeupForSessionId).toBe(original.id);
    expect(result.status).toBe('UPCOMING');
  });
});

// ─── moveSession — date validation ───────────────────────────────────────────

describe('moveSession — date validation', () => {
  it('throws MOVE_DATE_INVALID when target date is blocked by ScheduleException', async () => {
    const { school, staff, block, cabinet, actor, ownerUser } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: UPCOMING_DATE, status: 'UPCOMING',
    });
    await addSchoolException(school.id, EXCEPTION_DATE, ownerUser.id);

    // EXCEPTION_DATE is Monday — in activeDays and block.days, but blocked by exception
    await expect(
      moveSession({
        sessionId: session.id,
        schoolId: school.id,
        actor,
        newDate: EXCEPTION_DATE,
        newStartTime: '09:00',
        newEndTime: '10:00',
        newCabinetId: cabinet.id,
        reason: 'rescheduling due to conflict',
        versionGuard: session.version,
      }),
    ).rejects.toMatchObject({
      message: 'MOVE_DATE_INVALID',
    });

    // Original session must remain UPCOMING — transaction rolled back
    const dbSession = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(dbSession!.status).toBe('UPCOMING');
  });

  it('throws MOVE_DATE_INVALID when target date falls on an inactive school day', async () => {
    const { school, staff, block, cabinet, actor } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: UPCOMING_DATE, status: 'UPCOMING',
    });

    // Saturday — not in activeDays [0,1,2,3,4]
    await expect(
      moveSession({
        sessionId: session.id,
        schoolId: school.id,
        actor,
        newDate: SATURDAY_DATE,
        newStartTime: '09:00',
        newEndTime: '10:00',
        newCabinetId: cabinet.id,
        reason: 'rescheduling due to conflict',
        versionGuard: session.version,
      }),
    ).rejects.toMatchObject({
      message: 'MOVE_DATE_INVALID',
    });

    const dbSession = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(dbSession!.status).toBe('UPCOMING');
  });

  it('allows target date outside the recurring block day pattern', async () => {
    const { school, staff, block, cabinet, actor } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: UPCOMING_DATE, status: 'UPCOMING',
    });

    const result = await moveSession({
      sessionId: session.id,
      schoolId: school.id,
      actor,
      newDate: TUESDAY_DATE,
      newStartTime: '09:00',
      newEndTime: '10:00',
      newCabinetId: cabinet.id,
      reason: 'rescheduling due to conflict',
      versionGuard: session.version,
    });

    const dbSession = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(result.session.id).toBe(session.id);
    expect(dbSession!.date.toISOString()).toBe(TUESDAY_DATE.toISOString());
    expect(dbSession!.isManualDate).toBe(true);
    expect(dbSession!.dateOverrideFrom!.toISOString()).toBe(UPCOMING_DATE.toISOString());
  });
});
