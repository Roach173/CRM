/**
 * Unit tests for scheduleLifecycleNotificationService (PR 5).
 *
 * All external I/O is mocked. No database required.
 *
 * Covers:
 *   - dispatchSessionCancelledNotifications — students + teacher notified
 *   - dispatchRescheduleNotifications — students + teacher with old/new slot
 *   - dispatchTeacherReplacedNotifications — new teacher notified
 *   - dispatchSessionInvalidatedNotifications — admin only (notifySchoolAdmins)
 *   - LIFECYCLE_SIDE_EFFECTS contract: SESSION_CANCELLED.notifyTeacher = true (PR 5)
 */

jest.mock('../../lib/notify', () => ({
  notify:              jest.fn().mockResolvedValue(undefined),
  notifyMany:          jest.fn().mockResolvedValue(undefined),
  notifySchoolAdmins:  jest.fn().mockResolvedValue(undefined),
}));

import { notify, notifyMany, notifySchoolAdmins } from '../../lib/notify';

import {
  dispatchSessionCancelledNotifications,
  dispatchRescheduleNotifications,
  dispatchTeacherReplacedNotifications,
  dispatchSessionInvalidatedNotifications,
} from '../../services/scheduleLifecycleNotificationService';

import { LIFECYCLE_SIDE_EFFECTS } from '../../services/scheduleLifecycleTypes';

const SESSION_DATE = new Date('2026-06-15T12:00:00.000Z');
const BLOCK_LEVEL  = 'A2';

beforeEach(() => { jest.clearAllMocks(); });

// ─── CONTRACT: LIFECYCLE_SIDE_EFFECTS updated in PR 5 ────────────────────────

describe('LIFECYCLE_SIDE_EFFECTS — SESSION_CANCELLED.notifyTeacher updated in PR 5', () => {
  it('SESSION_CANCELLED.notifyTeacher is now true (PR 5 change from false)', () => {
    expect(LIFECYCLE_SIDE_EFFECTS['SESSION_CANCELLED'].notifyTeacher).toBe(true);
  });

  it('SESSION_RESCHEDULED: notifyTeacher=true, notifyParents=true', () => {
    const fx = LIFECYCLE_SIDE_EFFECTS['SESSION_RESCHEDULED'];
    expect(fx.notifyTeacher).toBe(true);
    expect(fx.notifyParents).toBe(true);
  });

  it('SESSION_INVALIDATED: notifyParents=false (admin internal only)', () => {
    expect(LIFECYCLE_SIDE_EFFECTS['SESSION_INVALIDATED'].notifyParents).toBe(false);
  });

  it('TEACHER_REPLACED: notifyTeacher=true', () => {
    expect(LIFECYCLE_SIDE_EFFECTS['TEACHER_REPLACED'].notifyTeacher).toBe(true);
  });
});

// ─── dispatchSessionCancelledNotifications ────────────────────────────────────

describe('dispatchSessionCancelledNotifications', () => {
  it('notifies students with LESSON_CANCELLED type', async () => {
    await dispatchSessionCancelledNotifications({
      sessionId: 1, lessonBlockId: 100,
      sessionDate: SESSION_DATE, blockLevel: BLOCK_LEVEL,
      reason: 'праздник', studentUserIds: [10, 11], teacherUserId: 5,
    });

    expect(notifyMany).toHaveBeenCalledWith(
      [10, 11],
      expect.objectContaining({ type: 'LESSON_CANCELLED' }),
    );
  });

  it('notifies teacher with LESSON_CANCELLED_FOR_TEACHER type', async () => {
    await dispatchSessionCancelledNotifications({
      sessionId: 1, lessonBlockId: 100,
      sessionDate: SESSION_DATE, blockLevel: BLOCK_LEVEL,
      reason: 'праздник', studentUserIds: [10], teacherUserId: 5,
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5, type: 'LESSON_CANCELLED_FOR_TEACHER' }),
    );
  });

  it('does NOT call notify when teacherUserId is undefined', async () => {
    await dispatchSessionCancelledNotifications({
      sessionId: 1, lessonBlockId: 100,
      sessionDate: SESSION_DATE, blockLevel: BLOCK_LEVEL,
      studentUserIds: [10], teacherUserId: undefined,
    });

    expect(notify).not.toHaveBeenCalled();
    expect(notifyMany).toHaveBeenCalledTimes(1);
  });

  it('does NOT call notifyMany when studentUserIds is empty', async () => {
    await dispatchSessionCancelledNotifications({
      sessionId: 1, lessonBlockId: 100,
      sessionDate: SESSION_DATE, blockLevel: BLOCK_LEVEL,
      studentUserIds: [], teacherUserId: 5,
    });

    expect(notifyMany).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1); // teacher still notified
  });

  it('includes reason in notification data when provided', async () => {
    await dispatchSessionCancelledNotifications({
      sessionId: 1, lessonBlockId: 100,
      sessionDate: SESSION_DATE, blockLevel: BLOCK_LEVEL,
      reason: 'school holiday', studentUserIds: [10], teacherUserId: 5,
    });

    expect(notifyMany).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ data: expect.objectContaining({ reason: 'school holiday' }) }),
    );
  });
});

