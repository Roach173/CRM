-- CreateEnum
CREATE TYPE "FreezeType" AS ENUM ('LESSON_SKIP', 'PERIOD');

-- CreateEnum
CREATE TYPE "FreezeStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AttendanceStatus" ADD VALUE 'FROZEN';

-- DropIndex
DROP INDEX "Attendance_schoolId_id_idx";

-- DropIndex
DROP INDEX "Invoice_schoolId_id_idx";

-- DropIndex
DROP INDEX "LessonCreditLog_schoolId_id_idx";

-- DropIndex
DROP INDEX "Payment_schoolId_id_idx";

-- DropIndex
DROP INDEX "PaymentRefund_schoolId_id_idx";

-- DropIndex
DROP INDEX "SessionStudent_schoolId_id_idx";

-- DropIndex
DROP INDEX "TeacherPayment_schoolId_id_idx";

-- AlterTable
ALTER TABLE "SchoolFinanceConfig" ADD COLUMN     "allowStudentSelfFreeze" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "freezeDeadlineHours" INTEGER;

-- CreateTable
CREATE TABLE "StudentFreeze" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentProfileId" INTEGER NOT NULL,
    "type" "FreezeType" NOT NULL,
    "lessonSessionId" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "reason" TEXT,
    "status" "FreezeStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" INTEGER NOT NULL,
    "cancelledById" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentFreeze_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentFreeze_schoolId_studentProfileId_status_idx" ON "StudentFreeze"("schoolId", "studentProfileId", "status");

-- CreateIndex
CREATE INDEX "StudentFreeze_schoolId_startDate_endDate_idx" ON "StudentFreeze"("schoolId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "StudentFreeze_lessonSessionId_idx" ON "StudentFreeze"("lessonSessionId");

-- CreateIndex
CREATE INDEX "StudentFreeze_studentProfileId_status_startDate_idx" ON "StudentFreeze"("studentProfileId", "status", "startDate");

-- AddForeignKey
ALTER TABLE "StudentFreeze" ADD CONSTRAINT "StudentFreeze_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFreeze" ADD CONSTRAINT "StudentFreeze_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFreeze" ADD CONSTRAINT "StudentFreeze_lessonSessionId_fkey" FOREIGN KEY ("lessonSessionId") REFERENCES "LessonSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFreeze" ADD CONSTRAINT "StudentFreeze_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFreeze" ADD CONSTRAINT "StudentFreeze_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
