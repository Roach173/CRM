/**
 * Unit tests for validateSessionTimeBounds (F-03 canonical time SOT).
 *
 * validateSessionTimeBounds compares HH:mm strings lexicographically against
 * the SchoolSchedulePolicy active for the target date.
 */
import {
  ScheduleValidationError,
  expandExcludedBlockIds,
  formatNonWorkingDaysError,
  validateScheduleBlock,
  validateSessionTimeBounds,
  validateSingleSessionOverride,
  checkStudentScheduleConflicts,
  findStudentScheduleConflicts,
  classifyBlockVisibility,
  computeConflictEligible,
  stillLiveBlockFilter,
} from '../../services/scheduleValidation';

function makePrisma(school: { workStart: string; workEnd: string } | null) {
  return {
    school: {
      findFirst: jest.fn().mockResolvedValue(school ? { id: SCHOOL_ID } : null),
    },
    schoolSchedulePolicy: {
      findFirst: jest.fn().mockResolvedValue(school
        ? { activeDays: [0, 1, 2, 3, 4], workStart: school.workStart, workEnd: school.workEnd, slotDuration: 60 }
        : null),
    },
  } as any;
}

const SCHOOL_ID = 1;

describe('validateSessionTimeBounds — F-03', () => {
  it('returns valid=true when times are inside working hours', async () => {
    const prisma = makePrisma({ workStart: '08:00', workEnd: '20:00' });

    const result = await validateSessionTimeBounds(prisma, SCHOOL_ID, '09:00', '10:30');

    expect(result).toEqual({ valid: true });
  });

  it('returns valid=false when startTime is before workStart', async () => {
    const prisma = makePrisma({ workStart: '08:00', workEnd: '20:00' });

    const result = await validateSessionTimeBounds(prisma, SCHOOL_ID, '07:30', '09:00');

    expect(result).toMatchObject({ valid: false, reason: expect.stringContaining('07:30') });
    expect(result).toMatchObject({ valid: false, reason: expect.stringContaining('08:00') });
  });

  it('returns valid=false when endTime is after workEnd', async () => {
    const prisma = makePrisma({ workStart: '08:00', workEnd: '20:00' });

    const result = await validateSessionTimeBounds(prisma, SCHOOL_ID, '19:00', '21:00');

    expect(result).toMatchObject({ valid: false, reason: expect.stringContaining('21:00') });
    expect(result).toMatchObject({ valid: false, reason: expect.stringContaining('20:00') });
  });

  it('returns valid=true at exact workStart boundary (start == workStart)', async () => {
    const prisma = makePrisma({ workStart: '08:00', workEnd: '20:00' });

    const result = await validateSessionTimeBounds(prisma, SCHOOL_ID, '08:00', '09:30');

    expect(result).toEqual({ valid: true });
  });

  it('returns valid=true at exact workEnd boundary (end == workEnd)', async () => {
    const prisma = makePrisma({ workStart: '08:00', workEnd: '20:00' });

    const result = await validateSessionTimeBounds(prisma, SCHOOL_ID, '18:30', '20:00');

    expect(result).toEqual({ valid: true });
  });

  it('returns valid=false with reason "School not found" when school is null', async () => {
    const prisma = makePrisma(null);

    const result = await validateSessionTimeBounds(prisma, SCHOOL_ID, '09:00', '10:00');

    expect(result).toEqual({ valid: false, reason: 'School not found' });
  });
});

describe('formatNonWorkingDaysError', () => {
  it('reports the submitted invalid days and compact school working days', () => {
    expect(formatNonWorkingDaysError([6], [0, 1, 2, 3, 4])).toBe(
      'Выбраны нерабочие дни: Вс. Рабочие дни школы: Пн–Пт.',
    );
  });
});

function makeBlock(
  id: number,
  parentBlockId: number | null,
  studentGroupId = 31,
  cabinetId = 14,
  type = 'GRAMMAR',
  teacherId = 40,
) {
  return {
    id,
    parentBlockId,
    schoolId: SCHOOL_ID,
    deletedAt: null,
    teacherId,
    studentGroupId,
    cabinetId,
    startTime: '08:00',
    endTime: '09:00',
    days: [0, 2],
    startDate: id === 29 ? new Date('2026-06-15T00:00:00.000Z') : new Date('2026-06-27T00:00:00.000Z'),
    endDate: id === 29 ? new Date('2026-06-26T00:00:00.000Z') : null,
    type,
    level: 'Intermediate',
    teacher: { user: { firstName: 'Тимур', lastName: 'Алиев' } },
    cabinet: { id: cabinetId, name: `Кабинет ${cabinetId}` },
    studentGroup: { id: studentGroupId, level: 'Intermediate', deletedAt: null },
  };
}