// ─── dispatchRescheduleNotifications ─────────────────────────────────────────

describe('dispatchRescheduleNotifications', () => {
  const base = {
    sessionId: 1, lessonBlockId: 100,
    sessionDate: SESSION_DATE, blockLevel: BLOCK_LEVEL,
    oldSlot: { startTime: '09:00', endTime: '10:00' },
    newSlot: { startTime: '10:00', endTime: '11:00' },
    reason: 'room conflict resolved',
  };

  it('notifies students with SESSION_RESCHEDULED type', async () => {
    await dispatchRescheduleNotifications({ ...base, studentUserIds: [10, 11], teacherUserId: 5 });

    expect(notifyMany).toHaveBeenCalledWith(
      [10, 11],
      expect.objectContaining({ type: 'SESSION_RESCHEDULED' }),
    );
  });

  it('notifies teacher with SESSION_RESCHEDULED_FOR_TEACHER type', async () => {
    await dispatchRescheduleNotifications({ ...base, studentUserIds: [10], teacherUserId: 5 });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5, type: 'SESSION_RESCHEDULED_FOR_TEACHER' }),
    );
  });

  it('includes old and new slot times in notification data', async () => {
    await dispatchRescheduleNotifications({ ...base, studentUserIds: [10], teacherUserId: 5 });

    expect(notifyMany).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        data: expect.objectContaining({
          oldStartTime: '09:00',
          oldEndTime:   '10:00',
          newStartTime: '10:00',
          newEndTime:   '11:00',
        }),
      }),
    );
  });

  it('does NOT notify teacher when teacherUserId is undefined', async () => {
    await dispatchRescheduleNotifications({ ...base, studentUserIds: [10], teacherUserId: undefined });

    expect(notify).not.toHaveBeenCalled();
    expect(notifyMany).toHaveBeenCalledTimes(1);
  });

  it('does NOT call notifyMany when no students', async () => {
    await dispatchRescheduleNotifications({ ...base, studentUserIds: [], teacherUserId: 5 });

    expect(notifyMany).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1); // teacher still notified
  });
});

// ─── dispatchTeacherReplacedNotifications ─────────────────────────────────────

describe('dispatchTeacherReplacedNotifications', () => {
  it('notifies the new teacher with SUBSTITUTE_TEACHER_ASSIGNED type', async () => {
    await dispatchTeacherReplacedNotifications({
      sessionId: 1, lessonBlockId: 100,
      sessionDate: SESSION_DATE, blockLevel: BLOCK_LEVEL,
      newTeacherUserId: 7, newTeacherName: 'Ivan Petrov',
      reason: 'illness',
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        type:   'SUBSTITUTE_TEACHER_ASSIGNED',
      }),
    );
  });

  it('includes reason in teacher notification data', async () => {
    await dispatchTeacherReplacedNotifications({
      sessionId: 1, lessonBlockId: 100,
      sessionDate: SESSION_DATE, blockLevel: BLOCK_LEVEL,
      newTeacherUserId: 7, newTeacherName: 'Ivan Petrov',
      reason: 'illness',
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'illness' }) }),
    );
  });

  it('does NOT call notifyMany (students handled separately in replaceTeacher)', async () => {
    await dispatchTeacherReplacedNotifications({
      sessionId: 1, lessonBlockId: 100,
      sessionDate: SESSION_DATE, blockLevel: BLOCK_LEVEL,
      newTeacherUserId: 7, newTeacherName: 'Ivan Petrov',
      reason: 'illness',
    });

    expect(notifyMany).not.toHaveBeenCalled();
  });
});

// ─── dispatchSessionInvalidatedNotifications ──────────────────────────────────

describe('dispatchSessionInvalidatedNotifications', () => {
  const mockPrisma = {} as any; // notifySchoolAdmins only uses prisma indirectly via notify.ts

  it('calls notifySchoolAdmins with SESSION_INVALIDATED_ALERT type', async () => {
    await dispatchSessionInvalidatedNotifications(mockPrisma, {
      sessionId: 1, schoolId: 10,
      sessionDate: SESSION_DATE,
      actorUserId: 99,
      reason: 'data integrity issue',
    });

    expect(notifySchoolAdmins).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ type: 'SESSION_INVALIDATED_ALERT' }),
    );
  });

  it('does NOT call notifyMany or notify (admin-only, not student-facing)', async () => {
    await dispatchSessionInvalidatedNotifications(mockPrisma, {
      sessionId: 1, schoolId: 10,
      sessionDate: SESSION_DATE,
      actorUserId: 99,
      reason: 'data integrity issue',
    });

    expect(notify).not.toHaveBeenCalled();
    expect(notifyMany).not.toHaveBeenCalled();
    expect(notifySchoolAdmins).toHaveBeenCalledTimes(1);
  });

  it('includes actorUserId and reason in notification data', async () => {
    await dispatchSessionInvalidatedNotifications(mockPrisma, {
      sessionId: 1, schoolId: 10,
      sessionDate: SESSION_DATE,
      actorUserId: 42,
      reason: 'test-reason',
    });

    expect(notifySchoolAdmins).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        data: expect.objectContaining({ actorUserId: 42, reason: 'test-reason' }),
      }),
    );
  });
});
