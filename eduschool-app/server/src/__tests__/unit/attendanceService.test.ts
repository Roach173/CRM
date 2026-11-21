/**
 * Unit tests for markAttendance.
 *
 * Prisma TransactionClient is replaced with a hand-crafted mock so these tests
 * run without a database. Focus: credit deduction / idempotency logic.
 *
 * BILLING MODEL: Slot Reservation — student reserves a slot.
 * PRESENT, LATE, ABSENT all deduct credits (slot was held).
 * Deduction is idempotent: creditDeducted flag is write-once.
 * Status changes (PRESENT→ABSENT) do NOT refund credits — only manual correction.
 * See: server/src/lib/businessInvariants.ts — BILLING_POLICY
 *
 * PR 5 (Freeze System Phase 1) additions:
 * - attendanceService reads StudentFreeze (not StudentProfile.isFrozen)
 * - Active freeze → credit skipped (creditDeducted=false, FREEZE_SKIP ledger); admin's status kept
 * - No active freeze → normal DEBIT logic unchanged
 * - DEBIT entries include type='DEBIT', attendanceId, actorId
 */
import { markAttendance } from '../../services/attendanceService';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeTx(overrides: Partial<ReturnType<typeof baseTx>> = {}) {
  return { ...baseTx(), ...overrides } as any;
}

function baseTx() {
  // findFirst starts returning null (no existing record).
  // createMany, when called, self-registers the created record for the next findFirst call.
  // This way UPDATE path tests can safely override findFirst without fighting once() queues.
  const findFirstMock = jest.fn().mockResolvedValue(null);
  const createManyMock = jest.fn().mockImplementation(({ data }: { data: any[] }) => {
    const row = data[0];
    findFirstMock.mockResolvedValueOnce({ id: 1, status: row.status, creditDeducted: row.creditDeducted });
    return Promise.resolve({ count: 1 });
  });

  return {
    attendance: {
      findFirst:   findFirstMock,
      createMany:  createManyMock,
      create:      jest.fn().mockResolvedValue({ id: 1, status: 'PRESENT', creditDeducted: true }),
      update:      jest.fn().mockResolvedValue({ id: 1, status: 'ABSENT', creditDeducted: true }),
      updateMany:  jest.fn().mockResolvedValue({ count: 1 }), // atomic claim — winner returns count=1
    },
    lessonSession: {
      findFirst: jest.fn().mockResolvedValue({
        status: 'IN_PROGRESS',
        lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } },
      }),
    },
    studentProfile: {
      findUnique: jest.fn().mockResolvedValue({ credits: 5 }),
      update:     jest.fn().mockResolvedValue({}),
    },
    schoolFinanceConfig: {
      findUnique: jest.fn().mockResolvedValue({ pricePerLesson: 1 }),
    },
    lessonCreditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    sessionStudent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create:     jest.fn().mockResolvedValue({ id: 10 }),
    },
    // PR 5: findActiveFreeze queries studentFreeze via the tx client
    studentFreeze: {
      findMany: jest.fn().mockResolvedValue([]), // default: no active freeze
    },
    // F-04: FOR UPDATE row lock on StudentProfile — present on Prisma.TransactionClient
    $executeRaw: jest.fn().mockResolvedValue(undefined),
  };
}

const FUTURE_SESSION_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const BASE_PARAMS = {
  sessionId:        42,
  studentProfileId: 7,
  schoolId:         1,
  sessionStudentId: 10,
  sessionDate:      FUTURE_SESSION_DATE,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('markAttendance — slot reservation billing model', () => {
  it('deducts 1 credit for PRESENT (new record)', async () => {
    const tx = makeTx();
    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.studentProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { credits: { decrement: 1 } } })
    );
    expect(tx.lessonCreditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: -1, type: 'DEBIT' }),
      })
    );
  });

  it('deducts 1 credit for LATE (new record)', async () => {
    const tx = makeTx();
    await markAttendance(tx, { ...BASE_PARAMS, status: 'LATE' });

    expect(tx.studentProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { credits: { decrement: 1 } } })
    );
  });

  it('deducts 1 credit for ABSENT (new record) — slot was reserved', async () => {
    const tx = makeTx();
    await markAttendance(tx, { ...BASE_PARAMS, status: 'ABSENT' });

    expect(tx.studentProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { credits: { decrement: 1 } } })
    );
    expect(tx.lessonCreditLog.create).toHaveBeenCalled();
  });

  it('DEBIT log includes attendanceId and actorId', async () => {
    const tx = makeTx();
    // attendance.create returns { id: 1, ... }
    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT', submittedById: 99 });

    expect(tx.lessonCreditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'DEBIT',
          attendanceId: 1,   // id from attendance.create mock
          actorId: 99,
          amount: -1,
        }),
      })
    );
  });
});

