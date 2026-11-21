import { PrismaClient, SessionStatus, Role } from '@prisma/client';

import prismaDefault from '../../lib/prisma';
import { canTransition } from '../../lib/sessionStateMachine';
import {
  LifecycleEventType,
  LifecycleValidationResult,
  EVENTS_REQUIRING_REASON,
  LIFECYCLE_SIDE_EFFECTS,
} from '../scheduleLifecycleTypes';
import { DbClient } from './lifecycleShared';

/**
 * Verifies that a session belongs to the given school.
 * Throws SESSION_NOT_FOUND (404) if absent or cross-tenant.
 */
export async function assertSessionBelongsToSchool(
  sessionId: number,
  schoolId: number,
  client: DbClient = prismaDefault,
): Promise<{ id: number; status: SessionStatus; schoolId: number }> {
  const session = await (client as PrismaClient).lessonSession.findFirst({
    where: { id: sessionId, schoolId, deletedAt: null },
    select: { id: true, status: true, schoolId: true },
  });
  if (!session) {
    throw Object.assign(new Error('SESSION_NOT_FOUND'), { httpStatus: 404 });
  }
  return session;
}

/**
 * Asserts that the state-machine allows the given transition for the actor's role.
 * Returns a LifecycleValidationResult (does NOT throw — callers decide error handling).
 */
export function assertLifecycleTransitionAllowed(
  fromStatus: SessionStatus,
  eventType: LifecycleEventType,
  actorRole: Role,
): LifecycleValidationResult {
  const sideEffects = LIFECYCLE_SIDE_EFFECTS[eventType];
  // Map event → target status; only status-changing events need the state machine check.
  const toStatus = eventTypeToTargetStatus(eventType, fromStatus);
  if (!toStatus) return { valid: true };

  const result = canTransition(fromStatus, toStatus, actorRole);
  return { valid: result.allowed, reason: result.reason };
}

/**
 * Checks whether the given event requires a reason, and if so, whether it meets
 * the minimum length requirement (≥ 5 characters).
 *
 * PR 3: EVENTS_REQUIRING_REASON is populated. This is now a hard check called
 * inside changeSessionStatus() and at the top of replaceTeacher()/invalidateSession().
 */
export function requireLifecycleReason(
  eventType: LifecycleEventType,
  reason?: string,
): LifecycleValidationResult {
  if (!EVENTS_REQUIRING_REASON.has(eventType)) return { valid: true };
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length >= 5) return { valid: true };
  return {
    valid: false,
    reason: `Event ${eventType} requires a reason of at least 5 characters`,
  };
}

/**
 * Checks whether the session can be edited given the incoming event type.
 * Uses the existing isEditable() logic from sessionStateMachine.
 *
 * NOTE: wired into teacher replacement (teacherReplacement.ts). Still NOT called by
 * PATCH /session/:id/details (scheduleSessions.routes.ts) — that route checks `version`
 * but not `status`, so it can still mutate a non-editable session. Remaining gap to close.
 */
export function assertSessionEditable(
  sessionStatus: SessionStatus,
  eventType: LifecycleEventType,
): LifecycleValidationResult {
  // Events that explicitly require an editable session
  const EDITABLE_REQUIRED: LifecycleEventType[] = [
    'TEACHER_REPLACED',
    'SESSION_RESCHEDULED',
  ];
  if (!EDITABLE_REQUIRED.includes(eventType)) return { valid: true };

  // Allow-list: only UPCOMING and IN_PROGRESS are editable.
  // COMPLETED is intentionally excluded — once a session is done, teacher salary is tied to it.
  const editable = sessionStatus === 'UPCOMING' || sessionStatus === 'IN_PROGRESS';
  if (!editable) {
    return {
      valid: false,
      reason: `Cannot apply ${eventType} to a session in status ${sessionStatus}`,
    };
  }
  return { valid: true };
}

// ─── Salary safety guard ──────────────────────────────────────────────────────

/**
 * Throws 409 SALARY_LOCKED_SESSION if a TeacherPaymentLesson already exists
 * for the given session. Called before salary-sensitive mutations.
 *
 * Affected event types: TEACHER_REPLACED, SESSION_RESCHEDULED, SESSION_INVALIDATED.
 * Correction flow (reverting salary attribution) is TODO PR 6+.
 */
export async function assertNoSalaryLockedSessionMutation(
  sessionId: number,
  eventType: LifecycleEventType,
  client: DbClient,
): Promise<void> {
  const SALARY_SENSITIVE: LifecycleEventType[] = [
    'TEACHER_REPLACED',
    'SESSION_RESCHEDULED',
    'SESSION_INVALIDATED',
  ];
  if (!SALARY_SENSITIVE.includes(eventType)) return;

  const link = await (client as PrismaClient).teacherPaymentLesson.findFirst({
    where: { lessonSessionId: sessionId },
    select: { paymentId: true },
  });

  if (link) {
    throw Object.assign(
      new Error('SALARY_LOCKED_SESSION'),
      {
        httpStatus: 409,
        details: {
          message: `Cannot apply ${eventType}: salary payment already recorded for this session. Use a correction flow. TODO PR 6.`,
          paymentId: link.paymentId,
        },
      },
    );
  }
}

// ─── Cancel credit guard ──────────────────────────────────────────────────────

/**
 * Throws 409 SESSION_HAS_DEDUCTED_CREDITS if the session already has any
 * Attendance record with creditDeducted=true. Only runs when targetStatus
 * is CANCELLED; no-op for all other transitions.
 *
 * Design: BLOCK, not auto-refund. The correct path is to issue a credit
 * correction first, then cancel. See ADR-026.
 */
export async function assertNoCreditDeductedAttendance(
  sessionId: number,
  targetStatus: SessionStatus,
  client: DbClient,
): Promise<void> {
  if (targetStatus !== 'CANCELLED') return;

  const deducted = await (client as PrismaClient).attendance.findFirst({
    where: { lessonSessionId: sessionId, creditDeducted: true },
    select: { id: true },
  });

  if (deducted) {
    throw Object.assign(
      new Error('SESSION_HAS_DEDUCTED_CREDITS'),
      {
        httpStatus: 409,
        details: {
          lifecycleError: true,
          message: 'Cannot cancel: session has attendance with deducted credits. Use a correction flow.',
        },
      },
    );
  }
}

// ─── Audit payload builder ─────────────────────────────────────────────────────

// ─── Internal helpers ──────────────────────────────────────────────────────────

/** Maps a LifecycleEventType to its target SessionStatus, if applicable. */
function eventTypeToTargetStatus(
  eventType: LifecycleEventType,
  fromStatus: SessionStatus,
): SessionStatus | null {
  switch (eventType) {
    case 'SESSION_CANCELLED':   return 'CANCELLED';
    case 'SESSION_LOCKED':      return 'LOCKED';
    case 'SESSION_INVALIDATED': return 'INVALIDATED';
    case 'SESSION_RESTORED':    return 'UPCOMING';
    case 'SESSION_REOPENED':    return 'UPCOMING';
    default:                    return null;
  }
}
