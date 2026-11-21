/**
 * SCHEDULE LIFECYCLE — Type Definitions
 * PR 2: scheduleLifecycleService skeleton
 *
 * All domain types for the lifecycle orchestration layer.
 * This file has no project imports — pure TypeScript types only.
 *
 * See SCHEDULE_LIFECYCLE_RFC.md for the full domain model.
 */

import { Role, SessionStatus } from '@prisma/client';

// ─── Domain event types ───────────────────────────────────────────────────────

export type LifecycleEventType =
  | 'SESSION_CANCELLED'
  | 'SESSION_RESTORED'
  | 'SESSION_RESCHEDULED'
  | 'TEACHER_REPLACED'
  | 'MAKEUP_CREATED'
  | 'MAKEUP_COMPLETED'
  | 'ATTENDANCE_SUBMITTED'
  | 'SESSION_LOCKED'
  | 'SESSION_INVALIDATED'
  | 'SESSION_REOPENED'
  | 'FREEZE_APPLIED'
  | 'FREEZE_REVERSED';

// ─── Actor ────────────────────────────────────────────────────────────────────

export interface LifecycleActor {
  userId: number;
  role: Role;
  schoolId: number;
  requestId?: string;
  ipAddress?: string;
}

// ─── Side effects contract ────────────────────────────────────────────────────
//
// Each lifecycle event has a declared set of side effects.
// This contract drives the orchestrator in PR 3+.
// In PR 2: types only — side effects are still handled inline in routes.

export interface LifecycleSideEffects {
  /** Write ScheduleActionLog entry */
  audit: boolean;
  /** Send notification to student/parent users */
  notifyParents: boolean;
  /** Send notification to the (substitute) teacher */
  notifyTeacher: boolean;
  /** Emit socket event to school room */
  emitSocket: boolean;
  /** Invalidate Redis cache for this school */
  invalidateCache: boolean;
  /** Whether this event affects student credit balance */
  financialImpact: 'none' | 'credit' | 'debt' | 'reversal';
  /** Whether this event affects teacher salary calculation */
  salaryImpact: 'none' | 'payable' | 'correction';
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface LifecycleValidationResult {
  valid: boolean;
  reason?: string;
}

// ─── Audit payload ────────────────────────────────────────────────────────────
//
// Canonical shape written to ScheduleActionLog.before / .after.
// PR 3+: routes must produce this shape instead of ad-hoc objects.

export interface LifecycleAuditPayload {
  eventType: LifecycleEventType;
  actorId: number;
  actorRole: Role;
  schoolId: number;
  sessionId?: number;
  blockId?: number;
  oldState: Record<string, unknown>;
  newState: Record<string, unknown>;
  reason?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  timestamp: Date;
}

// ─── Side effects map ─────────────────────────────────────────────────────────
//
// Authoritative mapping: event → expected side effects.
// Used by unit tests to verify the contract and by PR 3+ orchestrator.

export const LIFECYCLE_SIDE_EFFECTS: Record<LifecycleEventType, LifecycleSideEffects> = {
  SESSION_CANCELLED: {
    audit: true,
    notifyParents: true,
    notifyTeacher: true,   // PR 5: teacher now notified (was false in PR 2 stub)
    emitSocket: true,
    invalidateCache: true,
    financialImpact: 'none',
    salaryImpact: 'none',
  },
  SESSION_RESTORED: {
    audit: true,
    notifyParents: false,
    notifyTeacher: false,
    emitSocket: true,
    invalidateCache: true,
    financialImpact: 'none',
    salaryImpact: 'none',
  },
  SESSION_RESCHEDULED: {
    audit: true,
    notifyParents: true,
    notifyTeacher: true,
    emitSocket: true,
    invalidateCache: true,
    financialImpact: 'none',
    salaryImpact: 'none',
  },
  TEACHER_REPLACED: {
    audit: true,
    notifyParents: false,
    notifyTeacher: true,
    emitSocket: true,
    invalidateCache: false,
    financialImpact: 'none',
    salaryImpact: 'correction',
  },
  MAKEUP_CREATED: {
    audit: true,
    notifyParents: true,
    notifyTeacher: false,
    emitSocket: true,
    invalidateCache: true,
    financialImpact: 'none',
    salaryImpact: 'none',
  },
  MAKEUP_COMPLETED: {
    audit: true,
    notifyParents: false,
    notifyTeacher: false,
    emitSocket: true,
    invalidateCache: true,
    financialImpact: 'credit',
    salaryImpact: 'payable',
  },
  ATTENDANCE_SUBMITTED: {
    audit: false,
    notifyParents: false,
    notifyTeacher: false,
    emitSocket: true,
    invalidateCache: false,
    financialImpact: 'credit',
    salaryImpact: 'payable',
  },
  SESSION_LOCKED: {
    audit: true,
    notifyParents: false,
    notifyTeacher: false,
    emitSocket: true,
    invalidateCache: false,
    financialImpact: 'none',
    salaryImpact: 'none',
  },
  SESSION_INVALIDATED: {
    audit: true,
    notifyParents: false,
    notifyTeacher: false,
    emitSocket: true,
    invalidateCache: true,
    financialImpact: 'none',
    salaryImpact: 'none',
  },
  SESSION_REOPENED: {
    audit: true,
    notifyParents: false,
    notifyTeacher: false,
    emitSocket: true,
    invalidateCache: true,
    financialImpact: 'none',
    salaryImpact: 'none',
  },
  FREEZE_APPLIED: {
    audit: true,
    notifyParents: true,
    notifyTeacher: false,
    emitSocket: false,
    invalidateCache: false,
    financialImpact: 'none',
    salaryImpact: 'none',
  },
  FREEZE_REVERSED: {
    audit: true,
    notifyParents: true,
    notifyTeacher: false,
    emitSocket: false,
    invalidateCache: false,
    financialImpact: 'none',
    salaryImpact: 'none',
  },
};

// ─── Status → event type mapping ─────────────────────────────────────────────

export function deriveEventType(
  fromStatus: SessionStatus,
  toStatus: SessionStatus,
): LifecycleEventType {
  switch (toStatus) {
    case 'CANCELLED':    return 'SESSION_CANCELLED';
    case 'LOCKED':       return 'SESSION_LOCKED';
    case 'INVALIDATED':  return 'SESSION_INVALIDATED';
    case 'UPCOMING':
      return fromStatus === 'INVALIDATED' ? 'SESSION_REOPENED' : 'SESSION_RESTORED';
    // IN_PROGRESS / COMPLETED don't have dedicated events yet (TODO PR 3)
    default:
      return 'SESSION_RESTORED';
  }
}

// ─── Events that REQUIRE a reason ────────────────────────────────────────────
//
// PR 3: Hard 400 enforcement. Reason must be present and ≥ 5 characters.
// changeSessionStatus() and high-level wrappers (replaceTeacher, invalidateSession)
// call requireLifecycleReason() and throw 400 if the check fails.

export const EVENTS_REQUIRING_REASON: ReadonlySet<LifecycleEventType> = new Set([
  // SESSION_CANCELLED: reason is now optional (kept but not enforced) per user request
  'SESSION_INVALIDATED',
  'TEACHER_REPLACED',
  'SESSION_RESCHEDULED',
  'MAKEUP_CREATED',
  'FREEZE_APPLIED',
  'FREEZE_REVERSED',
]);
