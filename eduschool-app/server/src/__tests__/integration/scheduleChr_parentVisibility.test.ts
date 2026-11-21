/**
 * CHARACTERIZATION TESTS — Parent Visibility: No Central Projection Policy
 * PR 1: Schedule Lifecycle — document current behavior, NO production code changes.
 *
 * Problem: There is no "parent/student portal projection layer" in the current system.
 * The student API routes return raw session data (including all internal states).
 * The student/parent must interpret fields like isMakeup, status, teacherId themselves.
 *
 * Specific gaps:
 *   1. INVALIDATED sessions are returned in raw queries unless the caller filters them.
 *      The student schedule API does NOT filter out INVALIDATED sessions.
 *   2. isMakeup=true sessions look identical to regular sessions in raw data —
 *      no explicit "makeup" label or linked-original info in the API response shape.
 *   3. There is no cancellationReason field — you cannot distinguish
 *      CANCELLED_BY_SCHOOL from CANCELLED_BY_POLICY from BULK_CANCEL.
 *   4. A substitute teacher (session.teacherId != null) is only visible via the
 *      admin WeekGrid's isSubstitute flag; there is no student-facing equivalent.
 *   5. No session_type distinction (REGULAR / MAKEUP / RESCHEDULED) in the schema.
 *
 * What the student API DOES correctly:
 *   ✅ Returns attendance status per student
 *   ✅ Returns session date
 *   ✅ Returns block level/chapter
 *
 * TODO PR 7: Introduce sessionProjectionService.ts with projectForStudent(session).
 *   Returns a sanitized, student-safe view:
 *     { status: 'CANCELLED' | 'MAKEUP_SCHEDULED' | ... , label, isMakeup, substituteTeacher?, ... }
 *   All student-facing API routes use this projection.
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
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  await createFinanceConfig(school.id, 1);
  const owner    = await createUser(school.id, 'OWNER');
  const t1User   = await createUser(school.id, 'TEACHER');
  const t2User   = await createUser(school.id, 'TEACHER');
  const staff1   = await createStaffProfile(t1User.id, school.id);
  const staff2   = await createStaffProfile(t2User.id, school.id);
  const stuUser  = await createUser(school.id, 'STUDENT');
  const student  = await createStudentProfile(stuUser.id, school.id, 10);
  const group    = await createGroup(school.id);
  await createMembership(group.id, student.id, school.id);
  const block    = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff1.id });
  return { school, owner, staff1, staff2, student, group, block };
}

// ─── 1. INVALIDATED sessions visible in raw queries [GAP] ────────────────────

describe('CHARACTERIZATION — INVALIDATED sessions visible in raw queries [GAP]', () => {
  /**
   * CHARACTERIZATION: There is no automatic filter on INVALIDATED sessions
   * in the student-facing query path. An INVALIDATED session is a data-integrity
   * state that should never be shown to students or parents.
   *
   * The raw Prisma query for student sessions does not exclude INVALIDATED.
   * A projection layer would add: where: { status: { not: 'INVALIDATED' } }.
   *
   * TODO PR 7: projectForStudent() must filter out INVALIDATED sessions entirely.
   */
  it('raw session query returns INVALIDATED sessions without any filter', async () => {
    const { school, staff1, student, block, group } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'INVALIDATED' });
    await createSessionStudent(session.id, student.id, school.id);

    // Simulate what the student schedule query does (no INVALIDATED filter)
    const sessions = await prisma.lessonSession.findMany({
      where: {
        schoolId: school.id,
        lessonBlock: { studentGroupId: group.id },
        deletedAt: null,
        // NOTE: no status: { not: 'INVALIDATED' } filter here — current behavior
      },
      select: { id: true, status: true, date: true },
    });

    const invalidatedInResult = sessions.filter(s => s.status === 'INVALIDATED');
    // CURRENT BEHAVIOR: INVALIDATED session is returned to student
    expect(invalidatedInResult).toHaveLength(1);
  });

  it('a projection-aware query filtering INVALIDATED would correctly hide it', async () => {
    const { school, staff1, student, block, group } = await setup();

    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'INVALIDATED' });
    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-12T12:00:00.000Z'), status: 'UPCOMING' });

    // This is what a projection layer SHOULD do
    const filteredSessions = await prisma.lessonSession.findMany({
      where: {
        schoolId: school.id,
        lessonBlock: { studentGroupId: group.id },
        deletedAt: null,
        status: { not: 'INVALIDATED' }, // projection filter
      },
      select: { id: true, status: true },
    });

    expect(filteredSessions).toHaveLength(1);
    expect(filteredSessions[0].status).toBe('UPCOMING');
  });
});

// ─── 2. isMakeup sessions look identical to regular sessions [GAP] ────────────

