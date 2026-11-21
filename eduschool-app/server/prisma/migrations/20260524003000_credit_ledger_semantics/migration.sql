-- Phase 6: Credit Ledger Semantics
-- Adds CreditLogType enum, type/actorId/attendanceId columns to LessonCreditLog.
-- Backfills existing rows from reason/sign heuristics.
-- Adds partial unique index: at most one DEBIT per attendanceId (idempotency guard).

-- Step 1: Create enum
CREATE TYPE "CreditLogType" AS ENUM (
  'DEBIT',
  'REFUND',
  'MANUAL_ADD',
  'MANUAL_DEDUCT',
  'CORRECTION',
  'FREEZE_SKIP',
  'GIFT',
  'PAYMENT',
  'IMPORT'
);

-- Step 2: Add columns (type has DB-level default so existing rows get DEBIT)
ALTER TABLE "LessonCreditLog"
  ADD COLUMN "type"         "CreditLogType" NOT NULL DEFAULT 'DEBIT'::"CreditLogType",
  ADD COLUMN "actorId"      INTEGER,
  ADD COLUMN "attendanceId" INTEGER;

-- Step 3: Backfill type for existing rows (priority: REFUND > GIFT > PAYMENT > IMPORT > MANUAL_*)
UPDATE "LessonCreditLog" SET "type" = 'REFUND'
  WHERE "refundedLogId" IS NOT NULL;

UPDATE "LessonCreditLog" SET "type" = 'GIFT'
  WHERE "reason" = 'GIFT'
    AND "refundedLogId" IS NULL;

UPDATE "LessonCreditLog" SET "type" = 'PAYMENT'
  WHERE "reason" = 'PAYMENT'
    AND "refundedLogId" IS NULL;

UPDATE "LessonCreditLog" SET "type" = 'IMPORT'
  WHERE "reason" ILIKE '%импорт%'
    AND "refundedLogId" IS NULL;

-- Manual deductions: negative amount, no sessionId, not yet reclassified
UPDATE "LessonCreditLog" SET "type" = 'MANUAL_DEDUCT'
  WHERE "amount" < 0
    AND "sessionId" IS NULL
    AND "refundedLogId" IS NULL
    AND "type" = 'DEBIT'::"CreditLogType";

-- Manual additions: positive amount, not yet reclassified
UPDATE "LessonCreditLog" SET "type" = 'MANUAL_ADD'
  WHERE "amount" > 0
    AND "refundedLogId" IS NULL
    AND "type" = 'DEBIT'::"CreditLogType";

-- Step 4: FK constraints
ALTER TABLE "LessonCreditLog"
  ADD CONSTRAINT "LessonCreditLog_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "LessonCreditLog_attendanceId_fkey"
    FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE SET NULL;

-- Step 5: Partial unique index — at most one DEBIT entry per attendanceId.
-- This is a DB-level idempotency guard on top of the creditDeducted flag.
-- Partial index: only enforced when type = 'DEBIT' AND attendanceId IS NOT NULL,
-- so FREEZE_SKIP entries (amount=0) for the same attendance are allowed.
CREATE UNIQUE INDEX "credit_log_debit_attendance_unique"
  ON "LessonCreditLog"("attendanceId")
  WHERE "type" = 'DEBIT'::"CreditLogType" AND "attendanceId" IS NOT NULL;

-- Step 6: Composite index for ledger queries by student + type
CREATE INDEX "LessonCreditLog_studentProfileId_type_idx"
  ON "LessonCreditLog"("studentProfileId", "type");

CREATE INDEX "LessonCreditLog_attendanceId_idx"
  ON "LessonCreditLog"("attendanceId");