describe('markAttendance — idempotency (creditDeducted flag)', () => {
  it('does NOT deduct again when creditDeducted = true (PRESENT → PRESENT)', async () => {
    const tx = makeTx();
    tx.attendance.findFirst.mockResolvedValue({
      id: 1, status: 'PRESENT', creditDeducted: true, sessionStudentId: 10,
    });

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
  });

  it('does NOT deduct again when creditDeducted = true (PRESENT → ABSENT)', async () => {
    const tx = makeTx();
    tx.attendance.findFirst.mockResolvedValue({
      id: 1, status: 'PRESENT', creditDeducted: true, sessionStudentId: 10,
    });

    await markAttendance(tx, { ...BASE_PARAMS, status: 'ABSENT' });

    // Status-change editing does NOT refund or re-deduct — creditDeducted is immutable once true
    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
  });

  it('deducts on first call and skips on second call (full idempotency round-trip)', async () => {
    const tx = makeTx();

    // First call: baseTx findFirst returns null (once) then {id:1,...} — CREATE path
    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });
    expect(tx.studentProfile.update).toHaveBeenCalledTimes(1);

    // Second call: prior record with creditDeducted = true
    tx.studentProfile.update.mockClear();
    tx.attendance.findFirst.mockResolvedValue({
      id: 1, status: 'PRESENT', creditDeducted: true, sessionStudentId: 10,
    });
    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });
    expect(tx.studentProfile.update).not.toHaveBeenCalled();
  });
});

describe('markAttendance — PR 5: StudentFreeze-based freeze skip', () => {
  it('does NOT deduct (credit skipped via ledger) when active StudentFreeze exists', async () => {
    const tx = makeTx();
    // Mock: studentFreeze.findMany returns an active freeze
    tx.studentFreeze.findMany.mockResolvedValue([{ id: 7, type: 'LESSON_SKIP', reason: null, studentProfileId: 7 }]);
    tx.attendance.create.mockResolvedValue({ id: 1, status: 'ABSENT', creditDeducted: false });

    await markAttendance(tx, { ...BASE_PARAMS, status: 'ABSENT' });

    expect(tx.studentProfile.update).not.toHaveBeenCalled();

    // FREEZE_SKIP ledger entry with amount=0
    expect(tx.lessonCreditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'FREEZE_SKIP', amount: 0, attendanceId: 1 }),
      })
    );
  });

  it('keeps the caller-passed status while skipping the credit (freeze no longer overrides status)', async () => {
    const tx = makeTx();
    tx.studentFreeze.findMany.mockResolvedValue([{ id: 7, type: 'PERIOD', reason: null, studentProfileId: 7 }]);

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.attendance.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ status: 'PRESENT', creditDeducted: false }),
        ]),
        skipDuplicates: true,
      })
    );
  });

  it('DOES deduct normally when no active StudentFreeze (findFirst returns null)', async () => {
    const tx = makeTx();
    // studentFreeze.findMany already returns [] by default in baseTx()

    await markAttendance(tx, { ...BASE_PARAMS, status: 'ABSENT' });

    expect(tx.studentProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { credits: { decrement: 1 } } })
    );
    expect(tx.lessonCreditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'DEBIT', amount: -1 }),
      })
    );
  });
});

describe('markAttendance — atomic claim (Phase 4 PR 2)', () => {
  it('calls updateMany for atomic claim when existing record has creditDeducted=false', async () => {
    const tx = makeTx();
    tx.attendance.findFirst.mockResolvedValue({
      id: 1, status: 'PRESENT', creditDeducted: false, sessionStudentId: 10,
    });
    // updateMany returns count=1 — this transaction wins the claim
    tx.attendance.updateMany.mockResolvedValue({ count: 1 });

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.attendance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 1, creditDeducted: false }),
        data:  { creditDeducted: true },
      })
    );
    expect(tx.studentProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { credits: { decrement: 1 } } })
    );
    expect(tx.lessonCreditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'DEBIT', amount: -1 }) })
    );
  });

  it('does NOT deduct when updateMany returns count=0 (concurrent transaction won)', async () => {
    const tx = makeTx();
    tx.attendance.findFirst.mockResolvedValue({
      id: 1, status: 'PRESENT', creditDeducted: false, sessionStudentId: 10,
    });
    // Another transaction already flipped creditDeducted to true — this one loses the race
    tx.attendance.updateMany.mockResolvedValue({ count: 0 });

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.attendance.updateMany).toHaveBeenCalled();
    expect(tx.studentProfile.update).not.toHaveBeenCalled(); // loser: no deduction
    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
  });

  it('does NOT call updateMany when existing.creditDeducted is already true', async () => {
    const tx = makeTx();
    tx.attendance.findFirst.mockResolvedValue({
      id: 1, status: 'PRESENT', creditDeducted: true, sessionStudentId: 10,
    });

    await markAttendance(tx, { ...BASE_PARAMS, status: 'ABSENT' });

    expect(tx.attendance.updateMany).not.toHaveBeenCalled();
    expect(tx.studentProfile.update).not.toHaveBeenCalled();
  });
});

describe('markAttendance — student not found', () => {
  it('throws STUDENT_NOT_FOUND when studentProfile is null', async () => {
    const tx = makeTx();
    tx.studentProfile.findUnique.mockResolvedValue(null);

    await expect(
      markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' })
    ).rejects.toThrow('STUDENT_NOT_FOUND');

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
  });
});

