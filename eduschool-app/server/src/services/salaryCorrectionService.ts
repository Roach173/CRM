/**
 * SALARY CORRECTION SERVICE
 * PR 9: Controlled correction flow for salary records.
 *
 * Context:
 *   PR 5 introduced assertNoSalaryLockedSessionMutation() which blocks lifecycle
 *   mutations (TEACHER_REPLACED, SESSION_RESCHEDULED, SESSION_INVALIDATED) when a
 *   TeacherPaymentLesson already exists for the session. This is the correct safety
 *   guard. PR 9 adds the controlled correction flow that an OWNER or SUPERADMIN
 *   can use when an error is discovered after salary has been paid.
 *
 * Design constraints:
 *   - No DB migrations. Uses existing ManualLessonEntry and SalaryAdjustment models.
 *   - TeacherPaymentLesson records are NEVER deleted by this service.
 *     Financial history is immutable. Corrections are additive.
 *   - Corrections use ManualLessonEntry (ADD/REMOVE) with machine-parseable labels
 *     so that reconciliation can detect whether a correction has been applied.
 *   - Label format: 'SALARY_CORRECTION:session:{sessionId}:{suffix}'
 *   - All write operations must be idempotency-guarded at the route level.
 *   - All corrections produce an audit log entry via logScheduleAction().
 *
 * Correction scenarios:
 *   A. Wrong teacher (TEACHER_REPLACEMENT):
 *      - ManualLessonEntry REMOVE for old teacher (session was attributed to them)
 *      - ManualLessonEntry ADD for new teacher (session should count for them)
 *
 *   B. Invalidated session (INVALIDATED_SESSION):
 *      - ManualLessonEntry REMOVE for the teacher (session should not count)
 *      - TeacherPaymentLesson is preserved (financial history is immutable)
 *
 * Permissions:
 *   - OWNER or SUPERADMIN only (salary:pay scope at route level)
 *   - ADMIN explicitly blocked
 *   - reason ≥ 5 characters is required
 *
 * See SCHEDULE_LIFECYCLE_RFC.md §PR 9 for full design rationale.
 */

import { PrismaClient, Role, ManualEntryType } from '@prisma/client';
import prismaDefault from '../lib/prisma';
import { logScheduleAction } from '../lib/auditLog';
import { assertStaffBelongsToSchool } from '../lib/tenant';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Machine-parseable prefix used in ManualLessonEntry.label for corrections. */
export const CORRECTION_LABEL_PREFIX = 'SALARY_CORRECTION:session:';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type CorrectionType = 'TEACHER_REPLACEMENT' | 'INVALIDATED_SESSION';

export interface CorrectionActor {
  userId: number;
  role: Role;
  schoolId: number;
}

export interface CorrectionEntry {
  id: number;
  staffProfileId: number;
  type: ManualEntryType;
  label: string;
  count: number;
}

export interface CorrectionResult {
  correctionType: CorrectionType;
  sessionId: number;
  period: string;
  entries: CorrectionEntry[];
}

type DbClient = PrismaClient;

// ─── Label helpers ────────────────────────────────────────────────────────────

function correctionLabel(sessionId: number, suffix: string): string {
  return `${CORRECTION_LABEL_PREFIX}${sessionId}:${suffix}`;
}

/**
 * Returns true if the given ManualLessonEntry label is a correction entry
 * for the specified session. Used by reconciliationService to detect corrections.
 */
export function isCorrectionLabelForSession(label: string, sessionId: number): boolean {
  return label.startsWith(`${CORRECTION_LABEL_PREFIX}${sessionId}:`);
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Guards the correction flow: only OWNER or SUPERADMIN may apply corrections,
 * and a reason of at least 5 characters is required.
 *
 * Throws 403 if role is insufficient, 400 if reason is missing/too short.
 */
export function validateCorrectionAllowed(actor: CorrectionActor, reason?: string): void {
  if (actor.role !== 'OWNER' && actor.role !== 'SUPERADMIN') {
    throw Object.assign(
      new Error('CORRECTION_FORBIDDEN'),
      { httpStatus: 403, details: { message: 'Salary corrections require OWNER or SUPERADMIN role' } },
    );
  }
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length < 5) {
    throw Object.assign(
      new Error('CORRECTION_REASON_REQUIRED'),
      { httpStatus: 400, details: { message: 'A reason of at least 5 characters is required for salary corrections' } },
    );
  }
}

// ─── Scenario A: Wrong teacher correction ─────────────────────────────────────

/**
 * Corrects a salary attribution where a session was paid to the wrong teacher.
 *
 * Creates:
 *   - ManualLessonEntry REMOVE for oldStaffProfileId (reduce their lesson count)
 *   - ManualLessonEntry ADD for newStaffProfileId (increase their lesson count)
 *
 * Does NOT modify TeacherPayment or TeacherPaymentLesson — financial history is immutable.
 * The salary calculation for the period will automatically use the ManualLessonEntry delta.
 *
 * Requires OWNER or SUPERADMIN. Reason ≥ 5 chars.
 */
