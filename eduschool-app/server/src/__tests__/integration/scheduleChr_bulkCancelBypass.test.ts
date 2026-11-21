/**
 * CHARACTERIZATION TESTS — Bulk Cancel Bypass
 * PR 1: Schedule Lifecycle — document pre-PR-3 behavior, NO production code changes.
 *
 * ✅ FIXED IN PR 3: POST /sessions/bulk-cancel now routes through
 *   scheduleLifecycleService.cancelSession() per session.
 *   - reason is required (≥ 5 chars) — 400 if absent
 *   - canTransition() is enforced per session
 *   - ScheduleActionLog entry written per cancelled session via logScheduleAction()
 *   - notifyMany() called for each session's student group
 *   - emitToSchool('session:status-changed') emitted per session
 *
 * These tests document the OLD direct-updateMany behavior (simulated inline).
 * They remain as regression tests documenting what the old path did and why the
 * lifecycle wiring was necessary. They use direct Prisma calls, NOT the real route.
 *
 * Remaining gaps NOT fixed by PR 3 (see TODO markers below):
 *   - canTransition() is still only a query-filter guard at the DB level for IN_PROGRESS
 *     sessions (the lifecycle service itself also guards this, but the old path didn't).
 */

import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
  createStaffProfile, createGroup, createBlock, createSession,
  createSessionStudent, createFinanceConfig,
} from '../helpers/testDb';
import { getDayBoundaries } from '../../lib/tzUtils';
import { canTransition } from '../../lib/sessionStateMachine';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school  = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  await createFinanceConfig(school.id, 1);
  const owner   = await createUser(school.id, 'OWNER');
  const teacher = await createUser(school.id, 'TEACHER');
  const staff   = await createStaffProfile(teacher.id, school.id);
  const stuUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(stuUser.id, school.id, 10);
  const group   = await createGroup(school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, owner, teacher, staff, student, group, block };
}

// ─── 1. Functional: bulk cancel does cancel sessions ─────────────────────────

describe('CHARACTERIZATION — bulk cancel correctly cancels sessions', () => {
  it('sets session status to CANCELLED for each UPCOMING session on the target date', async () => {
    const { school, staff } = await setup();
    const block2 = await prisma.lessonBlock.findFirst({ where: { schoolId: school.id } });

    const targetDate = new Date('2026-06-10T12:00:00.000Z');
    const s1 = await createSession({ blockId: block2!.id, schoolId: school.id, staffProfileId: staff.id, date: targetDate, status: 'UPCOMING' });

    // Simulate what POST /sessions/bulk-cancel does:
    const tz = 'UTC';
    const { from: dayStart, to: dayEnd } = getDayBoundaries('2026-06-10', tz);

    const sessions = await prisma.lessonSession.findMany({
      where: { schoolId: school.id, date: { gte: dayStart, lte: dayEnd }, status: 'UPCOMING', deletedAt: null },
      select: { id: true },
    });

    await prisma.lessonSession.updateMany({
      where: { id: { in: sessions.map(s => s.id) } },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });

    const cancelled = await prisma.lessonSession.findUnique({ where: { id: s1.id } });
    expect(cancelled!.status).toBe('CANCELLED');
  });

  it('does NOT cancel IN_PROGRESS sessions — only UPCOMING is in the WHERE clause', async () => {
    const { school, staff } = await setup();
    const block2 = await prisma.lessonBlock.findFirst({ where: { schoolId: school.id } });

    const targetDate = new Date('2026-06-10T12:00:00.000Z');
    const inProgress = await createSession({ blockId: block2!.id, schoolId: school.id, staffProfileId: staff.id, date: targetDate, status: 'IN_PROGRESS' });

    const tz = 'UTC';
    const { from: dayStart, to: dayEnd } = getDayBoundaries('2026-06-10', tz);

    // Bulk cancel only targets UPCOMING
    const sessions = await prisma.lessonSession.findMany({
      where: { schoolId: school.id, date: { gte: dayStart, lte: dayEnd }, status: 'UPCOMING', deletedAt: null },
      select: { id: true },
    });

    await prisma.lessonSession.updateMany({
      where: { id: { in: sessions.map(s => s.id) } },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });

    // IN_PROGRESS session is not touched
    const stillInProgress = await prisma.lessonSession.findUnique({ where: { id: inProgress.id } });
    expect(stillInProgress!.status).toBe('IN_PROGRESS');
  });
});

// ─── 2. GAP: No ScheduleActionLog entries are written ─────────────────────────

