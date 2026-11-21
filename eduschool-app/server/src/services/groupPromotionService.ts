import { Prisma, Role } from '@prisma/client';
import prisma from '../lib/prisma';
import { logScheduleAction } from '../lib/auditLog';
import { GroupLifecycleService } from './groupLifecycleService';

export class GroupPromotionError extends Error {
  statusCode: number;
  code: string;

  constructor(code: string, message: string, statusCode = 422) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface PromoteGroupOptions {
  sourceGroupId: number;
  schoolId: number;
  actorId: number;
  role: Role;
  targetLevel: string;
  targetChapter?: number;
  completeSourceGroup?: boolean;
  reason?: string;
}

export interface PromoteGroupResult {
  sourceGroup: {
    id: number;
    level: string;
    chapter: number;
    status: string;
  };
  newGroup: {
    id: number;
    level: string;
    chapter: number;
  };
  progression: {
    id: number;
    fromGroupId: number;
    toGroupId: number;
  };
  copiedStudentsCount: number;
  copiedBlocksCount: number;
  completedSourceGroup: boolean;
}

export const GroupPromotionService = {
  async promoteGroup(options: PromoteGroupOptions): Promise<PromoteGroupResult> {
    const {
      sourceGroupId,
      schoolId,
      actorId,
      role,
      targetLevel,
      targetChapter = 1,
      completeSourceGroup = true,
      reason,
    } = options;

    return prisma.$transaction(async (tx) => {
      // 1. Load source group with active memberships and non-deleted blocks
      const source = await tx.studentGroup.findFirst({
        where: { id: sourceGroupId, schoolId },
        include: {
          memberships: {
            where: { status: 'ACTIVE' },
            select: { studentProfileId: true, schoolId: true },
          },
          blocks: {
            where: { deletedAt: null },
          },
        },
      });

      if (!source) {
        throw new GroupPromotionError('PROMOTE_SOURCE_NOT_FOUND', 'Source group not found', 404);
      }
      if (source.deletedAt) {
        throw new GroupPromotionError('PROMOTE_SOURCE_ARCHIVED', 'Cannot promote an archived group');
      }
      if (source.status === 'PAUSED') {
        throw new GroupPromotionError(
          'PROMOTE_SOURCE_PAUSED',
          'Cannot promote a paused group. Resume it first.',
        );
      }
      if (source.status === 'COMPLETED') {
        throw new GroupPromotionError(
          'PROMOTE_SOURCE_COMPLETED',
          'Cannot promote a completed group again.',
        );
      }

      // 2. Create new group (copy metadata, apply target level/chapter)
      const newGroup = await tx.studentGroup.create({
        data: {
          schoolId,
          level: targetLevel,
          chapter: targetChapter,
          maxStudents: source.maxStudents,
          status: 'ACTIVE',
          pricePerMonth: source.pricePerMonth,
        },
      });

      // 3. Copy active memberships into GroupMembership (the sole enrollment source of truth)
      const activeMemberships = source.memberships;
      const copiedStudentsCount = activeMemberships.length;

      if (copiedStudentsCount > 0) {
        const now = new Date();

        await tx.groupMembership.createMany({
          data: activeMemberships.map(m => ({
            schoolId,
            studentProfileId: m.studentProfileId,
            studentGroupId: newGroup.id,
            joinedAt: now,
            status: 'ACTIVE' as const,
          })),
          skipDuplicates: true,
        });
      }

      // 4. Copy non-deleted LessonBlocks as fresh UPCOMING blocks (schedule template)
      //    LessonSessions are NOT copied — syncSessionsForBlock will generate them.
      const sourceBlocks = source.blocks;
      const copiedBlocksCount = sourceBlocks.length;

      // Cutover boundary: when the source group is being completed (the normal "promote"
      // path), it stays the sole owner of TODAY (same teacher/cabinet/day, same as its
      // endDate below) and the new group's blocks start tomorrow — otherwise both groups'
      // identical blocks would claim the same cell on the promotion day and the schedule
      // grid renders it as a duplicate/teacher-conflict (⚠). When completeSourceGroup is
      // false the source deliberately keeps running unchanged, so the new blocks start
      // immediately as before — that fork-in-parallel case needs manual re-scheduling
      // anyway (same teacher/cabinet copied verbatim).
      const now = new Date();
      const effectiveDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const newBlocksStartDate = completeSourceGroup
        ? new Date(effectiveDate.getTime() + 24 * 60 * 60 * 1000)
        : now;

      for (const block of sourceBlocks) {
        await tx.lessonBlock.create({
          data: {
            schoolId,
            studentGroupId: newGroup.id,
            cabinetId: block.cabinetId,
            teacherId: block.teacherId,
            timeSlotId: block.timeSlotId,
            days: block.days,
            startTime: block.startTime,
            endTime: block.endTime,
            level: targetLevel,
            chapter: targetChapter,
            maxStudents: block.maxStudents,
            type: block.type,
            status: 'UPCOMING',
            startDate: newBlocksStartDate,
            endDate: null,
            deletedAt: null,
          },
        });
      }

      // 5. Record the academic progression link
      const progression = await tx.groupProgression.create({
        data: {
          schoolId,
          fromGroupId: source.id,
          toGroupId: newGroup.id,
          fromLevel: source.level,
          fromChapter: source.chapter,
          toLevel: targetLevel,
          toChapter: targetChapter,
          actorId,
          reason: reason ?? null,
        },
      });

      // 6. Audit log GROUP_PROMOTED
      await logScheduleAction({
        client: tx,
        schoolId,
        userId: actorId,
        entityType: 'group',
        groupId: source.id,
        action: 'GROUP_PROMOTED',
        before: {
          sourceGroupId: source.id,
          fromLevel: source.level,
          fromChapter: source.chapter,
          status: source.status,
        },
        after: {
          targetGroupId: newGroup.id,
          toLevel: targetLevel,
          toChapter: targetChapter,
          copiedStudentsCount,
          copiedBlocksCount,
          completeSourceGroup,
          progressionId: progression.id,
        },
        reason,
      });

      // 7. Optionally complete source group through the shared lifecycle owner.
      let completedSourceGroup = false;
      if (completeSourceGroup && source.status === 'ACTIVE') {
        await GroupLifecycleService.completeGroup({
          groupId: source.id,
          schoolId,
          actorId,
          role,
          reason: reason ?? `promoted to ${targetLevel}`,
          effectiveDate,
          client: tx as unknown as Prisma.TransactionClient,
        });

        completedSourceGroup = true;
      }

      return {
        sourceGroup: {
          id: source.id,
          level: source.level,
          chapter: source.chapter,
          status: completedSourceGroup ? 'COMPLETED' : source.status,
        },
        newGroup: {
          id: newGroup.id,
          level: newGroup.level,
          chapter: newGroup.chapter,
        },
        progression: {
          id: progression.id,
          fromGroupId: source.id,
          toGroupId: newGroup.id,
        },
        copiedStudentsCount,
        copiedBlocksCount,
        completedSourceGroup,
      };
    });
  },
};
