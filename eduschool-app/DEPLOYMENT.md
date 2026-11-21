# DEPLOYMENT.md — Shamdan

> **Purpose:** Complete guide for deploying Shamdan to production.

*Last Updated: 2026-08-09 (Railway migration: single project for API+Postgres+client, cross-origin client/API — see AI_SCHEDULE_HANDOFF.md changelog)*

---

## Architecture Overview (Production)

```
                    ┌─────────────┐
                    │   Nginx     │  ← reverse proxy + SSL + static files
                    └──────┬──────┘
                    ┌──────┴──────┐
          ┌─────────┤             ├─────────┐
          ▼                                 ▼
   ┌────────────┐                   ┌───────────────┐   ┌───────────────┐
   │  Frontend  │                   │  API Server   │   │  Worker       │
   │ (Vite SPA) │                   │ (Express)     │   │ (cron+queue)  │
   │ /var/www/  │                   │ port 3001     │   │ no HTTP port  │
   └────────────┘                   └───────┬───────┘   └───────┬───────┘
                                            │                   │
                              ┌─────────────┼───────────────────┘
                              │             │
                        ┌─────▼─────┐ ┌────▼──────┐
                        │ PostgreSQL │ │   Redis   │
                        │ port 5432  │ │ port 6379 │
                        └───────────┘ └───────────┘
```

- **API Server** — Express + Socket.IO, handles HTTP requests. Run with `DISABLE_CRON=true`.
- **Worker** — Standalone process: BullMQ queue consumer + daily cron jobs (session extension, archival, notification cleanup). No HTTP. Run exactly one worker unless infrastructure provides a singleton guarantee.
- **Redis** — Optional but recommended: BullMQ queue, Socket.IO adapter, analytics cache.

---

## Environment Variables

### Server (`server/.env`)

```env
# Required
DATABASE_URL="postgresql://postgres:<password>@localhost:5432/eduschool?connection_limit=10&pool_timeout=20"
JWT_SECRET="<minimum 32 chars — openssl rand -base64 32>"
PORT=3001
CLIENT_URL="https://yourdomain.com"

# Worker / cron
DISABLE_CRON=true          # API instances only. Leave unset/false on the singleton worker.

# Optional — Redis (BullMQ queue + Socket.IO adapter + cache)
REDIS_URL="redis://localhost:6379"

# Optional — Monitoring
SENTRY_DSN="https://xxx@sentry.io/yyy"

# Optional — DB pool override
DB_POOL_SIZE=10

# Required before go-live — Email (Resend, used for verification/password-reset/invite emails)
RESEND_API_KEY="re_xxxxxxxx"      # resend.com → API Keys
FROM_EMAIL="no-reply@yourdomain.com"  # must be on a domain verified in Resend — the
                                       # sandbox default onboarding@resend.dev only
                                       # delivers to your own Resend account email
```

### Client (`client/.env.production`)

```env
VITE_SENTRY_DSN="https://xxx@sentry.io/yyy"   # optional
```

> `VITE_API_BASE_URL` is not needed — Vite proxies `/api/*` to Express.
> If serving frontend from a different domain, set it to the API server URL.

---

## Pre-Deploy Checklist

Run these gates **before every production deploy**. All must pass (exit 0).

```bash
cd eduschool-app/server

# 1. Validate environment variables
NODE_ENV=production npm run validate:env:prod
#    ✓ DATABASE_URL set + SSL enforced
#    ✓ JWT_SECRET 32+ chars
#    ✓ CLIENT_URL set, https, no trailing slash
#    ⚠ REDIS_URL — warn if absent (acceptable for single node)
#    ⚠ SENTRY_DSN — warn if absent in production
#    ⚠ RESEND_API_KEY / FROM_EMAIL — warn if absent (verification/reset/invite emails won't deliver)

# 2. Check migration state (no pending or stuck migrations)
npm run migrate:check
#    ✓ All on-disk migrations applied to DB
#    ✓ No rolled-back or stuck migrations

# 3. TypeScript build (catches compile errors before deploy)
npm run build

# 4. Run full test suite (441 tests, ~10 min)
npm run test:integration
```

**Stop if any step fails.** Fix the issue and re-run from step 1.

---

## Step-by-Step Production Deploy

