import { AttendanceStatus, Prisma, SessionStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { isAttendanceAllowed } from '../lib/sessionStateMachine';
import { hasSessionStarted } from '../lib/tzUtils';
import { markAttendance } from './attendanceService';
import { findActiveFreezesForSession } from './freezeService';
import { recomputeAndPersistPaidUntil } from '../lib/paidUntilDerivation';

const VALID_ATTENDANCE_STATUSES = new Set<AttendanceStatus>([
  'PRESENT',
  'ABSENT',
  'LATE',
  'FROZEN',
]);

export class AttendanceFinalizationError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AttendanceFinalizationError';
  }
}

export function attendanceStateFor(
  session: {
    status: SessionStatus;
    attendanceFinalizedAt: Date | null;
    date?: Date | null;
    startTime?: string | null;
  },
  tz?: string,
) {
  const hasStarted = tz != null && session.date != null && session.startTime != null
    && hasSessionStarted(session.date, session.startTime, tz);
  const statusAllowsAttendance = isAttendanceAllowed(session.status, { hasStarted });
  return {
    canEditAttendance: statusAllowsAttendance && session.attendanceFinalizedAt == null,
    canReopenAttendance: statusAllowsAttendance && session.attendanceFinalizedAt != null,
  };
}

function normalizeReason(reason: unknown): string {
  return typeof reason === 'string' ? reason.trim() : '';
}

function parseAttendanceStatus(status: unknown): AttendanceStatus {
  if (typeof status !== 'string' || !VALID_ATTENDANCE_STATUSES.has(status as AttendanceStatus)) {
    throw new AttendanceFinalizationError(400, 'INVALID_ATTENDANCE_STATUS', 'Invalid attendance status');
  }
  return status as AttendanceStatus;
}

async function lockSession(tx: Prisma.TransactionClient, sessionId: number, schoolId: number) {
  await tx.$executeRaw`SELECT id FROM "LessonSession" WHERE id = ${sessionId} AND "schoolId" = ${schoolId} FOR UPDATE`;
}

async function ensureSessionStudent(
  tx: Prisma.TransactionClient,
  params: { schoolId: number; sessionId: number; studentProfileId: number },
) {
  const existing = await tx.sessionStudent.findUnique({
    where: {
      lessonSessionId_studentProfileId: {
        lessonSessionId: params.sessionId,
        studentProfileId: params.studentProfileId,
      },
    },
    select: { id: true },
  });
  if (existing) return existing;

  return tx.sessionStudent.create({
    data: {
      schoolId: params.schoolId,
      lessonSessionId: params.sessionId,
      studentProfileId: params.studentProfileId,
    },
    select: { id: true },
  });
}

