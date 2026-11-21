/**
 * GROUP LIFECYCLE POLICY
 *
 * Single source of truth for which operations are permitted on a StudentGroup
 * given its current lifecycle state. All backend routes and services MUST
 * consult this module instead of maintaining their own inline checks.
 *
 * Status model:
 *   ACTIVE    — normal operational group; all mutations allowed
 *   PAUSED    — temporarily halted; schedule/student/session mutations blocked
 *   COMPLETED — historical; only safe metadata (name) allowed
 *   ARCHIVED  — soft-deleted (deletedAt != null); fully read-only
 *
 * Usage:
 *   const result = canPerformGroupAction(group, 'add:students');
 *   if (!result.allowed) throw new GroupLifecycleError(result.code, result.message, 422);
 *
 *   — or use the throwing helper —
 *   assertGroupAction(group, 'add:students'); // throws GroupLifecycleError if denied
 */

import { GroupStatus } from '@prisma/client';
import { GroupLifecycleError } from '../services/groupLifecycleService';

// ─── Action catalogue ─────────────────────────────────────────────────────────

/**
 * Every mutation that can be performed on a StudentGroup or its child
 * entities (blocks, sessions, memberships).
 *
 * 'edit:metadata'      — name only for COMPLETED/PAUSED; also name for ACTIVE
 * 'edit:maxStudents'   — maxStudents field — ACTIVE only (COMPLETED: explicitly blocked)
 * 'edit:level-chapter' — level or chapter — ACTIVE + no history (checked separately)
 * 'edit:schedule'      — create/edit LessonBlock
 * 'add:students'       — add members to group
 * 'remove:students'    — remove members from group
 * 'submit:attendance'  — mark attendance on a session
 * 'create:makeup'      — create makeup session for a cancelled session
 * 'change:teacher'     — replace teacher on a session
 * 'reschedule'         — change time/room of a session
 * 'lifecycle:pause'    — ACTIVE → PAUSED
 * 'lifecycle:resume'   — PAUSED → ACTIVE
 * 'lifecycle:complete' — ACTIVE → COMPLETED
 * 'lifecycle:archive'  — COMPLETED → ARCHIVED
 * 'lifecycle:restore'  — ARCHIVED → COMPLETED
 * 'promote'            — start a new group at the next level
 */
export type GroupAction =
  | 'edit:metadata'
  | 'edit:maxStudents'
  | 'edit:level-chapter'
  | 'edit:schedule'
  | 'add:students'
  | 'remove:students'
  | 'submit:attendance'
  | 'create:makeup'
  | 'change:teacher'
  | 'reschedule'
  | 'lifecycle:pause'
  | 'lifecycle:resume'
  | 'lifecycle:complete'
  | 'lifecycle:archive'
  | 'lifecycle:restore'
  | 'promote';

export interface GroupShape {
  status: GroupStatus;
  deletedAt: Date | null;
}

export interface PolicyResult {
  allowed: boolean;
  /** Machine-readable error code, populated when allowed=false */
  code: string;
  /** Human-readable message, populated when allowed=false */
  message: string;
}

// ─── Derived lifecycle state ──────────────────────────────────────────────────

/** Returns true when group has been soft-deleted (archived). */
export function isGroupArchived(group: GroupShape): boolean {
  return group.deletedAt !== null;
}

/** Returns true when group is operationally active (not paused, completed, or archived). */
export function isGroupOperationallyActive(group: GroupShape): boolean {
  return !isGroupArchived(group) && group.status === 'ACTIVE';
}

// ─── Policy matrix ────────────────────────────────────────────────────────────

const ALLOWED: PolicyResult = { allowed: true, code: '', message: '' };

function denied(code: string, message: string): PolicyResult {
  return { allowed: false, code, message };
}

const ARCHIVED_DENY   = denied('GROUP_ARCHIVED',   'Group is archived and read-only.');
const PAUSED_DENY     = denied('GROUP_PAUSED',      'Group is paused. Resume it before performing this action.');
const COMPLETED_DENY  = denied('GROUP_COMPLETED',   'Group is completed. Use promotion for further changes.');
const NOT_ACTIVE_DENY = denied('GROUP_NOT_ACTIVE',  'This action requires an active group.');

/**
 * Pure function — no DB calls. Returns whether the action is allowed for the
 * group's current lifecycle state.
 *
 * NOTE: 'edit:level-chapter' requires an additional async history check;
 * this function only checks lifecycle status. Callers must also call
 * assertCanChangeLevelChapter() from groupLifecycleService for that action.
 */