describe('CHARACTERIZATION — makeup sessions have no student-visible label [GAP]', () => {
  /**
   * CHARACTERIZATION: A makeup session has isMakeup=true in the DB.
   * But the raw session data returned to students has no explicit "Makeup class"
   * label or type field. The student must infer isMakeup from the boolean.
   *
   * Additionally, makeupForSessionId is present but the original session's date
   * is not included in the response — you cannot show "This is a makeup for [date]"
   * without a separate query.
   *
   * TODO PR 7: Projection layer should add:
   *   sessionType: 'REGULAR' | 'MAKEUP'
   *   makeupFor?: { date, originalStatus }
   */
  it('raw makeup session data includes isMakeup=true but no human-readable type', async () => {
    const { school, staff1, block } = await setup();

    const original = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });
    const makeup = await prisma.lessonSession.create({
      data: {
        schoolId: school.id,
        lessonBlockId: block.id,
        date: new Date('2026-06-12T12:00:00.000Z'),
        status: 'UPCOMING',
        teacherIdSnap: staff1.id,
        startTimeSnap: '09:00',
        endTimeSnap: '10:00',
        isMakeup: true,
        makeupForSessionId: original.id,
      },
    });

    // Raw data: no explicit type field, just a boolean
    expect(makeup.isMakeup).toBe(true);
    expect((makeup as any).sessionType).toBeUndefined(); // no type field in schema
    // Caller must know to interpret isMakeup=true as "Makeup class"
  });

  it('cancelled session and makeup session both have status=CANCELLED/UPCOMING — no sub-type', async () => {
    const { school, staff1, block } = await setup();

    const cancelled = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });
    // Raw status is just 'CANCELLED' — cannot distinguish CANCELLED_BY_SCHOOL
    // from CANCELLED_BY_POLICY from bulk-cancel without a cancellationReason field
    expect(cancelled.status).toBe('CANCELLED');
    expect((cancelled as any).cancellationReason).toBeUndefined(); // no field in schema yet
  });
});

// ─── 3. Substitute teacher not exposed to student in raw API shape [GAP] ──────

describe('CHARACTERIZATION — substitute teacher visible in admin WeekGrid only [GAP]', () => {
  /**
   * CHARACTERIZATION: The admin WeekGrid API adds isSubstitute=true when
   * session.teacherId != null. But the student-facing session query does not
   * compute or expose this flag.
   *
   * A student querying their schedule sees raw session data:
   *   - teacherIdSnap: original teacher's staffProfileId
   *   - teacherId: substitute's staffProfileId (or null)
   * They cannot easily determine who is actually teaching their class.
   *
   * TODO PR 7: Projection layer should compute:
   *   effectiveTeacher: { firstName, lastName } — resolves teacherId ?? teacherIdSnap
   *   isSubstitute: boolean
   */
  it('raw session has teacherId and teacherIdSnap but no isSubstitute field', async () => {
    const { school, staff1, staff2, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'UPCOMING' });

    // Replace teacher (simulate substitute assignment)
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { teacherId: staff2.id, isManualTeacher: true, version: { increment: 1 } },
    });

    const updated = await prisma.lessonSession.findUnique({ where: { id: session.id } });

    // Raw data: two teacher fields, no computed isSubstitute
    expect(updated!.teacherIdSnap).toBe(staff1.id); // original
    expect(updated!.teacherId).toBe(staff2.id);      // substitute
    expect((updated as any).isSubstitute).toBeUndefined(); // not a schema field
    // Student must compute: isSubstitute = teacherId !== null && teacherId !== teacherIdSnap
  });
});

// ─── 4. No session_type or sub-status distinguishes reasons for cancellation ──

describe('CHARACTERIZATION — cancellation reason is not stored [GAP]', () => {
  /**
   * CHARACTERIZATION: When a session is cancelled, status='CANCELLED' is the only
   * record. There is no cancellationReason field in the schema (yet).
   *
   * You cannot query "how many sessions were cancelled by school vs by policy
   * vs by bulk cancel" without parsing audit log details strings manually.
   *
   * TODO PR 3: Add cancellationReason enum to LessonSession:
   *   BY_SCHOOL | BY_POLICY | RESCHEDULED | BULK_CANCEL
   *   This enables parent-visible labels and reconciliation queries.
   */
  it('cancelled session schema has no cancellationReason field currently', async () => {
    const { school, staff1, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });

    // No cancellationReason — all cancellations look identical
    expect((session as any).cancellationReason).toBeUndefined();
  });

  it('two sessions cancelled by different reasons are indistinguishable by status alone', async () => {
    const { school, staff1, block } = await setup();

    const bySchool = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'CANCELLED' });
    const byPolicy = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-11T12:00:00.000Z'), status: 'CANCELLED' });

    // Both sessions have the same status — no way to distinguish reason
    expect(bySchool.status).toBe('CANCELLED');
    expect(byPolicy.status).toBe('CANCELLED');
    // From raw DB data, these are identical — reason is lost
  });
});

// ─── 5. Attendance fact is visible to student (correct) ───────────────────────

describe('CHARACTERIZATION — student can see their own attendance (correct)', () => {
  it('attendance record for a student is queryable by studentProfileId', async () => {
    const { school, staff1, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff1.id, date: new Date('2026-06-10T12:00:00.000Z'), status: 'COMPLETED' });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate: session.date })
    );

    const att = await prisma.attendance.findFirst({
      where: { lessonSessionId: session.id, studentProfileId: student.id },
    });

    expect(att).not.toBeNull();
    expect(att!.status).toBe('PRESENT');
  });
});
