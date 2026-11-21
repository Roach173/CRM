/**
 * Started-lesson attendance convenience.
 *
 * Bug: attendance could only be marked once a lesson's status was manually
 * switched to «Идёт сейчас» (IN_PROGRESS) — and a same-day-only version of this
 * rule left past-dated UPCOMING sessions permanently stuck (isToday was false
 * forever once the calendar day had passed). An UPCOMING lesson dated today or
 * earlier should be markable directly — the whole calendar day, regardless of
 * start time (2026-07-07 whole-day markability).
 *
 * These tests pin the backend gates that decide editability/submittability:
 *   - isAttendanceAllowed(status, { hasStarted })  — the state-machine rule
 *   - attendanceStateFor(session, tz)              — drives read-model canEditAttendance
 *   - submitAttendanceAndFinalize({ ..., tz })      — the submit gate
 *
 * Credit deduction still happens only inside markAttendance during submit, so this
 * convenience does not change financial behaviour.
 */
import { isAttendanceAllowed } from '../../lib/sessionStateMachine';
import {
  attendanceStateFor,
  submitAttendanceAndFinalize,
} from '../../services/attendanceFinalizationService';
import { markAttendance } from '../../services/attendanceService';
import prisma from '../../lib/prisma';

jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

jest.mock('../../services/attendanceService', () => ({
  markAttendance: jest.fn(),
}));

/** UTC-noon sentinel for `days` calendar days from today (0 = today), matching how LessonSession.date is stored. */
function noonUtc(daysFromToday = 0): Date {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysFromToday,
    12, 0, 0,
  ));
}

describe('sessionStateMachine.isAttendanceAllowed — started-lesson rule', () => {
  it('blocks UPCOMING by default (unchanged)', () => {
    expect(isAttendanceAllowed('UPCOMING')).toBe(false);
    expect(isAttendanceAllowed('UPCOMING', { hasStarted: false })).toBe(false);
  });

  it('allows UPCOMING once the lesson has started', () => {
    expect(isAttendanceAllowed('UPCOMING', { hasStarted: true })).toBe(true);
  });

  it('still blocks terminal/locked statuses even when started', () => {
    expect(isAttendanceAllowed('CANCELLED', { hasStarted: true })).toBe(false);
    expect(isAttendanceAllowed('INVALIDATED', { hasStarted: true })).toBe(false);
    expect(isAttendanceAllowed('LOCKED', { hasStarted: true })).toBe(false);
  });

  it('still allows IN_PROGRESS / COMPLETED regardless of hasStarted', () => {
    expect(isAttendanceAllowed('IN_PROGRESS')).toBe(true);
    expect(isAttendanceAllowed('COMPLETED')).toBe(true);
  });
});

describe('attendanceStateFor — started-lesson editability (drives backendCanEditAttendance)', () => {
  it("today's UPCOMING session is editable once past its start time", () => {
    const state = attendanceStateFor(
      { status: 'UPCOMING', attendanceFinalizedAt: null, date: noonUtc(0), startTime: '00:01' },
      'UTC',
    );
    expect(state.canEditAttendance).toBe(true);
    expect(state.canReopenAttendance).toBe(false);
  });

  it("today's UPCOMING session is editable even before its start time (whole-day markability)", () => {
    const state = attendanceStateFor(
      { status: 'UPCOMING', attendanceFinalizedAt: null, date: noonUtc(0), startTime: '23:59' },
      'UTC',
    );
    expect(state.canEditAttendance).toBe(true);
  });

  it("a past day's UPCOMING session IS editable — no longer stuck (fixes the deadlock)", () => {
    const state = attendanceStateFor(
      { status: 'UPCOMING', attendanceFinalizedAt: null, date: noonUtc(-1), startTime: '09:00' },
      'UTC',
    );
    expect(state.canEditAttendance).toBe(true);
  });

  it("a future day's UPCOMING session is NOT editable", () => {
    const state = attendanceStateFor(
      { status: 'UPCOMING', attendanceFinalizedAt: null, date: noonUtc(1), startTime: '00:01' },
      'UTC',
    );
    expect(state.canEditAttendance).toBe(false);
  });

  it('without tz, UPCOMING stays non-editable (backward compatible)', () => {
    const state = attendanceStateFor({ status: 'UPCOMING', attendanceFinalizedAt: null, date: noonUtc(0), startTime: '00:01' });
    expect(state.canEditAttendance).toBe(false);
  });
});

