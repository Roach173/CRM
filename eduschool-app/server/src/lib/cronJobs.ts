import prisma from './prisma';
import { getRawRedis } from './cache';
import { createLogger } from './logger';
import { extendAllBlockSessions } from '../services/sessionService';
import { archiveOldSessions } from '../services/archivalService';
import { checkChurnRisk } from '../services/churnService';
import { cleanupExpiredEnrollmentRequests } from '../services/waitlistService';
import { cleanupExpiredIdempotencyKeys } from '../middleware/dbIdempotency';
import { processDueScheduledCampaigns } from '../services/communicationService';
import { recomputePaidUntilForSchool } from './paidUntilDerivation';
import { runChecks } from '../services/consistencyCheckService';
import { notifySchoolAdmins } from './notify';
import {
  cronRunTotal,
  cronDuration,
  cronConsecutiveFailures,
  cronLastRunTimestamp,
} from './metrics';

const log = createLogger('cron');

const DAY_MS  = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// ── Cron state tracking (in-memory, exposed via /health/deep) ─────────────────

interface CronJobState {
  lastRunAt: Date | null;
  lastDurationMs: number | null;
  lastStatus: 'success' | 'failure' | 'skipped' | null;
  consecutiveFailures: number;
  totalRuns: number;
}

const cronState: Record<string, CronJobState> = {};

function initJobState(name: string): CronJobState {
  if (!cronState[name]) {
    cronState[name] = {
      lastRunAt: null,
      lastDurationMs: null,
      lastStatus: null,
      consecutiveFailures: 0,
      totalRuns: 0,
    };
  }
  return cronState[name];
}

/** Returns a snapshot of all cron job states for /health/deep */
export function getCronState(): Record<string, CronJobState> {
  return cronState;
}

// ── Lua: release lock only if we still own it ─────────────────────────────────

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

/**
 * Wraps a cron function with:
 * - Redis distributed lock (prevents concurrent runs on multi-instance)
 * - Duration tracking
 * - Success/failure metrics
 * - Consecutive failure alerting
 */
async function withCronLock(name: string, ttlSec: number, fn: () => Promise<void>): Promise<void> {
  const state = initJobState(name);
  const r = getRawRedis();

  if (r) {
    const key   = `cron:lock:${name}`;
    const owner = `${process.pid}-${Date.now()}`;

    const acquired = await (r as any).call('SET', key, owner, 'NX', 'EX', String(ttlSec)).catch(() => null);
    if (!acquired) {
      log.info({ job: name }, 'skipped — another worker holds the lock');
      state.lastStatus = 'skipped';
      cronRunTotal.inc({ job: name, status: 'skipped' });
      return;
    }

    try {
      await runWithObservability(name, state, fn);
    } finally {
      await r.eval(RELEASE_LOCK_SCRIPT, 1, key, owner).catch(() => {});
    }
  } else {
    await runWithObservability(name, state, fn);
  }
}

async function runWithObservability(
  name: string,
  state: CronJobState,
  fn: () => Promise<void>,
): Promise<void> {
  const startMs = Date.now();
  state.lastRunAt = new Date();
  state.totalRuns++;
  cronLastRunTimestamp.set({ job: name }, startMs / 1000);

  const timer = cronDuration.startTimer({ job: name });
  try {
    await fn();
    const durationMs = Date.now() - startMs;
    state.lastDurationMs = durationMs;
    state.lastStatus = 'success';
    state.consecutiveFailures = 0;
    cronRunTotal.inc({ job: name, status: 'success' });
    cronConsecutiveFailures.set({ job: name }, 0);
    log.info({ job: name, durationMs }, 'cron job completed');
  } catch (err) {
    const durationMs = Date.now() - startMs;
    state.lastDurationMs = durationMs;
    state.lastStatus = 'failure';
    state.consecutiveFailures++;
    cronRunTotal.inc({ job: name, status: 'failure' });
    cronConsecutiveFailures.set({ job: name }, state.consecutiveFailures);
    log.error({ job: name, durationMs, err, consecutiveFailures: state.consecutiveFailures }, 'cron job failed');

    // Alert threshold: 3 consecutive failures for any critical job
    if (state.consecutiveFailures >= 3) {
      log.warn({ job: name, consecutiveFailures: state.consecutiveFailures }, 'CRON_ALERT: consecutive failures threshold reached');
    }
  } finally {
    timer();
  }
}

async function cleanupOldNotifications() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const { count } = await prisma.notification.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (count > 0) log.info({ count }, 'old notifications deleted');
}

// Multi-device login (no single-active-session revoke) means expired/revoked
// RefreshToken rows are no longer pruned as a side effect of the next login —
// sweep them here instead so the table doesn't grow unbounded at 50k+ users.
async function cleanupExpiredRefreshTokens() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const { count } = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }] },
  });
  if (count > 0) log.info({ count }, 'expired refresh tokens deleted');
}

export function calculateNextDailyRunDelay(
  hour: number,
  minute: number,
  now: Date = new Date(),
): number {
  const nextRun = new Date(now);
  nextRun.setHours(hour, minute, 0, 0);

  if (nextRun.getTime() <= now.getTime()) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun.getTime() - now.getTime();
}

// paidUntil is a projection anchored at "today": with zero balance events the
// stored date silently drifts into the past (or stays in the future after the
// balance hits 0 via a path that skipped recompute). Balance-event hooks can't
// heal time passing — only a periodic recompute can. Batched (500/tx inside),
// scales to 50k students.
async function recomputeAllPaidUntil() {
  const schools = await prisma.school.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  let checked = 0;
  let changed = 0;
  for (const s of schools) {
    const r = await recomputePaidUntilForSchool(prisma, s.id);
    checked += r.checked;
    changed += r.changed;
  }
  if (changed > 0) log.info({ schools: schools.length, checked, changed }, 'stale paidUntil dates re-derived from balance');
}

