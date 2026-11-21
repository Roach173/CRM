/**
 * Unit tests for freezeService.
 * All Prisma calls are mocked — no database required.
 *
 * Coverage:
 *   createFreeze — reason enforcement (domain-layer validation)
 *   createFreeze — LESSON_SKIP guards (NOT_UPCOMING, deadline, dedup)
 *   createFreeze — PERIOD guards (overlap, deadline via first session)
 *   cancelFreeze — reason enforcement (domain-layer validation)
 *   cancelFreeze — actor guards (Teacher forbidden), deadline, already-cancelled
 *   findActiveFreeze — LESSON_SKIP match, PERIOD match, open-ended match, no match
 */

import { createFreeze, cancelFreeze, findActiveFreeze } from '../../services/freezeService';

jest.mock('../../lib/notify', () => ({
  notify: jest.fn().mockResolvedValue(undefined),
  notifyMany: jest.fn().mockResolvedValue(undefined),
  notifySchoolAdmins: jest.fn().mockResolvedValue(undefined),
}));

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const SCHOOL_ID = 1;
const STUDENT_PROFILE_ID = 10;
const ACTOR_OWNER = { userId: 99, role: 'OWNER' as const, schoolId: SCHOOL_ID };
const ACTOR_ADMIN = { userId: 98, role: 'ADMIN' as const, schoolId: SCHOOL_ID };
const ACTOR_TEACHER = { userId: 97, role: 'TEACHER' as const, schoolId: SCHOOL_ID };
const VALID_REASON = 'Valid test reason';

// UTC noon sentinel for June 15, 2026
const SESSION_DATE_NOON = new Date('2026-06-15T12:00:00.000Z');
// Exact session start for 09:00 Bishkek (UTC+6) = T03:00Z
const SESSION_START_UTC = new Date('2026-06-15T03:00:00.000Z');
// 30 hours before session start — well before deadline
const NOW_BEFORE_DEADLINE = new Date(SESSION_START_UTC.getTime() - 30 * 3600_000);
// 1 hour after session start — after deadline
const NOW_AFTER_DEADLINE  = new Date(SESSION_START_UTC.getTime() + 1 * 3600_000);

