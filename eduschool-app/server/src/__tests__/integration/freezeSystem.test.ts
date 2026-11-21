/**
 * Integration tests for Freeze System Phase 1.
 * Real database. Tests the full stack: freezeService + attendanceService.
 *
 * Coverage:
 *   - LESSON_SKIP: credit skipped (creditDeducted=false), admin's status preserved
 *   - PERIOD:      credit skipped, admin's status preserved
 *   - PERIOD open-ended: credit skipped, admin's status preserved
 *   - No active freeze: normal DEBIT deduction
 *   - PERIOD covers makeup session (BR-07)
 *   - cancelFreeze by Teacher → 403
 *   - Legacy PATCH /users/:id/freeze compatibility: creates StudentFreeze, isFrozen synced
 *   - PERIOD overlap guard: 409 on second overlapping create
 *   - LESSON_SKIP NOT_UPCOMING guard: 422 for non-UPCOMING session
 */

import {
  prisma, cleanDb,
  createSchool, createUser, createStudentProfile,
  createStaffProfile, createGroup, createBlock, createSession,
  createSessionStudent, createFinanceConfig, createMembership,
  createStudentFreeze,
} from '../helpers/testDb';
import { markAttendance } from '../../services/attendanceService';
import { createFreeze, cancelFreeze } from '../../services/freezeService';
import { applyFreeze, reverseFreeze } from '../../services/scheduleLifecycleService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school    = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  const config    = await createFinanceConfig(school.id, 1);
  const ownerUser = await createUser(school.id, 'OWNER');
  const teacher   = await createUser(school.id, 'TEACHER');
  const staff     = await createStaffProfile(teacher.id, school.id);
  const stuUser   = await createUser(school.id, 'STUDENT');
  const student   = await createStudentProfile(stuUser.id, school.id, 5);
  const group     = await createGroup(school.id);
  await createMembership(group.id, student.id, school.id);
  const block     = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  // Session stored at UTC noon for June 20 2026
  const session   = await createSession({
    blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
    date: new Date('2026-06-20T12:00:00.000Z'), status: 'IN_PROGRESS',
  });
  const ss        = await createSessionStudent(session.id, student.id, school.id);
  const actor     = { userId: ownerUser.id, role: 'OWNER' as const, schoolId: school.id };
  return { school, config, ownerUser, staff, teacher, stuUser, student, group, block, session, ss, actor };
}

// ─── LESSON_SKIP freeze → credit skipped, admin's status preserved ────────────

describe('LESSON_SKIP freeze → credit skipped, admin status preserved', () => {
  it('keeps the marked status (ABSENT) with creditDeducted=false', async () => {
    const { student, session, ss, school, actor } = await setup();

    await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'LESSON_SKIP', lessonSessionId: session.id,
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'ABSENT', sessionDate: session.date,
      }),
    );

    const att = await prisma.attendance.findFirst({ where: { lessonSessionId: session.id } });
    expect(att!.status).toBe('ABSENT');
    expect(att!.creditDeducted).toBe(false);

    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(after!.credits).toBe(5); // no deduction
  });

  it('creates FREEZE_SKIP ledger entry with amount=0', async () => {
    const { student, session, ss, school, actor } = await setup();

    await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'LESSON_SKIP', lessonSessionId: session.id,
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'PRESENT', sessionDate: session.date,
      }),
    );

    const log = await prisma.lessonCreditLog.findFirst({ where: { studentProfileId: student.id } });
    expect(log).not.toBeNull();
    expect(Number(log!.amount)).toBe(0);
    expect(log!.type).toBe('FREEZE_SKIP');
  });
});

// ─── PERIOD freeze → credit skipped, admin's status preserved ─────────────────

