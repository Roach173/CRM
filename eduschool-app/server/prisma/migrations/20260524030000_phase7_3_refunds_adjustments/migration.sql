-- Phase 7.3 — Refunds, reversals, and financial adjustments

CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'CONFIRMED', 'VOIDED');

CREATE TYPE "FinancialAdjustmentType" AS ENUM (
  'CREDIT_GRANT',
  'CREDIT_DEDUCT',
  'BALANCE_DEBT',
  'BALANCE_CREDIT',
  'ACCOUNTING_CORRECTION',
  'MIGRATION_CORRECTION'
);

CREATE TYPE "FinancialAdjustmentStatus" AS ENUM ('ACTIVE', 'VOIDED');

CREATE TABLE "PaymentRefund" (
  "id"            SERIAL PRIMARY KEY,
  "schoolId"      INTEGER NOT NULL,
  "paymentId"     INTEGER NOT NULL,
  "amount"        DECIMAL(12,2) NOT NULL,
  "reason"        TEXT NOT NULL,
  "status"        "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "createdById"   INTEGER NOT NULL,
  "confirmedById" INTEGER,
  "voidedById"    INTEGER,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt"   TIMESTAMP(3),
  "voidedAt"      TIMESTAMP(3)
);

CREATE TABLE "PaymentRefundAllocation" (
  "id"                  SERIAL PRIMARY KEY,
  "refundId"            INTEGER NOT NULL,
  "paymentAllocationId" INTEGER NOT NULL,
  "amount"              DECIMAL(12,2) NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "CreditIssuanceReversal" (
  "id"                        SERIAL PRIMARY KEY,
  "creditIssuanceId"          INTEGER NOT NULL,
  "paymentRefundAllocationId" INTEGER,
  "creditsReversed"           INTEGER NOT NULL,
  "lessonCreditLogId"         INTEGER NOT NULL,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById"               INTEGER NOT NULL,
  "voidedAt"                  TIMESTAMP(3),
  "voidedById"                INTEGER,
  "voidLogId"                 INTEGER
);

CREATE TABLE "FinancialAdjustment" (
  "id"                        SERIAL PRIMARY KEY,
  "schoolId"                  INTEGER NOT NULL,
  "studentProfileId"          INTEGER NOT NULL,
  "type"                      "FinancialAdjustmentType" NOT NULL,
  "status"                    "FinancialAdjustmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "amountMoney"               DECIMAL(12,2),
  "amountCredits"             INTEGER,
  "reason"                    TEXT NOT NULL,
  "createdById"               INTEGER NOT NULL,
  "voidedById"                INTEGER,
  "paymentRefundId"           INTEGER,
  "paymentRefundAllocationId" INTEGER,
  "creditIssuanceId"          INTEGER,
  "lessonCreditLogId"         INTEGER,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt"                  TIMESTAMP(3)
);

ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentRefundAllocation" ADD CONSTRAINT "PaymentRefundAllocation_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "PaymentRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefundAllocation" ADD CONSTRAINT "PaymentRefundAllocation_paymentAllocationId_fkey"
  FOREIGN KEY ("paymentAllocationId") REFERENCES "PaymentAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CreditIssuanceReversal" ADD CONSTRAINT "CreditIssuanceReversal_creditIssuanceId_fkey"
  FOREIGN KEY ("creditIssuanceId") REFERENCES "CreditIssuance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditIssuanceReversal" ADD CONSTRAINT "CreditIssuanceReversal_paymentRefundAllocationId_fkey"
  FOREIGN KEY ("paymentRefundAllocationId") REFERENCES "PaymentRefundAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditIssuanceReversal" ADD CONSTRAINT "CreditIssuanceReversal_lessonCreditLogId_fkey"
  FOREIGN KEY ("lessonCreditLogId") REFERENCES "LessonCreditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditIssuanceReversal" ADD CONSTRAINT "CreditIssuanceReversal_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditIssuanceReversal" ADD CONSTRAINT "CreditIssuanceReversal_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditIssuanceReversal" ADD CONSTRAINT "CreditIssuanceReversal_voidLogId_fkey"
  FOREIGN KEY ("voidLogId") REFERENCES "LessonCreditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_studentProfileId_fkey"
  FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_paymentRefundId_fkey"
  FOREIGN KEY ("paymentRefundId") REFERENCES "PaymentRefund"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_paymentRefundAllocationId_fkey"
  FOREIGN KEY ("paymentRefundAllocationId") REFERENCES "PaymentRefundAllocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_creditIssuanceId_fkey"
  FOREIGN KEY ("creditIssuanceId") REFERENCES "CreditIssuance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_lessonCreditLogId_fkey"
  FOREIGN KEY ("lessonCreditLogId") REFERENCES "LessonCreditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentRefundAllocation" ADD CONSTRAINT "PaymentRefundAllocation_refundId_paymentAllocationId_key"
  UNIQUE ("refundId", "paymentAllocationId");
ALTER TABLE "CreditIssuanceReversal" ADD CONSTRAINT "CreditIssuanceReversal_lessonCreditLogId_key"
  UNIQUE ("lessonCreditLogId");
ALTER TABLE "CreditIssuanceReversal" ADD CONSTRAINT "CreditIssuanceReversal_voidLogId_key"
  UNIQUE ("voidLogId");
ALTER TABLE "CreditIssuanceReversal" ADD CONSTRAINT "CreditIssuanceReversal_creditIssuanceId_paymentRefundAllocationId_key"
  UNIQUE ("creditIssuanceId", "paymentRefundAllocationId");
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_lessonCreditLogId_key"
  UNIQUE ("lessonCreditLogId");
ALTER TABLE "FinancialAdjustment" ADD CONSTRAINT "FinancialAdjustment_paymentRefundAllocationId_creditIssuanceId_type_key"
  UNIQUE ("paymentRefundAllocationId", "creditIssuanceId", "type");

CREATE INDEX "PaymentRefund_schoolId_idx" ON "PaymentRefund"("schoolId");
CREATE INDEX "PaymentRefund_paymentId_idx" ON "PaymentRefund"("paymentId");
CREATE INDEX "PaymentRefund_schoolId_status_idx" ON "PaymentRefund"("schoolId", "status");
CREATE INDEX "PaymentRefundAllocation_refundId_idx" ON "PaymentRefundAllocation"("refundId");
CREATE INDEX "PaymentRefundAllocation_paymentAllocationId_idx" ON "PaymentRefundAllocation"("paymentAllocationId");
CREATE INDEX "CreditIssuanceReversal_creditIssuanceId_idx" ON "CreditIssuanceReversal"("creditIssuanceId");
CREATE INDEX "CreditIssuanceReversal_paymentRefundAllocationId_idx" ON "CreditIssuanceReversal"("paymentRefundAllocationId");
CREATE INDEX "FinancialAdjustment_schoolId_idx" ON "FinancialAdjustment"("schoolId");
CREATE INDEX "FinancialAdjustment_studentProfileId_idx" ON "FinancialAdjustment"("studentProfileId");
CREATE INDEX "FinancialAdjustment_paymentRefundId_idx" ON "FinancialAdjustment"("paymentRefundId");
CREATE INDEX "FinancialAdjustment_paymentRefundAllocationId_idx" ON "FinancialAdjustment"("paymentRefundAllocationId");
CREATE INDEX "FinancialAdjustment_creditIssuanceId_idx" ON "FinancialAdjustment"("creditIssuanceId");
CREATE INDEX "FinancialAdjustment_schoolId_type_idx" ON "FinancialAdjustment"("schoolId", "type");