// Financial consistency watchdog. runChecks (15 checks: ghost billing, phantom
// salary, deduction without ledger entry, …) existed but only ran on demand —
// admin endpoint, post-import, manual script. Nightly run means a broken
// invariant is caught within a day, not when someone remembers to look.
// Read-only: violations are reported loudly (logs/Sentry), never auto-repaired.
async function financialConsistencyWatchdog() {
  const schools = await prisma.school.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  for (const s of schools) {
    const violations = await runChecks(s.id);
    for (const v of violations) {
      const entry = { event: 'CONSISTENCY_VIOLATION', schoolId: s.id, check: v.check, count: v.count, ids: v.ids };
      if (v.severity === 'CRITICAL') log.error(entry, 'FINANCIAL_ALERT: consistency check failed');
      else log.warn(entry, 'consistency check warning');
    }

    // Route for sign-off: CRITICAL findings must reach a human, not just Sentry.
    // Watchdog runs once a day → at most one notification per school per day.
    const criticals = violations.filter(v => v.severity === 'CRITICAL');
    if (criticals.length > 0) {
      const totalRecords = criticals.reduce((sum, v) => sum + v.count, 0);
      await notifySchoolAdmins(s.id, {
        type:  'FINANCIAL_CONSISTENCY_ALERT',
        title: 'Проблемы в финансовых данных',
        body:  `Ночная проверка нашла критические расхождения: ${criticals.length} тип(ов), ${totalRecords} запис(ей). Откройте «Финансовый контроль» для деталей.`,
        data:  { checks: criticals.map(v => ({ check: v.check, count: v.count })) },
      }).catch(e => log.error({ err: e, schoolId: s.id }, 'consistency alert notification failed'));
    }
  }
}

async function processScheduledCommunications() {
  const result = await processDueScheduledCampaigns();
  if (result.processed > 0) {
    log.info(result, 'Processed scheduled communications');
  }
}

export function startCronJobs() {
  if (process.env.DISABLE_CRON === 'true') {
    log.info({ event: 'scheduler_skipped_disabled' }, 'cron jobs skipped because DISABLE_CRON=true');
    return;
  }

  // Run immediately on startup (no lock needed — single startup per process)
  cleanupOldNotifications().catch(e => log.error({ err: e }, 'cleanup startup error'));
  cleanupExpiredRefreshTokens().catch(e => log.error({ err: e }, 'refresh token cleanup startup error'));
  extendAllBlockSessions().catch(e => log.error({ err: e }, 'sessions startup error'));
  cleanupExpiredEnrollmentRequests().catch(e => log.error({ err: e }, 'waitlist startup error'));
  cleanupExpiredIdempotencyKeys().catch(e => log.error({ err: e }, 'idempotency cleanup startup error'));
  recomputeAllPaidUntil().catch(e => log.error({ err: e }, 'paidUntil recompute startup error'));

  // Daily: cleanup notifications
  setInterval(
    () => withCronLock('cleanupNotifications', 300, cleanupOldNotifications)
            .catch(e => log.error({ err: e }, 'cleanup job error')),
    DAY_MS
  );

  // Daily: extend rolling session window
  setInterval(
    () => withCronLock('extendSessions', 300, extendAllBlockSessions)
            .catch(e => log.error({ err: e }, 'sessions job error')),
    DAY_MS
  );

  // Weekly: archive old sessions
  setInterval(
    () => withCronLock('archiveSessions', 600, archiveOldSessions)
            .catch(e => log.error({ err: e }, 'archive job error')),
    WEEK_MS
  );

  // Daily: cleanup expired/revoked refresh tokens
  setInterval(
    () => withCronLock('refreshTokenCleanup', 300, cleanupExpiredRefreshTokens)
            .catch(e => log.error({ err: e }, 'refresh token cleanup job error')),
    DAY_MS
  );

  // Daily: churn risk detection
  setInterval(
    () => withCronLock('churnRisk', 300, checkChurnRisk)
            .catch(e => log.error({ err: e }, 'churn job error')),
    DAY_MS
  );

  // Daily: cleanup expired enrollment requests
  setInterval(
    () => withCronLock('waitlistCleanup', 300, cleanupExpiredEnrollmentRequests)
            .catch(e => log.error({ err: e }, 'waitlist job error')),
    DAY_MS
  );

  // Daily: Phase 4 — cleanup COMPLETED/FAILED expired idempotency keys
  setInterval(
    () => withCronLock('idempotencyCleanup', 300, cleanupExpiredIdempotencyKeys)
            .catch(e => log.error({ err: e }, 'idempotency cleanup job error')),
    DAY_MS
  );

  // Daily: re-derive paidUntil from the credit balance for every student
  setInterval(
    () => withCronLock('paidUntilRecompute', 600, recomputeAllPaidUntil)
            .catch(e => log.error({ err: e }, 'paidUntil recompute job error')),
    DAY_MS
  );

  // Daily: financial consistency watchdog (report-only, never mutates)
  setInterval(
    () => withCronLock('financialConsistency', 600, financialConsistencyWatchdog)
            .catch(e => log.error({ err: e }, 'consistency watchdog job error')),
    DAY_MS
  );

  // Every 60 seconds: process scheduled communications
  setInterval(
    () => withCronLock('scheduledCommunications', 55, processScheduledCommunications)
            .catch(e => log.error({ err: e }, 'scheduled communications job error')),
    60_000
  );

  log.info('daily jobs scheduled (with distributed lock)');
}