describe('submitAttendanceAndFinalize — started-lesson submit gate', () => {
  function makeTx(sessionDate: Date, status = 'UPCOMING', startTimeSnap: string | null = '00:01') {
    return {
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 7 }]),
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: 42, schoolId: 1, date: sessionDate, status, attendanceFinalizedAt: null,
          startTimeSnap, lessonBlock: { startTime: '09:00', studentGroup: { status: 'ACTIVE', deletedAt: null } },
        }),
        update: jest.fn().mockResolvedValue({
          id: 42, status: 'COMPLETED',
          attendanceFinalizedAt: new Date(), attendanceFinalizedById: 9,
          attendanceReopenedAt: null, attendanceReopenReason: null,
        }),
      },
      sessionStudent: {
        findUnique: jest.fn().mockResolvedValue({ id: 77 }),
        findMany: jest.fn().mockResolvedValue([{ id: 77, studentProfileId: 7 }]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
      },
      attendance: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      attendanceAudit: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      lessonCreditLog: { create: jest.fn() },
      schoolFinanceConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      studentFreeze: { findMany: jest.fn().mockResolvedValue([]) },
      studentProfile: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ credits: 0 }),
        // recomputeAndPersistPaidUntil early-returns when the profile read is null.
        findFirst: jest.fn().mockResolvedValue(null),
      },
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (markAttendance as jest.Mock).mockResolvedValue({ id: 100, status: 'PRESENT', creditDeducted: true });
  });

  it("submits today's started UPCOMING session without requiring IN_PROGRESS", async () => {
    const tx = makeTx(noonUtc(0), 'UPCOMING', '00:01');
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    const result = await submitAttendanceAndFinalize({
      sessionId: 42, schoolId: 1, actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'PRESENT' }],
      tz: 'UTC',
    });

    expect(markAttendance).toHaveBeenCalledWith(tx, expect.objectContaining({ tz: 'UTC' }));
    expect(result.canReopenAttendance).toBe(true);
    // Auto-completed from UPCOMING — audit reason must say so, no silent mutation.
    expect(tx.attendanceAudit.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'FINALIZE', reason: expect.stringMatching(/auto-completed/i) }),
    }));
  });

  it("submits today's UPCOMING session even before its start time (whole-day markability)", async () => {
    const tx = makeTx(noonUtc(0), 'UPCOMING', '23:59');
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    const result = await submitAttendanceAndFinalize({
      sessionId: 42, schoolId: 1, actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'PRESENT' }],
      tz: 'UTC',
    });

    expect(result.canReopenAttendance).toBe(true);
  });

  it("submits a past day's stuck UPCOMING session (deadlock fix)", async () => {
    const tx = makeTx(noonUtc(-1), 'UPCOMING', '09:00');
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    const result = await submitAttendanceAndFinalize({
      sessionId: 42, schoolId: 1, actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'PRESENT' }],
      tz: 'UTC',
    });

    expect(result.canReopenAttendance).toBe(true);
  });

  it("rejects a future day's UPCOMING session", async () => {
    const tx = makeTx(noonUtc(1), 'UPCOMING', '00:01');
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    await expect(submitAttendanceAndFinalize({
      sessionId: 42, schoolId: 1, actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'PRESENT' }],
      tz: 'UTC',
    })).rejects.toMatchObject({ httpStatus: 400, code: 'SESSION_NOT_SUBMITTABLE' });

    expect(markAttendance).not.toHaveBeenCalled();
  });

  it('does not add an auto-complete reason when the session was already IN_PROGRESS', async () => {
    const tx = makeTx(noonUtc(0), 'IN_PROGRESS', '00:01');
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    await submitAttendanceAndFinalize({
      sessionId: 42, schoolId: 1, actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'PRESENT' }],
      tz: 'UTC',
    });

    expect(tx.attendanceAudit.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'FINALIZE', reason: null }),
    }));
  });
});
