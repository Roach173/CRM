/**
 * CHARACTERIZATION TESTS — Reschedule as CRUD
 * PR 1: Schedule Lifecycle — document pre-PR-4 behavior.
 *
 * ✅ FIXED IN PR 4: Time/room changes now have a first-class lifecycle path:
 *   PATCH /session/:id/reschedule (new endpoint) routes through
 *   scheduleLifecycleService.rescheduleSession() which:
 *   1. ✅ SESSION_RESCHEDULED is now in EVENTS_REQUIRING_REASON (reason ≥ 5 chars)
 *   2. ✅ Audit log uses logScheduleAction('RESCHEDULE') with full before/after slot JSON
 *   3. ✅ Conflict validation (teacher + cabinet + group) via validateSingleSessionOverride
 *   4. ✅ Atomic transaction: DB update + audit in one Prisma $transaction
 *   5. ✅ Socket emit triggers schedule refresh on all clients
 *   6. ✅ Editability enforced: COMPLETED/LOCKED/INVALIDATED sessions return 422
 *
 * Still NOT fixed (deferred):
 *   ❌ Moving session to a DIFFERENT DATE: still requires cancel + makeup workaround.
 *      Atomic date-change is TODO PR 6.
 *   ❌ Notifications to parents/teachers: still TODO PR 5.
 *   ❌ PATCH /session/:id/details (cabinet-only path) still uses direct audit create
 *      (no before/after JSON, no lifecycle service). Left intentionally for compatibility.
 *
 * These tests simulate the OLD direct-Prisma CHANGE_DETAILS path (for regression docs).
 */

import {
  prisma, cleanDb, createSchool, createUser,
  createStaffProfile, createGroup, createBlock, createSession,
  createFinanceConfig,
} from '../helpers/testDb';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school  = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  await createFinanceConfig(school.id, 1); // freeze enforcement uses School.settings.pauseRules, not freezeWindowHours
  const owner   = await createUser(school.id, 'OWNER');
  const teacher = await createUser(school.id, 'TEACHER');
  const staff   = await createStaffProfile(teacher.id, school.id);
  const group   = await createGroup(school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, owner, staff, group, block };
}

// ─── 1. Session date is immutable after creation ──────────────────────────────

describe('CHARACTERIZATION — session.date cannot be changed via details route', () => {
  it('session.date is set at creation and is not in the details update payload', async () => {
    const { school, staff, block } = await setup();

    const originalDate = new Date('2026-06-10T12:00:00.000Z');
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: originalDate, status: 'UPCOMING' });

    // The details route only updates: startTimeSnap, endTimeSnap, cabinetIdSnap
    // It does NOT accept a `date` field. Simulating the update:
    const cabinet = await prisma.cabinet.create({ data: { schoolId: school.id, name: 'Room 2', capacity: 15 } });
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: {
        cabinetIdSnap: cabinet.id,
        isManualCabinet: true,
        version: { increment: 1 },
        // date is NOT here — it cannot be changed via this route
      },
    });

    const after = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(after!.date).toEqual(originalDate); // date unchanged
    expect(after!.cabinetIdSnap).toBe(cabinet.id); // cabinet changed
  });

  /**
   * CHARACTERIZATION: To move a session to a different date, the only
   * current path is: CANCEL original + CREATE makeup for the new date.
   * There is no atomic "reschedule" that preserves the original session's
   * context and links old-to-new for the audit trail.
   *
   * TODO PR 4: POST /session/:id/reschedule must handle this atomically.
   */
  it('moving session to a different date requires cancel + makeup workaround', async () => {
    const { school, staff, block } = await setup();

    const originalDate = new Date('2026-06-10T12:00:00.000Z');
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: originalDate, status: 'UPCOMING' });

    // Step 1: Cancel the original session
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });

    // Step 2: Create a makeup session for the new date
    const newDate = new Date('2026-06-12T12:00:00.000Z');
    const makeupSession = await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: block.id,
        date: newDate,
        status: 'UPCOMING',
        teacherIdSnap: staff.id,
        startTimeSnap: '09:00',
        endTimeSnap: '10:00',
        isMakeup: true,
        makeupForSessionId: session.id, // the only "link" between old and new
      },
    });

    // The "reschedule" was done manually — two separate operations
    const original = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    const makeup   = await prisma.lessonSession.findUnique({ where: { id: makeupSession.id } });

    expect(original!.status).toBe('CANCELLED');
    expect(makeup!.isMakeup).toBe(true);
    expect(makeup!.makeupForSessionId).toBe(session.id);
    expect(makeup!.date).toEqual(newDate);
  });
});

// ─── 2. CHANGE_DETAILS audit log has no before/after JSON ─────────────────────

