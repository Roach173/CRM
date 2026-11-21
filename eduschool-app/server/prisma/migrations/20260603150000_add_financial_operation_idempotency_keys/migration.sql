-- DropForeignKey
ALTER TABLE "TeacherRateLog" DROP CONSTRAINT "TeacherRateLog_changedById_fkey";

-- AlterTable
ALTER TABLE "LessonCreditLog" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "ManualLessonEntry" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "PaymentRefund" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "SalaryAdjustment" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "TeacherPayment" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LessonCreditLog_schoolId_idempotencyKey_key" ON "LessonCreditLog"("schoolId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ManualLessonEntry_schoolId_idempotencyKey_key" ON "ManualLessonEntry"("schoolId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRefund_schoolId_idempotencyKey_key" ON "PaymentRefund"("schoolId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryAdjustment_schoolId_idempotencyKey_key" ON "SalaryAdjustment"("schoolId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherPayment_schoolId_idempotencyKey_key" ON "TeacherPayment"("schoolId", "idempotencyKey");