export async function submitAttendanceAndFinalize(params: {
  sessionId: number;
  schoolId: number;
  actorId: number;
  attendances: { studentProfileId: number; status: unknown }[];
  expectedActiveStudentIds?: number[];
  tz?: string;
}) {
  if (params.expectedActiveStudentIds && params.expectedActiveStudentIds.length > 0) {
    const submittedIds = new Set(params.attendances.map(a => Number(a.studentProfileId)));
    const missingCount = params.expectedActiveStudentIds.filter(id => !submittedIds.has(id)).length;
    if (missingCount > 0) {
      throw new AttendanceFinalizationError(
        400,
        'ATTENDANCE_INCOMPLETE',
        'Отметьте всех студентов перед сдачей посещаемости.',
        { missingCount },
      );
    }
  }

  // Validate the payload up front (same errors the old per-entry checks threw).
  // Duplicate ids collapse to the LAST occurrence — identical to the final state
  // the old sequential loop produced (last write won, single deduction).
  const entryById = new Map<number, { studentProfileId: number; status: AttendanceStatus }>();
  for (const entry of params.attendances) {
    const studentProfileId = Number(entry.studentProfileId);
    if (!Number.isInteger(studentProfileId)) {
      throw new AttendanceFinalizationError(400, 'INVALID_STUDENT_PROFILE_ID', 'Invalid studentProfileId');
    }
    entryById.set(studentProfileId, { studentProfileId, status: parseAttendanceStatus(entry.status) });
  }
  const entries = [...entryById.values()];
  const studentIds = entries.map(e => e.studentProfileId);

  return prisma.$transaction(async (tx) => {
    await lockSession(tx, params.sessionId, params.schoolId);

    const session = await tx.lessonSession.findFirst({
      where: { id: params.sessionId, schoolId: params.schoolId, deletedAt: null },
      select: {
        id: true,
        schoolId: true,
        date: true,
        status: true,
        attendanceFinalizedAt: true,
        startTimeSnap: true,
        lessonBlock: { select: { startTime: true, studentGroup: { select: { status: true, deletedAt: true } } } },
      },
    });
    if (!session) {
      throw new AttendanceFinalizationError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }
    const effectiveStartTime = session.startTimeSnap ?? session.lessonBlock?.startTime;
    const hasStarted = params.tz != null && effectiveStartTime != null
      && hasSessionStarted(session.date, effectiveStartTime, params.tz);
    if (!isAttendanceAllowed(session.status, { hasStarted })) {
      throw new AttendanceFinalizationError(
        400,
        'SESSION_NOT_SUBMITTABLE',
        `Cannot submit attendance for session status ${session.status}`,
      );
    }
    if (session.attendanceFinalizedAt) {
      throw new AttendanceFinalizationError(409, 'ATTENDANCE_FINALIZED', 'Attendance is finalized');
    }

    // ── Batched reads (the old loop ran ~10 queries per student; these run once) ──

    // One FOR UPDATE lock for every submitted student, in deterministic id order
    // (the old code locked one-by-one in payload order, twice per student).
    // Serializes with freeze creation exactly like the per-student locks did,
    // and doubles as the existence check the old profile read performed.
    const lockedRows = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM "StudentProfile" WHERE id IN (${Prisma.join(studentIds)}) ORDER BY id FOR UPDATE`;
    if (lockedRows.length !== studentIds.length) {
      throw new Error('STUDENT_NOT_FOUND');
    }

    const existingAttendances = await tx.attendance.findMany({
      where: { lessonSessionId: session.id, studentProfileId: { in: studentIds } },
    });
    const existingByStudent = new Map(existingAttendances.map(a => [a.studentProfileId, a]));

    const sessionStudents = await tx.sessionStudent.findMany({
      where: { lessonSessionId: session.id, studentProfileId: { in: studentIds } },
      select: { id: true, studentProfileId: true },
    });
    const ssByStudent = new Map(sessionStudents.map(s => [s.studentProfileId, s.id]));
    const missingSS = studentIds.filter(id => !ssByStudent.has(id));
    if (missingSS.length > 0) {
      await tx.sessionStudent.createMany({
        data: missingSS.map(studentProfileId => ({
          schoolId: params.schoolId,
          lessonSessionId: session.id,
          studentProfileId,
        })),
        skipDuplicates: true,
      });
      const created = await tx.sessionStudent.findMany({
        where: { lessonSessionId: session.id, studentProfileId: { in: missingSS } },
        select: { id: true, studentProfileId: true },
      });
      for (const s of created) ssByStudent.set(s.studentProfileId, s.id);
    }

    const config = await tx.schoolFinanceConfig.findUnique({
      where: { schoolId: params.schoolId },
      select: { pricePerLesson: true },
    });

    // Freezes only matter for students whose deduction hasn't been claimed yet
    const deductIds = entries
      .filter(e => !existingByStudent.get(e.studentProfileId)?.creditDeducted)
      .map(e => e.studentProfileId);
    const freezeByStudent = await findActiveFreezesForSession(
      { studentProfileIds: deductIds, sessionId: session.id, sessionDate: session.date, schoolId: params.schoolId },
      tx,
    );

    const preSession = {
      status: session.status,
      startTimeSnap: session.startTimeSnap,
      lessonBlock: session.lessonBlock,
    };

    let saved = 0;
    const auditRows: Prisma.AttendanceAuditCreateManyInput[] = [];
    for (const { studentProfileId, status } of entries) {
      const sessionStudentId = ssByStudent.get(studentProfileId);
      if (sessionStudentId == null) throw new Error('SESSION_STUDENT_NOT_FOUND');
      const previous = existingByStudent.get(studentProfileId) ?? null;

      const attendance = await markAttendance(tx, {
        sessionId: session.id,
        studentProfileId,
        status,
        schoolId: params.schoolId,
        sessionStudentId,
        sessionDate: session.date,
        submittedById: params.actorId,
        tz: params.tz,
        pre: {
          session: preSession,
          existing: previous,
          pricePerLesson: config?.pricePerLesson ?? null,
          freeze: freezeByStudent.get(studentProfileId) ?? null,
        },
      });

      if (!previous) {
        auditRows.push({
          schoolId: params.schoolId,
          lessonSessionId: session.id,
          studentProfileId,
          attendanceId: attendance.id,
          oldStatus: null,
          newStatus: attendance.status,
          actorId: params.actorId,
          action: 'CREATE',
        });
      } else if (previous.status !== attendance.status) {
        auditRows.push({
          schoolId: params.schoolId,
          lessonSessionId: session.id,
          studentProfileId,
          attendanceId: attendance.id,
          oldStatus: previous.status,
          newStatus: attendance.status,
          actorId: params.actorId,
          action: 'UPDATE',
        });
      }

      saved += 1;
    }

    if (auditRows.length > 0) {
      await tx.attendanceAudit.createMany({ data: auditRows });
    }

    // UPCOMING sessions have no manual "Идёт сейчас" step behind them — this submit
    // is the only signal that the lesson happened. Surface that explicitly in the
    // audit trail rather than silently mutating status alongside FINALIZE.
    const autoCompletedFromUpcoming = session.status === 'UPCOMING';

    const finalizedAt = new Date();
    const updatedSession = await tx.lessonSession.update({
      where: { id: session.id },
      data: {
        attendanceFinalizedAt: finalizedAt,
        attendanceFinalizedById: params.actorId,
        ...(session.status !== 'COMPLETED' && {
          status: 'COMPLETED',
          version: { increment: 1 },
        }),
      },
      select: {
        id: true,
        status: true,
        attendanceFinalizedAt: true,
        attendanceFinalizedById: true,
        attendanceReopenedAt: true,
        attendanceReopenReason: true,
      },
    });

    await tx.attendanceAudit.create({
      data: {
        schoolId: params.schoolId,
        lessonSessionId: session.id,
        actorId: params.actorId,
        action: 'FINALIZE',
        reason: autoCompletedFromUpcoming
          ? 'Auto-completed session (was UPCOMING) during attendance submission'
          : null,
      },
    });

    // Refresh the derived paidUntil for every student whose balance just changed —
    // deductions here regularly drive credits negative, so the display date must
    // follow (recomputeAndPersistPaidUntil is the single writer of paidUntil).
    for (const studentProfileId of studentIds) {
      await recomputeAndPersistPaidUntil(tx, studentProfileId, params.schoolId);
    }

    // Post-deduction balances so the client can reflect the new credit count
    // (which may now be negative) without a full schedule reload.
    const balances = await tx.studentProfile.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, credits: true, paidUntil: true },
    });

    return {
      saved,
      errors: [] as { studentProfileId: number; error: string }[],
      sessionId: session.id,
      balances: balances.map((b) => ({ studentProfileId: b.id, credits: b.credits, paidUntil: b.paidUntil })),
      ...updatedSession,
      ...attendanceStateFor(updatedSession),
    };
  });
}

export async function updateAttendanceWhileEditable(params: {
  sessionId: number;
  schoolId: number;
  actorId: number;
  studentProfileId: number;
  status: unknown;
  reason?: unknown;
  version?: number;
  tz?: string;
}) {
  return prisma.$transaction(async (tx) => {
    await lockSession(tx, params.sessionId, params.schoolId);

    const session = await tx.lessonSession.findFirst({
      where: { id: params.sessionId, schoolId: params.schoolId, deletedAt: null },
      include: {
        lessonBlock: {
          select: { studentGroup: { select: { status: true, deletedAt: true } } },
        },
      },
    });
    if (!session) {
      throw new AttendanceFinalizationError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }
    if (params.version !== undefined && session.version !== params.version) {
      throw new AttendanceFinalizationError(409, 'STALE_DATA', 'STALE_DATA');
    }
    if (session.attendanceFinalizedAt) {
      throw new AttendanceFinalizationError(409, 'ATTENDANCE_FINALIZED', 'Attendance is finalized');
    }

    const status = parseAttendanceStatus(params.status);
    const reason = normalizeReason(params.reason) || null;

    await tx.$executeRaw`SELECT id FROM "StudentProfile" WHERE id = ${params.studentProfileId} FOR UPDATE`;

    const previous = await tx.attendance.findFirst({
      where: { lessonSessionId: session.id, studentProfileId: params.studentProfileId },
      select: { id: true, status: true },
    });

    const sessionStudent = await ensureSessionStudent(tx, {
      schoolId: params.schoolId,
      sessionId: session.id,
      studentProfileId: params.studentProfileId,
    });

    const attendance = await markAttendance(tx, {
      sessionId: session.id,
      studentProfileId: params.studentProfileId,
      status,
      schoolId: params.schoolId,
      sessionStudentId: sessionStudent.id,
      sessionDate: session.date,
      submittedById: params.actorId,
      tz: params.tz,
    });

    await tx.attendanceAudit.create({
      data: {
        schoolId: params.schoolId,
        lessonSessionId: session.id,
        studentProfileId: params.studentProfileId,
        attendanceId: attendance.id,
        oldStatus: previous?.status ?? null,
        newStatus: attendance.status,
        actorId: params.actorId,
        reason,
        action: previous ? 'UPDATE' : 'CREATE',
      },
    });

    // A correction may deduct/skip a credit — keep the derived paidUntil in sync.
    await recomputeAndPersistPaidUntil(tx, params.studentProfileId, params.schoolId);

    // Post-correction balance so the client can reflect the new credit count live.
    const profile = await tx.studentProfile.findUnique({
      where: { id: params.studentProfileId },
      select: { credits: true, paidUntil: true },
    });

    return { ...attendance, credits: profile?.credits ?? null, paidUntil: profile?.paidUntil ?? null };
  });
}

export async function reopenAttendance(params: {
  sessionId: number;
  schoolId: number;
  actorId: number;
  reason: unknown;
}) {
  const reason = normalizeReason(params.reason) || null;

  return prisma.$transaction(async (tx) => {
    await lockSession(tx, params.sessionId, params.schoolId);

    const session = await tx.lessonSession.findFirst({
      where: { id: params.sessionId, schoolId: params.schoolId, deletedAt: null },
      select: { id: true, attendanceFinalizedAt: true },
    });
    if (!session) {
      throw new AttendanceFinalizationError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }
    if (!session.attendanceFinalizedAt) {
      throw new AttendanceFinalizationError(409, 'ATTENDANCE_NOT_FINALIZED', 'Attendance is not finalized');
    }

    const reopenedAt = new Date();
    const updatedSession = await tx.lessonSession.update({
      where: { id: session.id },
      data: {
        attendanceFinalizedAt: null,
        attendanceFinalizedById: null,
        attendanceReopenedAt: reopenedAt,
        attendanceReopenedById: params.actorId,
        attendanceReopenReason: reason,
      },
      select: {
        id: true,
        status: true,
        attendanceFinalizedAt: true,
        attendanceFinalizedById: true,
        attendanceReopenedAt: true,
        attendanceReopenedById: true,
        attendanceReopenReason: true,
      },
    });

    await tx.attendanceAudit.create({
      data: {
        schoolId: params.schoolId,
        lessonSessionId: session.id,
        actorId: params.actorId,
        reason,
        action: 'REOPEN',
      },
    });

    return {
      ...updatedSession,
      ...attendanceStateFor(updatedSession),
    };
  });
}
