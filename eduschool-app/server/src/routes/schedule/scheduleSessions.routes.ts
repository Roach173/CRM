import { Router } from 'express';
import prisma from '../../lib/prisma';
import { authenticate, AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { MemberStatus } from '@prisma/client';
import { CacheKeys } from '../../lib/cacheKeys';
import { sessionEnsureLimiter } from '../../middleware/rateLimiters';
import { idempotency } from '../../middleware/idempotency';
import { cacheInvalidate } from '../../lib/cache';
import { getWeekBoundaries, getDayBoundaries, dateInTz } from '../../lib/tzUtils';
import {
  ScheduleValidationError,
  validateSingleSessionOverride,
  validateSessionTimeBounds,
  checkTeacherWorkload,
  timeRangesOverlap,
  dateRangesOverlap,
} from '../../services/scheduleValidation';
import {
  ensureSingleSession,
  getEffectiveSessionTeacherId,
} from '../../services/sessionService';
import {
  attendanceStateFor,
} from '../../services/attendanceFinalizationService';
import {
  changeSessionStatus,
  cancelSession,
  restoreSession,
  replaceTeacher,
  rescheduleSession,
  createMakeupSession,
  moveSession,
  requireLifecycleReason,
  SESSION_STATUS_CHANGE_INCLUDE,
} from '../../services/scheduleLifecycleService';
import type { LifecycleActor } from '../../services/scheduleLifecycleTypes';
import { canPerformGroupAction, GroupShape } from '../../lib/groupLifecyclePolicy';
import { sendLifecycleError } from '../../lib/routeError';
import {
  log, PAUSED_GROUP_OPERATION_ERROR,
  dateStr, isSessionInsideBlockVersion,
  isInactiveGroup,
  emitScheduleSessionChanged, mapTeacher,
  assertTeacherOwnsSession,
} from './scheduleRouteUtils';

const router = Router();

// ─── GET /sessions/week ───────────────────────────────────────────────────────

router.get('/sessions/week', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const { weekStart } = req.query;
    if (!weekStart) return res.status(400).json({ success: false, error: 'weekStart required' });

    const school = await prisma.school.findFirst({ where: { id: schoolId }, select: { timezone: true } });
    const tz = school?.timezone ?? 'Asia/Bishkek';
    const { from: mon, to: sun } = getWeekBoundaries(weekStart as string, tz);

    const sessions = await prisma.lessonSession.findMany({
      where: {
        schoolId,
        deletedAt: null,
        OR: [
          { date: { gte: mon, lt: sun } },
          { isManualDate: true, dateOverrideFrom: { gte: mon, lt: sun } },
        ],
      },
      select: {
        id: true,
        lessonBlockId: true,
        date: true,
        isManualDate: true,
        dateOverrideFrom: true,
        status: true,
        attendanceFinalizedAt: true,
        attendanceFinalizedById: true,
        attendanceReopenedAt: true,
        attendanceReopenedById: true,
        attendanceReopenReason: true,
        startTimeSnap: true,
        endTimeSnap: true,
        cabinetIdSnap: true,
        teacherIdSnap: true,
        isMakeup: true,
        makeupForSessionId: true,
        makeupForSession: {
          select: {
            id: true,
            date: true,
            status: true,
            startTimeSnap: true,
            endTimeSnap: true,
          },
        },
        makeupSessions: {
          where: { deletedAt: null },
          select: {
            id: true,
            date: true,
            status: true,
            startTimeSnap: true,
            endTimeSnap: true,
          },
          orderBy: { date: 'asc' },
          take: 1,
        },
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        lessonBlock: {
          select: {
            id: true,
            studentGroupId: true,
            type: true,
            teacherId: true,
            startTime: true,
            endTime: true,
            startDate: true,
            endDate: true,
            cabinetId: true,
            teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    });
    const rangeVisibleSessions = sessions.filter((session: any) => (
      session.lessonBlock && (isSessionInsideBlockVersion(session, session.lessonBlock) || (session.isManualDate && session.dateOverrideFrom))
    ));
    const visibleSessionMap = new Map<string, any>();
    const visibleSessions: any[] = [];
    for (const session of rangeVisibleSessions as any[]) {
      const groupId = session.lessonBlock?.studentGroupId;
      if (!groupId) {
        visibleSessions.push(session);
        continue;
      }
      const key = `${groupId}:${session.lessonBlock.type}:${dateStr(session.date)}`;
      const existing = visibleSessionMap.get(key);
      if (!existing) {
        visibleSessionMap.set(key, session);
        continue;
      }
      const existingStart = dateStr(existing.lessonBlock.startDate) ?? '';
      const sessionStart = dateStr(session.lessonBlock.startDate) ?? '';
      if (sessionStart > existingStart || (sessionStart === existingStart && session.lessonBlockId > existing.lessonBlockId)) {
        visibleSessionMap.set(key, session);
      }
    }
    visibleSessions.push(...visibleSessionMap.values());
    visibleSessions.sort((a, b) => a.date.getTime() - b.date.getTime() || a.lessonBlockId - b.lessonBlockId || a.id - b.id);

    // Batch-resolve teacherIdSnap names for COMPLETED/LOCKED sessions without an explicit sub.
    // Needed because block.teacher may have changed after the session was completed.
    const snapIds = visibleSessions
      .filter((s: any) => !s.teacher && s.teacherIdSnap && (s.status === 'COMPLETED' || s.status === 'LOCKED'))
      .map((s: any) => s.teacherIdSnap as number);
    const uniqueSnapIds = [...new Set(snapIds)];
    const snapTeacherMap = new Map<number, { id: number; firstName: string; lastName: string }>();
    if (uniqueSnapIds.length > 0) {
      const snapProfiles = await prisma.staffProfile.findMany({
        where: { id: { in: uniqueSnapIds } },
        select: { id: true, user: { select: { id: true, firstName: true, lastName: true } } },
      });
      for (const p of snapProfiles) {
        snapTeacherMap.set(p.id, { id: p.user.id, firstName: p.user.firstName, lastName: p.user.lastName });
      }
    }

    // Batch-resolve cabinet names for sessions where cabinetIdSnap overrides the block's default.
    const snapCabinetIds = visibleSessions
      .filter((s: any) => s.cabinetIdSnap && s.cabinetIdSnap !== s.lessonBlock?.cabinetId)
      .map((s: any) => s.cabinetIdSnap as number);
    const uniqueCabinetIds = [...new Set(snapCabinetIds)];
    const snapCabinetMap = new Map<number, string>();
    if (uniqueCabinetIds.length > 0) {
      const cabinets = await prisma.cabinet.findMany({
        where: { id: { in: uniqueCabinetIds }, schoolId: schoolId! },
        select: { id: true, name: true },
      });
      for (const c of cabinets) snapCabinetMap.set(c.id, c.name);
    }

    const data = visibleSessions.map((s: any) => {
      const sessionTeacher = s.teacher
        ? { id: s.teacher.userId, firstName: s.teacher.user.firstName, lastName: s.teacher.user.lastName }
        : null;
      const blockTeacher = s.lessonBlock?.teacher
        ? { id: s.lessonBlock.teacher.userId, firstName: s.lessonBlock.teacher.user.firstName, lastName: s.lessonBlock.teacher.user.lastName }
        : null;
      // For completed/locked sessions without an explicit sub, use the snapshot teacher (historical record)
      const isHistoricalSession = s.status === 'COMPLETED' || s.status === 'LOCKED';
      const snapTeacher = (!sessionTeacher && s.teacherIdSnap && isHistoricalSession)
        ? snapTeacherMap.get(s.teacherIdSnap) ?? null
        : null;
      // isSubstitute — true only when session teacher is explicitly different from block teacher
      const isSubstitute = sessionTeacher !== null
        && blockTeacher !== null
        && sessionTeacher.id !== blockTeacher.id;
      // isHistoricalTeacher — true when we're showing teacherIdSnap because block teacher has changed
      const effectiveTeacher = sessionTeacher ?? snapTeacher ?? blockTeacher;
      const isHistoricalTeacher = snapTeacher !== null && blockTeacher !== null && snapTeacher.id !== blockTeacher.id;
      // Снимки возвращаем только если они реально отличаются от значений блока
      const startTimeSnap = s.startTimeSnap && s.startTimeSnap !== s.lessonBlock?.startTime ? s.startTimeSnap : null;
      const endTimeSnap = s.endTimeSnap && s.endTimeSnap !== s.lessonBlock?.endTime ? s.endTimeSnap : null;
      const cabinetIdSnap = s.cabinetIdSnap && s.cabinetIdSnap !== s.lessonBlock?.cabinetId ? s.cabinetIdSnap : null;
      return {
        id: s.id,
        lessonBlockId: s.lessonBlockId,
        date: dateInTz(s.date, tz),
        isManualDate: s.isManualDate,
        dateOverrideFrom: s.dateOverrideFrom ? dateInTz(s.dateOverrideFrom, tz) : null,
        status: s.status,
        startTimeSnap,
        endTimeSnap,
        cabinetIdSnap,
        cabinetNameSnap: cabinetIdSnap ? (snapCabinetMap.get(cabinetIdSnap) ?? null) : null,
        teacher: effectiveTeacher,
        isSubstitute,
        isHistoricalTeacher,
        isMakeup: s.isMakeup,
        makeupForSessionId: s.makeupForSessionId,
        attendanceFinalizedAt: s.attendanceFinalizedAt,
        attendanceFinalizedById: s.attendanceFinalizedById,
        attendanceReopenedAt: s.attendanceReopenedAt,
        attendanceReopenedById: s.attendanceReopenedById,
        attendanceReopenReason: s.attendanceReopenReason,
        ...attendanceStateFor({
          status: s.status,
          attendanceFinalizedAt: s.attendanceFinalizedAt,
          date: s.date,
          startTime: s.startTimeSnap ?? s.lessonBlock?.startTime ?? null,
        }, tz),
        makeupForSession: s.makeupForSession ? {
          id: s.makeupForSession.id,
          date: dateInTz(s.makeupForSession.date, tz),
          status: s.makeupForSession.status,
          startTimeSnap: s.makeupForSession.startTimeSnap,
          endTimeSnap: s.makeupForSession.endTimeSnap,
        } : null,
        makeupSession: s.makeupSessions?.[0] ? {
          id: s.makeupSessions[0].id,
          date: dateInTz(s.makeupSessions[0].date, tz),
          status: s.makeupSessions[0].status,
          startTimeSnap: s.makeupSessions[0].startTimeSnap,
          endTimeSnap: s.makeupSessions[0].endTimeSnap,
        } : null,
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    log.error({ err: error }, 'get week sessions error');
    res.status(500).json({ success: false, error: 'Failed to fetch week sessions' });
  }
});

// ─── GET /session/for-date ────────────────────────────────────────────────────

router.get('/session/for-date', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const lessonBlockId = parseInt(String(req.query.lessonBlockId));
    const date = String(req.query.date);
    if (!lessonBlockId || !date) {
      return res.status(400).json({ success: false, error: 'lessonBlockId and date required' });
    }

    const sessionSchool = await prisma.school.findFirst({ where: { id: schoolId! }, select: { timezone: true } });
    const sessionTz = sessionSchool?.timezone ?? 'Asia/Bishkek';
    const { from: dayStart, to: dayEnd } = getDayBoundaries(date, sessionTz);

    const session = await prisma.lessonSession.findFirst({
      where: { lessonBlockId, schoolId, date: { gte: dayStart, lte: dayEnd }, deletedAt: null },
      select: {
        id: true,
        status: true,
        date: true,
        attendanceFinalizedAt: true,
        attendanceFinalizedById: true,
        attendanceReopenedAt: true,
        attendanceReopenedById: true,
        attendanceReopenReason: true,
        attendanceFinalizedBy: { select: { firstName: true, lastName: true } },
        attendanceReopenedBy: { select: { firstName: true, lastName: true } },
        startTimeSnap: true,
        lessonBlock: { select: { startTime: true } },
      },
    });

    if (!session) {
      return res.json({ success: true, data: { session: null, attendances: [] } });
    }

    const attendances = await prisma.attendance.findMany({
      where: { lessonSessionId: session.id },
      select: {
        studentProfileId: true,
        status: true,
        creditDeducted: true,
        submittedById: true,
        createdAt: true,
        submittedBy: { select: { firstName: true, lastName: true } },
      },
    });

    const { lessonBlock, ...sessionFields } = session;
    const effectiveStartTime = session.startTimeSnap ?? lessonBlock?.startTime ?? null;

    res.json({
      success: true,
      data: {
        session: {
          ...sessionFields,
          ...attendanceStateFor({ ...session, startTime: effectiveStartTime }, sessionTz),
        },
        attendances,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'get session for-date error');
    res.status(500).json({ success: false, error: 'Failed to fetch session attendance' });
  }
});

// ─── POST /session/ensure ─────────────────────────────────────────────────────

router.post('/session/ensure', sessionEnsureLimiter, authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const { lessonBlockId, date } = req.body;
    if (!lessonBlockId || !date) {
      return res.status(400).json({ success: false, error: 'lessonBlockId and date are required' });
    }

    const block = await prisma.lessonBlock.findFirst({
      where: { id: parseInt(lessonBlockId), schoolId: req.user!.schoolId!, deletedAt: null },
      select: { id: true, schoolId: true, days: true, startDate: true, endDate: true, teacherId: true, cabinetId: true, startTime: true, endTime: true, studentGroupId: true },
    });
    if (!block) return res.status(404).json({ success: false, error: 'Block not found' });

    const result = await ensureSingleSession(block, date);
    if ('error' in result) return res.status(400).json({ success: false, error: result.error });

    const fullSession = await prisma.lessonSession.findUnique({
      where: { id: result.session.id },
      include: { teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } } },
    });
    res.json({ success: true, data: mapTeacher(fullSession) });
  } catch (error) {
    log.error({ err: error }, 'ensure session error');
    res.status(500).json({ success: false, error: 'Failed to ensure session' });
  }
});

// ─── PATCH /session/:id/teacher ───────────────────────────────────────────────
// PR 3: when assigning a new teacher, routes through replaceTeacher() lifecycle
//        service for editability guard, cross-tenant check, salary safety,
//        before/after audit, and socket emit.
//        Clearing the teacher (teacherId absent) keeps the existing direct path.

router.patch('/session/:id/teacher', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const { teacherId, overrideTeacherConflict, version, reason } = req.body;
    const sessionId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;

    const session = await prisma.lessonSession.findFirst({
      where: { id: sessionId, schoolId, deletedAt: null },
      include: {
        lessonBlock: {
          select: {
            startTime: true,
            endTime: true,
            studentGroupId: true,
            studentGroup: true,
          },
        },
      },
    });
    if (!session) return res.status(404).json({ success: false, error: 'Сессия не найдена' });
    if (isInactiveGroup(session.lessonBlock.studentGroup)) {
      return res.status(400).json({ success: false, error: PAUSED_GROUP_OPERATION_ERROR });
    }

    if (version !== undefined && session.version !== version) {
      return res.status(409).json({ success: false, error: 'STALE_DATA' });
    }

    // ── ASSIGN NEW TEACHER: schedule conflict checks then lifecycle service ────
    if (teacherId) {
      const staff = await prisma.staffProfile.findFirst({ where: { userId: parseInt(teacherId), user: { schoolId } } });
      if (!staff) return res.status(400).json({ success: false, error: 'Учитель не найден' });
      const staffProfileId = staff.id;

      const sessionDate = session.date;
      const { startTime, endTime } = session.lessonBlock;

      // Permanent schedule conflicts
      const teacherBlocks = await prisma.lessonBlock.findMany({
        where: { teacherId: staffProfileId, deletedAt: null },
        select: { id: true, days: true, startTime: true, endTime: true, startDate: true, endDate: true, level: true },
      });
      for (const block of teacherBlocks) {
        if (
          block.days.includes((sessionDate.getUTCDay() + 6) % 7) &&
          timeRangesOverlap(block.startTime, block.endTime, startTime, endTime) &&
          dateRangesOverlap(block.startDate, block.endDate, sessionDate, sessionDate)
        ) {
          return res.status(409).json({
            success: false,
            error: `Конфликт: у учителя есть постоянный урок в это время (${block.level}, ${block.startTime}–${block.endTime})`,
          });
        }
      }

      // Substitute conflicts on the same day
      const dayStart = new Date(sessionDate);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(sessionDate);
      dayEnd.setUTCHours(23, 59, 59, 999);
      const otherSubstitutions = await prisma.lessonSession.findMany({
        where: { teacherId: staffProfileId, date: { gte: dayStart, lte: dayEnd }, deletedAt: null, id: { not: sessionId } },
        include: { lessonBlock: { select: { startTime: true, endTime: true, level: true } } },
      });
      for (const other of otherSubstitutions) {
        if (timeRangesOverlap(other.lessonBlock.startTime, other.lessonBlock.endTime, startTime, endTime)) {
          return res.status(409).json({
            success: false,
            error: `Конфликт: учитель уже назначен заменой на другой урок в это время (${other.lessonBlock.level}, ${other.lessonBlock.startTime}–${other.lessonBlock.endTime})`,
          });
        }
      }

      // Teacher workload check
      try {
        const weekday = sessionDate.getUTCDay();
        const adjustedWeekday = (weekday === 0) ? 6 : weekday - 1;
        await checkTeacherWorkload(prisma, staffProfileId, [adjustedWeekday], overrideTeacherConflict);
      } catch (e: any) {
        if (e instanceof ScheduleValidationError) {
          return res.status(400).json({ success: false, error: e.message });
        }
        throw e;
      }

      // Lifecycle service: editability + cross-tenant + salary safety + audit + notify + socket
      try {
        const actor: LifecycleActor = { userId: req.user!.userId, role: req.user!.role, schoolId };
        const updated = await replaceTeacher({
          sessionId,
          schoolId,
          actor,
          substituteStaffProfileId: staffProfileId,
          reason: reason ?? '',
          versionGuard: version,
        });
        return res.json({ success: true, data: mapTeacher(updated) });
      } catch (err: any) {
        return sendLifecycleError(res, err, 'Failed to replace teacher');
      }
    }

    // ── CLEAR TEACHER (teacherId absent): direct path, preserve existing behavior ─
    const updated = await prisma.lessonSession.update({
      where: {
        id: sessionId,
        ...(version !== undefined && { version }),
      },
      data: {
        teacherId: null,
        isManualTeacher: true,
        version: { increment: 1 },
      },
      include: {
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        lessonBlock: { select: { teacher: { select: { user: { select: { firstName: true, lastName: true } } } } } },
      },
    });
    await prisma.scheduleActionLog.create({
      data: {
        schoolId: updated.schoolId,
        sessionId: updated.id,
        userId: req.user!.userId,
        action: 'CHANGE_TEACHER',
        details: 'Учитель удален',
      },
    });
    emitScheduleSessionChanged(schoolId, {
      sessionId: updated.id,
      lessonBlockId: updated.lessonBlockId,
      date: updated.date,
      action: 'teacher-cleared',
    });
    return res.json({ success: true, data: mapTeacher(updated) });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(409).json({ success: false, error: 'STALE_DATA' });
    }
    log.error({ err: error }, 'update session teacher error');
    res.status(500).json({ success: false, error: 'Failed to update session teacher' });
  }
});

