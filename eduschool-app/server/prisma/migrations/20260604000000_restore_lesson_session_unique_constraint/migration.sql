-- ============================================================
-- RESTORE LessonSession(lessonBlockId, date) UNIQUE CONSTRAINT
-- ============================================================
-- Root cause: the UNIQUE index created by the baseline migration was replaced
-- by a non-unique index (LessonSession_lessonBlockId_date_idx), allowing the
-- rolling-window cron job to accumulate duplicate sessions across server restarts.
--
-- This migration:
--   1. Invalidates excess duplicate UPCOMING sessions (financial-data safe)
--   2. Hard-deletes ALL excess INVALIDATED artifacts (no financial data, pure race-condition noise)
--   3. Drops the unauthorized non-unique index
--   4. Restores the UNIQUE index that the codebase relies on for idempotent session creation.
-- ============================================================

-- Step 1: Invalidate excess duplicate UPCOMING sessions.
-- For each (lessonBlockId, date) pair (across all statuses), keep the oldest session (lowest id)
-- and INVALIDATE all UPCOMING extras that carry no financial data.
WITH all_ranked AS (
  SELECT
    id, status::text AS status_text,
    ROW_NUMBER() OVER (PARTITION BY "lessonBlockId", date ORDER BY id) AS rn
  FROM "LessonSession"
  WHERE "deletedAt" IS NULL
),
excess_upcoming AS (
  SELECT id FROM all_ranked WHERE rn > 1 AND status_text = 'UPCOMING'
),
safe_to_invalidate AS (
  SELECT e.id
  FROM excess_upcoming e
  WHERE NOT EXISTS (SELECT 1 FROM "Attendance"           WHERE "lessonSessionId" = e.id)
    AND NOT EXISTS (SELECT 1 FROM "LessonCreditLog"      WHERE "sessionId"       = e.id)
    AND NOT EXISTS (SELECT 1 FROM "TeacherPaymentLesson" WHERE "lessonSessionId" = e.id)
)
UPDATE "LessonSession"
SET status = 'INVALIDATED', version = version + 1
WHERE id IN (SELECT id FROM safe_to_invalidate);

-- Step 2: Hard-delete excess INVALIDATED sessions (artifacts of concurrent cron runs).
-- Ranks ALL sessions together so excess INVALIDATED entries are correctly identified even
-- when the canonical (oldest) session for that date is UPCOMING.
WITH all_ranked AS (
  SELECT
    id, status::text AS status_text,
    ROW_NUMBER() OVER (PARTITION BY "lessonBlockId", date ORDER BY id) AS rn
  FROM "LessonSession"
  WHERE "deletedAt" IS NULL
),
excess_invalidated AS (
  SELECT id FROM all_ranked WHERE rn > 1 AND status_text = 'INVALIDATED'
),
safe_to_delete AS (
  SELECT e.id
  FROM excess_invalidated e
  WHERE NOT EXISTS (SELECT 1 FROM "Attendance"           WHERE "lessonSessionId" = e.id)
    AND NOT EXISTS (SELECT 1 FROM "LessonCreditLog"      WHERE "sessionId"       = e.id)
    AND NOT EXISTS (SELECT 1 FROM "TeacherPaymentLesson" WHERE "lessonSessionId" = e.id)
)
DELETE FROM "LessonSession"
WHERE id IN (SELECT id FROM safe_to_delete);

-- Step 3: Remove the unauthorized non-unique index (schema drift from an untracked manual change).
DROP INDEX IF EXISTS "LessonSession_lessonBlockId_date_idx";

-- Step 4: Restore the UNIQUE index that the baseline migration created
-- and that the codebase relies on for idempotent session creation.
CREATE UNIQUE INDEX IF NOT EXISTS "LessonSession_lessonBlockId_date_key"
  ON "LessonSession"("lessonBlockId", date);
