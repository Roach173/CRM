/**
 * SCHEDULE LIFECYCLE SERVICE — facade
 *
 * scheduleLifecycleService.ts grew into a 2265-line file covering guards,
 * audit payload building, and every session lifecycle transition. Split into
 * one module per responsibility under this directory; this file re-exports
 * the same public surface so existing imports of
 * '../services/scheduleLifecycleService' keep working unchanged.
 *
 * See SCHEDULE_LIFECYCLE_RFC.md §11 for the original implementation strategy.
 */

export {
  assertSessionBelongsToSchool,
  assertLifecycleTransitionAllowed,
  requireLifecycleReason,
  assertSessionEditable,
  assertNoSalaryLockedSessionMutation,
  assertNoCreditDeductedAttendance,
} from './lifecycleGuards';

export {
  SESSION_STATUS_CHANGE_INCLUDE,
  buildLifecycleAuditPayload,
} from './lifecycleAudit';

export {
  changeSessionStatus,
  cancelSession,
  restoreSession,
  invalidateSession,
} from './sessionStatusLifecycle';

export { rescheduleSession } from './sessionReschedule';
export { replaceTeacher } from './teacherReplacement';
export { createMakeupSession } from './makeupSession';
export { moveSession } from './sessionMove';
export { applyFreeze, reverseFreeze } from './freezeLifecycle';
