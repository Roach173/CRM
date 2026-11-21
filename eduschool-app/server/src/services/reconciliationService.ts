/**
 * RECONCILIATION SERVICE
 * PR 8: Lifecycle integrity checks for attendance, credits, salary, and makeup sessions.
 *
 * Design:
 *   - Every exported check function returns ReconciliationIssue[].
 *   - Issues are per-entity (one issue per violating record), not aggregated.
 *   - runFullReconciliation() runs all checks and returns a ReconciliationReport.
 *   - All checks are READ-ONLY. No automatic repair.
 *   - The N+1 in findAttendanceWithoutCreditLog is intentional — it mirrors
 *     consistencyCheckService.check4 and is acceptable for a diagnostic endpoint.
 *     At 50k-student scale, replace with a NOT EXISTS subquery in SQL migration.
 *
 * Severity guide:
 *   CRITICAL — financial or salary data is corrupted; requires immediate correction.
 *   ERROR    — lifecycle invariant violated; data is inconsistent but not yet financial.
 *   WARNING  — potential gap; might be intentional (e.g., attendanceSkipped policy).
 *   INFO     — informational; no action required.
 *
 * Invariants checked (from RFC §10):
 *   R1. COMPLETED/LOCKED session + enrolled students → attendance must exist        [WARNING]
 *   R2. CANCELLED/INVALIDATED session → no credit deduction                         [CRITICAL]
 *   R3. INVALIDATED session → no TeacherPaymentLesson                               [CRITICAL]
 *   R4. isMakeup=true → makeupForSessionId must be set                              [ERROR]
 *   R5. Multiple active makeups for same original session (duplicate links)          [ERROR]
 *   R6. TeacherPaymentLesson → session must not be CANCELLED/INVALIDATED            [CRITICAL]
 *   R7. Attendance.creditDeducted=true → LessonCreditLog entry must exist           [CRITICAL]
 *
 * See SCHEDULE_LIFECYCLE_RFC.md §10 for the canonical reconciliation requirements.
 */

import { PrismaClient } from '@prisma/client';
import prismaDefault from '../lib/prisma';
import { hasCorrectionForSession } from './salaryCorrectionService';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ReconciliationSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type ReconciliationEntityType =
  | 'session'
  | 'attendance'
  | 'credit_log'
  | 'teacher_payment'
  | 'makeup';

