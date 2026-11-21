-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "StudentPayment" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_schoolId_idempotencyKey_key" ON "Payment"("schoolId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "StudentPayment_schoolId_idempotencyKey_key" ON "StudentPayment"("schoolId", "idempotencyKey");