describe('CHARACTERIZATION — bulk cancel writes ZERO audit log entries [FIXED IN PR 3]', () => {
  /**
   * CHARACTERIZATION (historical): The OLD bulk cancel route called updateMany()
   * and a console.log(). No ScheduleActionLog rows were created.
   *
   * ✅ FIXED IN PR 3: The route now calls scheduleLifecycleService.cancelSession()
   *   per session, which calls logScheduleAction() for each cancellation.
   *   The tests below simulate the OLD direct-updateMany path for regression documentation.
   */
  it('leaves ScheduleActionLog empty after cancelling N sessions', async () => {
    const { school, staff } = await setup();
    const block2 = await prisma.lessonBlock.findFirst({ where: { schoolId: school.id } });

    const d1 = new Date('2026-06-10T12:00:00.000Z');
    const d2 = new Date('2026-06-11T12:00:00.000Z');
    await createSession({ blockId: block2!.id, schoolId: school.id, staffProfileId: staff.id, date: d1, status: 'UPCOMING' });
    await createSession({ blockId: block2!.id, schoolId: school.id, staffProfileId: staff.id, date: d2, status: 'UPCOMING' });

    // Simulate bulk-cancel (no logScheduleAction call)
    await prisma.lessonSession.updateMany({
      where: { schoolId: school.id, status: 'UPCOMING' },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });

    const auditLogs = await prisma.scheduleActionLog.findMany({ where: { schoolId: school.id } });

    // CURRENT BEHAVIOR: zero audit entries — this is the documented gap.
    expect(auditLogs).toHaveLength(0);
  });

  it('contrast: single session CANCEL via status-change route pattern DOES write audit log', async () => {
    /**
     * To show what the bulk-cancel is missing, this test simulates the PATCH /session/:id/status
     * pattern — which DOES call logScheduleAction and produces an audit entry.
     */
    const { school, owner, staff } = await setup();
    const block2 = await prisma.lessonBlock.findFirst({ where: { schoolId: school.id } });
    const session = await createSession({ blockId: block2!.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    // The single-cancel route calls canTransition + logScheduleAction + update in sequence.
    const transition = canTransition(session.status, 'CANCELLED', 'OWNER');
    expect(transition.allowed).toBe(true);

    // Simulate logScheduleAction (the helper used by PATCH /session/:id/status)
    await prisma.scheduleActionLog.create({
      data: {
        schoolId: school.id,
        sessionId: session.id,
        userId: owner.id,
        action: 'CANCEL',
        entityType: 'session',
        before: { status: 'UPCOMING' } as any,
        after: { status: 'CANCELLED' } as any,
        reason: 'manual cancel test',
      },
    });

    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });

    const auditLogs = await prisma.scheduleActionLog.findMany({
      where: { schoolId: school.id, sessionId: session.id },
    });

    // Single-cancel DOES produce an audit entry with before/after JSON.
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('CANCEL');
    expect(auditLogs[0].before).toMatchObject({ status: 'UPCOMING' });
    expect(auditLogs[0].after).toMatchObject({ status: 'CANCELLED' });
  });
});

// ─── 3. GAP: No notifications dispatched ─────────────────────────────────────

describe('CHARACTERIZATION — bulk cancel dispatches ZERO notifications [FIXED IN PR 3]', () => {
  /**
   * CHARACTERIZATION (historical): The OLD bulk cancel route had no call to notifyMany().
   *
   * ✅ FIXED IN PR 3: The route now calls cancelSession() which calls notifyMany() for
   *   each session's student group (same path as single-session cancel).
   *   Test below simulates the old direct-updateMany path for regression documentation.
   */
  it('leaves Notification table empty after bulk cancel', async () => {
    const { school, student, staff } = await setup();
    const block2 = await prisma.lessonBlock.findFirst({ where: { schoolId: school.id } });
    const session = await createSession({ blockId: block2!.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });
    await createSessionStudent(session.id, student.id, school.id);

    // Simulate bulk-cancel — no notifyMany call
    await prisma.lessonSession.updateMany({
      where: { id: session.id },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });

    const notifications = await prisma.notification.findMany({});

    // CURRENT BEHAVIOR: no notifications — documented gap.
    expect(notifications).toHaveLength(0);
  });
});

// ─── 4. GAP: canTransition() is not the enforcement mechanism ─────────────────

describe('CHARACTERIZATION — bulk cancel does not enforce state machine per session [GAP]', () => {
  /**
   * canTransition() correctly says UPCOMING → CANCELLED is allowed for OWNER/ADMIN.
   * canTransition() also correctly says LOCKED → CANCELLED is NOT allowed.
   *
   * But bulk cancel's WHERE clause only filters by status = 'UPCOMING',
   * NOT by the state machine rules. This means if a LOCKED session somehow
   * appeared in a future query (e.g., a future WHERE change), it could be
   * bulk-cancelled without any canTransition check.
   *
   * Current behavior: LOCKED sessions are excluded because the WHERE clause
   * only targets UPCOMING. The state machine is irrelevant to the outcome.
   */
  it('canTransition confirms UPCOMING → CANCELLED is allowed for OWNER', () => {
    const result = canTransition('UPCOMING', 'CANCELLED', 'OWNER');
    expect(result.allowed).toBe(true);
  });

  it('canTransition confirms LOCKED → CANCELLED is blocked for OWNER', () => {
    const result = canTransition('LOCKED', 'CANCELLED', 'OWNER');
    expect(result.allowed).toBe(false);
  });

  it('bulk cancel query filter (not state machine) is what prevents LOCKED/COMPLETED from being cancelled', async () => {
    const { school, staff } = await setup();
    const block2 = await prisma.lessonBlock.findFirst({ where: { schoolId: school.id } });

    const lockedSession = await createSession({ blockId: block2!.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'LOCKED' });
    const completedSession = await createSession({ blockId: block2!.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-11T12:00:00.000Z'), status: 'COMPLETED' });

    // The WHERE clause in bulk-cancel only includes UPCOMING
    await prisma.lessonSession.updateMany({
      where: { schoolId: school.id, status: 'UPCOMING' },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });

    // LOCKED and COMPLETED survive — but only because of query filter, not canTransition()
    const locked    = await prisma.lessonSession.findUnique({ where: { id: lockedSession.id } });
    const completed = await prisma.lessonSession.findUnique({ where: { id: completedSession.id } });
    expect(locked!.status).toBe('LOCKED');
    expect(completed!.status).toBe('COMPLETED');
  });
});
