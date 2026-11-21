import { Role } from '@prisma/client';
import prisma from '../../lib/prisma';
import { emitToSchool } from '../../lib/socket';
import * as notificationService from '../../services/notificationService';
import { canPerformGroupAction, GroupShape } from '../../lib/groupLifecyclePolicy';
import { findStudentScheduleConflicts } from '../../services/scheduleValidation';
import { generatePolicySlotDefs, getPolicyForDate } from '../../services/policyService';
import { getEffectiveSessionTeacherId } from '../../services/sessionService';
import { createLogger } from '../../lib/logger';

export const log = createLogger('schedule');

// Legacy error message constants kept for inline uses below.
// Source of truth for policy decisions is groupLifecyclePolicy.ts.
export const PAUSED_GROUP_OPERATION_ERROR = 'Group is paused. Resume it before performing this action.';
export const GROUP_HAS_ARCHIVED_HISTORY_CODE = 'GROUP_HAS_ARCHIVED_HISTORY';
export const GROUP_HAS_ARCHIVED_HISTORY_MESSAGE =
  'У этой группы уже есть архивное расписание и посещаемость за этот период. Создание нового блока начнёт новую историю. Используйте редактирование существующего расписания или подтвердите создание новой истории.';

export function isAdminOrOwner(role: Role): boolean {
  return role === Role.OWNER || role === Role.ADMIN;
}

export class TeacherOwnershipError extends Error {
  httpStatus: number;
  constructor(message: string, httpStatus = 403) {
    super(message);
    this.name = 'TeacherOwnershipError';
    this.httpStatus = httpStatus;
  }
}

/**
 * Restricts TEACHER-role actors to sessions where they are the effective
 * teacher (owner, or an active substitute per getEffectiveSessionTeacherId) —
 * "TEACHER: assigned sessions only" per CLAUDE.md's role matrix. No-op for
 * OWNER/ADMIN/SUPERADMIN, who may act on any session in their school.
 * Throws TeacherOwnershipError (handled by sendLifecycleError via httpStatus)
 * rather than returning a result object — a `{ok:true}|{ok:false,...}` return
 * type fails to narrow under tsconfig.test.json's strict:false, which ts-jest
 * uses for every route file pulled in by an integration test.
 */
export async function assertTeacherOwnsSession(
  req: { user?: { userId: number; role: Role } },
  sessionId: number,
): Promise<void> {
  if (req.user?.role !== Role.TEACHER) return;

  const [staff, session] = await Promise.all([
    prisma.staffProfile.findUnique({ where: { userId: req.user.userId }, select: { id: true } }),
    prisma.lessonSession.findUnique({
      where: { id: sessionId },
      select: { teacherId: true, teacherIdSnap: true, isManualTeacher: true, lessonBlock: { select: { teacherId: true } } },
    }),
  ]);
  if (!staff || !session) throw new TeacherOwnershipError('Session not found', 404);

  const effectiveTeacherId = getEffectiveSessionTeacherId(session) ?? session.lessonBlock.teacherId;
  if (effectiveTeacherId !== staff.id) {
    throw new TeacherOwnershipError('Эта сессия не назначена вам', 403);
  }
}

