/**
 * Phase 7 — Observability & Recovery tests
 *
 * Covers:
 *  - Health endpoints (/health/live, /health/ready, /health/deep)
 *  - X-Request-ID correlation header (echoed back, auto-generated)
 *  - Prometheus /metrics endpoint (format and key metric names)
 *  - Cron state getCronState() initial shape
 *  - Audit log security filter (?securityOnly=true)
 *  - Admin recovery routes (invalidate-sessions, webhook-disable,
 *    idempotency cleanup-stuck, subscription override)
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.NODE_ENV = 'test';

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Server } from 'http';

const { prisma, cleanDb } = require('../helpers/testDb');
const { Role } = require('@prisma/client');

import { getCronState } from '../../lib/cronJobs';

// ── Test server setup ─────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const express    = require('express');
  const cookieParser = require('cookie-parser');
  const { register } = require('../../lib/metrics');
  const { metricsMiddleware } = require('../../middleware/metricsMiddleware');
  const adminRoutes     = require('../../routes/admin').default;
  const superadminRoutes = require('../../routes/superadmin').default;
  const prismaLib = require('../../lib/prisma').default;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(metricsMiddleware);

  // Correlation ID
  const { randomUUID } = require('crypto');
  app.use((req: any, res: any, next: any) => {
    const id = req.headers['x-request-id'] || randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  });

  app.get('/health/live', (_req: any, res: any) => {
    res.status(200).json({ status: 'alive', ts: new Date().toISOString() });
  });

  app.get('/health/ready', async (_req: any, res: any) => {
    const issues: string[] = [];
    try {
      await prismaLib.$queryRaw`SELECT 1`;
    } catch {
      issues.push('database unreachable');
    }
    if (issues.length > 0) {
      return res.status(503).json({ status: 'not_ready', issues, ts: new Date().toISOString() });
    }
    res.status(200).json({ status: 'ready', ts: new Date().toISOString() });
  });

  app.get('/health/deep', async (_req: any, res: any) => {
    const mem = process.memoryUsage();
    const cronStateSnapshot = getCronState();
    let dbOk = false;
    let migrationVersion: string | null = null;
    try {
      await prismaLib.$queryRaw`SELECT 1`;
      dbOk = true;
      const result = await prismaLib.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 1
      `;
      migrationVersion = result[0]?.migration_name ?? null;
    } catch {}

    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      version: '1.0.0-test',
      env: 'test',
      uptime: Math.floor(process.uptime()),
      ts: new Date().toISOString(),
      db: { status: dbOk ? 'ok' : 'error', lastMigration: migrationVersion },
      redis: { status: 'disabled' },
      memory: {
        rss:  `${Math.round(mem.rss / 1024 / 1024)}MB`,
        heap: `${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      },
      cron: cronStateSnapshot,
    });
  });

  app.get('/metrics', async (_req: any, res: any) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/superadmin', superadminRoutes);

  server = app.listen(0, () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server failed to bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
    done();
  });
});

beforeEach(() => cleanDb());

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(err => (err ? reject(err) : resolve())),
  );
  await prisma.$disconnect();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function unique(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createSchool(overrides: Record<string, any> = {}) {
  const id = unique('obs-school');
  return prisma.school.create({
    data: {
      name: 'Observability Test School',
      slug: id,
      city: 'Bishkek',
      email: `${id}@test.local`,
      activeDays: [1, 2, 3, 4, 5],
      ...overrides,
    },
  });
}

async function createUser(role: string, schoolId: number | null, overrides: Record<string, any> = {}) {
  const id = unique(`obs-${role.toLowerCase()}`);
  const password = await bcrypt.hash('Pass123!', 10);
  return prisma.user.create({
    data: {
      schoolId,
      role,
      firstName: 'Obs',
      lastName: 'Test',
      email: `${id}@test.local`,
      password,
      emailVerified: true,
      tokenVersion: 0,
      ...overrides,
    },
  });
}

function signToken(user: any) {
  return jwt.sign(
    { userId: user.id, schoolId: user.schoolId ?? null, role: user.role, tokenVersion: user.tokenVersion },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' },
  );
}

async function req(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

// ── 1. Health endpoints ───────────────────────────────────────────────────────

describe('Health: /health/live', () => {
  it('returns 200 with status alive', async () => {
    const { status, body } = await req('/health/live');
    expect(status).toBe(200);
    expect(body.status).toBe('alive');
    expect(typeof body.ts).toBe('string');
  });
});

describe('Health: /health/ready', () => {
  it('returns 200 when DB is reachable', async () => {
    const { status, body } = await req('/health/ready');
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
  });
});

describe('Health: /health/deep', () => {
  it('returns 200 with full system shape', async () => {
    const { status, body } = await req('/health/deep');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.db).toBeDefined();
    expect(body.db.status).toBe('ok');
    expect(body.redis).toBeDefined();
    expect(body.memory).toBeDefined();
    expect(typeof body.memory.rss).toBe('string');
    expect(typeof body.memory.heap).toBe('string');
    expect(body.cron).toBeDefined();
  });

  it('includes version and env fields', async () => {
    const { body } = await req('/health/deep');
    expect(typeof body.version).toBe('string');
    expect(typeof body.env).toBe('string');
  });

  it('includes lastMigration if migrations table exists', async () => {
    const { body } = await req('/health/deep');
    // May be null in some test DB setups, but key must be present
    expect('lastMigration' in body.db).toBe(true);
  });
});

// ── 2. X-Request-ID correlation ───────────────────────────────────────────────

describe('Request correlation: X-Request-ID', () => {
  it('echoes back a provided X-Request-ID', async () => {
    const myId = 'test-correlation-id-12345';
    const { headers } = await req('/health/live', { headers: { 'x-request-id': myId } });
    expect(headers.get('x-request-id')).toBe(myId);
  });

  it('generates an X-Request-ID when none provided', async () => {
    const { headers } = await req('/health/live');
    const id = headers.get('x-request-id');
    expect(typeof id).toBe('string');
    expect(id!.length).toBeGreaterThan(0);
  });

  it('generates unique IDs for different requests', async () => {
    const [r1, r2] = await Promise.all([req('/health/live'), req('/health/live')]);
    const id1 = r1.headers.get('x-request-id');
    const id2 = r2.headers.get('x-request-id');
    expect(id1).not.toBe(id2);
  });
});

// ── 3. Prometheus metrics ─────────────────────────────────────────────────────

describe('Prometheus: /metrics endpoint', () => {
  it('returns 200 with prometheus content-type', async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    await response.text();
  });

  it('includes standard HTTP metric names', async () => {
    // Make a request so the counter has at least one entry
    await req('/health/live');

    const response = await fetch(`${baseUrl}/metrics`);
    const text = await response.text();

    expect(text).toContain('http_request_duration_seconds');
    expect(text).toContain('http_requests_total');
  });

  it('includes cron metric names', async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    const text = await response.text();
    expect(text).toContain('cron_runs_total');
    expect(text).toContain('cron_duration_seconds');
    expect(text).toContain('cron_consecutive_failures');
  });

  it('includes Node.js default metrics (process_cpu_seconds_total)', async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    const text = await response.text();
    expect(text).toContain('process_cpu_seconds_total');
  });
});

// ── 4. Cron state getCronState() ──────────────────────────────────────────────

describe('Cron state: getCronState()', () => {
  it('returns an object (empty or with known jobs)', () => {
    const state = getCronState();
    expect(state).toBeDefined();
    expect(typeof state).toBe('object');
  });

  it('each job entry has the expected CronJobState shape (if any exist)', () => {
    const state = getCronState();
    for (const [, jobState] of Object.entries(state)) {
      const s = jobState as any;
      expect('lastRunAt' in s).toBe(true);
      expect('lastDurationMs' in s).toBe(true);
      expect('lastStatus' in s).toBe(true);
      expect('consecutiveFailures' in s).toBe(true);
      expect('totalRuns' in s).toBe(true);
    }
  });
});

// ── 5. Audit log security filter ──────────────────────────────────────────────

describe('Audit log: securityOnly filter', () => {
  it('returns only security entityType entries when securityOnly=true', async () => {
    const school = await createSchool();
    const owner  = await createUser(Role.OWNER, school.id);
    const token  = signToken(owner);

    // Seed one schedule log entry and one security entry
    await prisma.scheduleActionLog.createMany({
      data: [
        {
          schoolId: school.id,
          userId:   owner.id,
          action:   'SESSION_UPDATE',
          entityType: 'session',
          before: {},
          after:  {},
        },
        {
          schoolId: school.id,
          userId:   owner.id,
          action:   'SECURITY:CLEAR_ALL_DATA',
          entityType: 'security',
          before: {},
          after:  {},
        },
      ],
    });

    const { status, body } = await req(
      '/api/v1/admin/audit-log?securityOnly=true',
      { token },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    // All returned entries must be security type
    for (const entry of body.data) {
      expect(entry.entityType).toBe('security');
    }

    // The schedule entry must NOT appear
    const nonSecurity = body.data.filter((e: any) => e.entityType !== 'security');
    expect(nonSecurity).toHaveLength(0);
  });

  it('response includes filters.securityEventTypes array', async () => {
    const school = await createSchool();
    const owner  = await createUser(Role.OWNER, school.id);
    const token  = signToken(owner);

    const { body } = await req('/api/v1/admin/audit-log', { token });
    expect(body.filters).toBeDefined();
    expect(Array.isArray(body.filters.securityEventTypes)).toBe(true);
    expect(body.filters.securityEventTypes.length).toBeGreaterThan(0);
  });

  it('without securityOnly returns all entity types', async () => {
    const school = await createSchool();
    const owner  = await createUser(Role.OWNER, school.id);
    const token  = signToken(owner);

    await prisma.scheduleActionLog.createMany({
      data: [
        { schoolId: school.id, userId: owner.id, action: 'SESSION_UPDATE', entityType: 'session', before: {}, after: {} },
        { schoolId: school.id, userId: owner.id, action: 'SECURITY:UPLOAD_REJECTED', entityType: 'security', before: {}, after: {} },
      ],
    });

    const { body } = await req('/api/v1/admin/audit-log', { token });
    const types = new Set(body.data.map((e: any) => e.entityType));
    expect(types.has('session')).toBe(true);
    expect(types.has('security')).toBe(true);
  });

  it('returns 403 for non-OWNER role', async () => {
    const school = await createSchool();
    const admin  = await createUser(Role.ADMIN, school.id);
    const token  = signToken(admin);

    const { status } = await req('/api/v1/admin/audit-log', { token });
    expect(status).toBe(403);
  });
});

// ── 6. Recovery tools ─────────────────────────────────────────────────────────

describe('Recovery: POST /superadmin/schools/:id/invalidate-sessions', () => {
  async function createSuperAdmin() {
    return createUser(Role.SUPERADMIN, null);
  }

  it('requires reason (min 5 chars)', async () => {
    const school = await createSchool();
    const sa     = await createSuperAdmin();
    const token  = signToken(sa);

    const { status, body } = await req(
      `/api/v1/superadmin/schools/${school.id}/invalidate-sessions`,
      { method: 'POST', body: { reason: 'hi' }, token },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('returns 404 for unknown school', async () => {
    const sa    = await createSuperAdmin();
    const token = signToken(sa);

    const { status } = await req(
      `/api/v1/superadmin/schools/999999/invalidate-sessions`,
      { method: 'POST', body: { reason: 'incident test reason' }, token },
    );
    expect(status).toBe(404);
  });

  it('bumps tokenVersion for all school users and returns usersAffected', async () => {
    const school  = await createSchool();
    const owner   = await createUser(Role.OWNER, school.id);
    const student = await createUser(Role.STUDENT, school.id);
    const sa      = await createSuperAdmin();
    const token   = signToken(sa);

    const { status, body } = await req(
      `/api/v1/superadmin/schools/${school.id}/invalidate-sessions`,
      { method: 'POST', body: { reason: 'incident-response-test' }, token },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.usersAffected).toBe(2); // owner + student

    // tokenVersion must have been incremented
    const updatedOwner = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(updatedOwner.tokenVersion).toBe(owner.tokenVersion + 1);

    const updatedStudent = await prisma.user.findUnique({ where: { id: student.id } });
    expect(updatedStudent.tokenVersion).toBe(student.tokenVersion + 1);
  });

  it('returns 403 for non-SUPERADMIN', async () => {
    const school = await createSchool();
    const owner  = await createUser(Role.OWNER, school.id);
    const token  = signToken(owner);

    const { status } = await req(
      `/api/v1/superadmin/schools/${school.id}/invalidate-sessions`,
      { method: 'POST', body: { reason: 'unauthorized attempt' }, token },
    );
    expect(status).toBe(403);
  });
});

describe('Recovery: POST /superadmin/webhooks/:id/disable', () => {
  async function createSuperAdmin() {
    return createUser(Role.SUPERADMIN, null);
  }

  it('requires reason', async () => {
    const school  = await createSchool();
    const webhook = await prisma.webhook.create({
      data: { schoolId: school.id, url: 'https://example.com/hook', events: ['SESSION_CREATED'], secret: 'abc', isActive: true },
    });
    const sa    = await createSuperAdmin();
    const token = signToken(sa);

    const { status } = await req(
      `/api/v1/superadmin/webhooks/${webhook.id}/disable`,
      { method: 'POST', body: {}, token },
    );
    expect(status).toBe(400);
  });

  it('sets isActive=false for an active webhook', async () => {
    const school  = await createSchool();
    const webhook = await prisma.webhook.create({
      data: { schoolId: school.id, url: 'https://example.com/hook', events: ['SESSION_CREATED'], secret: 'abc', isActive: true },
    });
    const sa    = await createSuperAdmin();
    const token = signToken(sa);

    const { status, body } = await req(
      `/api/v1/superadmin/webhooks/${webhook.id}/disable`,
      { method: 'POST', body: { reason: 'SSRF mitigation test' }, token },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.wasActive).toBe(true);

    const updated = await prisma.webhook.findUnique({ where: { id: webhook.id } });
    expect(updated.isActive).toBe(false);
  });

  it('returns 404 for unknown webhook', async () => {
    const sa    = await createSuperAdmin();
    const token = signToken(sa);

    const { status } = await req(
      `/api/v1/superadmin/webhooks/999999/disable`,
      { method: 'POST', body: { reason: 'test reason here' }, token },
    );
    expect(status).toBe(404);
  });
});

describe('Recovery: POST /superadmin/idempotency/cleanup-stuck', () => {
  async function createSuperAdmin() {
    return createUser(Role.SUPERADMIN, null);
  }

  it('requires reason', async () => {
    const sa    = await createSuperAdmin();
    const token = signToken(sa);

    const { status } = await req(
      '/api/v1/superadmin/idempotency/cleanup-stuck',
      { method: 'POST', body: { olderThanMinutes: 60 }, token },
    );
    expect(status).toBe(400);
  });

  it('deletes IN_PROGRESS keys older than threshold and returns count', async () => {
    const school = await createSchool();

    const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
    const recentDate = new Date(Date.now() - 5 * 60 * 1000);   // 5 min ago

    await prisma.idempotencyKey.createMany({
      data: [
        // Stuck (old, IN_PROGRESS) → should be deleted
        {
          schoolId: school.id, actorId: 1, endpoint: '/test', key: 'stuck-old-1',
          status: 'IN_PROGRESS', requestHash: 'hash1', startedAt: oldDate,
          expiresAt: new Date(Date.now() + 86400000),
        },
        // Recent IN_PROGRESS → should NOT be deleted (below threshold)
        {
          schoolId: school.id, actorId: 1, endpoint: '/test', key: 'recent-1',
          status: 'IN_PROGRESS', requestHash: 'hash2', startedAt: recentDate,
          expiresAt: new Date(Date.now() + 86400000),
        },
        // Completed (old) → should NOT be deleted (wrong status)
        {
          schoolId: school.id, actorId: 1, endpoint: '/test', key: 'completed-1',
          status: 'COMPLETED', requestHash: 'hash3', startedAt: oldDate,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ],
    });

    const sa    = await createSuperAdmin();
    const token = signToken(sa);

    const { status, body } = await req(
      '/api/v1/superadmin/idempotency/cleanup-stuck',
      { method: 'POST', body: { reason: 'post-deploy cleanup test', olderThanMinutes: 120 }, token },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.deletedCount).toBe(1); // only the stuck-old-1

    // Recent and completed must remain
    const remaining = await prisma.idempotencyKey.findMany({ where: { schoolId: school.id } });
    expect(remaining).toHaveLength(2);
    const statuses = remaining.map((k: any) => k.status);
    expect(statuses).toContain('IN_PROGRESS'); // recent one survived
    expect(statuses).toContain('COMPLETED');
  });
});

describe('Recovery: PATCH /superadmin/schools/:id/subscription', () => {
  async function createSuperAdmin() {
    return createUser(Role.SUPERADMIN, null);
  }

  it('requires reason', async () => {
    const school = await createSchool();
    await prisma.subscription.create({
      data: { schoolId: school.id, status: 'TRIALING', plan: 'TRIAL' },
    });
    const sa    = await createSuperAdmin();
    const token = signToken(sa);

    const { status } = await req(
      `/api/v1/superadmin/schools/${school.id}/subscription`,
      { method: 'PATCH', body: { status: 'ACTIVE' }, token },
    );
    expect(status).toBe(400);
  });

  it('rejects invalid status values', async () => {
    const school = await createSchool();
    await prisma.subscription.create({
      data: { schoolId: school.id, status: 'TRIALING', plan: 'TRIAL' },
    });
    const sa    = await createSuperAdmin();
    const token = signToken(sa);

    const { status, body } = await req(
      `/api/v1/superadmin/schools/${school.id}/subscription`,
      { method: 'PATCH', body: { status: 'INVALID_STATUS', reason: 'test reason here' }, token },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('updates subscription status and returns previous + new', async () => {
    const school = await createSchool();
    await prisma.subscription.create({
      data: { schoolId: school.id, status: 'TRIALING', plan: 'TRIAL' },
    });
    const sa    = await createSuperAdmin();
    const token = signToken(sa);

    const { status, body } = await req(
      `/api/v1/superadmin/schools/${school.id}/subscription`,
      { method: 'PATCH', body: { status: 'ACTIVE', reason: 'manual activation for beta school' }, token },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.previousStatus).toBe('TRIALING');
    expect(body.data.status).toBe('ACTIVE');

    const sub = await prisma.subscription.findUnique({ where: { schoolId: school.id } });
    expect(sub.status).toBe('ACTIVE');
  });

  it('returns 404 when subscription does not exist for school', async () => {
    const school = await createSchool(); // no subscription created
    const sa     = await createSuperAdmin();
    const token  = signToken(sa);

    const { status } = await req(
      `/api/v1/superadmin/schools/${school.id}/subscription`,
      { method: 'PATCH', body: { status: 'ACTIVE', reason: 'no subscription test case' }, token },
    );
    expect(status).toBe(404);
  });
});