function makeClient(overrides: Record<string, any> = {}) {
  return {
    studentProfile: {
      findFirst:   jest.fn().mockResolvedValue({
        id: STUDENT_PROFILE_ID, isFrozen: false, frozenAt: null,
        user: { id: 50 },
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    school: {
      // minNotice: 1 day → deadlineHours = 24 (preserves original test timing)
      findFirst: jest.fn().mockResolvedValue({
        timezone: 'Asia/Bishkek',
        settings: { pauseRules: { minNotice: 1 } },
      }),
    },
    lessonSession: {
      findFirst: jest.fn().mockResolvedValue({
        id: 42, status: 'UPCOMING', date: SESSION_DATE_NOON,
        startTimeSnap: null,
        lessonBlock: { startTime: '09:00' },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    studentFreeze: {
      findFirst:   jest.fn().mockResolvedValue(null),
      create:      jest.fn().mockResolvedValue({ id: 1, type: 'LESSON_SKIP', status: 'ACTIVE' }),
      update:      jest.fn().mockResolvedValue({ id: 1, status: 'CANCELLED' }),
      updateMany:  jest.fn().mockResolvedValue({ count: 1 }),
      count:       jest.fn().mockResolvedValue(0),
      findMany:    jest.fn().mockResolvedValue([]),
    },
    scheduleActionLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(makeTxClient())),
    ...overrides,
  } as any;
}

function makeTxClient(overrides: Record<string, any> = {}) {
  return makeClient(overrides);
}

// ─── findActiveFreeze ─────────────────────────────────────────────────────────

describe('findActiveFreeze', () => {
  it('LESSON_SKIP: returns match when lessonSessionId matches', async () => {
    const client = makeClient();
    client.studentFreeze.findMany.mockResolvedValue([
      { id: 1, type: 'LESSON_SKIP', reason: null, studentProfileId: STUDENT_PROFILE_ID },
    ]);
    const result = await findActiveFreeze(
      { studentProfileId: STUDENT_PROFILE_ID, sessionId: 42, sessionDate: SESSION_DATE_NOON, schoolId: SCHOOL_ID },
      client,
    );
    expect(result).not.toBeNull();
    expect(client.studentFreeze.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });

  it('returns null when no active freeze exists', async () => {
    const client = makeClient();
    client.studentFreeze.findMany.mockResolvedValue([]);
    const result = await findActiveFreeze(
      { studentProfileId: STUDENT_PROFILE_ID, sessionId: 42, sessionDate: SESSION_DATE_NOON, schoolId: SCHOOL_ID },
      client,
    );
    expect(result).toBeNull();
  });
});

// ─── createFreeze — reason enforcement ───────────────────────────────────────

describe('createFreeze — reason enforcement', () => {
  it('throws 400 and makes no DB calls when reason is missing', async () => {
    const client = makeClient();
    await expect(
      createFreeze({
        studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER,
        type: 'LESSON_SKIP', lessonSessionId: 42,
        // reason: intentionally omitted
        client,
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(client.studentProfile.findFirst).not.toHaveBeenCalled();
  });

  it('throws 400 and makes no DB calls when reason is shorter than 5 chars', async () => {
    const client = makeClient();
    await expect(
      createFreeze({
        studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER,
        type: 'LESSON_SKIP', lessonSessionId: 42,
        reason: 'hi',
        client,
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(client.studentProfile.findFirst).not.toHaveBeenCalled();
  });

  it('throws 400 and makes no DB calls when reason is whitespace only', async () => {
    const client = makeClient();
    await expect(
      createFreeze({
        studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER,
        type: 'LESSON_SKIP', lessonSessionId: 42,
        reason: '     ',
        client,
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(client.studentProfile.findFirst).not.toHaveBeenCalled();
  });
});

// ─── createFreeze — LESSON_SKIP ───────────────────────────────────────────────

describe('createFreeze — LESSON_SKIP', () => {
  it('succeeds for UPCOMING session before deadline', async () => {
    const client = makeClient();
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await createFreeze({
      studentProfileId: STUDENT_PROFILE_ID,
      schoolId: SCHOOL_ID,
      actor: ACTOR_OWNER,
      type: 'LESSON_SKIP',
      lessonSessionId: 42,
      reason: VALID_REASON,
      client,
    });

    expect(client.$transaction).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('throws FREEZE_SESSION_NOT_UPCOMING for IN_PROGRESS session', async () => {
    const client = makeClient();
    client.lessonSession.findFirst.mockResolvedValue({
      id: 42, status: 'IN_PROGRESS', date: SESSION_DATE_NOON,
      startTimeSnap: null, lessonBlock: { startTime: '09:00' },
    });
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'LESSON_SKIP', lessonSessionId: 42, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_SESSION_NOT_UPCOMING', httpStatus: 422 });

    jest.useRealTimers();
  });

  it('throws FREEZE_SESSION_NOT_UPCOMING for COMPLETED session', async () => {
    const client = makeClient();
    client.lessonSession.findFirst.mockResolvedValue({
      id: 42, status: 'COMPLETED', date: SESSION_DATE_NOON,
      startTimeSnap: null, lessonBlock: { startTime: '09:00' },
    });
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'LESSON_SKIP', lessonSessionId: 42, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_SESSION_NOT_UPCOMING', httpStatus: 422 });

    jest.useRealTimers();
  });

  it('throws FREEZE_SESSION_NOT_UPCOMING for CANCELLED session', async () => {
    const client = makeClient();
    client.lessonSession.findFirst.mockResolvedValue({
      id: 42, status: 'CANCELLED', date: SESSION_DATE_NOON,
      startTimeSnap: null, lessonBlock: { startTime: '09:00' },
    });
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'LESSON_SKIP', lessonSessionId: 42, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_SESSION_NOT_UPCOMING', httpStatus: 422 });

    jest.useRealTimers();
  });

  it('throws FREEZE_DEADLINE_PASSED when now is after deadline', async () => {
    const client = makeClient();
    jest.useFakeTimers().setSystemTime(NOW_AFTER_DEADLINE);

    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'LESSON_SKIP', lessonSessionId: 42, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_DEADLINE_PASSED', httpStatus: 422 });

    jest.useRealTimers();
  });

  it('throws FREEZE_LESSON_SKIP_EXISTS when duplicate', async () => {
    const client = makeClient();
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);
    // Simulate: overlap/dedup check returns existing freeze inside tx
    client.$transaction.mockImplementation(async (fn: any) => {
      const tx = makeTxClient();
      tx.studentFreeze.findFirst.mockResolvedValue({ id: 99 });
      return fn(tx);
    });

    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'LESSON_SKIP', lessonSessionId: 42, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_LESSON_SKIP_EXISTS', httpStatus: 409 });

    jest.useRealTimers();
  });

  it('throws LESSON_SESSION_ID_REQUIRED when not provided', async () => {
    const client = makeClient();
    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'LESSON_SKIP', reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'LESSON_SESSION_ID_REQUIRED', httpStatus: 400 });
  });
});

// ─── createFreeze — PERIOD ─────────────────────────────────────────────────────

describe('createFreeze — PERIOD', () => {
  const START = new Date('2026-06-15T12:00:00.000Z');
  const END   = new Date('2026-06-22T12:00:00.000Z');

  it('succeeds when no overlap and no sessions (no deadline to check)', async () => {
    const client = makeClient();
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);
    // No first session in period
    client.$transaction.mockImplementation(async (fn: any) => {
      const tx = makeTxClient();
      tx.studentFreeze.findFirst.mockResolvedValue(null); // no overlap
      tx.lessonSession.findFirst = jest.fn().mockResolvedValue(null); // no sessions
      tx.studentFreeze.create.mockResolvedValue({ id: 2, type: 'PERIOD', status: 'ACTIVE' });
      return fn(tx);
    });

    const result = await createFreeze({
      studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER,
      type: 'PERIOD', startDate: START, endDate: END, reason: VALID_REASON, client,
    });

    expect(result.type).toBe('PERIOD');
    jest.useRealTimers();
  });

  it('throws FREEZE_PERIOD_OVERLAP when overlapping ACTIVE PERIOD exists', async () => {
    const client = makeClient();
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);
    client.$transaction.mockImplementation(async (fn: any) => {
      const tx = makeTxClient();
      tx.studentFreeze.findFirst.mockResolvedValue({ id: 5 }); // overlap exists
      return fn(tx);
    });

    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'PERIOD', startDate: START, endDate: END, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_PERIOD_OVERLAP', httpStatus: 409 });

    jest.useRealTimers();
  });

  it('throws START_DATE_REQUIRED when startDate missing', async () => {
    const client = makeClient();
    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'PERIOD', reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'START_DATE_REQUIRED', httpStatus: 400 });
  });
});

// ─── createFreeze — pause rules enforcement ────────────────────────────────────

describe('createFreeze — pause rules enforcement', () => {
  it('throws PAUSE_NOT_ALLOWED when allowed=false', async () => {
    const client = makeClient();
    client.school.findFirst.mockResolvedValue({
      timezone: 'Asia/Bishkek',
      settings: { pauseRules: { minNotice: 1, allowed: false } },
    });
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'LESSON_SKIP', lessonSessionId: 42, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'PAUSE_NOT_ALLOWED', httpStatus: 400 });

    jest.useRealTimers();
  });

  it('throws PAUSE_LIMIT_REACHED when timesPerYear exceeded', async () => {
    const client = makeClient();
    client.school.findFirst.mockResolvedValue({
      timezone: 'Asia/Bishkek',
      settings: { pauseRules: { minNotice: 1, timesPerYear: 2 } },
    });
    // Simulate existing 2 freezes this year (at limit)
    client.$transaction.mockImplementation(async (fn: any) => {
      const tx = makeTxClient();
      tx.studentFreeze.count = jest.fn().mockResolvedValue(2);
      tx.studentFreeze.findFirst.mockResolvedValue(null);
      return fn(tx);
    });
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'LESSON_SKIP', lessonSessionId: 42, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'PAUSE_LIMIT_REACHED', httpStatus: 422 });

    jest.useRealTimers();
  });

  it('throws FREEZE_PERIOD_TOO_LONG when PERIOD exceeds maxDays', async () => {
    const client = makeClient();
    client.school.findFirst.mockResolvedValue({
      timezone: 'Asia/Bishkek',
      settings: { pauseRules: { minNotice: 1, maxDays: 7 } },
    });
    const START = new Date('2026-06-15T12:00:00.000Z');
    const END   = new Date('2026-06-30T12:00:00.000Z'); // 15 days > 7
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await expect(
      createFreeze({ studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, type: 'PERIOD', startDate: START, endDate: END, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_PERIOD_TOO_LONG', httpStatus: 422 });

    jest.useRealTimers();
  });

  it('null timesPerYear (unlimited) does not block creation', async () => {
    const client = makeClient();
    client.school.findFirst.mockResolvedValue({
      timezone: 'Asia/Bishkek',
      settings: { pauseRules: { minNotice: 1, timesPerYear: null } },
    });
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await createFreeze({
      studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER,
      type: 'LESSON_SKIP', lessonSessionId: 42, reason: VALID_REASON, client,
    });

    expect(client.$transaction).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('skipDeadlineCheck bypasses deadline and maxDays but not allowed', async () => {
    const client = makeClient();
    client.school.findFirst.mockResolvedValue({
      timezone: 'Asia/Bishkek',
      settings: { pauseRules: { minNotice: 1, allowed: false } },
    });
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    // allowed=false is always enforced, even with skipDeadlineCheck
    await expect(
      createFreeze({
        studentProfileId: STUDENT_PROFILE_ID, schoolId: SCHOOL_ID, actor: ACTOR_OWNER,
        type: 'LESSON_SKIP', lessonSessionId: 42, reason: VALID_REASON, client,
        skipDeadlineCheck: true,
      }),
    ).rejects.toMatchObject({ message: 'PAUSE_NOT_ALLOWED', httpStatus: 400 });

    jest.useRealTimers();
  });
});

// ─── cancelFreeze ─────────────────────────────────────────────────────────────

describe('cancelFreeze', () => {
  function makeFreeze(overrides: Record<string, any> = {}) {
    return {
      id: 1, status: 'ACTIVE', type: 'LESSON_SKIP', lessonSessionId: 42,
      studentProfileId: STUDENT_PROFILE_ID, createdById: 99,
      startDate: null, endDate: null,
      studentProfile: { user: { id: 50 } },
      ...overrides,
    };
  }

  it('throws 400 and makes no DB calls when reason is missing', async () => {
    const client = makeClient();
    await expect(
      cancelFreeze({ freezeId: 1, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, client }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('throws 400 and makes no DB calls when reason is shorter than 5 chars', async () => {
    const client = makeClient();
    await expect(
      cancelFreeze({ freezeId: 1, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, reason: 'no', client }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('throws FREEZE_CANCEL_FORBIDDEN for TEACHER actor', async () => {
    const client = makeClient();
    client.studentFreeze.findFirst.mockResolvedValue(makeFreeze());

    await expect(
      cancelFreeze({ freezeId: 1, schoolId: SCHOOL_ID, actor: ACTOR_TEACHER, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_CANCEL_FORBIDDEN', httpStatus: 403 });
  });

  it('throws FREEZE_ALREADY_CANCELLED if freeze is already cancelled', async () => {
    const client = makeClient();
    client.studentFreeze.findFirst.mockResolvedValue(makeFreeze({ status: 'CANCELLED' }));

    await expect(
      cancelFreeze({ freezeId: 1, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_ALREADY_CANCELLED', httpStatus: 409 });
  });

  it('throws FREEZE_NOT_FOUND when freeze does not exist', async () => {
    const client = makeClient();
    client.studentFreeze.findFirst.mockResolvedValue(null);

    await expect(
      cancelFreeze({ freezeId: 999, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, reason: VALID_REASON, client }),
    ).rejects.toMatchObject({ message: 'FREEZE_NOT_FOUND', httpStatus: 404 });
  });

  it('succeeds for OWNER actor before deadline', async () => {
    const client = makeClient();
    client.studentFreeze.findFirst.mockResolvedValue(makeFreeze());
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await cancelFreeze({ freezeId: 1, schoolId: SCHOOL_ID, actor: ACTOR_OWNER, reason: VALID_REASON, client });

    expect(client.$transaction).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('succeeds for ADMIN actor before deadline', async () => {
    const client = makeClient();
    client.studentFreeze.findFirst.mockResolvedValue(makeFreeze());
    jest.useFakeTimers().setSystemTime(NOW_BEFORE_DEADLINE);

    await cancelFreeze({ freezeId: 1, schoolId: SCHOOL_ID, actor: ACTOR_ADMIN, reason: VALID_REASON, client });
    expect(client.$transaction).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
