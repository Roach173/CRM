-- Proportional billing accumulator: lessons already granted from moneyBalance
ALTER TABLE "StudentProfile" ADD COLUMN "billingLessonsGranted" INTEGER NOT NULL DEFAULT 0;

-- Payment cancellation audit fields (soft-cancel a StudentPayment, OWNER/SUPERADMIN)
ALTER TABLE "StudentPayment" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "StudentPayment" ADD COLUMN "cancelledById" INTEGER;
