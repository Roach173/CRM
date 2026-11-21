import fs from 'fs';
import path from 'path';
import {
  AttendanceFinalizationError,
  reopenAttendance,
  submitAttendanceAndFinalize,
  updateAttendanceWhileEditable,
} from '../../services/attendanceFinalizationService';
import { markAttendance } from '../../services/attendanceService';
import prisma from '../../lib/prisma';

jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
  },
}));

jest.mock('../../services/attendanceService', () => ({
  markAttendance: jest.fn(),
}));

function makeTx(overrides: Record<string, any> = {}) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([{ id: 7 }]),
    lessonSession: {
      findFirst: jest.fn().mockResolvedValue({
        id: 42,
        schoolId: 1,
        date: new Date('2026-06-08T12:00:00.000Z'),
        status: 'IN_PROGRESS',
        version: 0,
        attendanceFinalizedAt: null,
        attendanceReopenedAt: null,
        startTimeSnap: null,
        lessonBlock: { startTime: '09:00', studentGroup: { status: 'ACTIVE', deletedAt: null } },
      }),
      update: jest.fn().mockResolvedValue({
        id: 42,
        status: 'COMPLETED',
        attendanceFinalizedAt: new Date('2026-06-08T13:00:00.000Z'),
        attendanceFinalizedById: 9,
        attendanceReopenedAt: null,
        attendanceReopenReason: null,
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
    schoolFinanceConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    studentFreeze: { findMany: jest.fn().mockResolvedValue([]) },
    lessonCreditLog: {
      create: jest.fn(),
    },
    studentProfile: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ credits: 0 }),
      // recomputeAndPersistPaidUntil early-returns when the profile read is null.
      findFirst: jest.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(makeTx()));
  (markAttendance as jest.Mock).mockResolvedValue({
    id: 100,
    status: 'PRESENT',
    creditDeducted: true,
  });
});

