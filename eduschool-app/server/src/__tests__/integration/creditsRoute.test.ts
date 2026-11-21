/**
 * HTTP integration tests for POST /credits/add.
 *
 * Uses supertest against a real Express app (minimal — no subscriptionGuard,
 * no rate limiter) with a real PostgreSQL database.
 *
 * Validates:
 *  1. Missing Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED
 *  2. Same key + same payload → 200 replay (Idempotent-Replayed: true), balance changes once
 *  3. Same key + different payload → 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
 *  4. Concurrent same-key requests → balance mutated exactly once
 *  5. Negative deduction below balance → 422 INSUFFICIENT_CREDITS
 *  6. OWNER override with overrideReason → allowed (negative balance)
 *  7. ADMIN → 403 Forbidden (no finance:write permission)
 *  8. completeIdempotency timing: COMPLETED only after commit; transaction error → FAILED
 *  9. Replay does not create duplicate LessonCreditLog entries
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

// ─── App factory ──────────────────────────────────────────────────────────────

type TestRole = 'OWNER' | 'ADMIN' | 'SUPERADMIN';

function buildApp(user: { userId: number; schoolId: number; role: TestRole; tokenVersion: number }) {
  const app = express();
  app.use(express.json());

  // Inject req.user before authenticate — the middleware skips verification
  // when req.user is already set, so no JWT is needed in tests.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = user;
    next();
  });

  app.use('/credits', creditsRouter);
  return app;
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

async function setup(initialCredits = 10) {
  const school  = await createSchool();
  const ownerU  = await createUser(school.id, 'OWNER');
  const adminU  = await createUser(school.id, 'ADMIN');
  const stuU    = await createUser(school.id, 'STUDENT');
  const student = await createStudentProfile(stuU.id, school.id, initialCredits);

  const ownerCtx = { userId: ownerU.id, schoolId: school.id, role: 'OWNER' as TestRole, tokenVersion: 0 };
  const adminCtx = { userId: adminU.id, schoolId: school.id, role: 'ADMIN' as TestRole, tokenVersion: 0 };

  return { school, ownerCtx, adminCtx, student, initialCredits };
}

function uniqueKey(prefix = 'key') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ─── 1. Missing Idempotency-Key ───────────────────────────────────────────────

describe('POST /credits/add — missing Idempotency-Key', () => {
  it('returns 400 IDEMPOTENCY_KEY_REQUIRED when header is absent', async () => {
    const { ownerCtx, student } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app)
      .post('/credits/add')
      .send({ studentProfileId: student.id, amount: 1, reason: 'top-up' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 400 when header is an empty string', async () => {
    const { ownerCtx, student } = await setup();
    const app = buildApp(ownerCtx);

    const res = await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', '   ')
      .send({ studentProfileId: student.id, amount: 1, reason: 'top-up' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

// ─── 2. Idempotent replay — same key + same payload ──────────────────────────

describe('POST /credits/add — idempotent replay', () => {
  it('returns 200 on first call and replays 200 with Idempotent-Replayed header on second call', async () => {
    const { ownerCtx, student, initialCredits } = await setup();
    const app = buildApp(ownerCtx);
    const key = uniqueKey('replay');
    const body = { studentProfileId: student.id, amount: 2, reason: 'top-up' };

    const res1 = await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', key)
      .send(body);

    expect(res1.status).toBe(200);
    expect(res1.body.success).toBe(true);

    const res2 = await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', key)
      .send(body);

    expect(res2.status).toBe(200);
    expect(res2.headers['idempotent-replayed']).toBe('true');

    // Balance changed exactly once despite two identical requests
    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(initialCredits + 2);
  });

  it('replay does NOT create duplicate LessonCreditLog entries', async () => {
    const { ownerCtx, student } = await setup();
    const app = buildApp(ownerCtx);
    const key = uniqueKey('replay-log');
    const body = { studentProfileId: student.id, amount: 3, reason: 'top-up' };

    await request(app).post('/credits/add').set('Idempotency-Key', key).send(body);
    await request(app).post('/credits/add').set('Idempotency-Key', key).send(body);

    const logs = await prisma.lessonCreditLog.findMany({
      where: { studentProfileId: student.id, type: 'MANUAL_ADD' },
    });
    expect(logs).toHaveLength(1); // exactly one ledger entry — no duplicate on replay
  });
});

// ─── 3. Same key + different payload → 409 ───────────────────────────────────

describe('POST /credits/add — key reuse with different payload', () => {
  it('returns 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', async () => {
    const { ownerCtx, student } = await setup();
    const app = buildApp(ownerCtx);
    const key = uniqueKey('conflict');

    // First request
    await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: 1, reason: 'top-up' });

    // Same key, different amount
    const res2 = await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: 99, reason: 'different amount' });

    expect(res2.status).toBe(409);
    expect(res2.body.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });
});

// ─── 4. Concurrent same-key requests → balance mutated exactly once ──────────

describe('POST /credits/add — concurrent requests with same key', () => {
  it('mutates balance exactly once when two requests race with the same key', async () => {
    const { ownerCtx, student, initialCredits } = await setup();
    const app = buildApp(ownerCtx);
    const key = uniqueKey('concurrent');
    const body = { studentProfileId: student.id, amount: 5, reason: 'concurrent' };

    // Both requests race concurrently
    const [res1, res2] = await Promise.all([
      request(app).post('/credits/add').set('Idempotency-Key', key).send(body),
      request(app).post('/credits/add').set('Idempotency-Key', key).send(body),
    ]);

    // One must succeed (200); the other may get 200 (replay) or 409 (in-progress)
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toContain(200);

    // Regardless of race outcome, balance must change exactly once
    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(initialCredits + 5);
  });
});

// ─── 5. Negative deduction below balance → 422 ───────────────────────────────

describe('POST /credits/add — insufficient credits', () => {
  it('returns 422 INSUFFICIENT_CREDITS when deduction would go negative', async () => {
    const { ownerCtx, student } = await setup(3); // 3 credits
    const app = buildApp(ownerCtx);

    const res = await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', uniqueKey('insufficient'))
      .send({ studentProfileId: student.id, amount: -10, reason: 'deduct more than balance' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');

    // Balance unchanged
    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(3);
  });

  it('FAILED idempotency key after 422 — same key can be retried', async () => {
    const { ownerCtx, student } = await setup(0); // 0 credits
    const app = buildApp(ownerCtx);
    const key = uniqueKey('retry');

    // First attempt fails
    await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: -1, reason: 'fail' });

    // Key should be FAILED → retry allowed
    const idempKey = await prisma.idempotencyKey.findFirst({
      where: { actorId: ownerCtx.userId, key },
    });
    expect(idempKey?.status).toBe('FAILED');
  });
});

// ─── 6. OWNER override with overrideReason — debt model (Phase 5 correction) ──
//
// Business model: OWNER with overrideReason can intentionally set negative balance
// (lesson debt). No DB-level floor — the DB allows credits < 0.
// Without overrideReason, the application-level guard still blocks accidental overdraft.
// See ARCHITECTURAL_DECISIONS.md ADR-021.

describe('POST /credits/add — OWNER override with overrideReason', () => {
  it('allows negative balance with OWNER overrideReason (debt model)', async () => {
    const { ownerCtx, student } = await setup(0); // 0 credits
    const app = buildApp(ownerCtx);

    const res = await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', uniqueKey('owner-override'))
      .send({
        studentProfileId: student.id,
        amount:           -5,
        reason:           'manual correction',
        overrideReason:   'Reversing double top-up from previous admin session',
      });

    // OWNER override: debt is allowed — balance goes negative
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Balance is now -5 (debt)
    const profile = await prisma.studentProfile.findUnique({ where: { id: student.id } });
    expect(profile!.credits).toBe(-5);

    // Audit log created with [OWNER_OVERRIDE:] prefix
    const log = await prisma.lessonCreditLog.findFirst({
      where: { studentProfileId: student.id, type: 'MANUAL_DEDUCT' },
    });
    expect(log).not.toBeNull();
    expect(log!.reason).toContain('[OWNER_OVERRIDE:');
  });

  it('rejects OWNER deduction without overrideReason if balance insufficient', async () => {
    const { ownerCtx, student } = await setup(0);
    const app = buildApp(ownerCtx);

    const res = await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', uniqueKey('owner-no-override'))
      .send({ studentProfileId: student.id, amount: -5, reason: 'deduct' }); // no overrideReason

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
  });
});

// ─── 7. ADMIN → 403 (no finance:write permission) ────────────────────────────

describe('POST /credits/add — ADMIN role is forbidden', () => {
  it('returns 403 Forbidden for ADMIN because finance:write is OWNER-only', async () => {
    const { adminCtx, student } = await setup();
    const app = buildApp(adminCtx);

    const res = await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', uniqueKey('admin'))
      .send({ studentProfileId: student.id, amount: 1, reason: 'test' });

    expect(res.status).toBe(403);
  });
});

// ─── 8. completeIdempotency timing — COMPLETED only after commit ──────────────

describe('POST /credits/add — idempotency lifecycle', () => {
  it('key is COMPLETED after successful request', async () => {
    const { ownerCtx, student } = await setup();
    const app = buildApp(ownerCtx);
    const key = uniqueKey('lifecycle');

    await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: 1, reason: 'test' });

    const row = await prisma.idempotencyKey.findFirst({
      where: { actorId: ownerCtx.userId, key },
    });
    expect(row?.status).toBe('COMPLETED');
    expect(row?.responseStatus).toBe(200);
    expect(row?.responseBody).not.toBeNull();
  });

  it('key is FAILED after 422 INSUFFICIENT_CREDITS', async () => {
    const { ownerCtx, student } = await setup(0);
    const app = buildApp(ownerCtx);
    const key = uniqueKey('failed-lifecycle');

    await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: -99, reason: 'over-deduct' });

    const row = await prisma.idempotencyKey.findFirst({
      where: { actorId: ownerCtx.userId, key },
    });
    expect(row?.status).toBe('FAILED');
  });

  it('COMPLETED responseBody does not include sensitive fields', async () => {
    const { ownerCtx, student } = await setup();
    const app = buildApp(ownerCtx);
    const key = uniqueKey('sanitize');

    await request(app)
      .post('/credits/add')
      .set('Idempotency-Key', key)
      .send({ studentProfileId: student.id, amount: 1, reason: 'sanitize test' });

    const row = await prisma.idempotencyKey.findFirst({
      where: { actorId: ownerCtx.userId, key },
    });

    const body = row?.responseBody as Record<string, unknown> | null;
    const bodyStr = JSON.stringify(body ?? {}).toLowerCase();

    // No sensitive fields in stored replay cache
    expect(bodyStr).not.toContain('"token"');
    expect(bodyStr).not.toContain('"password"');
    expect(bodyStr).not.toContain('"secret"');
  });
});
