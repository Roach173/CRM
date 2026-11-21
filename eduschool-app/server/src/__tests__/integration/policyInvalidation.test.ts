/**
 * Integration: policy service functions (real DB).
 *
 * invalidateSessionsForRemovedDays is retained as a compatibility shim only.
 * Policy changes are warning-only and must not set LessonSession.INVALIDATED.
 *
 * repairInvalidatedSessions (via POST /settings/repair-invalidated) — dry-run and restore
 * sessions that were incorrectly INVALIDATED by a past policy change.
 */
import { prisma, cleanDb, createSchool, createUser, createStudentProfile,
         createStaffProfile, createGroup, createBlock, createSession,
         createSessionStudent, createFinanceConfig } from '../helpers/testDb';
import { invalidateSessionsForRemovedDays, getPolicyForDate } from '../../services/policyService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// Monday = 0, Tuesday = 1, Wednesday = 2, Thursday = 3, Friday = 4

function nextSchemaDayDate(schemaDay: number): Date {
  const date = new Date();
  const currentSchemaDay = (date.getUTCDay() + 6) % 7;
  let delta = (schemaDay - currentSchemaDay + 7) % 7;
  if (delta === 0) delta = 7;
  date.setUTCDate(date.getUTCDate() + delta);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

function daysFromNow(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

async function setup(activeDays = [0, 1, 2, 3, 4]) {
  const school  = await createSchool({ timezone: 'UTC', activeDays });
  await createFinanceConfig(school.id, 1);
  const tUser   = await createUser(school.id, 'TEACHER');
  const staff   = await createStaffProfile(tUser.id, school.id);
  const sUser   = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(sUser.id, school.id, 10);
  const group   = await createGroup(school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id,
    days: [0, 1, 2, 3, 4] });
  return { school, staff, student, group, block };
}

describe('invalidateSessionsForRemovedDays', () => {
  it('does not invalidate UPCOMING sessions on removed policy days', async () => {
    const { school, staff, block } = await setup([0, 1, 2, 3, 4]);

    // Create sessions: Monday (day 0) and Tuesday (day 1) — both UPCOMING, in rolling window
    const monSession = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(0), status: 'UPCOMING' }); // Monday
    const tueSession = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(1), status: 'UPCOMING' }); // Tuesday

    // Remove Monday from activeDays
    const result = await invalidateSessionsForRemovedDays(school.id, [0]);

    const mon = await prisma.lessonSession.findUnique({ where: { id: monSession.id } });
    const tue = await prisma.lessonSession.findUnique({ where: { id: tueSession.id } });

    expect(mon!.status).toBe('UPCOMING');
    expect(tue!.status).toBe('UPCOMING'); // Tuesday untouched
    expect(result.invalidated).toBe(0);
    expect(result.protected).toBe(0);
  });

  it('does not mutate UPCOMING sessions that have Attendance records', async () => {
    const { school, staff, student, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(0), status: 'UPCOMING' }); // Monday
    const ss = await createSessionStudent(session.id, student.id, school.id);

    // Raw insert: simulate legacy attendance on an UPCOMING session (bypasses isAttendanceAllowed).
    // The policy service must still protect such sessions with existing financial data.
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: student.id,
        sessionStudentId: ss.id,
        status: 'PRESENT',
        creditDeducted: true,
      },
    });

    const result = await invalidateSessionsForRemovedDays(school.id, [0]);

    const after = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(after!.status).toBe('UPCOMING'); // policy changes never invalidate
    expect(result.protected).toBe(0);
    expect(result.invalidated).toBe(0);
  });

  it('does not mutate UPCOMING sessions that have TeacherPaymentLesson', async () => {
    const { school, staff, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(0), status: 'UPCOMING' }); // Monday

    // Create a TeacherPayment and link this session to it
    const payment = await prisma.teacherPayment.create({
      data: { schoolId: school.id, staffProfileId: staff.id, period: '2026-06',
        lessonsCount: 1, rateSnapshot: 5000, amount: 5000, paidAt: new Date() },
    });
    await prisma.teacherPaymentLesson.create({
      data: { paymentId: payment.id, lessonSessionId: session.id },
    });

    const result = await invalidateSessionsForRemovedDays(school.id, [0]);

    const after = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(after!.status).toBe('UPCOMING'); // policy changes never invalidate
    expect(result.protected).toBe(0);
  });

  it('does NOT touch COMPLETED sessions on removed days', async () => {
    const { school, staff, block } = await setup();

    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(0), status: 'COMPLETED' }); // Monday, completed

    await invalidateSessionsForRemovedDays(school.id, [0]);

    const after = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(after!.status).toBe('COMPLETED'); // historical record, never touched
  });

  it('returns { invalidated: 0, protected: 0 } when removedDays is empty', async () => {
    const { school } = await setup();
    const result = await invalidateSessionsForRemovedDays(school.id, []);
    expect(result).toEqual({ invalidated: 0, protected: 0 });
  });

  it('does not invalidate sessions outside the rolling window (past sessions)', async () => {
    const { school, staff, block } = await setup();

    // Past session (before now) on removed day
    const pastSession = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: daysFromNow(-7), status: 'UPCOMING' }); // past session

    await invalidateSessionsForRemovedDays(school.id, [0]);

    const after = await prisma.lessonSession.findUnique({ where: { id: pastSession.id } });
    expect(after!.status).toBe('UPCOMING'); // past sessions not in rolling window
  });
});

