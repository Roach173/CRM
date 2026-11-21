-- Add parentBlockId to LessonBlock for temporal versioning (block split on teacher/config change)
ALTER TABLE "LessonBlock" ADD COLUMN "parentBlockId" INTEGER;

ALTER TABLE "LessonBlock"
  ADD CONSTRAINT "LessonBlock_parentBlockId_fkey"
  FOREIGN KEY ("parentBlockId") REFERENCES "LessonBlock"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "LessonBlock_parentBlockId_idx" ON "LessonBlock"("parentBlockId");
