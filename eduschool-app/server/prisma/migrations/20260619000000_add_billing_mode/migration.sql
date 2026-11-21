-- Billing mode selector for SchoolFinanceConfig.
-- PER_LESSON: balance (credits) drives status; paidUntil is the projected run-out date.
-- CALENDAR_MONTH: one basePrice buys one calendar month; paidUntil drives status.
-- Default PER_LESSON preserves existing behaviour (overdue = credits <= 0).
CREATE TYPE "BillingMode" AS ENUM ('PER_LESSON', 'CALENDAR_MONTH');

ALTER TABLE "SchoolFinanceConfig"
    ADD COLUMN "billingMode" "BillingMode" NOT NULL DEFAULT 'PER_LESSON';
