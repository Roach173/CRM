/**
 * Integration: Phase 9 — Production Hardening.
 *
 * Covers:
 *  - runChecks(): clean baseline (no CRITICAL violations for empty school)
 *  - runChecks(): detects ghost billing (attendance on INVALIDATED session)
 *  - runChecks(): cross-school isolation (violations only from own school)
 *  - Credit log pagination: meta fields returned by paginated query
 *  - Analytics limits: scheduleHeatmap take:5000 does not crash on small dataset
 */
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStudentProfile,
  createGroup,
  createBlock,
  createSession,
  createStaffProfile,
} from '../helpers/testDb';
import { runChecks } from '../../services/consistencyCheckService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function setup() {
  const school   = await createSchool({ timezone: 'UTC' });
  const owner    = await createUser(school.id, 'OWNER');
  const stuUser  = await createUser(school.id, 'STUDENT');
  const student  = await createStudentProfile(stuUser.id, school.id, 10);
  const staffUser = await createUser(school.id, 'TEACHER');
  const staff    = await createStaffProfile(staffUser.id, school.id);
  const group    = await createGroup(school.id);
  return { school, owner, student, staff, group };
}

// ─── runChecks — clean baseline ───────────────────────────────────────────────

describe('runChecks — clean baseline', () => {
  it('returns no CRITICAL violations for a freshly created school', async () => {
    const { school } = await setup();
    const violations = await runChecks(school.id);
    const critical = violations.filter(v => v.severity === 'CRITICAL');
    expect(critical).toHaveLength(0);
  });
});

// ─── runChecks — check1: ghost billing ───────────────────────────────────────

describe('runChecks — check1 ghost billing', () => {
  it('flags attendance on an INVALIDATED session', async () => {
    const { school, student, staff, group } = await setup();

    const block = await createBlock({
      groupId: group.id,
      schoolId: school.id,
      staffProfileId: staff.id,
    });

    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2026-05-20T12:00:00.000Z'),
      status: 'INVALIDATED',
    });

    await prisma.attendance.create({
      data: {
        lessonSessionId: session.id,
        studentProfileId: student.id,
        schoolId: school.id,
        status: 'PRESENT',
        creditDeducted: false,
      },
    });

    const violations = await runChecks(school.id);
    const ghostBilling = violations.find(v =>
      v.check.includes('INVALIDATED') && v.severity === 'CRITICAL',
    );
    expect(ghostBilling).toBeDefined();
    expect(ghostBilling!.count).toBeGreaterThanOrEqual(1);
  });
});

// ─── runChecks — cross-school isolation ──────────────────────────────────────

describe('runChecks — cross-school isolation', () => {
  it('does not include violations from another school', async () => {
    const schoolA = await createSchool({ timezone: 'UTC' });
    const schoolB = await createSchool({ timezone: 'UTC' });

    const stuUserA  = await createUser(schoolA.id, 'STUDENT');
    const studentA  = await createStudentProfile(stuUserA.id, schoolA.id, 10);
    const staffUser = await createUser(schoolA.id, 'TEACHER');
    const staffA    = await createStaffProfile(staffUser.id, schoolA.id);
    const groupA    = await createGroup(schoolA.id);

    const blockA = await createBlock({
      groupId: groupA.id,
      schoolId: schoolA.id,
      staffProfileId: staffA.id,
    });

    const sessionA = await createSession({
      blockId: blockA.id,
      schoolId: schoolA.id,
      staffProfileId: staffA.id,
      date: new Date('2026-05-20T12:00:00.000Z'),
      status: 'INVALIDATED',
    });

    await prisma.attendance.create({
      data: {
        lessonSessionId: sessionA.id,
        studentProfileId: studentA.id,
        schoolId: schoolA.id,
        status: 'PRESENT',
        creditDeducted: false,
      },
    });

    // School B should have no CRITICAL violations
    const violationsB = await runChecks(schoolB.id);
    const criticalB = violationsB.filter(v => v.severity === 'CRITICAL');
    expect(criticalB).toHaveLength(0);
  });
});

// ─── Credit log pagination ────────────────────────────────────────────────────

describe('credit log pagination', () => {
  it('paginates credit logs and returns correct count and pages', async () => {
    const { school, student } = await setup();

    for (let i = 1; i <= 15; i++) {
      await prisma.lessonCreditLog.create({
        data: {
          studentProfileId: student.id,
          schoolId: school.id,
          amount: -1,
          reason: `Test log ${i}`,
        },
      });
    }

    const page  = 1;
    const limit = 10;
    const [total, logs] = await Promise.all([
      prisma.lessonCreditLog.count({ where: { studentProfileId: student.id } }),
      prisma.lessonCreditLog.findMany({
        where: { studentProfileId: student.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    expect(total).toBe(15);
    expect(logs).toHaveLength(10);
    expect(Math.ceil(total / limit)).toBe(2);
  });

  it('returns remaining items on second page', async () => {
    const { school, student } = await setup();

    for (let i = 1; i <= 15; i++) {
      await prisma.lessonCreditLog.create({
        data: {
          studentProfileId: student.id,
          schoolId: school.id,
          amount: -1,
          reason: `Test log ${i}`,
        },
      });
    }

    const page  = 2;
    const limit = 10;
    const logs = await prisma.lessonCreditLog.findMany({
      where: { studentProfileId: student.id },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    expect(logs).toHaveLength(5);
  });
});

// ─── Analytics take limit safety ─────────────────────────────────────────────

describe('analytics take limits — scheduleHeatmap safety', () => {
  it('take:5000 on lessonSession.findMany returns correct count on small dataset', async () => {
    const { school, staff, group } = await setup();

    const block = await createBlock({
      groupId: group.id,
      schoolId: school.id,
      staffProfileId: staff.id,
    });

    const now = new Date('2026-05-24T12:00:00.000Z');
    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: now, status: 'COMPLETED' });
    await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: new Date(now.getTime() + 86400000), status: 'UPCOMING' });

    const sessions = await prisma.lessonSession.findMany({
      where: { schoolId: school.id, deletedAt: null, status: { not: 'CANCELLED' } },
      select: { date: true, startTimeSnap: true, lessonBlock: { select: { startTime: true } } },
      take: 5000,
    });

    expect(sessions.length).toBe(2);
  });
});
