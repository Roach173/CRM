/**
 * CHARACTERIZATION TESTS — Freeze as Billing-Only
 * PR 1: Schedule Lifecycle — document current behavior, NO production code changes.
 *
 * What freeze does currently:
 *   ✅ isFrozen + frozenAt on StudentProfile control whether credit is skipped
 *   ✅ Freeze window: frozenAt <= sessionDate - freezeWindowHours → skip deduction
 *   ✅ FREEZE_SKIP ledger entry with amount=0 is written (Phase 6)
 *   ✅ Frozen student after-deadline: deduction proceeds normally
 *
 * What freeze does NOT do (gaps — billing-only):
 *   ❌ No ScheduleActionLog entry for FREEZE_APPLIED or FREEZE_REVERSED
 *   ❌ No lifecycle event — freeze is a bare column update (PATCH /settings or similar)
 *   ❌ No history: only one frozenAt timestamp exists — if student was frozen/unfrozen
 *      multiple times, only the last frozenAt is stored
 *   ❌ No "freeze period" model — a freeze has no endDate
 *   ❌ No notification to student/parent that they were frozen
 *   ❌ Freeze does not affect session status — a frozen student's session stays UPCOMING
 *   ❌ No way to query "which sessions were skipped due to freeze" other than
 *      scanning LessonCreditLog for type='FREEZE_SKIP' entries
 *
 * TODO PR 6: Introduce a StudentFreeze model with startDate/endDate/reason.
 *   FREEZE_APPLIED and FREEZE_REVERSED become lifecycle events with ScheduleActionLog.
 */

import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
  createStaffProfile, createGroup, createBlock, createSession,
  createSessionStudent, createFinanceConfig,
} from '../helpers/testDb';
import { markAttendance } from '../../services/attendanceService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school  = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  await createFinanceConfig(school.id, 1); // freeze enforcement uses School.settings.pauseRules, not freezeWindowHours
  const owner   = await createUser(school.id, 'OWNER');
  const teacher = await createUser(school.id, 'TEACHER');
  const staff   = await createStaffProfile(teacher.id, school.id);
  const stuUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(stuUser.id, school.id, 10);
  const group   = await createGroup(school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, owner, staff, student, group, block };
}

// ─── 1. Freeze skips credit deduction (correct behavior) ─────────────────────

describe('CHARACTERIZATION — freeze correctly skips credit deduction', () => {
  it('frozen student within window: credit not deducted, FREEZE_SKIP log created', async () => {
    const { school, staff, student, block, owner } = await setup();

    const sessionDate = new Date(Date.now() + 48 * 3600 * 1000); // 48h from now
    sessionDate.setUTCHours(12, 0, 0, 0);
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: sessionDate, status: 'IN_PROGRESS' });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    // PR 5: StudentFreeze is source of truth. Create PERIOD freeze covering sessionDate.
    await prisma.studentFreeze.create({
      data: {
        schoolId: school.id, studentProfileId: student.id, createdById: owner.id,
        type: 'PERIOD', startDate: new Date(Date.now() - 1 * 3600_000), endDate: null, status: 'ACTIVE',
      },
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate })
    );

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(Number(after!.credits)).toBe(10); // unchanged — freeze skip

    const freezeLog = await prisma.lessonCreditLog.findFirst({ where: { sessionId: session.id } });
    expect(freezeLog!.type).toBe('FREEZE_SKIP');
    expect(Number(freezeLog!.amount)).toBe(0);
  });

  it('frozen student within window: credit is skipped regardless of freeze time direction', async () => {
    /**
     * CHARACTERIZATION: The freeze window (freezeWindowHours=24) is computed as
     * sessionDate - frozenAt > freezeWindowHours. If the student was frozen more than
     * 24h before the session date, credit is skipped.
     *
     * NOTE: setUTCHours(12,0,0,0) on a date snaps to UTC noon, which may add or
     * subtract hours depending on the time of day tests run (flaky if using
     * relative offsets that straddle noon). Fixed by using explicit UTC epoch offsets.
     *
     * frozenAt = now + 2h, sessionDate = now + 30h → diff = 28h > 24h → SKIP
     */
    const { school, staff, student, block, owner } = await setup();

    const now = Date.now();
    const sessionDate = new Date(now + 30 * 3600 * 1000);
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: sessionDate, status: 'IN_PROGRESS' });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    // PR 5: StudentFreeze is source of truth. Create PERIOD freeze starting 2h from now,
    // which covers sessionDate (30h from now). The freeze covers the session.
    await prisma.studentFreeze.create({
      data: {
        schoolId: school.id, studentProfileId: student.id, createdById: owner.id,
        type: 'PERIOD', startDate: new Date(now + 2 * 3600_000), endDate: null, status: 'ACTIVE',
      },
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate })
    );

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(Number(after!.credits)).toBe(10); // unchanged — freeze skip applies (diff > 24h)

    const freezeLog = await prisma.lessonCreditLog.findFirst({ where: { sessionId: session.id } });
    expect(freezeLog!.type).toBe('FREEZE_SKIP');
  });
});

// ─── 2. GAP: Freeze state has no history ─────────────────────────────────────

