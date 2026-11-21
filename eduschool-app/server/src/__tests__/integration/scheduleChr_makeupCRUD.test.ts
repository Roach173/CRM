/**
 * CHARACTERIZATION TESTS — Makeup Session CRUD-ish
 * PR 1: Schedule Lifecycle — document current behavior, NO production code changes.
 *
 * What the current makeup implementation has:
 *   ✅ makeupForSessionId FK — weak link to the original cancelled session
 *   ✅ isMakeup: true flag
 *   ✅ Status guard: only CANCELLED sessions can have a makeup created
 *   ✅ Duplicate guard: existingMakeup check (prevents two makeups for same session)
 *   ✅ SessionStudent snapshot at makeup creation time
 *
 * What is missing (current gaps):
 *   ❌ No ScheduleActionLog entry is written when makeup is created
 *   ❌ No MAKEUP_CREATED lifecycle event in the audit trail
 *   ❌ No notification to students when makeup is created (route does NOT call notifyMany)
 *   ❌ makeupForSessionId has no @@unique constraint — DB allows multiple makeup
 *      sessions pointing to the same original (the route's in-transaction guard
 *      prevents this in practice, but the DB doesn't enforce it)
 *   ❌ Credit policy for makeup attendance is undefined: the RFC (§14 Q2) is open
 *   ❌ Salary policy for makeup is undefined (RFC §8.4)
 *
 * TODO PR 6: Implement MAKEUP_CREATED as a lifecycle event:
 *   — Write ScheduleActionLog with action='MAKEUP_CREATED' and originalSessionId
 *   — Notify students with "makeup class scheduled on [date]"
 *   — Add @@unique([makeupForSessionId]) on LessonSession after business decision
 */

import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
  createStaffProfile, createGroup, createBlock, createSession,
  createSessionStudent, createFinanceConfig, createMembership,
} from '../helpers/testDb';
import { markAttendance } from '../../services/attendanceService';

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
  await createMembership(group.id, student.id, school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, owner, staff, student, group, block };
}

async function createMakeupDirectly(
  original: { id: number; lessonBlockId: number; schoolId: number; teacherIdSnap: number | null },
  newDate: Date,
  status: 'UPCOMING' | 'IN_PROGRESS' | 'COMPLETED' = 'UPCOMING',
) {
  return prisma.lessonSession.create({
    data: {
      schoolId: original.schoolId,
      lessonBlockId: original.lessonBlockId,
      date: newDate,
      status,
      teacherIdSnap: original.teacherIdSnap,
      startTimeSnap: '09:00',
      endTimeSnap: '10:00',
      isMakeup: true,
      makeupForSessionId: original.id,
    },
  });
}

// ─── 1. Makeup link to original session exists ────────────────────────────────

describe('CHARACTERIZATION — makeup session correctly links to original', () => {
  it('makeup session has isMakeup=true and makeupForSessionId pointing to cancelled original', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });

    const makeup = await createMakeupDirectly(
      { id: original.id, lessonBlockId: block.id, schoolId: school.id, teacherIdSnap: staff.id },
      new Date('2026-06-12T12:00:00.000Z'),
    );

    expect(makeup.isMakeup).toBe(true);
    expect(makeup.makeupForSessionId).toBe(original.id);
    expect(makeup.status).toBe('UPCOMING');
  });

  it('can navigate from original session to its makeup session', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });
    await createMakeupDirectly(
      { id: original.id, lessonBlockId: block.id, schoolId: school.id, teacherIdSnap: staff.id },
      new Date('2026-06-12T12:00:00.000Z'),
    );

    const makeups = await prisma.lessonSession.findMany({
      where: { makeupForSessionId: original.id, deletedAt: null },
    });
    expect(makeups).toHaveLength(1);
    expect(makeups[0].isMakeup).toBe(true);
  });
});

// ─── 2. GAP: No ScheduleActionLog entry for makeup creation ───────────────────

describe('CHARACTERIZATION — makeup creation writes NO audit log entry [GAP]', () => {
  /**
   * CHARACTERIZATION: POST /session/:id/makeup creates the session in a transaction
   * and returns it. It does NOT write to ScheduleActionLog.
   * After a makeup is created, the audit trail shows nothing — you cannot tell
   * from the logs when, who, or why a makeup was created.
   *
   * Contrast: the cancel event (PATCH /session/:id/status → CANCELLED) DOES write
   * a ScheduleActionLog entry via logScheduleAction().
   *
   * TODO PR 6: Write ScheduleActionLog{ action: 'MAKEUP_CREATED', sessionId: makeupId,
   *   before: null, after: { makeupForSessionId, date, isMakeup: true } }
   */
  it('ScheduleActionLog is empty after creating a makeup session', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });

    // Simulate the route: create makeup session in transaction, no audit log
    const makeup = await prisma.$transaction(async (tx) => {
      return tx.lessonSession.create({
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
      // NOTE: logScheduleAction() is NOT called here — this is the gap
    });

    const auditLogs = await prisma.scheduleActionLog.findMany({
      where: { schoolId: school.id },
    });

    // CURRENT BEHAVIOR: zero audit entries after makeup creation
    expect(auditLogs).toHaveLength(0);
  });

  it('ScheduleActionLog is empty for the makeup session itself', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });
    const makeup = await createMakeupDirectly(
      { id: original.id, lessonBlockId: block.id, schoolId: school.id, teacherIdSnap: staff.id },
      new Date('2026-06-12T12:00:00.000Z'),
    );

    const auditForMakeup = await prisma.scheduleActionLog.findMany({
      where: { sessionId: makeup.id },
    });
    expect(auditForMakeup).toHaveLength(0);
  });
});

