# BACKUP_RESTORE.md — Shamdan Backup & Restore Guide

**Last Updated:** 2026-05-28 (Phase 8 — Deployment Safety)
**Audience:** DevOps, on-call engineers

---

## Backup Strategy

| Layer | Tool | Frequency | Retention |
|-------|------|-----------|-----------|
| PostgreSQL | `pg_dump` | Daily (cron) | 30 days |
| File uploads | rsync / S3 sync | Daily | 30 days |
| Env/secrets | Encrypted vault (e.g., Railway secrets, Doppler) | On change | Indefinite |

**Minimum viable backup:** PostgreSQL dump only (all financial and operational data lives in the DB).

---

## Recovery Time / Point Objectives

| Metric | Target | Notes |
|--------|--------|-------|
| RTO (Recovery Time Objective) | < 40 min | From decision-to-restore to service-up |
| RPO (Recovery Point Objective) | < 24 hours | With daily backups — reduce with more frequent dumps |
| Test restore frequency | Monthly | See "Test Restore Procedure" below |

---

## Automated Backup Script

Save as `scripts/backup.sh` and run from cron on the DB host or CI:

```bash
#!/bin/bash
# backup.sh — Shamdan daily PostgreSQL backup
# Cron: 0 3 * * * /path/to/backup.sh >> /var/log/eduschool-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups/eduschool}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/eduschool_$TIMESTAMP.dump"

mkdir -p "$BACKUP_DIR"

echo "[$(date -Is)] Starting backup → $BACKUP_FILE"

# Create backup
pg_dump "$DATABASE_URL" \
  --no-owner \
  --no-acl \
  -Fc \
  -f "$BACKUP_FILE"

echo "[$(date -Is)] Backup created: $(du -sh "$BACKUP_FILE" | cut -f1)"

# Verify the backup file is non-empty
if [ ! -s "$BACKUP_FILE" ]; then
  echo "[$(date -Is)] ERROR: Backup file is empty — aborting"
  exit 1
fi

# Run verification script
cd /app/eduschool-app/server  # adjust to your deploy path
npx tsx scripts/verify-backup.ts --backup-file "$BACKUP_FILE"

echo "[$(date -Is)] Verification passed"

# Rotate: delete backups older than RETENTION_DAYS
find "$BACKUP_DIR" -name "eduschool_*.dump" -mtime "+$RETENTION_DAYS" -delete
echo "[$(date -Is)] Rotated backups older than $RETENTION_DAYS days"

echo "[$(date -Is)] Backup complete"
```

Make executable: `chmod +x scripts/backup.sh`

---

## Creating a Backup

### PostgreSQL dump

```bash
# Plain SQL format (portable, human-readable):
pg_dump "$DATABASE_URL" --no-owner --no-acl -f backup_$(date +%Y%m%d_%H%M%S).sql

# Custom format (faster restore, supports parallel):
pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc -f backup_$(date +%Y%m%d_%H%M%S).dump
```

### File uploads

```bash
# If using local filesystem:
rsync -av server/public/uploads/ /backup/uploads/

# If using S3-compatible storage:
aws s3 sync s3://your-bucket/uploads/ /backup/uploads/
```

---

## Verifying a Backup

Run the verification script after every backup:

```bash
# Basic check (DB reachability, table counts, migrations, disk):
npx tsx server/scripts/verify-backup.ts

# Full check including backup file integrity:
npx tsx server/scripts/verify-backup.ts --backup-file /path/to/backup.sql
```

**Exit code 0** = all checks passed.
**Exit code 1** = one or more checks failed — do NOT rotate the backup until resolved.

The script checks:
1. Database reachable and responds
2. Critical tables (School, User, LessonBlock, LessonSession) have non-zero rows
3. Latest Prisma migration is applied
4. Uploads directory readable
5. Free disk space above 500 MB (configurable via `MIN_FREE_DISK_MB`)
6. Backup file present and non-empty (if `--backup-file` provided)
7. No stuck IN_PROGRESS idempotency keys older than 2 hours

---

## Test Restore Procedure

**Do this monthly** before you need it in an incident.

The goal: confirm a backup can produce a working database with correct schema and data.

```bash
# 1. Create a clean test database
createdb eduschool_restore_test
# or: psql -c "CREATE DATABASE eduschool_restore_test;"

# 2. Restore the most recent backup into it
pg_restore --no-owner --no-acl \
  -d "postgresql://postgres:password@localhost:5432/eduschool_restore_test" \
  /backups/eduschool_LATEST.dump

# 3. Point verify-backup.ts at the test DB
DATABASE_URL="postgresql://postgres:password@localhost:5432/eduschool_restore_test" \
  npx tsx server/scripts/verify-backup.ts
# Expected: all checks pass (db_reachable, table counts, migration)

# 4. Check migration state against restored DB
DATABASE_URL="postgresql://postgres:password@localhost:5432/eduschool_restore_test" \
  npx tsx server/scripts/migrate-check.ts
# Expected: no pending migrations (restore includes migration history)

# 5. Spot-check data (adjust to your actual school IDs)
psql "postgresql://postgres:password@localhost:5432/eduschool_restore_test" << 'SQL'
  SELECT COUNT(*) FROM "School";
  SELECT COUNT(*) FROM "User";
  SELECT COUNT(*) FROM "StudentProfile";
  SELECT COUNT(*) FROM "LessonSession";
  SELECT MAX("createdAt") FROM "User";   -- should be recent
SQL

# 6. Clean up
dropdb eduschool_restore_test
```

