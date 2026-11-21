-- AddColumn: per-student monthly tuition target. NULL → falls back to SchoolFinanceConfig.basePrice.
ALTER TABLE "StudentProfile" ADD COLUMN "monthlyFee" DECIMAL(10,2);
