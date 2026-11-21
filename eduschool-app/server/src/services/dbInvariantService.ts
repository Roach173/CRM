/**
 * Phase 5 — DB Invariant Pre-Check Service
 *
 * Validates that existing data satisfies all invariants that will be enforced
 * by migration 20260527030000_phase5_db_invariants before that migration runs.
 *
 * Severity:
 *   BLOCKER — CHECK constraint or partial unique index will reject this row;
 *              migration will fail if any exist.
 *   WARNING  — data quality issue that won't block the migration but should
 *              be investigated.
 */
import { PrismaClient } from '@prisma/client';

export interface InvariantViolation {
  check: string;
  severity: 'BLOCKER' | 'WARNING';
  count: number;
  sampleIds: number[];
  repairStrategy: string;
}

type RawIdRow  = { id: bigint | number };
type CountRow  = { count: bigint };

function toIds(rows: RawIdRow[]): number[] {
  return rows.map(r => Number(r.id));
}

function toCount(rows: CountRow[]): number {
  return rows.length > 0 ? Number(rows[0].count) : 0;
}

async function countRaw(prisma: PrismaClient, sql: TemplateStringsArray, ...values: unknown[]): Promise<number> {
  const rows = await (prisma.$queryRaw as Function)(sql, ...values) as CountRow[];
  return toCount(rows);
}

