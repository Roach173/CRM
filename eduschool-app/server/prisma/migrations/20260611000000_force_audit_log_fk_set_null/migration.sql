-- Migration: force_audit_log_fk_set_null
-- Idempotent re-application of SET NULL on ScheduleActionLog FKs.
--
-- Rationale: The baseline migration (20260510200000_baseline) created
-- ScheduleActionLog_blockId_fkey and ScheduleActionLog_sessionId_fkey as
-- ON DELETE CASCADE. Migration 20260610120000_audit_log_set_null_on_delete
-- was written to fix this, but may have been recorded as applied in
-- _prisma_migrations without the ALTER TABLE actually executing (e.g. if
-- the migration ran inside a failing transaction that was partially committed,
-- or if the constraints were renamed/recreated by another migration in between).
--
-- This migration force-drops and force-re-creates both constraints to guarantee
-- SET NULL semantics regardless of prior state. Safe to re-apply: uses
-- DROP CONSTRAINT IF EXISTS before re-adding.

-- ScheduleActionLog.blockId → LessonBlock: SET NULL on block hard-delete
ALTER TABLE "ScheduleActionLog"
  DROP CONSTRAINT IF EXISTS "ScheduleActionLog_blockId_fkey";

ALTER TABLE "ScheduleActionLog"
  ADD CONSTRAINT "ScheduleActionLog_blockId_fkey"
  FOREIGN KEY ("blockId") REFERENCES "LessonBlock"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ScheduleActionLog.sessionId → LessonSession: SET NULL on session hard-delete
ALTER TABLE "ScheduleActionLog"
  DROP CONSTRAINT IF EXISTS "ScheduleActionLog_sessionId_fkey";

ALTER TABLE "ScheduleActionLog"
  ADD CONSTRAINT "ScheduleActionLog_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "LessonSession"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