**Pass criteria:**
- All tables present with non-zero counts matching production
- Migration history intact (`_prisma_migrations` table present)
- `MAX(createdAt)` timestamps are recent (confirms it's a fresh backup, not a stale one)

**Record the result** (date, backup file, pass/fail) in your ops runbook.

---

## Restoring from Backup

**IMPORTANT:** Always test the restore in a staging environment first. Never restore directly to production without verification.

### Step 0 — Snapshot current (broken) state first

```bash
# Preserve the broken state for forensics before overwriting
pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc \
  -f "broken_$(date +%Y%m%d_%H%M%S).dump"
echo "Broken-state snapshot saved."
```

### Step 1 — Stop the application

```bash
# Railway: redeploy with MAINTENANCE=true or disable the service
# PM2:
pm2 stop eduschool-api eduschool-worker
```

### Step 2 — Identify the correct backup

```bash
# List available backups (newest first)
ls -lt /backups/eduschool_*.dump | head -10

# Pick the backup BEFORE the incident. Example:
BACKUP_FILE="/backups/eduschool_20260528_030000.dump"
```

### Step 3 — Restore PostgreSQL

```bash
# Drop and recreate schema first (clears broken state)
# WARNING: This destroys ALL current data — do Step 0 first!
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Restore from custom format (preferred — faster, supports parallel):
pg_restore --no-owner --no-acl -d "$DATABASE_URL" "$BACKUP_FILE"

# Or from plain SQL:
# psql "$DATABASE_URL" < "$BACKUP_FILE"
```

### Step 4 — Verify restored database

```bash
cd eduschool-app/server

# Full backup verification
npx tsx scripts/verify-backup.ts --backup-file "$BACKUP_FILE"
# Expected: all 9 checks pass

# Migration state check
npx tsx scripts/migrate-check.ts
# Expected: all migrations applied, none pending
```

### Step 5 — Apply any post-backup migrations

```bash
# If the restore point predates recent migrations, apply them now
npx prisma migrate deploy
npx tsx scripts/migrate-check.ts   # confirm
```

### Step 6 — Restore file uploads (if affected)

```bash
rsync -av /backup/uploads/ server/public/uploads/
# or from S3:
aws s3 sync s3://your-bucket/uploads/backup/ server/public/uploads/
```

### Step 7 — Restart application

```bash
pm2 start eduschool-api
pm2 start eduschool-worker
# or redeploy via Railway
```

### Step 8 — Post-restore smoke tests

```bash
# Wait 15s for process to start
sleep 15

# Run smoke tests against live server
npx tsx scripts/smoke-test.ts --base-url https://api.yourdomain.com
# All critical checks must pass

# Manual spot-checks:
# 1. Log in as SUPERADMIN — verify school list
# 2. Log in as OWNER for one affected school — verify student count and schedule
# 3. Check /health/deep → cron lastStatus: null (expected post-restart)
```

---

## Point-in-Time Recovery Scenarios

### Accidental Clear-All-Data

```
1. Identify timestamp from audit log: GET /api/v1/admin/audit-log?securityOnly=true&action=CLEAR_ALL_DATA
2. Find the backup immediately BEFORE that timestamp
3. Restore to staging, verify data, then restore to production (Steps 1–6 above)
```

### Corrupted Financial Records

```
1. Identify affected schoolId and time range from Sentry/logs
2. Restore to staging, extract affected rows:
   psql "$STAGING_DB" -c "SELECT * FROM LessonCreditLog WHERE schoolId = X AND createdAt BETWEEN ..."
3. Manually reconcile or re-import the extracted rows into production
   (never bulk-restore production for a partial schema issue — surgical repair is safer)
```

### Full Database Corruption / Disk Failure

```
Follow Steps 1–6 above using the most recent verified backup.
Document downtime window and notify school owners.
```

---

## Environment Variables Required for Backup Script

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | Required | PostgreSQL connection string |
| `UPLOADS_DIR` | `server/public/uploads` | Path to check for readability |
| `BACKUP_DIR` | CWD | Path used for disk space check |
| `MIN_FREE_DISK_MB` | `500` | Minimum free disk space in MB |

---

## Backup Rotation

Keep the last 30 daily backups. Delete older ones to conserve disk space:

```bash
# Delete backups older than 30 days
find /backups/ -name "backup_*.sql" -mtime +30 -delete
```

---

## Railway-Specific Notes

- Railway provides automatic PostgreSQL backups with 7-day retention on Pro plans.
- For longer retention: set up a Railway cron service that runs `pg_dump` to an S3 bucket.
- Uploads: if stored locally in Railway volumes, they are persistent but NOT automatically backed up — use S3.
- Recommended: Use `UPLOADS_DIR=/data/uploads` pointing to a Railway persistent volume, then sync `/data/uploads/` to S3 daily.
