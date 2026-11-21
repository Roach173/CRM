# INCIDENT_RESPONSE.md — Shamdan Incident Response Playbook

**Last Updated:** 2026-05-28
**Audience:** On-call engineers

---

## Severity Levels

| Level | Definition | Response time |
|-------|-----------|---------------|
| P1 — Critical | Data loss, all schools down, security breach | Immediate (< 15 min) |
| P2 — High | One school down, payment broken, cron dead for 3+ runs | 1 hour |
| P3 — Medium | Degraded performance, one feature broken | Next business day |

---

## First Response Checklist

```
1. Check health endpoints immediately:
   curl https://api/health/deep | jq .

2. Check recent error logs:
   grep '"level":50' app.log | tail -50

3. Check Sentry for exception clusters.

4. Check Prometheus for metric anomalies (/metrics or Grafana).

5. Identify schoolId/requestId from logs to scope blast radius.
```

---

## Playbook: Database Unreachable

**Symptom:** `/health/ready` returns 503, `db: "error"`.

```
1. Confirm DB is running: psql $DATABASE_URL -c 'SELECT 1'
2. Check connection pool: active connections vs pg_stat_activity
3. Check disk space on DB host
4. If DB is up but connection pool exhausted: restart server process (SIGTERM → graceful shutdown)
5. If DB is genuinely down: follow DB failover runbook
```

**After resolution:** Run backup verification:
```bash
npx tsx server/scripts/verify-backup.ts
```

---

## Playbook: Suspected Data Breach / Token Leak

**Symptom:** Unusual `auth_failures_total` spike, Sentry reports from unfamiliar IPs, or report from user.

```
1. Identify affected schoolId from Sentry/logs.

2. Immediately invalidate all sessions for that school:
   POST /api/v1/superadmin/schools/:id/invalidate-sessions
   Body: { "reason": "Suspected token leak — incident YYYY-MM-DD" }
   (Bumps tokenVersion for all users + revokes all refresh tokens)

3. Check audit log for the school:
   GET /api/v1/admin/audit-log?securityOnly=true&dateFrom=<yesterday>
   Look for: CLEAR_ALL_DATA, EXPORT, SSRF_BLOCKED, PERMISSION_DENIED

4. Check raw logs for the requestId of suspicious requests:
   grep '"requestId":"<id>"' app.log

5. If breach confirmed: notify affected school owner, document timeline.

6. Rotate JWT_SECRET (will invalidate ALL tokens platform-wide — coordinate with all schools).
```

---

## Playbook: SSRF Attack Detected

**Symptom:** `security_events_total{event="SSRF_BLOCKED"}` count > 0, or Sentry event.

```
1. Find the blocked URL:
   GET /api/v1/admin/audit-log?securityOnly=true&action=SSRF_BLOCKED

2. Identify the schoolId / webhook that triggered it.

3. Force-disable the offending webhook:
   POST /api/v1/superadmin/webhooks/:id/disable
   Body: { "reason": "SSRF attempt blocked — incident YYYY-MM-DD" }

4. Notify school owner that their webhook URL was flagged and disabled.

5. If it's a legitimate internal webhook (misconfigured URL), let the admin reconfigure it.
```

---

## Playbook: Cron Job Failure (3+ Consecutive)

**Symptom:** `cron_consecutive_failures{job="X"} >= 3`, or `/health/deep` shows `lastStatus: "failure"`.

```
1. Identify which job is failing from /health/deep cron section.

2. Check error logs:
   grep '"domain":"cron","job":"<name>"' app.log | grep '"level":50'

3. Common causes:
   - DB unreachable → see DB unreachable playbook
   - Session extension: schema change, stale session state → check DB migration status
   - Churn risk: analytics query timeout → check query performance
   - Idempotency cleanup: already cleaned up, no-op → check if it's actually failing or just logging

4. If job is stuck in Redis lock (rare — lock TTL is 300s for most jobs, 600s for archive):
   Wait for lock to expire, or if Redis is reachable: DEL cron:lock:<name>

5. After fix, confirm next run succeeds via /health/deep.
```

---

## Playbook: Stuck Idempotency Keys Blocking Retries

**Symptom:** Client reports that retrying an action returns a stale response, or logs show `IN_PROGRESS` keys older than expected.

```
1. Identify stuck keys in Sentry/logs, or:
   GET /health/deep (check if any cron jobs report errors)

2. Check count of stuck keys (requires DB access):
   SELECT COUNT(*) FROM "IdempotencyKey" WHERE status = 'IN_PROGRESS' AND "startedAt" < NOW() - INTERVAL '2 hours';

3. Clean up stuck keys via recovery endpoint:
   POST /api/v1/superadmin/idempotency/cleanup-stuck
   Body: { "reason": "Stuck keys after deploy YYYY-MM-DD", "olderThanMinutes": 120 }

4. Confirm: client can now retry successfully.
```

---

## Playbook: Clear-All-Data Was Executed

**Symptom:** School reports missing data, or Sentry/audit log shows `CLEAR_ALL_DATA` event.

```
1. Audit log will show the event WITH reason and actor:
   GET /api/v1/admin/audit-log?securityOnly=true&action=CLEAR_ALL_DATA

2. Verify the actor was an authorized OWNER for that school.

3. If unauthorized: see Data Breach playbook.

4. If authorized (user accidentally cleared data): restore from backup.
   - Latest backup: see BACKUP_RESTORE.md
   - Verify backup integrity: npx tsx server/scripts/verify-backup.ts --backup-file path/to/dump.sql
```

---

## Key Contacts / Resources

- **Sentry:** Check `SENTRY_DSN` in `.env` for the project URL
- **Logs:** Structured JSON via pino — pipe to your log aggregator (Papertrail, Logtail, etc.)
- **Metrics:** `GET /metrics` (Prometheus format) — scrape from internal network only
- **Audit log API:** `GET /api/v1/admin/audit-log?securityOnly=true` (OWNER role required)
- **Recovery tools:** `POST /api/v1/superadmin/...` (SUPERADMIN role required)