export interface ReconciliationIssue {
  /** Machine-readable identifier for the invariant that was violated */
  issueType: string;
  severity: ReconciliationSeverity;
  schoolId: number;
  entityType: ReconciliationEntityType;
  /** Primary key of the violating record */
  entityId: number;
  /** Human-readable explanation */
  description: string;
  detectedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface ReconciliationReport {
  schoolId: number;
  checkedAt: Date;
  summary: string;
  issues: ReconciliationIssue[];
  countsBySeverity: Record<ReconciliationSeverity, number>;
  countsByType: Record<string, number>;
}

type DbClient = PrismaClient;

// ─── R1: COMPLETED/LOCKED sessions with students but no attendance ─────────────

/**
 * Returns sessions that are COMPLETED or LOCKED, have enrolled students,
 * but have zero attendance records. These may indicate forgotten attendance
 * submission or an intentional no-show policy.
 *
 * Severity: WARNING — might be intentional; no financial impact yet.
 * Fix path: submit attendance retroactively or mark `attendanceSkipped` (future field).
 */
export async function findCompletedWithoutAttendance(
  schoolId: number,
  client: DbClient = prismaDefault as DbClient,
): Promise<ReconciliationIssue[]> {
  const sessions = await client.lessonSession.findMany({
    where: {
      schoolId,
      status: { in: ['COMPLETED', 'LOCKED'] },
      deletedAt: null,
      sessionStudents: { some: {} },
      attendances: { none: {} },
    },
    select: { id: true, date: true, status: true },
  });

  const now = new Date();
  return sessions.map(s => ({
    issueType: 'R1_COMPLETED_WITHOUT_ATTENDANCE',
    severity: 'WARNING' as ReconciliationSeverity,
    schoolId,
    entityType: 'session' as ReconciliationEntityType,
    entityId: s.id,
    description: `Session ${s.id} (status=${s.status}, date=${s.date.toISOString().slice(0, 10)}) has enrolled students but no attendance records`,
    detectedAt: now,
    metadata: { status: s.status, date: s.date },
  }));
}

// ─── R2: Cancelled/Invalidated sessions with credit deductions ─────────────────

/**
 * Returns LessonCreditLog entries with amount < 0 (deduction) linked to
 * a CANCELLED or INVALIDATED session. Credits should never be deducted
 * for sessions that did not take place.
 *
 * Severity: CRITICAL — financial integrity violation.
 * Fix path: reverse the deduction via SESSION_INVALIDATED correction flow.
 */
export async function findCancelledWithCreditDeduction(
  schoolId: number,
  client: DbClient = prismaDefault as DbClient,
): Promise<ReconciliationIssue[]> {
  const logs = await client.lessonCreditLog.findMany({
    where: {
      schoolId,
      amount: { lt: 0 },
      session: {
        status: { in: ['CANCELLED', 'INVALIDATED'] },
        deletedAt: null,
      },
    },
    select: {
      id: true,
      amount: true,
      sessionId: true,
      session: { select: { status: true, date: true } },
    },
  });

  const now = new Date();
  return logs.map(l => ({
    issueType: 'R2_CANCELLED_SESSION_CREDIT_DEDUCTION',
    severity: 'CRITICAL' as ReconciliationSeverity,
    schoolId,
    entityType: 'credit_log' as ReconciliationEntityType,
    entityId: l.id,
    description: `LessonCreditLog ${l.id} deducts ${l.amount} credits for session ${l.sessionId} which has status ${l.session?.status}`,
    detectedAt: now,
    metadata: {
      logId: l.id,
      sessionId: l.sessionId,
      sessionStatus: l.session?.status,
      amount: l.amount,
    },
  }));
}

// ─── R3: Invalidated sessions with salary records ──────────────────────────────

/**
 * Returns TeacherPaymentLesson entries linked to INVALIDATED sessions.
 * Salary must not be attributed to sessions marked as data-integrity errors.
 *
 * Severity:
 *   CRITICAL — no correction has been applied (PR 9 correction flow not used yet)
 *   WARNING  — a salary correction ManualLessonEntry exists for this session,
 *              indicating the owner acknowledged and compensated for the error.
 *              The TeacherPaymentLesson is preserved (financial history is immutable).
 *
 * Fix path (CRITICAL): run `POST /salary/corrections` with correctionType=INVALIDATED_SESSION.
 * Fix path (WARNING): already corrected — no action needed.
 */
export async function findInvalidatedWithTeacherPayment(
  schoolId: number,
  client: DbClient = prismaDefault as DbClient,
): Promise<ReconciliationIssue[]> {
  const links = await client.teacherPaymentLesson.findMany({
    where: {
      lessonSession: { schoolId, status: 'INVALIDATED', deletedAt: null },
    },
    select: {
      id: true,
      paymentId: true,
      lessonSessionId: true,
      payment: { select: { staffProfileId: true, period: true } },
    },
  });

  const now = new Date();
  const issues: ReconciliationIssue[] = [];

  for (const l of links) {
    const corrected = await hasCorrectionForSession(
      l.lessonSessionId,
      l.payment.staffProfileId,
      l.payment.period,
      client,
    );

    issues.push({
      issueType:   'R3_INVALIDATED_SESSION_TEACHER_PAYMENT',
      severity:    corrected ? 'WARNING' : 'CRITICAL' as ReconciliationSeverity,
      schoolId,
      entityType:  'teacher_payment' as ReconciliationEntityType,
      entityId:    l.id,
      description: corrected
        ? `TeacherPaymentLesson ${l.id} (paymentId=${l.paymentId}) links to INVALIDATED session ${l.lessonSessionId} — salary correction applied`
        : `TeacherPaymentLesson ${l.id} (paymentId=${l.paymentId}) links to INVALIDATED session ${l.lessonSessionId} — no correction found`,
      detectedAt:  now,
      metadata:    { paymentLessonId: l.id, paymentId: l.paymentId, sessionId: l.lessonSessionId, corrected },
    });
  }

  return issues;
}

// ─── R4: Makeup sessions without original link ─────────────────────────────────

/**
 * Returns makeup sessions (isMakeup=true) where makeupForSessionId is null.
 * Every makeup session must link to its cancelled original.
 *
 * Severity: ERROR — cannot trace the original cancelled session.
 * Fix path: manually set makeupForSessionId or mark as INVALIDATED.
 */
export async function findMakeupWithoutOriginal(
  schoolId: number,
  client: DbClient = prismaDefault as DbClient,
): Promise<ReconciliationIssue[]> {
  const sessions = await client.lessonSession.findMany({
    where: {
      schoolId,
      isMakeup: true,
      makeupForSessionId: null,
      deletedAt: null,
    },
    select: { id: true, date: true, status: true },
  });

  const now = new Date();
  return sessions.map(s => ({
    issueType: 'R4_MAKEUP_WITHOUT_ORIGINAL_LINK',
    severity: 'ERROR' as ReconciliationSeverity,
    schoolId,
    entityType: 'makeup' as ReconciliationEntityType,
    entityId: s.id,
    description: `Makeup session ${s.id} (status=${s.status}, date=${s.date.toISOString().slice(0, 10)}) has isMakeup=true but makeupForSessionId is null`,
    detectedAt: now,
    metadata: { status: s.status, date: s.date },
  }));
}

// ─── R5: Duplicate makeup links (multiple active makeups for same original) ────

/**
 * Returns pairs where more than one active (non-CANCELLED) makeup session
 * points to the same original cancelled session. Only one makeup per original
 * is allowed per RFC §5 MAKEUP_CREATED guard.
 *
 * Severity: ERROR — duplicate compensation for the same missed session.
 * Fix path: cancel the duplicate makeup session(s).
 */
export async function findDuplicateMakeupLinks(
  schoolId: number,
  client: DbClient = prismaDefault as DbClient,
): Promise<ReconciliationIssue[]> {
  // Group by makeupForSessionId, keep only groups with > 1 active makeup
  const grouped = await client.lessonSession.groupBy({
    by: ['makeupForSessionId'],
    where: {
      schoolId,
      isMakeup: true,
      makeupForSessionId: { not: null },
      status: { not: 'CANCELLED' },
      deletedAt: null,
    },
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  });

  if (grouped.length === 0) return [];

  // Fetch the actual makeup session IDs for each duplicated original
  const issues: ReconciliationIssue[] = [];
  const now = new Date();

  for (const g of grouped) {
    const makeups = await client.lessonSession.findMany({
      where: {
        schoolId,
        makeupForSessionId: g.makeupForSessionId,
        status: { not: 'CANCELLED' },
        deletedAt: null,
      },
      select: { id: true, date: true, status: true },
    });

    for (const m of makeups) {
      issues.push({
        issueType: 'R5_DUPLICATE_MAKEUP_LINK',
        severity: 'ERROR' as ReconciliationSeverity,
        schoolId,
        entityType: 'makeup' as ReconciliationEntityType,
        entityId: m.id,
        description: `Makeup session ${m.id} is one of ${makeups.length} active makeups for original session ${g.makeupForSessionId}`,
        detectedAt: now,
        metadata: {
          originalSessionId: g.makeupForSessionId,
          activeMakeupCount: makeups.length,
          makeupSessionIds: makeups.map(x => x.id),
        },
      });
    }
  }

  return issues;
}

// ─── R6: TeacherPaymentLesson for cancelled/invalidated sessions ───────────────

/**
 * Returns TeacherPaymentLesson records where the linked session is CANCELLED
 * or INVALIDATED. RFC §8.6 invariant 1: salary must not be attributed to
 * non-payable sessions.
 *
 * Severity:
 *   CANCELLED sessions: always CRITICAL (salary should never exist for cancelled sessions)
 *   INVALIDATED sessions:
 *     CRITICAL — no correction ManualLessonEntry exists
 *     WARNING  — a correction has been applied via POST /salary/corrections
 *
 * Fix path (CANCELLED CRITICAL): investigate and void via correction flow.
 * Fix path (INVALIDATED CRITICAL): POST /salary/corrections correctionType=INVALIDATED_SESSION.
 * Fix path (INVALIDATED WARNING): already corrected — no action needed.
 */
export async function findSalaryWithoutSession(
  schoolId: number,
  client: DbClient = prismaDefault as DbClient,
): Promise<ReconciliationIssue[]> {
  const links = await client.teacherPaymentLesson.findMany({
    where: {
      lessonSession: {
        schoolId,
        status: { in: ['CANCELLED', 'INVALIDATED'] },
        deletedAt: null,
      },
    },
    select: {
      id: true,
      paymentId: true,
      lessonSessionId: true,
      lessonSession: { select: { status: true } },
      payment: { select: { staffProfileId: true, period: true } },
    },
  });

  const now = new Date();
  const issues: ReconciliationIssue[] = [];

  for (const l of links) {
    const isCancelled = l.lessonSession?.status === 'CANCELLED';

    // CANCELLED sessions never have a valid correction scenario — always CRITICAL
    let severity: ReconciliationSeverity = 'CRITICAL';
    let corrected = false;

    if (!isCancelled) {
      // INVALIDATED: check if correction was applied
      corrected = await hasCorrectionForSession(
        l.lessonSessionId,
        l.payment.staffProfileId,
        l.payment.period,
        client,
      );
      if (corrected) severity = 'WARNING';
    }

    issues.push({
      issueType:   'R6_SALARY_ON_NON_PAYABLE_SESSION',
      severity,
      schoolId,
      entityType:  'teacher_payment' as ReconciliationEntityType,
      entityId:    l.id,
      description: corrected
        ? `TeacherPaymentLesson ${l.id} links to INVALIDATED session ${l.lessonSessionId} — salary correction applied`
        : `TeacherPaymentLesson ${l.id} (paymentId=${l.paymentId}) links to session ${l.lessonSessionId} with status ${l.lessonSession?.status}`,
      detectedAt:  now,
      metadata:    {
        paymentLessonId: l.id,
        paymentId:       l.paymentId,
        sessionId:       l.lessonSessionId,
        sessionStatus:   l.lessonSession?.status,
        corrected,
      },
    });
  }

  return issues;
}

// ─── R7: Attendance with creditDeducted=true but no credit log ─────────────────

/**
 * Returns Attendance records where creditDeducted=true but no matching
 * LessonCreditLog entry exists (by attendanceId FK). This breaks the
 * credit balance audit trail.
 *
 * Severity: CRITICAL — credit balance cannot be reconciled without the log.
 * Fix path: create a correction LessonCreditLog entry manually.
 *
 * NOTE: This uses an N+1 loop (same as consistencyCheckService.check4).
 * At 50k-student scale, replace with a NOT EXISTS subquery.
 */
export async function findAttendanceWithoutCreditLog(
  schoolId: number,
  client: DbClient = prismaDefault as DbClient,
): Promise<ReconciliationIssue[]> {
  const deducted = await client.attendance.findMany({
    where: { schoolId, creditDeducted: true },
    select: { id: true, lessonSessionId: true, studentProfileId: true },
  });

  if (deducted.length === 0) return [];

  const issues: ReconciliationIssue[] = [];
  const now = new Date();

  for (const att of deducted) {
    const log = await client.lessonCreditLog.findFirst({
      where: { attendanceId: att.id },
      select: { id: true },
    });
    if (!log) {
      issues.push({
        issueType: 'R7_ATTENDANCE_WITHOUT_CREDIT_LOG',
        severity: 'CRITICAL' as ReconciliationSeverity,
        schoolId,
        entityType: 'attendance' as ReconciliationEntityType,
        entityId: att.id,
        description: `Attendance ${att.id} has creditDeducted=true but no LessonCreditLog entry with attendanceId=${att.id} exists`,
        detectedAt: now,
        metadata: { attendanceId: att.id, sessionId: att.lessonSessionId, studentProfileId: att.studentProfileId },
      });
    }
  }

  return issues;
}

// ─── Full reconciliation run ──────────────────────────────────────────────────

/**
 * Runs all R1–R7 lifecycle reconciliation checks for the given school.
 * Returns a ReconciliationReport with all issues, counts by severity and type.
 *
 * All checks run in parallel. Any single check failure is caught and reported
 * as a CRITICAL issue so a partial failure does not suppress the rest.
 */
export async function runFullReconciliation(
  schoolId: number,
  client: DbClient = prismaDefault as DbClient,
): Promise<ReconciliationReport> {
  const checkedAt = new Date();

  // Run all checks; wrap each in try-catch so one failure doesn't abort the others
  const checkResults = await Promise.allSettled([
    findCompletedWithoutAttendance(schoolId, client),
    findCancelledWithCreditDeduction(schoolId, client),
    findInvalidatedWithTeacherPayment(schoolId, client),
    findMakeupWithoutOriginal(schoolId, client),
    findDuplicateMakeupLinks(schoolId, client),
    findSalaryWithoutSession(schoolId, client),
    findAttendanceWithoutCreditLog(schoolId, client),
  ]);

  const issues: ReconciliationIssue[] = [];

  for (const result of checkResults) {
    if (result.status === 'fulfilled') {
      issues.push(...result.value);
    } else {
      // A check itself failed — report it as a CRITICAL issue
      issues.push({
        issueType: 'CHECK_EXECUTION_ERROR',
        severity: 'CRITICAL',
        schoolId,
        entityType: 'session',
        entityId: 0,
        description: `Reconciliation check failed: ${result.reason?.message ?? String(result.reason)}`,
        detectedAt: checkedAt,
      });
    }
  }

  // Aggregate
  const countsBySeverity: Record<ReconciliationSeverity, number> = {
    INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0,
  };
  const countsByType: Record<string, number> = {};

  for (const issue of issues) {
    countsBySeverity[issue.severity] += 1;
    countsByType[issue.issueType] = (countsByType[issue.issueType] ?? 0) + 1;
  }

  const totalCritical = countsBySeverity.CRITICAL + countsBySeverity.ERROR;
  const summary = issues.length === 0
    ? 'All lifecycle invariants satisfied — no issues found'
    : `Found ${issues.length} issue(s): ${countsBySeverity.CRITICAL} CRITICAL, ${countsBySeverity.ERROR} ERROR, ${countsBySeverity.WARNING} WARNING`;

  return {
    schoolId,
    checkedAt,
    summary,
    issues,
    countsBySeverity,
    countsByType,
  };
}
