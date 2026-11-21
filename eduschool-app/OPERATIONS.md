# OPERATIONS.md — Shamdan Platform Operations Guide

**Last Updated:** 2026-08-02
**Audience:** On-call engineers, backend maintainers

---

## Health Checks

| Endpoint | Purpose | Expected Response |
|----------|---------|------------------|
| `GET /health/live` | k8s liveness — is the process running | 200 `{ status: 'alive' }` |
| `GET /health/ready` | k8s readiness — DB reachable, env configured | 200 `{ status: 'ready' }` |
| `GET /health` | Legacy combined health | 200 `{ status: 'healthy' }` |
| `GET /health/deep` | Full system report: DB, Redis, cron, memory, version | 200/503 JSON |

### `/health/deep` — Example Response

```json
{
  "status": "ok",
  "version": "1.2.0",
  "env": "production",
  "uptime": 3600,
  "db": { "status": "ok", "lastMigration": "20260527030000_phase5_db_invariants" },
  "redis": { "status": "ok" },
  "memory": { "rss": "120MB", "heap": "80MB / 100MB" },
  "cron": {
    "cleanupNotifications": {
      "lastRunAt": "2026-05-28T03:00:00.000Z",
      "lastDurationMs": 42,
      "lastStatus": "success",
      "consecutiveFailures": 0,
      "totalRuns": 7
    }
  }
}
```

---

## Prometheus Metrics

**Endpoint:** `GET /metrics` (restrict to internal network/VPC — no auth token)

### Key metrics to alert on

| Metric | Alert condition | Meaning |
|--------|----------------|---------|
| `cron_consecutive_failures{job="..."}` | ≥ 3 | Cron job failing repeatedly |
| `http_request_duration_seconds_p99` | > 2s | API latency degradation |
| `http_requests_total{status_code="5.."}` | rate spike | Server errors |
| `auth_failures_total{reason="invalid_token"}` | sustained high rate | Possible brute-force / token leak |
| `security_events_total{event="SSRF_BLOCKED"}` | any count | SSRF attempt — investigate immediately |
| `security_events_total{event="CLEAR_ALL_DATA"}` | any count | Destructive action — verify it was authorized |

### Recommended alert thresholds (production)

```yaml
# Pseudocode — adapt to your alerting system
cron_consecutive_failures >= 3  → PagerDuty P2
http_error_rate (5xx) > 5%      → PagerDuty P2
security_event SSRF_BLOCKED     → Slack #security-alerts immediately
auth_failures_total > 100/min   → Slack #security-alerts
heap usage > 80%                → Slack #ops
```

---

## Cron Jobs

All cron jobs run inside `withCronLock()` — distributed Redis lock prevents concurrent runs across instances.

| Job name | Schedule | What it does |
|----------|----------|-------------|
| `cleanupNotifications` | Daily | Delete notifications older than 90 days |
| `extendSessions` | Daily | Extend rolling 14-day session window |
| `archiveSessions` | Weekly | Archive old completed sessions |
| `churnRisk` | Daily | Flag students at risk of churning |
| `waitlistCleanup` | Daily | Remove expired enrollment requests |
| `idempotencyCleanup` | Daily | Remove expired COMPLETED/FAILED idempotency keys |
| `paidUntilRecompute` | Daily | Re-derive `paidUntil` from each student's credit balance |
| `financialConsistency` | Daily | Watchdog — report-only, never mutates |
| `scheduledCommunications` | Every 60s | Send due scheduled communications |

### Checking cron health

```bash
curl https://your-api/health/deep | jq .cron
```

A `consecutiveFailures >= 3` for any job means something is broken. Check logs:

```bash
# Filter cron errors in production logs
grep '"domain":"cron"' app.log | grep '"level":50'  # level 50 = error
```

---

## Log Format

All logs use structured JSON (pino). Every authenticated log line includes:

```json
{
  "level": 30,
  "time": 1716854400000,
  "domain": "auth",
  "requestId": "uuid-of-request",
  "schoolId": 42,
  "userId": 99,
  "msg": "..."
}
```

**Correlation:** Use `requestId` to trace a request across all log lines. The same `requestId` is returned in the `X-Request-ID` response header.

**Verbosity:** controlled by the `LOG_LEVEL` env var (default `info`). Set to `debug` temporarily to investigate an incident, then revert — `debug` is noisy at scale.

### HTTP access log

Every request produces one structured line (`domain: "http"`, via pino-http in `index.ts`): `req.id` (= `X-Request-ID`), method, url, statusCode, responseTime. `/health/*` and `/metrics` are excluded. Level by status: 2xx/3xx → `info`, 4xx → `warn`, 5xx or thrown error → `error`.

### Log levels

| Level | Meaning |
|-------|---------|
| `info` (30) | Normal operations |
| `warn` (40) | Security events (`SECURITY_EVENT:`), consecutive cron failures, recovery actions, 4xx responses |
| `error` (50) | Failures that need investigation |

### No `console.*` in app code

All app code under `server/src/` must log through `createLogger(domain)` from `src/lib/logger.ts` — console output bypasses JSON structure, levels, and the requestId/schoolId/userId mixin. Enforced by `npm run check:no-console` (part of `predeploy`). CLI scripts (`src/scripts/`) and tests are exempt; a rare intentional exception (pre-boot fatals in `index.ts`) carries a `// no-console-ok` marker. On the client, all `console.*` and `debugger` statements are stripped from production bundles (`esbuild.drop` in `vite.config.ts`); errors reach Sentry through `AppErrorBoundary`.

---

## Redis

Redis is optional — the app degrades gracefully without it.

**With Redis:** Cron lock, analytics cache (60s TTL), teacher calendar cache (120s TTL), notification queue (BullMQ).
**Without Redis:** No distributed cron lock (cron runs on every instance), no caching, no queue (BullMQ jobs skipped, notifications fall back to sync DB writes).

**Checking Redis:**

```bash
curl https://your-api/health | jq .redis
```

---

## Rate Limits

| Endpoint group | Limit | Window |
|----------------|-------|--------|
| Login | 10 | 15 min |
| Register | 3 | 1 hour |
| Attendance | 60 | 1 min |
| Session ensure | 30 | 1 min |
| Credits | 30 | 1 min |
| Upload | 10 | 1 min |
| Notifications | 20 | 1 min |
| General | 200 | 1 min |

Rate limit hits are logged as `SECURITY_EVENT: RATE_LIMIT_TRIGGERED` and increment `rate_limit_triggered_total{endpoint}`.

---

## Scaling Notes

- **Horizontal scaling:** Multiple instances work correctly. Redis cron lock prevents duplicate job runs. WebSocket rooms are per-school (Socket.IO), but sticky sessions required if not using Redis adapter.
- **DB at 50k students:** All critical queries are indexed. Pagination is server-side (max 100 rows/page). Never use `findMany` without `where: { schoolId }`.
- **Cache invalidation:** Analytics cache invalidated on attendance/credit changes. Subscription cache invalidated on status change.