// ─── PATCH /session/:id/details ───────────────────────────────────────────────

router.patch('/session/:id/details', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const { startTime, endTime, cabinetId, overrideCabinetConflict, overrideTeacherConflict, version } = req.body;
    const sessionId = parseInt(req.params.id);

    const session = await prisma.lessonSession.findFirst({
      where: { id: sessionId, schoolId: req.user!.schoolId!, deletedAt: null },
      include: {
        lessonBlock: {
          select: { startTime: true, endTime: true, cabinetId: true, teacherId: true, studentGroupId: true }
        }
      }
    });

    if (!session) return res.status(404).json({ success: false, error: 'Сессия не найдена' });

    if (version !== undefined && session.version !== version) {
      return res.status(409).json({ success: false, error: 'STALE_DATA' });
    }

    const newStartTime = startTime ?? session.startTimeSnap ?? session.lessonBlock.startTime;
    const newEndTime = endTime ?? session.endTimeSnap ?? session.lessonBlock.endTime;
    const newCabinetId = cabinetId ?? session.cabinetIdSnap ?? session.lessonBlock.cabinetId;
    const currentTeacherId = getEffectiveSessionTeacherId(session) ?? session.lessonBlock.teacherId;

    if (!newCabinetId) {
      return res.status(400).json({ success: false, error: 'Кабинет обязателен' });
    }

    try {
      await validateSingleSessionOverride(prisma, {
        sessionId,
        date: session.date,
        schoolId: session.schoolId,
        cabinetId: newCabinetId,
        teacherId: currentTeacherId!,
        startTime: newStartTime,
        endTime: newEndTime,
        studentGroupId: session.lessonBlock.studentGroupId,
        overrideTeacherConflict
      });
    } catch (e: any) {
      if (e instanceof ScheduleValidationError && e.message.startsWith('CAPACITY_WARNING:')) {
        if (!overrideCabinetConflict) {
          return res.status(400).json({ success: false, error: e.message });
        }
      } else if (e instanceof ScheduleValidationError) {
        return res.status(409).json({ success: false, error: e.message });
      } else {
        return sendLifecycleError(res, e, 'Failed to update session details');
      }
    }

    // D-02: validate working-hours bounds when start/end time is being changed.
    if (startTime !== undefined || endTime !== undefined) {
      const timeBoundsResult = await validateSessionTimeBounds(
        prisma,
        req.user!.schoolId!,
        newStartTime,
        newEndTime,
        session.date,
      );
      if (timeBoundsResult.valid === false) {
        return res.status(422).json({
          success: false,
          error: 'TIME_OUTSIDE_WORKING_HOURS',
          details: { reason: timeBoundsResult.reason },
        });
      }
    }

    const updated = await prisma.lessonSession.update({
      where: {
        id: sessionId,
        ...(version !== undefined && { version }), // atomic version guard — P2025 if stale
      },
      data: {
        startTimeSnap: newStartTime,
        endTimeSnap: newEndTime,
        cabinetIdSnap: newCabinetId,
        isManualTime: startTime !== undefined || endTime !== undefined,
        isManualCabinet: cabinetId !== undefined,
        version: { increment: 1 },
      },
      include: {
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        lessonBlock: { select: { startTime: true, endTime: true, cabinet: { select: { name: true } } } }
      },
    });

    // Логируем изменения
    let logMsg = [];
    if (startTime || endTime) logMsg.push(`Время изменено на ${newStartTime}-${newEndTime}`);
    if (cabinetId) {
      const cab = await prisma.cabinet.findFirst({ where: { id: cabinetId, schoolId: req.user!.schoolId! }, select: { name: true } });
      logMsg.push(`Кабинет изменен на ${cab?.name ?? cabinetId}`);
    }

    if (logMsg.length > 0) {
      await prisma.scheduleActionLog.create({
        data: {
          schoolId: updated.schoolId,
          sessionId: updated.id,
          userId: req.user!.userId,
          action: 'CHANGE_DETAILS',
          details: logMsg.join('; ')
        }
      });
    }

    emitScheduleSessionChanged(updated.schoolId, {
      sessionId: updated.id,
      lessonBlockId: updated.lessonBlockId,
      date: updated.date,
      action: 'details-updated',
    });

    res.json({ success: true, data: mapTeacher(updated) });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(409).json({ success: false, error: 'STALE_DATA' });
    }
    log.error({ err: error }, 'update session details error');
    res.status(500).json({ success: false, error: 'Failed to update session details' });
  }
});

