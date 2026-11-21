/**
 * HTTP integration tests for the 2026-08-09 audit's highest-severity fixes.
 * Uses supertest against a real Express app (router-under-test only) with a
 * real PostgreSQL database, injecting req.user directly (see creditsRoute.test.ts
 * for the same pattern).
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStudentProfile,
} from '../helpers/testDb';
import groupsRouter from '../../routes/groups';
import importExportRouter from '../../routes/importexport';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

type TestRole = 'OWNER' | 'ADMIN' | 'TEACHER' | 'STUDENT' | 'SUPERADMIN';

function buildApp(router: express.Router, mountPath: string, user: { userId: number; schoolId: number; role: TestRole }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = user;
    next();
  });
  app.use(mountPath, router);
  return app;
}

// ─── groups.ts POST / — cross-tenant GroupMembership IDOR (critical finding) ──

describe('POST /groups — initial studentIds must be tenant-checked', () => {
  it('rejects a studentId that belongs to a different school', async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const ownerA = await createUser(schoolA.id, 'OWNER');
    const studentUserB = await createUser(schoolB.id, 'STUDENT');
    const studentB = await createStudentProfile(studentUserB.id, schoolB.id, 10);

    const app = buildApp(groupsRouter, '/groups', { userId: ownerA.id, schoolId: schoolA.id, role: 'OWNER' });

    const res = await request(app)
      .post('/groups')
      .send({ level: 'A1', studentIds: [studentB.id] });

    expect(res.status).toBe(404);

    // The group itself must not have been created with a leaked cross-tenant member.
    const membership = await prisma.groupMembership.findFirst({ where: { studentProfileId: studentB.id } });
    expect(membership).toBeNull();
  });

  it('still succeeds for students that genuinely belong to the requesting school', async () => {
    const schoolA = await createSchool();
    const ownerA = await createUser(schoolA.id, 'OWNER');
    const studentUserA = await createUser(schoolA.id, 'STUDENT');
    const studentA = await createStudentProfile(studentUserA.id, schoolA.id, 10);

    const app = buildApp(groupsRouter, '/groups', { userId: ownerA.id, schoolId: schoolA.id, role: 'OWNER' });

    const res = await request(app)
      .post('/groups')
      .send({ level: 'A1', studentIds: [studentA.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.students).toHaveLength(1);
  });
});

// ─── groups.ts GET / and GET /:id — STUDENT must not see the full roster ──────

describe('GET /groups and GET /groups/:id — STUDENT role gate', () => {
  it('blocks STUDENT from listing all groups', async () => {
    const school = await createSchool();
    const studentUser = await createUser(school.id, 'STUDENT');
    const app = buildApp(groupsRouter, '/groups', { userId: studentUser.id, schoolId: school.id, role: 'STUDENT' });

    const res = await request(app).get('/groups');
    expect(res.status).toBe(403);
  });

  it('allows TEACHER to list groups (unchanged behavior)', async () => {
    const school = await createSchool();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const app = buildApp(groupsRouter, '/groups', { userId: teacherUser.id, schoolId: school.id, role: 'TEACHER' });

    const res = await request(app).get('/groups');
    expect(res.status).toBe(200);
  });
});

// ─── importexport.ts teacher-import preview/apply — cross-tenant leak+write (critical) ──

describe('POST /import-export/import/preview-teachers and apply-teachers — tenant scoping', () => {
  it('preview does not report a same-email user from a different school as a conflict', async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const ownerA = await createUser(schoolA.id, 'OWNER');
    const victimB = await createUser(schoolB.id, 'TEACHER');

    const app = buildApp(importExportRouter, '/import-export', { userId: ownerA.id, schoolId: schoolA.id, role: 'OWNER' });

    const res = await request(app)
      .post('/import-export/import/preview-teachers')
      .send({ teachers: [{ firstName: 'X', lastName: 'Y', email: victimB.email }] });

    expect(res.status).toBe(200);
    expect(res.body.data.conflicts).toHaveLength(0);
    expect(res.body.data.newCount).toBe(1);
  });

  it('apply does not overwrite a same-email user from a different school', async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const ownerA = await createUser(schoolA.id, 'OWNER');
    const victimB = await createUser(schoolB.id, 'TEACHER');

    const app = buildApp(importExportRouter, '/import-export', { userId: ownerA.id, schoolId: schoolA.id, role: 'OWNER' });

    await request(app)
      .post('/import-export/import/apply-teachers')
      .send({
        teachers: [{ firstName: 'Hacked', lastName: 'Name', email: victimB.email }],
        resolutions: { [victimB.email!]: 'update' },
        defaultPassword: 'ValidPass123',
      });

    // Victim's record in school B must be untouched — a NEW user should have been
    // created in school A instead (or the row skipped), never an update to victimB.
    const stillIntact = await prisma.user.findUnique({ where: { id: victimB.id } });
    expect(stillIntact!.firstName).toBe(victimB.firstName);
    expect(stillIntact!.lastName).toBe(victimB.lastName);
    expect(stillIntact!.schoolId).toBe(schoolB.id);
  });
});
