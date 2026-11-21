/**
 * smoke-test.ts
 * Post-deploy smoke tests — verifies the live API is responding correctly.
 *
 * Usage:
 *   npx tsx scripts/smoke-test.ts
 *   npx tsx scripts/smoke-test.ts --base-url https://api.yourdomain.com
 *
 * Environment variables:
 *   API_BASE_URL       Override the target URL (alternative to --base-url flag)
 *   SMOKE_TIMEOUT_MS   Per-request timeout in ms (default: 10000)
 *   SUPERADMIN_TOKEN   JWT for an authenticated SUPERADMIN — enables tenant check
 *
 * Exit 0  = all critical tests passed.
 * Exit 1  = one or more CRITICAL tests failed.
 *
 * Two test categories:
 *   CRITICAL  — fail the deploy gate (server down, DB down, auth broken)
 *   ADVISORY  — warn but do not block (Redis optional, metrics firewalled)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

// ── CLI / env config ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const baseUrlFlagIdx = args.indexOf('--base-url');
const BASE_URL = (
  baseUrlFlagIdx !== -1
    ? args[baseUrlFlagIdx + 1]
    : (process.env.API_BASE_URL ?? 'http://localhost:3001')
).replace(/\/$/, '');

const TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT_MS ?? '10000', 10);

// ── Output helpers ────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

interface TestResult {
  name:       string;
  critical:   boolean;
  passed:     boolean;
  message:    string;
  durationMs: number;
}

const results: TestResult[] = [];

function addResult(
  name: string, critical: boolean, passed: boolean, message: string, durationMs: number,
) {
  results.push({ name, critical, passed, message, durationMs });
  const icon = passed
    ? `${GREEN}✓${RESET}`
    : critical ? `${RED}✗${RESET}` : `${YELLOW}⚠${RESET}`;
  const tag  = critical ? '' : ' [advisory]';
  console.log(`${icon} [${durationMs}ms]${tag} ${name}: ${message}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function httpGet(
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${urlPath}`, {
      signal:  controller.signal,
      headers: { Accept: 'application/json', ...headers },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body, ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}

async function httpPost(
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${urlPath}`, {
      method:  'POST',
      signal:  controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body:    JSON.stringify(body),
    });
    const resBody = await res.json().catch(() => ({}));
    return { status: res.status, body: resBody, ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}

// ── Test runner ───────────────────────────────────────────────────────────────

async function test(
  name: string,
  critical: boolean,
  fn: () => Promise<{ passed: boolean; message: string }>,
) {
  const start = Date.now();
  try {
    const { passed, message } = await fn();
    addResult(name, critical, passed, message, Date.now() - start);
  } catch (err: any) {
    const msg = err.name === 'AbortError'
      ? `Timed out after ${TIMEOUT_MS}ms`
      : `Error: ${err.message}`;
    addResult(name, critical, false, msg, Date.now() - start);
  }
}

// ── Smoke tests ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Shamdan Smoke Tests ===`);
  console.log(`Target  : ${BASE_URL}`);
  console.log(`Timeout : ${TIMEOUT_MS}ms`);
  console.log(`Started : ${new Date().toISOString()}\n`);

  // 1. Liveness — process alive (fastest check, no DB)
  await test('health/live', true, async () => {
    const r = await httpGet('/health/live');
    if (r.status !== 200)         return { passed: false, message: `Expected 200, got ${r.status}` };
    if (r.body?.status !== 'alive') return { passed: false, message: `status field: "${r.body?.status}"` };
    return { passed: true, message: 'alive' };
  });

  // 2. Readiness — DB connected
  await test('health/ready', true, async () => {
    const r = await httpGet('/health/ready');
    if (r.status !== 200) return { passed: false, message: `Got ${r.status} — DB may be down` };
    return { passed: true, message: r.body?.status ?? 'ready' };
  });

  // 3. Deep health — DB status + last migration
  await test('health/deep — db', true, async () => {
    const r = await httpGet('/health/deep');
    if (r.status !== 200) return { passed: false, message: `Got HTTP ${r.status}` };
    const dbStatus = r.body?.db?.status;
    if (dbStatus !== 'ok') return { passed: false, message: `db.status = "${dbStatus}"` };
    const migration = r.body?.db?.lastMigration ?? 'unknown';
    return { passed: true, message: `ok — last migration: ${migration}` };
  });

  // 4. Redis status (advisory — Redis is optional for single-node)
  await test('health/deep — redis', false, async () => {
    const r = await httpGet('/health/deep');
    const redisStatus = r.body?.redis?.status;
    if (redisStatus === 'disabled') return { passed: true,  message: 'disabled (no REDIS_URL — acceptable for single node)' };
    if (redisStatus === 'ok')       return { passed: true,  message: 'connected' };
    return { passed: false, message: `redis.status = "${redisStatus}"` };
  });

  // 5. Cron state — check for consecutive failures (advisory)
  await test('health/deep — cron', false, async () => {
    const r = await httpGet('/health/deep');
    const cron = r.body?.cron as Record<string, any> | undefined;
    if (!cron) return { passed: true, message: 'cron state not available (server may be freshly started)' };

    const failing = Object.entries(cron)
      .filter(([, s]) => (s as any).consecutiveFailures >= 3)
      .map(([name]) => name);

    if (failing.length > 0) {
      return { passed: false, message: `Jobs with 3+ consecutive failures: ${failing.join(', ')}` };
    }
    return { passed: true, message: `${Object.keys(cron).length} job(s) healthy` };
  });

  // 6. Auth endpoint reachable — wrong creds return 400/401, not 500/502/503
  await test('auth/login — endpoint reachable', true, async () => {
    const r = await httpPost('/api/v1/auth/login', {
      email:    '__smoke_test_nonexistent@eduschool.invalid',
      password: '__invalid_smoke_password__',
      slug:     '__smoke__',
    });
    if (r.status >= 500) {
      return { passed: false, message: `Server-side error ${r.status} — auth layer may be broken` };
    }
    // 400 (missing field), 401 (wrong creds), 404 (school not found) all indicate the route is up
    return { passed: true, message: `Auth layer responding (${r.status})` };
  });

  // 7. API /v1 prefix mounted correctly — wrong/no token returns 401, not 404
  await test('api/v1 — routes mounted', true, async () => {
    const r = await httpGet('/api/v1/auth/me');
    if (r.status === 404) {
      return { passed: false, message: '404 — /api/v1 routes may not be mounted' };
    }
    if (r.status >= 500) {
      return { passed: false, message: `Server error ${r.status} on /api/v1/auth/me` };
    }
    // Expect 401 (no auth token)
    return { passed: true, message: `API prefix accessible (${r.status})` };
  });

  // 8. Prometheus metrics endpoint (advisory — firewalled in production is OK)
  await test('GET /metrics', false, async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${BASE_URL}/metrics`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 200) return { passed: true,  message: 'Prometheus metrics available' };
      return { passed: false, message: `Got ${res.status}` };
    } catch {
      return { passed: false, message: 'Not reachable — OK if firewalled in production' };
    }
  });

  // 9. Authenticated SUPERADMIN check (only if SUPERADMIN_TOKEN is set)
  const token = process.env.SUPERADMIN_TOKEN;
  if (token) {
    await test('superadmin/schools — authenticated request', true, async () => {
      const r = await httpGet('/api/v1/superadmin/schools', {
        Authorization: `Bearer ${token}`,
      });
      if (r.status === 200) return { passed: true,  message: `Schools list returned (${Array.isArray(r.body?.data) ? r.body.data.length : '?'} schools)` };
      if (r.status === 401) return { passed: false, message: 'SUPERADMIN_TOKEN is invalid or expired' };
      if (r.status === 403) return { passed: false, message: 'Token is valid but role is not SUPERADMIN' };
      return { passed: false, message: `Unexpected ${r.status}` };
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const criticalFailed  = results.filter(r => r.critical  && !r.passed);
  const advisoryFailed  = results.filter(r => !r.critical && !r.passed);
  const totalPassed     = results.filter(r => r.passed).length;

  console.log(`\n=== Summary: ${totalPassed}/${results.length} passed ===`);

  if (advisoryFailed.length > 0) {
    console.warn(
      `${YELLOW}Advisory (non-blocking): ${advisoryFailed.map(r => r.name).join(', ')}${RESET}`,
    );
  }

  if (criticalFailed.length === 0) {
    console.log(`${GREEN}Smoke tests PASSED — deployment looks healthy.${RESET}\n`);
    process.exit(0);
  } else {
    console.error(`\n${RED}Smoke tests FAILED — critical issues:${RESET}`);
    for (const r of criticalFailed) {
      console.error(`  ✗ ${r.name}: ${r.message}`);
    }
    console.error('');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke-test fatal error:', err);
  process.exit(1);
});
