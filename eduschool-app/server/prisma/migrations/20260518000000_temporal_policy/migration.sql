-- Temporal School Policy Model
-- Adds effectiveTo to SchoolSchedulePolicy for point-in-time policy queries.
-- Adds INVALIDATED to SessionStatus so policy-invalidated sessions are archived, not deleted.

-- 1. Add INVALIDATED to SessionStatus enum
--    ALTER TYPE ... ADD VALUE is safe in PostgreSQL 12+ even inside transactions.
ALTER TYPE "SessionStatus" ADD VALUE IF NOT EXISTS 'INVALIDATED';

-- 2. Add effectiveTo column to SchoolSchedulePolicy (nullable — null = currently active)
ALTER TABLE "SchoolSchedulePolicy" ADD COLUMN IF NOT EXISTS "effectiveTo" TIMESTAMP(3);

-- 3. Composite index for fast point-in-time queries:
--    WHERE schoolId = ? AND effectiveFrom <= ? AND (effectiveTo IS NULL OR effectiveTo > ?)
CREATE INDEX IF NOT EXISTS "SchoolSchedulePolicy_schoolId_effectiveFrom_effectiveTo_idx"
  ON "SchoolSchedulePolicy"("schoolId", "effectiveFrom", "effectiveTo");
