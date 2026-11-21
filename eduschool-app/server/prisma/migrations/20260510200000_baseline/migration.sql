-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPERADMIN', 'OWNER', 'ADMIN', 'TEACHER', 'STUDENT');

-- CreateEnum
CREATE TYPE "BlockType" AS ENUM ('GRAMMAR', 'SPEAKING_CLUB');

-- CreateEnum
CREATE TYPE "BlockStatus" AS ENUM ('UPCOMING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('UPCOMING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'LOCKED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "GroupStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'PAUSED');

-- CreateEnum
CREATE TYPE "AdjType" AS ENUM ('FINE', 'ADVANCE', 'BONUS');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'PAUSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('TEACHER_UNAVAILABLE', 'CABINET_UNAVAILABLE', 'GROUP_RESCHEDULED', 'EXAM_PERIOD', 'HOLIDAY_CUSTOM');

-- CreateEnum
CREATE TYPE "ExceptionScope" AS ENUM ('SCHOOL', 'TEACHER', 'CABINET', 'GROUP');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'TRANSFER');

-- CreateTable
CREATE TABLE "School" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'KG',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Bishkek',
    "slug" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT NOT NULL,
    "address" TEXT,
    "description" TEXT,
    "logoUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "blockedAt" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "activeDays" INTEGER[],
    "workStart" TEXT NOT NULL DEFAULT '08:00',
    "workEnd" TEXT NOT NULL DEFAULT '20:00',
    "slotDuration" INTEGER NOT NULL DEFAULT 80,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "School_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cabinet" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 15,
    "schoolId" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Cabinet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "schoolId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpSecret" TEXT,
    "backupCodes" TEXT[],

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "level" TEXT,
    "chapter" INTEGER NOT NULL DEFAULT 1,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "paidUntil" TIMESTAMP(3),
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "StudentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "salaryRate" DECIMAL(10,2),
    "position" TEXT,
    "hireDate" TIMESTAMP(3),
    "workingDays" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4, 5]::INTEGER[],
    "maxLessonsPerDay" INTEGER,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentGroup" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "chapter" INTEGER NOT NULL DEFAULT 1,
    "maxStudents" INTEGER NOT NULL DEFAULT 15,
    "status" "GroupStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "StudentGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeSlot" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TimeSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonBlock" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentGroupId" INTEGER,
    "cabinetId" INTEGER,
    "teacherId" INTEGER,
    "timeSlotId" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "days" INTEGER[],
    "level" TEXT NOT NULL,
    "chapter" INTEGER NOT NULL DEFAULT 1,
    "maxStudents" INTEGER NOT NULL DEFAULT 15,
    "type" "BlockType" NOT NULL DEFAULT 'GRAMMAR',
    "status" "BlockStatus" NOT NULL DEFAULT 'UPCOMING',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LessonBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonSession" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "lessonBlockId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "teacherId" INTEGER,
    "teacherIdSnap" INTEGER,
    "cabinetIdSnap" INTEGER,
    "startTimeSnap" TEXT,
    "endTimeSnap" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'UPCOMING',
    "isManualTeacher" BOOLEAN NOT NULL DEFAULT false,
    "isManualCabinet" BOOLEAN NOT NULL DEFAULT false,
    "isManualTime" BOOLEAN NOT NULL DEFAULT false,
    "isMakeup" BOOLEAN NOT NULL DEFAULT false,
    "makeupForSessionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LessonSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "lessonSessionId" INTEGER NOT NULL,
    "studentProfileId" INTEGER NOT NULL,
    "sessionStudentId" INTEGER,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "creditDeducted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrollmentRequest" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentGroupId" INTEGER,
    "lessonBlockId" INTEGER,
    "studentProfileId" INTEGER NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrollmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonCreditLog" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentProfileId" INTEGER NOT NULL,
    "sessionId" INTEGER,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonCreditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherPayment" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "staffProfileId" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "lessonsCount" INTEGER NOT NULL,
    "rateSnapshot" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeacherPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryAdjustment" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "staffProfileId" INTEGER NOT NULL,
    "type" "AdjType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER,

    CONSTRAINT "SalaryAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMembership" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentProfileId" INTEGER NOT NULL,
    "studentGroupId" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,

    CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionStudent" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "lessonSessionId" INTEGER NOT NULL,
    "studentProfileId" INTEGER NOT NULL,
    "snappedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionStudent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentPayment" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentProfileId" INTEGER NOT NULL,
    "creditsAdded" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "pricePerCredit" DECIMAL(10,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "note" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPasskey" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "transports" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleActionLog" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "sessionId" INTEGER,
    "blockId" INTEGER,
    "userId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL DEFAULT 'session',
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "details" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleException" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "type" "ExceptionType" NOT NULL,
    "scope" "ExceptionScope" NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "days" INTEGER[],
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "teacherId" INTEGER,
    "cabinetId" INTEGER,
    "groupId" INTEGER,
    "reason" TEXT,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonSessionArchive" (
    "id" INTEGER NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "lessonBlockId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "teacherId" INTEGER,
    "teacherIdSnap" INTEGER,
    "cabinetIdSnap" INTEGER,
    "startTimeSnap" TEXT,
    "endTimeSnap" TEXT,
    "status" "SessionStatus" NOT NULL,
    "isMakeup" BOOLEAN NOT NULL DEFAULT false,
    "makeupForSessionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonSessionArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceArchive" (
    "id" INTEGER NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "lessonSessionId" INTEGER NOT NULL,
    "studentProfileId" INTEGER NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "creditDeducted" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_GroupStudents" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_GroupStudents_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "School_slug_key" ON "School"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "School_email_key" ON "School"("email");

-- CreateIndex
CREATE INDEX "School_isActive_idx" ON "School"("isActive");

-- CreateIndex
CREATE INDEX "School_country_idx" ON "School"("country");

-- CreateIndex
CREATE INDEX "Cabinet_schoolId_idx" ON "Cabinet"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_schoolId_idx" ON "User"("schoolId");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_schoolId_role_idx" ON "User"("schoolId", "role");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StudentProfile_userId_key" ON "StudentProfile"("userId");

-- CreateIndex
CREATE INDEX "StudentProfile_userId_idx" ON "StudentProfile"("userId");

-- CreateIndex
CREATE INDEX "StudentProfile_isFrozen_idx" ON "StudentProfile"("isFrozen");

-- CreateIndex
CREATE UNIQUE INDEX "StaffProfile_userId_key" ON "StaffProfile"("userId");

-- CreateIndex
CREATE INDEX "StaffProfile_userId_idx" ON "StaffProfile"("userId");

-- CreateIndex
CREATE INDEX "StudentGroup_schoolId_idx" ON "StudentGroup"("schoolId");

-- CreateIndex
CREATE INDEX "StudentGroup_schoolId_status_idx" ON "StudentGroup"("schoolId", "status");

-- CreateIndex
CREATE INDEX "StudentGroup_schoolId_deletedAt_idx" ON "StudentGroup"("schoolId", "deletedAt");

-- CreateIndex
CREATE INDEX "TimeSlot_schoolId_idx" ON "TimeSlot"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "TimeSlot_schoolId_startTime_endTime_key" ON "TimeSlot"("schoolId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "LessonBlock_schoolId_idx" ON "LessonBlock"("schoolId");

-- CreateIndex
CREATE INDEX "LessonBlock_schoolId_status_idx" ON "LessonBlock"("schoolId", "status");

-- CreateIndex
CREATE INDEX "LessonBlock_schoolId_deletedAt_idx" ON "LessonBlock"("schoolId", "deletedAt");

-- CreateIndex
CREATE INDEX "LessonBlock_teacherId_idx" ON "LessonBlock"("teacherId");

-- CreateIndex
CREATE INDEX "LessonBlock_cabinetId_idx" ON "LessonBlock"("cabinetId");

-- CreateIndex
CREATE INDEX "LessonBlock_studentGroupId_idx" ON "LessonBlock"("studentGroupId");

-- CreateIndex
CREATE INDEX "LessonBlock_timeSlotId_idx" ON "LessonBlock"("timeSlotId");

-- CreateIndex
CREATE INDEX "LessonBlock_schoolId_teacherId_idx" ON "LessonBlock"("schoolId", "teacherId");

-- CreateIndex
CREATE INDEX "LessonBlock_schoolId_timeSlotId_idx" ON "LessonBlock"("schoolId", "timeSlotId");

-- CreateIndex
CREATE INDEX "LessonSession_schoolId_idx" ON "LessonSession"("schoolId");

-- CreateIndex
CREATE INDEX "LessonSession_date_idx" ON "LessonSession"("date");

-- CreateIndex
CREATE INDEX "LessonSession_status_idx" ON "LessonSession"("status");

-- CreateIndex
CREATE INDEX "LessonSession_schoolId_date_idx" ON "LessonSession"("schoolId", "date");

-- CreateIndex
CREATE INDEX "LessonSession_teacherId_date_idx" ON "LessonSession"("teacherId", "date");

-- CreateIndex
CREATE INDEX "LessonSession_status_date_idx" ON "LessonSession"("status", "date");

-- CreateIndex
CREATE INDEX "LessonSession_schoolId_status_idx" ON "LessonSession"("schoolId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LessonSession_lessonBlockId_date_key" ON "LessonSession"("lessonBlockId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_sessionStudentId_key" ON "Attendance"("sessionStudentId");

-- CreateIndex
CREATE INDEX "Attendance_schoolId_idx" ON "Attendance"("schoolId");

-- CreateIndex
CREATE INDEX "Attendance_lessonSessionId_idx" ON "Attendance"("lessonSessionId");

-- CreateIndex
CREATE INDEX "Attendance_studentProfileId_idx" ON "Attendance"("studentProfileId");

-- CreateIndex
CREATE INDEX "Attendance_studentProfileId_createdAt_idx" ON "Attendance"("studentProfileId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_lessonSessionId_studentProfileId_key" ON "Attendance"("lessonSessionId", "studentProfileId");

-- CreateIndex
CREATE INDEX "EnrollmentRequest_schoolId_idx" ON "EnrollmentRequest"("schoolId");

-- CreateIndex
CREATE INDEX "EnrollmentRequest_studentGroupId_idx" ON "EnrollmentRequest"("studentGroupId");

-- CreateIndex
CREATE INDEX "EnrollmentRequest_lessonBlockId_idx" ON "EnrollmentRequest"("lessonBlockId");

-- CreateIndex
CREATE INDEX "EnrollmentRequest_studentProfileId_idx" ON "EnrollmentRequest"("studentProfileId");

-- CreateIndex
CREATE INDEX "EnrollmentRequest_studentGroupId_status_idx" ON "EnrollmentRequest"("studentGroupId", "status");

-- CreateIndex
CREATE INDEX "EnrollmentRequest_studentProfileId_status_idx" ON "EnrollmentRequest"("studentProfileId", "status");

-- CreateIndex
CREATE INDEX "LessonCreditLog_schoolId_idx" ON "LessonCreditLog"("schoolId");

-- CreateIndex
CREATE INDEX "LessonCreditLog_studentProfileId_idx" ON "LessonCreditLog"("studentProfileId");

-- CreateIndex
CREATE INDEX "LessonCreditLog_createdAt_idx" ON "LessonCreditLog"("createdAt");

-- CreateIndex
CREATE INDEX "TeacherPayment_schoolId_idx" ON "TeacherPayment"("schoolId");

-- CreateIndex
CREATE INDEX "TeacherPayment_staffProfileId_idx" ON "TeacherPayment"("staffProfileId");

-- CreateIndex
CREATE INDEX "TeacherPayment_period_idx" ON "TeacherPayment"("period");

-- CreateIndex
CREATE INDEX "SalaryAdjustment_schoolId_idx" ON "SalaryAdjustment"("schoolId");

-- CreateIndex
CREATE INDEX "SalaryAdjustment_staffProfileId_idx" ON "SalaryAdjustment"("staffProfileId");

-- CreateIndex
CREATE INDEX "SalaryAdjustment_staffProfileId_month_idx" ON "SalaryAdjustment"("staffProfileId", "month");

-- CreateIndex
CREATE INDEX "SalaryAdjustment_month_idx" ON "SalaryAdjustment"("month");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "GroupMembership_schoolId_idx" ON "GroupMembership"("schoolId");

-- CreateIndex
CREATE INDEX "GroupMembership_studentGroupId_idx" ON "GroupMembership"("studentGroupId");

-- CreateIndex
CREATE INDEX "GroupMembership_studentProfileId_idx" ON "GroupMembership"("studentProfileId");

-- CreateIndex
CREATE INDEX "GroupMembership_studentGroupId_status_idx" ON "GroupMembership"("studentGroupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMembership_studentProfileId_studentGroupId_key" ON "GroupMembership"("studentProfileId", "studentGroupId");

-- CreateIndex
CREATE INDEX "SessionStudent_schoolId_idx" ON "SessionStudent"("schoolId");

-- CreateIndex
CREATE INDEX "SessionStudent_lessonSessionId_idx" ON "SessionStudent"("lessonSessionId");

-- CreateIndex
CREATE INDEX "SessionStudent_studentProfileId_idx" ON "SessionStudent"("studentProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionStudent_lessonSessionId_studentProfileId_key" ON "SessionStudent"("lessonSessionId", "studentProfileId");

-- CreateIndex
CREATE INDEX "StudentPayment_schoolId_idx" ON "StudentPayment"("schoolId");

-- CreateIndex
CREATE INDEX "StudentPayment_studentProfileId_idx" ON "StudentPayment"("studentProfileId");

-- CreateIndex
CREATE INDEX "StudentPayment_schoolId_createdAt_idx" ON "StudentPayment"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "UserPasskey_userId_idx" ON "UserPasskey"("userId");

-- CreateIndex
CREATE INDEX "ScheduleActionLog_schoolId_createdAt_idx" ON "ScheduleActionLog"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduleActionLog_sessionId_idx" ON "ScheduleActionLog"("sessionId");

-- CreateIndex
CREATE INDEX "ScheduleActionLog_blockId_idx" ON "ScheduleActionLog"("blockId");

-- CreateIndex
CREATE INDEX "ScheduleActionLog_userId_createdAt_idx" ON "ScheduleActionLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduleException_schoolId_startDate_idx" ON "ScheduleException"("schoolId", "startDate");

-- CreateIndex
CREATE INDEX "ScheduleException_schoolId_scope_idx" ON "ScheduleException"("schoolId", "scope");

-- CreateIndex
CREATE INDEX "ScheduleException_teacherId_startDate_idx" ON "ScheduleException"("teacherId", "startDate");

-- CreateIndex
CREATE INDEX "ScheduleException_cabinetId_startDate_idx" ON "ScheduleException"("cabinetId", "startDate");

-- CreateIndex
CREATE INDEX "LessonSessionArchive_schoolId_date_idx" ON "LessonSessionArchive"("schoolId", "date");

-- CreateIndex
CREATE INDEX "LessonSessionArchive_lessonBlockId_idx" ON "LessonSessionArchive"("lessonBlockId");

-- CreateIndex
CREATE INDEX "AttendanceArchive_schoolId_idx" ON "AttendanceArchive"("schoolId");

-- CreateIndex
CREATE INDEX "AttendanceArchive_lessonSessionId_idx" ON "AttendanceArchive"("lessonSessionId");

-- CreateIndex
CREATE INDEX "AttendanceArchive_studentProfileId_idx" ON "AttendanceArchive"("studentProfileId");

-- CreateIndex
CREATE INDEX "Webhook_schoolId_idx" ON "Webhook"("schoolId");

-- CreateIndex
CREATE INDEX "_GroupStudents_B_index" ON "_GroupStudents"("B");

-- AddForeignKey
ALTER TABLE "Cabinet" ADD CONSTRAINT "Cabinet_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentProfile" ADD CONSTRAINT "StudentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentGroup" ADD CONSTRAINT "StudentGroup_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeSlot" ADD CONSTRAINT "TimeSlot_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBlock" ADD CONSTRAINT "LessonBlock_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBlock" ADD CONSTRAINT "LessonBlock_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBlock" ADD CONSTRAINT "LessonBlock_cabinetId_fkey" FOREIGN KEY ("cabinetId") REFERENCES "Cabinet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBlock" ADD CONSTRAINT "LessonBlock_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "StaffProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBlock" ADD CONSTRAINT "LessonBlock_timeSlotId_fkey" FOREIGN KEY ("timeSlotId") REFERENCES "TimeSlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonSession" ADD CONSTRAINT "LessonSession_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonSession" ADD CONSTRAINT "LessonSession_lessonBlockId_fkey" FOREIGN KEY ("lessonBlockId") REFERENCES "LessonBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonSession" ADD CONSTRAINT "LessonSession_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "StaffProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonSession" ADD CONSTRAINT "LessonSession_makeupForSessionId_fkey" FOREIGN KEY ("makeupForSessionId") REFERENCES "LessonSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_lessonSessionId_fkey" FOREIGN KEY ("lessonSessionId") REFERENCES "LessonSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_sessionStudentId_fkey" FOREIGN KEY ("sessionStudentId") REFERENCES "SessionStudent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentRequest" ADD CONSTRAINT "EnrollmentRequest_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentRequest" ADD CONSTRAINT "EnrollmentRequest_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentRequest" ADD CONSTRAINT "EnrollmentRequest_lessonBlockId_fkey" FOREIGN KEY ("lessonBlockId") REFERENCES "LessonBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentRequest" ADD CONSTRAINT "EnrollmentRequest_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonCreditLog" ADD CONSTRAINT "LessonCreditLog_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonCreditLog" ADD CONSTRAINT "LessonCreditLog_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherPayment" ADD CONSTRAINT "TeacherPayment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherPayment" ADD CONSTRAINT "TeacherPayment_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherPayment" ADD CONSTRAINT "TeacherPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryAdjustment" ADD CONSTRAINT "SalaryAdjustment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryAdjustment" ADD CONSTRAINT "SalaryAdjustment_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryAdjustment" ADD CONSTRAINT "SalaryAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionStudent" ADD CONSTRAINT "SessionStudent_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionStudent" ADD CONSTRAINT "SessionStudent_lessonSessionId_fkey" FOREIGN KEY ("lessonSessionId") REFERENCES "LessonSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionStudent" ADD CONSTRAINT "SessionStudent_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPayment" ADD CONSTRAINT "StudentPayment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPayment" ADD CONSTRAINT "StudentPayment_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPayment" ADD CONSTRAINT "StudentPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPasskey" ADD CONSTRAINT "UserPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleActionLog" ADD CONSTRAINT "ScheduleActionLog_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleActionLog" ADD CONSTRAINT "ScheduleActionLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LessonSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleActionLog" ADD CONSTRAINT "ScheduleActionLog_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "LessonBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleActionLog" ADD CONSTRAINT "ScheduleActionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_GroupStudents" ADD CONSTRAINT "_GroupStudents_A_fkey" FOREIGN KEY ("A") REFERENCES "StudentGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_GroupStudents" ADD CONSTRAINT "_GroupStudents_B_fkey" FOREIGN KEY ("B") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('TRIAL', 'STARTER', 'OPTIMA', 'NETWORK');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'OVERDUE', 'BLOCKED');

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL DEFAULT 'TRIAL',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "trialEndsAt" TIMESTAMP(3),
    "paidUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherRateLog" (
    "id" SERIAL NOT NULL,
    "staffProfileId" INTEGER NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "changedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeacherRateLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolSchedulePolicy" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "activeDays" INTEGER[],
    "workStart" TEXT NOT NULL,
    "workEnd" TEXT NOT NULL,
    "slotDuration" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolSchedulePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolPolicyLog" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "activeDays" INTEGER[],
    "workStart" TEXT NOT NULL,
    "workEnd" TEXT NOT NULL,
    "slotDuration" INTEGER NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedById" INTEGER NOT NULL,

    CONSTRAINT "SchoolPolicyLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResetToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateEnum
CREATE TYPE "ManualEntryType" AS ENUM ('ADD', 'REMOVE');

-- CreateTable
CREATE TABLE "ManualLessonEntry" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "staffProfileId" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "type" "ManualEntryType" NOT NULL,
    "label" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualLessonEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_schoolId_key" ON "Subscription"("schoolId");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX "Subscription_trialEndsAt_idx" ON "Subscription"("trialEndsAt");

-- CreateIndex
CREATE INDEX "Subscription_paidUntil_idx" ON "Subscription"("paidUntil");

-- CreateIndex
CREATE INDEX "TeacherRateLog_staffProfileId_effectiveFrom_idx" ON "TeacherRateLog"("staffProfileId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "SchoolSchedulePolicy_schoolId_effectiveFrom_idx" ON "SchoolSchedulePolicy"("schoolId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "SchoolSchedulePolicy_schoolId_effectiveFrom_effectiveTo_idx" ON "SchoolSchedulePolicy"("schoolId", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE INDEX "SchoolPolicyLog_schoolId_changedAt_idx" ON "SchoolPolicyLog"("schoolId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_token_idx" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "ResetToken_userId_idx" ON "ResetToken"("userId");

-- CreateIndex
CREATE INDEX "ManualLessonEntry_schoolId_idx" ON "ManualLessonEntry"("schoolId");

-- CreateIndex
CREATE INDEX "ManualLessonEntry_staffProfileId_idx" ON "ManualLessonEntry"("staffProfileId");

-- CreateIndex
CREATE INDEX "ManualLessonEntry_staffProfileId_month_idx" ON "ManualLessonEntry"("staffProfileId", "month");

-- CreateIndex
CREATE INDEX "ManualLessonEntry_month_idx" ON "ManualLessonEntry"("month");

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "verificationToken" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "verificationExpires" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherRateLog" ADD CONSTRAINT "TeacherRateLog_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSchedulePolicy" ADD CONSTRAINT "SchoolSchedulePolicy_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolPolicyLog" ADD CONSTRAINT "SchoolPolicyLog_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResetToken" ADD CONSTRAINT "ResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualLessonEntry" ADD CONSTRAINT "ManualLessonEntry_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualLessonEntry" ADD CONSTRAINT "ManualLessonEntry_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualLessonEntry" ADD CONSTRAINT "ManualLessonEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


