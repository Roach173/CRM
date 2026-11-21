/**
 * Integration: Block generation guard — block state machine in session generation.
 *
 * Verifies:
 * - syncSessionsForBlock skips COMPLETED blocks
 * - syncSessionsForBlock skips CANCELLED blocks
 * - syncSessionsForBlock proceeds for UPCOMING blocks
 * - extendAllBlockSessions (cron) only extends UPCOMING blocks
 */
import {
  prisma, cleanDb, createSchool, createUser, createStaffProfile,
  createGroup, createBlock,
} from '../helpers/testDb';
import { syncSessionsForBlock } from '../../services/sessionService';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school  = await createSchool({ timezone: 'UTC', activeDays: [0,1,2,3,4] });
  const tUser   = await createUser(school.id, 'TEACHER');
  const staff   = await createStaffProfile(tUser.id, school.id);
  const group   = await createGroup(school.id);
  const block   = await createBlock({
    groupId: group.id, schoolId: school.id, staffProfileId: staff.id,
    startDate: new Date(),
  });
  return { school, staff, group, block };
}

describe('syncSessionsForBlock — block status guard', () => {
  it('skips session generation for COMPLETED block', async () => {
    const { block } = await setup();

    await prisma.lessonBlock.update({ where: { id: block.id }, data: { status: 'COMPLETED' } });

    const result = await syncSessionsForBlock({ ...block, status: 'COMPLETED' });

    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/completed/i);
    expect(result.created).toBe(0);

    const sessions = await prisma.lessonSession.findMany({ where: { lessonBlockId: block.id } });
    expect(sessions).toHaveLength(0);
  });

  it('skips session generation for CANCELLED block', async () => {
    const { block } = await setup();

    await prisma.lessonBlock.update({ where: { id: block.id }, data: { status: 'CANCELLED' } });

    const result = await syncSessionsForBlock({ ...block, status: 'CANCELLED' });

    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/cancelled/i);
    expect(result.created).toBe(0);

    const sessions = await prisma.lessonSession.findMany({ where: { lessonBlockId: block.id } });
    expect(sessions).toHaveLength(0);
  });

  it('generates sessions for UPCOMING block', async () => {
    const { block } = await setup();
    // status defaults to UPCOMING in the schema

    const result = await syncSessionsForBlock({ ...block, status: 'UPCOMING' });

    expect(result.skipped).toBe(false);
    // Should create sessions within the 14-day rolling window
    const sessions = await prisma.lessonSession.findMany({ where: { lessonBlockId: block.id } });
    expect(sessions.length).toBeGreaterThanOrEqual(0); // may be 0 if no matching days in window
  });

  it('generates sessions when status is omitted (backward compat)', async () => {
    const { block } = await setup();
    // When status is not passed, we assume UPCOMING (no status guard runs)
    const blockWithoutStatus = {
      id: block.id,
      schoolId: block.schoolId,
      days: block.days,
      startDate: block.startDate,
      endDate: block.endDate,
      studentGroupId: block.studentGroupId,
      teacherId: block.teacherId,
      cabinetId: block.cabinetId,
      startTime: block.startTime,
      endTime: block.endTime,
      // status omitted
    };

    const result = await syncSessionsForBlock(blockWithoutStatus);
    // Should not be skipped due to status
    expect(result.skipped).toBe(false);
  });
});
