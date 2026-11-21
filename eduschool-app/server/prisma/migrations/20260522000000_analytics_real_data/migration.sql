-- Minimal real-data support for the existing owner analytics UI.

CREATE TYPE "ExpenseCategory" AS ENUM ('SALARY', 'RENT', 'MARKETING', 'UTILITIES', 'MATERIALS', 'SOFTWARE', 'TAX', 'OTHER');
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'TRIAL_SCHEDULED', 'TRIAL_ATTENDED', 'PAID', 'ACTIVE', 'RENEWED', 'LOST');

ALTER TABLE "StaffProfile" ADD COLUMN "rating" DECIMAL(3,2);
ALTER TABLE "GroupMembership" ADD COLUMN "leftReason" TEXT;

CREATE TABLE "Expense" (
  "id" SERIAL NOT NULL,
  "schoolId" INTEGER NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "category" "ExpenseCategory" NOT NULL DEFAULT 'OTHER',
  "description" TEXT,
  "expenseDate" TIMESTAMP(3) NOT NULL,
  "teacherId" INTEGER,
  "teacherPaymentId" INTEGER,
  "createdById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingCampaign" (
  "id" SERIAL NOT NULL,
  "schoolId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingSpend" (
  "id" SERIAL NOT NULL,
  "schoolId" INTEGER NOT NULL,
  "campaignId" INTEGER,
  "source" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "spendDate" TIMESTAMP(3) NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketingSpend_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Lead" (
  "id" SERIAL NOT NULL,
  "schoolId" INTEGER NOT NULL,
  "campaignId" INTEGER,
  "studentProfileId" INTEGER,
  "firstName" TEXT,
  "lastName" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "source" TEXT NOT NULL DEFAULT 'Organic',
  "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "trialAt" TIMESTAMP(3),
  "trialAttendedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "becameActiveAt" TIMESTAMP(3),
  "renewedAt" TIMESTAMP(3),
  "lostAt" TIMESTAMP(3),
  "note" TEXT,
  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NpsResponse" (
  "id" SERIAL NOT NULL,
  "schoolId" INTEGER NOT NULL,
  "score" INTEGER NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NpsResponse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Expense_teacherPaymentId_key" ON "Expense"("teacherPaymentId");
CREATE INDEX "Expense_schoolId_idx" ON "Expense"("schoolId");
CREATE INDEX "Expense_schoolId_expenseDate_idx" ON "Expense"("schoolId", "expenseDate");
CREATE INDEX "Expense_schoolId_category_idx" ON "Expense"("schoolId", "category");
CREATE INDEX "Expense_teacherId_idx" ON "Expense"("teacherId");
CREATE INDEX "MarketingCampaign_schoolId_idx" ON "MarketingCampaign"("schoolId");
CREATE INDEX "MarketingCampaign_schoolId_source_idx" ON "MarketingCampaign"("schoolId", "source");
CREATE INDEX "MarketingSpend_schoolId_idx" ON "MarketingSpend"("schoolId");
CREATE INDEX "MarketingSpend_schoolId_spendDate_idx" ON "MarketingSpend"("schoolId", "spendDate");
CREATE INDEX "MarketingSpend_schoolId_source_idx" ON "MarketingSpend"("schoolId", "source");
CREATE INDEX "MarketingSpend_campaignId_idx" ON "MarketingSpend"("campaignId");
CREATE INDEX "Lead_schoolId_idx" ON "Lead"("schoolId");
CREATE INDEX "Lead_schoolId_createdAt_idx" ON "Lead"("schoolId", "createdAt");
CREATE INDEX "Lead_schoolId_source_idx" ON "Lead"("schoolId", "source");
CREATE INDEX "Lead_schoolId_status_idx" ON "Lead"("schoolId", "status");
CREATE INDEX "Lead_campaignId_idx" ON "Lead"("campaignId");
CREATE INDEX "Lead_studentProfileId_idx" ON "Lead"("studentProfileId");
CREATE INDEX "NpsResponse_schoolId_idx" ON "NpsResponse"("schoolId");
CREATE INDEX "NpsResponse_schoolId_createdAt_idx" ON "NpsResponse"("schoolId", "createdAt");

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "StaffProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_teacherPaymentId_fkey" FOREIGN KEY ("teacherPaymentId") REFERENCES "TeacherPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketingSpend" ADD CONSTRAINT "MarketingSpend_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketingSpend" ADD CONSTRAINT "MarketingSpend_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NpsResponse" ADD CONSTRAINT "NpsResponse_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
