/**
 * Integration — Phase 2: Makeup concurrency invariant
 *
 * Verifies:
 *   - FOR UPDATE lock serializes concurrent createMakeupSession calls:
 *     only one succeeds, the other gets MAKEUP_ALREADY_EXISTS (409)
 *   - Partial unique index "LessonSession_active_makeup_unique" blocks a second
 *     active makeup at the DB level (P2002 → MAKEUP_ALREADY_EXISTS surface)
 *   - A CANCELLED makeup does NOT block a new active makeup (partial index allows it)
 *   - A soft-deleted makeup does NOT block a new active makeup
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
import { createMakeupSession } from '../../services/scheduleLifecycleService';
import type { LifecycleActor } from '../../services/scheduleLifecycleTypes';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

const CANCELLED_DATE = new Date('2026-06-10T12:00:00.000Z'); // Wednesday — valid
const MAKEUP_DATE_A  = new Date('2026-06-22T12:00:00.000Z'); // Monday
const MAKEUP_DATE_B  = new Date('2026-06-29T12:00:00.000Z'); // Following Monday

async function setup() {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
  await createFinanceConfig(school.id, 1);
  const ownerUser = await createUser(school.id, 'OWNER');
  const teachUser = await createUser(school.id, 'TEACHER');
  const staff     = await createStaffProfile(teachUser.id, school.id);
  const group     = await createGroup(school.id);
  const block     = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  const actor: LifecycleActor = { userId: ownerUser.id, role: 'OWNER', schoolId: school.id };
  return { school, staff, group, block, actor };
}

// ─── 1. FOR UPDATE concurrency guard ─────────────────────────────────────────

describe('createMakeupSession — FOR UPDATE serialization', () => {
  it('concurrent calls for the same session produce exactly one makeup', async () => {
    const { school, staff, block, actor } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: CANCELLED_DATE, status: 'CANCELLED',
    });

    // Launch both concurrently — FOR UPDATE inside the transaction serializes them.
    const [r1, r2] = await Promise.allSettled([
      createMakeupSession({
        originalSessionId: original.id, schoolId: school.id, actor,
        newDate: MAKEUP_DATE_A, reason: 'makeup for cancelled class',
      }),
      createMakeupSession({
        originalSessionId: original.id, schoolId: school.id, actor,
        newDate: MAKEUP_DATE_B, reason: 'makeup for cancelled class',
      }),
    ]);

    const succeeded = [r1, r2].filter(r => r.status === 'fulfilled');
    const failed    = [r1, r2].filter(r => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.message).toBe('MAKEUP_ALREADY_EXISTS');
    expect((failed[0] as PromiseRejectedResult).reason.httpStatus).toBe(409);

    // Exactly one makeup session in the DB
    const makeups = await prisma.lessonSession.findMany({
      where: { makeupForSessionId: original.id, deletedAt: null },
    });
    expect(makeups).toHaveLength(1);
    expect(makeups[0].isMakeup).toBe(true);
  });
});

// ─── 2. Partial unique index — DB-level enforcement ───────────────────────────

describe('partial unique index — LessonSession_active_makeup_unique', () => {
  it('direct DB insert of a second active makeup violates the unique index', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: CANCELLED_DATE, status: 'CANCELLED',
    });

    // First makeup — inserted directly (bypassing service)
    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: MAKEUP_DATE_A, status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });

    // Second active makeup for same original → DB constraint must reject it
    await expect(
      prisma.lessonSession.create({
        data: {
          schoolId: school.id, lessonBlockId: block.id,
          date: MAKEUP_DATE_B, status: 'UPCOMING',
          teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
          isMakeup: true, makeupForSessionId: original.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('CANCELLED makeup does NOT block a new active makeup (partial index allows it)', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: CANCELLED_DATE, status: 'CANCELLED',
    });

    // First makeup — CANCELLED status
    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: MAKEUP_DATE_A, status: 'CANCELLED',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });

    // Second makeup — UPCOMING is allowed because first is CANCELLED (not in index)
    const second = await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: MAKEUP_DATE_B, status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });
    expect(second.status).toBe('UPCOMING');
  });

  it('soft-deleted makeup does NOT block a new active makeup', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: CANCELLED_DATE, status: 'CANCELLED',
    });

    // First makeup — soft deleted
    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: MAKEUP_DATE_A, status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
        deletedAt: new Date(),
      },
    });

    // Second active makeup — allowed because first is soft-deleted (not in index)
    const second = await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: MAKEUP_DATE_B, status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });
    expect(second.status).toBe('UPCOMING');
  });
});

// ─── 3. MAKEUP_ALREADY_EXISTS error shape ─────────────────────────────────────

describe('MAKEUP_ALREADY_EXISTS — canonical error shape', () => {
  it('has httpStatus 409 and lifecycleError flag when app guard fires', async () => {
    const { school, staff, block, actor } = await setup();

    const original = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: CANCELLED_DATE, status: 'CANCELLED',
    });

    // Create a makeup via service (app guard will set the state)
    await createMakeupSession({
      originalSessionId: original.id, schoolId: school.id, actor,
      newDate: MAKEUP_DATE_A, reason: 'makeup for cancelled class',
    });

    // Second call via service → app guard catches it
    let caught: any;
    try {
      await createMakeupSession({
        originalSessionId: original.id, schoolId: school.id, actor,
        newDate: MAKEUP_DATE_B, reason: 'makeup for cancelled class',
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught.message).toBe('MAKEUP_ALREADY_EXISTS');
    expect(caught.httpStatus).toBe(409);
    expect(caught.details?.lifecycleError).toBe(true);
  });
});
