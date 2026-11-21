import { PrismaClient } from '@prisma/client';
import { Request } from 'express';

import prismaDefault from '../../lib/prisma';
import { emitToSchool } from '../../lib/socket';
import { logScheduleAction } from '../../lib/auditLog';
import { validateSingleSessionOverride, ScheduleValidationError, validateSessionTimeBounds, timeRangesOverlap } from '../scheduleValidation';
import {
  dispatchRescheduleNotifications,
} from '../scheduleLifecycleNotificationService';
import { getEffectiveSessionTeacherId, validateSessionDate } from '../sessionService';
import {
  LifecycleActor,
} from '../scheduleLifecycleTypes';
import { log, emitScheduleSessionChanged, studentUserIdsFromMemberships, DbClient } from './lifecycleShared';
import {
  requireLifecycleReason,
} from './lifecycleGuards';
import { SESSION_STATUS_CHANGE_INCLUDE } from './lifecycleAudit';

/**
 * Moves a clean UPCOMING session to another date as one business action.
 *
 * This is not a makeup flow. It updates the same LessonSession row and marks it
 * as a manual date override so syncSessionsForBlock does not recreate the old
 * planned date.
 */
export async function moveSession(params: {
  sessionId: number;
  schoolId: number;
  actor: LifecycleActor;
  newDate: Date;
  newStartTime: string;
  newEndTime: string;
  newCabinetId: number;
  newTeacherStaffProfileId?: number;
  overrideTeacherConflict?: boolean;
  overrideCabinetConflict?: boolean;
  reason: string;
  versionGuard: number;
  req?: Request;
  client?: DbClient;
}): Promise<{ session: any }> {
  const prismaClient = (params.client ?? prismaDefault) as PrismaClient;

  const reasonCheck = requireLifecycleReason('SESSION_RESCHEDULED', params.reason);
  if (!reasonCheck.valid) {
    throw Object.assign(new Error(reasonCheck.reason!), { httpStatus: 400 });
  }
  if (!Number.isInteger(params.versionGuard)) {
    throw Object.assign(new Error('version required'), { httpStatus: 400 });
  }
  if (!params.newCabinetId) {
    throw Object.assign(new Error('CABINET_REQUIRED'), { httpStatus: 400 });
  }
  if (!params.newStartTime || !params.newEndTime) {
    throw Object.assign(new Error('TIME_REQUIRED'), { httpStatus: 400 });
  }
  if (Number.isNaN(params.newDate.getTime())) {
    throw Object.assign(new Error('INVALID_DATE'), { httpStatus: 400 });
  }

  let result: any;
  try {
    result = await prismaClient.$transaction(async (tx) => {
      const dbClient = tx as unknown as PrismaClient;

      await dbClient.$executeRaw`SELECT id FROM "LessonSession" WHERE id = ${params.sessionId} FOR UPDATE`;

      const original = await dbClient.lessonSession.findFirst({
        where: { id: params.sessionId, schoolId: params.schoolId, deletedAt: null },
        include: {
          teacher: { select: { userId: true } },
          lessonBlock: {
            include: {
              teacher: { select: { userId: true } },
              studentGroup: {
                include: { memberships: { where: { status: 'ACTIVE' as const }, select: { studentProfile: { include: { user: { select: { id: true } } } } } } },
              },
            },
          },
        },
      });
      if (!original) {
        throw Object.assign(new Error('SESSION_NOT_FOUND'), { httpStatus: 404 });
      }
      if (original.version !== params.versionGuard) {
        throw Object.assign(new Error('STALE_DATA'), { httpStatus: 409 });
      }
      if (original.status !== 'UPCOMING') {
        throw Object.assign(new Error('SESSION_NOT_MOVABLE'), {
          httpStatus: 422,
          details: { currentStatus: original.status, reason: 'Only UPCOMING sessions can be moved' },
        });
      }
      if (original.attendanceFinalizedAt) {
        throw Object.assign(new Error('SESSION_NOT_MOVABLE'), {
          httpStatus: 409,
          details: { reason: 'Attendance is finalized' },
        });
      }

      const originalDateKey = original.date.toISOString().slice(0, 10);
      const targetDateKey = params.newDate.toISOString().slice(0, 10);
      if (targetDateKey === originalDateKey) {
        throw Object.assign(new Error('MOVE_REQUIRES_DIFFERENT_DATE'), { httpStatus: 400 });
      }
      const sourceDateForMove = original.dateOverrideFrom ?? original.date;
      const sourceDateKeyForMove = sourceDateForMove.toISOString().slice(0, 10);

      const targetDayStart = new Date(`${targetDateKey}T00:00:00.000Z`);
      const targetDayEnd = new Date(`${targetDateKey}T23:59:59.999Z`);
      const sourceDayStart = new Date(`${sourceDateKeyForMove}T00:00:00.000Z`);
      const sourceDayEnd = new Date(`${sourceDateKeyForMove}T23:59:59.999Z`);
      const existingMoveFromSource = await dbClient.lessonSession.findFirst({
        where: {
          id: { not: original.id },
          lessonBlockId: original.lessonBlockId,
          isManualDate: true,
          dateOverrideFrom: { gte: sourceDayStart, lte: sourceDayEnd },
          status: { not: 'CANCELLED' },
          deletedAt: null,
        },
        select: { id: true, date: true, status: true },
      });
      if (existingMoveFromSource) {
        throw Object.assign(new Error('LESSON_DATE_CONFLICT'), {
          httpStatus: 409,
          details: {
            existingSessionId: existingMoveFromSource.id,
            existingDate: existingMoveFromSource.date,
            sourceDate: sourceDateForMove,
          },
        });
      }

      const existingTargetSession = await dbClient.lessonSession.findFirst({
        where: {
          id: { not: original.id },
          lessonBlockId: original.lessonBlockId,
          date: { gte: targetDayStart, lte: targetDayEnd },
          deletedAt: null,
        },
        select: { id: true, status: true },
      });
      if (existingTargetSession) {
        throw Object.assign(new Error('LESSON_DATE_CONFLICT'), {
          httpStatus: 409,
          details: { existingSessionId: existingTargetSession.id },
        });
      }

      const [attendanceCount, creditLogCount, paymentLink] = await Promise.all([
        dbClient.attendance.count({ where: { lessonSessionId: original.id } }),
        dbClient.lessonCreditLog.count({ where: { sessionId: original.id } }),
        dbClient.teacherPaymentLesson.findFirst({ where: { lessonSessionId: original.id }, select: { id: true } }),
      ]);
      if (attendanceCount > 0 || creditLogCount > 0 || paymentLink) {
        throw Object.assign(new Error('SESSION_NOT_MOVABLE'), {
          httpStatus: 409,
          details: {
            reason: 'Session already has attendance, credits, or teacher payment facts',
            attendanceCount,
            creditLogCount,
            hasTeacherPayment: Boolean(paymentLink),
          },
        });
      }

      const cabinet = await dbClient.cabinet.findFirst({
        where: { id: params.newCabinetId, schoolId: params.schoolId, deletedAt: null },
        select: { id: true },
      });
      if (!cabinet) {
        throw Object.assign(new Error('CABINET_NOT_FOUND'), { httpStatus: 404 });
      }

      const targetTeacherId = params.newTeacherStaffProfileId ?? original.lessonBlock.teacherId;
      if (!targetTeacherId) {
        throw Object.assign(new Error('TEACHER_REQUIRED'), { httpStatus: 400 });
      }
      if (params.newTeacherStaffProfileId !== undefined) {
        const targetTeacher = await dbClient.staffProfile.findFirst({
          where: { id: params.newTeacherStaffProfileId, user: { schoolId: params.schoolId } },
          select: { id: true },
        });
        if (!targetTeacher) {
          throw Object.assign(new Error('TEACHER_NOT_FOUND'), { httpStatus: 404 });
        }
      }

      const moveDateValidation = await validateSessionDate(
        params.schoolId,
        {
          days: [0, 1, 2, 3, 4, 5, 6],
          startDate: (original.lessonBlock as any).startDate as Date | null ?? null,
          endDate: (original.lessonBlock as any).endDate as Date | null ?? null,
        },
        targetDateKey,
        {
          teacherId: targetTeacherId,
          cabinetId: params.newCabinetId,
          groupId: original.lessonBlock.studentGroupId,
        },
      );
      if (moveDateValidation.valid === false) {
        throw Object.assign(new Error('MOVE_DATE_INVALID'), {
          httpStatus: 422,
          details: { lifecycleError: true, reason: moveDateValidation.reason },
        });
      }

      if (original.lessonBlock.studentGroupId !== null) {
        const targetWeekday = (params.newDate.getUTCDay() + 6) % 7;
        const sameGroupBlocks = await dbClient.lessonBlock.findMany({
          where: {
            schoolId: params.schoolId,
            deletedAt: null,
            id: { not: original.lessonBlockId },
            studentGroupId: original.lessonBlock.studentGroupId,
            days: { has: targetWeekday },
            startDate: { lte: targetDayEnd },
            OR: [
              { endDate: null },
              { endDate: { gte: targetDayStart } },
            ],
          },
          select: {
            id: true,
            startTime: true,
            endTime: true,
            type: true,
          },
        });
        const overlappingSameGroupBlocks = sameGroupBlocks.filter(block =>
          timeRangesOverlap(block.startTime, block.endTime, params.newStartTime, params.newEndTime)
        );
        if (overlappingSameGroupBlocks.length > 0) {
          const blockIds = overlappingSameGroupBlocks.map(block => block.id);
          const sessionStates = await dbClient.lessonSession.findMany({
            where: {
              schoolId: params.schoolId,
              deletedAt: null,
              lessonBlockId: { in: blockIds },
              OR: [
                { date: { gte: targetDayStart, lte: targetDayEnd } },
                { isManualDate: true, dateOverrideFrom: { gte: targetDayStart, lte: targetDayEnd } },
              ],
            },
            select: {
              id: true,
              lessonBlockId: true,
              date: true,
              status: true,
              isManualDate: true,
              dateOverrideFrom: true,
            },
          });
          const conflictBlock = overlappingSameGroupBlocks.find(block => {
            const states = sessionStates.filter(state => state.lessonBlockId === block.id);
            const movedAway = states.some(state =>
              state.isManualDate
              && state.dateOverrideFrom?.toISOString().slice(0, 10) === targetDateKey
              && state.date.toISOString().slice(0, 10) !== targetDateKey
            );
            if (movedAway) return false;

            const explicitOnTarget = states.find(state => state.date.toISOString().slice(0, 10) === targetDateKey);
            return !explicitOnTarget || explicitOnTarget.status !== 'CANCELLED';
          });
          if (conflictBlock) {
            throw Object.assign(new Error('LESSON_TARGET_GROUP_CONFLICT'), {
              httpStatus: 409,
              details: {
                lessonBlockId: conflictBlock.id,
                startTime: conflictBlock.startTime,
                endTime: conflictBlock.endTime,
                type: conflictBlock.type,
              },
            });
          }
        }
      }

      try {
        await validateSingleSessionOverride(dbClient, {
          sessionId: original.id,
          date: params.newDate,
          schoolId: params.schoolId,
          cabinetId: params.newCabinetId,
          teacherId: targetTeacherId,
          startTime: params.newStartTime,
          endTime: params.newEndTime,
          studentGroupId: original.lessonBlock.studentGroupId,
          overrideTeacherConflict: params.overrideTeacherConflict,
        });
      } catch (e: any) {
        if (e instanceof ScheduleValidationError && e.message.startsWith('CAPACITY_WARNING:')) {
          if (!params.overrideCabinetConflict) {
            throw Object.assign(new Error(e.message), { httpStatus: 400 });
          }
        } else {
          throw Object.assign(new Error(e.message), { httpStatus: 409 });
        }
      }

      const timeBoundsResult = await validateSessionTimeBounds(
        dbClient,
        params.schoolId,
        params.newStartTime,
        params.newEndTime,
        params.newDate,
      );
      if (timeBoundsResult.valid === false) {
        throw Object.assign(new Error('TIME_OUTSIDE_WORKING_HOURS'), {
          httpStatus: 422,
          details: { lifecycleError: true, reason: timeBoundsResult.reason },
        });
      }

      const oldStartTime = original.startTimeSnap ?? original.lessonBlock.startTime;
      const oldEndTime = original.endTimeSnap ?? original.lessonBlock.endTime;
      const oldCabinetId = original.cabinetIdSnap ?? original.lessonBlock.cabinetId;
      const oldTeacherId = getEffectiveSessionTeacherId(original) ?? original.lessonBlock.teacherId;
      const dateOverrideFrom = original.dateOverrideFrom ?? original.date;
      const movingBackToPlannedDate = targetDateKey === dateOverrideFrom.toISOString().slice(0, 10);

      const updatedSession = await dbClient.lessonSession.update({
        where: { id: original.id, version: params.versionGuard },
        data: {
          date: params.newDate,
          teacherId: params.newTeacherStaffProfileId ?? null,
          teacherIdSnap: targetTeacherId,
          cabinetIdSnap: params.newCabinetId,
          startTimeSnap: params.newStartTime,
          endTimeSnap: params.newEndTime,
          isManualTeacher: params.newTeacherStaffProfileId !== undefined,
          isManualTime: true,
          isManualCabinet: true,
          isManualDate: !movingBackToPlannedDate,
          dateOverrideFrom: movingBackToPlannedDate ? null : dateOverrideFrom,
          isMakeup: false,
          makeupForSessionId: null,
          version: { increment: 1 },
        },
        include: SESSION_STATUS_CHANGE_INCLUDE,
      });

      await logScheduleAction({
        client: dbClient,
        schoolId: params.schoolId,
        userId: params.actor.userId,
        action: 'SESSION_MOVED',
        entityType: 'session',
        sessionId: original.id,
        before: {
          sessionId: original.id,
          date: original.date,
          status: original.status,
          startTime: oldStartTime,
          endTime: oldEndTime,
          cabinetId: oldCabinetId,
          teacherId: oldTeacherId,
        },
        after: {
          sessionId: updatedSession.id,
          date: params.newDate,
          status: updatedSession.status,
          startTime: params.newStartTime,
          endTime: params.newEndTime,
          cabinetId: params.newCabinetId,
          teacherId: targetTeacherId,
          isManualDate: updatedSession.isManualDate,
          dateOverrideFrom: updatedSession.dateOverrideFrom,
        },
        reason: params.reason,
        req: params.req,
      });

      return { original, updatedSession, oldStartTime, oldEndTime };
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      throw Object.assign(new Error('LESSON_DATE_CONFLICT'), { httpStatus: 409 });
    }
    throw err;
  }

  const studentUserIds = studentUserIdsFromMemberships((result.original as any).lessonBlock?.studentGroup);
  const teacherUserId =
    params.newTeacherStaffProfileId !== undefined
      ? (result.updatedSession as any).teacher?.userId as number | undefined
      : (result.original as any).lessonBlock?.teacher?.userId as number | undefined;

  try {
    await dispatchRescheduleNotifications({
      sessionId: result.updatedSession.id,
      lessonBlockId: result.updatedSession.lessonBlockId,
      sessionDate: result.updatedSession.date,
      blockLevel: (result.original as any).lessonBlock?.level ?? '',
      oldSlot: { startTime: result.oldStartTime, endTime: result.oldEndTime },
      newSlot: { startTime: params.newStartTime, endTime: params.newEndTime },
      reason: params.reason,
      studentUserIds,
      teacherUserId,
    });
  } catch (err) {
    log.warn({ err, sessionId: result.updatedSession.id }, 'SESSION_MOVED notification dispatch failed');
  }

  emitToSchool(params.schoolId, 'session:status-changed', {
    sessionId: result.updatedSession.id,
    lessonBlockId: result.updatedSession.lessonBlockId,
    status: result.updatedSession.status,
    date: result.updatedSession.date,
  });
  emitScheduleSessionChanged(params.schoolId, {
    sessionId: result.updatedSession.id,
    lessonBlockId: result.updatedSession.lessonBlockId,
    status: result.updatedSession.status,
    date: result.updatedSession.date,
    action: 'session-moved',
  });

  return { session: result.updatedSession };
}