function makeValidationPrisma(blocks: Array<ReturnType<typeof makeBlock>>) {
  const findBlocks = (where: any) => {
    let result = blocks;
    if (where?.id?.in) result = result.filter(b => where.id.in.includes(b.id));
    if (where?.id?.notIn) result = result.filter(b => !where.id.notIn.includes(b.id));
    if (where?.parentBlockId?.in) result = result.filter(b => where.parentBlockId.in.includes(b.parentBlockId));
    if (where?.teacherId) result = result.filter(b => b.teacherId === where.teacherId);
    if (where?.cabinetId) result = result.filter(b => b.cabinetId === where.cabinetId);
    if (where?.studentGroupId) result = result.filter(b => b.studentGroupId === where.studentGroupId);
    return result;
  };

  return {
    school: {
      findFirst: jest.fn().mockResolvedValue({ id: SCHOOL_ID }),
    },
    schoolSchedulePolicy: {
      findFirst: jest.fn().mockResolvedValue({ activeDays: [0, 1, 2, 3, 4], workStart: '08:00', workEnd: '20:00', slotDuration: 60 }),
    },
    cabinet: {
      findFirst: jest.fn().mockResolvedValue({ id: 14, capacity: 10 }),
    },
    studentGroup: {
      findFirst: jest.fn().mockResolvedValue({
        id: 31,
        _count: { memberships: 0 },
        memberships: [],
      }),
    },
    studentProfile: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    staffProfile: {
      findUnique: jest.fn().mockResolvedValue({
        id: 40,
        workingDays: [0, 1, 2, 3, 4],
        maxLessonsPerDay: null,
        user: { firstName: 'Тимур', lastName: 'Алиев' },
      }),
    },
    lessonBlock: {
      findMany: jest.fn(({ where }: any) => Promise.resolve(findBlocks(where))),
    },
  } as any;
}

function validationData(blockId: number) {
  return {
    schoolId: SCHOOL_ID,
    cabinetId: 14,
    teacherId: 40,
    startTime: '08:00',
    endTime: '09:00',
    days: [0, 2],
    startDate: new Date('2026-06-22T00:00:00.000Z'),
    endDate: null,
    maxStudents: 10,
    studentGroupId: 31,
    blockId,
    excludeBlockIds: [blockId],
    isAdminOrOwner: true,
    blockType: 'GRAMMAR',
    policyDate: new Date('2026-06-22T00:00:00.000Z'),
  };
}

describe('LessonBlock version-chain exclusions', () => {
  it('editing old pair from policy-conflict flow excludes future child pair', async () => {
    const prisma = makeValidationPrisma([
      makeBlock(29, null),
      makeBlock(30, null, 31, 14, 'SPEAKING_CLUB', 35),
      makeBlock(31, 29),
      makeBlock(32, 30, 31, 14, 'SPEAKING_CLUB', 35),
    ]);

    await expect(validateScheduleBlock(prisma, {
      ...validationData(29),
      excludeBlockIds: [29, 30],
    })).resolves.toBe(true);
    await expect(expandExcludedBlockIds(prisma, [29, 30])).resolves.toEqual([29, 30, 31, 32]);
  });

  it('editing parent block excludes its future child', async () => {
    const prisma = makeValidationPrisma([makeBlock(29, null), makeBlock(31, 29)]);

    await expect(validateScheduleBlock(prisma, validationData(29))).resolves.toBe(true);
    await expect(expandExcludedBlockIds(prisma, [29])).resolves.toEqual([29, 31]);
  });

  it('editing child block excludes its parent', async () => {
    const prisma = makeValidationPrisma([makeBlock(29, null), makeBlock(31, 29)]);

    await expect(validateScheduleBlock(prisma, validationData(31))).resolves.toBe(true);
    await expect(expandExcludedBlockIds(prisma, [31])).resolves.toEqual([29, 31]);
  });

  it('still fails on a real conflict with an unrelated block', async () => {
    const prisma = makeValidationPrisma([
      makeBlock(29, null),
      makeBlock(31, 29),
      makeBlock(99, null, 99, 15),
    ]);

    await expect(validateScheduleBlock(prisma, validationData(29))).rejects.toThrow(ScheduleValidationError);
    await expect(expandExcludedBlockIds(prisma, [29])).resolves.toEqual([29, 31]);
  });
});

