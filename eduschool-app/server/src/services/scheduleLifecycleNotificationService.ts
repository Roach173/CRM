/**
 * SCHEDULE LIFECYCLE NOTIFICATION SERVICE
 * PR 5: Centralized, typed notification dispatch for lifecycle events.
 *
 * Design rules:
 *   - All exported functions are best-effort: callers MUST wrap in try-catch.
 *   - Failures must NOT rollback the main lifecycle mutation.
 *   - Each function owns the notification contract for its event.
 *   - No DB mutations here — only notification creation via notify.ts.
 *
 * TODO PR 7: Integrate parent visibility projection (filter INVALIDATED from student view).
 * TODO PR 5+: FCM push notifications when mobile app exists.
 */

import type { PrismaClient } from '@prisma/client';
import { notify, notifyMany, notifySchoolAdmins } from '../lib/notify';

// ─── Shared slot type ─────────────────────────────────────────────────────────

export interface TimeSlot {
  startTime: string;
  endTime:   string;
  cabinetId?: number | null;
}

// ─── SESSION_CANCELLED ────────────────────────────────────────────────────────

export interface SessionCancelledNotificationParams {
  sessionId:      number;
  lessonBlockId:  number;
  sessionDate:    Date;
  blockLevel:     string;
  reason?:        string;
  studentUserIds: number[];
  teacherUserId?: number;
}

/**
 * Notifies students and the assigned teacher that a session was cancelled.
 *
 * LIFECYCLE_SIDE_EFFECTS.SESSION_CANCELLED:
 *   notifyParents: true  — students/parents notified
 *   notifyTeacher: true  — teacher notified (PR 5: was false, now true)
 */
export async function dispatchSessionCancelledNotifications(
  params: SessionCancelledNotificationParams,
): Promise<void> {
  const dateStr = params.sessionDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  if (params.studentUserIds.length > 0) {
    await notifyMany(params.studentUserIds, {
      type:  'LESSON_CANCELLED',
      title: 'Урок отменён',
      body:  `Занятие ${params.blockLevel} ${dateStr} отменено`,
      data:  {
        sessionId:     params.sessionId,
        lessonBlockId: params.lessonBlockId,
        ...(params.reason ? { reason: params.reason } : {}),
      },
    });
  }

  if (params.teacherUserId) {
    await notify({
      userId: params.teacherUserId,
      type:   'LESSON_CANCELLED_FOR_TEACHER',
      title:  'Ваш урок отменён',
      body:   `Занятие ${params.blockLevel} ${dateStr} было отменено`,
      data:   {
        sessionId:     params.sessionId,
        lessonBlockId: params.lessonBlockId,
        ...(params.reason ? { reason: params.reason } : {}),
      },
    });
  }
}

// ─── SESSION_RESCHEDULED ──────────────────────────────────────────────────────

export interface RescheduleNotificationParams {
  sessionId:      number;
  lessonBlockId:  number;
  sessionDate:    Date;
  blockLevel:     string;
  oldSlot:        TimeSlot;
  newSlot:        TimeSlot;
  reason:         string;
  studentUserIds: number[];
  teacherUserId?: number;
}

/**
 * Notifies students and teacher about a time/room change.
 *
 * LIFECYCLE_SIDE_EFFECTS.SESSION_RESCHEDULED:
 *   notifyParents: true
 *   notifyTeacher: true
 */
export async function dispatchRescheduleNotifications(
  params: RescheduleNotificationParams,
): Promise<void> {
  const dateStr = params.sessionDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const oldTime = `${params.oldSlot.startTime}–${params.oldSlot.endTime}`;
  const newTime = `${params.newSlot.startTime}–${params.newSlot.endTime}`;

  if (params.studentUserIds.length > 0) {
    await notifyMany(params.studentUserIds, {
      type:  'SESSION_RESCHEDULED',
      title: 'Время урока изменено',
      body:  `Занятие ${params.blockLevel} ${dateStr}: время изменено с ${oldTime} на ${newTime}`,
      data:  {
        sessionId:    params.sessionId,
        lessonBlockId: params.lessonBlockId,
        oldStartTime: params.oldSlot.startTime,
        oldEndTime:   params.oldSlot.endTime,
        newStartTime: params.newSlot.startTime,
        newEndTime:   params.newSlot.endTime,
        reason:       params.reason,
      },
    });
  }

  if (params.teacherUserId) {
    await notify({
      userId: params.teacherUserId,
      type:   'SESSION_RESCHEDULED_FOR_TEACHER',
      title:  'Время урока изменено',
      body:   `Занятие ${params.blockLevel} ${dateStr}: время изменено с ${oldTime} на ${newTime}`,
      data:   {
        sessionId:    params.sessionId,
        lessonBlockId: params.lessonBlockId,
        oldStartTime: params.oldSlot.startTime,
        oldEndTime:   params.oldSlot.endTime,
        newStartTime: params.newSlot.startTime,
        newEndTime:   params.newSlot.endTime,
        reason:       params.reason,
      },
    });
  }
}