describe('CHARACTERIZATION — freeze is a single timestamp, no history [GAP]', () => {
  /**
   * CHARACTERIZATION: StudentProfile has isFrozen: Boolean and frozenAt: DateTime?
   * Only one freeze state is stored at a time. If a student is frozen, unfrozen,
   * and frozen again, only the latest frozenAt survives.
   *
   * TODO PR 6: Create StudentFreeze model with startDate, endDate?, reason, createdById.
   *   Allow queryable history: "show all freeze periods for student X".
   */
  it('isFrozen is a bare boolean with no start/end date pair', async () => {
    const { student } = await setup();

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile).not.toBeNull();

    // Only these two fields exist — no endDate, no history model
    expect(typeof profile!.isFrozen).toBe('boolean');
    // frozenAt can be null (no freeze) or a single timestamp
    expect(profile!.frozenAt === null || profile!.frozenAt instanceof Date).toBe(true);
  });

  it('second freeze overwrites frozenAt — previous freeze date is lost', async () => {
    const { student } = await setup();

    const freeze1 = new Date('2026-03-01T10:00:00.000Z');
    await prisma.studentProfile.update({ where: { id: student.id }, data: { isFrozen: true, frozenAt: freeze1 } });

    // Unfreeze
    await prisma.studentProfile.update({ where: { id: student.id }, data: { isFrozen: false, frozenAt: null } });

    // Second freeze
    const freeze2 = new Date('2026-04-15T10:00:00.000Z');
    await prisma.studentProfile.update({ where: { id: student.id }, data: { isFrozen: true, frozenAt: freeze2 } });

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.frozenAt!.toISOString()).toBe(freeze2.toISOString());
    // freeze1 date is permanently lost — no history table
  });
});

// ─── 3. GAP: No ScheduleActionLog for freeze/unfreeze ─────────────────────────

describe('CHARACTERIZATION — freeze/unfreeze has NO audit trail [GAP]', () => {
  /**
   * CHARACTERIZATION: Freezing a student is a bare StudentProfile update.
   * No ScheduleActionLog is written. No FREEZE_APPLIED event exists.
   * An auditor cannot determine when a student was frozen or who froze them.
   *
   * TODO PR 6: Write ScheduleActionLog{ entityType: 'student', action: 'FREEZE_APPLIED' }
   *   with before: { isFrozen: false }, after: { isFrozen: true, frozenAt: ... }.
   */
  it('freezing a student writes ZERO ScheduleActionLog entries', async () => {
    const { school, student } = await setup();

    // Simulate the freeze operation (bare update, as the settings route does)
    await prisma.studentProfile.update({
      where: { id: student.id },
      data: { isFrozen: true, frozenAt: new Date() },
    });

    const auditLogs = await prisma.scheduleActionLog.findMany({ where: { schoolId: school.id } });
    // CURRENT BEHAVIOR: no audit entries
    expect(auditLogs).toHaveLength(0);
  });

  it('FREEZE_SKIP in LessonCreditLog is the only trace of freeze in session history', async () => {
    /**
     * PR 5: StudentFreeze is source of truth. Freeze is now tracked in StudentFreeze table.
     * LessonCreditLog still records FREEZE_SKIP. Session status remains UPCOMING.
     * Direct DB insert of StudentFreeze (bypassing service) leaves no ScheduleActionLog entry.
     */
    const { school, staff, student, block, owner } = await setup();

    const sessionDate = new Date(Date.now() + 48 * 3600 * 1000);
    sessionDate.setUTCHours(12, 0, 0, 0);
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: sessionDate, status: 'IN_PROGRESS' });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    // Direct insert — bypasses service, no audit log written
    await prisma.studentFreeze.create({
      data: {
        schoolId: school.id, studentProfileId: student.id, createdById: owner.id,
        type: 'PERIOD', startDate: new Date(Date.now() - 1 * 3600_000), endDate: null, status: 'ACTIVE',
      },
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate })
    );

    // LessonCreditLog records FREEZE_SKIP
    const freezeLog = await prisma.lessonCreditLog.findFirst({
      where: { schoolId: school.id, type: 'FREEZE_SKIP' },
    });
    expect(freezeLog).not.toBeNull();

    // Session status is still IN_PROGRESS — freeze doesn't affect the session
    const sessionAfter = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(sessionAfter!.status).toBe('IN_PROGRESS');

    // Direct insert bypasses service: no ScheduleActionLog entry from this test
    const auditLogs = await prisma.scheduleActionLog.findMany({ where: { schoolId: school.id } });
    expect(auditLogs).toHaveLength(0);
  });
});

// ─── 4. GAP: No notification to student when frozen ───────────────────────────

describe('CHARACTERIZATION — freeze dispatches NO notification [GAP]', () => {
  /**
   * CHARACTERIZATION: The freeze operation is a direct StudentProfile update.
   * No notification is sent to the student or parent.
   *
   * TODO PR 6: FREEZE_APPLIED event should optionally notify the student:
   *   "Your account has been frozen from [date] to [date]. Lessons during this
   *    period will not consume credits."
   */
  it('Notification table is empty after freezing a student', async () => {
    const { school, student } = await setup();

    await prisma.studentProfile.update({
      where: { id: student.id },
      data: { isFrozen: true, frozenAt: new Date() },
    });

    const notifications = await prisma.notification.findMany({});
    expect(notifications).toHaveLength(0);
  });
});
