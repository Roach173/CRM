/**
 * Backend RBAC hardening for school-wide operational control endpoints.
 *
 * Frontend already hides PolicyConflictsPanel from TEACHER/STUDENT/PARENT,
 * but that is not a security boundary — these endpoints previously accepted
 * the broad `schedule:read` (or `attendance:write`) permission, which
 * TEACHER/STUDENT/PARENT also hold, and returned unfiltered school-wide
 * data. They must require `analytics:read` (OWNER/ADMIN/SUPERADMIN only),
 * matching the existing convention already used by GET /schedule/integrity.
 */
import express from 'express';
import request from 'supertest';
import { Role } from '@prisma/client';
import { prisma, cleanDb, createSchool, createUser, createStaffProfile, createStudentProfile } from '../helpers/testDb';
import scheduleRoutes from '../../routes/schedule';

process.env.NODE_ENV = 'test';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function buildScheduleApp(user: { id: number; schoolId: number | null; role: Role }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: user.id, schoolId: user.schoolId, role: user.role, tokenVersion: 1 };
    next();
  });
  app.use('/api/schedule', scheduleRoutes);
  return app;
}

const PROTECTED_ENDPOINTS = [
  '/policy-conflicts',
  '/attendance-dashboard',
];

describe('School-wide operational control endpoints require analytics:read', () => {
  for (const path of PROTECTED_ENDPOINTS) {
    describe(`GET /schedule${path}`, () => {
      it('OWNER can access (200)', async () => {
        const school = await createSchool({ timezone: 'UTC' });
        const owner = await createUser(school.id, 'OWNER');
        const res = await request(buildScheduleApp(owner)).get(`/api/schedule${path}`);
        expect(res.status).toBe(200);
      });

      it('ADMIN can access (200)', async () => {
        const school = await createSchool({ timezone: 'UTC' });
        const admin = await createUser(school.id, 'ADMIN');
        const res = await request(buildScheduleApp(admin)).get(`/api/schedule${path}`);
        expect(res.status).toBe(200);
      });

      it('TEACHER gets 403', async () => {
        const school = await createSchool({ timezone: 'UTC' });
        const teacher = await createUser(school.id, 'TEACHER');
        const res = await request(buildScheduleApp(teacher)).get(`/api/schedule${path}`);
        expect(res.status).toBe(403);
      });

      it('STUDENT gets 403', async () => {
        const school = await createSchool({ timezone: 'UTC' });
        const student = await createUser(school.id, 'STUDENT');
        const res = await request(buildScheduleApp(student)).get(`/api/schedule${path}`);
        expect(res.status).toBe(403);
      });

      it('PARENT gets 403', async () => {
        const school = await createSchool({ timezone: 'UTC' });
        const parent = { id: 99999, schoolId: school.id, role: Role.PARENT };
        const res = await request(buildScheduleApp(parent)).get(`/api/schedule${path}`);
        expect(res.status).toBe(403);
      });
    });
  }

  it('GET /schedule/policy-conflicts — OWNER of school A never sees school B data (cross-tenant)', async () => {
    const schoolA = await createSchool({ timezone: 'UTC' });
    const schoolB = await createSchool({ timezone: 'UTC' });
    const ownerA = await createUser(schoolA.id, 'OWNER');
    await createUser(schoolB.id, 'OWNER');

    const res = await request(buildScheduleApp(ownerA)).get('/api/schedule/policy-conflicts');
    expect(res.status).toBe(200);
    // schoolA has no blocks/sessions — response must be empty, never schoolB's.
    expect(res.body.data.blocksOutsidePolicy).toEqual([]);
  });
});

describe('Regression — self-scoped teacher/student schedule endpoints still work', () => {
  it('GET /schedule/teacher still returns 200 for TEACHER (own schedule, unaffected by this change)', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const teacherUser = await createUser(school.id, 'TEACHER');
    await createStaffProfile(teacherUser.id, school.id);
    const res = await request(buildScheduleApp(teacherUser)).get('/api/schedule/teacher');
    expect(res.status).toBe(200);
  });

  it('GET /schedule/student still returns 200 for STUDENT (own schedule, unaffected by this change)', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const studentUser = await createUser(school.id, 'STUDENT');
    await createStudentProfile(studentUser.id, school.id);
    const res = await request(buildScheduleApp(studentUser)).get('/api/schedule/student');
    expect(res.status).toBe(200);
  });

  it('GET /schedule/integrity (already analytics:read) still 403s for TEACHER — unchanged precedent', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const teacherUser = await createUser(school.id, 'TEACHER');
    const res = await request(buildScheduleApp(teacherUser)).get('/api/schedule/integrity');
    expect(res.status).toBe(403);
  });
});