export async function createTeacherCorrection(params: {
  sessionId: number;
  schoolId: number;
  actor: CorrectionActor;
  oldStaffProfileId: number;
  newStaffProfileId: number;
  period: string;
  reason: string;
  client?: DbClient;
  idempotencyKey?: string;
}): Promise<CorrectionResult> {
  const client = (params.client ?? prismaDefault) as DbClient;

  validateCorrectionAllowed(params.actor, params.reason);

  // Tenant guards — both teachers must belong to the same school
  await assertStaffBelongsToSchool(params.oldStaffProfileId, params.schoolId, client);
  await assertStaffBelongsToSchool(params.newStaffProfileId, params.schoolId, client);

  // Atomic: both ManualLessonEntry records created together or neither
  const [removeEntry, addEntry] = await client.$transaction(async (tx) => {
    const db = tx as unknown as DbClient;

    const removed = await db.manualLessonEntry.create({
      data: {
        schoolId:       params.schoolId,
        staffProfileId: params.oldStaffProfileId,
        month:          params.period,
        type:           ManualEntryType.REMOVE,
        label:          correctionLabel(params.sessionId, `removed`),
        count:          1,
        createdById:    params.actor.userId,
        idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:remove` : null,
      },
    });

    const added = await db.manualLessonEntry.create({
      data: {
        schoolId:       params.schoolId,
        staffProfileId: params.newStaffProfileId,
        month:          params.period,
        type:           ManualEntryType.ADD,
        label:          correctionLabel(params.sessionId, `added`),
        count:          1,
        createdById:    params.actor.userId,
        idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:add` : null,
      },
    });

    return [removed, added] as const;
  });

  // Audit — best-effort (failure must not rollback correction), but awaited so there
  // is no in-flight DB write after this function returns. Prevents cleanDb() deadlocks.
  try {
    await logScheduleAction({
      client,
      schoolId:  params.schoolId,
      userId:    params.actor.userId,
      action:    'SALARY_CORRECTION_TEACHER_REPLACEMENT',
      entityType: 'session',
      sessionId: params.sessionId,
      before:    { oldStaffProfileId: params.oldStaffProfileId, period: params.period },
      after:     {
        newStaffProfileId: params.newStaffProfileId,
        period:    params.period,
        removeEntryId: removeEntry.id,
        addEntryId:    addEntry.id,
      },
      reason: params.reason,
    });
  } catch { /* best-effort */ }

  return {
    correctionType: 'TEACHER_REPLACEMENT',
    sessionId:      params.sessionId,
    period:         params.period,
    entries: [
      { id: removeEntry.id, staffProfileId: removeEntry.staffProfileId, type: removeEntry.type, label: removeEntry.label, count: removeEntry.count },
      { id: addEntry.id,    staffProfileId: addEntry.staffProfileId,    type: addEntry.type,    label: addEntry.label,    count: addEntry.count    },
    ],
  };
}

// ─── Scenario B: Invalidated session salary reversal ─────────────────────────

/**
 * Reverses the salary attribution for an INVALIDATED session that was already paid.
 *
 * Creates a ManualLessonEntry REMOVE for the teacher who received the payment,
 * reducing their effective lesson count for the period. The salary recalculation
 * will pick this up automatically.
 *
 * Does NOT delete the TeacherPaymentLesson — financial history is immutable.
 * The paid amount remains in TeacherPayment.amount; this correction only adjusts
 * the ongoing lesson count for accurate reporting.
 *
 * Only INVALIDATED sessions can be corrected this way — CANCELLED sessions
 * should not have salary records at all (see reconciliation R6).
 *
 * Requires OWNER or SUPERADMIN. Reason ≥ 5 chars.
 */
