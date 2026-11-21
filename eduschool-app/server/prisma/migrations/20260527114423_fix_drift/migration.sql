-- DropForeignKey
ALTER TABLE "LessonCreditLog" DROP CONSTRAINT IF EXISTS "LessonCreditLog_actorId_fkey";

-- DropForeignKey
ALTER TABLE "LessonCreditLog" DROP CONSTRAINT IF EXISTS "LessonCreditLog_attendanceId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduleActionLog" DROP CONSTRAINT IF EXISTS "ScheduleActionLog_blockId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduleActionLog" DROP CONSTRAINT IF EXISTS "ScheduleActionLog_sessionId_fkey";

-- AlterTable
ALTER TABLE "IdempotencyKey" ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Invoice" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "StudentProfile" ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- AddForeignKey
ALTER TABLE "LessonCreditLog" ADD CONSTRAINT "LessonCreditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonCreditLog" ADD CONSTRAINT "LessonCreditLog_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleActionLog" ADD CONSTRAINT "ScheduleActionLog_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "LessonBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleActionLog" ADD CONSTRAINT "ScheduleActionLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LessonSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "AttendanceMonthlySummary_schoolId_studentProfileId_year_month_k" RENAME TO "AttendanceMonthlySummary_schoolId_studentProfileId_year_mon_key";

-- RenameIndex
ALTER INDEX "CreditIssuanceReversal_creditIssuanceId_paymentRefundAllocation" RENAME TO "CreditIssuanceReversal_creditIssuanceId_paymentRefundAlloca_key";

-- RenameIndex
ALTER INDEX "FinancialAdjustment_paymentRefundAllocationId_creditIssuanceId_" RENAME TO "FinancialAdjustment_paymentRefundAllocationId_creditIssuanc_key";

-- RenameIndex
ALTER INDEX "IdempotencyKey_unique_key" RENAME TO "IdempotencyKey_schoolId_scopeType_actorId_endpoint_key_key";
