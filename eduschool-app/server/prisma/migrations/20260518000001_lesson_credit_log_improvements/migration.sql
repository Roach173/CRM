-- B3: Add priceSnapshot to LessonCreditLog for financial audit history
ALTER TABLE "LessonCreditLog" ADD COLUMN IF NOT EXISTS "priceSnapshot" INTEGER;

-- B4: Nullify orphan sessionId references before adding FK constraint
UPDATE "LessonCreditLog"
SET "sessionId" = NULL
WHERE "sessionId" IS NOT NULL
  AND "sessionId" NOT IN (SELECT "id" FROM "LessonSession");

-- B4: Add FK from LessonCreditLog.sessionId → LessonSession.id with SetNull on delete
ALTER TABLE "LessonCreditLog" ADD CONSTRAINT "LessonCreditLog_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "LessonSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