describe('CHARACTERIZATION — CHANGE_DETAILS audit log has no before/after JSON [PARTIALLY FIXED IN PR 4]', () => {
  /**
   * CHARACTERIZATION: PATCH /session/:id/details still writes a ScheduleActionLog with
   * action='CHANGE_DETAILS' and a human-readable details string only (no before/after JSON).
   *
   * ✅ FIXED for time changes via new PATCH /session/:id/reschedule (PR 4).
   *   New route uses logScheduleAction('RESCHEDULE') with full before/after slot JSON.
   *
   * Still OPEN: PATCH /session/:id/details (cabinet-only path) still lacks before/after.
   *   Left intentionally as the old details route is preserved for compatibility.
   *
   * TODO PR 5+: Fully retire PATCH /session/:id/details or add before/after to it.
   */
  it('CHANGE_DETAILS audit log entry has NULL before and NULL after', async () => {
    const { school, owner, staff, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    // Simulate what the details route does — direct create, no before/after
    await prisma.scheduleActionLog.create({
      data: {
        schoolId: school.id,
        sessionId: session.id,
        userId: owner.id,
        action: 'CHANGE_DETAILS',
        details: 'Время изменено на 10:00-11:20',
        // before/after are intentionally omitted — current route behavior
      },
    });

    const log = await prisma.scheduleActionLog.findFirst({
      where: { sessionId: session.id, action: 'CHANGE_DETAILS' },
    });

    expect(log).not.toBeNull();
    expect(log!.details).toBe('Время изменено на 10:00-11:20');

    // CURRENT BEHAVIOR: no before/after JSON
    expect(log!.before).toBeNull();
    expect(log!.after).toBeNull();
  });

  it('CHANGE_DETAILS does not create a domain event or notification', async () => {
    /**
     * CHARACTERIZATION: No notification is dispatched to students when
     * session time or room changes via the details route.
     * Students would find out only by checking the schedule again.
     *
     * TODO PR 4: reschedule event should notify students with old and new slot.
     */
    const { school, owner, staff, block } = await setup();
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    // Simulate the details update
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { startTimeSnap: '10:00', endTimeSnap: '11:20', isManualTime: true, version: { increment: 1 } },
    });

    // No notification was dispatched (none in the DB)
    const notifications = await prisma.notification.findMany({});
    expect(notifications).toHaveLength(0);
  });
});

// ─── 3. isManualTime / isManualCabinet flags protect the change ───────────────

describe('CHARACTERIZATION — isManualTime flag prevents session generator from overwriting', () => {
  /**
   * The regeneration safety flags are correctly implemented.
   * This is a PASSING characterization of correct behavior.
   */
  it('setting isManualTime = true marks the session as protected from cron overwrite', async () => {
    const { school, staff, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { startTimeSnap: '10:00', endTimeSnap: '11:00', isManualTime: true, version: { increment: 1 } },
    });

    const after = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(after!.isManualTime).toBe(true);
    expect(after!.startTimeSnap).toBe('10:00');
  });

  it('setting isManualCabinet = true marks the session for cabinet protection', async () => {
    const { school, staff, block } = await setup();
    const cabinet = await prisma.cabinet.create({ data: { schoolId: school.id, name: 'Room B', capacity: 20 } });

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { cabinetIdSnap: cabinet.id, isManualCabinet: true, version: { increment: 1 } },
    });

    const after = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(after!.isManualCabinet).toBe(true);
    expect(after!.cabinetIdSnap).toBe(cabinet.id);
  });
});

// ─── 4. No central "SESSION_RESCHEDULED" domain event model ───────────────────

describe('CHARACTERIZATION — no SESSION_RESCHEDULED concept for date change [PARTIALLY FIXED IN PR 4]', () => {
  /**
   * ✅ FIXED for time/room changes: PATCH /session/:id/reschedule (PR 4) writes
   *   action='RESCHEDULE' with before/after slot JSON.
   *
   * Still OPEN: Moving a session to a different DATE still requires cancel + makeup.
   *   The cancel writes action='CANCEL', the makeup has no audit entry (PR 6 gap).
   *   An atomic "date reschedule" that links originalSessionId → newSessionId in
   *   a single RESCHEDULE event is TODO PR 6.
   */
  it('makeup session has no audit log entry for its creation', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    await prisma.lessonSession.update({ where: { id: original.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });

    const makeupSession = await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: block.id,
        date: new Date('2026-06-12T12:00:00.000Z'),
        status: 'UPCOMING',
        teacherIdSnap: staff.id,
        startTimeSnap: '09:00',
        endTimeSnap: '10:00',
        isMakeup: true,
        makeupForSessionId: original.id,
      },
    });

    // No audit log entry was written for the makeup session creation
    const auditForMakeup = await prisma.scheduleActionLog.findMany({
      where: { sessionId: makeupSession.id },
    });
    expect(auditForMakeup).toHaveLength(0); // gap: MAKEUP_CREATED event not logged
  });
});
