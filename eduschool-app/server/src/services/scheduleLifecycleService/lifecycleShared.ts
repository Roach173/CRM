import { PrismaClient, SessionStatus } from '@prisma/client';

import { emitToSchool } from '../../lib/socket';
import { createLogger } from '../../lib/logger';

export const log = createLogger('lifecycle');

export function emitScheduleSessionChanged(
  schoolId: number,
  payload: { sessionId: number; lessonBlockId?: number | null; date?: Date | string | null; action: string; status?: string },
) {
  emitToSchool(schoolId, 'schedule:session-changed', payload);
}

/**
 * Maps a studentGroup's active GroupMembership rows to notifiable User ids.
 * Single source of truth for this shape across the lifecycle service — every
 * caller must query `studentGroup: { include: { memberships: { where: { status: 'ACTIVE' }, ... } } }`
 * (see SESSION_STATUS_CHANGE_INCLUDE in lifecycleAudit.ts) and pass the result here,
 * never the legacy StudentGroup.students relation (dead on write, always empty).
 */
export function studentUserIdsFromMemberships(
  studentGroup: { memberships?: Array<{ studentProfile: { user: { id: number } } }> } | null | undefined,
): number[] {
  return (studentGroup?.memberships ?? [])
    .map(m => m.studentProfile.user.id)
    .filter((id): id is number => typeof id === 'number');
}

// ─── Internal types ────────────────────────────────────────────────────────────

export type DbClient =
  | PrismaClient
  | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/** Minimal session shape needed for changeSessionStatus validation + side effects. */
export interface SessionForStatusChange {
  id: number;
  status: SessionStatus;
  schoolId: number;
  lessonBlockId: number;
  version: number;
  date: Date;
  lessonBlock: {
    level: string;
    studentGroup: {
      status: string;
      deletedAt: Date | null;
      memberships: Array<{ studentProfile: { user: { id: number } } }>;
    } | null;
  };
}

/**
 * Cancels all ACTIVE LESSON_SKIP freezes tied to `sessionId`, then clears
 * StudentProfile.isFrozen for affected students if no active freezes remain.
 * Must be called inside an existing transaction — `txClient` must be the tx client.
 */
export async function cancelLessonSkipFreezesForSession(
  txClient: DbClient,
  sessionId: number,
): Promise<void> {
  const affectedFreezeRows = await (txClient as PrismaClient).studentFreeze.findMany({
    where: { lessonSessionId: sessionId, type: 'LESSON_SKIP', status: 'ACTIVE' },
    select: { studentProfileId: true },
  });
  if (affectedFreezeRows.length === 0) return;

  await (txClient as PrismaClient).studentFreeze.updateMany({
    where: { lessonSessionId: sessionId, type: 'LESSON_SKIP', status: 'ACTIVE' },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  const affectedProfileIds = [...new Set(affectedFreezeRows.map(r => r.studentProfileId))];
  for (const profileId of affectedProfileIds) {
    const remaining = await (txClient as PrismaClient).studentFreeze.count({
      where: { studentProfileId: profileId, status: 'ACTIVE' },
    });
    if (remaining === 0) {
      await (txClient as PrismaClient).studentProfile.update({
        where: { id: profileId },
        data:  { isFrozen: false, frozenAt: null },
      });
    }
  }
}
