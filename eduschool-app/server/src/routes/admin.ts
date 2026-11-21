import { Router } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { runChecks } from '../services/consistencyCheckService';
import { runFullReconciliation } from '../services/reconciliationService';
import { resolveViolationDetails, ViolationDetail, ViolationEntityKind } from '../services/violationDetailService';
import { createLogger } from '../lib/logger';

const router = Router();
const log = createLogger('admin');

// Maps each consistency-check's `check` string to the entity kind its `ids` reference,
// so Finance Control can show who/what/when instead of raw numeric ids. Checks not
// listed here degrade gracefully to the raw id list on the client.
const CHECK_KIND: Record<string, ViolationEntityKind> = {
  'Attendance on INVALIDATED session (ghost billing risk)': 'attendance',
  'TeacherPaymentLesson linked to CANCELLED/INVALIDATED session (phantom salary)': 'teacherPaymentLesson',
  'Duplicate TeacherPaymentLesson (double salary payment)': 'lessonSession',
  'creditDeducted=true without LessonCreditLog deduction (balance mismatch)': 'attendance',
  'LessonCreditLog deduction for CANCELLED session (invalid charge)': 'lessonCreditLog',
  'UPCOMING SessionStudent for WITHDRAWN student (ghost attendee)': 'sessionStudent',
  'LessonBlock with endDate < startDate (zombie block)': 'lessonBlock',
  'School with no active SchoolSchedulePolicy (policy gap)': 'school',
  'Active LessonSession with archived parent LessonBlock (zombie session)': 'lessonSession',
  'TeacherPayment lessonsCount ≠ TeacherPaymentLesson.count (denorm inconsistency)': 'teacherPayment',
  'Teacher double-booking: same teacher assigned to overlapping blocks simultaneously': 'lessonBlock',
  'Student double-booking: Grammar and Club of same group overlap in time/days': 'lessonBlock',
  'StudentProfile.credits ≠ sum(LessonCreditLog.amount) — balance diverged from ledger': 'studentProfile',
  'invoice.paidAmount ≠ SUM(confirmed allocations) — payment balance corrupted': 'invoice',
  'invoice net paid exceeds totalAmount — negative outstanding risk': 'invoice',
  'invoice status inconsistent with net-paid outstanding math': 'invoice',
};

// Maps reconciliationService's ReconciliationEntityType to the same entity kinds.
const RECON_KIND: Record<string, ViolationEntityKind> = {
  session: 'lessonSession',
  attendance: 'attendance',
  credit_log: 'lessonCreditLog',
  teacher_payment: 'teacherPaymentLesson',
  makeup: 'lessonSession',
};

async function detailsFor(kind: ViolationEntityKind | undefined, ids: number[], schoolId: number): Promise<ViolationDetail[]> {
  if (!kind) return [];
  try {
    return await resolveViolationDetails(kind, ids, schoolId, prisma);
  } catch (error) {
    log.error({ err: error, kind }, 'violation detail resolve failed');
    return [];
  }
}

/**
 * GET /api/v1/admin/consistency-check
 * Read-only data integrity audit for the caller's school.
 * OWNER-only.
 */
router.get(
  '/consistency-check',
  authenticate,
  requirePermission('users:manage'),
  async (req: AuthRequest, res) => {
    try {
      const schoolId = req.user!.schoolId;
      const violations = await runChecks(schoolId);
      const criticalCount = violations.filter(v => v.severity === 'CRITICAL').length;
      const warningCount  = violations.filter(v => v.severity === 'WARNING').length;
      log.info({ schoolId, criticalCount, warningCount }, 'consistency check completed');
      const enrichedViolations = await Promise.all(
        violations.map(async v => ({
          ...v,
          details: await detailsFor(CHECK_KIND[v.check], v.ids, schoolId),
        })),
      );
      res.json({
        success: true,
        data: {
          schoolId,
          checkedAt: new Date().toISOString(),
          totalViolations: violations.length,
          criticalCount,
          warningCount,
          violations: enrichedViolations,
        },
      });
    } catch (error) {
      log.error({ err: error }, 'consistency check failed');
      res.status(500).json({ success: false, error: 'Consistency check failed' });
    }
  },
);

// Security event action prefixes for the securityEvent filter
const SECURITY_ACTION_PREFIXES = [
  'SECURITY:SSRF_BLOCKED',
  'SECURITY:RATE_LIMIT_TRIGGERED',
  'SECURITY:LOGIN_FAILED',
  'SECURITY:TOKEN_REUSE_DETECTED',
  'SECURITY:CLEAR_ALL_DATA',
  'SECURITY:EXPORT',
  'SECURITY:PERMISSION_DENIED',
  'SECURITY:UPLOAD_REJECTED',
  'SECURITY:WEBHOOK_SECRET_ROTATED',
];