export function parseScheduleDateInput(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const datePart = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const parsed = new Date(`${datePart}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function dateStr(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function previousUtcDate(date: Date): Date {
  return new Date(date.getTime() - DAY_MS);
}

export function isSessionInsideBlockVersion(session: { date: Date }, block: { startDate: Date | string | null; endDate: Date | string | null }) {
  const sessionDate = dateStr(session.date);
  const blockStart = dateStr(block.startDate);
  const blockEnd = dateStr(block.endDate);
  if (!sessionDate || !blockStart) return false;
  if (sessionDate < blockStart) return false;
  if (blockEnd && sessionDate > blockEnd) return false;
  return true;
}

export function isBlockActiveOnDate(block: { startDate: Date | string | null; endDate: Date | string | null }, targetDate: Date) {
  const target = dateStr(targetDate);
  const blockStart = dateStr(block.startDate);
  const blockEnd = dateStr(block.endDate);
  if (!target || !blockStart) return false;
  if (target < blockStart) return false;
  if (blockEnd && target > blockEnd) return false;
  return true;
}

export function filterCanonicalVersionsForDate<T extends {
  id: number;
  studentGroupId: number | null;
  type: string;
  startDate: Date | string | null;
  endDate: Date | string | null;
}>(blocks: T[], targetDate: Date): T[] {
  const canonical = new Map<string, T>();
  const passthrough: T[] = [];
  for (const block of blocks) {
    if (!block.studentGroupId || !isBlockActiveOnDate(block, targetDate)) {
      passthrough.push(block);
      continue;
    }
    const key = `${block.studentGroupId}:${block.type}`;
    const existing = canonical.get(key);
    if (!existing) {
      canonical.set(key, block);
      continue;
    }
    const existingStart = dateStr(existing.startDate) ?? '';
    const blockStart = dateStr(block.startDate) ?? '';
    if (blockStart > existingStart || (blockStart === existingStart && block.id > existing.id)) {
      canonical.set(key, block);
    }
  }
  return [...passthrough, ...canonical.values()].sort((a, b) => a.id - b.id);
}

export function utcWeekRangeFor(date: Date): { from: Date; to: Date } {
  const day = date.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  const from = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - daysFromMonday,
  ));
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 7);
  return { from, to };
}

export async function notifyTeacherAssigned(schoolId: number, blockId: number, teacherStaffProfileId: number | null): Promise<void> {
  if (!teacherStaffProfileId) return;

  try {
    const block = await prisma.lessonBlock.findUnique({
      where: { id: blockId },
      include: {
        studentGroup: true,
        teacher: { select: { userId: true } },
        school: { select: { slug: true } },
      },
    });

    if (!block || !block.teacher || !block.studentGroup) return;

    const teacherUserId = block.teacher.userId;
    const groupName = block.studentGroup.level;
    const schoolSlug = block.school.slug;

    await notificationService.createForUser({
      userId: teacherUserId,
      schoolId,
      type: 'TEACHER_ASSIGNED_TO_GROUP',
      title: 'Назначена новая группа',
      body: `Вы назначены преподавателем в группу "${groupName}".`,
      category: 'SCHEDULE',
      priority: 'NORMAL',
      actionUrl: `/${schoolSlug}/teacher/schedule`,
      entityType: 'StudentGroup',
      entityId: block.studentGroup.id,
      data: {
        groupId: block.studentGroup.id,
        groupName,
        blockId: block.id,
      },
    });
  } catch (error) {
    log.error({ err: error, blockId, teacherStaffProfileId }, 'Failed to send teacher assignment notification');
  }
}

/**
 * Returns true when the group is not operationally active (PAUSED, COMPLETED, or ARCHIVED).
 * Delegates to the canonical lifecycle policy — 'edit:schedule' is the proxy action
 * since it requires ACTIVE status.
 */
export function isInactiveGroup(group?: { status?: string; deletedAt?: Date | null } | null): boolean {
  if (!group) return false;
  const result = canPerformGroupAction(
    { status: (group.status ?? 'ACTIVE') as GroupShape['status'], deletedAt: group.deletedAt ?? null },
    'edit:schedule',
  );
  return !result.allowed;
}

/**
 * Grammar/Club pairs are owned exclusively by the group-pair endpoints once active.
 * "Active" mirrors the definition used by DELETE /group-pair: studentGroupId set,
 * not archived, and not a closed historical version (endDate === null).
 */
export function isActiveGroupOwnedBlock(block: { studentGroupId: number | null; endDate: Date | null; deletedAt?: Date | null }): boolean {
  return Boolean(block.studentGroupId) && block.endDate === null && !block.deletedAt;
}

export function emitScheduleStructureChanged(schoolId: number, action: string, extra: Record<string, unknown> = {}) {
  emitToSchool(schoolId, 'schedule:structure-changed', { action, ...extra });
}

export function emitScheduleSessionChanged(
  schoolId: number,
  payload: { sessionId: number; lessonBlockId?: number | null; date?: Date | string | null; action: string },
) {
  emitToSchool(schoolId, 'schedule:session-changed', payload);
}

export type TimeSlotErrorCode =
  | 'TIME_SLOT_NOT_FOUND'
  | 'TIME_SLOT_NOT_WRITABLE'
  | 'TIME_SLOT_SCHOOL_MISMATCH'
  | 'TIME_SLOT_TIME_MISMATCH'
  | 'HISTORICAL_POLICY_READ_ONLY';

export type WritableTimeSlotResolution =
  | {
      ok: true;
      slot: { id: number; schoolId: number; startTime: string; endTime: string; order: number };
    }
  | {
      ok: false;
      status: number;
      code: TimeSlotErrorCode;
      error: string;
    };

export function parseOptionalIntStrict(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeScheduleDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((d) => parseInt(String(d), 10))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)));
}

export function normalizeClock(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function parseTargetDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.length === 10 ? `${value}T12:00:00.000Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isHistoricalTargetDate(value: unknown): boolean {
  const date = parseTargetDate(value);
  if (!date) return false;
  const now = new Date();
  const daysFromMonday = now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1;
  const startOfCurrentWeekMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysFromMonday,
  );
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) < startOfCurrentWeekMs;
}

