/**
 * Integration — F-03 fix: LESSON_SKIP freeze cleaned up when session is cancelled.
 *
 * Before this fix: cancelling a session left any LESSON_SKIP freeze pointing to it
 * in ACTIVE status forever. StudentProfile.isFrozen stayed true indefinitely.
 *
 * After fix: changeSessionStatus (CANCELLED path) cancels all LESSON_SKIP freezes
 * targeting the session, then re-evaluates StudentProfile.isFrozen for each
 * affected student (cleared if no other ACTIVE freezes remain).
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
import { cancelSession } from '../../services/scheduleLifecycleService';
import type { LifecycleActor } from '../../services/scheduleLifecycleTypes';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school    = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
  await createFinanceConfig(school.id, 1);
  const ownerUser = await createUser(school.id, 'OWNER');
  const teacher   = await createUser(school.id, 'TEACHER');
  const staff     = await createStaffProfile(teacher.id, school.id);
  const stuUser   = await createUser(school.id, 'STUDENT');
  const student   = await createStudentProfile(stuUser.id, school.id, 10);
  const group     = await createGroup(school.id);
  await createMembership(group.id, student.id, school.id);
  const block     = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  const actor: LifecycleActor = { userId: ownerUser.id, role: 'OWNER', schoolId: school.id };
  return { school, staff, student, group, block, actor };
}

async function makeUpcomingSession(blockId: number, schoolId: number, staffId: number) {
  return prisma.lessonSession.create({
    data: {
      schoolId, lessonBlockId: blockId,
      date:          new Date('2026-07-10T12:00:00.000Z'),
      status:        'UPCOMING',
      teacherIdSnap: staffId,
      startTimeSnap: '09:00', endTimeSnap: '10:00',
    },
  });
}

async function makeLessonSkipFreeze(
  studentProfileId: number,
  schoolId: number,
  lessonSessionId: number,
  createdById: number,
) {
  const freeze = await prisma.studentFreeze.create({
    data: {
      schoolId, studentProfileId, lessonSessionId,
      type:        'LESSON_SKIP',
      status:      'ACTIVE',
      createdById,
    },
  });
  await prisma.studentProfile.update({
    where: { id: studentProfileId },
    data:  { isFrozen: true, frozenAt: new Date() },
  });
  return freeze;
}

// ─── 1. Freeze cancelled when session is cancelled ────────────────────────────

describe('F-03 — LESSON_SKIP freeze cancelled when its session is cancelled', () => {
  it('freeze status becomes CANCELLED after session cancel', async () => {
    const { school, staff, student, block, actor } = await setup();
    const session = await makeUpcomingSession(block.id, school.id, staff.id);
    const freeze  = await makeLessonSkipFreeze(student.id, school.id, session.id, actor.userId);

    await cancelSession({
      sessionId: session.id,
      schoolId:  school.id,
      actor,
      reason:    'School closure',
    });

    const updated = await prisma.studentFreeze.findUnique({ where: { id: freeze.id } });
    expect(updated!.status).toBe('CANCELLED');
  });

  it('StudentProfile.isFrozen becomes false after session cancel (no other active freezes)', async () => {
    const { school, staff, student, block, actor } = await setup();
    const session = await makeUpcomingSession(block.id, school.id, staff.id);
    await makeLessonSkipFreeze(student.id, school.id, session.id, actor.userId);

    await cancelSession({
      sessionId: session.id,
      schoolId:  school.id,
      actor,
      reason:    'School closure',
    });

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.isFrozen).toBe(false);
    expect(profile!.frozenAt).toBeNull();
  });
});

// ─── 2. isFrozen stays true when another active freeze remains ─────────────────

describe('F-03 — isFrozen stays true when another ACTIVE freeze remains', () => {
  it('isFrozen = true when a second ACTIVE LESSON_SKIP freeze exists for a different session', async () => {
    const { school, staff, student, block, actor } = await setup();

    const session1 = await makeUpcomingSession(block.id, school.id, staff.id);

    // Second session for the second freeze
    const session2 = await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: new Date('2026-07-17T12:00:00.000Z'), status: 'UPCOMING',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
      },
    });

    await makeLessonSkipFreeze(student.id, school.id, session1.id, actor.userId);

    // Second freeze (different session) — manually set ACTIVE
    await prisma.studentFreeze.create({
      data: {
        schoolId: school.id, studentProfileId: student.id,
        lessonSessionId: session2.id,
        type: 'LESSON_SKIP', status: 'ACTIVE',
        createdById: actor.userId,
      },
    });

    // Cancel session1 — its freeze should be cancelled; but session2 freeze is still active
    await cancelSession({
      sessionId: session1.id,
      schoolId:  school.id,
      actor,
      reason:    'Teacher sick',
    });

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.isFrozen).toBe(true);
  });
});

// ─── 3. PERIOD freezes are NOT touched ────────────────────────────────────────

describe('F-03 — PERIOD freeze is NOT cancelled when session is cancelled', () => {
  it('ACTIVE PERIOD freeze remains active after session cancel', async () => {
    const { school, staff, student, block, actor } = await setup();
    const session = await makeUpcomingSession(block.id, school.id, staff.id);

    // Create a PERIOD freeze (not a LESSON_SKIP)
    const periodFreeze = await prisma.studentFreeze.create({
      data: {
        schoolId: school.id, studentProfileId: student.id,
        type:      'PERIOD',
        startDate: new Date('2026-07-01T00:00:00.000Z'),
        endDate:   new Date('2026-07-31T00:00:00.000Z'),
        status:    'ACTIVE',
        createdById: actor.userId,
      },
    });
    await prisma.studentProfile.update({
      where: { id: student.id },
      data:  { isFrozen: true, frozenAt: new Date() },
    });

    await cancelSession({
      sessionId: session.id,
      schoolId:  school.id,
      actor,
      reason:    'School closure',
    });

    const updated = await prisma.studentFreeze.findUnique({ where: { id: periodFreeze.id } });
    expect(updated!.status).toBe('ACTIVE');

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.isFrozen).toBe(true);
  });
});

// ─── 4. No freeze — no side effects ──────────────────────────────────────────

describe('F-03 — session cancel with no freeze is unaffected', () => {
  it('session cancels normally when no LESSON_SKIP freeze exists', async () => {
    const { school, staff, student: _student, block, actor } = await setup();
    const session = await makeUpcomingSession(block.id, school.id, staff.id);

    const result = await cancelSession({
      sessionId: session.id,
      schoolId:  school.id,
      actor,
      reason:    'School closure',
    });

    expect(result.status).toBe('CANCELLED');
  });
});