// ─── Student conflict detection — GroupMembership as the only source of truth ──
// The legacy StudentGroup.students/enrolledGroups relation is dead on the write
// path in production (only test fixtures and a one-time backfill script touch
// it), so conflict detection must read active GroupMembership rows exclusively.

function makeMembership(overrides: {
  studentProfileId?: number;
  blockDays?: number[];
  blockStart?: string;
  blockEnd?: string;
  blockStartDate?: Date | null;
  blockEndDate?: Date | null;
} = {}) {
  return {
    studentProfileId: overrides.studentProfileId ?? 7,
    studentProfile: { user: { firstName: 'Аяна', lastName: 'Иманова' } },
    studentGroup: {
      name: 'Advanced B2',
      level: 'B2',
      blocks: [{
        startTime: overrides.blockStart ?? '10:00',
        endTime: overrides.blockEnd ?? '11:00',
        days: overrides.blockDays ?? [1, 3],
        startDate: overrides.blockStartDate ?? new Date('2026-01-01T00:00:00.000Z'),
        endDate: overrides.blockEndDate ?? null,
      }],
    },
  };
}

function makeMembershipPrisma(memberships: ReturnType<typeof makeMembership>[]) {
  return {
    groupMembership: {
      findMany: jest.fn().mockResolvedValue(memberships),
    },
  } as any;
}

const CONFLICT_TARGET_BLOCK = {
  days: [1, 4],
  startTime: '10:30',
  endTime: '11:30',
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  endDate: null as Date | null,
};

describe('findStudentScheduleConflicts — GroupMembership as source of truth', () => {
  it('detects a conflict for a student with an overlapping ACTIVE GroupMembership', async () => {
    const prisma = makeMembershipPrisma([makeMembership()]);

    const conflicts = await findStudentScheduleConflicts(prisma, [7], CONFLICT_TARGET_BLOCK);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ studentProfileId: 7, studentName: 'Аяна Иманова' });
    // Only ACTIVE memberships are queried — status filter is baked into the where clause.
    expect(prisma.groupMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
  });

  it('returns no conflicts when the day ranges do not overlap', async () => {
    const prisma = makeMembershipPrisma([makeMembership({ blockDays: [2, 5] })]);

    await expect(findStudentScheduleConflicts(prisma, [7], CONFLICT_TARGET_BLOCK)).resolves.toHaveLength(0);
  });

  it('returns no conflicts when the time ranges do not overlap', async () => {
    const prisma = makeMembershipPrisma([makeMembership({ blockStart: '12:00', blockEnd: '13:00' })]);

    await expect(findStudentScheduleConflicts(prisma, [7], CONFLICT_TARGET_BLOCK)).resolves.toHaveLength(0);
  });

  it('excludes the current group via ignoreGroupId (no false positive against itself)', async () => {
    const prisma = makeMembershipPrisma([]);

    await findStudentScheduleConflicts(prisma, [7], { ...CONFLICT_TARGET_BLOCK, ignoreGroupId: 50 });

    expect(prisma.groupMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ studentGroupId: { not: 50 } }) }),
    );
  });

  it('returns immediately for an empty student list without querying the database', async () => {
    const prisma = makeMembershipPrisma([makeMembership()]);

    const conflicts = await findStudentScheduleConflicts(prisma, [], CONFLICT_TARGET_BLOCK);

    expect(conflicts).toEqual([]);
    expect(prisma.groupMembership.findMany).not.toHaveBeenCalled();
  });
});

