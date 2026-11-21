-- Fix: ScheduleActionLog cascade to SetNull for block and session relations.
-- Audit logs must survive when blocks/sessions are deleted.

-- Drop existing cascade foreign keys on ScheduleActionLog
ALTER TABLE "ScheduleActionLog" DROP CONSTRAINT IF EXISTS "ScheduleActionLog_blockId_fkey";
ALTER TABLE "ScheduleActionLog" DROP CONSTRAINT IF EXISTS "ScheduleActionLog_sessionId_fkey";

-- Re-add with SetNull behavior
ALTER TABLE "ScheduleActionLog"
  ADD CONSTRAINT "ScheduleActionLog_blockId_fkey"
  FOREIGN KEY ("blockId") REFERENCES "LessonBlock"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduleActionLog"
  ADD CONSTRAINT "ScheduleActionLog_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "LessonSession"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