### 1. Database (PostgreSQL)

**Managed DB (Railway, Supabase, Neon) — recommended:**
```
DATABASE_URL="postgresql://user:pass@host:5432/eduschool?sslmode=require&connection_limit=10"
```

**Self-hosted (Docker):**
```bash
docker-compose up -d
docker ps | grep postgres   # verify running
```

### 2. Redis (Optional but Recommended)

Without Redis: notifications are synchronous (direct DB insert), Redis-based locks for some jobs are unavailable, and there is no Socket.IO scaling. Keep exactly one cron-enabled process. API instances should still use `DISABLE_CRON=true`; the worker should run cron.

```bash
# Docker
docker run -d --name redis -p 6379:6379 redis:alpine

# Or managed: Railway Redis, Upstash, Redis Cloud
```

Set `REDIS_URL` in server `.env`.

### 3. Apply Migrations

```bash
cd eduschool-app/server
npx prisma migrate deploy   # applies pending migrations — safe, no prompts
npx prisma generate         # regenerates Prisma Client
```

> **Never use `prisma migrate dev` in production** — requires shadow DB + interactive prompt.
> `migrate deploy` only runs committed migration files.

### 4. Build Frontend

```bash
cd eduschool-app/client
npm install
npm run build               # output: client/dist/
```

Copy `client/dist/` to Nginx static directory (e.g. `/var/www/eduschool/`).

### 5. Build Backend

```bash
cd eduschool-app/server
npm install
npm run build               # compiles TypeScript → dist/
```

### 6. PM2 — Process Manager

```bash
npm install -g pm2

# API server (one or more instances)
DISABLE_CRON=true pm2 start "npm run start" --name eduschool-api

# Worker (exactly ONE instance — handles cron + BullMQ queue)
pm2 start "npm run start:worker" --name eduschool-worker

# Persist and auto-restart on reboot
pm2 save
pm2 startup

# Useful commands
pm2 logs eduschool-api       # live API logs
pm2 logs eduschool-worker    # live worker logs
pm2 restart eduschool-api
pm2 status
```

> **Critical:** Run exactly ONE `eduschool-worker`. Multiple workers = duplicate cron jobs.
> API instances can be scaled freely (`pm2 scale eduschool-api 4`).

### 7. Nginx Configuration

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Frontend static files
    root /var/www/eduschool;
    index index.html;

    # React Router — all non-api routes fallback to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy to Express (v1 prefix — /api/v1/*)
    location /api/v1/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }

    # Health check (no version prefix — used by PM2/load balancer)
    location /health {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    # Socket.IO WebSocket proxy
    location /socket.io/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }

    client_max_body_size 15M;
}
```

> **Note:** Express is configured with `app.set('trust proxy', 1)` (`server/src/index.ts`) —
> it trusts exactly one proxy hop (this Nginx, or your host's load balancer — e.g. Railway's). This is required
> for per-IP rate limiting to key on the real client IP from `X-Forwarded-For`. If you add
> a second proxy layer (e.g. Cloudflare in front of Nginx), bump the hop count accordingly.

### 8. SSL (Let's Encrypt)

```bash
certbot --nginx -d yourdomain.com
certbot renew --dry-run      # test auto-renewal
```

---

## Cron Jobs (Worker Process)

The **worker** (`npm run start:worker`, which runs `dist/src/worker.js`) runs these jobs automatically:

| Job | Schedule | Function |
|-----|----------|---------|
| Session extension | Daily at startup + every 24h | `extendAllBlockSessions()` — generates sessions 14 days ahead |
| Session archival | Weekly (Sunday ~03:00) | `archiveOldSessions()` — moves sessions >24 months to archive tables |
| Notification cleanup | Daily | `cleanupOldNotifications()` — deletes notifications older than 90 days |

> Jobs are in `server/src/lib/cronJobs.ts` → `startCronJobs()`.
> Worker handles SIGTERM gracefully: drains queue → stops cron → disconnects Prisma.

---

## Post-Deploy Checklist

Run these gates **immediately after every production deploy**.

```bash
cd eduschool-app/server

