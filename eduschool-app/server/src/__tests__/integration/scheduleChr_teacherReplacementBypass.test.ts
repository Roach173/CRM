/**
 * CHARACTERIZATION TESTS — Teacher Replacement Bypass
 * PR 1: Schedule Lifecycle — document pre-PR-3 behavior, NO production code changes.
 *
 * ✅ FIXED IN PR 3: PATCH /session/:id/teacher (assign path) now routes through
 *   scheduleLifecycleService.replaceTeacher() which adds:
 *   1. ✅ Editability guard — assertSessionEditable() enforces UPCOMING/IN_PROGRESS only.
 *      CANCELLED, LOCKED, COMPLETED sessions are rejected (httpStatus 422).
 *   2. ✅ Audit log now uses logScheduleAction() with before: { teacherId } / after: { teacherId }.
 *   3. ✅ Cross-tenant guard: substitute must belong to the same school.
 *   4. ✅ Salary safety: 409 if TeacherPaymentLesson already exists for the session.
 *
 * Still NOT fixed (deferred):
 *   ❌ Salary re-attribution after replacement on a completed session — TODO PR 5.
 *   ❌ Clear-teacher path still uses direct Prisma update (no lifecycle service).
 *
 * These tests simulate the OLD pre-PR-3 direct-Prisma behavior for regression docs.
 * Section 1: DB-level operations (still succeed at DB level — shows what isEditable() prevented).
 * Section 2: OLD audit log shape (direct create, no before/after) — historical documentation.
 * Section 3: Salary gap — NOT fixed by PR 3, still a TODO PR 5 item.
 */

import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
  createStaffProfile, createGroup, createBlock, createSession,
  createFinanceConfig,
} from '../helpers/testDb';
import { isEditable } from '../../lib/sessionStateMachine';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  await createFinanceConfig(school.id, 1);
  const owner    = await createUser(school.id, 'OWNER');
  const t1User   = await createUser(school.id, 'TEACHER');
  const t2User   = await createUser(school.id, 'TEACHER');
  const staff1   = await createStaffProfile(t1User.id, school.id);
  const staff2   = await createStaffProfile(t2User.id, school.id);
  const group    = await createGroup(school.id);
  const block    = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff1.id });
  return { school, owner, t1User, t2User, staff1, staff2, group, block };
}

// ─── 1. isEditable() policy vs route reality ─────────────────────────────────

describe('CHARACTERIZATION — isEditable() is NOT enforced by teacher replacement [FIXED IN PR 3]', () => {
  /**
   * The state machine says CANCELLED/LOCKED sessions are not editable.
   *
   * ✅ FIXED IN PR 3: The route's assign-teacher path now calls replaceTeacher()
   *   which calls assertSessionEditable(). CANCELLED/LOCKED/COMPLETED sessions
   *   are rejected with 422. The tests below verify DB-level behavior
   *   (direct Prisma updates still work) — they document what the OLD route allowed.
   */
  it('isEditable() returns false for CANCELLED — the state machine policy', () => {
    expect(isEditable('CANCELLED')).toBe(false);
  });

  it('isEditable() returns false for LOCKED — the state machine policy', () => {
    expect(isEditable('LOCKED')).toBe(false);
  });

  it('teacher can be changed on a CANCELLED session at DB level [historical — route now blocks via 422]', async () => {
    /**
     * CHARACTERIZATION (historical): The old route had no status check.
     * A CANCELLED session's teacher could be changed at the DB level.
     *
     * ✅ FIXED IN PR 3: replaceTeacher() calls assertSessionEditable() — returns 422.
     *   This test shows the DB still allows direct updates (no DB constraint),
     *   but the service layer now prevents it.
     */
    const { school, staff1, staff2, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });

    // The route would execute this update — no status guard blocks it
    const updated = await prisma.lessonSession.update({
      where: { id: session.id },
      data: { teacherId: staff2.id, isManualTeacher: true, version: { increment: 1 } },
    });

    // CURRENT BEHAVIOR: update succeeds on a CANCELLED session
    expect(updated.teacherId).toBe(staff2.id);
    expect(updated.status).toBe('CANCELLED'); // status unchanged
    expect(updated.isManualTeacher).toBe(true);
  });

  it('teacher can be changed on a LOCKED session at DB level [historical — route now blocks via 422]', async () => {
    /**
     * CHARACTERIZATION (historical): The old route didn't check for LOCKED status.
     *
     * ✅ FIXED IN PR 3: replaceTeacher() → assertSessionEditable() → 422 for LOCKED.
     *   After-lock correction via ManualLessonEntry is still TODO PR 5.
     */
    const { school, staff1, staff2, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'LOCKED' });

    // The route would execute this update — no LOCKED guard
    const updated = await prisma.lessonSession.update({
      where: { id: session.id },
      data: { teacherId: staff2.id, isManualTeacher: true, version: { increment: 1 } },
    });

    // CURRENT BEHAVIOR: update succeeds on a LOCKED session
    expect(updated.teacherId).toBe(staff2.id);
    expect(updated.status).toBe('LOCKED'); // still locked after teacher change
  });
});