// ─── PATCH /session/:id/reschedule ───────────────────────────────────────────
// First-class lifecycle event for time/room changes on the same date.
//        Requires reason (≥ 5 chars). Validates conflicts. Writes before/after audit.
//        To move a session to a different day, use POST /session/:id/move (moveSession) instead.

router.patch('/session/:id/reschedule', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const schoolId  = req.user!.schoolId!;
    const { startTime, endTime, cabinetId, reason, overrideTeacherConflict, overrideCabinetConflict, version } = req.body;

    const actor: LifecycleActor = { userId: req.user!.userId, role: req.user!.role, schoolId };

    const updated = await rescheduleSession({
      sessionId,
      schoolId,
      actor,
      newStartTime:  startTime,
      newEndTime:    endTime,
      newCabinetId:  cabinetId !== undefined ? parseInt(cabinetId) : undefined,
      overrideTeacherConflict,
      overrideCabinetConflict,
      reason: reason ?? '',
      versionGuard:  version,
    });

    return res.json({ success: true, data: mapTeacher(updated) });
  } catch (err: any) {
    sendLifecycleError(res, err, 'Failed to reschedule session');
  }
});

// ─── POST /session/:id/move ────────────────────────────────────────────────────
// Atomic date move: update the same clean UPCOMING session.
router.post('/session/:id/move', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const schoolId = req.user!.schoolId!;
    const {
      date,
      startTime,
      endTime,
      cabinetId,
      teacherId,
      reason,
      version,
      overrideCabinetConflict,
      overrideTeacherConflict,
    } = req.body;

    if (!date) return res.status(400).json({ success: false, error: 'date required' });
    if (!startTime || !endTime) return res.status(400).json({ success: false, error: 'startTime and endTime required' });
    if (cabinetId === undefined || cabinetId === null || cabinetId === '') {
      return res.status(400).json({ success: false, error: 'cabinetId required' });
    }
    if (version === undefined || version === null || version === '') {
      return res.status(400).json({ success: false, error: 'version required' });
    }

    const parsedCabinetId = parseInt(String(cabinetId), 10);
    const parsedVersion = parseInt(String(version), 10);
    if (!Number.isInteger(parsedCabinetId)) {
      return res.status(400).json({ success: false, error: 'invalid cabinetId' });
    }
    if (!Number.isInteger(parsedVersion)) {
      return res.status(400).json({ success: false, error: 'invalid version' });
    }

    const targetDate = new Date(`${date}T12:00:00.000Z`);
    if (Number.isNaN(targetDate.getTime())) {
      return res.status(400).json({ success: false, error: 'invalid date' });
    }

    let teacherStaffProfileId: number | undefined;
    if (teacherId !== undefined && teacherId !== null && teacherId !== '') {
      const parsedTeacherUserId = parseInt(String(teacherId), 10);
      if (!Number.isInteger(parsedTeacherUserId)) {
        return res.status(400).json({ success: false, error: 'invalid teacherId' });
      }
      const staff = await prisma.staffProfile.findFirst({
        where: { userId: parsedTeacherUserId, user: { schoolId } },
        select: { id: true },
      });
      if (!staff) {
        return res.status(404).json({ success: false, error: 'TEACHER_NOT_FOUND' });
      }
      teacherStaffProfileId = staff.id;
    }

    const actor: LifecycleActor = {
      userId: req.user!.userId,
      role: req.user!.role,
      schoolId,
    };

    const result = await moveSession({
      sessionId,
      schoolId,
      actor,
      newDate: targetDate,
      newStartTime: String(startTime),
      newEndTime: String(endTime),
      newCabinetId: parsedCabinetId,
      newTeacherStaffProfileId: teacherStaffProfileId,
      overrideCabinetConflict,
      overrideTeacherConflict,
      reason: reason ?? '',
      versionGuard: parsedVersion,
      req,
    });

    await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});

    return res.json({ success: true, data: result });
  } catch (err: any) {
    sendLifecycleError(res, err, 'Failed to move session');
  }
});