# 1. Smoke tests (hits live API — wait 10–15s for server to start)
npm run smoke
# or with explicit URL:
npx tsx scripts/smoke-test.ts --base-url https://api.yourdomain.com
#    ✓ /health/live  → alive
#    ✓ /health/ready → DB connected
#    ✓ /health/deep  → db.status = ok, last migration shown
#    ✓ auth endpoint responding (401 on wrong creds, not 500)
#    ✓ /api/v1 prefix mounted

# 2. Confirm migration applied (post-deploy verification)
npm run migrate:check
#    ✓ Latest migration matches what was in the deploy diff

# 3. Verify backup health (confirm backup pipeline still working)
npm run verify:backup
```

**If smoke tests fail:** follow the Rollback Strategy below immediately.

---

## Rollback Strategy

> **Principle:** Never attempt to "fix forward" a broken deploy under pressure.
> Roll back first, diagnose after.

### Step 1 — Code Rollback

**Railway:**
```
1. Go to Railway → service → Deployments tab
2. Click the previous successful deploy → "Redeploy"
3. Wait for healthcheck to pass
4. Run: npm run smoke --base-url https://api.yourdomain.com
```

**PM2 / self-hosted:**
```bash
# The previous build is in dist/ — roll back by redeploying the previous tag/commit
git checkout <previous-sha>
cd eduschool-app/server && npm run build
pm2 restart eduschool-api eduschool-worker
```

### Step 2 — Migration Rollback Limitation

> **Prisma does NOT support automatic migration rollback.**
> `prisma migrate deploy` applies migrations forward-only. There is no `migrate rollback`.

**If the new deploy added a migration and rollback is needed:**

Option A — Schema is backward-compatible (column added, index added):
```
Rolling back the code is safe — old code ignores new columns.
The migration stays applied. No DB action needed.
```

Option B — Schema is NOT backward-compatible (column renamed, type changed, constraint added):
```
1. DO NOT roll back code without fixing the DB first.
2. Write a compensating migration that undoes the schema change:
   npx prisma migrate dev --name rollback_<name>  (on a local DB copy)
3. Apply the compensating migration to production BEFORE rolling back code:
   npx prisma migrate deploy
4. Then roll back the code.
```

Option C — DB is broken beyond compensating migration:
```
→ See DB Restore from Backup below.
```

### Step 3 — DB Restore from Backup (Last Resort)

Only needed if the deploy corrupted data or the schema cannot be repaired:

```bash
# 1. Stop all application processes
pm2 stop all

# 2. Create a post-deploy snapshot (preserve the broken state for forensics)
pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc \
  -f "broken_$(date +%Y%m%d_%H%M%S).dump"

# 3. Restore the last known-good backup (see BACKUP_RESTORE.md for full procedure)
pg_restore --no-owner --no-acl -d "$DATABASE_URL" \
  /backups/eduschool_<last_good_date>.dump

# 4. Verify restore
npx tsx server/scripts/verify-backup.ts

# 5. Re-apply migrations UP TO the pre-broken state (skip the bad migration)
npx prisma migrate deploy

# 6. Restart on the previous code version
pm2 start all

# 7. Smoke test
npm run smoke
```

**Estimated RTO:** 20–40 minutes for a full DB restore on Railway with a daily backup.
**RPO (data loss window):** Up to 24 hours if only daily backups. Reduce with more frequent dumps.

### Step 4 — Uploads Rollback (if file storage was affected)

```bash
# Restore uploads from backup
rsync -av /backup/uploads/ server/public/uploads/
# or from S3:
aws s3 sync s3://your-bucket/uploads/backup/ server/public/uploads/
```

### Rollback Decision Matrix

| Scenario | Action |
|----------|--------|
| Bug in new feature (no DB change) | Code rollback only |
| New column added, backward-compatible | Code rollback only |
| Column renamed / type changed | Compensating migration first, then code rollback |
| Constraint added that blocks existing data | Compensating migration (DROP CONSTRAINT) first |
| Data corruption / broken records | DB restore from backup |
| Auth broken (JWT_SECRET changed) | Revert JWT_SECRET in env, restart |
| All schools affected, data loss | P1 incident — DB restore + notify owners |

---

## Disaster Recovery

### Database Backups

**Railway (managed):**
- Backups are automatic. Go to Railway → Postgres service → Backups tab.
- Verify retention is set to **at least 7 days**.
- Test restore quarterly: create a branch DB and restore a backup.

**Self-hosted:**
```bash
# Backup (run via cron daily)
pg_dump -U postgres -d eduschool -Fc > /backups/eduschool_$(date +%Y%m%d_%H%M).dump