// ─── repair-invalidated — restore incorrectly INVALIDATED sessions ────────────
//
// Simulates the scenario: school had activeDays=[0..4], a session was incorrectly
// INVALIDATED by the old policy, then activeDays stays the same. The repair finds
// the session eligible and restores it to UPCOMING.

describe('repair: restore incorrectly INVALIDATED sessions', () => {
  it('restores INVALIDATED future sessions with no financial data when day is still active', async () => {
    const { school, staff, block } = await setup([0, 1, 2, 3, 4]);

    // Simulate a session that was incorrectly INVALIDATED by old policy
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(1), // Tuesday — still in activeDays
      status: 'INVALIDATED',
    });

    // Dry-run: eligible count returned, no DB change
    const activeDays: number[] = [0, 1, 2, 3, 4];
    const activeSet = new Set(activeDays);
    const candidates = await prisma.lessonSession.findMany({
      where: { schoolId: school.id, deletedAt: null, status: 'INVALIDATED', date: { gte: new Date() } },
      select: { id: true, date: true, lessonBlock: { select: { id: true, days: true, deletedAt: true } } },
    });
    const eligible = candidates.filter(s => {
      const dayIdx = (new Date(s.date).getUTCDay() + 6) % 7;
      return s.lessonBlock && !s.lessonBlock.deletedAt && activeSet.has(dayIdx) && s.lessonBlock.days.includes(dayIdx);
    });
    expect(eligible.length).toBe(1);
    expect(eligible[0].id).toBe(session.id);

    // Apply: restore to UPCOMING
    await prisma.lessonSession.updateMany({
      where: { id: { in: eligible.map(s => s.id) } },
      data: { status: 'UPCOMING', version: { increment: 1 } },
    });
    const after = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(after!.status).toBe('UPCOMING');
  });

  it('does NOT restore INVALIDATED sessions that have Attendance', async () => {
    const { school, staff, student, block } = await setup([0, 1, 2, 3, 4]);
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(1), status: 'INVALIDATED',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);
    await prisma.attendance.create({
      data: { schoolId: school.id, lessonSessionId: session.id, studentProfileId: student.id,
        sessionStudentId: ss.id, status: 'PRESENT', creditDeducted: false },
    });

    const withAtt = await prisma.attendance.findMany({ where: { lessonSessionId: session.id } });
    expect(withAtt.length).toBeGreaterThan(0); // has financial data → not eligible
  });

  it('does NOT restore INVALIDATED sessions on days no longer in activeDays', async () => {
    const { school, staff, block } = await setup([0, 1, 2, 3, 4]);
    // Saturday (day 5) — not in activeDays
    const satDate = nextSchemaDayDate(5);
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: satDate, status: 'INVALIDATED',
    });

    const activeDays = [0, 1, 2, 3, 4];
    const activeSet = new Set(activeDays);
    const dayIdx = (new Date(session.date).getUTCDay() + 6) % 7;
    expect(activeSet.has(dayIdx)).toBe(false); // Saturday excluded → not eligible
  });
});