describe('attendance finalization service', () => {
  it('submit finalizes and locks attendance in the same transaction', async () => {
    const tx = makeTx();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    const result = await submitAttendanceAndFinalize({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'PRESENT' }],
    });

    expect(markAttendance).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ sessionId: 42, studentProfileId: 7, submittedById: 9 }),
    );
    expect(tx.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 42 },
        data: expect.objectContaining({
          attendanceFinalizedAt: expect.any(Date),
          attendanceFinalizedById: 9,
          status: 'COMPLETED',
        }),
      }),
    );
    expect(tx.attendanceAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'FINALIZE', actorId: 9 }) }),
    );
    expect(result.canEditAttendance).toBe(false);
    expect(result.canReopenAttendance).toBe(true);
  });

  it('PATCH after finalization returns a finalized conflict and does not call markAttendance', async () => {
    const tx = makeTx({
      lessonSession: {
        ...makeTx().lessonSession,
        findFirst: jest.fn().mockResolvedValue({
          id: 42,
          schoolId: 1,
          date: new Date('2026-06-08T12:00:00.000Z'),
          status: 'COMPLETED',
          version: 0,
          attendanceFinalizedAt: new Date('2026-06-08T13:00:00.000Z'),
          attendanceReopenedAt: null,
          lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } },
        }),
      },
    });
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    await expect(updateAttendanceWhileEditable({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      studentProfileId: 7,
      status: 'ABSENT',
      reason: 'forced frontend patch',
    })).rejects.toMatchObject({
      httpStatus: 409,
      code: 'ATTENDANCE_FINALIZED',
    } satisfies Partial<AttendanceFinalizationError>);

    expect(markAttendance).not.toHaveBeenCalled();
  });

  it('reopen with reason clears finalization and writes REOPEN audit', async () => {
    const tx = makeTx({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: 42,
          attendanceFinalizedAt: new Date('2026-06-08T13:00:00.000Z'),
        }),
        update: jest.fn().mockResolvedValue({
          id: 42,
          status: 'COMPLETED',
          attendanceFinalizedAt: null,
          attendanceFinalizedById: null,
          attendanceReopenedAt: new Date('2026-06-08T14:00:00.000Z'),
          attendanceReopenedById: 9,
          attendanceReopenReason: 'Parent called after class',
        }),
      },
    });
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    const result = await reopenAttendance({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      reason: 'Parent called after class',
    });

    expect(tx.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attendanceFinalizedAt: null,
          attendanceFinalizedById: null,
          attendanceReopenedById: 9,
          attendanceReopenReason: 'Parent called after class',
        }),
      }),
    );
    expect(tx.attendanceAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'REOPEN', reason: 'Parent called after class' }),
      }),
    );
    expect(result.canEditAttendance).toBe(true);
  });

  it('correction after reopen requires reason and writes old/new audit', async () => {
    const tx = makeTx({
      lessonSession: {
        ...makeTx().lessonSession,
        findFirst: jest.fn().mockResolvedValue({
          id: 42,
          schoolId: 1,
          date: new Date('2026-06-08T12:00:00.000Z'),
          status: 'COMPLETED',
          version: 0,
          attendanceFinalizedAt: null,
          attendanceReopenedAt: new Date('2026-06-08T14:00:00.000Z'),
          lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } },
        }),
      },
      attendance: {
        findFirst: jest.fn().mockResolvedValue({ id: 100, status: 'PRESENT' }),
      },
    });
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
    (markAttendance as jest.Mock).mockResolvedValue({ id: 100, status: 'ABSENT', creditDeducted: true });

    await updateAttendanceWhileEditable({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      studentProfileId: 7,
      status: 'ABSENT',
      reason: 'Student was marked by mistake',
    });

    expect(tx.attendanceAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UPDATE',
          oldStatus: 'PRESENT',
          newStatus: 'ABSENT',
          actorId: 9,
          reason: 'Student was marked by mistake',
        }),
      }),
    );
  });

  it('does not perform credit ledger writes outside markAttendance', async () => {
    const tx = makeTx({
      attendance: {
        findFirst: jest.fn().mockResolvedValue({ id: 100, status: 'PRESENT' }),
        findMany: jest.fn().mockResolvedValue([{ id: 100, status: 'PRESENT', studentProfileId: 7, creditDeducted: true, sessionStudentId: 77 }]),
      },
    });
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
    (markAttendance as jest.Mock).mockResolvedValue({ id: 100, status: 'LATE', creditDeducted: true });

    await submitAttendanceAndFinalize({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'LATE' }],
    });

    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
    expect(markAttendance).toHaveBeenCalledTimes(1);
  });

  it('COMPLETED session without finalized attendance remains submittable', async () => {
    const tx = makeTx({
      lessonSession: {
        ...makeTx().lessonSession,
        findFirst: jest.fn().mockResolvedValue({
          id: 42,
          schoolId: 1,
          date: new Date('2026-06-08T12:00:00.000Z'),
          status: 'COMPLETED',
          attendanceFinalizedAt: null,
        }),
      },
    });
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    await submitAttendanceAndFinalize({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'PRESENT' }],
    });

    expect(markAttendance).toHaveBeenCalled();
    expect(tx.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it('rejects with ATTENDANCE_INCOMPLETE when expectedActiveStudentIds has missing students', async () => {
    await expect(submitAttendanceAndFinalize({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'PRESENT' }],
      expectedActiveStudentIds: [7, 8, 9],
    })).rejects.toMatchObject({
      httpStatus: 400,
      code: 'ATTENDANCE_INCOMPLETE',
      meta: { missingCount: 2 },
    } satisfies Partial<AttendanceFinalizationError>);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not reject when all expectedActiveStudentIds are covered', async () => {
    const tx = makeTx();
    tx.$queryRaw.mockResolvedValue([{ id: 7 }, { id: 8 }]);
    tx.sessionStudent.findMany.mockResolvedValue([{ id: 77, studentProfileId: 7 }, { id: 78, studentProfileId: 8 }]);
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    await expect(submitAttendanceAndFinalize({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      attendances: [
        { studentProfileId: 7, status: 'PRESENT' },
        { studentProfileId: 8, status: 'ABSENT' },
      ],
      expectedActiveStudentIds: [7, 8],
    })).resolves.toMatchObject({ canReopenAttendance: true });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('skips completeness check when expectedActiveStudentIds is not provided', async () => {
    const tx = makeTx();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    await expect(submitAttendanceAndFinalize({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'PRESENT' }],
    })).resolves.toMatchObject({ canReopenAttendance: true });
  });

  it('ABSENT status is accepted only when explicitly provided — not inferred from missing students', async () => {
    const tx = makeTx();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
    (markAttendance as jest.Mock).mockResolvedValue({ id: 100, status: 'ABSENT', creditDeducted: false });

    const result = await submitAttendanceAndFinalize({
      sessionId: 42,
      schoolId: 1,
      actorId: 9,
      attendances: [{ studentProfileId: 7, status: 'ABSENT' }],
      expectedActiveStudentIds: [7],
    });

    expect(markAttendance).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ studentProfileId: 7, status: 'ABSENT' }),
    );
    expect(result.canReopenAttendance).toBe(true);
  });

  it('migration finalizes existing attendance from earliest attendance and earliest non-null submitter', () => {
    const migration = fs.readFileSync(
      path.join(
        __dirname,
        '../../../prisma/migrations/20260614000000_attendance_finalization/migration.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('MIN("createdAt") AS "attendanceFinalizedAt"');
    expect(migration).toContain('WHERE "submittedById" IS NOT NULL');
    expect(migration).toContain('"attendanceFinalizedAt" = fa."attendanceFinalizedAt"');
    expect(migration).not.toContain('LessonCreditLog');
  });
});
