-- Migration: add_active_makeup_unique_index
-- Partial unique index: at most one non-CANCELLED makeup session per original session.
--
-- Rationale: createMakeupSession has an in-transaction guard (existingMakeup check)
-- that prevents duplicate active makeups at the application level. This index adds
-- the equivalent DB-level guarantee, protecting against:
--   - Concurrent requests that both pass the app guard before either insert commits
--   - Direct DB inserts (imports, fixtures, break-glass ops) that bypass the service
--
-- A PARTIAL index is required because:
--   - A CANCELLED makeup can be replaced by a new one (second-chance makeup)
--   - Soft-deleted rows (deletedAt IS NOT NULL) must not block new makeups
--   - A full unique on makeupForSessionId would prevent the above cases
--
-- IF NOT EXISTS makes this idempotent — safe to re-apply.

CREATE UNIQUE INDEX IF NOT EXISTS "LessonSession_active_makeup_unique"
ON "LessonSession" ("makeupForSessionId")
WHERE "makeupForSessionId" IS NOT NULL
  AND status != 'CANCELLED'::"SessionStatus"
  AND "deletedAt" IS NULL;
