-- AlterEnum: add PARENT to Role
ALTER TYPE "Role" ADD VALUE 'PARENT';

-- AlterTable: StudentProfile — add atRiskSince
ALTER TABLE "StudentProfile" ADD COLUMN "atRiskSince" TIMESTAMP(3);
CREATE INDEX "StudentProfile_atRiskSince_idx" ON "StudentProfile"("atRiskSince");

-- AlterTable: EnrollmentRequest — add priority, expiresAt
ALTER TABLE "EnrollmentRequest" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EnrollmentRequest" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "EnrollmentRequest_studentGroupId_status_createdAt_idx" ON "EnrollmentRequest"("studentGroupId", "status", "createdAt");

-- CreateTable: AttendanceMonthlySummary
CREATE TABLE "AttendanceMonthlySummary" (
    "id"               SERIAL NOT NULL,
    "schoolId"         INTEGER NOT NULL,
    "studentProfileId" INTEGER NOT NULL,
    "year"             INTEGER NOT NULL,
    "month"            INTEGER NOT NULL,
    "totalSessions"    INTEGER NOT NULL,
    "attended"         INTEGER NOT NULL,
    "absent"           INTEGER NOT NULL,
    "late"             INTEGER NOT NULL,
    "creditsDeducted"  INTEGER NOT NULL DEFAULT 0,
    "archivedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceMonthlySummary_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttendanceMonthlySummary_schoolId_studentProfileId_year_month_key"
    ON "AttendanceMonthlySummary"("schoolId", "studentProfileId", "year", "month");
CREATE INDEX "AttendanceMonthlySummary_schoolId_studentProfileId_idx"
    ON "AttendanceMonthlySummary"("schoolId", "studentProfileId");
CREATE INDEX "AttendanceMonthlySummary_schoolId_year_month_idx"
    ON "AttendanceMonthlySummary"("schoolId", "year", "month");

ALTER TABLE "AttendanceMonthlySummary"
    ADD CONSTRAINT "AttendanceMonthlySummary_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceMonthlySummary"
    ADD CONSTRAINT "AttendanceMonthlySummary_studentProfileId_fkey"
    FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: ParentProfile
CREATE TABLE "ParentProfile" (
    "id"        SERIAL NOT NULL,
    "userId"    INTEGER NOT NULL,
    "schoolId"  INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ParentProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ParentProfile_userId_key" ON "ParentProfile"("userId");
CREATE INDEX "ParentProfile_userId_idx" ON "ParentProfile"("userId");
CREATE INDEX "ParentProfile_schoolId_idx" ON "ParentProfile"("schoolId");

ALTER TABLE "ParentProfile"
    ADD CONSTRAINT "ParentProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ParentProfile"
    ADD CONSTRAINT "ParentProfile_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: ParentChild
CREATE TABLE "ParentChild" (
    "id"               SERIAL NOT NULL,
    "parentProfileId"  INTEGER NOT NULL,
    "studentProfileId" INTEGER NOT NULL,

    CONSTRAINT "ParentChild_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ParentChild_parentProfileId_studentProfileId_key"
    ON "ParentChild"("parentProfileId", "studentProfileId");
CREATE INDEX "ParentChild_parentProfileId_idx" ON "ParentChild"("parentProfileId");
CREATE INDEX "ParentChild_studentProfileId_idx" ON "ParentChild"("studentProfileId");

ALTER TABLE "ParentChild"
    ADD CONSTRAINT "ParentChild_parentProfileId_fkey"
    FOREIGN KEY ("parentProfileId") REFERENCES "ParentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ParentChild"
    ADD CONSTRAINT "ParentChild_studentProfileId_fkey"
    FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
