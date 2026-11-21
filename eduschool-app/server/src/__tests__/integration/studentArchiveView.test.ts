/**
 * HTTP integration tests for the student Archive view + restore.
 *
 * Covers PR A ("soft-deleted accounts stay visible in the archive"):
 *  1. GET /students?archived=true returns BOTH archived (archivedAt) and
 *     soft-deleted (deletedAt) students, each carrying both flags.
 *  2. Active view (no ?archived) excludes archived AND soft-deleted students.
 *  3. PATCH /students/:id/unarchive restores a soft-deleted student
 *     (clears User.deletedAt + StudentProfile.deletedAt).
 *  4. PATCH /students/:id/unarchive restores an archived student (clears archivedAt).
 *  5. unarchive on a normal active student → 404.
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStudentProfile,
  createGroup,
  createMembership,
} from '../helpers/testDb';
import studentsRouter from '../../routes/students';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function buildApp(user: { userId: number; schoolId: number; role: string; tokenVersion: number }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = user;
    next();
  });
  app.use('/students', studentsRouter);
  return app;
}

async function setup() {
  const school = await createSchool();
  const ownerU = await createUser(school.id, 'OWNER');

  // active student
  const activeU = await createUser(school.id, 'STUDENT');
  await createStudentProfile(activeU.id, school.id, 10);

  // archived student (archivedAt set)
  const archivedU = await createUser(school.id, 'STUDENT');
  await createStudentProfile(archivedU.id, school.id, 5);
  await prisma.user.update({ where: { id: archivedU.id }, data: { archivedAt: new Date() } });

  // soft-deleted student (deletedAt set on user + profile, as clear-data / user-delete does)
  const deletedU = await createUser(school.id, 'STUDENT');
  const deletedP = await createStudentProfile(deletedU.id, school.id, 0);
  await prisma.user.update({ where: { id: deletedU.id }, data: { deletedAt: new Date() } });
  await prisma.studentProfile.update({ where: { id: deletedP.id }, data: { deletedAt: new Date() } });

  const ownerCtx = { userId: ownerU.id, schoolId: school.id, role: 'OWNER', tokenVersion: 0 };
  return { school, ownerCtx, activeU, archivedU, deletedU, deletedP };
}

describe('Student archive view + restore', () => {
  it('archived=true returns BOTH archived and soft-deleted students', async () => {
    const { ownerCtx, archivedU, deletedU, activeU } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).get('/students').query({ archived: 'true' });
    expect(res.status).toBe(200);

    const ids = res.body.data.map((s: any) => s.id);
    expect(ids).toContain(archivedU.id);
    expect(ids).toContain(deletedU.id);
    expect(ids).not.toContain(activeU.id);
    expect(res.body.meta.total).toBe(2);

    const deletedRow = res.body.data.find((s: any) => s.id === deletedU.id);
    expect(deletedRow.deletedAt).not.toBeNull();
    const archivedRow = res.body.data.find((s: any) => s.id === archivedU.id);
    expect(archivedRow.archivedAt).not.toBeNull();
  });

  it('active view excludes archived and soft-deleted students', async () => {
    const { ownerCtx, archivedU, deletedU, activeU } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).get('/students');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: any) => s.id);
    expect(ids).toContain(activeU.id);
    expect(ids).not.toContain(archivedU.id);
    expect(ids).not.toContain(deletedU.id);
  });

  it('unarchive restores a SOFT-DELETED student (user + profile deletedAt cleared)', async () => {
    const { ownerCtx, deletedU, deletedP } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).patch(`/students/${deletedU.id}/unarchive`);
    expect(res.status).toBe(200);

    const user = await prisma.user.findUnique({ where: { id: deletedU.id } });
    const profile = await prisma.studentProfile.findUnique({ where: { id: deletedP.id } });
    expect(user?.deletedAt).toBeNull();
    expect(user?.archivedAt).toBeNull();
    expect(profile?.deletedAt).toBeNull();

    // now visible in active view
    const active = await request(app).get('/students');
    expect(active.body.data.map((s: any) => s.id)).toContain(deletedU.id);
  });

  it('unarchive restores an ARCHIVED student (archivedAt cleared)', async () => {
    const { ownerCtx, archivedU } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).patch(`/students/${archivedU.id}/unarchive`);
    expect(res.status).toBe(200);

    const user = await prisma.user.findUnique({ where: { id: archivedU.id } });
    expect(user?.archivedAt).toBeNull();
    expect(user?.deletedAt).toBeNull();
  });

  it('unarchive on a normal active student returns 404', async () => {
    const { ownerCtx, activeU } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).patch(`/students/${activeU.id}/unarchive`);
    expect(res.status).toBe(404);
  });

  it('active list includes enrolledGroups for a student with an active GroupMembership (regression: GET /students never remapped memberships, unlike GET /:id and /by-profile/:id)', async () => {
    const { ownerCtx, activeU } = await setup();
    const app = buildApp(ownerCtx);

    const activeProfile = await prisma.studentProfile.findFirstOrThrow({ where: { userId: activeU.id } });
    const group = await createGroup(ownerCtx.schoolId);
    await createMembership(group.id, activeProfile.id, ownerCtx.schoolId);

    const res = await request(app).get('/students');
    expect(res.status).toBe(200);

    const row = res.body.data.find((s: any) => s.id === activeU.id);
    expect(row.studentProfile.enrolledGroups).toHaveLength(1);
    expect(row.studentProfile.enrolledGroups[0].id).toBe(group.id);
    expect(row.studentProfile.memberships).toBeUndefined();
  });
});
