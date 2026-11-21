import { Router } from 'express';
import prisma from '../../lib/prisma';
import { authenticate, AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { attendanceLimiter } from '../../middleware/rateLimiters';
import { idempotency } from '../../middleware/idempotency';
import { emitToSchool } from '../../lib/socket';
import { cacheInvalidate } from '../../lib/cache';
import { sendLifecycleError } from '../../lib/routeError';
import {
  ensureSingleSession,
} from '../../services/sessionService';
import {
  AttendanceFinalizationError,
  reopenAttendance,
  submitAttendanceAndFinalize,
  updateAttendanceWhileEditable,
} from '../../services/attendanceFinalizationService';
import { canPerformGroupAction, GroupShape } from '../../lib/groupLifecyclePolicy';
import {
  log,
  assertTeacherOwnsSession,
} from './scheduleRouteUtils';

const router = Router();

// ─── POST /session/submit-attendance — сдать посещаемость для всей группы ─────

router.post('/session/submit-attendance', attendanceLimiter, authenticate, idempotency, requirePermission('attendance:write'), async (req: AuthRequest, res) => {
  let expectedActiveStudentIds: number[] | undefined;
  try {
    const { lessonBlockId, date, attendances } = req.body;
    if (!lessonBlockId || !date || !Array.isArray(attendances) || attendances.length === 0) {
      return res.status(400).json({ success: false, error: 'lessonBlockId, date и attendances[] обязательны' });
    }

    const schoolId = req.user!.schoolId!;
    const blockId = parseInt(lessonBlockId);

    const block = await prisma.lessonBlock.findFirst({
      where: { id: blockId, schoolId, deletedAt: null },
      select: {
        id: true,
        schoolId: true,
        days: true,
        startDate: true,
        endDate: true,
        teacherId: true,
        cabinetId: true,
        startTime: true,
        endTime: true,
        studentGroupId: true,
        studentGroup: { select: { status: true, deletedAt: true } },
        school: { select: { timezone: true } },
      },
    });
    if (!block) return res.status(404).json({ success: false, error: 'Блок не найден' });
    if (block.studentGroup) {
      const policyResult = canPerformGroupAction(block.studentGroup as GroupShape, 'submit:attendance');
      if (!policyResult.allowed) {
        return res.status(422).json({ success: false, error: policyResult.message, code: policyResult.code });
      }
    }

    if (block.studentGroupId) {
      const activeMembers = await prisma.groupMembership.findMany({
        where: { studentGroupId: block.studentGroupId, schoolId, leftAt: null },
        select: { studentProfileId: true },
      });
      expectedActiveStudentIds = activeMembers.map(m => m.studentProfileId);
    }

    const sessionResult = await ensureSingleSession(block, date);
    if ('error' in sessionResult) return res.status(400).json({ success: false, error: sessionResult.error });

    const sessionId = sessionResult.session.id;

    await assertTeacherOwnsSession(req, sessionId);

    const result = await submitAttendanceAndFinalize({
      sessionId,
      schoolId,
      actorId: req.user!.userId,
      attendances: attendances as { studentProfileId: number; status: string }[],
      expectedActiveStudentIds,
      tz: block.school?.timezone ?? 'Asia/Bishkek',
    });

    // Сбрасываем кэш календаря учителей за этот месяц. Fire-and-forget: the
    // response must not wait on a Redis SCAN — worst case the calendar cache
    // stays warm for its remaining TTL (120s).
    const sessionDate = sessionResult.session.date;
    const yr = sessionDate.getUTCFullYear();
    const mo = sessionDate.getUTCMonth() + 1;
    void cacheInvalidate(`teacher-cal:${schoolId}:*:${yr}:${mo}`).catch(() => {});

    emitToSchool(schoolId, 'attendance:updated', { sessionId });

    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof AttendanceFinalizationError) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.message,
        code: error.code,
        ...(error.meta ?? {}),
      });
    }
    log.error({ err: error }, 'submit-attendance error');
    sendLifecycleError(res, error, 'Failed to submit attendance');
  }
});

// ─── GET /session/:id/attendance ──────────────────────────────────────────────

router.get('/session/:id/attendance', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;

    // Verify session belongs to this school — prevents cross-tenant data leak
    const session = await prisma.lessonSession.findFirst({
      where: { id: sessionId, schoolId, deletedAt: null },
      select: { id: true },
    });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    await assertTeacherOwnsSession(req, sessionId);

    const attendances = await prisma.attendance.findMany({ where: { lessonSessionId: sessionId, schoolId } });

    const profileIds = attendances.map(a => a.studentProfileId);
    if (profileIds.length > 0) {
      const profiles = await prisma.studentProfile.findMany({
        where: { id: { in: profileIds }, deletedAt: null },
        include: { user: { select: { firstName: true, lastName: true } } },
      });
      return res.json({
        success: true,
        data: attendances.map(a => ({ ...a, studentProfile: profiles.find(p => p.id === a.studentProfileId) })),
      });
    }

    res.json({ success: true, data: attendances });
  } catch (error) {
    log.error({ err: error }, 'get session attendance error');
    sendLifecycleError(res, error, 'Failed to fetch attendance');
  }
});

// ─── PATCH /session/:id/attendance ───────────────────────────────────────────

router.patch('/session/:id/attendance', attendanceLimiter, authenticate, idempotency, requirePermission('attendance:write'), async (req: AuthRequest, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const { studentProfileId, status, version, reason } = req.body;
    const schoolId = req.user!.schoolId!;

    const session = await prisma.lessonSession.findFirst({
      where: { id: sessionId, schoolId, deletedAt: null },
      include: {
        lessonBlock: {
          select: { studentGroup: { select: { status: true, deletedAt: true } } },
        },
        school: { select: { timezone: true } },
      },
    });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (session.lessonBlock.studentGroup) {
      const policyResult = canPerformGroupAction(session.lessonBlock.studentGroup as GroupShape, 'submit:attendance');
      if (!policyResult.allowed) {
        return res.status(422).json({ success: false, error: policyResult.message, code: policyResult.code });
      }
    }

    if (version !== undefined && session.version !== version) {
      return res.status(409).json({ success: false, error: 'STALE_DATA' });
    }

    await assertTeacherOwnsSession(req, sessionId);

    const result = await updateAttendanceWhileEditable({
      sessionId,
      schoolId,
      actorId: req.user!.userId,
      studentProfileId,
      status,
      reason,
      version,
      tz: session.school?.timezone ?? 'Asia/Bishkek',
    });

    emitToSchool(schoolId, 'attendance:updated', {
      sessionId,
      studentProfileId,
      status,
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof AttendanceFinalizationError) {
      return res.status(error.httpStatus).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'Attendance update error');
    sendLifecycleError(res, error, 'Failed to update attendance and credits');
  }
});

router.post('/session/:id/attendance/reopen', attendanceLimiter, authenticate, idempotency, requirePermission('attendance:write'), async (req: AuthRequest, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;
    const { reason } = req.body;

    await assertTeacherOwnsSession(req, sessionId);

    const result = await reopenAttendance({
      sessionId,
      schoolId,
      actorId: req.user!.userId,
      reason,
    });

    emitToSchool(schoolId, 'attendance:updated', { sessionId });

    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof AttendanceFinalizationError) {
      return res.status(error.httpStatus).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'Attendance reopen error');
    sendLifecycleError(res, error, 'Failed to reopen attendance');
  }
});

export default router;
