-- Phase 2: group lifecycle audit support.
ALTER TABLE "ScheduleActionLog" ADD COLUMN IF NOT EXISTS "groupId" INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ScheduleActionLog_groupId_fkey'
  ) THEN
    ALTER TABLE "ScheduleActionLog" ADD CONSTRAINT "ScheduleActionLog_groupId_fkey"
      FOREIGN KEY ("groupId") REFERENCES "StudentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ScheduleActionLog_groupId_idx" ON "ScheduleActionLog"("groupId");
