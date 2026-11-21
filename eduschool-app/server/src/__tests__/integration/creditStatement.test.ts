/**
 * HTTP integration tests for GET /credits/statement/:studentProfileId
 *
 * Roll-forward invariant: opening + added + deducted = closing.
 * Foot check: profile.credits vs sum(ledger) — discrepancy surfaced, never plugged.
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
import creditsRouter from '../../routes/credits';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function buildApp(user: { userId: number; schoolId: number; role: 'OWNER' | 'STUDENT'; tokenVersion: number }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = user;
    next();
  });
  app.use('/credits', creditsRouter);
  return app;
}

// Current UTC month boundaries — the endpoint uses UTC month windows.
const now = new Date();
const Y = now.getUTCFullYear();
const M = now.getUTCMonth(); // 0-based
const monthStr   = `${Y}-${String(M + 1).padStart(2, '0')}`;
const inMonth    = (day: number) => new Date(Date.UTC(Y, M, day, 12));
const beforeMonth = new Date(Date.UTC(Y, M, 1) - 15 * 24 * 60 * 60 * 1000); // ~mid prev month

async function setup(credits: number) {
  const school  = await createSchool();
  const ownerU  = await createUser(school.id, 'OWNER');
  const stuU    = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(stuU.id, school.id, credits);
  const ownerCtx = { userId: ownerU.id, schoolId: school.id, role: 'OWNER' as const, tokenVersion: 0 };
  return { school, ownerCtx, student };
}

describe('GET /credits/statement — roll-forward math', () => {
  it('opening + added + deducted = closing, and foots when ledger matches balance', async () => {
    const { ownerCtx, student, school } = await setup(12); // ledger below sums to 12
    const app = buildApp(ownerCtx);

    await prisma.lessonCreditLog.createMany({
      data: [
        { schoolId: school.id, studentProfileId: student.id, amount: 10, reason: 'top-up prev month', type: 'MANUAL_ADD', createdAt: beforeMonth },
        { schoolId: school.id, studentProfileId: student.id, amount: 5,  reason: 'top-up this month', type: 'MANUAL_ADD', createdAt: inMonth(5) },
        { schoolId: school.id, studentProfileId: student.id, amount: -3, reason: 'lessons attended',  type: 'DEBIT',      createdAt: inMonth(10) },
      ],
    });

    const res = await request(app).get(`/credits/statement/${student.id}`).query({ month: monthStr });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.month).toBe(monthStr);
    expect(d.opening).toBe(10);
    expect(d.added).toBe(5);
    expect(d.deducted).toBe(-3);
    expect(d.closing).toBe(12);
    expect(d.closing).toBe(d.opening + d.added + d.deducted); // must foot
    expect(d.lines).toHaveLength(2); // only this month's lines
    expect(d.ledgerBalance).toBe(12);
    expect(d.profileBalance).toBe(12);
    expect(d.foots).toBe(true);
  });

  it('surfaces discrepancy (foots=false) when balance diverges from ledger', async () => {
    const { ownerCtx, student, school } = await setup(99); // balance says 99, ledger says 4
    const app = buildApp(ownerCtx);

    await prisma.lessonCreditLog.create({
      data: { schoolId: school.id, studentProfileId: student.id, amount: 4, reason: 'top-up', type: 'MANUAL_ADD', createdAt: inMonth(3) },
    });

    const res = await request(app).get(`/credits/statement/${student.id}`).query({ month: monthStr });

    expect(res.status).toBe(200);
    expect(res.body.data.ledgerBalance).toBe(4);
    expect(res.body.data.profileBalance).toBe(99);
    expect(res.body.data.foots).toBe(false); // gap surfaced, not plugged
  });

  it('404 for a student from another school (tenant isolation)', async () => {
    const { ownerCtx } = await setup(0);
    const other = await setup(5); // second school + student
    const app = buildApp(ownerCtx);

    const res = await request(app).get(`/credits/statement/${other.student.id}`).query({ month: monthStr });
    expect(res.status).toBe(404);
  });

  it('400 for a malformed month', async () => {
    const { ownerCtx, student } = await setup(0);
    const app = buildApp(ownerCtx);

    const res = await request(app).get(`/credits/statement/${student.id}`).query({ month: '2026-13' });
    expect(res.status).toBe(400);
  });

  it('month boundaries follow the school timezone, not UTC', async () => {
    // Bishkek = UTC+6: 2026-06-30T20:00Z is already July 1st, 02:00 local.
    const school  = await createSchool({ timezone: 'Asia/Bishkek' });
    const ownerU  = await createUser(school.id, 'OWNER');
    const stuU    = await createUser(school.id, 'STUDENT');
    const student = await createStudentProfile(stuU.id, school.id, 3);
    const app = buildApp({ userId: ownerU.id, schoolId: school.id, role: 'OWNER', tokenVersion: 0 });

    await prisma.lessonCreditLog.create({
      data: {
        schoolId: school.id, studentProfileId: student.id, amount: 3,
        reason: 'top-up at local July 1st, 02:00', type: 'MANUAL_ADD',
        createdAt: new Date('2026-06-30T20:00:00.000Z'),
      },
    });

    const june = await request(app).get(`/credits/statement/${student.id}`).query({ month: '2026-06' });
    const july = await request(app).get(`/credits/statement/${student.id}`).query({ month: '2026-07' });

    expect(june.body.data.lines).toHaveLength(0);   // not June for the school
    expect(june.body.data.closing).toBe(0);
    expect(july.body.data.opening).toBe(0);         // continuity: June closing = July opening
    expect(july.body.data.lines).toHaveLength(1);   // lands in July
    expect(july.body.data.closing).toBe(3);
  });
});

describe('GET /credits/my-statement — student self-service', () => {
  it('student gets their own statement without finance:read', async () => {
    const { student, school } = await setup(7);
    const stu = await prisma.studentProfile.findUnique({ where: { id: student.id }, select: { userId: true } });
    const app = buildApp({ userId: stu!.userId, schoolId: school.id, role: 'STUDENT', tokenVersion: 0 });

    await prisma.lessonCreditLog.create({
      data: { schoolId: school.id, studentProfileId: student.id, amount: 7, reason: 'top-up', type: 'MANUAL_ADD', createdAt: inMonth(2) },
    });

    const res = await request(app).get('/credits/my-statement').query({ month: monthStr });
    expect(res.status).toBe(200);
    expect(res.body.data.closing).toBe(7);
    expect(res.body.data.foots).toBe(true);
  });

  it('student is denied the admin statement route (403)', async () => {
    const { student, school } = await setup(0);
    const stu = await prisma.studentProfile.findUnique({ where: { id: student.id }, select: { userId: true } });
    const app = buildApp({ userId: stu!.userId, schoolId: school.id, role: 'STUDENT', tokenVersion: 0 });

    const res = await request(app).get(`/credits/statement/${student.id}`).query({ month: monthStr });
    expect(res.status).toBe(403);
  });
});