export async function reverseTeacherPaymentLesson(params: {
  paymentLessonId: number;
  schoolId: number;
  actor: CorrectionActor;
  reason: string;
  client?: DbClient;
  idempotencyKey?: string;
}): Promise<CorrectionResult> {
  const client = (params.client ?? prismaDefault) as DbClient;

  validateCorrectionAllowed(params.actor, params.reason);

  // Load the TeacherPaymentLesson with all context needed for the correction
  const paymentLesson = await client.teacherPaymentLesson.findFirst({
    where: { id: params.paymentLessonId },
    include: {
      payment:      { select: { staffProfileId: true, period: true, schoolId: true } },
      lessonSession: { select: { id: true, schoolId: true, status: true } },
    },
  });

  if (!paymentLesson) {
    throw Object.assign(new Error('PAYMENT_LESSON_NOT_FOUND'), { httpStatus: 404 });
  }

  // Tenant guard — both payment and session must belong to the actor's school
  if (
    paymentLesson.payment.schoolId   !== params.schoolId ||
    paymentLesson.lessonSession.schoolId !== params.schoolId
  ) {
    throw Object.assign(new Error('PAYMENT_LESSON_NOT_FOUND'), { httpStatus: 404 });
  }

  // Only INVALIDATED sessions qualify for this correction scenario
  if (paymentLesson.lessonSession.status !== 'INVALIDATED') {
    throw Object.assign(
      new Error('CORRECTION_REQUIRES_INVALIDATED_SESSION'),
      {
        httpStatus: 409,
        details: {
          message: `Cannot reverse salary for session in status ${paymentLesson.lessonSession.status}. Only INVALIDATED sessions qualify.`,
          currentStatus: paymentLesson.lessonSession.status,
        },
      },
    );
  }

  const sessionId     = paymentLesson.lessonSession.id;
  const staffProfileId = paymentLesson.payment.staffProfileId;
  const period        = paymentLesson.payment.period;

  // Create REMOVE entry — does NOT delete TeacherPaymentLesson
  const removeEntry = await client.manualLessonEntry.create({
    data: {
      schoolId:       params.schoolId,
      staffProfileId,
      month:          period,
      type:           ManualEntryType.REMOVE,
      label:          correctionLabel(sessionId, `invalidated`),
      count:          1,
      createdById:    params.actor.userId,
      idempotencyKey: params.idempotencyKey ?? null,
    },
  });

  // Audit — best-effort (failure must not rollback correction), but awaited so there
  // is no in-flight DB write after this function returns. Prevents cleanDb() deadlocks.
  try {
    await logScheduleAction({
      client,
      schoolId:  params.schoolId,
      userId:    params.actor.userId,
      action:    'SALARY_CORRECTION_INVALIDATED_SESSION',
      entityType: 'session',
      sessionId,
      before: {
        paymentLessonId: params.paymentLessonId,
        staffProfileId,
        period,
        sessionStatus:   paymentLesson.lessonSession.status,
      },
      after: {
        manualEntryId: removeEntry.id,
      },
      reason: params.reason,
    });
  } catch { /* best-effort */ }

  return {
    correctionType: 'INVALIDATED_SESSION',
    sessionId,
    period,
    entries: [{
      id:             removeEntry.id,
      staffProfileId: removeEntry.staffProfileId,
      type:           removeEntry.type,
      label:          removeEntry.label,
      count:          removeEntry.count,
    }],
  };
}

// ─── Thin wrapper: createManualSalaryAdjustment ───────────────────────────────

/**
 * Creates a SalaryAdjustment (FINE | ADVANCE | BONUS) with role validation.
 * Thin wrapper around prisma.salaryAdjustment.create with OWNER/SUPERADMIN guard.
 */
export async function createManualSalaryAdjustment(params: {
  staffProfileId: number;
  schoolId: number;
  type: 'FINE' | 'ADVANCE' | 'BONUS';
  amount: number;
  month: string;
  reason: string;
  actor: CorrectionActor;
  client?: DbClient;
}) {
  const client = (params.client ?? prismaDefault) as DbClient;

  validateCorrectionAllowed(params.actor, params.reason);
  await assertStaffBelongsToSchool(params.staffProfileId, params.schoolId, client);

  return client.salaryAdjustment.create({
    data: {
      schoolId:       params.schoolId,
      staffProfileId: params.staffProfileId,
      type:           params.type as any,
      amount:         params.amount,
      reason:         params.reason.trim(),
      month:          params.month,
      createdById:    params.actor.userId,
    },
  });
}

// ─── Audit payload builder ────────────────────────────────────────────────────

/**
 * Builds a structured audit payload for correction log entries.
 * Callers can include this in logScheduleAction().after.
 */
export function buildCorrectionAuditPayload(params: {
  correctionType: CorrectionType;
  actor: CorrectionActor;
  sessionId: number;
  reason: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    event:          `SALARY_CORRECTION:${params.correctionType}`,
    actorId:        params.actor.userId,
    actorRole:      params.actor.role,
    schoolId:       params.actor.schoolId,
    sessionId:      params.sessionId,
    reason:         params.reason,
    timestamp:      new Date().toISOString(),
    ...(params.metadata ?? {}),
  };
}

// ─── Reconciliation helper (exported for reconciliationService.ts) ─────────────

/**
 * Returns true if a correction ManualLessonEntry exists for the given session
 * in the given staff member's period. Used by reconciliationService to downgrade
 * CRITICAL R3/R6 issues to WARNING when a correction has been applied.
 */
export async function hasCorrectionForSession(
  sessionId: number,
  staffProfileId: number,
  period: string,
  client: DbClient,
): Promise<boolean> {
  const entry = await client.manualLessonEntry.findFirst({
    where: {
      staffProfileId,
      month: period,
      type:  ManualEntryType.REMOVE,
      label: { startsWith: `${CORRECTION_LABEL_PREFIX}${sessionId}:` },
    },
    select: { id: true },
  });
  return entry !== null;
}