export function timeSlotError(status: number, code: TimeSlotErrorCode, error: string): WritableTimeSlotResolution {
  return { ok: false, status, code, error };
}

export async function resolvePolicySlotForTime(
  schoolId: number,
  startTime: string,
  endTime: string,
  targetDate: unknown,
) {
  const policyDate = parseTargetDate(targetDate) ?? new Date();
  const policy = await getPolicyForDate(schoolId, policyDate);
  const generatedSlots = generatePolicySlotDefs(policy);
  const found = generatedSlots.find((slot) => slot.startTime === startTime && slot.endTime === endTime);
  return found ?? null;
}

export async function resolveWritableTimeSlot({
  schoolId,
  timeSlotId,
  startTime,
  endTime,
  targetDate,
  allowHistoricalWrite = false,
}: {
  schoolId: number;
  timeSlotId?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  targetDate?: unknown;
  allowHistoricalWrite?: boolean;
}): Promise<WritableTimeSlotResolution> {
  if (!allowHistoricalWrite && isHistoricalTargetDate(targetDate)) {
    return timeSlotError(409, 'HISTORICAL_POLICY_READ_ONLY', 'Историческая сетка доступна только для просмотра');
  }

  const parsedTimeSlotId = parseOptionalIntStrict(timeSlotId);
  const normalizedStart = normalizeClock(startTime);
  const normalizedEnd = normalizeClock(endTime);
  const hasTimeRange = Boolean(normalizedStart && normalizedEnd);

  if (parsedTimeSlotId && parsedTimeSlotId > 0) {
    const slotById = await prisma.timeSlot.findUnique({
      where: { id: parsedTimeSlotId },
      select: { id: true, schoolId: true, startTime: true, endTime: true, order: true },
    });

    if (slotById) {
      if (slotById.schoolId !== schoolId) {
        return timeSlotError(403, 'TIME_SLOT_SCHOOL_MISMATCH', 'Временной слот принадлежит другой школе');
      }
      if (
        hasTimeRange
        && (slotById.startTime !== normalizedStart || slotById.endTime !== normalizedEnd)
      ) {
        return timeSlotError(409, 'TIME_SLOT_TIME_MISMATCH', 'Временной слот не совпадает с выбранным временем');
      }
      const effectiveStart = normalizedStart ?? slotById.startTime;
      const effectiveEnd = normalizedEnd ?? slotById.endTime;
      const policySlot = await resolvePolicySlotForTime(schoolId, effectiveStart, effectiveEnd, targetDate);
      if (!policySlot) {
        return timeSlotError(404, 'TIME_SLOT_NOT_FOUND', 'Временной слот не найден в действующей политике расписания');
      }
      return { ok: true, slot: slotById };
    }
  } else if (timeSlotId !== undefined && timeSlotId !== null && timeSlotId !== '') {
    // Synthetic/negative client IDs are allowed only as hints; never as DB identity.
    if (!hasTimeRange) {
      return timeSlotError(400, 'TIME_SLOT_NOT_WRITABLE', 'Временной слот не может быть сохранён без времени начала и окончания');
    }
  }

  if (hasTimeRange) {
    const policySlot = await resolvePolicySlotForTime(schoolId, normalizedStart!, normalizedEnd!, targetDate);
    if (!policySlot) {
      return timeSlotError(404, 'TIME_SLOT_NOT_FOUND', 'Временной слот не найден в действующей политике расписания');
    }

    const slotByTime = await prisma.timeSlot.upsert({
      where: {
        schoolId_startTime_endTime: {
          schoolId,
          startTime: normalizedStart!,
          endTime: normalizedEnd!,
        },
      },
      update: { order: policySlot.order },
      create: {
        schoolId,
        startTime: normalizedStart!,
        endTime: normalizedEnd!,
        order: policySlot.order,
      },
      select: { id: true, schoolId: true, startTime: true, endTime: true, order: true },
    });
    if (slotByTime) return { ok: true, slot: slotByTime };
  }

  return timeSlotError(404, 'TIME_SLOT_NOT_FOUND', 'Временной слот не найден');
}