router.get('/session/:id/logs', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const logs = await prisma.scheduleActionLog.findMany({
      where: { sessionId, schoolId: req.user!.schoolId },
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: logs });
  } catch (error) {
    log.error({ err: error }, 'get session logs error');
    res.status(500).json({ success: false, error: 'Failed to fetch logs' });
  }
});

// ─── GET /session/:id/students ────────────────────────────────────────────────

router.get('/session/:id/students', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const sessionId = parseInt(req.params.id);

    const snapshot = await prisma.sessionStudent.findMany({
      where: { lessonSessionId: sessionId, schoolId: req.user!.schoolId! },
      include: {
        studentProfile: {
          include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
        },
      },
      orderBy: { snappedAt: 'asc' },
    });

    if (snapshot.length > 0) {
      return res.json({ success: true, data: snapshot.map(ss => ss.studentProfile) });
    }

    // Fallback для сессий до введения снапшотов
    const session = await prisma.lessonSession.findFirst({
      where: { id: sessionId, schoolId: req.user!.schoolId!, deletedAt: null },
      include: {
        lessonBlock: {
          include: {
            studentGroup: {
              include: {
                memberships: {
                  where: { status: MemberStatus.ACTIVE },
                  select: { studentProfile: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } } },
                },
              },
            },
          },
        },
      },
    });
    if (!session) return res.status(404).json({ success: false, error: 'Сессия не найдена' });

    res.json({ success: true, data: session.lessonBlock.studentGroup?.memberships.map(m => m.studentProfile) ?? [] });
  } catch (error) {
    log.error({ err: error }, 'get session students error');
    res.status(500).json({ success: false, error: 'Failed to fetch session students' });
  }
});

