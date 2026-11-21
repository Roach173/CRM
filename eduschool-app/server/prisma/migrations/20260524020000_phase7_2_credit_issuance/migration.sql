-- Phase 7.2 — Credit Issuance from Paid Tuition Invoices

CREATE TABLE "CreditIssuance" (
    "id"                  SERIAL PRIMARY KEY,
    "schoolId"            INTEGER NOT NULL,
    "paymentAllocationId" INTEGER NOT NULL,
    "invoiceLineId"       INTEGER NOT NULL,
    "studentProfileId"    INTEGER NOT NULL,
    "creditsIssued"       INTEGER NOT NULL,
    "lessonCreditLogId"   INTEGER,
    "issuedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById"          INTEGER NOT NULL,
    "reversedAt"          TIMESTAMP(3),
    "reversedById"        INTEGER,
    "reversalLogId"       INTEGER,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotency key: one issuance per (allocation, line)
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_paymentAllocationId_invoiceLineId_key"
    UNIQUE ("paymentAllocationId", "invoiceLineId");

-- Unique FKs to LessonCreditLog entries (one-to-one relations)
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_lessonCreditLogId_key"
    UNIQUE ("lessonCreditLogId");
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_reversalLogId_key"
    UNIQUE ("reversalLogId");

-- FK constraints
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_paymentAllocationId_fkey"
    FOREIGN KEY ("paymentAllocationId") REFERENCES "PaymentAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_invoiceLineId_fkey"
    FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_studentProfileId_fkey"
    FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_issuedById_fkey"
    FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_reversedById_fkey"
    FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_lessonCreditLogId_fkey"
    FOREIGN KEY ("lessonCreditLogId") REFERENCES "LessonCreditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditIssuance" ADD CONSTRAINT "CreditIssuance_reversalLogId_fkey"
    FOREIGN KEY ("reversalLogId") REFERENCES "LessonCreditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Performance indexes
CREATE INDEX "CreditIssuance_schoolId_idx"            ON "CreditIssuance"("schoolId");
CREATE INDEX "CreditIssuance_studentProfileId_idx"    ON "CreditIssuance"("studentProfileId");
CREATE INDEX "CreditIssuance_invoiceLineId_idx"        ON "CreditIssuance"("invoiceLineId");
CREATE INDEX "CreditIssuance_paymentAllocationId_idx"  ON "CreditIssuance"("paymentAllocationId");
