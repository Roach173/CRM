-- Add archivedAt to User for student archive feature
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_schoolId_role_archivedAt_idx" ON "User"("schoolId", "role", "archivedAt");
