/**
 * HTTP integration tests for freeze routes.
 *
 * Mutation proof:
 *   POST /freeze without reason → 400, no StudentFreeze row created
 *   DELETE /freeze/:id without reason → 400, StudentFreeze status unchanged
 *   POST /freeze with valid reason → 201, StudentFreeze created
 *   DELETE /freeze/:id with valid reason → 200, StudentFreeze CANCELLED
 *
 * Uses supertest + real PostgreSQL test database.
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
import freezeRouter from '../../routes/freeze';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

type TestRole = 'OWNER' | 'ADMIN' | 'SUPERADMIN';

function buildApp(user: { userId: number; schoolId: number; role: TestRole }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { ...user, tokenVersion: 1 };
    next();
  });
  app.use('/freeze', freezeRouter);
  return app;
}

// ─── POST /freeze ─────────────────────────────────────────────────────────────

describe('POST /freeze — reason enforcement', () => {
  it('returns 400 and creates NO StudentFreeze when reason is missing', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const studentUser = await createUser(school.id, 'STUDENT');
    const profile = await createStudentProfile(studentUser.id, school.id);

    const app = buildApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app).post('/freeze').send({
      studentProfileId: profile.id,
      type: 'PERIOD',
      startDate: '2026-08-01',
      // reason: intentionally omitted
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/reason/i);

    // Mutation proof: no StudentFreeze row was created
    const count = await prisma.studentFreeze.count({ where: { studentProfileId: profile.id } });
    expect(count).toBe(0);
  });

  it('returns 400 when reason is shorter than 5 chars', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const studentUser = await createUser(school.id, 'STUDENT');
    const profile = await createStudentProfile(studentUser.id, school.id);

    const app = buildApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app).post('/freeze').send({
      studentProfileId: profile.id,
      type: 'PERIOD',
      startDate: '2026-08-01',
      reason: 'hi',
    });

    expect(res.status).toBe(400);
    const count = await prisma.studentFreeze.count({ where: { studentProfileId: profile.id } });
    expect(count).toBe(0);
  });

  it('creates StudentFreeze when reason is valid (≥5 chars)', async () => {
    const school = await createSchool({ activeDays: [0, 1, 2, 3, 4, 5, 6] });
    const ownerUser = await createUser(school.id, 'OWNER');
    const studentUser = await createUser(school.id, 'STUDENT');
    const profile = await createStudentProfile(studentUser.id, school.id);

    const app = buildApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app).post('/freeze').send({
      studentProfileId: profile.id,
      type: 'PERIOD',
      startDate: '2026-08-01',
      reason: 'Student requested pause for exam period',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const freeze = await prisma.studentFreeze.findFirst({ where: { studentProfileId: profile.id } });
    expect(freeze).not.toBeNull();
    expect(freeze!.status).toBe('ACTIVE');
    expect(freeze!.reason).toBe('Student requested pause for exam period');
  });
});

// ─── DELETE /freeze/:id ───────────────────────────────────────────────────────

describe('DELETE /freeze/:id — reason enforcement', () => {
  it('returns 400 and leaves freeze ACTIVE when reason is missing', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const studentUser = await createUser(school.id, 'STUDENT');
    const profile = await createStudentProfile(studentUser.id, school.id);

    // Seed an ACTIVE freeze directly
    const freeze = await prisma.studentFreeze.create({
      data: {
        schoolId:         school.id,
        studentProfileId: profile.id,
        type:             'PERIOD',
        startDate:        new Date('2026-08-01T12:00:00.000Z'),
        endDate:          null,
        status:           'ACTIVE',
        createdById:      ownerUser.id,
      },
    });

    const app = buildApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });

    const res = await request(app).delete(`/freeze/${freeze.id}`).send({
      // reason: intentionally omitted
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/reason/i);

    // Mutation proof: freeze still ACTIVE
    const updated = await prisma.studentFreeze.findUnique({ where: { id: freeze.id } });
    expect(updated!.status).toBe('ACTIVE');
  });

  it('returns 400 when reason is shorter than 5 chars', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const studentUser = await createUser(school.id, 'STUDENT');
    const profile = await createStudentProfile(studentUser.id, school.id);

    const freeze = await prisma.studentFreeze.create({
      data: {
        schoolId: school.id, studentProfileId: profile.id, type: 'PERIOD',
        startDate: new Date('2026-08-01T12:00:00.000Z'), endDate: null,
        status: 'ACTIVE', createdById: ownerUser.id,
      },
    });

    const app = buildApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });
    const res = await request(app).delete(`/freeze/${freeze.id}`).send({ reason: 'no' });

    expect(res.status).toBe(400);
    const still = await prisma.studentFreeze.findUnique({ where: { id: freeze.id } });
    expect(still!.status).toBe('ACTIVE');
  });

  it('cancels freeze when reason is valid', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const studentUser = await createUser(school.id, 'STUDENT');
    const profile = await createStudentProfile(studentUser.id, school.id);

    await prisma.studentProfile.update({ where: { id: profile.id }, data: { isFrozen: true } });

    const freeze = await prisma.studentFreeze.create({
      data: {
        schoolId: school.id, studentProfileId: profile.id, type: 'PERIOD',
        startDate: new Date('2026-08-01T12:00:00.000Z'), endDate: null,
        status: 'ACTIVE', createdById: ownerUser.id,
      },
    });

    const app = buildApp({ userId: ownerUser.id, schoolId: school.id, role: 'OWNER' });
    const res = await request(app)
      .delete(`/freeze/${freeze.id}`)
      .send({ reason: 'Student returned from vacation' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const cancelled = await prisma.studentFreeze.findUnique({ where: { id: freeze.id } });
    expect(cancelled!.status).toBe('CANCELLED');
  });
});
