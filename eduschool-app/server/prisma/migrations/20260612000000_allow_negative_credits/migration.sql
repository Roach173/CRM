-- Business decision: allow credits < 0 (student debt / deferred payment model).
-- The phase5_correction migration should have already dropped this, but drop again
-- to handle any drift or re-creation.
ALTER TABLE "StudentProfile"
  DROP CONSTRAINT IF EXISTS "StudentProfile_credits_nonnegative";