# Restore
pg_restore -U postgres -d eduschool_restore /backups/eduschool_20260510.dump

# Automated backup cron (add to crontab):
# 0 3 * * * pg_dump -U postgres -d eduschool -Fc > /backups/eduschool_$(date +\%Y\%m\%d).dump
```

### Credit Reconciliation (Financial Recovery)

If `StudentProfile.credits` becomes inconsistent with `LessonCreditLog`:

```bash
cd eduschool-app/server

# Preview (no changes)
npx tsx scripts/rebuild-credits.ts --dry

# Preview for one school
npx tsx scripts/rebuild-credits.ts 3 --dry

# Apply for all schools
npx tsx scripts/rebuild-credits.ts

# Apply for one school
npx tsx scripts/rebuild-credits.ts 3
```

The script compares each student's current `credits` against the sum of their `LessonCreditLog` entries and corrects any discrepancies.

### Schema Recovery

If the database schema drifts:
```bash
# Check migration status
npx prisma migrate status

# Apply any pending migrations
npx prisma migrate deploy

# If schema is out of sync with migrations (emergency only):
npx prisma db push    # syncs schema without migration files — use only as last resort
```

---

## Deployment Checklist

Use `npm run validate:env:prod` and `npm run migrate:check` to automate the first two sections.

```
PRE-DEPLOY (automated — npm run predeploy)
[ ] npm run validate:env:prod          → exit 0
[ ] npm run migrate:check              → exit 0
[ ] npm run build                      → no TypeScript errors
[ ] npm run test:integration           → 441/441 pass

Database
[ ] DATABASE_URL → production DB (not localhost, not dev DB)
[ ] SSL in connection string (?sslmode=require)
[ ] Backup retention ≥7 days verified
[ ] npx prisma migrate deploy          → applied successfully
[ ] npx prisma generate                → after migration

Server env
[ ] JWT_SECRET set (32+ chars, random — never placeholder)
[ ] CLIENT_URL = https://yourdomain.com (no trailing slash)
[ ] DISABLE_CRON=true on all API instances
[ ] REDIS_URL set (if using Redis; warn if absent)
[ ] SENTRY_DSN set (strongly recommended)
[ ] BACKUP_DIR set (for verify-backup.ts disk check)

Process start
[ ] PM2: eduschool-api (DISABLE_CRON=true) — started
[ ] PM2: eduschool-worker (exactly ONE) — started
[ ] pm2 save && pm2 startup             → persisted

Frontend
[ ] npm run build in client/            → dist/ built
[ ] dist/ copied to Nginx root
[ ] Nginx try_files fallback for React Router
[ ] Nginx /socket.io/ proxy block present
[ ] client_max_body_size 15M in Nginx
[ ] SSL certificate obtained + auto-renewal tested

POST-DEPLOY (automated — npm run postdeploy)
[ ] npm run smoke                       → exit 0
[ ] npm run migrate:check               → confirms latest migration applied
[ ] npm run verify:backup               → DB reachable, no stuck idempotency keys
```

---

## Common Pitfalls

### ❌ `ECONNREFUSED` on startup
**Cause:** Server starts before PostgreSQL is ready.
**Fix:** Add healthcheck or retry logic. With Docker Compose:
```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U postgres"]
  interval: 5s
  retries: 5
```

### ❌ React Router returns 404 on refresh
**Cause:** Nginx doesn't know about client-side routes.
**Fix:** `try_files $uri $uri/ /index.html` — see Nginx config above.

### ❌ WebSocket connections fail
**Cause:** Missing `/socket.io/` proxy block in Nginx, or missing `Upgrade` header.
**Fix:** Add the Socket.IO location block from the config above. Ensure `proxy_http_version 1.1`.

### ❌ Duplicate cron jobs / duplicate notifications
**Cause:** Multiple worker instances running.
**Fix:** Run exactly ONE `eduschool-worker` process. API instances must have `DISABLE_CRON=true`.

### ❌ `413 Request Entity Too Large` on Excel import
**Cause:** Nginx default body limit is 1MB.
**Fix:** `client_max_body_size 15M` in Nginx server block.

### ❌ CORS errors
**Cause:** `CLIENT_URL` in server `.env` doesn't match frontend domain exactly.
**Fix:** `CLIENT_URL=https://yourdomain.com` — no trailing slash.