describe('validateSingleSessionOverride — capacity fallback (no sessionStudent snapshot)', () => {
  function makeOverridePrisma(activeMembershipCount: number, cabinetCapacity: number) {
    return {
      staffProfile: { findUnique: jest.fn().mockResolvedValue(null) }, // skips checkTeacherWorkload
      lessonSession: { findMany: jest.fn().mockResolvedValue([]) }, // no other sessions to conflict with
      cabinet: { findFirst: jest.fn().mockResolvedValue({ id: 1, capacity: cabinetCapacity }) },
      sessionStudent: { count: jest.fn().mockResolvedValue(0) }, // no snapshot yet — triggers the fallback
      groupMembership: { count: jest.fn().mockResolvedValue(activeMembershipCount) },
    } as any;
  }

  const OVERRIDE_DATA = {
    sessionId: 1, date: new Date('2026-06-15'), schoolId: 10, cabinetId: 1, teacherId: 99,
    startTime: '09:00', endTime: '10:00', studentGroupId: 5,
  };

  it('throws CAPACITY_WARNING using a live GroupMembership count, not the dead StudentGroup.students relation', async () => {
    const prisma = makeOverridePrisma(10, 5); // 10 active members, 5-seat cabinet
    await expect(validateSingleSessionOverride(prisma, OVERRIDE_DATA)).rejects.toThrow(/CAPACITY_WARNING/);
    expect(prisma.groupMembership.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ studentGroupId: 5, status: 'ACTIVE' }) }),
    );
  });

  it('does not throw when the active membership count is within cabinet capacity', async () => {
    const prisma = makeOverridePrisma(3, 5);
    await expect(validateSingleSessionOverride(prisma, OVERRIDE_DATA)).resolves.toBe(true);
  });
});

describe('checkStudentScheduleConflicts — throwing wrapper', () => {
  it('throws ScheduleValidationError with student/group/time details on conflict', async () => {
    const prisma = makeMembershipPrisma([makeMembership()]);

    await expect(
      checkStudentScheduleConflicts(prisma, [7], CONFLICT_TARGET_BLOCK)
    ).rejects.toThrow(/Аяна Иманова.*B2/);
  });

  it('resolves true when there is no conflict', async () => {
    const prisma = makeMembershipPrisma([]);

    await expect(checkStudentScheduleConflicts(prisma, [7], CONFLICT_TARGET_BLOCK)).resolves.toBe(true);
  });
});

// ─── classifyBlockVisibility — schedule truth-display read model ──────────────

function makeVisibilityBlock(overrides: {
  deletedAt?: Date | null;
  status?: 'UPCOMING' | 'COMPLETED' | 'CANCELLED';
  endDate?: Date | null;
  effectiveDays?: number[];
} = {}) {
  return {
    deletedAt: overrides.deletedAt ?? null,
    status: overrides.status ?? 'UPCOMING',
    endDate: overrides.endDate ?? null,
    effectiveDays: overrides.effectiveDays ?? [1, 3],
  };
}

const NOW = new Date('2026-07-05T00:00:00.000Z');
const PAST = new Date('2026-07-04T00:00:00.000Z');
const FUTURE = new Date('2026-08-01T00:00:00.000Z');

