import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.test'), override: true });

export const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

// Truncate all tables in dependency order (leaves → roots).
// RESTART IDENTITY resets auto-increment sequences.
// CASCADE handles any tables not explicitly listed (e.g. onDelete Cascade children).
//
// IMPORTANT: This function is NOT safe to call from multiple parallel Jest workers
// against the same database. The integration project enforces maxWorkers:1 in
// jest.config.js to prevent concurrent cleanDb() calls from wiping each other's data.
export async function cleanDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "IdempotencyKey",
      "IntegrationSyncLog",
      "IntegrationConnection",
      "WebhookDelivery",
      "Webhook",
      "StaffInvite",
      "NpsResponse",
      "LeadAttribution",
      "Lead",
      "MarketingSpend",
      "MarketingCampaign",
      "Expense",
      "ScheduleException",
      "StudentPayment",
      "CreditIssuanceReversal",
      "FinancialAdjustment",
      "PaymentRefundAllocation",
      "PaymentRefund",
      "CreditIssuance",
      "PaymentAllocation",
      "InvoiceLine",
      "TeacherPaymentLesson",
      "TeacherPayment",
      "SalaryAdjustment",
      "ManualLessonEntry",
      "AttendanceMonthlySummary",
      "AttendanceArchive",
      "LessonSessionArchive",
      "StudentFreeze",
      "LessonCreditLog",
      "Attendance",
      "SessionStudent",
      "LessonSession",
      "LessonBlock",
      "GroupMembership",
      "GroupProgression",
      "ParentChild",
      "ParentProfile",
      "StudentGroup",
      "EnrollmentRequest",
      "TimeSlot",
      "TeacherRateLog",
      "SchoolFinanceConfig",
      "SchoolSchedulePolicy",
      "SchoolPolicyLog",
      "StaffProfile",
      "Payment",
      "Invoice",
      "StudentProfile",
      "UserPasskey",
      "RefreshToken",
      "Notification",
      "ScheduleActionLog",
      "ResetToken",
      "Cabinet",
      "Subscription",
      "User",
      "School"
    RESTART IDENTITY CASCADE
  `);
}

// ─── Fixture factories ────────────────────────────────────────────────────────

export async function createSchool(overrides: {
  timezone?: string;
  activeDays?: number[];
  workStart?: string;
  workEnd?: string;
  slotDuration?: number;
} = {}) {
  return prisma.school.create({
    data: {
      name: 'Test School',
      slug: `test-school-${Date.now()}`,
      city: 'Bishkek',
      email: `test-school-${Date.now()}@test.local`,
      timezone: overrides.timezone ?? 'UTC',
      activeDays: overrides.activeDays ?? [0, 1, 2, 3, 4],
      workStart: overrides.workStart ?? '09:00',
      workEnd: overrides.workEnd ?? '18:00',
      slotDuration: overrides.slotDuration ?? 60,
    },
  });
}

export async function createUser(schoolId: number, role: 'OWNER' | 'ADMIN' | 'TEACHER' | 'STUDENT') {
  return prisma.user.create({
    data: {
      schoolId,
      role,
      firstName: 'Test',
      lastName: role,
      email: `test-${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
      password: 'hashed',
    },
  });
}

export async function createStudentProfile(userId: number, schoolId: number, credits = 10) {
  return prisma.studentProfile.create({
    data: { userId, credits },
  });
}

export async function createStaffProfile(userId: number, schoolId: number, salaryRate = 5000) {
  return prisma.staffProfile.create({
    data: { userId, salaryRate },
  });
}

export async function createGroup(schoolId: number) {
  return prisma.studentGroup.create({
    data: { schoolId, level: 'A1', chapter: 1, status: 'ACTIVE' },
  });
}

export async function createBlock(opts: {
  groupId?: number | null;
  schoolId: number;
  staffProfileId: number;
  days?: number[];
  startDate?: Date;
  endDate?: Date | null;
  type?: 'GRAMMAR' | 'SPEAKING_CLUB';
  status?: 'UPCOMING' | 'COMPLETED' | 'CANCELLED';
  deletedAt?: Date | null;
}) {
  const slot = await prisma.timeSlot.upsert({
    where: { schoolId_startTime_endTime: { schoolId: opts.schoolId, startTime: '09:00', endTime: '10:00' } },
    update: {},
    create: { schoolId: opts.schoolId, startTime: '09:00', endTime: '10:00', order: 1 },
  });
  return prisma.lessonBlock.create({
    data: {
      schoolId: opts.schoolId,
      studentGroupId: opts.groupId ?? null,
      teacherId: opts.staffProfileId,
      timeSlotId: slot.id,
      days: opts.days ?? [0, 2, 4], // Mon, Wed, Fri
      startDate: opts.startDate ?? new Date('2026-01-01T12:00:00.000Z'),
      endDate: opts.endDate ?? null,
      type: opts.type ?? 'GRAMMAR',
      status: opts.status ?? 'UPCOMING',
      deletedAt: opts.deletedAt ?? null,
      startTime: '09:00',
      endTime: '10:00',
      level: 'A1',
      chapter: 1,
    },
    include: { school: true, studentGroup: true },
  });
}

