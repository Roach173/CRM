-- Phase 4: Financial Consistency — DB-backed idempotency infrastructure.
--
-- Adds the IdempotencyKey table that provides race-safe first-write detection
-- for financial write endpoints (credits, payments, refunds, salary payouts).
--
-- Key design decisions:
--   * UNIQUE on (schoolId, scopeType, actorId, endpoint, key) → only one
--     IN_PROGRESS row per logical operation; concurrent first requests race
--     at the DB level; exactly one wins.
--   * startedAt tracked separately from createdAt → stale IN_PROGRESS
--     detection (server crash recovery): rows older than 5 min are reclaimed.
--   * responseBody JSONB capped at 64 KB in application layer; sensitive
--     fields stripped before storage.
--   * Cleanup policy: only COMPLETED/FAILED expired rows are deleted;
--     IN_PROGRESS rows are never auto-deleted (only logged as anomalies).
--
-- NOTE: scopeType=SYSTEM/WEBHOOK with NULL actorId will require per-scope
-- partial unique indexes in a future phase (PostgreSQL NULL != NULL in
-- standard B-tree unique indexes). Phase 4 uses USER scope only.

CREATE TYPE "IdempotencyScopeType" AS ENUM ('USER', 'SYSTEM', 'WEBHOOK');
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

CREATE TABLE "IdempotencyKey" (
    "id"             SERIAL       PRIMARY KEY,
    "schoolId"       INTEGER,
    "actorId"        INTEGER,
    "scopeType"      "IdempotencyScopeType" NOT NULL DEFAULT 'USER',
    "endpoint"       TEXT         NOT NULL,
    "key"            TEXT         NOT NULL,
    "status"         "IdempotencyStatus"    NOT NULL DEFAULT 'IN_PROGRESS',
    "requestHash"    TEXT         NOT NULL,
    "startedAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "responseBody"   JSONB,
    "responseStatus" INTEGER,
    "expiresAt"      TIMESTAMPTZ  NOT NULL,
    "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updatedAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Race-safe unique constraint: INSERT fails with P2002 if another request
-- already inserted a row with the same logical key.
CREATE UNIQUE INDEX "IdempotencyKey_unique_key"
    ON "IdempotencyKey" ("schoolId", "scopeType", "actorId", "endpoint", "key");

-- Cleanup index: scan for expired rows efficiently.
CREATE INDEX "IdempotencyKey_expiresAt_idx"
    ON "IdempotencyKey" ("expiresAt");

-- Stale detection index: find IN_PROGRESS rows by age.
CREATE INDEX "IdempotencyKey_status_startedAt_idx"
    ON "IdempotencyKey" ("status", "startedAt");