export function sendTimeSlotError(res: any, resolution: Extract<WritableTimeSlotResolution, { ok: false }>) {
  return res.status(resolution.status).json({
    success: false,
    error: resolution.error,
    code: resolution.code,
  });
}

export type SupersededSessionPlan = { blockId: number; fromDate: Date };

export async function findProtectedFutureSessionsForSplit(
  client: any,
  schoolId: number,
  plans: SupersededSessionPlan[],
) {
  if (plans.length === 0) return [];
  const found: any[] = [];
  for (const plan of plans) {
    const sessions = await client.lessonSession.findMany({
      where: {
        schoolId,
        lessonBlockId: plan.blockId,
        date: { gte: plan.fromDate },
        deletedAt: null,
        status: { not: 'INVALIDATED' },
        OR: [
          { status: { not: 'UPCOMING' } },
          { attendances: { some: {} } },
          { creditLogs: { some: {} } },
          { teacherPaymentLesson: { isNot: null } },
        ],
      },
      select: {
        id: true,
        lessonBlockId: true,
        date: true,
        status: true,
        _count: { select: { attendances: true, creditLogs: true } },
        teacherPaymentLesson: { select: { id: true } },
      },
      orderBy: { date: 'asc' },
      take: Math.max(0, 10 - found.length),
    });
    found.push(...sessions);
    if (found.length >= 10) break;
  }
  return found.sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, 10);
}

export async function invalidateSupersededFutureSessions(
  client: any,
  schoolId: number,
  plans: SupersededSessionPlan[],
) {
  let count = 0;
  for (const plan of plans) {
    const updated = await client.lessonSession.updateMany({
      where: {
        schoolId,
        lessonBlockId: plan.blockId,
        date: { gte: plan.fromDate },
        deletedAt: null,
        status: 'UPCOMING',
        attendances: { none: {} },
        creditLogs: { none: {} },
        teacherPaymentLesson: { is: null },
      },
      data: { status: 'INVALIDATED', version: { increment: 1 } },
    });
    count += updated.count;
  }
  return { count };
}

export function mapTeacher(obj: any) {
  if (!obj) return obj;
  const newObj = { ...obj };

  if (newObj.teacher) {
    newObj.teacherId = newObj.teacher.userId;
    newObj.teacher = {
      id: newObj.teacher.userId,
      firstName: newObj.teacher.user.firstName,
      lastName: newObj.teacher.user.lastName,
    };
  }

  if (newObj.sessions && Array.isArray(newObj.sessions)) {
    newObj.sessions = newObj.sessions.map((s: any) => mapTeacher(s));
  }

  if (newObj.studentGroup) {
    newObj.level = newObj.studentGroup.level;
    newObj.chapter = newObj.studentGroup.chapter;
  }

  return newObj;
}

// Distinct from scheduleValidation.ts's checkStudentScheduleConflicts (which throws) —
// this one maps conflicts to a plain array for route handlers that report them in a 400 response.
export async function mapStudentScheduleConflicts(
  studentProfileIds: number[],
  targetBlock: { id: number; studentGroupId?: number | null; days: number[]; startTime: string; endTime: string; startDate: Date | null; endDate: Date | null }
) {
  const conflicts = await findStudentScheduleConflicts(prisma, studentProfileIds, {
    days: targetBlock.days,
    startTime: targetBlock.startTime,
    endTime: targetBlock.endTime,
    startDate: targetBlock.startDate,
    endDate: targetBlock.endDate,
    ignoreGroupId: targetBlock.studentGroupId ?? undefined,
  });

  return conflicts.map(c => ({
    studentName: c.studentName,
    conflictLevel: c.conflictLevel,
    conflictDays: c.conflictingDays,
  }));
}