// ─── PATCH /session/:id/status ────────────────────────────────────────────────

router.patch('/session/:id/status', authenticate, requirePermission('session:write'), async (req: AuthRequest, res) => {
  try {
    const { status, reason, version } = req.body;
    const sessionId = parseInt(req.params.id);
    const role = req.user!.role;

    const session = await prisma.lessonSession.findFirst({
      where: { id: sessionId, schoolId: req.user!.schoolId!, deletedAt: null },
      include: SESSION_STATUS_CHANGE_INCLUDE,
    });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    if (version !== undefined && session.version !== version) {
      return res.status(409).json({ success: false, error: 'STALE_DATA' });
    }
    if (status !== session.status && isInactiveGroup(session.lessonBlock.studentGroup)) {
      return res.status(400).json({ success: false, error: PAUSED_GROUP_OPERATION_ERROR });
    }

    await assertTeacherOwnsSession(req, sessionId);

    // Delegate to scheduleLifecycleService (PR 2: route integration).
    // changeSessionStatus handles: canTransition, restore guard, DB update,
    // audit log, notifications, and socket emit — identical behavior to before.
    const updated = await changeSessionStatus({
      session,
      targetStatus: status,
      actor: { userId: req.user!.userId, role, schoolId: req.user!.schoolId! },
      reason,
      versionGuard: version,
      req,
    });

    res.json({ success: true, data: mapTeacher(updated) });
  } catch (error: any) {
    sendLifecycleError(res, error, 'Failed to update session status');
  }
});

