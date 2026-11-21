-- Add indexes on teacherIdSnap for efficient salary/calendar queries
-- These are used when filtering sessions by the teacher who conducted them
-- (as opposed to the current block teacher, which changes over time)

CREATE INDEX IF NOT EXISTS "LessonSession_teacherIdSnap_idx"
  ON "LessonSession"("teacherIdSnap");

CREATE INDEX IF NOT EXISTS "LessonSession_teacherIdSnap_date_idx"
  ON "LessonSession"("teacherIdSnap", date);
