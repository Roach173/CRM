-- Salary payouts: void instead of delete (same model as income Payment).
-- A cancelled TeacherPayment keeps its row as an audit trail with status
-- VOIDED + who/when/why; its TeacherPaymentLesson links are removed by the
-- API so the sessions become payable again. All salary math excludes VOIDED.

-- AlterTable
ALTER TABLE "TeacherPayment"
  ADD COLUMN "status" "PaymentStatus" NOT NULL DEFAULT 'CONFIRMED',
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidedById" INTEGER,
  ADD COLUMN "voidReason" TEXT;

-- AddForeignKey
ALTER TABLE "TeacherPayment" ADD CONSTRAINT "TeacherPayment_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