/**
 * GET /api/v1/admin/audit-log
 * Paginated read of ScheduleActionLog for the caller's school.
 * Query params: entityType, action, actorId, dateFrom, dateTo, securityOnly, page, limit (max 100).
 * OWNER-only.
 */
router.get(
  '/audit-log',
  authenticate,
  requirePermission('users:manage'),
  async (req: AuthRequest, res) => {
    try {
      const schoolId = req.user!.schoolId;

      const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
      const skip  = (page - 1) * limit;

      const { entityType, action, actorId, dateFrom, dateTo, securityOnly } = req.query as Record<string, string | undefined>;

      const where: Record<string, unknown> = { schoolId };
      if (entityType)  where.entityType = entityType;
      if (action)      where.action     = { contains: action, mode: 'insensitive' };
      if (actorId)     where.userId     = parseInt(actorId);
      if (securityOnly === 'true') {
        // Filter to all security-prefixed events
        where.entityType = 'security';
      }
      if (dateFrom || dateTo) {
        where.createdAt = {
          ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
          ...(dateTo   ? { lte: new Date(dateTo)   } : {}),
        };
      }

      const [total, entries] = await Promise.all([
        prisma.scheduleActionLog.count({ where }),
        prisma.scheduleActionLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id:         true,
            action:     true,
            entityType: true,
            sessionId:  true,
            blockId:    true,
            groupId:    true,
            before:     true,
            after:      true,
            reason:     true,
            ipAddress:  true,
            createdAt:  true,
            user: { select: { id: true, firstName: true, lastName: true, role: true } },
          },
        }),
      ]);

      log.info({ schoolId, total, page, limit, securityOnly: securityOnly === 'true' }, 'audit-log queried');

      res.json({
        success: true,
        data: entries.map(e => ({
          ...e,
          actor: e.user
            ? { id: e.user.id, name: `${e.user.firstName} ${e.user.lastName}`, role: e.user.role }
            : null,
          user: undefined,
        })),
        meta: { total, page, limit, pages: Math.ceil(total / limit) },
        filters: { securityEventTypes: SECURITY_ACTION_PREFIXES },
      });
    } catch (error) {
      log.error({ err: error }, 'audit-log query failed');
      res.status(500).json({ success: false, error: 'Audit log query failed' });
    }
  },
);

/**
 * GET /api/v1/admin/reconciliation
 * Lifecycle reconciliation report for the caller's school.
 *
 * Runs R1–R7 lifecycle integrity checks (RFC §10) and returns a structured report.
 * Read-only — no automatic repair.
 * OWNER-only (same permission as consistency-check).
 *
 * Response shape:
 *   { success: true, data: ReconciliationReport }
 *
 * ReconciliationReport:
 *   schoolId, checkedAt, summary, issues[], countsBySeverity, countsByType
 */
router.get(
  '/reconciliation',
  authenticate,
  requirePermission('users:manage'),
  async (req: AuthRequest, res) => {
    try {
      const schoolId = req.user!.schoolId;
      const report = await runFullReconciliation(schoolId);
      log.info(
        {
          schoolId,
          totalIssues: report.issues.length,
          criticalCount: report.countsBySeverity.CRITICAL,
          errorCount: report.countsBySeverity.ERROR,
          warningCount: report.countsBySeverity.WARNING,
        },
        'reconciliation report generated',
      );

      // Resolve details in batches per issueType (capped to the first 20 ids per type —
      // the client only ever displays 20), not per-issue, to avoid an N+1 query storm.
      const idsByIssueType = new Map<string, number[]>();
      for (const issue of report.issues) {
        const arr = idsByIssueType.get(issue.issueType) ?? [];
        if (arr.length < 20) arr.push(issue.entityId);
        idsByIssueType.set(issue.issueType, arr);
      }
      const detailMap = new Map<string, ViolationDetail>();
      await Promise.all(
        [...idsByIssueType.entries()].map(async ([issueType, ids]) => {
          const sample = report.issues.find(i => i.issueType === issueType);
          const kind = sample ? RECON_KIND[sample.entityType] : undefined;
          const details = await detailsFor(kind, ids, schoolId);
          for (const d of details) detailMap.set(`${issueType}:${d.id}`, d);
        }),
      );
      const enrichedIssues = report.issues.map(issue => ({
        ...issue,
        detail: detailMap.get(`${issue.issueType}:${issue.entityId}`),
      }));

      res.json({ success: true, data: { ...report, issues: enrichedIssues } });
    } catch (error) {
      log.error({ err: error }, 'reconciliation check failed');
      res.status(500).json({ success: false, error: 'Reconciliation check failed' });
    }
  },
);

export default router;
