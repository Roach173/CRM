/**
 * Integration — F-02 fix: restoreSession blocks restore when active makeup exists.
 *
 * Before this fix restoreSession() had no guard for existing active makeup sessions.
 * Sequence: cancel A → create makeup M (UPCOMING) → restore A (UPCOMING) produced
 * two UPCOMING sessions, causing double credit deduction when both were attended.
 *
 * After fix: restoreSession throws ACTIVE_MAKEUP_EXISTS (409) if a non-CANCELLED
 * makeup session exists for the cancelled session. Admin must cancel the makeup first.
 */

import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStudentProfile,
  createStaffProfile,
  createGroup,
  createBlock,
  createFinanceConfig,
  createMembership,
} from '../helpers/testDb';
import { restoreSession } from '../../services/scheduleLifecycleService';
import type { LifecycleActor } from '../../services/scheduleLifecycleTypes';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school    = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
  await createFinanceConfig(school.id, 1);
  const ownerUser = await createUser(school.id, 'OWNER');
  const teacher   = await createUser(school.id, 'TEACHER');
  const staff     = await createStaffProfile(teacher.id, school.id);
  const group     = await createGroup(school.id);
  const block     = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  const actor: LifecycleActor = { userId: ownerUser.id, role: 'OWNER', schoolId: school.id };
  return { school, staff, group, block, actor };
}

async function makeCancelledSession(blockId: number, schoolId: number, staffId: number) {
  return prisma.lessonSession.create({
    data: {
      schoolId, lessonBlockId: blockId,
      date:          new Date('2026-06-20T12:00:00.000Z'),
      status:        'CANCELLED',
      teacherIdSnap: staffId,
      startTimeSnap: '09:00', endTimeSnap: '10:00',
    },
  });
}

// ─── 1. Block restore when UPCOMING makeup exists ─────────────────────────────

describe('F-02 — restoreSession blocked by active makeup', () => {
  it('throws ACTIVE_MAKEUP_EXISTS when a non-CANCELLED makeup exists', async () => {
    const { school, staff, block, actor } = await setup();
    const original = await makeCancelledSession(block.id, school.id, staff.id);

    // Create an active makeup for the cancelled session
    await prisma.lessonSession.create({
      data: {
        schoolId:          school.id,
        lessonBlockId:     block.id,
        date:              new Date('2026-06-25T12:00:00.000Z'),
        status:            'UPCOMING',
        teacherIdSnap:     staff.id,
        startTimeSnap:     '09:00', endTimeSnap: '10:00',
        isMakeup:          true,
        makeupForSessionId: original.id,
      },
    });

    await expect(
      restoreSession({ sessionId: original.id, schoolId: school.id, actor })
    ).rejects.toMatchObject({ message: 'ACTIVE_MAKEUP_EXISTS' });
  });

  it('error has httpStatus 409 and lifecycleError flag', async () => {
    const { school, staff, block, actor } = await setup();
    const original = await makeCancelledSession(block.id, school.id, staff.id);

    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: new Date('2026-06-25T12:00:00.000Z'), status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });

    const err: any = await restoreSession({ sessionId: original.id, schoolId: school.id, actor })
      .catch(e => e);

    expect(err.httpStatus).toBe(409);
    expect(err.details?.lifecycleError).toBe(true);
    expect(err.details?.activeMakeupId).toBeDefined();
  });

  it('throws when makeup is IN_PROGRESS (not just UPCOMING)', async () => {
    const { school, staff, block, actor } = await setup();
    const original = await makeCancelledSession(block.id, school.id, staff.id);

    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: new Date('2026-06-25T12:00:00.000Z'), status: 'IN_PROGRESS',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });

    await expect(
      restoreSession({ sessionId: original.id, schoolId: school.id, actor })
    ).rejects.toMatchObject({ message: 'ACTIVE_MAKEUP_EXISTS' });
  });
});

// ─── 2. Allow restore when makeup is CANCELLED ────────────────────────────────

describe('F-02 — restoreSession allowed when makeup is CANCELLED', () => {
  it('succeeds when the only makeup is CANCELLED', async () => {
    const { school, staff, block, actor } = await setup();
    const original = await makeCancelledSession(block.id, school.id, staff.id);

    // Makeup was created then cancelled — session should be restorable
    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: new Date('2026-06-25T12:00:00.000Z'), status: 'CANCELLED',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });

    const result = await restoreSession({ sessionId: original.id, schoolId: school.id, actor });
    expect(result.status).toBe('UPCOMING');
  });

  it('succeeds when no makeup exists at all', async () => {
    const { school, staff, block, actor } = await setup();
    const original = await makeCancelledSession(block.id, school.id, staff.id);

    const result = await restoreSession({ sessionId: original.id, schoolId: school.id, actor });
    expect(result.status).toBe('UPCOMING');
  });
});