describe('PERIOD freeze → credit skipped, admin status preserved', () => {
  it('covers session within date range: status preserved (ABSENT), no deduction', async () => {
    const { student, session, ss, school, actor } = await setup();

    await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'PERIOD',
      startDate: new Date('2026-06-15T12:00:00.000Z'),
      endDate:   new Date('2026-06-25T12:00:00.000Z'),
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'ABSENT', sessionDate: session.date,
      }),
    );

    const att = await prisma.attendance.findFirst({ where: { lessonSessionId: session.id } });
    expect(att!.status).toBe('ABSENT');
    expect(att!.creditDeducted).toBe(false);
  });

  it('open-ended PERIOD (endDate=null) covers session: status preserved (PRESENT), no deduction', async () => {
    const { student, session, ss, school, actor } = await setup();

    await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'PERIOD',
      startDate: new Date('2026-06-01T12:00:00.000Z'),
      endDate:   null,
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'PRESENT', sessionDate: session.date,
      }),
    );

    const att = await prisma.attendance.findFirst({ where: { lessonSessionId: session.id } });
    expect(att!.status).toBe('PRESENT');
    expect(att!.creditDeducted).toBe(false);
  });

  it('session outside date range: normal DEBIT deduction', async () => {
    const { student, session, ss, school, actor } = await setup();

    await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'PERIOD',
      startDate: new Date('2026-07-01T12:00:00.000Z'),
      endDate:   new Date('2026-07-10T12:00:00.000Z'),
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: session.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: ss.id,
        status: 'PRESENT', sessionDate: session.date,
      }),
    );

    const att = await prisma.attendance.findFirst({ where: { lessonSessionId: session.id } });
    expect(att!.status).toBe('PRESENT');
    expect(att!.creditDeducted).toBe(true);
    const after = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(after!.credits).toBe(4);
  });
});

// ─── PERIOD covers makeup session (BR-07) ─────────────────────────────────────

describe('PERIOD freeze covers makeup session (BR-07)', () => {
  it('makeup session within period range: status preserved (PRESENT), no deduction', async () => {
    const { student, block, school, actor } = await setup();

    const makeupSession = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: (await prisma.lessonBlock.findFirst({ where: { id: block.id } }))!.teacherId!,
      date: new Date('2026-06-21T12:00:00.000Z'), status: 'IN_PROGRESS',
    });
    const makeupSs = await createSessionStudent(makeupSession.id, student.id, school.id);

    await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'PERIOD',
      startDate: new Date('2026-06-15T12:00:00.000Z'),
      endDate:   new Date('2026-06-25T12:00:00.000Z'),
    });

    await prisma.$transaction(tx =>
      markAttendance(tx, {
        sessionId: makeupSession.id, studentProfileId: student.id,
        schoolId: school.id, sessionStudentId: makeupSs.id,
        status: 'PRESENT', sessionDate: makeupSession.date,
      }),
    );

    const att = await prisma.attendance.findFirst({ where: { lessonSessionId: makeupSession.id } });
    expect(att!.status).toBe('PRESENT');
    expect(att!.creditDeducted).toBe(false);
  });
});

// ─── Legacy applyFreeze / reverseFreeze compatibility ─────────────────────────

describe('legacy applyFreeze / reverseFreeze', () => {
  it('applyFreeze creates StudentFreeze and syncs isFrozen=true', async () => {
    const { student, school, actor } = await setup();

    await applyFreeze({ studentProfileId: student.id, schoolId: school.id, actor, reason: 'Test freeze reason' });

    const freeze = await prisma.studentFreeze.findFirst({ where: { studentProfileId: student.id } });
    expect(freeze).not.toBeNull();
    expect(freeze!.type).toBe('PERIOD');
    expect(freeze!.status).toBe('ACTIVE');
    expect(freeze!.endDate).toBeNull();

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.isFrozen).toBe(true);
    expect(profile!.frozenAt).not.toBeNull();
  });

  it('reverseFreeze cancels all ACTIVE freezes and syncs isFrozen=false', async () => {
    const { student, school, actor } = await setup();

    await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'PERIOD', startDate: new Date(), endDate: null,
    });
    await prisma.studentProfile.update({ where: { id: student.id }, data: { isFrozen: true, frozenAt: new Date() } });

    await reverseFreeze({ studentProfileId: student.id, schoolId: school.id, actor, reason: 'Test unfreeze reason' });

    const activeFreezes = await prisma.studentFreeze.count({ where: { studentProfileId: student.id, status: 'ACTIVE' } });
    expect(activeFreezes).toBe(0);

    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.isFrozen).toBe(false);
    expect(profile!.frozenAt).toBeNull();
  });
});

