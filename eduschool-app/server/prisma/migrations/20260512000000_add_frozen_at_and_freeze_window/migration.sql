-- Add frozenAt to StudentProfile (nullable, IF NOT EXISTS for safety)
ALTER TABLE "StudentProfile" ADD COLUMN IF NOT EXISTS "frozenAt" TIMESTAMP(3);

-- Add freezeWindowHours to SchoolFinanceConfig (NOT NULL with default 24, IF NOT EXISTS for safety)
ALTER TABLE "SchoolFinanceConfig" ADD COLUMN IF NOT EXISTS "freezeWindowHours" INTEGER NOT NULL DEFAULT 24;
