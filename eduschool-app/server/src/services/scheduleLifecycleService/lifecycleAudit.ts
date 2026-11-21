import { Role } from '@prisma/client';

import {
  LifecycleAuditPayload,
  LifecycleEventType,
} from '../scheduleLifecycleTypes';

/** Prisma include shape for status-change queries. Shared with schedule.ts route. */
export const SESSION_STATUS_CHANGE_INCLUDE = {
  teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
  lessonBlock: {
    include: {
      studentGroup: {
        include: { memberships: { where: { status: 'ACTIVE' as const }, select: { studentProfile: { include: { user: { select: { id: true } } } } } } },
      },
    },
  },
} as const;

// ─── Validation helpers ────────────────────────────────────────────────────────

/**
 * Builds the canonical audit payload written to ScheduleActionLog.before / .after.
 * In PR 2: used by changeSessionStatus.
 * In PR 3+: all lifecycle routes must call this instead of ad-hoc objects.
 */
export function buildLifecycleAuditPayload(params: {
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
}): LifecycleAuditPayload {
  return {
    ...params,
    timestamp: new Date(),
  };
}

// ─── Shared cancel-side-effect helper ────────────────────────────────────────