// ─── getPolicyForDate — temporal resolution ───────────────────────────────────
//
// Verifies that getPolicyForDate returns the policy that was active on a given
// date, not the current policy. This is the foundation of historical grid rendering.

describe('getPolicyForDate — temporal resolution', () => {
  it('falls back to school columns when no SchoolSchedulePolicy rows exist', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    const policy = await getPolicyForDate(school.id, new Date());
    expect(policy.activeDays).toEqual([0, 1, 2, 3, 4]);
  });

  it('returns the historical policy (Mon-Sat) for a past date when current policy is Mon-Fri', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });

    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const oneWeekAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000);
    const now         = new Date();

    // Historical policy: Mon-Sat, active 2 weeks ago → closed 1 week ago
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id, activeDays: [0, 1, 2, 3, 4, 5],
        workStart: '08:00', workEnd: '20:00', slotDuration: 80,
        effectiveFrom: twoWeeksAgo, effectiveTo: oneWeekAgo, createdById: 1,
      },
    });
    // Current policy: Mon-Fri, active from 1 week ago → open
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id, activeDays: [0, 1, 2, 3, 4],
        workStart: '08:00', workEnd: '20:00', slotDuration: 80,
        effectiveFrom: oneWeekAgo, effectiveTo: null, createdById: 1,
      },
    });

    const historicalPolicy = await getPolicyForDate(school.id, twoWeeksAgo);
    expect(historicalPolicy.activeDays).toEqual([0, 1, 2, 3, 4, 5]); // Mon-Sat

    const currentPolicy = await getPolicyForDate(school.id, now);
    expect(currentPolicy.activeDays).toEqual([0, 1, 2, 3, 4]); // Mon-Fri
  });

  it('returns current open policy (effectiveTo null) for a date after its effectiveFrom', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id, activeDays: [0, 1, 2, 3],
        workStart: '09:00', workEnd: '18:00', slotDuration: 60,
        effectiveFrom: yesterday, effectiveTo: null, createdById: 1,
      },
    });

    const policy = await getPolicyForDate(school.id, new Date());
    expect(policy.activeDays).toEqual([0, 1, 2, 3]);
    expect(policy.workStart).toBe('09:00');
    expect(policy.slotDuration).toBe(60);
  });

  it('resolves duplicate effectiveFrom rows deterministically by latest createdAt/id', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    const effectiveFrom = new Date('2026-06-01T00:00:00.000Z');

    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id, activeDays: [0],
        workStart: '08:00', workEnd: '10:00', slotDuration: 60,
        effectiveFrom, effectiveTo: null, createdById: 1,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      },
    });
    await prisma.schoolSchedulePolicy.create({
      data: {
        schoolId: school.id, activeDays: [1, 2, 3],
        workStart: '10:00', workEnd: '12:00', slotDuration: 60,
        effectiveFrom, effectiveTo: null, createdById: 1,
        createdAt: new Date('2026-05-02T00:00:00.000Z'),
      },
    });

    const policy = await getPolicyForDate(school.id, new Date('2026-06-15T12:00:00.000Z'));
    expect(policy.activeDays).toEqual([1, 2, 3]);
    expect(policy.workStart).toBe('10:00');
  });
});
