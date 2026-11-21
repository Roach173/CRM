-- Phase 5: Group Promotion — academic progression creates a new group instead of mutating current one.
-- GroupProgression tracks the source→target link as a first-class business event.

CREATE TABLE "GroupProgression" (
  "id"          SERIAL PRIMARY KEY,
  "schoolId"    INTEGER NOT NULL,
  "fromGroupId" INTEGER NOT NULL,
  "toGroupId"   INTEGER NOT NULL,
  "fromLevel"   TEXT NOT NULL,
  "fromChapter" INTEGER NOT NULL,
  "toLevel"     TEXT NOT NULL,
  "toChapter"   INTEGER NOT NULL,
  "actorId"     INTEGER NOT NULL,
  "reason"      TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GroupProgression_schoolId_fkey"    FOREIGN KEY ("schoolId")    REFERENCES "School"("id")       ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GroupProgression_fromGroupId_fkey" FOREIGN KEY ("fromGroupId") REFERENCES "StudentGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GroupProgression_toGroupId_fkey"   FOREIGN KEY ("toGroupId")   REFERENCES "StudentGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GroupProgression_actorId_fkey"     FOREIGN KEY ("actorId")     REFERENCES "User"("id")         ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "GroupProgression_schoolId_idx"    ON "GroupProgression"("schoolId");
CREATE INDEX "GroupProgression_fromGroupId_idx" ON "GroupProgression"("fromGroupId");
CREATE INDEX "GroupProgression_toGroupId_idx"   ON "GroupProgression"("toGroupId");
CREATE INDEX "GroupProgression_actorId_idx"     ON "GroupProgression"("actorId");
