-- Phase 5 follow-up: keep one canonical partial unique index for DEBIT credit logs.
-- 20260524003000_credit_ledger_semantics created the same invariant under the
-- old name credit_log_debit_attendance_unique. Phase 5 uses the explicit
-- LessonCreditLog_debit_per_attendance name, so remove the duplicate index.

DROP INDEX IF EXISTS "credit_log_debit_attendance_unique";
