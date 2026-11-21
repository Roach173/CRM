-- Phase 7.1 — Invoice Infrastructure Foundation
-- Additive only: new tables, new enums, new nullable/default columns.
-- No destructive changes. StudentPayment, LessonCreditLog semantics unchanged.

-- ─── New enums ────────────────────────────────────────────────────────────────

CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'OVERDUE');
CREATE TYPE "InvoiceLineType" AS ENUM ('TUITION', 'MATERIAL', 'REGISTRATION', 'DISCOUNT', 'CUSTOM');
CREATE TYPE "PaymentStatus" AS ENUM ('CONFIRMED', 'VOIDED', 'REFUNDED');

-- ─── Invoice ──────────────────────────────────────────────────────────────────

CREATE TABLE "Invoice" (
    "id"               SERIAL          NOT NULL,
    "schoolId"         INTEGER         NOT NULL,
    "studentProfileId" INTEGER         NOT NULL,
    "status"           "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount"      DECIMAL(12,2)   NOT NULL DEFAULT 0,
    "paidAmount"       DECIMAL(12,2)   NOT NULL DEFAULT 0,
    "currencyCode"     TEXT            NOT NULL DEFAULT 'KGS',
    "dueDate"          TIMESTAMP(3),
    "issuedAt"         TIMESTAMP(3),
    "voidedAt"         TIMESTAMP(3),
    "note"             TEXT,
    "periodStart"      TIMESTAMP(3),
    "periodEnd"        TIMESTAMP(3),
    "createdById"      INTEGER         NOT NULL,
    "createdAt"        TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- ─── InvoiceLine ──────────────────────────────────────────────────────────────

CREATE TABLE "InvoiceLine" (
    "id"             SERIAL              NOT NULL,
    "invoiceId"      INTEGER             NOT NULL,
    "type"           "InvoiceLineType"   NOT NULL,
    "description"    TEXT                NOT NULL,
    "quantity"       DECIMAL(10,2)       NOT NULL,
    "unitPrice"      DECIMAL(12,2)       NOT NULL,
    "amount"         DECIMAL(12,2)       NOT NULL,
    "creditsToIssue" INTEGER,
    "groupId"        INTEGER,
    "lessonBlockId"  INTEGER,
    "periodStart"    TIMESTAMP(3),
    "periodEnd"      TIMESTAMP(3),
    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- ─── Payment (new — not StudentPayment) ───────────────────────────────────────

CREATE TABLE "Payment" (
    "id"               SERIAL          NOT NULL,
    "schoolId"         INTEGER         NOT NULL,
    "studentProfileId" INTEGER         NOT NULL,
    "amount"           DECIMAL(12,2)   NOT NULL,
    "method"           "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "status"           "PaymentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "paidAt"           TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById"     INTEGER         NOT NULL,
    "note"             TEXT,
    "voidedAt"         TIMESTAMP(3),
    "voidedById"       INTEGER,
    "refundedAt"       TIMESTAMP(3),
    "refundedById"     INTEGER,
    "refundPaymentId"  INTEGER,
    "createdAt"        TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- ─── PaymentAllocation ────────────────────────────────────────────────────────

CREATE TABLE "PaymentAllocation" (
    "id"        SERIAL        NOT NULL,
    "paymentId" INTEGER       NOT NULL,
    "invoiceId" INTEGER       NOT NULL,
    "amount"    DECIMAL(12,2) NOT NULL,
    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- ─── Additive columns on existing tables ─────────────────────────────────────

-- moneyBalance: monetary balance separate from lesson credits (Phase 7.2 will populate)
ALTER TABLE "StudentProfile" ADD COLUMN "moneyBalance" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- paymentId: nullable FK so Phase 7.2 can link credit logs to a Payment
ALTER TABLE "LessonCreditLog" ADD COLUMN "paymentId" INTEGER;

-- ─── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_schoolId_fkey"
        FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Invoice_studentProfileId_fkey"
        FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Invoice_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_invoiceId_fkey"
        FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "InvoiceLine_groupId_fkey"
        FOREIGN KEY ("groupId") REFERENCES "StudentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "InvoiceLine_lessonBlockId_fkey"
        FOREIGN KEY ("lessonBlockId") REFERENCES "LessonBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payment"
    ADD CONSTRAINT "Payment_schoolId_fkey"
        FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Payment_studentProfileId_fkey"
        FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Payment_receivedById_fkey"
        FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Payment_voidedById_fkey"
        FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "Payment_refundedById_fkey"
        FOREIGN KEY ("refundedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "Payment_refundPaymentId_fkey"
        FOREIGN KEY ("refundPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentAllocation"
    ADD CONSTRAINT "PaymentAllocation_paymentId_fkey"
        FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PaymentAllocation_invoiceId_fkey"
        FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LessonCreditLog"
    ADD CONSTRAINT "LessonCreditLog_paymentId_fkey"
        FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Unique constraints ───────────────────────────────────────────────────────

ALTER TABLE "PaymentAllocation"
    ADD CONSTRAINT "PaymentAllocation_paymentId_invoiceId_key" UNIQUE ("paymentId", "invoiceId");

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX "Invoice_schoolId_studentProfileId_idx" ON "Invoice"("schoolId", "studentProfileId");
CREATE INDEX "Invoice_schoolId_status_idx"            ON "Invoice"("schoolId", "status");
CREATE INDEX "Invoice_schoolId_dueDate_idx"           ON "Invoice"("schoolId", "dueDate");

CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

CREATE INDEX "Payment_schoolId_studentProfileId_idx" ON "Payment"("schoolId", "studentProfileId");
CREATE INDEX "Payment_schoolId_paidAt_idx"           ON "Payment"("schoolId", "paidAt");
CREATE INDEX "Payment_schoolId_status_idx"           ON "Payment"("schoolId", "status");

CREATE INDEX "PaymentAllocation_invoiceId_idx"  ON "PaymentAllocation"("invoiceId");
CREATE INDEX "PaymentAllocation_paymentId_idx"  ON "PaymentAllocation"("paymentId");

CREATE INDEX "LessonCreditLog_paymentId_idx" ON "LessonCreditLog"("paymentId");
