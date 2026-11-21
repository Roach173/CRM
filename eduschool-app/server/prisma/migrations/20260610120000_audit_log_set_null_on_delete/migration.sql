-- Migration: audit_log_set_null_on_delete
-- Immutable Audit Trail (P0 Architecture Closure)
--
-- Changes ScheduleActionLog.blockId and ScheduleActionLog.sessionId FK behavior
-- from CASCADE DELETE to SET NULL.
--
-- Rationale: ScheduleActionLog is compliance-critical. Deleting a LessonBlock or
-- LessonSession must NOT destroy the audit history. After this migration, when a
-- block/session is deleted the audit log row is preserved with blockId/sessionId
-- set to NULL, while action/before/after/reason/userId/createdAt remain intact.

-- Drop existing FK constraints
ALTER TABLE "ScheduleActionLog" DROP CONSTRAINT IF EXISTS "ScheduleActionLog_blockId_fkey";
ALTER TABLE "ScheduleActionLog" DROP CONSTRAINT IF EXISTS "ScheduleActionLog_sessionId_fkey";

-- Re-add with SET NULL on delete
ALTER TABLE "ScheduleActionLog"
  ADD CONSTRAINT "ScheduleActionLog_blockId_fkey"
  FOREIGN KEY ("blockId") REFERENCES "LessonBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduleActionLog"
  ADD CONSTRAINT "ScheduleActionLog_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "LessonSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