describe('markAttendance — paused group guard', () => {
  it('throws before deducting credits when group is PAUSED', async () => {
    const tx = makeTx();
    tx.lessonSession.findFirst.mockResolvedValue({
      status: 'IN_PROGRESS',
      lessonBlock: { studentGroup: { status: 'PAUSED', deletedAt: null } },
    });

    await expect(
      markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' })
    ).rejects.toThrow('Cannot submit attendance for paused group');

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
  });
});

describe('markAttendance — session status guard (Phase 6)', () => {
  it('throws SESSION_NOT_FOUND when session does not exist', async () => {
    const tx = makeTx();
    tx.lessonSession.findFirst.mockResolvedValue(null);

    await expect(
      markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' })
    ).rejects.toThrow('SESSION_NOT_FOUND');

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
  });

  it('throws SESSION_NOT_SUBMITTABLE for CANCELLED session', async () => {
    const tx = makeTx();
    tx.lessonSession.findFirst.mockResolvedValue({
      status: 'CANCELLED',
      lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } },
    });

    await expect(
      markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' })
    ).rejects.toThrow('SESSION_NOT_SUBMITTABLE');

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
  });

  it('throws SESSION_NOT_SUBMITTABLE for INVALIDATED session', async () => {
    const tx = makeTx();
    tx.lessonSession.findFirst.mockResolvedValue({
      status: 'INVALIDATED',
      lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } },
    });

    await expect(
      markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' })
    ).rejects.toThrow('SESSION_NOT_SUBMITTABLE');

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
  });

  it('throws SESSION_NOT_SUBMITTABLE for UPCOMING session (F-01)', async () => {
    const tx = makeTx();
    tx.lessonSession.findFirst.mockResolvedValue({
      status: 'UPCOMING',
      lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } },
    });

    await expect(
      markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' })
    ).rejects.toThrow('SESSION_NOT_SUBMITTABLE');

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
  });

  it('throws SESSION_NOT_SUBMITTABLE for LOCKED session (F-01)', async () => {
    const tx = makeTx();
    tx.lessonSession.findFirst.mockResolvedValue({
      status: 'LOCKED',
      lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } },
    });

    await expect(
      markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' })
    ).rejects.toThrow('SESSION_NOT_SUBMITTABLE');

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.lessonCreditLog.create).not.toHaveBeenCalled();
  });

  it('proceeds normally for IN_PROGRESS session', async () => {
    const tx = makeTx();
    tx.lessonSession.findFirst.mockResolvedValue({
      status: 'IN_PROGRESS',
      lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } },
    });

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.studentProfile.update).toHaveBeenCalled();
  });

  it('proceeds normally for COMPLETED session', async () => {
    const tx = makeTx();
    tx.lessonSession.findFirst.mockResolvedValue({
      status: 'COMPLETED',
      lessonBlock: { studentGroup: { status: 'ACTIVE', deletedAt: null } },
    });

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.studentProfile.update).toHaveBeenCalled();
  });
});

describe('markAttendance — F-04: FOR UPDATE lock guarantees ACTIVE FREEZE ⇒ NO CREDIT DEDUCTION', () => {
  it('acquires FOR UPDATE lock on StudentProfile before freeze check', async () => {
    const tx = makeTx();

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    // Lock must come before the freeze check: $executeRaw index < studentFreeze.findMany index
    const lockCallOrder = tx.$executeRaw.mock.invocationCallOrder[0];
    const freezeCallOrder = tx.studentFreeze.findMany.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(freezeCallOrder);
  });

  it('skips deduction when freeze exists (freeze wins)', async () => {
    const tx = makeTx();
    tx.studentFreeze.findMany.mockResolvedValue([{ id: 9, type: 'PERIOD', reason: null, studentProfileId: 7 }]);

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.lessonCreditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'FREEZE_SKIP', amount: 0 }),
      })
    );
  });

  it('deducts normally when no freeze exists (no freeze = deduct)', async () => {
    const tx = makeTx();
    // studentFreeze.findMany already returns [] by default

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.studentProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { credits: { decrement: 1 } } })
    );
    expect(tx.lessonCreditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'DEBIT', amount: -1 }) })
    );
  });

  it('no double deduction: second call with creditDeducted=true skips lock and deduction', async () => {
    const tx = makeTx();
    tx.attendance.findFirst.mockResolvedValue({
      id: 1, status: 'PRESENT', creditDeducted: true, sessionStudentId: 10,
    });

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    // wantDeduct is false (creditDeducted already true), so lock is not needed
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.studentProfile.update).not.toHaveBeenCalled();
  });

  it('freeze always blocks the deduction: status=PRESENT is kept but no credit is charged', async () => {
    const tx = makeTx();
    tx.studentFreeze.findMany.mockResolvedValue([{ id: 11, type: 'LESSON_SKIP', reason: null, studentProfileId: 7 }]);

    await markAttendance(tx, { ...BASE_PARAMS, status: 'PRESENT' });

    expect(tx.studentProfile.update).not.toHaveBeenCalled();
    expect(tx.attendance.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ status: 'PRESENT', creditDeducted: false }),
        ]),
      })
    );
  });
});
