-- B5: Structured Refunds — self-referential FK on LessonCreditLog
-- Allows a refund entry to reference the original deduction log it cancels,
-- enabling proper financial audit trail (which session was refunded, by whom, when).

ALTER TABLE "LessonCreditLog" ADD COLUMN IF NOT EXISTS "refundedLogId" INTEGER;

ALTER TABLE "LessonCreditLog" ADD CONSTRAINT "LessonCreditLog_refundedLogId_fkey"
FOREIGN KEY ("refundedLogId") REFERENCES "LessonCreditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