// ─── POST /session/:id/makeup — создать замещающий урок для отменённой сессии ─
// PR 6: routed through lifecycle service — audit, notifications, socket, lifecycle event.

router.post('/session/:id/makeup', authenticate, idempotency, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const sessionId = parseInt(req.params.id);
    const { date, reason } = req.body; // date: YYYY-MM-DD, reason: string

    if (!date) return res.status(400).json({ success: false, error: 'date required' });

    const preCheck = await prisma.lessonSession.findFirst({
      where: { id: sessionId, schoolId, deletedAt: null },
      include: {
        lessonBlock: {
          include: { studentGroup: { select: { status: true, deletedAt: true } } },
        },
      },
    });
    if (!preCheck) return res.status(404).json({ success: false, error: 'Session not found' });
    if (preCheck.lessonBlock.studentGroup) {
      const policyResult = canPerformGroupAction(preCheck.lessonBlock.studentGroup as GroupShape, 'create:makeup');
      if (!policyResult.allowed) {
        return res.status(422).json({ success: false, error: policyResult.message, code: policyResult.code });
      }
    }

    const actor: LifecycleActor = {
      userId: req.user!.userId,
      role:   req.user!.role,
      schoolId,
    };

    const makeup = await createMakeupSession({
      originalSessionId: sessionId,
      schoolId,
      actor,
      newDate: new Date(`${date}T12:00:00.000Z`),
      reason,
    });

    res.json({ success: true, data: makeup });
  } catch (error: any) {
    sendLifecycleError(res, error, 'Failed to create makeup session');
  }
});

