/**
 * SESSION PROJECTION SERVICE
 * PR 7: Parent/student visibility projection layer.
 *
 * Transforms internal LessonSession lifecycle states into a safe, parent-facing DTO.
 * All functions are pure (no DB I/O) — they accept pre-fetched session data and return
 * a projection. Routes must supply the correct session shape.
 *
 * Visibility rules (RFC §9):
 *   UPCOMING        → visible, label "Upcoming"
 *   IN_PROGRESS     → visible, label "In progress"
 *   COMPLETED       → visible, label "Completed"
 *   LOCKED          → visible, label "Completed"  (lock is an internal accounting state)
 *   CANCELLED       → visible, label "Cancelled"
 *   INVALIDATED     → NOT visible (data integrity state, never shown to students/parents)
 *
 * Makeup sessions add the sessionType: 'MAKEUP' distinction and a portalLabel of
 * "Makeup class" when upcoming. The originalSessionId links back to the cancelled session.
 *
 * Teacher substitution: if isManualTeacher=true, isSubstitute=true is reported and
 * the effectiveTeacher resolves the substitute's name. When no substitute, the block's
 * primary teacher is used.
 *
 * See SCHEDULE_LIFECYCLE_RFC.md §9 for the canonical visibility rules.
 */

import { SessionStatus } from '@prisma/client';

// ─── Input: minimal session shape required for projection ─────────────────────

export interface RawSessionForProjection {
  id: number;
  status: SessionStatus;
  date: Date;
  startTimeSnap: string | null;
  endTimeSnap: string | null;
  isMakeup: boolean;
  makeupForSessionId: number | null;
  /** Substitute teacher's StaffProfile.id (set only when teacher was replaced) */
  teacherId: number | null;
  /** Original block teacher's StaffProfile.id at time of session generation */
  teacherIdSnap: number | null;
  /** True when teacherId was set by explicit teacher replacement */
  isManualTeacher: boolean;
  /** Resolved substitute teacher (via teacherId relation) */
  teacher: { user: { firstName: string; lastName: string } } | null;
  lessonBlock: {
    type: string;
    studentGroup: { level: string } | null;
    cabinet: { name: string } | null;
    /** Block's primary teacher (resolved via lessonBlock.teacherId relation) */
    teacher: { user: { firstName: string; lastName: string } } | null;
  } | null;
}

// ─── Output: parent/student-safe projection ────────────────────────────────────

export type SessionType = 'REGULAR' | 'MAKEUP';

export interface ParentSessionProjection {
  sessionId: number;
  /** Raw DB status — may differ from portalLabel (e.g., LOCKED is shown as Completed) */
  status: SessionStatus;
  /** False only for INVALIDATED sessions — route must filter these out */
  isVisible: boolean;
  sessionType: SessionType;
  /** Human-readable title: block type + group name */
  title: string;
  /** Parent-facing status label — LOCKED shown as "Completed", INVALIDATED hidden */
  portalLabel: string;
  date: Date;
  startTime: string | null;
  endTime: string | null;
  isCancelled: boolean;
  isMakeup: boolean;
  /** Non-null for makeup sessions — links to the original cancelled session */
  originalSessionId: number | null;
  /** Resolved teacher name (substitute if isSubstitute, otherwise block teacher) */
  effectiveTeacher: { firstName: string; lastName: string } | null;
  /** True when a substitute teacher was explicitly assigned via teacher replacement */
  isSubstitute: boolean;
  /** Human-readable reason shown to parent, or null */
  parentVisibleReason: string | null;
}

// ─── Visibility rule ──────────────────────────────────────────────────────────

/**
 * INVALIDATED is an internal data-integrity state and must NEVER be shown to
 * students or parents. All other statuses are parent-visible.
 */
export function isVisibleToParent(status: SessionStatus): boolean {
  return status !== 'INVALIDATED';
}

// ─── Portal label ─────────────────────────────────────────────────────────────

function computePortalLabel(status: SessionStatus, isMakeup: boolean): string {
  switch (status) {
    case 'UPCOMING':    return isMakeup ? 'Makeup class' : 'Upcoming';
    case 'IN_PROGRESS': return 'In progress';
    case 'COMPLETED':   return 'Completed';
    case 'LOCKED':      return 'Completed';   // lock is internal; parent sees "Completed"
    case 'CANCELLED':   return 'Cancelled';
    case 'INVALIDATED': return 'Hidden';       // defensive — callers must filter before projecting
    default:            return 'Upcoming';
  }
}

// ─── Effective teacher resolution ─────────────────────────────────────────────

function resolveEffectiveTeacher(session: RawSessionForProjection): {
  teacher: { firstName: string; lastName: string } | null;
  isSubstitute: boolean;
} {
  // Substitute teacher was explicitly assigned via replaceTeacher()
  if (session.isManualTeacher && session.teacher) {
    return { teacher: session.teacher.user, isSubstitute: true };
  }
  // No substitute — use block's primary teacher
  const blockTeacher = session.lessonBlock?.teacher?.user ?? null;
  return { teacher: blockTeacher, isSubstitute: false };
}

// ─── Title builder ────────────────────────────────────────────────────────────

function computeTitle(session: RawSessionForProjection): string {
  const type      = session.lessonBlock?.type ?? '';
  const groupName = session.lessonBlock?.studentGroup?.level ?? '';
  const parts     = [type, groupName].filter(Boolean);
  return parts.join(' · ') || 'Lesson';
}

// ─── Cancellation reason ──────────────────────────────────────────────────────

function computeParentVisibleReason(session: RawSessionForProjection): string | null {
  if (session.status === 'CANCELLED') return 'Class cancelled by school';
  return null;
}

// ─── Core projection ──────────────────────────────────────────────────────────

/**
 * Projects a single session into the parent-safe representation.
 * Callers should check `isVisible` before including in a response.
 * `projectSessionsForParent()` handles the filter automatically.
 */
export function projectSessionForParent(
  session: RawSessionForProjection,
): ParentSessionProjection {
  const { teacher: effectiveTeacher, isSubstitute } = resolveEffectiveTeacher(session);

  return {
    sessionId:          session.id,
    status:             session.status,
    isVisible:          isVisibleToParent(session.status),
    sessionType:        session.isMakeup ? 'MAKEUP' : 'REGULAR',
    title:              computeTitle(session),
    portalLabel:        computePortalLabel(session.status, session.isMakeup),
    date:               session.date,
    startTime:          session.startTimeSnap,
    endTime:            session.endTimeSnap,
    isCancelled:        session.status === 'CANCELLED',
    isMakeup:           session.isMakeup,
    originalSessionId:  session.makeupForSessionId,
    effectiveTeacher,
    isSubstitute,
    parentVisibleReason: computeParentVisibleReason(session),
  };
}

/**
 * Projects a list of sessions, filtering out INVALIDATED ones automatically.
 * Use this in route handlers to replace raw session arrays.
 */
export function projectSessionsForParent(
  sessions: RawSessionForProjection[],
): ParentSessionProjection[] {
  return sessions
    .map(projectSessionForParent)
    .filter(p => p.isVisible);
}
