-- Phase 5 Correction: Remove StudentProfile_credits_nonnegative CHECK constraint.
--
-- Business decision: credits < 0 is valid — it represents lesson debt.
-- A student may attend lessons before purchasing credits (deferred payment model).
-- Debt is tracked via LessonCreditLog and managed by school finance policy.
-- No DB-level floor is appropriate; enforcement is at the application/policy layer.
--
-- See ARCHITECTURAL_DECISIONS.md ADR-021 for full design rationale.

ALTER TABLE "StudentProfile"
  DROP CONSTRAINT IF EXISTS "StudentProfile_credits_nonnegative";
