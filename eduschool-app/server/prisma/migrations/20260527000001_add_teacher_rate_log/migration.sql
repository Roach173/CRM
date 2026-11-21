-- CreateTable: TeacherRateLog — salary rate history for staff members
CREATE TABLE IF NOT EXISTS "TeacherRateLog" (
    "id" SERIAL NOT NULL,
    "staffProfileId" INTEGER NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "changedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeacherRateLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TeacherRateLog_staffProfileId_effectiveFrom_idx" ON "TeacherRateLog"("staffProfileId", "effectiveFrom");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TeacherRateLog_staffProfileId_fkey'
  ) THEN
    ALTER TABLE "TeacherRateLog" ADD CONSTRAINT "TeacherRateLog_staffProfileId_fkey"
      FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TeacherRateLog_changedById_fkey'
  ) THEN
    ALTER TABLE "TeacherRateLog" ADD CONSTRAINT "TeacherRateLog_changedById_fkey"
      FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
