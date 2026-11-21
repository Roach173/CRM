import { register, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

// Collect default Node.js metrics (event loop lag, GC, memory, process CPU)
collectDefaultMetrics({ register });

// ── HTTP ─────────────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

// ── Auth ──────────────────────────────────────────────────────────────────────

export const authFailureTotal = new Counter({
  name: 'auth_failures_total',
  help: 'Total number of authentication failures',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const rateLimitTotal = new Counter({
  name: 'rate_limit_triggered_total',
  help: 'Total number of rate limit rejections',
  labelNames: ['endpoint'] as const,
  registers: [register],
});

// ── Upload ────────────────────────────────────────────────────────────────────

export const uploadRejectTotal = new Counter({
  name: 'upload_rejections_total',
  help: 'Total number of upload rejections',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const uploadSuccessTotal = new Counter({
  name: 'uploads_total',
  help: 'Total number of successful uploads',
  registers: [register],
});

// ── Webhooks ──────────────────────────────────────────────────────────────────

export const webhookDeliveryTotal = new Counter({
  name: 'webhook_deliveries_total',
  help: 'Total webhook delivery attempts',
  labelNames: ['status'] as const, // delivered | failed | ssrf_blocked
  registers: [register],
});

// ── Idempotency ───────────────────────────────────────────────────────────────

export const idempotencyReplayTotal = new Counter({
  name: 'idempotency_replays_total',
  help: 'Total number of idempotency key replays (duplicate requests)',
  registers: [register],
});

// ── Cron ──────────────────────────────────────────────────────────────────────

export const cronRunTotal = new Counter({
  name: 'cron_runs_total',
  help: 'Total number of cron job executions',
  labelNames: ['job', 'status'] as const, // status: success | failure | skipped
  registers: [register],
});

export const cronDuration = new Histogram({
  name: 'cron_duration_seconds',
  help: 'Duration of cron job execution',
  labelNames: ['job'] as const,
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const cronConsecutiveFailures = new Gauge({
  name: 'cron_consecutive_failures',
  help: 'Number of consecutive failures for each cron job',
  labelNames: ['job'] as const,
  registers: [register],
});

export const cronLastRunTimestamp = new Gauge({
  name: 'cron_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last cron job run',
  labelNames: ['job'] as const,
  registers: [register],
});
// ── Queue ─────────────────────────────────────────────────────────────────────


export const queueJobTotal = new Counter({
  name: 'queue_jobs_total',
  help: 'Total number of queue jobs processed',
  labelNames: ['queue', 'status'] as const, // status: completed | failed
  registers: [register],
});

// ── DB / Redis ────────────────────────────────────────────────────────────────

export const redisHitMissTotal = new Counter({
  name: 'redis_operations_total',
  help: 'Redis cache hits and misses',
  labelNames: ['operation', 'result'] as const, // result: hit | miss
  registers: [register],
});

// ── Security ──────────────────────────────────────────────────────────────────

export const securityEventTotal = new Counter({
  name: 'security_events_total',
  help: 'Total number of security events logged',
  labelNames: ['event'] as const,
  registers: [register],
});

export { register };
