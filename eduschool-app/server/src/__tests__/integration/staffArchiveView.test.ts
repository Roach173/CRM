/**
 * HTTP integration tests for the staff (teacher/admin) Archive view + restore.
 *
 * Mirrors studentArchiveView.test.ts for the /users router:
 *  1. GET /users?archived=true returns BOTH archived (archivedAt) and
 *     soft-deleted (deletedAt) staff, each carrying both flags.
 *  2. Active view (no ?archived) excludes archived AND soft-deleted staff.
 *  3. PATCH /users/:id/archive moves an active teacher/admin to the archive.
 *  4. PATCH /users/:id/unarchive restores a soft-deleted staff member
 *     (clears User.deletedAt + StaffProfile.deletedAt).
 *  5. PATCH /users/:id/unarchive restores an archived staff member (clears archivedAt).
 *  6. unarchive on a normal active staff member → 404.
 *  7. archiving your own account → 400.
 *  8. archiving a STUDENT via this endpoint → 404 (staff-only guard).
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStaffProfile,
  createStudentProfile,
} from '../helpers/testDb';
import usersRouter from '../../routes/users';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function buildApp(user: { userId: number; schoolId: number; role: string; tokenVersion: number }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = user;
    next();
  });
  app.use('/users', usersRouter);
  return app;
}

async function setup() {
  const school = await createSchool();
  const ownerU = await createUser(school.id, 'OWNER');

  // active teacher
  const activeT = await createUser(school.id, 'TEACHER');
  await createStaffProfile(activeT.id, school.id);

  // archived teacher (archivedAt set)
  const archivedT = await createUser(school.id, 'TEACHER');
  await createStaffProfile(archivedT.id, school.id);
  await prisma.user.update({ where: { id: archivedT.id }, data: { archivedAt: new Date() } });

  // soft-deleted admin (deletedAt set on user + staffProfile, as clear-data / user-delete does)
  const deletedA = await createUser(school.id, 'ADMIN');
  const deletedAP = await createStaffProfile(deletedA.id, school.id);
  await prisma.user.update({ where: { id: deletedA.id }, data: { deletedAt: new Date() } });
  await prisma.staffProfile.update({ where: { id: deletedAP.id }, data: { deletedAt: new Date() } });

  const ownerCtx = { userId: ownerU.id, schoolId: school.id, role: 'OWNER', tokenVersion: 0 };
  return { school, ownerCtx, ownerU, activeT, archivedT, deletedA, deletedAP };
}

describe('Staff archive view + restore', () => {
  it('archived=true returns BOTH archived and soft-deleted staff', async () => {
    const { ownerCtx, archivedT, deletedA, activeT } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).get('/users').query({ archived: 'true' });
    expect(res.status).toBe(200);

    const ids = res.body.data.map((u: any) => u.id);
    expect(ids).toContain(archivedT.id);
    expect(ids).toContain(deletedA.id);
    expect(ids).not.toContain(activeT.id);

    const deletedRow = res.body.data.find((u: any) => u.id === deletedA.id);
    expect(deletedRow.deletedAt).not.toBeNull();
    const archivedRow = res.body.data.find((u: any) => u.id === archivedT.id);
    expect(archivedRow.archivedAt).not.toBeNull();
  });

  it('active view excludes archived and soft-deleted staff', async () => {
    const { ownerCtx, archivedT, deletedA, activeT } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).get('/users').query({ role: 'TEACHER' });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((u: any) => u.id);
    expect(ids).toContain(activeT.id);
    expect(ids).not.toContain(archivedT.id);
    expect(ids).not.toContain(deletedA.id);
  });

  it('archive moves an active teacher to the archive', async () => {
    const { ownerCtx, activeT } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).patch(`/users/${activeT.id}/archive`);
    expect(res.status).toBe(200);

    const user = await prisma.user.findUnique({ where: { id: activeT.id } });
    expect(user?.archivedAt).not.toBeNull();
  });

  it('unarchive restores a SOFT-DELETED staff member (user + staffProfile deletedAt cleared)', async () => {
    const { ownerCtx, deletedA, deletedAP } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).patch(`/users/${deletedA.id}/unarchive`);
    expect(res.status).toBe(200);

    const user = await prisma.user.findUnique({ where: { id: deletedA.id } });
    const profile = await prisma.staffProfile.findUnique({ where: { id: deletedAP.id } });
    expect(user?.deletedAt).toBeNull();
    expect(user?.archivedAt).toBeNull();
    expect(profile?.deletedAt).toBeNull();

    // now visible in active view
    const active = await request(app).get('/users').query({ role: 'ADMIN' });
    expect(active.body.data.map((u: any) => u.id)).toContain(deletedA.id);
  });

  it('unarchive restores an ARCHIVED staff member (archivedAt cleared)', async () => {
    const { ownerCtx, archivedT } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).patch(`/users/${archivedT.id}/unarchive`);
    expect(res.status).toBe(200);

    const user = await prisma.user.findUnique({ where: { id: archivedT.id } });
    expect(user?.archivedAt).toBeNull();
    expect(user?.deletedAt).toBeNull();
  });

  it('unarchive on a normal active staff member returns 404', async () => {
    const { ownerCtx, activeT } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).patch(`/users/${activeT.id}/unarchive`);
    expect(res.status).toBe(404);
  });

  it('archiving your own account returns 400', async () => {
    const { ownerCtx } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app).patch(`/users/${ownerCtx.userId}/archive`);
    expect(res.status).toBe(400);
  });

  it('archiving a STUDENT via the staff endpoint returns 404', async () => {
    const { ownerCtx, school } = await setup();
    const studentU = await createUser(school.id, 'STUDENT');
    await createStudentProfile(studentU.id, school.id, 10);
    const app = buildApp(ownerCtx);

    const res = await request(app).patch(`/users/${studentU.id}/archive`);
    expect(res.status).toBe(404);
  });
});
