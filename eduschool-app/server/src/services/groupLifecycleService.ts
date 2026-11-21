import { GroupStatus, Prisma, PrismaClient, Role } from '@prisma/client';
import { canBlockTransition, BlockStatus } from '../lib/blockStateMachine';
import prisma from '../lib/prisma';
import { logScheduleAction } from '../lib/auditLog';
import { assertGroupAction } from '../lib/groupLifecyclePolicy';

type DbClient = PrismaClient | Prisma.TransactionClient;

type LifecycleAction =
  | 'GROUP_PAUSED'
  | 'GROUP_RESUMED'
  | 'GROUP_COMPLETED'
  | 'GROUP_COMPLETION_INVALIDATED_FUTURE_SESSIONS'
  | 'GROUP_ARCHIVED'
  | 'GROUP_RESTORED';

export const LEVEL_CHAPTER_HISTORY_ERROR =
  'Level/chapter cannot be changed after group history exists. Use promotion flow.';

export const GROUP_OPERATION_REQUIRES_ACTIVE_ERROR =
  'Group operation requires an active, non-archived group.';

export class GroupLifecycleError extends Error {
  statusCode: number;
  code: string;

  constructor(code: string, message: string, statusCode = 422) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface TransitionParams {
  groupId: number;
  schoolId: number;
  actorId: number;
  reason?: string;
  client?: DbClient;
}

interface CompleteGroupParams extends TransitionParams {
  effectiveDate?: Date;
  sourceBlockId?: number;
  role: Role;
}

async function withClient<T>(client: DbClient | undefined, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if (client) return fn(client as Prisma.TransactionClient);
  return prisma.$transaction(fn);
}

function assertStatus(current: GroupStatus, allowed: GroupStatus[], target: GroupStatus) {
  if (!allowed.includes(current)) {
    throw new GroupLifecycleError(
      'GROUP_TRANSITION_FORBIDDEN',
      `Cannot transition group from ${current} to ${target}`,
    );
  }
}

async function loadGroup(tx: Prisma.TransactionClient, groupId: number, schoolId: number, includeArchived = false) {
  const group = await tx.studentGroup.findFirst({
    where: {
      id: groupId,
      schoolId,
      ...(includeArchived ? {} : { deletedAt: null }),
    },
    select: { id: true, schoolId: true, status: true, deletedAt: true },
  });
  if (!group) {
    throw new GroupLifecycleError('GROUP_NOT_FOUND', 'Group not found', 404);
  }
  return group;
}

export async function groupHasLifecycleHistory(
  client: DbClient,
  groupId: number,
  schoolId: number,
): Promise<boolean> {
  const [
    blocks,
    sessions,
    attendances,
    creditLogs,
    salaryLessons,
    memberships,
    progressions,
  ] = await Promise.all([
    client.lessonBlock.count({ where: { studentGroupId: groupId, schoolId } }),
    client.lessonSession.count({ where: { schoolId, lessonBlock: { studentGroupId: groupId } } }),
    client.attendance.count({ where: { schoolId, lessonSession: { lessonBlock: { studentGroupId: groupId } } } }),
    client.lessonCreditLog.count({ where: { schoolId, session: { lessonBlock: { studentGroupId: groupId } } } }),
    client.teacherPaymentLesson.count({ where: { lessonSession: { schoolId, lessonBlock: { studentGroupId: groupId } } } }),
    client.groupMembership.count({ where: { studentGroupId: groupId, schoolId } }),
    client.groupProgression.count({
      where: {
        schoolId,
        OR: [{ fromGroupId: groupId }, { toGroupId: groupId }],
      },
    }),
  ]);

  return blocks + sessions + attendances + creditLogs + salaryLessons + memberships + progressions > 0;
}

export async function assertCanChangeLevelChapter(
  client: DbClient,
  group: { id: number; schoolId: number; status: GroupStatus; deletedAt: Date | null },
) {
  // Lifecycle policy check first (pure, fast)
  assertGroupAction(group, 'edit:level-chapter');

  if (await groupHasLifecycleHistory(client, group.id, group.schoolId)) {
    throw new GroupLifecycleError('GROUP_LEVEL_CHAPTER_LOCKED', LEVEL_CHAPTER_HISTORY_ERROR, 400);
  }
}

export async function assertGroupOperationallyActive(
  client: DbClient,
  groupId: number,
  schoolId: number,
) {
  const group = await client.studentGroup.findFirst({
    where: { id: groupId, schoolId },
    select: { id: true, status: true, deletedAt: true },
  });

  if (!group) {
    throw new GroupLifecycleError('GROUP_NOT_FOUND', 'Group not found', 404);
  }

  // Delegate to policy — covers PAUSED, COMPLETED, ARCHIVED
  assertGroupAction(group, 'add:students');

  return group;
}

async function audit(tx: Prisma.TransactionClient, params: {
  schoolId: number;
  actorId: number;
  groupId: number;
  action: LifecycleAction;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason?: string;
}) {
  await logScheduleAction({
    client: tx,
    schoolId: params.schoolId,
    userId: params.actorId,
    entityType: 'group',
    groupId: params.groupId,
    action: params.action,
    before: params.before,
    after: params.after,
    reason: params.reason,
  });
}

async function transitionStatus(params: TransitionParams & {
  to: GroupStatus;
  allowedFrom: GroupStatus[];
  action: LifecycleAction;
}) {
  return withClient(params.client, async tx => {
    const group = await loadGroup(tx, params.groupId, params.schoolId);
    const before = { groupId: group.id, status: group.status, deletedAt: group.deletedAt?.toISOString() ?? null };

    if (group.status !== params.to) {
      assertStatus(group.status, params.allowedFrom, params.to);
      await tx.studentGroup.update({
        where: { id: group.id },
        data: { status: params.to },
      });
    }

    const after = { groupId: group.id, status: params.to, deletedAt: group.deletedAt?.toISOString() ?? null };
    await audit(tx, {
      schoolId: params.schoolId,
      actorId: params.actorId,
      groupId: group.id,
      action: params.action,
      before,
      after,
      reason: params.reason,
    });

    return { ...group, status: params.to };
  });
}

export const GroupLifecycleService = {
  pauseGroup(params: TransitionParams) {
    return transitionStatus({
      ...params,
      to: 'PAUSED',
      allowedFrom: ['ACTIVE'],
      action: 'GROUP_PAUSED',
    });
  },

  resumeGroup(params: TransitionParams) {
    return transitionStatus({
      ...params,
      to: 'ACTIVE',
      allowedFrom: ['PAUSED'],
      action: 'GROUP_RESUMED',
    });
  },

  completeGroup(params: CompleteGroupParams) {
    return withClient(params.client, async tx => {
      const group = await loadGroup(tx, params.groupId, params.schoolId);
      const before = { groupId: group.id, status: group.status, deletedAt: group.deletedAt?.toISOString() ?? null };

      if (group.status !== 'COMPLETED') {
        assertStatus(group.status, ['ACTIVE'], 'COMPLETED');
      }

      // Default to UTC-midnight of "now", not the raw timestamp: LessonSession.date is
      // always stored at T12:00:00Z for its calendar day, so a raw `new Date()` default
      // landed before or after that noon mark depending on what time of day someone
      // clicked "complete" — today's own session silently escaped invalidation whenever
      // this ran after 12:00 UTC. Midnight is always earlier than noon, so this makes
      // today's session reliably in-scope regardless of time of day (matches the explicit
      // `T00:00:00.000Z` normalization already used by POST /blocks/:id/complete-group).
      const effectiveDate = params.effectiveDate ?? (() => {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      })();
      const blocks = await tx.lessonBlock.findMany({
        where: { studentGroupId: group.id, schoolId: params.schoolId, deletedAt: null },
        select: { id: true, status: true },
      });
      const blockIds = blocks.map(block => block.id);

      for (const block of blocks) {
        const transition = canBlockTransition(block.status as BlockStatus, 'COMPLETED', params.role);
        if (!transition.allowed) {
          throw new GroupLifecycleError('BLOCK_TRANSITION_FORBIDDEN', transition.reason!, 422);
        }
      }

      let invalidatedSessions = 0;
      let protectedFutureSessions = 0;
      if (blockIds.length > 0) {
        protectedFutureSessions = await tx.lessonSession.count({
          where: {
            lessonBlockId: { in: blockIds },
            date: { gte: effectiveDate },
            status: { in: ['UPCOMING', 'IN_PROGRESS'] },
            deletedAt: null,
            OR: [
              { attendances: { some: {} } },
              { creditLogs: { some: {} } },
              { teacherPaymentLesson: { isNot: null } },
            ],
          },
        });

        const invalidated = await tx.lessonSession.updateMany({
          where: {
            lessonBlockId: { in: blockIds },
            date: { gte: effectiveDate },
            status: { in: ['UPCOMING', 'IN_PROGRESS'] },
            deletedAt: null,
            attendances: { none: {} },
            creditLogs: { none: {} },
            teacherPaymentLesson: { is: null },
          },
          data: { status: 'INVALIDATED', version: { increment: 1 } },
        });
        invalidatedSessions = invalidated.count;

        await tx.lessonBlock.updateMany({
          where: { id: { in: blockIds } },
          data: { endDate: effectiveDate, status: 'COMPLETED' },
        });
      }

      if (group.status !== 'COMPLETED') {
        await tx.studentGroup.update({
          where: { id: group.id },
          data: { status: 'COMPLETED' },
        });
      }

      // Close active memberships so a completed group stops feeding the student's live
      // schedule/roster queries (GroupMembership.status is their sole enrollment source
      // of truth — see groupPromotionService.ts). Previously only archiveGroup() did this,
      // leaving a window where a COMPLETED-but-not-yet-archived group's blocks kept
      // showing up alongside whatever group the student was promoted into.
      const closedMemberships = await tx.groupMembership.updateMany({
        where: { studentGroupId: group.id, schoolId: params.schoolId, status: 'ACTIVE' },
        data: { status: 'WITHDRAWN', leftAt: effectiveDate, leftReason: 'GROUP_COMPLETED' },
      });

      const after = {
        groupId: group.id,
        status: 'COMPLETED',
        deletedAt: group.deletedAt?.toISOString() ?? null,
        closedMemberships: closedMemberships.count,
      };
      await audit(tx, {
        schoolId: params.schoolId,
        actorId: params.actorId,
        groupId: group.id,
        action: 'GROUP_COMPLETED',
        before,
        after,
        reason: params.reason,
      });

      if (blockIds.length > 0) {
        await audit(tx, {
          schoolId: params.schoolId,
          actorId: params.actorId,
          groupId: group.id,
          action: 'GROUP_COMPLETION_INVALIDATED_FUTURE_SESSIONS',
          before: { sessionStatuses: ['UPCOMING', 'IN_PROGRESS'], blockStatus: 'UPCOMING' },
          after: {
            sessionStatus: 'INVALIDATED',
            blockStatus: 'COMPLETED',
            invalidatedSessions,
            protectedFutureSessions,
            blockIds,
            fromDate: effectiveDate.toISOString().slice(0, 10),
          },
          reason: 'GROUP_COMPLETED',
        });
      }

      return {
        ...group,
        status: 'COMPLETED' as const,
        completedBlocks: blockIds.length,
        invalidatedSessions,
        protectedFutureSessions,
        sourceBlockId: params.sourceBlockId,
      };
    });
  },

  archiveGroup(params: TransitionParams) {
    return withClient(params.client, async tx => {
      const group = await loadGroup(tx, params.groupId, params.schoolId);
      if (group.status !== 'COMPLETED') {
        throw new GroupLifecycleError(
          'GROUP_ARCHIVE_REQUIRES_COMPLETED',
          'Only completed groups can be archived.',
        );
      }
      const before = {
        groupId: group.id,
        status: group.status,
        deletedAt: group.deletedAt?.toISOString() ?? null,
      };

      const archivedAt = group.deletedAt ?? new Date();
      let closedMemberships = 0;
      if (!group.deletedAt) {
        await tx.studentGroup.update({
          where: { id: group.id },
          data: { deletedAt: archivedAt },
        });

        // Close active memberships so they never point to a soft-deleted group.
        // Invariant: status=ACTIVE ⇒ studentGroup.deletedAt IS NULL.
        // No roster reconciliation needed: archive requires COMPLETED, and
        // completeGroup() already invalidated future sessions (no UPCOMING left).
        const closed = await tx.groupMembership.updateMany({
          where: { studentGroupId: group.id, schoolId: params.schoolId, status: 'ACTIVE' },
          data: { status: 'WITHDRAWN', leftAt: archivedAt, leftReason: 'GROUP_ARCHIVED' },
        });
        closedMemberships = closed.count;
      }

      const after = {
        groupId: group.id,
        status: group.status,
        deletedAt: archivedAt.toISOString(),
        closedMemberships,
      };
      await audit(tx, {
        schoolId: params.schoolId,
        actorId: params.actorId,
        groupId: group.id,
        action: 'GROUP_ARCHIVED',
        before,
        after,
        reason: params.reason,
      });

      return { ...group, deletedAt: archivedAt };
    });
  },

  restoreGroup(params: TransitionParams) {
    return withClient(params.client, async tx => {
      const group = await loadGroup(tx, params.groupId, params.schoolId, true);
      if (!group.deletedAt) {
        throw new GroupLifecycleError('GROUP_NOT_ARCHIVED', 'Group is not archived');
      }

      const before = {
        groupId: group.id,
        status: group.status,
        deletedAt: group.deletedAt.toISOString(),
      };

      await tx.studentGroup.update({
        where: { id: group.id },
        data: { deletedAt: null },
      });

      const after = { groupId: group.id, status: group.status, deletedAt: null };
      await audit(tx, {
        schoolId: params.schoolId,
        actorId: params.actorId,
        groupId: group.id,
        action: 'GROUP_RESTORED',
        before,
        after,
        reason: params.reason,
      });

      return { ...group, deletedAt: null };
    });
  },
};
