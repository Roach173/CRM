import { Prisma, PrismaClient, Role, SessionStatus } from '@prisma/client';
import { canBlockTransition, BlockStatus } from '../lib/blockStateMachine';
import prisma from '../lib/prisma';

const ACTIVE_FUTURE_SESSION_STATUSES: SessionStatus[] = ['UPCOMING', 'IN_PROGRESS'];
const HISTORICAL_SESSION_STATUSES: SessionStatus[] = ['COMPLETED', 'CANCELLED', 'LOCKED'];

type ArchiveClient = PrismaClient;
type ArchiveTx = Prisma.TransactionClient;

export interface LessonBlockArchiveResult {
  blockId: number;
  archivedAt: Date;
  alreadyArchived: boolean;
  invalidatedFutureSessions: number;
  counts: {
    sessions: number;
    historicalSessions: number;
    attendances: number;
    creditLogs: number;
    teacherPaymentLinks: number;
    enrollments: number;
    sessionStudents: number;
  };
}

/**
 * Transaction-scoped archive step: validation + DB writes + audit log only.
 * No cache invalidation, no socket emit — callers do that once, after their
 * outer transaction commits. Lets multiple blocks (e.g. a Grammar/Club pair)
 * be archived atomically in one caller-owned transaction.
 */
export async function archiveLessonBlockInTx(
  tx: ArchiveTx,
  params: {
    blockId: number;
    schoolId: number;
    actorId?: number;
    role: Role;
    reason?: string;
    now?: Date;
  },
): Promise<LessonBlockArchiveResult> {
  const archivedAt = params.now ?? new Date();
  const block = await tx.lessonBlock.findFirst({
    where: { id: params.blockId, schoolId: params.schoolId },
    select: { id: true, schoolId: true, startDate: true, endDate: true, deletedAt: true, status: true },
  });
  if (!block) {
    throw Object.assign(new Error('BLOCK_NOT_FOUND'), { httpStatus: 404 });
  }

  const sessions = await tx.lessonSession.findMany({
    where: { lessonBlockId: block.id },
    select: { id: true, status: true },
  });
  const sessionIds = sessions.map(s => s.id);

  const [
    attendances,
    creditLogs,
    teacherPaymentLinks,
    enrollments,
    sessionStudents,
  ] = await Promise.all([
    sessionIds.length > 0
      ? tx.attendance.count({ where: { lessonSessionId: { in: sessionIds } } })
      : Promise.resolve(0),
    sessionIds.length > 0
      ? tx.lessonCreditLog.count({ where: { sessionId: { in: sessionIds } } })
      : Promise.resolve(0),
    sessionIds.length > 0
      ? tx.teacherPaymentLesson.count({ where: { lessonSessionId: { in: sessionIds } } })
      : Promise.resolve(0),
    tx.enrollmentRequest.count({ where: { lessonBlockId: block.id } }),
    sessionIds.length > 0
      ? tx.sessionStudent.count({ where: { lessonSessionId: { in: sessionIds } } })
      : Promise.resolve(0),
  ]);

  const counts = {
    sessions: sessions.length,
    historicalSessions: sessions.filter(s => HISTORICAL_SESSION_STATUSES.includes(s.status)).length,
    attendances,
    creditLogs,
    teacherPaymentLinks,
    enrollments,
    sessionStudents,
  };

  if (!block.deletedAt) {
    const transition = canBlockTransition(block.status as BlockStatus, 'CANCELLED', params.role);
    if (!transition.allowed) {
      throw Object.assign(new Error(transition.reason!), { httpStatus: 422 });
    }
  }

  let invalidatedFutureSessions = 0;
  if (!block.deletedAt) {
    const updated = await tx.lessonSession.updateMany({
      where: {
        lessonBlockId: block.id,
        date: { gte: archivedAt },
        status: { in: ACTIVE_FUTURE_SESSION_STATUSES },
        deletedAt: null,
        attendances: { none: {} },
        creditLogs: { none: {} },
        teacherPaymentLesson: { is: null },
      },
      data: { status: 'INVALIDATED', version: { increment: 1 } },
    });
    invalidatedFutureSessions = updated.count;

    const safeEndDate =
      block.endDate && block.endDate < archivedAt
        ? block.endDate
        : block.startDate > archivedAt
          ? block.startDate
          : archivedAt;

    await tx.lessonBlock.update({
      where: { id: block.id },
      data: {
        deletedAt: archivedAt,
        endDate: safeEndDate,
        status: 'CANCELLED',
      },
    });

    if (params.actorId != null) {
      await tx.scheduleActionLog.create({
        data: {
          schoolId: params.schoolId,
          blockId: block.id,
          userId: params.actorId,
          entityType: 'block',
          action: 'ARCHIVE_BLOCK',
          reason: params.reason ?? 'safe-delete',
          before: {
            deletedAt: null,
            endDate: block.endDate?.toISOString() ?? null,
            status: block.status,
          } as Prisma.InputJsonValue,
          after: {
            deletedAt: archivedAt.toISOString(),
            endDate: safeEndDate.toISOString(),
            status: 'CANCELLED',
            invalidatedFutureSessions,
            counts,
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  return {
    blockId: block.id,
    archivedAt,
    alreadyArchived: Boolean(block.deletedAt),
    invalidatedFutureSessions,
    counts,
  };
}

/**
 * Single-block archive: opens its own transaction and runs archiveLessonBlockInTx.
 * Callers needing to archive multiple related blocks atomically (e.g. a Grammar/Club
 * pair) should open one outer transaction and call archiveLessonBlockInTx directly
 * for each block instead of calling this per block.
 */
export async function archiveLessonBlock(params: {
  blockId: number;
  schoolId: number;
  actorId?: number;
  role: Role;
  reason?: string;
  now?: Date;
  client?: ArchiveClient;
}): Promise<LessonBlockArchiveResult> {
  const client = params.client ?? prisma;
  return client.$transaction((tx) => archiveLessonBlockInTx(tx, params));
}