// ─── TEACHER_REPLACED ─────────────────────────────────────────────────────────

export interface TeacherReplacedNotificationParams {
  sessionId:       number;
  lessonBlockId:   number;
  sessionDate:     Date;
  blockLevel:      string;
  newTeacherUserId: number;
  newTeacherName:   string;
  reason:           string;
}

/**
 * Notifies the NEW (substitute) teacher about the assignment.
 * Student notifications for TEACHER_REPLACED are handled inline in replaceTeacher()
 * via notifyMany (existing behavior preserved).
 *
 * LIFECYCLE_SIDE_EFFECTS.TEACHER_REPLACED:
 *   notifyTeacher: true   — this function delivers it
 *   notifyParents: false  — student notification done in replaceTeacher() inline
 */
export async function dispatchTeacherReplacedNotifications(
  params: TeacherReplacedNotificationParams,
): Promise<void> {
  const dateStr = params.sessionDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  await notify({
    userId: params.newTeacherUserId,
    type:   'SUBSTITUTE_TEACHER_ASSIGNED',
    title:  'Вы назначены преподавателем',
    body:   `Вам назначено занятие ${params.blockLevel} ${dateStr}`,
    data:   {
      sessionId:     params.sessionId,
      lessonBlockId: params.lessonBlockId,
      reason:        params.reason,
    },
  });
}

// ─── MAKEUP_CREATED ───────────────────────────────────────────────────────────

export interface MakeupCreatedNotificationParams {
  originalSessionId: number;
  makeupSessionId:   number;
  lessonBlockId:     number;
  makeupDate:        Date;
  blockLevel:        string;
  studentUserIds:    number[];
}

/**
 * Notifies students that a makeup session was scheduled for a previously cancelled lesson.
 *
 * LIFECYCLE_SIDE_EFFECTS.MAKEUP_CREATED:
 *   notifyParents: true  — students notified
 *   notifyTeacher: false — teacher not notified at this stage
 */
export async function dispatchMakeupCreatedNotifications(
  params: MakeupCreatedNotificationParams,
): Promise<void> {
  if (params.studentUserIds.length === 0) return;
  const dateStr = params.makeupDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  await notifyMany(params.studentUserIds, {
    type:  'MAKEUP_SCHEDULED',
    title: 'Назначен замещающий урок',
    body:  `Замещающее занятие ${params.blockLevel} назначено на ${dateStr}`,
    data:  {
      sessionId:         params.makeupSessionId,
      originalSessionId: params.originalSessionId,
      lessonBlockId:     params.lessonBlockId,
    },
  });
}

// ─── SESSION_INVALIDATED ──────────────────────────────────────────────────────

export interface SessionInvalidatedNotificationParams {
  sessionId:  number;
  schoolId:   number;
  sessionDate: Date;
  actorUserId: number;
  reason:      string;
}

/**
 * Sends an internal admin/owner alert when a session is invalidated.
 * Students/parents are NOT notified (LIFECYCLE_SIDE_EFFECTS.SESSION_INVALIDATED.notifyParents = false).
 * Only admins receive an internal record for audit awareness.
 *
 * TODO PR 7: If parent visibility projection is implemented, INVALIDATED sessions
 * should be hidden from student schedule — no notification needed then either.
 */
export async function dispatchSessionInvalidatedNotifications(
  prisma: PrismaClient,
  params: SessionInvalidatedNotificationParams,
): Promise<void> {
  const dateStr = params.sessionDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  await notifySchoolAdmins(params.schoolId, {
    type:  'SESSION_INVALIDATED_ALERT',
    title: 'Урок помечен как недействительный',
    body:  `Занятие от ${dateStr} помечено как INVALIDATED (недействительное)`,
    data:  {
      sessionId:   params.sessionId,
      actorUserId: params.actorUserId,
      reason:      params.reason,
    },
  });
}
