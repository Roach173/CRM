/**
 * CHARACTERIZATION TESTS — Delete / Archive After Financial Impact
 * PR 1: Schedule Lifecycle — document current behavior, NO production code changes.
 *
 * Problem: archiveLessonBlock() (called by DELETE /schedule/:id) correctly handles
 * most cases, but the following financial-risk scenario is not fully protected:
 *
 *   Future UPCOMING sessions that already have attendance/creditLogs are left
 *   as-is (not invalidated, not cancelled) when their block is archived.
 *   The block gets deletedAt set, but orphaned sessions remain in UPCOMING status
 *   with attached financial records — the session generator won't touch them (it
 *   skips non-UPCOMING+no-financial-data sessions), but the admin UI will still
 *   show them until they pass.
 *
 * What archiveLessonBlock DOES do correctly:
 *   ✅ Block gets deletedAt + status = CANCELLED
 *   ✅ Future UPCOMING sessions WITHOUT financial data get INVALIDATED
 *   ✅ Historical sessions (COMPLETED, CANCELLED) are untouched — data preserved
 *   ✅ ScheduleActionLog entry is written for the archive action
 *
 * What archiveLessonBlock does NOT do (current gaps):
 *   ❌ Future sessions WITH attendance/creditLogs are left in UPCOMING (not cancelled/invalidated)
 *   ❌ There is no credit refund for "future sessions with pre-submitted attendance"
 *      (edge case: admin submitted attendance in advance, then archived the block)
 *   ❌ No per-session audit log for the sessions that are left orphaned
 *
 * TODO PR 3: Decide whether future sessions with financial data should:
 *   Option A — stay as-is (current, document-only)
 *   Option B — move to CANCELLED with credit reversal
 */

import { archiveLessonBlock } from '../../services/blockArchiveService';
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
  await createFinanceConfig(school.id, 1);
  const owner   = await createUser(school.id, 'OWNER');
  const teacher = await createUser(school.id, 'TEACHER');
  const staff   = await createStaffProfile(teacher.id, school.id);
  const stuUser = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(stuUser.id, school.id, 10);
  const group   = await createGroup(school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, owner, staff, student, group, block };
}

// ─── 1. Block gets soft-deleted; historical sessions survive intact ────────────

describe('CHARACTERIZATION — archive block preserves completed session history', () => {
  it('sets block.deletedAt after archive and marks block CANCELLED', async () => {
    const { school, owner, staff, block } = await setup();

    await archiveLessonBlock({ blockId: block.id, schoolId: school.id, actorId: owner.id, role: 'OWNER', client: prisma });

    const archived = await prisma.lessonBlock.findUnique({ where: { id: block.id } });
    expect(archived!.deletedAt).not.toBeNull();
    expect(archived!.status).toBe('CANCELLED');
  });

  it('COMPLETED sessions with attendance remain in DB with their creditLogs intact', async () => {
    const { school, owner, staff, student, block } = await setup();

    const pastDate = new Date('2026-01-15T12:00:00.000Z');
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: pastDate, status: 'COMPLETED' });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate: session.date })
    );

    // Pre-archive: credit deducted
    const creditsBefore = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;
    expect(Number(creditsBefore)).toBe(9);

    await archiveLessonBlock({ blockId: block.id, schoolId: school.id, actorId: owner.id, role: 'OWNER', client: prisma });

    // Post-archive: historical session still exists
    const sessionAfter = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(sessionAfter).not.toBeNull();
    expect(sessionAfter!.status).toBe('COMPLETED');

    // Credit log still exists — financial history preserved
    const creditLog = await prisma.lessonCreditLog.findFirst({ where: { sessionId: session.id } });
    expect(creditLog).not.toBeNull();
    expect(Number(creditLog!.amount)).toBe(-1);

    // Credits unchanged — no reversal for past sessions
    const creditsAfter = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;
    expect(Number(creditsAfter)).toBe(9);
  });

  it('archive action writes a ScheduleActionLog entry for the block', async () => {
    const { school, owner, block } = await setup();

    await archiveLessonBlock({ blockId: block.id, schoolId: school.id, actorId: owner.id, role: 'OWNER', client: prisma });

    const auditLog = await prisma.scheduleActionLog.findFirst({
      where: { blockId: block.id, action: 'ARCHIVE_BLOCK' },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog!.before).toMatchObject({ deletedAt: null });
    expect((auditLog!.after as any)?.deletedAt).not.toBeNull();
  });
});

// ─── 2. Future sessions without financial data are invalidated (correct) ───────

describe('CHARACTERIZATION — archive invalidates clean future sessions', () => {
  it('UPCOMING future sessions with no attendance are set to INVALIDATED', async () => {
    const { school, owner, staff, block } = await setup();

    const futureDate = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    futureDate.setUTCHours(12, 0, 0, 0);
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: futureDate, status: 'UPCOMING' });

    await archiveLessonBlock({ blockId: block.id, schoolId: school.id, actorId: owner.id, role: 'OWNER', now: new Date(), client: prisma });

    const afterArchive = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(afterArchive!.status).toBe('INVALIDATED');
  });
});

