-- Add submittedById to Attendance (nullable FK to User)
ALTER TABLE "Attendance" ADD COLUMN "submittedById" INTEGER;

ALTER TABLE "Attendance"
  ADD CONSTRAINT "Attendance_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Attendance_submittedById_idx" ON "Attendance"("submittedById");