export async function runDbInvariantPrecheck(prisma: PrismaClient): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  // ─── 1. Negative / invalid values ──────────────────────────────────────────

  // Negative credits = lesson debt — this is valid by business design.
  // Report as WARNING (finance review) not BLOCKER. Never auto-correct to 0.
  const negCredits = await prisma.$queryRaw<RawIdRow[]>`
    SELECT id FROM "StudentProfile" WHERE credits < 0 LIMIT 20`;
  if (negCredits.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "StudentProfile" WHERE credits < 0`;
    violations.push({
      check: 'StudentProfile.credits < 0 (debt report)',
      severity: 'WARNING',
      count: toCount(total),
      sampleIds: toIds(negCredits),
      repairStrategy:
        'Debt balance is valid by design (deferred payment model). Do NOT auto-correct to zero — this destroys real debt records. Present list to school finance team for review.',
    });
  }

  const negSalary = await prisma.$queryRaw<RawIdRow[]>`
    SELECT id FROM "StaffProfile"
    WHERE "salaryRate" IS NOT NULL AND "salaryRate" < 0 LIMIT 20`;
  if (negSalary.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "StaffProfile"
      WHERE "salaryRate" IS NOT NULL AND "salaryRate" < 0`;
    violations.push({
      check: 'StaffProfile.salaryRate < 0',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(negSalary),
      repairStrategy:
        'Review TeacherRateLog; SET salaryRate = 0 WHERE salaryRate < 0 after verification.',
    });
  }

  const badPayment = await prisma.$queryRaw<RawIdRow[]>`
    SELECT id FROM "Payment" WHERE amount <= 0 LIMIT 20`;
  if (badPayment.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "Payment" WHERE amount <= 0`;
    violations.push({
      check: 'Payment.amount <= 0',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(badPayment),
      repairStrategy:
        'Manual review required. VOID erroneous Payment rows — do NOT delete financial records.',
    });
  }

  const badStudentPayment = await prisma.$queryRaw<RawIdRow[]>`
    SELECT id FROM "StudentPayment" WHERE amount <= 0 LIMIT 20`;
  if (badStudentPayment.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "StudentPayment" WHERE amount <= 0`;
    violations.push({
      check: 'StudentPayment.amount <= 0',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(badStudentPayment),
      repairStrategy:
        'Manual review required. StudentPayment is a credit-purchase event — do NOT delete.',
    });
  }

  const badTeacherPayment = await prisma.$queryRaw<RawIdRow[]>`
    SELECT id FROM "TeacherPayment" WHERE amount <= 0 LIMIT 20`;
  if (badTeacherPayment.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "TeacherPayment" WHERE amount <= 0`;
    violations.push({
      check: 'TeacherPayment.amount <= 0',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(badTeacherPayment),
      repairStrategy:
        'TeacherPayments are immutable salary records. Manual admin review + correction record required.',
    });
  }

  const badRefund = await prisma.$queryRaw<RawIdRow[]>`
    SELECT id FROM "PaymentRefund" WHERE amount <= 0 LIMIT 20`;
  if (badRefund.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "PaymentRefund" WHERE amount <= 0`;
    violations.push({
      check: 'PaymentRefund.amount <= 0',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(badRefund),
      repairStrategy:
        'VOID PaymentRefund rows with amount <= 0 — they indicate data-entry errors.',
    });
  }

  // ─── 2. Duplicate financial rows ───────────────────────────────────────────

  const dupDebit = await prisma.$queryRaw<{ attendanceid: bigint | number; cnt: bigint }[]>`
    SELECT "attendanceId" AS attendanceid, COUNT(*) AS cnt
    FROM "LessonCreditLog"
    WHERE "attendanceId" IS NOT NULL AND "type" = 'DEBIT'::"CreditLogType"
    GROUP BY "attendanceId"
    HAVING COUNT(*) > 1
    LIMIT 20`;
  if (dupDebit.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM (
        SELECT "attendanceId"
        FROM "LessonCreditLog"
        WHERE "attendanceId" IS NOT NULL AND "type" = 'DEBIT'::"CreditLogType"
        GROUP BY "attendanceId" HAVING COUNT(*) > 1
      ) sub`;
    violations.push({
      check: 'Duplicate DEBIT LessonCreditLog per attendanceId',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: dupDebit.map(r => Number(r.attendanceid)),
      repairStrategy:
        'Keep earliest DEBIT per attendanceId; reverse duplicates with a CORRECTION log entry (reversal ledger pattern).',
    });
  }

  const dupPendingEnrollment = await prisma.$queryRaw<{ studentprofileid: bigint | number; cnt: bigint }[]>`
    SELECT "studentProfileId" AS studentprofileid, COUNT(*) AS cnt
    FROM "EnrollmentRequest"
    WHERE "studentGroupId" IS NOT NULL AND "status" = 'PENDING'::"EnrollmentStatus"
    GROUP BY "studentProfileId", "studentGroupId"
    HAVING COUNT(*) > 1
    LIMIT 20`;
  if (dupPendingEnrollment.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM (
        SELECT "studentProfileId"
        FROM "EnrollmentRequest"
        WHERE "studentGroupId" IS NOT NULL AND "status" = 'PENDING'::"EnrollmentStatus"
        GROUP BY "studentProfileId", "studentGroupId" HAVING COUNT(*) > 1
      ) sub`;
    violations.push({
      check: 'Duplicate PENDING EnrollmentRequest per (studentProfileId, studentGroupId)',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: dupPendingEnrollment.map(r => Number(r.studentprofileid)),
      repairStrategy:
        'Keep latest PENDING per (studentProfileId, studentGroupId); REJECT older duplicates.',
    });
  }

  const dupTeacherPaymentLesson = await prisma.$queryRaw<{ sessid: bigint | number; cnt: bigint }[]>`
    SELECT "lessonSessionId" AS sessid, COUNT(*) AS cnt
    FROM "TeacherPaymentLesson"
    GROUP BY "lessonSessionId"
    HAVING COUNT(*) > 1
    LIMIT 20`;
  if (dupTeacherPaymentLesson.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM (
        SELECT "lessonSessionId" FROM "TeacherPaymentLesson"
        GROUP BY "lessonSessionId" HAVING COUNT(*) > 1
      ) sub`;
    violations.push({
      check: 'Duplicate TeacherPaymentLesson.lessonSessionId',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: dupTeacherPaymentLesson.map(r => Number(r.sessid)),
      repairStrategy:
        'Delete duplicate TeacherPaymentLesson rows keeping the one with the correct paymentId.',
    });
  }

  // ─── 3. Cross-tenant inconsistencies ───────────────────────────────────────

  const ctAttendanceSession = await prisma.$queryRaw<RawIdRow[]>`
    SELECT a.id FROM "Attendance" a
    JOIN "LessonSession" ls ON ls.id = a."lessonSessionId"
    WHERE a."schoolId" != ls."schoolId" LIMIT 20`;
  if (ctAttendanceSession.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "Attendance" a
      JOIN "LessonSession" ls ON ls.id = a."lessonSessionId"
      WHERE a."schoolId" != ls."schoolId"`;
    violations.push({
      check: 'Attendance.schoolId != LessonSession.schoolId',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(ctAttendanceSession),
      repairStrategy:
        'UPDATE "Attendance" a SET "schoolId" = ls."schoolId" FROM "LessonSession" ls WHERE ls.id = a."lessonSessionId" AND a."schoolId" != ls."schoolId" — verify first.',
    });
  }

  const ctAttendanceUser = await prisma.$queryRaw<RawIdRow[]>`
    SELECT a.id FROM "Attendance" a
    JOIN "StudentProfile" sp ON sp.id = a."studentProfileId"
    JOIN "User" u ON u.id = sp."userId"
    WHERE u."schoolId" IS NOT NULL AND a."schoolId" != u."schoolId" LIMIT 20`;
  if (ctAttendanceUser.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "Attendance" a
      JOIN "StudentProfile" sp ON sp.id = a."studentProfileId"
      JOIN "User" u ON u.id = sp."userId"
      WHERE u."schoolId" IS NOT NULL AND a."schoolId" != u."schoolId"`;
    violations.push({
      check: 'Attendance.schoolId != StudentProfile.user.schoolId',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(ctAttendanceUser),
      repairStrategy:
        'Cross-tenant attendance records — manual review required before any correction.',
    });
  }

  const ctSessionStudent = await prisma.$queryRaw<RawIdRow[]>`
    SELECT ss.id FROM "SessionStudent" ss
    JOIN "LessonSession" ls ON ls.id = ss."lessonSessionId"
    WHERE ss."schoolId" != ls."schoolId" LIMIT 20`;
  if (ctSessionStudent.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "SessionStudent" ss
      JOIN "LessonSession" ls ON ls.id = ss."lessonSessionId"
      WHERE ss."schoolId" != ls."schoolId"`;
    violations.push({
      check: 'SessionStudent.schoolId != LessonSession.schoolId',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(ctSessionStudent),
      repairStrategy:
        'UPDATE "SessionStudent" SET "schoolId" = ls."schoolId" FROM "LessonSession" ls WHERE ... — verify first.',
    });
  }

  const ctSessionStudentUser = await prisma.$queryRaw<RawIdRow[]>`
    SELECT ss.id FROM "SessionStudent" ss
    JOIN "StudentProfile" sp ON sp.id = ss."studentProfileId"
    JOIN "User" u ON u.id = sp."userId"
    WHERE u."schoolId" IS NOT NULL AND ss."schoolId" != u."schoolId" LIMIT 20`;
  if (ctSessionStudentUser.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "SessionStudent" ss
      JOIN "StudentProfile" sp ON sp.id = ss."studentProfileId"
      JOIN "User" u ON u.id = sp."userId"
      WHERE u."schoolId" IS NOT NULL AND ss."schoolId" != u."schoolId"`;
    violations.push({
      check: 'SessionStudent.schoolId != StudentProfile.user.schoolId',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(ctSessionStudentUser),
      repairStrategy:
        'Cross-tenant session student records — manual review required.',
    });
  }

  const ctPayment = await prisma.$queryRaw<RawIdRow[]>`
    SELECT p.id FROM "Payment" p
    JOIN "StudentProfile" sp ON sp.id = p."studentProfileId"
    JOIN "User" u ON u.id = sp."userId"
    WHERE u."schoolId" IS NOT NULL AND p."schoolId" != u."schoolId" LIMIT 20`;
  if (ctPayment.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "Payment" p
      JOIN "StudentProfile" sp ON sp.id = p."studentProfileId"
      JOIN "User" u ON u.id = sp."userId"
      WHERE u."schoolId" IS NOT NULL AND p."schoolId" != u."schoolId"`;
    violations.push({
      check: 'Payment.schoolId != StudentProfile.user.schoolId',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(ctPayment),
      repairStrategy:
        'Financial records crossing school boundaries — do NOT auto-correct; manual review required.',
    });
  }

  const ctTeacherPayment = await prisma.$queryRaw<RawIdRow[]>`
    SELECT tp.id FROM "TeacherPayment" tp
    JOIN "StaffProfile" sp ON sp.id = tp."staffProfileId"
    JOIN "User" u ON u.id = sp."userId"
    WHERE u."schoolId" IS NOT NULL AND tp."schoolId" != u."schoolId" LIMIT 20`;
  if (ctTeacherPayment.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "TeacherPayment" tp
      JOIN "StaffProfile" sp ON sp.id = tp."staffProfileId"
      JOIN "User" u ON u.id = sp."userId"
      WHERE u."schoolId" IS NOT NULL AND tp."schoolId" != u."schoolId"`;
    violations.push({
      check: 'TeacherPayment.schoolId != StaffProfile.user.schoolId',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(ctTeacherPayment),
      repairStrategy:
        'Salary records crossing school boundaries — do NOT auto-correct; manual review required.',
    });
  }

  const ctCreditLog = await prisma.$queryRaw<RawIdRow[]>`
    SELECT lcl.id FROM "LessonCreditLog" lcl
    JOIN "StudentProfile" sp ON sp.id = lcl."studentProfileId"
    JOIN "User" u ON u.id = sp."userId"
    WHERE u."schoolId" IS NOT NULL AND lcl."schoolId" != u."schoolId" LIMIT 20`;
  if (ctCreditLog.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "LessonCreditLog" lcl
      JOIN "StudentProfile" sp ON sp.id = lcl."studentProfileId"
      JOIN "User" u ON u.id = sp."userId"
      WHERE u."schoolId" IS NOT NULL AND lcl."schoolId" != u."schoolId"`;
    violations.push({
      check: 'LessonCreditLog.schoolId != StudentProfile.user.schoolId',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(ctCreditLog),
      repairStrategy:
        'Credit ledger entries crossing school boundaries — do NOT auto-correct; manual review required.',
    });
  }

  // ─── 4. Orphan / broken references ─────────────────────────────────────────

  const orphanAttendanceSession = await prisma.$queryRaw<RawIdRow[]>`
    SELECT a.id FROM "Attendance" a
    LEFT JOIN "LessonSession" ls ON ls.id = a."lessonSessionId"
    WHERE ls.id IS NULL LIMIT 20`;
  if (orphanAttendanceSession.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "Attendance" a
      LEFT JOIN "LessonSession" ls ON ls.id = a."lessonSessionId"
      WHERE ls.id IS NULL`;
    violations.push({
      check: 'Attendance without LessonSession',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(orphanAttendanceSession),
      repairStrategy:
        'FK violation — should be impossible. Investigate data ingestion path; delete only after verifying truly orphaned.',
    });
  }

  const orphanAttendanceStudent = await prisma.$queryRaw<RawIdRow[]>`
    SELECT a.id FROM "Attendance" a
    LEFT JOIN "StudentProfile" sp ON sp.id = a."studentProfileId"
    WHERE sp.id IS NULL LIMIT 20`;
  if (orphanAttendanceStudent.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "Attendance" a
      LEFT JOIN "StudentProfile" sp ON sp.id = a."studentProfileId"
      WHERE sp.id IS NULL`;
    violations.push({
      check: 'Attendance without StudentProfile',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(orphanAttendanceStudent),
      repairStrategy:
        'FK violation — should be impossible. Investigate; do not auto-delete.',
    });
  }

  const orphanSS = await prisma.$queryRaw<RawIdRow[]>`
    SELECT ss.id FROM "SessionStudent" ss
    LEFT JOIN "LessonSession" ls ON ls.id = ss."lessonSessionId"
    WHERE ls.id IS NULL LIMIT 20`;
  if (orphanSS.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "SessionStudent" ss
      LEFT JOIN "LessonSession" ls ON ls.id = ss."lessonSessionId"
      WHERE ls.id IS NULL`;
    violations.push({
      check: 'SessionStudent without LessonSession',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(orphanSS),
      repairStrategy:
        'FK violation — should be impossible. Investigate; do not auto-delete.',
    });
  }

  const orphanCreditLog = await prisma.$queryRaw<RawIdRow[]>`
    SELECT lcl.id FROM "LessonCreditLog" lcl
    LEFT JOIN "StudentProfile" sp ON sp.id = lcl."studentProfileId"
    WHERE sp.id IS NULL LIMIT 20`;
  if (orphanCreditLog.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "LessonCreditLog" lcl
      LEFT JOIN "StudentProfile" sp ON sp.id = lcl."studentProfileId"
      WHERE sp.id IS NULL`;
    violations.push({
      check: 'LessonCreditLog without StudentProfile',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(orphanCreditLog),
      repairStrategy:
        'Financial ledger entries without student — manual review required before any action.',
    });
  }

  const orphanAllocPayment = await prisma.$queryRaw<RawIdRow[]>`
    SELECT pa.id FROM "PaymentAllocation" pa
    LEFT JOIN "Payment" p ON p.id = pa."paymentId"
    WHERE p.id IS NULL LIMIT 20`;
  if (orphanAllocPayment.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "PaymentAllocation" pa
      LEFT JOIN "Payment" p ON p.id = pa."paymentId"
      WHERE p.id IS NULL`;
    violations.push({
      check: 'PaymentAllocation without Payment',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(orphanAllocPayment),
      repairStrategy:
        'FK violation — allocation without parent payment. Manual review required.',
    });
  }

  const orphanAllocInvoice = await prisma.$queryRaw<RawIdRow[]>`
    SELECT pa.id FROM "PaymentAllocation" pa
    LEFT JOIN "Invoice" inv ON inv.id = pa."invoiceId"
    WHERE inv.id IS NULL LIMIT 20`;
  if (orphanAllocInvoice.length > 0) {
    const total = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count FROM "PaymentAllocation" pa
      LEFT JOIN "Invoice" inv ON inv.id = pa."invoiceId"
      WHERE inv.id IS NULL`;
    violations.push({
      check: 'PaymentAllocation without Invoice',
      severity: 'BLOCKER',
      count: toCount(total),
      sampleIds: toIds(orphanAllocInvoice),
      repairStrategy:
        'FK violation — allocation without parent invoice. Manual review required.',
    });
  }

  return violations;
}