// ─── POST /sessions/bulk-cancel ───────────────────────────────────────────────
// PR 3: routed through lifecycle service — per-session audit, notifications,
//        socket emits. reason is now required (≥ 5 chars).

router.post('/sessions/bulk-cancel', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const { date, reason } = req.body;
    if (!date) return res.status(400).json({ success: false, error: 'date required' });

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    const reasonCheck = requireLifecycleReason('SESSION_CANCELLED', trimmedReason);
    if (!reasonCheck.valid) {
      return res.status(400).json({ success: false, error: reasonCheck.reason });
    }

    const sessionSchool = await prisma.school.findFirst({ where: { id: schoolId }, select: { timezone: true } });
    const tz = sessionSchool?.timezone ?? 'Asia/Bishkek';
    const { from: dayStart, to: dayEnd } = getDayBoundaries(date, tz);

    const sessions = await prisma.lessonSession.findMany({
      where: {
        schoolId,
        date: { gte: dayStart, lte: dayEnd },
        status: 'UPCOMING',
        deletedAt: null,
        OR: [
          { lessonBlock: { studentGroupId: null } },
          { lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } } },
        ],
      },
      select: { id: true },
    });

    if (sessions.length === 0) return res.json({ success: true, data: { cancelled: 0 } });

    const actor: LifecycleActor = {
      userId: req.user!.userId,
      role: req.user!.role,
      schoolId,
    };

    // Cancel each session through the lifecycle service — per-session audit + notifications.
    // Sequential loop is acceptable: correctness > concurrency, sessions per day are small.
    let cancelledCount = 0;
    const errors: { sessionId: number; error: string }[] = [];

    for (const sess of sessions) {
      try {
        await cancelSession({
          sessionId: sess.id,
          schoolId,
          actor,
          reason: trimmedReason,
        });
        cancelledCount++;
      } catch (err: any) {
        errors.push({ sessionId: sess.id, error: err.message ?? 'UNKNOWN' });
      }
    }

    log.info(
      { event: 'BULK_CANCEL', schoolId, date, cancelled: cancelledCount, errors: errors.length, userId: actor.userId },
      'Bulk cancel completed via lifecycle service',
    );

    res.json({ success: true, data: { cancelled: cancelledCount, errors } });
  } catch (error) {
    log.error({ err: error }, 'bulk cancel sessions error');
    res.status(500).json({ success: false, error: 'Failed to bulk cancel sessions' });
  }
});

