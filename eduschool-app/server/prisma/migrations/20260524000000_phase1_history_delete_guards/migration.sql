-- Phase 1: protect ERP history from accidental cascade deletes.
-- LessonBlock deletion must not physically remove sessions.
ALTER TABLE "LessonSession" DROP CONSTRAINT IF EXISTS "LessonSession_lessonBlockId_fkey";
ALTER TABLE "LessonSession"
  ADD CONSTRAINT "LessonSession_lessonBlockId_fkey"
  FOREIGN KEY ("lessonBlockId") REFERENCES "LessonBlock"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- SessionStudent is a historical membership snapshot; deleting a session must not cascade it.
ALTER TABLE "SessionStudent" DROP CONSTRAINT IF EXISTS "SessionStudent_lessonSessionId_fkey";
ALTER TABLE "SessionStudent"
  ADD CONSTRAINT "SessionStudent_lessonSessionId_fkey"
  FOREIGN KEY ("lessonSessionId") REFERENCES "LessonSession"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Schedule audit rows should survive block/session archival.
ALTER TABLE "ScheduleActionLog" DROP CONSTRAINT IF EXISTS "ScheduleActionLog_sessionId_fkey";
ALTER TABLE "ScheduleActionLog"
  ADD CONSTRAINT "ScheduleActionLog_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "LessonSession"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduleActionLog" DROP CONSTRAINT IF EXISTS "ScheduleActionLog_blockId_fkey";
ALTER TABLE "ScheduleActionLog"
  ADD CONSTRAINT "ScheduleActionLog_blockId_fkey"
  FOREIGN KEY ("blockId") REFERENCES "LessonBlock"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
