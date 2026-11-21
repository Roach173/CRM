/**
 * Integration tests — Cancel Credit Guard (PR 2: Schedule Financial Integrity)
 *
 * Rule: a session with any Attendance.creditDeducted=true CANNOT be cancelled.
 * Error: 409 SESSION_HAS_DEDUCTED_CREDITS
 *
 * Tests go through cancelSession() (the lifecycle service), which is the same
 * path used by both PATCH /session/:id/status and POST /sessions/bulk-cancel.
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
  createSession,
  createSessionStudent,
  createFinanceConfig,
} from '../helpers/testDb';
import { cancelSession } from '../../services/scheduleLifecycleService';
import { Role } from '@prisma/client';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school   = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
  await createFinanceConfig(school.id, 1);
  const ownerUser  = await createUser(school.id, 'OWNER');
  const teachUser  = await createUser(school.id, 'TEACHER');
  const staff      = await createStaffProfile(teachUser.id, school.id);
  const stuUser    = await createUser(school.id, 'STUDENT');
  const student    = await createStudentProfile(stuUser.id, school.id, 10);
  const group      = await createGroup(school.id);
  const block      = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, ownerUser, staff, student, group, block };
}

const VALID_REASON = 'school holiday';

// ─── 1. No attendance → cancel allowed ───────────────────────────────────────

describe('cancel guard — UPCOMING session with no attendance', () => {
  it('cancels successfully when no attendance records exist', async () => {
    const { school, ownerUser, staff, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2030-06-10T12:00:00.000Z'), status: 'UPCOMING',
    });

    await expect(cancelSession({
      sessionId: session.id,
      schoolId:  school.id,
      actor: { userId: ownerUser.id, role: 'OWNER' as Role, schoolId: school.id },
      reason:    VALID_REASON,
    })).resolves.toMatchObject({ status: 'CANCELLED' });

    const updated = await prisma.lessonSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(updated.status).toBe('CANCELLED');
  });
});

// ─── 2. Attendance exists but creditDeducted=false → cancel allowed ───────────

describe('cancel guard — attendance with creditDeducted=false', () => {
  it('cancels successfully when attendance exists but no credits were deducted', async () => {
    const { school, ownerUser, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2030-06-10T12:00:00.000Z'), status: 'UPCOMING',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: student.id,
        sessionStudentId: ss.id,
        status: 'PRESENT',
        creditDeducted: false,
      },
    });

    await expect(cancelSession({
      sessionId: session.id,
      schoolId:  school.id,
      actor: { userId: ownerUser.id, role: 'OWNER' as Role, schoolId: school.id },
      reason:    VALID_REASON,
    })).resolves.toMatchObject({ status: 'CANCELLED' });
  });
});

// ─── 3. Attendance with creditDeducted=true → cancel blocked ─────────────────

describe('cancel guard — UPCOMING session with creditDeducted=true attendance', () => {
  it('throws 409 SESSION_HAS_DEDUCTED_CREDITS and leaves session UPCOMING', async () => {
    const { school, ownerUser, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2030-06-10T12:00:00.000Z'), status: 'UPCOMING',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);
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

    await expect(cancelSession({
      sessionId: session.id,
      schoolId:  school.id,
      actor: { userId: ownerUser.id, role: 'OWNER' as Role, schoolId: school.id },
      reason:    VALID_REASON,
    })).rejects.toMatchObject({
      message:    'SESSION_HAS_DEDUCTED_CREDITS',
      httpStatus: 409,
      details:    expect.objectContaining({ lifecycleError: true }),
    });

    const unchanged = await prisma.lessonSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(unchanged.status).toBe('UPCOMING');
  });
});

// ─── 4. IN_PROGRESS session with creditDeducted=true → cancel blocked ─────────

describe('cancel guard — IN_PROGRESS session with creditDeducted=true attendance', () => {
  it('throws 409 SESSION_HAS_DEDUCTED_CREDITS', async () => {
    const { school, ownerUser, staff, student, block } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2030-06-10T12:00:00.000Z'), status: 'IN_PROGRESS',
    });
    const ss = await createSessionStudent(session.id, student.id, school.id);
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

    await expect(cancelSession({
      sessionId: session.id,
      schoolId:  school.id,
      actor: { userId: ownerUser.id, role: 'OWNER' as Role, schoolId: school.id },
      reason:    VALID_REASON,
    })).rejects.toMatchObject({ message: 'SESSION_HAS_DEDUCTED_CREDITS', httpStatus: 409 });

    const unchanged = await prisma.lessonSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(unchanged.status).toBe('IN_PROGRESS');
  });
});

// ─── 5. Mixed attendance: one deducted, one not → cancel blocked ──────────────

describe('cancel guard — mixed attendance (one creditDeducted=true is enough to block)', () => {
  it('throws 409 when at least one attendance has creditDeducted=true', async () => {
    const { school, ownerUser, staff, student, block } = await setup();
    const stu2User    = await createUser(school.id, 'STUDENT');
    const student2    = await createStudentProfile(stu2User.id, school.id, 10);
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2030-06-10T12:00:00.000Z'), status: 'UPCOMING',
    });
    const ss1 = await createSessionStudent(session.id, student.id, school.id);
    const ss2 = await createSessionStudent(session.id, student2.id, school.id);

    await prisma.attendance.create({
      data: {
        schoolId: school.id, lessonSessionId: session.id,
        studentProfileId: student.id, sessionStudentId: ss1.id,
        status: 'PRESENT', creditDeducted: true,
      },
    });
    await prisma.attendance.create({
      data: {
        schoolId: school.id, lessonSessionId: session.id,
        studentProfileId: student2.id, sessionStudentId: ss2.id,
        status: 'ABSENT', creditDeducted: false,
      },
    });

    await expect(cancelSession({
      sessionId: session.id,
      schoolId:  school.id,
      actor: { userId: ownerUser.id, role: 'OWNER' as Role, schoolId: school.id },
      reason:    VALID_REASON,
    })).rejects.toMatchObject({ message: 'SESSION_HAS_DEDUCTED_CREDITS', httpStatus: 409 });
  });
});

// ─── 6. Bulk-cancel: one clean session + one blocked → partial success ────────

describe('cancel guard — bulk-cancel partial: one clean + one blocked', () => {
  it('cancels clean session and reports blocked session in errors', async () => {
    const { school, ownerUser, staff, student, block } = await setup();

    const cleanSession = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2030-06-10T12:00:00.000Z'), status: 'UPCOMING',
    });
    const blockedSession = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: new Date('2030-06-11T12:00:00.000Z'), status: 'UPCOMING',
    });
    const ss = await createSessionStudent(blockedSession.id, student.id, school.id);
    await prisma.attendance.create({
      data: {
        schoolId: school.id, lessonSessionId: blockedSession.id,
        studentProfileId: student.id, sessionStudentId: ss.id,
        status: 'PRESENT', creditDeducted: true,
      },
    });

    const actor = { userId: ownerUser.id, role: 'OWNER' as Role, schoolId: school.id };
    const sessions = [cleanSession, blockedSession];
    let cancelledCount = 0;
    const errors: { sessionId: number; error: string }[] = [];

    for (const sess of sessions) {
      try {
        await cancelSession({ sessionId: sess.id, schoolId: school.id, actor, reason: VALID_REASON });
        cancelledCount++;
      } catch (err: any) {
        errors.push({ sessionId: sess.id, error: err.message });
      }
    }

    expect(cancelledCount).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].sessionId).toBe(blockedSession.id);
    expect(errors[0].error).toBe('SESSION_HAS_DEDUCTED_CREDITS');

    const clean = await prisma.lessonSession.findUniqueOrThrow({ where: { id: cleanSession.id } });
    const blocked = await prisma.lessonSession.findUniqueOrThrow({ where: { id: blockedSession.id } });
    expect(clean.status).toBe('CANCELLED');
    expect(blocked.status).toBe('UPCOMING');
  });
});

// ─── 7. Bulk-cancel: all sessions blocked → 0 cancelled ──────────────────────

describe('cancel guard — bulk-cancel all blocked', () => {
  it('cancels 0 sessions when all have creditDeducted=true attendance', async () => {
    const { school, ownerUser, staff, student, block } = await setup();

    const sessions = await Promise.all([
      createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
        date: new Date('2030-06-10T12:00:00.000Z'), status: 'UPCOMING' }),
      createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
        date: new Date('2030-06-11T12:00:00.000Z'), status: 'UPCOMING' }),
    ]);

    for (const sess of sessions) {
      const ss = await createSessionStudent(sess.id, student.id, school.id);
      await prisma.attendance.create({
        data: {
          schoolId: school.id, lessonSessionId: sess.id,
          studentProfileId: student.id, sessionStudentId: ss.id,
          status: 'PRESENT', creditDeducted: true,
        },
      });
    }

    const actor = { userId: ownerUser.id, role: 'OWNER' as Role, schoolId: school.id };
    let cancelledCount = 0;
    const errors: { sessionId: number; error: string }[] = [];

    for (const sess of sessions) {
      try {
        await cancelSession({ sessionId: sess.id, schoolId: school.id, actor, reason: VALID_REASON });
        cancelledCount++;
      } catch (err: any) {
        errors.push({ sessionId: sess.id, error: err.message });
      }
    }

    expect(cancelledCount).toBe(0);
    expect(errors).toHaveLength(2);
    errors.forEach(e => expect(e.error).toBe('SESSION_HAS_DEDUCTED_CREDITS'));

    for (const sess of sessions) {
      const row = await prisma.lessonSession.findUniqueOrThrow({ where: { id: sess.id } });
      expect(row.status).toBe('UPCOMING');
    }
  });
});
