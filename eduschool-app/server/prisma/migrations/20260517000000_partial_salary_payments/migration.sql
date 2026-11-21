-- Remove the unique index that forced one payment per teacher per month
-- NOTE: Prisma creates @@unique as a UNIQUE INDEX, not a CONSTRAINT — must use DROP INDEX
DROP INDEX IF EXISTS "TeacherPayment_staffProfileId_period_key";

-- Create join table for partial payment sessions (idempotent: IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "TeacherPaymentLesson" (
    "id" SERIAL NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "lessonSessionId" INTEGER NOT NULL,

    CONSTRAINT "TeacherPaymentLesson_pkey" PRIMARY KEY ("id")
);

-- Unique: each session can be in at most one payment
CREATE UNIQUE INDEX IF NOT EXISTS "TeacherPaymentLesson_lessonSessionId_key" ON "TeacherPaymentLesson"("lessonSessionId");

-- Index for fast lookup by payment
CREATE INDEX IF NOT EXISTS "TeacherPaymentLesson_paymentId_idx" ON "TeacherPaymentLesson"("paymentId");

-- FK: cascade delete when payment is deleted (idempotent check)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TeacherPaymentLesson_paymentId_fkey'
  ) THEN
    ALTER TABLE "TeacherPaymentLesson" ADD CONSTRAINT "TeacherPaymentLesson_paymentId_fkey"
      FOREIGN KEY ("paymentId") REFERENCES "TeacherPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TeacherPaymentLesson_lessonSessionId_fkey'
  ) THEN
    ALTER TABLE "TeacherPaymentLesson" ADD CONSTRAINT "TeacherPaymentLesson_lessonSessionId_fkey"
      FOREIGN KEY ("lessonSessionId") REFERENCES "LessonSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
