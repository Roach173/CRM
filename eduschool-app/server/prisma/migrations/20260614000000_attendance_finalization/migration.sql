-- Attendance finalization metadata on LessonSession
ALTER TABLE "LessonSession"
  ADD COLUMN "attendanceFinalizedAt" TIMESTAMP(3),
  ADD COLUMN "attendanceFinalizedById" INTEGER,
  ADD COLUMN "attendanceReopenedAt" TIMESTAMP(3),
  ADD COLUMN "attendanceReopenedById" INTEGER,
  ADD COLUMN "attendanceReopenReason" TEXT;

-- Audit action enum
CREATE TYPE "AttendanceAuditAction" AS ENUM ('CREATE', 'UPDATE', 'FINALIZE', 'REOPEN');

-- Attendance audit trail
CREATE TABLE "AttendanceAudit" (
  "id" SERIAL NOT NULL,
  "schoolId" INTEGER NOT NULL,
  "lessonSessionId" INTEGER NOT NULL,
  "studentProfileId" INTEGER,
  "attendanceId" INTEGER,
  "oldStatus" "AttendanceStatus",
  "newStatus" "AttendanceStatus",
  "actorId" INTEGER NOT NULL,
  "reason" TEXT,
  "action" "AttendanceAuditAction" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AttendanceAudit_pkey" PRIMARY KEY ("id")
);

-- Existing attendance rows become finalized at their first recorded attendance timestamp.
WITH first_attendance AS (
  SELECT
    "lessonSessionId",
    MIN("createdAt") AS "attendanceFinalizedAt"
  FROM "Attendance"
  GROUP BY "lessonSessionId"
),
first_submitter AS (
  SELECT DISTINCT ON ("lessonSessionId")
    "lessonSessionId",
    "submittedById"
  FROM "Attendance"
  WHERE "submittedById" IS NOT NULL
  ORDER BY
    "lessonSessionId",
    "createdAt" ASC,
    "id" ASC
)
UPDATE "LessonSession" ls
SET
  "attendanceFinalizedAt" = fa."attendanceFinalizedAt",
  "attendanceFinalizedById" = fs."submittedById"
FROM first_attendance fa
LEFT JOIN first_submitter fs ON fs."lessonSessionId" = fa."lessonSessionId"
WHERE ls."id" = fa."lessonSessionId";

-- Foreign keys
ALTER TABLE "LessonSession"
  ADD CONSTRAINT "LessonSession_attendanceFinalizedById_fkey"
  FOREIGN KEY ("attendanceFinalizedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LessonSession"
  ADD CONSTRAINT "LessonSession_attendanceReopenedById_fkey"
  FOREIGN KEY ("attendanceReopenedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AttendanceAudit"
  ADD CONSTRAINT "AttendanceAudit_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "School"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceAudit"
  ADD CONSTRAINT "AttendanceAudit_lessonSessionId_fkey"
  FOREIGN KEY ("lessonSessionId") REFERENCES "LessonSession"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceAudit"
  ADD CONSTRAINT "AttendanceAudit_studentProfileId_fkey"
  FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AttendanceAudit"
  ADD CONSTRAINT "AttendanceAudit_attendanceId_fkey"
  FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AttendanceAudit"
  ADD CONSTRAINT "AttendanceAudit_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "LessonSession_attendanceFinalizedAt_idx" ON "LessonSession"("attendanceFinalizedAt");
CREATE INDEX "LessonSession_attendanceFinalizedById_idx" ON "LessonSession"("attendanceFinalizedById");
CREATE INDEX "LessonSession_attendanceReopenedById_idx" ON "LessonSession"("attendanceReopenedById");
CREATE INDEX "AttendanceAudit_schoolId_createdAt_idx" ON "AttendanceAudit"("schoolId", "createdAt");
CREATE INDEX "AttendanceAudit_lessonSessionId_createdAt_idx" ON "AttendanceAudit"("lessonSessionId", "createdAt");
CREATE INDEX "AttendanceAudit_studentProfileId_idx" ON "AttendanceAudit"("studentProfileId");
CREATE INDEX "AttendanceAudit_attendanceId_idx" ON "AttendanceAudit"("attendanceId");
CREATE INDEX "AttendanceAudit_actorId_createdAt_idx" ON "AttendanceAudit"("actorId", "createdAt");
CREATE INDEX "AttendanceAudit_action_idx" ON "AttendanceAudit"("action");