describe('classifyBlockVisibility — block visibility precedence', () => {
  it('classifies a plain block as ACTIVE', () => {
    expect(classifyBlockVisibility(makeVisibilityBlock(), null, NOW)).toEqual({
      blockVisibility: 'ACTIVE',
      visibilityReason: 'active block',
    });
  });

  it('classifies a soft-deleted block as SOFT_DELETED regardless of status', () => {
    const result = classifyBlockVisibility(makeVisibilityBlock({ deletedAt: NOW, status: 'CANCELLED' }), null, NOW);
    expect(result.blockVisibility).toBe('SOFT_DELETED');
    expect(result.visibilityReason).toContain('deletedAt is set');
  });

  it('SOFT_DELETED reason mentions session-backing when the block has sessions in the viewed range', () => {
    const withSessions = classifyBlockVisibility(
      { ...makeVisibilityBlock({ deletedAt: NOW }), sessionCountInRange: 3 }, null, NOW,
    );
    expect(withSessions.blockVisibility).toBe('SOFT_DELETED');
    expect(withSessions.visibilityReason).toContain('soft-deleted block with sessions in viewed week');

    const withoutSessions = classifyBlockVisibility(
      { ...makeVisibilityBlock({ deletedAt: NOW }), sessionCountInRange: 0 }, null, NOW,
    );
    expect(withoutSessions.visibilityReason).not.toContain('sessions in viewed week');
  });

  it('deletedAt outranks CANCELLED (rule 1 before rule 2)', () => {
    // blockArchiveService sets CANCELLED + deletedAt together — must land in SOFT_DELETED, not CANCELLED.
    expect(classifyBlockVisibility(makeVisibilityBlock({ deletedAt: NOW, status: 'CANCELLED' }), null, NOW).blockVisibility)
      .toBe('SOFT_DELETED');
  });

  it('classifies an undeleted CANCELLED block as CANCELLED', () => {
    // PATCH /:id/status sets status alone — the real, reachable, undeleted CANCELLED case.
    expect(classifyBlockVisibility(makeVisibilityBlock({ status: 'CANCELLED' }), null, NOW))
      .toEqual({ blockVisibility: 'CANCELLED', visibilityReason: 'status CANCELLED' });
  });

  it('classifies a COMPLETED block as COMPLETED even with an already-passed endDate', () => {
    // completeGroup() sets endDate+COMPLETED together — status outranks endDate (rule 3 before 4).
    expect(classifyBlockVisibility(makeVisibilityBlock({ status: 'COMPLETED', endDate: PAST }), null, NOW))
      .toEqual({ blockVisibility: 'COMPLETED', visibilityReason: 'status COMPLETED' });
  });

  it('classifies an UPCOMING block with a passed endDate as CLOSED_BY_END_DATE', () => {
    // Reschedule/split: parent block gets endDate but keeps status UPCOMING.
    expect(classifyBlockVisibility(makeVisibilityBlock({ endDate: PAST }), null, NOW))
      .toEqual({ blockVisibility: 'CLOSED_BY_END_DATE', visibilityReason: 'endDate already passed' });
  });

  it('does not classify as CLOSED_BY_END_DATE when endDate is in the future', () => {
    expect(classifyBlockVisibility(makeVisibilityBlock({ endDate: FUTURE }), null, NOW).blockVisibility)
      .toBe('ACTIVE');
  });

  it('classifies a block with no effective days as OUT_OF_GRID', () => {
    expect(classifyBlockVisibility(makeVisibilityBlock({ effectiveDays: [] }), null, NOW))
      .toEqual({ blockVisibility: 'OUT_OF_GRID', visibilityReason: 'slot is not in current schedule grid' });
  });

  it('classifies an otherwise-active block on a COMPLETED group as HISTORICAL', () => {
    expect(classifyBlockVisibility(makeVisibilityBlock(), { status: 'COMPLETED' } as any, NOW))
      .toEqual({ blockVisibility: 'HISTORICAL', visibilityReason: 'group is not active' });
  });

  it('does not flag a PAUSED group as HISTORICAL — PAUSED keeps its own non-read-only UX', () => {
    // Rule 6 checks the literal studentGroup.status === 'COMPLETED', not the broader
    // isInactiveGroup() notion, which would also catch PAUSED groups.
    expect(classifyBlockVisibility(makeVisibilityBlock(), { status: 'PAUSED' } as any, NOW).blockVisibility)
      .toBe('ACTIVE');
  });
});

describe('computeConflictEligible — alignment with stillLiveBlockFilter', () => {
  // Unlike classifyBlockVisibility above, computeConflictEligible reads the real
  // system clock (new Date()) rather than taking NOW as a parameter — so its
  // fixtures must be relative to Date.now(), not the fictional NOW/PAST/FUTURE
  // timeline, or this describe block expires the moment real time passes FUTURE.
  const REAL_FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const REAL_PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  it('is true for a block with no endDate', () => {
    expect(computeConflictEligible({ deletedAt: null, endDate: null })).toBe(true);
  });

  it('is true for a block whose endDate has not yet passed', () => {
    expect(computeConflictEligible({ deletedAt: null, endDate: REAL_FUTURE })).toBe(true);
  });

  it('is false for a block whose endDate has already passed', () => {
    expect(computeConflictEligible({ deletedAt: null, endDate: REAL_PAST })).toBe(false);
  });

  it('is false for a soft-deleted block regardless of endDate', () => {
    expect(computeConflictEligible({ deletedAt: NOW, endDate: null })).toBe(false);
  });

  it('produces the same OR shape as stillLiveBlockFilter (same predicate, two forms)', () => {
    const filter = stillLiveBlockFilter();
    expect(filter.OR).toEqual([{ endDate: null }, { endDate: { gte: expect.any(Date) } }]);
  });

  it('known gap (reported, not fixed here): an undeleted CANCELLED block is read-only but still conflictEligible', () => {
    // None of the 5 conflict-check query sites filter on `status`, only deletedAt/endDate —
    // whether cancelling a block should free its teacher/cabinet slot is a separate decision.
    const block = makeVisibilityBlock({ status: 'CANCELLED' });
    const { blockVisibility } = classifyBlockVisibility(block, null, NOW);
    expect(blockVisibility).toBe('CANCELLED');
    expect(computeConflictEligible(block)).toBe(true);
  });
});
