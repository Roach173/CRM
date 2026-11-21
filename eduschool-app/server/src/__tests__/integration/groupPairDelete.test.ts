import express from 'express';
import request from 'supertest';
import { Role } from '@prisma/client';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStaffProfile,
  createGroup,
  createBlock,
} from '../helpers/testDb';
import scheduleRoutes from '../../routes/schedule';
import * as blockArchiveService from '../../services/blockArchiveService';

process.env.NODE_ENV = 'test';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());
afterEach(() => jest.restoreAllMocks());

function buildScheduleApp(user: { id: number; schoolId: number | null; role: Role; tokenVersion?: number }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: user.id, schoolId: user.schoolId, role: user.role, tokenVersion: user.tokenVersion ?? 1 };
    next();
  });
  app.use('/api/schedule', scheduleRoutes);
  return app;
}

async function setup() {
  const school = await createSchool({ timezone: 'UTC' });
  const owner = await createUser(school.id, 'OWNER');
  const admin = await createUser(school.id, 'ADMIN');
  const teacherUser = await createUser(school.id, 'TEACHER');
  const staff = await createStaffProfile(teacherUser.id, school.id);
  const group = await createGroup(school.id);
  return { school, owner, admin, staff, group };
}

describe('DELETE /schedule/group-pair/:studentGroupId', () => {
  it('archives both Grammar and Club blocks atomically', async () => {
    const { school, owner, staff, group } = await setup();
    const grammar = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR', days: [0, 2] });
    const club = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'SPEAKING_CLUB', days: [4] });

    const res = await request(buildScheduleApp(owner))
      .delete(`/api/schedule/group-pair/${group.id}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.archived).toHaveLength(2);

    const [afterGrammar, afterClub] = await Promise.all([
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: grammar.id } }),
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: club.id } }),
    ]);
    expect(afterGrammar.deletedAt).not.toBeNull();
    expect(afterGrammar.status).toBe('CANCELLED');
    expect(afterClub.deletedAt).not.toBeNull();
    expect(afterClub.status).toBe('CANCELLED');

    const logs = await prisma.scheduleActionLog.findMany({ where: { schoolId: school.id }, orderBy: { id: 'asc' } });
    expect(logs.filter(l => l.action === 'ARCHIVE_BLOCK')).toHaveLength(2);
    expect(logs.filter(l => l.action === 'DELETE_GROUP_PAIR')).toHaveLength(1);
  });

  it('archives a Grammar-only group (no Club block)', async () => {
    const { school, owner, staff, group } = await setup();
    const grammar = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR' });

    const res = await request(buildScheduleApp(owner))
      .delete(`/api/schedule/group-pair/${group.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.archived).toHaveLength(1);

    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: grammar.id } });
    expect(after.deletedAt).not.toBeNull();
  });

  it('self-heals a half-deleted pair left by the old non-atomic loop', async () => {
    const { school, owner, staff, group } = await setup();
    const grammar = await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'), status: 'CANCELLED',
    });
    const club = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'SPEAKING_CLUB', days: [4] });

    const res = await request(buildScheduleApp(owner))
      .delete(`/api/schedule/group-pair/${group.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.archived).toHaveLength(1);
    expect(res.body.data.archived[0].blockId).toBe(club.id);

    const afterClub = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: club.id } });
    expect(afterClub.deletedAt).not.toBeNull();
    // The already-archived grammar block's original archive timestamp is untouched.
    const afterGrammar = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: grammar.id } });
    expect(afterGrammar.deletedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('leaves closed history blocks (endDate in the past, not soft-deleted) untouched and only archives the current active pair', async () => {
    // Reproduces real dev data: after a reschedule/split via PUT /group-pair, the old
    // pair is closed with endDate set but deletedAt stays null — it's history, not active.
    const { school, owner, staff, group } = await setup();
    const closedGrammar = await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR',
      startDate: new Date('2026-06-15T00:00:00.000Z'), endDate: new Date('2026-06-21T00:00:00.000Z'),
    });
    const closedClub = await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'SPEAKING_CLUB',
      startDate: new Date('2026-06-15T00:00:00.000Z'), endDate: new Date('2026-06-21T00:00:00.000Z'), days: [4],
    });
    const activeGrammar = await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR',
      startDate: new Date('2026-06-29T00:00:00.000Z'),
    });
    const activeClub = await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'SPEAKING_CLUB',
      startDate: new Date('2026-06-29T00:00:00.000Z'), days: [4],
    });

    const res = await request(buildScheduleApp(owner))
      .delete(`/api/schedule/group-pair/${group.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.archived.map((a: any) => a.blockId).sort()).toEqual([activeGrammar.id, activeClub.id].sort());

    const [afterClosedGrammar, afterClosedClub, afterActiveGrammar, afterActiveClub] = await Promise.all([
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: closedGrammar.id } }),
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: closedClub.id } }),
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: activeGrammar.id } }),
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: activeClub.id } }),
    ]);
    // History stays exactly as it was — never archived, deletedAt still null.
    expect(afterClosedGrammar.deletedAt).toBeNull();
    expect(afterClosedClub.deletedAt).toBeNull();
    // Only the current active pair got archived.
    expect(afterActiveGrammar.deletedAt).not.toBeNull();
    expect(afterActiveClub.deletedAt).not.toBeNull();
  });

  it('returns 404 and mutates nothing when the group has no active blocks', async () => {
    const { owner, group } = await setup();

    const res = await request(buildScheduleApp(owner))
      .delete(`/api/schedule/group-pair/${group.id}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('returns 404 and mutates nothing for a group belonging to another school (cross-tenant)', async () => {
    const { school: schoolA, staff, group } = await setup();
    await createBlock({ groupId: group.id, schoolId: schoolA.id, staffProfileId: staff.id, type: 'GRAMMAR' });

    const schoolB = await createSchool({ timezone: 'UTC' });
    const ownerB = await createUser(schoolB.id, 'OWNER');

    const res = await request(buildScheduleApp(ownerB))
      .delete(`/api/schedule/group-pair/${group.id}`);

    expect(res.status).toBe(404);

    const stillActive = await prisma.lessonBlock.findMany({ where: { studentGroupId: group.id, deletedAt: null } });
    expect(stillActive).toHaveLength(1);
  });

  it('rejects ADMIN (schedule:delete is OWNER-only), same as the existing single-block route', async () => {
    const { admin, group } = await setup();

    const res = await request(buildScheduleApp(admin))
      .delete(`/api/schedule/group-pair/${group.id}`);

    expect(res.status).toBe(403);
  });

  it('rolls back the whole transaction if archiving the second block fails', async () => {
    const { school, owner, staff, group } = await setup();
    const grammar = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'GRAMMAR', days: [0, 2] });
    const club = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id, type: 'SPEAKING_CLUB', days: [4] });

    const real = blockArchiveService.archiveLessonBlockInTx;
    let calls = 0;
    jest.spyOn(blockArchiveService, 'archiveLessonBlockInTx').mockImplementation(async (tx, params) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error('SIMULATED_FAILURE'), { httpStatus: 500 });
      }
      return real(tx, params);
    });

    const res = await request(buildScheduleApp(owner))
      .delete(`/api/schedule/group-pair/${group.id}`);

    expect(res.status).toBe(500);

    const [afterGrammar, afterClub] = await Promise.all([
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: grammar.id } }),
      prisma.lessonBlock.findUniqueOrThrow({ where: { id: club.id } }),
    ]);
    // Neither block was archived — the first block's write was rolled back with the second's failure.
    expect(afterGrammar.deletedAt).toBeNull();
    expect(afterClub.deletedAt).toBeNull();

    const logs = await prisma.scheduleActionLog.findMany({ where: { schoolId: school.id } });
    expect(logs).toHaveLength(0);
  });
});

describe('DELETE /schedule/:id (existing single-block route)', () => {
  it('still archives a standalone block (no studentGroupId) after the archiveLessonBlock refactor', async () => {
    const { school, owner, staff } = await setup();
    const block = await createBlock({ schoolId: school.id, staffProfileId: staff.id });

    const res = await request(buildScheduleApp(owner))
      .delete(`/api/schedule/${block.id}`);

    expect(res.status).toBe(200);
    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.status).toBe('CANCELLED');
  });

  it('rejects deleting an active grouped block — must use DELETE /group-pair instead (see groupPairWriteOwnership.test.ts)', async () => {
    const { school, owner, staff, group } = await setup();
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });

    const res = await request(buildScheduleApp(owner))
      .delete(`/api/schedule/${block.id}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GROUP_PAIR_OWNED');
    const after = await prisma.lessonBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(after.deletedAt).toBeNull();
  });
});