// ─── cancelFreeze by Teacher → 403 ───────────────────────────────────────────

describe('cancelFreeze actor guards', () => {
  it('Teacher cannot cancel a freeze', async () => {
    const { student, session, school, teacher, actor } = await setup();
    const freeze = await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'LESSON_SKIP', lessonSessionId: session.id,
    });
    const teacherActor = { userId: teacher.id, role: 'TEACHER' as const, schoolId: school.id };

    await expect(
      cancelFreeze({ freezeId: freeze.id, schoolId: school.id, actor: teacherActor, reason: 'Test cancel reason' }),
    ).rejects.toMatchObject({ message: 'FREEZE_CANCEL_FORBIDDEN', httpStatus: 403 });
  });
});

// ─── PERIOD overlap guard ──────────────────────────────────────────────────────

describe('PERIOD overlap guard', () => {
  it('throws 409 FREEZE_PERIOD_OVERLAP for overlapping ranges', async () => {
    const { student, school, actor } = await setup();

    await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'PERIOD',
      startDate: new Date('2026-06-10T12:00:00.000Z'),
      endDate:   new Date('2026-06-25T12:00:00.000Z'),
    });

    await expect(
      createFreeze({
        studentProfileId: student.id, schoolId: school.id, actor,
        type: 'PERIOD',
        startDate: new Date('2026-06-20T12:00:00.000Z'),
        endDate:   new Date('2026-06-30T12:00:00.000Z'),
        reason: 'Test overlap reason',
      }),
    ).rejects.toMatchObject({ message: 'FREEZE_PERIOD_OVERLAP', httpStatus: 409 });
  });

  it('allows adjacent non-overlapping PERIOD freezes', async () => {
    const { student, school, actor } = await setup();

    await createStudentFreeze({
      schoolId: school.id, studentProfileId: student.id, createdById: actor.userId,
      type: 'PERIOD',
      startDate: new Date('2026-06-01T12:00:00.000Z'),
      endDate:   new Date('2026-06-10T12:00:00.000Z'),
    });

    // Adjacent period starting after endDate — should succeed (no sessions to hit deadline)
    await expect(
      createFreeze({
        studentProfileId: student.id, schoolId: school.id, actor,
        type: 'PERIOD',
        startDate: new Date('2026-07-01T12:00:00.000Z'),
        endDate:   new Date('2026-07-10T12:00:00.000Z'),
        skipDeadlineCheck: true,
        reason: 'Test adjacent period',
      }),
    ).resolves.toMatchObject({ type: 'PERIOD', status: 'ACTIVE' });
  });
});

// ─── LESSON_SKIP UPCOMING-only guard ──────────────────────────────────────────

describe('LESSON_SKIP session status guard', () => {
  it('throws 422 for COMPLETED session', async () => {
    const { student, block, school, actor, staff } = await setup();
    const completedSession = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-19T12:00:00.000Z'), status: 'COMPLETED',
    });

    await expect(
      createFreeze({
        studentProfileId: student.id, schoolId: school.id, actor,
        type: 'LESSON_SKIP', lessonSessionId: completedSession.id,
        reason: 'Test skip guard reason',
      }),
    ).rejects.toMatchObject({ message: 'FREEZE_SESSION_NOT_UPCOMING', httpStatus: 422 });
  });

  it('throws 422 for CANCELLED session', async () => {
    const { student, block, school, actor, staff } = await setup();
    const cancelledSession = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2026-06-19T12:00:00.000Z'), status: 'CANCELLED',
    });

    await expect(
      createFreeze({
        studentProfileId: student.id, schoolId: school.id, actor,
        type: 'LESSON_SKIP', lessonSessionId: cancelledSession.id,
        reason: 'Test skip guard reason',
      }),
    ).rejects.toMatchObject({ message: 'FREEZE_SESSION_NOT_UPCOMING', httpStatus: 422 });
  });
});