// ─── 2. Audit log has no before/after JSON snapshot ───────────────────────────

describe('CHARACTERIZATION — teacher replacement audit log missing before/after [FIXED IN PR 3]', () => {
  /**
   * ✅ FIXED IN PR 3: The assign-teacher path now routes through replaceTeacher()
   *   which calls logScheduleAction() with:
   *     before: { teacherId: oldTeacherId }
   *     after:  { teacherId: newStaffProfileId, teacherName: 'First Last' }
   *
   * The tests below simulate the OLD direct-create pattern (what the pre-PR-3 route did)
   * to document what was missing and why the fix was needed.
   * The clear-teacher path still uses direct create — that is expected behavior.
   */
  it('teacher replacement writes a CHANGE_TEACHER audit log entry', async () => {
    const { school, owner, staff1, staff2, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    // Simulate what the route does — direct create, no logScheduleAction
    await prisma.scheduleActionLog.create({
      data: {
        schoolId: school.id,
        sessionId: session.id,
        userId: owner.id,
        action: 'CHANGE_TEACHER',
        details: `Учитель заменен на teacher2`,
        // NOTE: no before/after fields — this is the current route behavior
      },
    });

    const log = await prisma.scheduleActionLog.findFirst({
      where: { sessionId: session.id, action: 'CHANGE_TEACHER' },
    });
    expect(log).not.toBeNull();
    expect(log!.action).toBe('CHANGE_TEACHER');
  });

  it('teacher replacement audit log has NULL before and NULL after [GAP]', async () => {
    /**
     * CHARACTERIZATION: before/after fields are null because the route uses
     * the direct create pattern (not logScheduleAction).
     * This means audit consumers cannot reconstruct the state before the change.
     *
     * TODO PR 5: Use logScheduleAction() to include before/after JSON.
     */
    const { school, owner, staff1, staff2, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    await prisma.scheduleActionLog.create({
      data: {
        schoolId: school.id,
        sessionId: session.id,
        userId: owner.id,
        action: 'CHANGE_TEACHER',
        details: `Учитель заменен на teacher2`,
        // before and after are omitted — they default to null
      },
    });

    const log = await prisma.scheduleActionLog.findFirst({
      where: { sessionId: session.id, action: 'CHANGE_TEACHER' },
    });

    // CURRENT BEHAVIOR: no before/after JSON — this is the documented gap
    expect(log!.before).toBeNull();
    expect(log!.after).toBeNull();
  });

  it('contrast: status-change audit log DOES include before/after JSON', async () => {
    /**
     * PATCH /session/:id/status uses logScheduleAction() helper.
     * This test documents what a correctly-structured audit entry looks like.
     * Teacher replacement should adopt the same pattern in PR 5.
     */
    const { school, owner, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: (await prisma.staffProfile.findFirst({ where: { userId: owner.id } }))?.id ?? 1, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    // Simulate logScheduleAction (what PATCH /session/:id/status does)
    await prisma.scheduleActionLog.create({
      data: {
        schoolId: school.id,
        sessionId: session.id,
        userId: owner.id,
        action: 'CANCEL',
        entityType: 'session',
        before: { status: 'UPCOMING' } as any,
        after: { status: 'CANCELLED' } as any,
        reason: 'test cancel',
      },
    });

    const log = await prisma.scheduleActionLog.findFirst({
      where: { sessionId: session.id, action: 'CANCEL' },
    });

    // Correct pattern: before/after JSON is present
    expect(log!.before).toMatchObject({ status: 'UPCOMING' });
    expect(log!.after).toMatchObject({ status: 'CANCELLED' });
  });
});

// ─── 3. No salary re-attribution after teacher replacement ────────────────────

describe('CHARACTERIZATION — teacher replacement does NOT update salary attribution [GAP]', () => {
  /**
   * CHARACTERIZATION: When a session's teacher is replaced, the salary query
   * correctly picks up the new teacher via LessonSession.teacherId.
   * However, the ROUTE does not create a ManualLessonEntry to notify the
   * original teacher's salary calculation that a lesson was removed.
   *
   * For sessions in a past period that already have a TeacherPayment,
   * the TeacherPaymentLesson still points to the original teacher's payment.
   * The route does NOT check for or update existing TeacherPaymentLesson records.
   *
   * TODO PR 5: After teacher replacement on a completed session,
   *   if a TeacherPayment for the period exists:
   *   — create ManualLessonEntry REMOVE for original teacher
   *   — create ManualLessonEntry ADD for new teacher
   *   — log both entries as a correction with the session ID as reference
   */
  it('salary query after teacher replacement correctly counts the new teacher', async () => {
    const { school, staff1, staff2, block } = await setup();

    const sessionDate = new Date('2026-06-10T12:00:00.000Z');
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: sessionDate, status: 'COMPLETED' });

    // Replace teacher (setting teacherId = staff2.id on the session)
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { teacherId: staff2.id, isManualTeacher: true, version: { increment: 1 } },
    });

    // The salary query uses: teacherId = T OR (teacherIdSnap = T AND teacherId IS NULL)
    const staff2Count = await prisma.lessonSession.count({
      where: {
        status: { notIn: ['CANCELLED', 'INVALIDATED'] },
        date: { gte: new Date('2026-06-01'), lte: new Date('2026-06-30') },
        OR: [
          { teacherId: staff2.id },
          { teacherIdSnap: staff2.id, teacherId: null },
        ],
      },
    });
    const staff1Count = await prisma.lessonSession.count({
      where: {
        status: { notIn: ['CANCELLED', 'INVALIDATED'] },
        date: { gte: new Date('2026-06-01'), lte: new Date('2026-06-30') },
        OR: [
          { teacherId: staff1.id },
          { teacherIdSnap: staff1.id, teacherId: null },
        ],
      },
    });

    // After replacement: staff2 gets credit, staff1 loses it (correct in future queries)
    expect(staff2Count).toBe(1);
    expect(staff1Count).toBe(0); // teacherIdSnap is staff1 but teacherId overrides to staff2
  });

  it('existing TeacherPaymentLesson is NOT updated after teacher replacement [GAP]', async () => {
    /**
     * CHARACTERIZATION: If a TeacherPayment record was already created for staff1
     * for June, and then the session teacher is replaced to staff2, the
     * TeacherPaymentLesson record still links to staff1's payment.
     * The route has no code to detect or correct this stale link.
     *
     * TODO PR 5: Add a correction flow when replacement happens after payment creation.
     */
    const { school, owner, staff1, staff2, block } = await setup();

    const sessionDate = new Date('2026-06-10T12:00:00.000Z');
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: sessionDate, status: 'COMPLETED' });

    // Create a TeacherPayment for staff1 for June
    const payment = await prisma.teacherPayment.create({
      data: {
        schoolId: school.id,
        staffProfileId: staff1.id,
        period: '2026-06',
        lessonsCount: 1,
        rateSnapshot: 5000,
        amount: 5000,
        createdById: owner.id,
      },
    });

    // Link this session to that payment
    await prisma.teacherPaymentLesson.create({
      data: { paymentId: payment.id, lessonSessionId: session.id },
    });

    // Now replace the teacher — the route does NOT update TeacherPaymentLesson
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { teacherId: staff2.id, isManualTeacher: true, version: { increment: 1 } },
    });

    // CURRENT BEHAVIOR: TeacherPaymentLesson still points to staff1's payment
    const paymentLink = await prisma.teacherPaymentLesson.findFirst({
      where: { lessonSessionId: session.id },
    });
    expect(paymentLink).not.toBeNull();
    expect(paymentLink!.paymentId).toBe(payment.id); // still linked to staff1's payment

    // But the session now says staff2 is the teacher — inconsistency
    const updatedSession = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(updatedSession!.teacherId).toBe(staff2.id); // session says staff2

    // The salary payment still shows staff1 — the documented inconsistency
    const staff1Payment = await prisma.teacherPayment.findUnique({ where: { id: payment.id } });
    expect(staff1Payment!.staffProfileId).toBe(staff1.id);
  });
});
