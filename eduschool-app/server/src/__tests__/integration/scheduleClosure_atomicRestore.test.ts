/**
 * Integration — F-06 fix: restoreSession is fully atomic (status + roster in one tx).
 *
 * Before this fix: changeSessionStatus committed first (separate transaction), then
 * reconcileRoster ran in separate transactions. If reconciliation failed, the session
 * was UPCOMING with a stale roster and no recovery path.
 *
 * After fix: the entire restoreSession body (status transition + roster reconciliation)
 * runs inside a single $transaction. If any step fails, the session stays CANCELLED
 * (recoverable state — admin can retry).
 *
 * Verification strategy: test that the final committed state is always consistent —
 * either fully restored (UPCOMING + correct roster) or not restored at all.
 * We can't easily inject mid-tx failures in integration tests, so we test the
 * success path atomicity: that status AND roster are correct in the same observation.
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

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

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

async function makeCancelledSession(
  blockId: number, schoolId: number, staffId: number,
  studentIds: number[],
) {
  const session = await prisma.lessonSession.create({
    data: {
      schoolId, lessonBlockId: blockId,
      date: daysFromNow(7), status: 'CANCELLED',
      teacherIdSnap: staffId, startTimeSnap: '09:00', endTimeSnap: '10:00',
    },
  });
  for (const sid of studentIds) {
    await prisma.sessionStudent.create({
      data: { schoolId, lessonSessionId: session.id, studentProfileId: sid },
    });
  }
  return session;
}

// ─── 1. Status and roster are consistent after successful restore ─────────────

describe('F-06 — restoreSession: status and roster are atomically committed', () => {
  it('session is UPCOMING AND roster includes new member in same observation', async () => {
    const { school, staff, group, block, actor } = await setup();

    const userA   = await createUser(school.id, 'STUDENT');
    const stuA    = await createStudentProfile(userA.id, school.id);
    await createMembership(group.id, stuA.id, school.id);

    const session = await makeCancelledSession(block.id, school.id, staff.id, [stuA.id]);

    // B joins after cancellation
    const userB   = await createUser(school.id, 'STUDENT');
    const stuB    = await createStudentProfile(userB.id, school.id);
    await createMembership(group.id, stuB.id, school.id);

    await restoreSession({ sessionId: session.id, schoolId: school.id, actor });

    // Both status and roster are visible atomically (single read)
    const [dbSession, roster] = await Promise.all([
      prisma.lessonSession.findUnique({ where: { id: session.id } }),
      prisma.sessionStudent.findMany({ where: { lessonSessionId: session.id }, select: { studentProfileId: true } }),
    ]);

    expect(dbSession!.status).toBe('UPCOMING');
    const rosterIds = roster.map(r => r.studentProfileId).sort();
    expect(rosterIds).toEqual([stuA.id, stuB.id].sort());
  });

  it('session is UPCOMING AND withdrawn member is removed in same observation', async () => {
    const { school, staff, group, block, actor } = await setup();

    const userA    = await createUser(school.id, 'STUDENT');
    const stuA     = await createStudentProfile(userA.id, school.id);
    await createMembership(group.id, stuA.id, school.id);

    const userB    = await createUser(school.id, 'STUDENT');
    const stuB     = await createStudentProfile(userB.id, school.id);
    const memB     = await createMembership(group.id, stuB.id, school.id);

    const session  = await makeCancelledSession(block.id, school.id, staff.id, [stuA.id, stuB.id]);

    // B withdraws after cancellation
    await prisma.groupMembership.update({
      where: { id: memB.id },
      data:  { status: 'WITHDRAWN' },
    });

    await restoreSession({ sessionId: session.id, schoolId: school.id, actor });

    const [dbSession, roster] = await Promise.all([
      prisma.lessonSession.findUnique({ where: { id: session.id } }),
      prisma.sessionStudent.findMany({ where: { lessonSessionId: session.id }, select: { studentProfileId: true } }),
    ]);

    expect(dbSession!.status).toBe('UPCOMING');
    const rosterIds = roster.map(r => r.studentProfileId);
    expect(rosterIds).toContain(stuA.id);
    expect(rosterIds).not.toContain(stuB.id);
  });
});

// ─── 2. Session with no roster group is restored cleanly ─────────────────────

describe('F-06 — restoreSession with no group roster has no side effects', () => {
  it('session without a group restores to UPCOMING with version increment', async () => {
    const { school, staff, block, actor } = await setup();
    const session = await makeCancelledSession(block.id, school.id, staff.id, []);

    const versionBefore = session.version;
    const result = await restoreSession({ sessionId: session.id, schoolId: school.id, actor });

    expect(result.status).toBe('UPCOMING');
    // Version is incremented by the status update — confirms the transaction committed
    expect(result.version).toBe(versionBefore + 1);
  });
});