### ❌ API calls 404 in production but work in dev (client/API on separate Railway services)
**Cause:** `VITE_API_URL` unset at Vite build time. Client and API are cross-origin on
Railway, so `client/src/lib/api.ts`'s `${VITE_API_URL || ''}/api/v1` collapses to a
relative path that resolves against the client's own static-file origin, not the API.
**Fix:** Set `VITE_API_URL=https://<api-service>.up.railway.app` (or your custom API
domain) as a build-time env var on the client's Railway service, then rebuild — this is
a Vite env var, baked in at build time, not readable at runtime like the server's env vars.

### ❌ `P2002` crash on server restart
**Cause:** `extendAllBlockSessions()` tries to create a session for a (blockId, date) that has a soft-deleted record with the same unique constraint.
**Fix:** Already handled — `skipDuplicates: true` in `sessionService.ts`. Check it wasn't accidentally removed.

### ❌ Credits inconsistent after manual DB edit
**Fix:** Run `npx tsx scripts/rebuild-credits.ts --dry` to preview, then without `--dry` to apply.

---

## Environment Separation

| Environment | DB | Server | Notes |
|-------------|-----|--------|-------|
| **Local dev** | Docker `localhost:5432` | `tsx watch` port 3001 + Vite HMR 5173 | `npm run dev` from root |
| **Staging** | Separate managed DB | PM2 (same config as prod) | Mirror prod, safe for testing |
| **Production** | Managed DB (Railway/Supabase) | PM2: api + worker | `migrate deploy` only |

---

## Scaling (50k students)

Current architecture handles 50k+ students across multiple schools on a single server thanks to:
- Composite DB indexes on all hot query paths
- Server-side pagination (no full table scans)
- Redis cache for analytics (60s TTL) and teacher calendars (120s TTL)
- BullMQ async notifications (decoupled from request path)
- Session archive (sessions >24 months moved to archive tables)
- Rate limiters per endpoint

**Horizontal scaling (if needed):**
- Scale API: `pm2 scale eduschool-api 4` — stateless, works out of the box
- Socket.IO multi-instance: `@socket.io/redis-adapter` already wired in (requires `REDIS_URL`)
- Worker: keep exactly ONE instance (cron deduplication)
- DB read replicas: add for analytics queries when p99 latency > 500ms

---

## PgBouncer (Connection Pooling)

**When to add:** If you scale to 4+ API instances. Each instance holds up to `connection_limit` connections — without a pooler, 4 instances × 10 = 40 open connections. PostgreSQL handles ~100 comfortably; beyond that, add PgBouncer.

**Install:**
```bash
apt install pgbouncer
```

**`/etc/pgbouncer/pgbouncer.ini`:**
```ini
[databases]
eduschool = host=localhost port=5432 dbname=eduschool

[pgbouncer]
listen_port = 6432
listen_addr = 127.0.0.1
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction          ; transaction mode — safe for Prisma
max_client_conn = 200
default_pool_size = 20
server_idle_timeout = 600
log_connections = 0
log_disconnections = 0
```

**`/etc/pgbouncer/userlist.txt`:**
```
"postgres" "md5<hash>"   ; generate with: echo -n "password+username" | md5sum
```

**Update `DATABASE_URL` to point at PgBouncer:**
```env
DATABASE_URL="postgresql://postgres:<password>@localhost:6432/eduschool?connection_limit=5&pool_timeout=10"
```

> **Important:** Use `pool_mode = transaction`. Prisma is compatible with transaction mode.
> Lower `connection_limit` per API instance (e.g. 5) — PgBouncer multiplexes them efficiently.
> Do **not** use session mode — it negates the pooling benefit.

**Start and enable:**
```bash
systemctl enable pgbouncer
systemctl start pgbouncer
pgbouncer -d /etc/pgbouncer/pgbouncer.ini   # alternative: run directly
```