export async function createSession(opts: {
  blockId: number;
  schoolId: number;
  staffProfileId: number;
  date: Date;
  status?: 'UPCOMING' | 'COMPLETED' | 'CANCELLED' | 'INVALIDATED' | 'IN_PROGRESS' | 'LOCKED';
}) {
  return prisma.lessonSession.create({
    data: {
      schoolId: opts.schoolId,
      lessonBlockId: opts.blockId,
      date: opts.date,
      status: opts.status ?? 'UPCOMING',
      teacherIdSnap: opts.staffProfileId,
      startTimeSnap: '09:00',
      endTimeSnap: '10:00',
    },
  });
}

export async function createSessionStudent(
  sessionId: number,
  studentProfileId: number,
  schoolId: number
) {
  return prisma.sessionStudent.create({
    data: { schoolId, lessonSessionId: sessionId, studentProfileId },
  });
}

export async function createFinanceConfig(schoolId: number, pricePerLesson = 1) {
  return prisma.schoolFinanceConfig.create({
    data: { schoolId, pricePerLesson },
  });
}

export async function createStudentFreeze(opts: {
  schoolId: number;
  studentProfileId: number;
  createdById: number;
  type: 'LESSON_SKIP' | 'PERIOD';
  lessonSessionId?: number;
  startDate?: Date;
  endDate?: Date | null;
  reason?: string;
}) {
  return prisma.studentFreeze.create({
    data: {
      schoolId:         opts.schoolId,
      studentProfileId: opts.studentProfileId,
      createdById:      opts.createdById,
      type:             opts.type,
      lessonSessionId:  opts.lessonSessionId ?? null,
      startDate:        opts.startDate ?? null,
      endDate:          opts.endDate ?? null,
      reason:           opts.reason ?? null,
      status:           'ACTIVE',
    },
  });
}

export async function createMembership(groupId: number, studentProfileId: number, schoolId: number) {
  return prisma.groupMembership.create({
    data: { studentGroupId: groupId, studentProfileId, schoolId, status: 'ACTIVE' },
  });
}

// ─── Phase 7.1 fixtures ───────────────────────────────────────────────────────

export async function createInvoiceDraft(
  studentProfileId: number,
  schoolId: number,
  createdById: number,
  opts: { note?: string; currencyCode?: string } = {},
) {
  return prisma.invoice.create({
    data: {
      schoolId,
      studentProfileId,
      createdById,
      status:      'DRAFT',
      totalAmount: 0,
      paidAmount:  0,
      currencyCode: opts.currencyCode ?? 'KGS',
      note:         opts.note,
    },
  });
}

export async function createPaymentRecord(
  studentProfileId: number,
  schoolId: number,
  receivedById: number,
  amount: string,
  method: 'CASH' | 'CARD' | 'TRANSFER' = 'CASH',
) {
  return prisma.payment.create({
    data: {
      schoolId,
      studentProfileId,
      receivedById,
      amount,
      method,
      status: 'CONFIRMED',
    },
  });
}

// ─── Phase 4 PR 3 fixtures ────────────────────────────────────────────────────

export async function createIssuedInvoice(
  studentProfileId: number,
  schoolId: number,
  createdById: number,
  totalAmount: number,
  opts: { currencyCode?: string } = {},
) {
  return prisma.invoice.create({
    data: {
      schoolId,
      studentProfileId,
      createdById,
      status:       'ISSUED',
      totalAmount,
      paidAmount:   0,
      currencyCode: opts.currencyCode ?? 'KGS',
    },
  });
}

/** Creates a PaymentAllocation directly in DB — bypasses locking (fixture only). */
export async function createPaymentAllocationRecord(
  paymentId: number,
  invoiceId: number,
  amount: string,
) {
  return prisma.paymentAllocation.create({
    data: { paymentId, invoiceId, amount },
  });
}

// ─── Phase 4 PR 4 fixtures ────────────────────────────────────────────────────

/** Creates a TeacherPayment directly in DB — bypasses idempotency (fixture only). */
export async function createTeacherPaymentRecord(
  staffProfileId: number,
  schoolId: number,
  createdById: number,
  opts: { period?: string; lessonsCount?: number; rate?: number } = {},
) {
  const period = opts.period ?? new Date().toISOString().slice(0, 7);
  const lessonsCount = opts.lessonsCount ?? 1;
  const rate = opts.rate ?? 5000;
  return prisma.teacherPayment.create({
    data: {
      schoolId,
      staffProfileId,
      period,
      lessonsCount,
      rateSnapshot: rate,
      amount: lessonsCount * rate,
      createdById,
    },
  });
}

/** Creates a completed LessonSession with one attendance record (fixture only). */
export async function createCompletedSessionWithAttendance(opts: {
  blockId: number;
  schoolId: number;
  staffProfileId: number;
  studentProfileId: number;
  date?: Date;
}) {
  const date = opts.date ?? new Date('2026-06-02T12:00:00.000Z');
  const session = await prisma.lessonSession.create({
    data: {
      schoolId: opts.schoolId,
      lessonBlockId: opts.blockId,
      date,
      status: 'COMPLETED',
      teacherIdSnap: opts.staffProfileId,
      startTimeSnap: '09:00',
      endTimeSnap: '10:00',
    },
  });
  const ss = await prisma.sessionStudent.create({
    data: { schoolId: opts.schoolId, lessonSessionId: session.id, studentProfileId: opts.studentProfileId },
  });
  await prisma.attendance.create({
    data: {
      schoolId: opts.schoolId,
      lessonSessionId: session.id,
      studentProfileId: opts.studentProfileId,
      sessionStudentId: ss.id,
      status: 'PRESENT',
      creditDeducted: true,
    },
  });
  return session;
}
