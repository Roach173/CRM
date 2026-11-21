-- SchoolFinanceConfig: отдельная таблица финансовых настроек школы (one-to-one)
CREATE TABLE "SchoolFinanceConfig" (
    "id"                INT          NOT NULL GENERATED ALWAYS AS IDENTITY,
    "schoolId"          INT          NOT NULL,
    "basePrice"         DECIMAL(10,2) NOT NULL DEFAULT 5000,
    "billingDays"       INT          NOT NULL DEFAULT 26,
    "pricePerLesson"    INT          NOT NULL DEFAULT 193,
    "currency"          TEXT         NOT NULL DEFAULT 'KGS',
    "defaultSalaryRate" DECIMAL(10,2) NOT NULL DEFAULT 800,
    "paymentCash"       BOOLEAN      NOT NULL DEFAULT true,
    "paymentCard"       BOOLEAN      NOT NULL DEFAULT false,
    "paymentMbank"      BOOLEAN      NOT NULL DEFAULT true,
    "paymentOptima"     BOOLEAN      NOT NULL DEFAULT false,
    "mbankNumber"       TEXT,
    "paymentReceiver"   TEXT,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    "updatedById"       INT,

    CONSTRAINT "SchoolFinanceConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SchoolFinanceConfig_schoolId_key" ON "SchoolFinanceConfig"("schoolId");
CREATE INDEX "SchoolFinanceConfig_schoolId_idx" ON "SchoolFinanceConfig"("schoolId");

ALTER TABLE "SchoolFinanceConfig"
    ADD CONSTRAINT "SchoolFinanceConfig_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SchoolFinanceConfig"
    ADD CONSTRAINT "SchoolFinanceConfig_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- pricePerMonth на StudentGroup для будущих предметных цен
ALTER TABLE "StudentGroup" ADD COLUMN "pricePerMonth" DECIMAL(10,2);