// ─── 3. RISK: Future sessions WITH financial data are left as UPCOMING ──────────

describe('CHARACTERIZATION — archive leaves future sessions with financial data as-is [RISK]', () => {
  /**
   * CHARACTERIZATION: archiveLessonBlock's updateMany only targets sessions
   * where attendances.none(), creditLogs.none(), teacherPaymentLesson.is(null).
   * A session that already has attendance submitted remains in UPCOMING status
   * after the block is archived.
   *
   * Risk scenario: Admin submits attendance in advance (e.g., bulk import for
   * next week's sessions), then archives the block. The sessions stay UPCOMING
   * forever — no cron will clean them, and the admin dashboard will show them
   * as pending until their date passes.
   *
   * TODO PR 3: Decide the correct policy for this edge case (RFC §14).
   *   Current behavior is preserved here as the characterization baseline.
   */
  it('future UPCOMING session with attendance is NOT invalidated by archive', async () => {
    const { school, owner, staff, student, block } = await setup();

    // A future session that already has attendance submitted
    const futureDate = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    futureDate.setUTCHours(12, 0, 0, 0);
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: futureDate, status: 'IN_PROGRESS' });
    const ss = await createSessionStudent(session.id, student.id, school.id);

    // Pre-submit attendance (edge case: admin submitted in advance)
    await prisma.$transaction(tx =>
      markAttendance(tx, { sessionId: session.id, studentProfileId: student.id, schoolId: school.id, sessionStudentId: ss.id, status: 'PRESENT', sessionDate: session.date })
    );

    await archiveLessonBlock({ blockId: block.id, schoolId: school.id, actorId: owner.id, role: 'OWNER', now: new Date(), client: prisma });

    // CURRENT BEHAVIOR: session stays IN_PROGRESS with its financial data attached
    const afterArchive = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(afterArchive!.status).toBe('IN_PROGRESS'); // NOT invalidated — status unchanged by archive

    // Financial data is intact (credit was deducted, not reversed)
    const creditsBefore = (await prisma.studentProfile.findUnique({ where: { id: student.id } }))!.credits;
    expect(Number(creditsBefore)).toBe(9); // deducted and not returned
  });

  it('future UPCOMING session with creditLog (but no attendance) is NOT invalidated', async () => {
    const { school, owner, staff, student, block } = await setup();

    const futureDate = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    futureDate.setUTCHours(12, 0, 0, 0);
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: futureDate, status: 'UPCOMING' });

    // Plant a creditLog directly (simulating a manual credit adjustment tied to this session)
    await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id,
        studentProfileId: student.id,
        sessionId: session.id,
        amount: -1,
        type: 'DEBIT',
        reason: 'manual advance deduction',
      },
    });

    await archiveLessonBlock({ blockId: block.id, schoolId: school.id, actorId: owner.id, role: 'OWNER', now: new Date(), client: prisma });

    // CURRENT BEHAVIOR: session stays UPCOMING — archive skips it due to creditLog presence
    const afterArchive = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(afterArchive!.status).toBe('UPCOMING');
  });
});

// ─── 4. Sessions reference soft-deleted block — link is weakened but intact ────

describe('CHARACTERIZATION — session.lessonBlockId still points to archived block', () => {
  /**
   * CHARACTERIZATION: After block archive, sessions retain their lessonBlockId FK.
   * The FK reference is valid (Restrict constraint), but the block is soft-deleted.
   * Queries that filter by block.deletedAt = null will miss these sessions.
   * Queries that don't filter will see orphaned sessions referencing a deleted block.
   *
   * TODO PR 6+: Decide whether sessions need a "block_archived" flag or whether
   *   the soft-delete on the block is sufficient signal.
   */
  it('session.lessonBlockId still references the archived (deletedAt-set) block', async () => {
    const { school, owner, staff, block } = await setup();

    const pastDate = new Date('2026-01-15T12:00:00.000Z');
    const session = await createSession({ blockId: block.id, schoolId: school.id, staffProfileId: staff.id, date: pastDate, status: 'COMPLETED' });

    await archiveLessonBlock({ blockId: block.id, schoolId: school.id, actorId: owner.id, role: 'OWNER', client: prisma });

    const sessionAfter = await prisma.lessonSession.findUnique({
      where: { id: session.id },
      include: { lessonBlock: true },
    });
    expect(sessionAfter).not.toBeNull();
    // Session still points to the block
    expect(sessionAfter!.lessonBlockId).toBe(block.id);
    // The block is soft-deleted
    expect(sessionAfter!.lessonBlock.deletedAt).not.toBeNull();
  });
});