export function canPerformGroupAction(
  group: GroupShape,
  action: GroupAction,
): PolicyResult {
  const archived   = isGroupArchived(group);
  const { status } = group;

  // ARCHIVED: fully read-only. Nothing is allowed.
  if (archived) {
    if (action === 'lifecycle:restore') return ALLOWED;
    return ARCHIVED_DENY;
  }

  switch (action) {
    // ── Safe metadata: name only (comment/color not yet in schema) ────────────
    // Allowed for ACTIVE, PAUSED, and COMPLETED.
    // PAUSED blocks schedule/student/session mutations but safe metadata (name) is OK.
    case 'edit:metadata':
      if (status === 'ACTIVE' || status === 'PAUSED' || status === 'COMPLETED') return ALLOWED;
      return NOT_ACTIVE_DENY;

    // ── maxStudents: structural — ACTIVE only ─────────────────────────────────
    case 'edit:maxStudents':
      if (status === 'ACTIVE') return ALLOWED;
      if (status === 'PAUSED') return PAUSED_DENY;
      return COMPLETED_DENY;

    // ── level/chapter: ACTIVE only (+ history check is caller's responsibility) ─
    case 'edit:level-chapter':
      if (status === 'ACTIVE') return ALLOWED;
      if (status === 'PAUSED') return PAUSED_DENY;
      return COMPLETED_DENY;

    // ── Schedule mutations ────────────────────────────────────────────────────
    case 'edit:schedule':
      if (status === 'ACTIVE') return ALLOWED;
      if (status === 'PAUSED') return PAUSED_DENY;
      return COMPLETED_DENY;

    // ── Membership mutations ──────────────────────────────────────────────────
    case 'add:students':
    case 'remove:students':
      if (status === 'ACTIVE') return ALLOWED;
      if (status === 'PAUSED') return PAUSED_DENY;
      return COMPLETED_DENY;

    // ── Session mutations ─────────────────────────────────────────────────────
    case 'submit:attendance':
    case 'create:makeup':
    case 'change:teacher':
    case 'reschedule':
      if (status === 'ACTIVE') return ALLOWED;
      if (status === 'PAUSED') return PAUSED_DENY;
      return COMPLETED_DENY;

    // ── Lifecycle transitions ─────────────────────────────────────────────────
    case 'lifecycle:pause':
      if (status === 'ACTIVE') return ALLOWED;
      return denied('GROUP_TRANSITION_FORBIDDEN', `Cannot pause a group with status ${status}.`);

    case 'lifecycle:resume':
      if (status === 'PAUSED') return ALLOWED;
      return denied('GROUP_TRANSITION_FORBIDDEN', `Cannot resume a group with status ${status}.`);

    case 'lifecycle:complete':
      if (status === 'ACTIVE') return ALLOWED;
      return denied('GROUP_TRANSITION_FORBIDDEN', `Cannot complete a group with status ${status}.`);

    case 'lifecycle:archive':
      if (status === 'COMPLETED') return ALLOWED;
      return denied('GROUP_ARCHIVE_REQUIRES_COMPLETED', 'Only completed groups can be archived.');

    case 'lifecycle:restore':
      // For non-archived groups restore makes no sense
      return denied('GROUP_NOT_ARCHIVED', 'Group is not archived.');

    // ── Academic promotion ────────────────────────────────────────────────────
    case 'promote':
      if (status === 'ACTIVE') return ALLOWED;
      if (status === 'PAUSED') return PAUSED_DENY;
      return COMPLETED_DENY;

    default: {
      const _exhaustive: never = action;
      return denied('UNKNOWN_ACTION', `Unknown group action: ${_exhaustive}`);
    }
  }
}

// ─── Throwing assertion ───────────────────────────────────────────────────────

/**
 * Asserts that the action is permitted for the group's lifecycle state.
 * Throws GroupLifecycleError with the appropriate HTTP status code if denied.
 *
 * HTTP status mapping:
 *   - ARCHIVED (read-only): 422
 *   - PAUSED (operational hold): 422
 *   - COMPLETED (historical): 422
 *   - Transition forbidden: 422
 */
export function assertGroupAction(
  group: GroupShape,
  action: GroupAction,
): void {
  const result = canPerformGroupAction(group, action);
  if (!result.allowed) {
    throw new GroupLifecycleError(result.code, result.message, 422);
  }
}
