/**
 * Integration: Immutable Audit Trail (Phase 5).
 *
 * Verifies:
 * - Soft-deleting a LessonBlock (deletedAt) preserves ScheduleActionLog rows
 * - ScheduleActionLog.blockId is set to NULL when block is hard-deleted
 *   (onDelete: SetNull instead of Cascade)
 * - ScheduleActionLog.sessionId is set to NULL when session is soft-deleted
 * - Audit log rows survive entity deletion with action/reason/createdAt intact
 */
import {
  prisma, cleanDb, createSchool, createUser, createStaffProfile,
  createGroup, createBlock, createSession,
} from '../helpers/testDb';

// Guard: assert FK constraints are SET NULL before any test runs.
// confdeltype = 'n' means ON DELETE SET NULL in pg_constraint.
// If this fails, the migration 20260611000000_force_audit_log_fk_set_null
// was not applied — the test would otherwise produce a misleading failure.
beforeAll(async () => {
  const rows = await prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
    SELECT conname, confdeltype
    FROM pg_constraint
    WHERE conname IN (
      'ScheduleActionLog_blockId_fkey',
      'ScheduleActionLog_sessionId_fkey'
    )
  `;

  const map = new Map(rows.map(r => [r.conname, r.confdeltype]));

  const blockType   = map.get('ScheduleActionLog_blockId_fkey')   ?? 'MISSING';
  const sessionType = map.get('ScheduleActionLog_sessionId_fkey') ?? 'MISSING';

  if (blockType !== 'n' || sessionType !== 'n') {
    throw new Error(
      `[auditTrailPreservation] ScheduleActionLog FK constraints are not SET NULL.\n` +
      `  ScheduleActionLog_blockId_fkey   confdeltype = '${blockType}' (expected 'n')\n` +
      `  ScheduleActionLog_sessionId_fkey confdeltype = '${sessionType}' (expected 'n')\n` +
      `  Run: npx prisma migrate deploy\n` +
      `  Migration required: 20260611000000_force_audit_log_fk_set_null`,
    );
  }
});

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

async function setup() {
  const school  = await createSchool();
  const tUser   = await createUser(school.id, 'OWNER');
  const staff   = await createStaffProfile(tUser.id, school.id);
  const group   = await createGroup(school.id);
  const block   = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
  return { school, tUser, staff, group, block };
}

describe('ScheduleActionLog — audit trail preservation', () => {
  it('audit log survives soft-delete of its LessonBlock', async () => {
    const { school, tUser, block } = await setup();

    const log = await prisma.scheduleActionLog.create({
      data: {
        schoolId: school.id,
        blockId: block.id,
        userId: tUser.id,
        action: 'UPDATE_BLOCK',
        reason: 'test audit entry',
      },
    });

    // Soft-delete the block
    await prisma.lessonBlock.update({
      where: { id: block.id },
      data: { deletedAt: new Date() },
    });

    const found = await prisma.scheduleActionLog.findUnique({ where: { id: log.id } });
    expect(found).not.toBeNull();
    expect(found!.action).toBe('UPDATE_BLOCK');
    expect(found!.reason).toBe('test audit entry');
    expect(found!.userId).toBe(tUser.id);
    // blockId reference still present after soft-delete (soft-delete doesn't trigger FK cascade)
    expect(found!.blockId).toBe(block.id);
  });

  it('audit log survives hard-delete of its LessonBlock (blockId becomes NULL)', async () => {
    const { school, tUser, block } = await setup();

    // Create audit log entry
    const log = await prisma.scheduleActionLog.create({
      data: {
        schoolId: school.id,
        blockId: block.id,
        userId: tUser.id,
        action: 'CREATE_GROUP_PAIR',
        reason: 'must survive block deletion',
      },
    });

    // Hard delete the block (requires removing sessions first due to Restrict on sessions)
    // This tests the onDelete: SetNull behavior on ScheduleActionLog.blockId
    await prisma.lessonBlock.delete({ where: { id: block.id } });

    const found = await prisma.scheduleActionLog.findUnique({ where: { id: log.id } });
    expect(found).not.toBeNull(); // log was NOT cascade-deleted
    expect(found!.action).toBe('CREATE_GROUP_PAIR');
    expect(found!.reason).toBe('must survive block deletion');
    expect(found!.userId).toBe(tUser.id);
    expect(found!.blockId).toBeNull(); // blockId set to NULL by onDelete: SetNull
  });

  it('audit log survives session soft-delete (sessionId reference preserved)', async () => {
    const { school, tUser, block, staff } = await setup();

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: daysFromNow(7), status: 'UPCOMING',
    });

    const log = await prisma.scheduleActionLog.create({
      data: {
        schoolId: school.id,
        sessionId: session.id,
        userId: tUser.id,
        action: 'SESSION_CANCELLED',
        reason: 'test session audit',
      },
    });

    // Soft-delete the session
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { deletedAt: new Date() },
    });

    const found = await prisma.scheduleActionLog.findUnique({ where: { id: log.id } });
    expect(found).not.toBeNull();
    expect(found!.action).toBe('SESSION_CANCELLED');
    expect(found!.sessionId).toBe(session.id); // reference preserved after soft-delete
  });
});
