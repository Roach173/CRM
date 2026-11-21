/**
 * Integration — Phase 3: restoreSession roster reconciliation via rosterService
 *
 * Verifies that after CANCELLED → UPCOMING transition, the SessionStudent roster
 * is reconciled to match the current group membership:
 *   - New ACTIVE members get a SessionStudent row added
 *   - WITHDRAWN members get their SessionStudent row removed (if no attendance)
 *   - Existing roster rows for still-ACTIVE members are untouched (idempotent)
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

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

async function setup() {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
  await createFinanceConfig(school.id, 1);
  const ownerUser = await createUser(school.id, 'OWNER');
  const teachUser = await createUser(school.id, 'TEACHER');
  const staff     = await createStaffProfile(teachUser.id, school.id);
  const group     = await createGroup(school.id);
  const block     = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  const actor: LifecycleActor = { userId: ownerUser.id, role: 'OWNER', schoolId: school.id };
  return { school, ownerUser, staff, group, block, actor };
}

async function createCancelledSessionWithRoster(
  blockId: number,
  schoolId: number,
  staffId: number,
  studentIds: number[],
): Promise<{ session: any }> {
  const session = await prisma.lessonSession.create({
    data: {
      schoolId,
      lessonBlockId: blockId,
      date: daysFromNow(7),
      status: 'CANCELLED',
      teacherIdSnap: staffId,
      startTimeSnap: '09:00',
      endTimeSnap: '10:00',
    },
  });
  for (const sid of studentIds) {
    await prisma.sessionStudent.create({
      data: { schoolId, lessonSessionId: session.id, studentProfileId: sid },
    });
  }
  return { session };
}

// ─── 1. New active member added after cancellation ────────────────────────────

describe('restoreSession — adds new active members to roster', () => {
  it('student who joined group after session was cancelled gets a SessionStudent row', async () => {
    const { school, staff, group, block, actor } = await setup();

    // Student A: original roster member
    const userA    = await createUser(school.id, 'STUDENT');
    const studentA = await createStudentProfile(userA.id, school.id);
    await createMembership(group.id, studentA.id, school.id);

    const { session } = await createCancelledSessionWithRoster(
      block.id, school.id, staff.id, [studentA.id],
    );

    // Student B joins the group AFTER the session was cancelled
    const userB    = await createUser(school.id, 'STUDENT');
    const studentB = await createStudentProfile(userB.id, school.id);
    await createMembership(group.id, studentB.id, school.id);

    // Restore the session
    await restoreSession({
      sessionId: session.id,
      schoolId: school.id,
      actor,
    });

    const roster = await prisma.sessionStudent.findMany({
      where: { lessonSessionId: session.id },
      select: { studentProfileId: true },
    });
    const rosterIds = roster.map(r => r.studentProfileId).sort();
    expect(rosterIds).toEqual([studentA.id, studentB.id].sort());
  });
});

// ─── 2. Withdrawn member removed after restore ────────────────────────────────

describe('restoreSession — removes withdrawn members from roster', () => {
  it('student who withdrew after session was cancelled is removed on restore', async () => {
    const { school, staff, group, block, actor } = await setup();

    const userA    = await createUser(school.id, 'STUDENT');
    const studentA = await createStudentProfile(userA.id, school.id);
    await createMembership(group.id, studentA.id, school.id);

    const userB    = await createUser(school.id, 'STUDENT');
    const studentB = await createStudentProfile(userB.id, school.id);
    const membershipB = await createMembership(group.id, studentB.id, school.id);

    const { session } = await createCancelledSessionWithRoster(
      block.id, school.id, staff.id, [studentA.id, studentB.id],
    );

    // Student B withdraws from the group after cancellation
    await prisma.groupMembership.update({
      where: { id: membershipB.id },
      data: { status: 'WITHDRAWN' },
    });

    // Restore
    await restoreSession({
      sessionId: session.id,
      schoolId: school.id,
      actor,
    });

    const roster = await prisma.sessionStudent.findMany({
      where: { lessonSessionId: session.id },
      select: { studentProfileId: true },
    });
    const rosterIds = roster.map(r => r.studentProfileId);
    expect(rosterIds).toContain(studentA.id);
    expect(rosterIds).not.toContain(studentB.id);
  });

  it('withdrawn member with attendance on the restored session is protected', async () => {
    const { school, staff, group, block, actor } = await setup();

    const userB    = await createUser(school.id, 'STUDENT');
    const studentB = await createStudentProfile(userB.id, school.id);
    const membershipB = await createMembership(group.id, studentB.id, school.id);

    const { session } = await createCancelledSessionWithRoster(
      block.id, school.id, staff.id, [studentB.id],
    );

    // Add an attendance record for B on this session (creditDeducted=false — safe to cancel)
    const ss = await prisma.sessionStudent.findFirst({
      where: { lessonSessionId: session.id, studentProfileId: studentB.id },
    });
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: studentB.id,
        sessionStudentId: ss!.id,
        status: 'PRESENT',
        creditDeducted: false,
      },
    });

    // B withdraws
    await prisma.groupMembership.update({
      where: { id: membershipB.id },
      data: { status: 'WITHDRAWN' },
    });

    // Restore — B should stay on roster because of existing attendance
    await restoreSession({ sessionId: session.id, schoolId: school.id, actor });

    const roster = await prisma.sessionStudent.findMany({
      where: { lessonSessionId: session.id },
      select: { studentProfileId: true },
    });
    expect(roster.map(r => r.studentProfileId)).toContain(studentB.id);
  });
});

// ─── 3. Unchanged roster remains intact ──────────────────────────────────────

describe('restoreSession — unchanged roster is unaffected', () => {
  it('restoring with no membership changes preserves the original roster exactly', async () => {
    const { school, staff, group, block, actor } = await setup();

    const userA    = await createUser(school.id, 'STUDENT');
    const studentA = await createStudentProfile(userA.id, school.id);
    await createMembership(group.id, studentA.id, school.id);

    const { session } = await createCancelledSessionWithRoster(
      block.id, school.id, staff.id, [studentA.id],
    );

    await restoreSession({ sessionId: session.id, schoolId: school.id, actor });

    const roster = await prisma.sessionStudent.findMany({
      where: { lessonSessionId: session.id },
      select: { studentProfileId: true },
    });
    expect(roster).toHaveLength(1);
    expect(roster[0].studentProfileId).toBe(studentA.id);
  });

  it('session status is UPCOMING after restore', async () => {
    const { school, staff, group, block, actor } = await setup();

    const userA    = await createUser(school.id, 'STUDENT');
    const studentA = await createStudentProfile(userA.id, school.id);
    await createMembership(group.id, studentA.id, school.id);

    const { session } = await createCancelledSessionWithRoster(
      block.id, school.id, staff.id, [studentA.id],
    );

    await restoreSession({ sessionId: session.id, schoolId: school.id, actor });

    const dbSession = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(dbSession!.status).toBe('UPCOMING');
  });
});