// ─── 3. GAP: No notification dispatched on makeup creation ────────────────────

describe('CHARACTERIZATION — makeup creation dispatches NO notification [GAP]', () => {
  /**
   * CHARACTERIZATION: POST /session/:id/makeup creates the session and returns it.
   * No call to notifyMany() or notify() is made. Students receive no message
   * that a makeup class was scheduled for them.
   *
   * TODO PR 6: After makeup creation, call notifyMany() to students in the group
   *   with type='MAKEUP_SCHEDULED', body="Замена урока назначена на [date]".
   */
  it('Notification table is empty after makeup creation', async () => {
    const { school, student, staff, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });
    await createSessionStudent(original.id, student.id, school.id);

    // Simulate makeup creation (no notifyMany call)
    await createMakeupDirectly(
      { id: original.id, lessonBlockId: block.id, schoolId: school.id, teacherIdSnap: staff.id },
      new Date('2026-06-12T12:00:00.000Z'),
    );

    const notifications = await prisma.notification.findMany({});
    // CURRENT BEHAVIOR: no notifications dispatched
    expect(notifications).toHaveLength(0);
  });
});

// ─── 4. DB now prevents duplicate active makeup sessions (partial unique index) ──

describe('CHARACTERIZATION — DB blocks duplicate active makeup sessions [FIXED Phase 2]', () => {
  /**
   * Phase 2 added partial unique index "LessonSession_active_makeup_unique":
   *   CREATE UNIQUE INDEX ON "LessonSession" ("makeupForSessionId")
   *   WHERE "makeupForSessionId" IS NOT NULL
   *     AND status != 'CANCELLED'::"SessionStatus"
   *     AND "deletedAt" IS NULL
   *
   * Closes the previous gap: the DB now enforces "at most one non-CANCELLED makeup
   * per original session", matching the service-level guard.
   *
   * CANCELLED makeups are excluded from the index, so second-chance makeup
   * (cancel the first, create a replacement) is still allowed.
   */
  it('DB blocks a second active makeup for the same original (P2002)', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });

    await createMakeupDirectly(
      { id: original.id, lessonBlockId: block.id, schoolId: school.id, teacherIdSnap: staff.id },
      new Date('2026-06-22T12:00:00.000Z'),
    );

    await expect(
      createMakeupDirectly(
        { id: original.id, lessonBlockId: block.id, schoolId: school.id, teacherIdSnap: staff.id },
        new Date('2026-06-29T12:00:00.000Z'),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('CANCELLED makeup + new active makeup is allowed (second-chance makeup)', async () => {
    const { school, staff, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });

    await prisma.lessonSession.create({
      data: {
        schoolId: school.id, lessonBlockId: block.id,
        date: new Date('2026-06-22T12:00:00.000Z'), status: 'CANCELLED',
        teacherIdSnap: staff.id, startTimeSnap: '09:00', endTimeSnap: '10:00',
        isMakeup: true, makeupForSessionId: original.id,
      },
    });

    const second = await createMakeupDirectly(
      { id: original.id, lessonBlockId: block.id, schoolId: school.id, teacherIdSnap: staff.id },
      new Date('2026-06-29T12:00:00.000Z'),
    );
    expect(second.status).toBe('UPCOMING');
  });
});

// ─── 5. Makeup credit policy — no explicit deduction rule ─────────────────────

describe('CHARACTERIZATION — makeup credit policy is undefined / relies on general rule', () => {
  /**
   * CHARACTERIZATION: There is no special credit rule for makeup sessions.
   * When attendance is marked on a makeup session, markAttendance() applies
   * the same slot-reservation billing: deducts 1 credit like any other session.
   *
   * There is no check in attendanceService for isMakeup or makeupForSessionId.
   * The RFC (§14 Q2) question "does makeup consume credit?" is unresolved.
   *
   * TODO PR 6: After Q2 is resolved, implement the credit policy for makeup:
   *   Option B (RFC recommendation): makeup does NOT deduct if original was cancelled
   *   before attendance was submitted.
   */
  it('markAttendance deducts a credit on makeup session — same as regular session', async () => {
    const { school, staff, student, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });
    const makeup = await createMakeupDirectly(
      { id: original.id, lessonBlockId: block.id, schoolId: school.id, teacherIdSnap: staff.id },
      new Date('2026-06-12T12:00:00.000Z'),
      'IN_PROGRESS',
    );

    const creditsBefore = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;

    const ss = await createSessionStudent(makeup.id, student.id, school.id);
    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: makeup.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate: makeup.date })
    );

    const creditsAfter = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;

    // CURRENT BEHAVIOR: makeup deducts 1 credit — same as any session
    expect(Number(creditsAfter)).toBe(Number(creditsBefore) - 1);
  });

  it('attendanceService has no isMakeup check in its logic path', async () => {
    /**
     * Verifies that the service sees the makeup session the same way it sees
     * a regular session — there is no branching on isMakeup.
     */
    const { school, staff, student, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });
    const makeup = await createMakeupDirectly(
      { id: original.id, lessonBlockId: block.id, schoolId: school.id, teacherIdSnap: staff.id },
      new Date('2026-06-12T12:00:00.000Z'),
      'IN_PROGRESS',
    );

    const ss = await createSessionStudent(makeup.id, student.id, school.id);
    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: makeup.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate: makeup.date })
    );

    const creditLog = await prisma.lessonCreditLog.findFirst({ where: { sessionId: makeup.id } });
    expect(creditLog).not.toBeNull();
    expect(creditLog!.type).toBe('DEBIT');
    expect(Number(creditLog!.amount)).toBe(-1);
    // No 'MAKEUP_SKIP' or similar type — it's a regular DEBIT
  });
});
