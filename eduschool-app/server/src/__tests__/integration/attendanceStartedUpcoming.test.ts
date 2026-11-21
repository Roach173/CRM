/**
 * PR 1 — Attendance Lifecycle UX.
 *
 * An UPCOMING session becomes submittable once its actual start instant
 * (date + startTimeSnap, in school timezone) has passed — not merely once it's
 * "today". This closes the deadlock where a past-dated session stuck as UPCOMING
 * (cron miss, forgotten teacher) could never be closed without first manually
 * walking it through IN_PROGRESS.
 *
 * See sessionStateMachine.isAttendanceAllowed({ hasStarted }) and
 * attendanceFinalizationService.submitAttendanceAndFinalize.
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
import { submitAttendanceAndFinalize } from '../../services/attendanceFinalizationService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

/** UTC-noon sentinel `days` calendar days from today (0 = today), matching LessonSession.date storage. */
function noonUtc(daysFromToday: number): Date {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysFromToday,
    12, 0, 0,
  ));
}

async function setup() {
  const school  = await createSchool({ timezone: 'UTC' });
  await createFinanceConfig(school.id, 1);
  const teacher = await createUser(school.id, 'TEACHER');
  const staff   = await createStaffProfile(teacher.id, school.id);
  const stuUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(stuUser.id, school.id, 10);
  const group   = await createGroup(school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  const owner   = await createUser(school.id, 'OWNER');
  return { school, staff, student, block, owner };
}

describe('PR1 — future UPCOMING session (not yet started)', () => {
  it('rejects attendance, deducts no credit, leaves status unchanged', async () => {
    const { school, staff, student, block, owner } = await setup();
    // startTimeSnap defaults to '09:00' UTC — tomorrow 09:00 UTC is always in the future.
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: noonUtc(1), status: 'UPCOMING',
    });
    await createSessionStudent(session.id, student.id, school.id);
    const creditsBefore = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;

    await expect(submitAttendanceAndFinalize({
      sessionId: session.id, schoolId: school.id, actorId: owner.id,
      attendances: [{ studentProfileId: student.id, status: 'PRESENT' }],
      tz: 'UTC',
    })).rejects.toMatchObject({ httpStatus: 400, code: 'SESSION_NOT_SUBMITTABLE' });

    const creditsAfter = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;
    expect(Number(creditsAfter)).toBe(Number(creditsBefore));
    const attendance = await prisma.attendance.findFirst({ where: { lessonSessionId: session.id } });
    expect(attendance).toBeNull();
    const reloaded = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(reloaded!.status).toBe('UPCOMING');
  });
});

describe('PR1 — UPCOMING session whose start time has already passed', () => {
  it('auto-completes, saves attendance, deducts credit once, and audits the auto-complete', async () => {
    const { school, staff, student, block, owner } = await setup();
    // Yesterday 09:00 UTC is always in the past — proves the "stuck in the past" deadlock is fixed.
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: noonUtc(-1), status: 'UPCOMING',
    });
    await createSessionStudent(session.id, student.id, school.id);
    const creditsBefore = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;

    const result = await submitAttendanceAndFinalize({
      sessionId: session.id, schoolId: school.id, actorId: owner.id,
      attendances: [{ studentProfileId: student.id, status: 'PRESENT' }],
      tz: 'UTC',
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.attendanceFinalizedAt).not.toBeNull();

    const reloaded = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(reloaded!.status).toBe('COMPLETED');

    const attendance = await prisma.attendance.findFirst({ where: { lessonSessionId: session.id } });
    expect(attendance).not.toBeNull();
    expect(attendance!.status).toBe('PRESENT');
    expect(attendance!.creditDeducted).toBe(true);

    const creditsAfter = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;
    expect(Number(creditsAfter)).toBe(Number(creditsBefore) - 1);

    // Audit must show the auto-complete explicitly — no silent status mutation.
    const finalizeAudit = await prisma.attendanceAudit.findFirst({
      where: { lessonSessionId: session.id, action: 'FINALIZE' },
    });
    expect(finalizeAudit).not.toBeNull();
    expect(finalizeAudit!.reason).toMatch(/auto-completed/i);

    // Re-submitting must not double-deduct credit — the session is already finalized.
    await expect(submitAttendanceAndFinalize({
      sessionId: session.id, schoolId: school.id, actorId: owner.id,
      attendances: [{ studentProfileId: student.id, status: 'PRESENT' }],
      tz: 'UTC',
    })).rejects.toMatchObject({ httpStatus: 409, code: 'ATTENDANCE_FINALIZED' });

    const creditsAfterSecondSubmit = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;
    expect(Number(creditsAfterSecondSubmit)).toBe(Number(creditsBefore) - 1);
  });
});

describe('PR1 — terminal statuses stay blocked even when the lesson has clearly started', () => {
  it.each(['CANCELLED', 'INVALIDATED', 'LOCKED'] as const)('%s stays SESSION_NOT_SUBMITTABLE', async (status) => {
    const { school, staff, student, block, owner } = await setup();
    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: noonUtc(-1), status,
    });
    await createSessionStudent(session.id, student.id, school.id);

    await expect(submitAttendanceAndFinalize({
      sessionId: session.id, schoolId: school.id, actorId: owner.id,
      attendances: [{ studentProfileId: student.id, status: 'PRESENT' }],
      tz: 'UTC',
    })).rejects.toMatchObject({ httpStatus: 400, code: 'SESSION_NOT_SUBMITTABLE' });
  });
});