// ─── POST /sessions/bulk-restore ──────────────────────────────────────────────
// Restores all CANCELLED sessions for a given date back to UPCOMING.
// Mirror of bulk-cancel — uses restoreSession() lifecycle service per session.

router.post('/sessions/bulk-restore', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const { date } = req.body;
    if (!date) return res.status(400).json({ success: false, error: 'date required' });

    const sessionSchool = await prisma.school.findFirst({ where: { id: schoolId }, select: { timezone: true } });
    const tz = sessionSchool?.timezone ?? 'Asia/Bishkek';
    const { from: dayStart, to: dayEnd } = getDayBoundaries(date, tz);

    const sessions = await prisma.lessonSession.findMany({
      where: {
        schoolId,
        date: { gte: dayStart, lte: dayEnd },
        status: 'CANCELLED',
        deletedAt: null,
      },
      select: { id: true },
    });

    if (sessions.length === 0) return res.json({ success: true, data: { restored: 0 } });

    const actor: LifecycleActor = {
      userId: req.user!.userId,
      role: req.user!.role,
      schoolId,
    };

    let restoredCount = 0;
    const errors: { sessionId: number; error: string }[] = [];

    for (const sess of sessions) {
      try {
        await restoreSession({ sessionId: sess.id, schoolId, actor });
        restoredCount++;
      } catch (err: any) {
        errors.push({ sessionId: sess.id, error: err.message ?? 'UNKNOWN' });
      }
    }

    log.info(
      { event: 'BULK_RESTORE', schoolId, date, restored: restoredCount, errors: errors.length, userId: actor.userId },
      'Bulk restore completed via lifecycle service',
    );

    res.json({ success: true, data: { restored: restoredCount, errors } });
  } catch (error) {
    log.error({ err: error }, 'bulk restore sessions error');
    res.status(500).json({ success: false, error: 'Failed to bulk restore sessions' });
  }
});

export default router;
