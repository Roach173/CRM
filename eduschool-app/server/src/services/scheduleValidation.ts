import { PrismaClient, BlockStatus, GroupStatus } from '@prisma/client';
import { getEffectiveSessionTeacherId } from './sessionService';
import { getPolicyForDate } from './policyService';

// Works for both PrismaClient and Prisma transaction client (tx)
type DbClient = Pick<PrismaClient,
  'school' | 'cabinet' | 'studentGroup' | 'studentProfile' |
  'lessonBlock' | 'staffProfile' | 'lessonSession' | 'sessionStudent' |
  'schoolSchedulePolicy' | 'groupMembership'
>;

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

const DAY_NAMES: Record<number, string> = {
  0: 'Пн', 1: 'Вт', 2: 'Ср', 3: 'Чт', 4: 'Пт', 5: 'Сб', 6: 'Вс',
};

function formatDayList(days: number[]): string {
  return days.map(d => DAY_NAMES[d] ?? d).join(', ');
}

export function formatWorkingDays(days: number[]): string {
  const sorted = Array.from(new Set(days)).sort((a, b) => a - b);
  const monToFri = [0, 1, 2, 3, 4];
  const monToSat = [0, 1, 2, 3, 4, 5];
  const monToSun = [0, 1, 2, 3, 4, 5, 6];
  if (sorted.length === monToFri.length && sorted.every((d, i) => d === monToFri[i])) return 'Пн–Пт';
  if (sorted.length === monToSat.length && sorted.every((d, i) => d === monToSat[i])) return 'Пн–Сб';
  if (sorted.length === monToSun.length && sorted.every((d, i) => d === monToSun[i])) return 'Пн–Вс';
  return formatDayList(sorted);
}

export function formatNonWorkingDaysError(invalidDays: number[], activeDays: number[]): string {
  return `Выбраны нерабочие дни: ${formatDayList(invalidDays)}. Рабочие дни школы: ${formatWorkingDays(activeDays)}.`;
}

export async function expandExcludedBlockIds(prisma: DbClient, ids: number[]): Promise<number[]> {
  const expanded = new Set(ids.filter(id => Number.isInteger(id) && id > 0));
  if (expanded.size === 0) return [];

  let changed = true;
  while (changed) {
    changed = false;
    const currentIds = [...expanded];
    const blocks = await prisma.lessonBlock.findMany({
      where: { id: { in: currentIds }, deletedAt: null },
      select: { id: true, parentBlockId: true },
    });
    for (const block of blocks) {
      if (block.parentBlockId && !expanded.has(block.parentBlockId)) {
        expanded.add(block.parentBlockId);
        changed = true;
      }
    }

    const children = await prisma.lessonBlock.findMany({
      where: { parentBlockId: { in: [...expanded] }, deletedAt: null },
      select: { id: true },
    });
    for (const child of children) {
      if (!expanded.has(child.id)) {
        expanded.add(child.id);
        changed = true;
      }
    }
  }

  return [...expanded].sort((a, b) => a - b);
}

export function daysOverlap(days1: number[], days2: number[]): boolean {
  const set1 = new Set(days1);
  return days2.some(d => set1.has(d));
}

export function timeRangesOverlap(start1: string, end1: string, start2: string, end2: string): boolean {
  return start1 < end2 && start2 < end1;
}

export function dateRangesOverlap(start1: Date | null, end1: Date | null, start2: Date | null, end2: Date | null): boolean {
  const s1 = start1 ?? new Date(0);
  const e1 = end1 ?? new Date('2099-12-31');
  const s2 = start2 ?? new Date(0);
  const e2 = end2 ?? new Date('2099-12-31');
  return s1 <= e2 && s2 <= e1;
}

/**
 * A block that's closed (`endDate` already in the past) no longer occupies its
 * slot — completeGroup()/GroupPromotionService close a group's blocks via
 * `endDate` + `status` without deleting them (membership on a COMPLETED group
 * intentionally stays ACTIVE until the group is archived, see
 * groupLifecycleService.archiveGroup). Every "is this teacher/cabinet/group
 * slot already taken" query below must filter these out the same way
 * GET /schedule's rangeFilter does, or a promoted/completed group's old slot
 * conflicts forever with any new block reusing that day/time.
 */
export function stillLiveBlockFilter() {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  return { OR: [{ endDate: null }, { endDate: { gte: startOfToday } }] };
}

/** Same condition as stillLiveBlockFilter(), as a plain boolean for classification/response use. */
export function computeConflictEligible(block: { deletedAt: Date | null; endDate: Date | null }): boolean {
  if (block.deletedAt != null) return false;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  return block.endDate == null || block.endDate >= startOfToday;
}

export type BlockVisibility =
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'CLOSED_BY_END_DATE'
  | 'SOFT_DELETED'
  | 'OUT_OF_GRID'
  | 'HISTORICAL';

export interface BlockVisibilityResult {
  blockVisibility: BlockVisibility;
  visibilityReason: string;
}

/**
 * Block-level, as-of-`now` classification of "is this LessonBlock still an
 * active, editable schedule entry" — the read-model source of truth behind
 * GET /schedule's blockVisibility/isReadOnly/isScheduleActive fields.
 *
 * Precedence matters and is verified against actual write paths (not just an
 * arbitrary order): blockArchiveService is the only place that sets CANCELLED
 * *together with* deletedAt (so deletedAt must outrank CANCELLED, rule 1
 * before 2); PATCH /:id/status sets CANCELLED alone (rule 2 is reachable);
 * completeGroup() sets endDate+COMPLETED together, never deletedAt (rule 3
 * before 4); a reschedule/split closes a block via endDate while status stays
 * UPCOMING (rule 4). Rule 6 deliberately checks the literal studentGroup
 * status 'COMPLETED' only, not the broader isInactiveGroup() notion — PAUSED
 * groups already have their own non-read-only UX and must not be folded in.
 *
 * This is a static, as-of-request-time snapshot, not a per-date reconstruction
 * of "was this active back then" — the caller (the schedule grid's per-cell
 * Session-first resolution) decides *whether* a date-cell shows this block's
 * plan at all; this function only supplies the badge/reason once that's decided.
 */
export function classifyBlockVisibility(
  block: {
    deletedAt: Date | null; status: BlockStatus; endDate: Date | null; effectiveDays: number[];
    /** Sessions this block has within the currently-requested week/range, if known — additive, only present on the ranged branch. */
    sessionCountInRange?: number;
  },
  studentGroup: { status: GroupStatus } | null,
  now: Date,
): BlockVisibilityResult {
  if (block.deletedAt != null) {
    const hasSessions = (block.sessionCountInRange ?? 0) > 0;
    const reason = hasSessions
      ? `soft-deleted block with sessions in viewed week (deletedAt: ${block.deletedAt.toISOString()}, status: ${block.status})`
      : `deletedAt is set (${block.deletedAt.toISOString()}, status: ${block.status})`;
    return { blockVisibility: 'SOFT_DELETED', visibilityReason: reason };
  }
  if (block.status === 'CANCELLED') {
    return { blockVisibility: 'CANCELLED', visibilityReason: 'status CANCELLED' };
  }
  if (block.status === 'COMPLETED') {
    return { blockVisibility: 'COMPLETED', visibilityReason: 'status COMPLETED' };
  }
  if (block.endDate != null && block.endDate < now) {
    return { blockVisibility: 'CLOSED_BY_END_DATE', visibilityReason: 'endDate already passed' };
  }
  if (block.effectiveDays.length === 0) {
    return { blockVisibility: 'OUT_OF_GRID', visibilityReason: 'slot is not in current schedule grid' };
  }
  if (studentGroup?.status === 'COMPLETED') {
    return { blockVisibility: 'HISTORICAL', visibilityReason: 'group is not active' };
  }
  return { blockVisibility: 'ACTIVE', visibilityReason: 'active block' };
}

export interface ScheduleConflictMatch {
  studentProfileId: number;
  studentName: string;
  groupName: string;
  conflictLevel: string;
  blockStartTime: string;
  blockEndTime: string;
  conflictingDays: string;
}

/**
 * Single low-level source of truth for "is this student already scheduled at this
 * time via an active GroupMembership". GroupMembership is the only source written
 * to by any live enrollment flow — the legacy StudentGroup.students/enrolledGroups
 * relation is not written by any production route and must not be consulted here.
 */
export async function findStudentScheduleConflicts(
  prisma: DbClient,
  studentProfileIds: number[],
  targetBlock: {
    days: number[];
    startTime: string;
    endTime: string;
    startDate: Date | null;
    endDate: Date | null;
    ignoreGroupId?: number;
  },
): Promise<ScheduleConflictMatch[]> {
  if (studentProfileIds.length === 0) return [];

  const memberships = await prisma.groupMembership.findMany({
    where: {
      studentProfileId: { in: studentProfileIds },
      status: 'ACTIVE',
      studentGroupId: targetBlock.ignoreGroupId ? { not: targetBlock.ignoreGroupId } : undefined,
    },
    include: {
      studentProfile: { include: { user: { select: { firstName: true, lastName: true } } } },
      studentGroup: {
        select: {
          level: true,
          blocks: {
            where: { deletedAt: null, ...stillLiveBlockFilter() },
            select: { startTime: true, endTime: true, days: true, startDate: true, endDate: true },
          },
        },
      },
    },
  });

  const conflicts: ScheduleConflictMatch[] = [];
  for (const m of memberships) {
    for (const block of m.studentGroup.blocks) {
      if (
        timeRangesOverlap(block.startTime, block.endTime, targetBlock.startTime, targetBlock.endTime) &&
        daysOverlap(block.days, targetBlock.days) &&
        dateRangesOverlap(block.startDate, block.endDate, targetBlock.startDate, targetBlock.endDate)
      ) {
        conflicts.push({
          studentProfileId: m.studentProfileId,
          studentName: `${m.studentProfile.user.firstName} ${m.studentProfile.user.lastName}`.trim(),
          groupName: m.studentGroup.level,
          conflictLevel: m.studentGroup.level,
          blockStartTime: block.startTime,
          blockEndTime: block.endTime,
          conflictingDays: block.days.filter(d => targetBlock.days.includes(d)).map(d => DAY_NAMES[d] ?? d).join(', '),
        });
        break; // one conflict is enough per student
      }
    }
  }

  return conflicts;
}

export async function checkStudentScheduleConflicts(
  prisma: DbClient,
  studentProfileIds: number[],
  targetBlock: {
    days: number[];
    startTime: string;
    endTime: string;
    startDate: Date;
    endDate: Date | null;
    ignoreGroupId?: number;
  },
  // Kept in the signature for backwards compat — this is a hard block (exact
  // time+day overlap), never overridable, so the flag is intentionally ignored.
  _overrideStudentConflict?: boolean
) {
  const conflicts = await findStudentScheduleConflicts(prisma, studentProfileIds, targetBlock);
  if (conflicts.length > 0) {
    const c = conflicts[0];
    throw new ScheduleValidationError(
      `Конфликт расписания: студент ${c.studentName} уже учится в группе '${c.groupName}' в это время (${c.blockStartTime}–${c.blockEndTime}, дни: ${c.conflictingDays}).`
    );
  }
  return true;
}

export async function validateScheduleBlock(
  prisma: DbClient,
  data: {
    schoolId: number;
    cabinetId: number | null;
    teacherId: number | null;
    startTime: string;
    endTime: string;
    days: number[];
    startDate: Date;
    endDate: Date | null;
    maxStudents: number;
    studentGroupId: number | null;
    overrideCabinetConflict?: boolean;
    overrideStudentConflict?: boolean;
    overrideTeacherConflict?: boolean;
    blockId?: number;
    excludeBlockIds?: number[];
    isAdminOrOwner?: boolean;
    blockType?: string;
    policyDate?: Date;
  }
) {
  const directExcludeBlockIds = Array.from(new Set(
    [data.blockId, ...(data.excludeBlockIds ?? [])]
      .filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
  ));
  const excludeBlockIds = await expandExcludedBlockIds(prisma, directExcludeBlockIds);
  const idFilter = excludeBlockIds.length > 0 ? { notIn: excludeBlockIds } : undefined;

  // 1. Проверка рабочих дней школы
  // 2. Обязательность кабинета и учителя
  if (!data.cabinetId) {
    throw new ScheduleValidationError('Кабинет не указан. Поле cabinetId обязательно.');
  }
  if (!data.teacherId && data.blockType !== 'SPEAKING_CLUB') {
    throw new ScheduleValidationError('Учитель не назначен. Выбор учителя обязателен.');
  }

  // Параллельно получаем school, cabinet и studentGroup
  const [school, policy, cabinet, studentGroup] = await Promise.all([
    prisma.school.findFirst({
      where: { id: data.schoolId, deletedAt: null },
      select: { id: true },
    }),
    getPolicyForDate(data.schoolId, data.policyDate ?? data.startDate, prisma as any),
    prisma.cabinet.findFirst({ where: { id: data.cabinetId, schoolId: data.schoolId } }),
    data.studentGroupId
      ? prisma.studentGroup.findFirst({
          where: { id: data.studentGroupId, schoolId: data.schoolId },
          include: {
            _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
            memberships: { where: { status: 'ACTIVE' }, select: { studentProfileId: true } },
          },
        })
      : Promise.resolve(null),
  ]);

  if (!school) {
    throw new ScheduleValidationError('School not found');
  }

  const policyActiveDays: number[] = (policy.activeDays ?? []).length > 0
    ? policy.activeDays
    : [0, 1, 2, 3, 4];
  const activeSet = new Set(policyActiveDays);
  const nonWorkingDays = data.days.filter(d => !activeSet.has(d));
  if (nonWorkingDays.length > 0) {
    throw new ScheduleValidationError(formatNonWorkingDaysError(nonWorkingDays, policyActiveDays));
  }

  // 2.5. Проверка нагрузки учителя
  // ponytail: teacher tenant-scoping is enforced at every call site (handlers
  // resolve teacherId from a client userId via findFirst + user.schoolId), so a
  // foreign teacherId can't reach here. Cabinet/studentGroup below have no such
  // upstream gate, so they're scoped in this shared validator instead.
  if (data.teacherId) {
    await checkTeacherWorkload(
      prisma,
      data.teacherId,
      data.days,
      data.overrideTeacherConflict,
      excludeBlockIds
    );
  }

  // 3. Контроль вместимости
  if (!cabinet) {
    throw new ScheduleValidationError('Кабинет не найден.');
  }

  let realStudentsCount = 0;
  if (studentGroup) {
    realStudentsCount = studentGroup._count.memberships;

    // Check student schedule conflicts
    const studentIds = studentGroup.memberships.map((m: { studentProfileId: number }) => m.studentProfileId);
    await checkStudentScheduleConflicts(
      prisma,
      studentIds,
      {
        days: data.days,
        startTime: data.startTime,
        endTime: data.endTime,
        startDate: data.startDate,
        endDate: data.endDate,
        ignoreGroupId: data.studentGroupId ?? undefined,
      },
      data.overrideStudentConflict
    );
  }

  if (realStudentsCount > cabinet.capacity) {
    if (!data.overrideCabinetConflict) {
      throw new ScheduleValidationError(`CAPACITY_WARNING:Кабинет рассчитан на ${cabinet.capacity} чел., а в группе уже ${realStudentsCount} студ.`);
    }
  }

  // 4. Проверка коллизий кабинета
  const cabinetConflicts = await prisma.lessonBlock.findMany({
    where: {
      schoolId: data.schoolId,
      cabinetId: data.cabinetId,
      deletedAt: null,
      id: idFilter,
      AND: [
        stillLiveBlockFilter(),
        { OR: [{ studentGroupId: null }, { studentGroup: { deletedAt: null } }] },
      ],
    },
    include: {
      teacher: { include: { user: { select: { firstName: true, lastName: true } } } },
      studentGroup: { select: { level: true } }
    }
  });

  const cabinetBlockConflicts = (b: typeof cabinetConflicts[0]) => {
    // Grammar и Club одной группы делят кабинет — это не конфликт
    if (data.studentGroupId && b.studentGroupId === data.studentGroupId) return false;
    return timeRangesOverlap(b.startTime, b.endTime, data.startTime, data.endTime) &&
      daysOverlap(b.days, data.days) &&
      dateRangesOverlap(b.startDate, b.endDate, data.startDate, data.endDate);
  };

  const hasCabinetConflict = cabinetConflicts.some(cabinetBlockConflicts);

  if (hasCabinetConflict) {
    if (!data.isAdminOrOwner || !data.overrideCabinetConflict) {
      const conflictBlock = cabinetConflicts.find(cabinetBlockConflicts)!;
      const conflictDaysStr = conflictBlock.days.map(d => DAY_NAMES[d] ?? d).join(', ');
      
      const teacherName = conflictBlock.teacher?.user 
        ? `${conflictBlock.teacher.user.firstName} ${conflictBlock.teacher.user.lastName}`.trim() 
        : 'Учитель не назначен';
      const groupName = conflictBlock.studentGroup?.level || conflictBlock.level || 'Неизвестная группа';

      throw new ScheduleValidationError(
        `Конфликт: Кабинет уже занят. ${teacherName} ведет группу '${groupName}' с ${conflictBlock.startTime} до ${conflictBlock.endTime} (${conflictDaysStr}).`
      );
    }
  }

  // 5. Проверка коллизий учителя
  const teacherConflicts = await prisma.lessonBlock.findMany({
    where: {
      teacherId: data.teacherId,
      deletedAt: null,
      id: idFilter,
      AND: [
        stillLiveBlockFilter(),
        { OR: [{ studentGroupId: null }, { studentGroup: { deletedAt: null } }] },
      ],
    },
    include: {
      teacher: {
        include: { user: { select: { firstName: true, lastName: true } } }
      },
      cabinet: { select: { name: true } },
      studentGroup: { select: { level: true } }
    }
  });

  for (const b of teacherConflicts) {
    if (
      timeRangesOverlap(b.startTime, b.endTime, data.startTime, data.endTime) &&
      daysOverlap(b.days, data.days) &&
      dateRangesOverlap(b.startDate, b.endDate, data.startDate, data.endDate)
    ) {
      // Один учитель ведёт Grammar и Club одной группы — OK только если дни не пересекаются
      if (data.studentGroupId && b.studentGroupId === data.studentGroupId) {
        const overlappingDays = b.days.filter((d: number) => data.days.includes(d));
        if (overlappingDays.length === 0) continue;
        // Дни совпадают — учитель физически не может вести два урока одновременно
      }
      const teacherName = b.teacher?.user
        ? `${b.teacher.user.firstName} ${b.teacher.user.lastName}`.trim()
        : 'Учитель';
      const groupName = b.studentGroup?.level || b.level || 'Неизвестная группа';
      const cabinetName = b.cabinet?.name || `ID:${b.cabinetId}`;
      const conflictingDays = b.days
        .filter(d => data.days.includes(d))
        .map(d => DAY_NAMES[d] ?? d)
        .join(', ');

      throw new ScheduleValidationError(
        `Конфликт: Учитель ${teacherName} уже ведёт группу '${groupName}' с ${b.startTime} до ${b.endTime} в кабинете '${cabinetName}' (${conflictingDays}).`
      );
    }
  }

  // 6. Grammar/Club day overlap — студенты физически не могут быть на двух уроках одновременно.
  // Это не предупреждение — это жёсткое ограничение, override невозможен.
  if (data.studentGroupId) {
    const siblingBlocks = await prisma.lessonBlock.findMany({
      where: {
        studentGroupId: data.studentGroupId,
        schoolId: data.schoolId,
        deletedAt: null,
        ...(idFilter ? { id: idFilter } : {}),
        ...stillLiveBlockFilter(),
      },
    });
    for (const sb of siblingBlocks) {
      if (
        timeRangesOverlap(sb.startTime, sb.endTime, data.startTime, data.endTime) &&
        daysOverlap(sb.days as number[], data.days) &&
        dateRangesOverlap(sb.startDate, sb.endDate, data.startDate, data.endDate)
      ) {
        const overlapDays = (sb.days as number[])
          .filter((d: number) => data.days.includes(d))
          .map((d: number) => DAY_NAMES[d] ?? d)
          .join(', ');
        const blockLabel = sb.type === 'SPEAKING_CLUB' ? 'Разговорного клуба' : 'Грамматики';
        throw new ScheduleValidationError(
          `GRAMMAR_CLUB_DAY_CONFLICT:Блок ${blockLabel} этой группы уже занимает дни: ${overlapDays}. Студенты не могут быть на двух уроках одновременно.`
        );
      }
    }
  }

  return true;
}

export async function validateSingleSessionOverride(
  prisma: PrismaClient,
  data: {
    sessionId: number;
    date: Date;
    schoolId: number;
    cabinetId: number;
    teacherId: number;
    startTime: string;
    endTime: string;
    studentGroupId: number | null;
    overrideTeacherConflict?: boolean;
  }
) {
  // 0. Проверка нагрузки учителя
  const weekday = data.date.getUTCDay();
  const adjustedWeekday = (weekday === 0) ? 6 : weekday - 1;
  await checkTeacherWorkload(prisma, data.teacherId, [adjustedWeekday], data.overrideTeacherConflict);

  // Get all other uncancelled sessions on this date for the school
  const sessionsOnDate = await prisma.lessonSession.findMany({
    where: {
      schoolId: data.schoolId,
      date: data.date,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      id: { not: data.sessionId },
      lessonBlock: {
        OR: [
          { studentGroupId: null },
          { studentGroup: { deletedAt: null } }
        ]
      }
    },
    include: {
      lessonBlock: {
        select: { 
          startTime: true, 
          endTime: true, 
          cabinetId: true, 
          teacherId: true, 
          studentGroupId: true,
          studentGroup: { select: { level: true } },
          level: true,
          cabinet: { select: { name: true } }
        }
      },
      teacher: { include: { user: { select: { firstName: true, lastName: true } } } }
    }
  });

  for (const other of sessionsOnDate) {
    const otherStartTime = other.startTimeSnap ?? other.lessonBlock.startTime;
    const otherEndTime = other.endTimeSnap ?? other.lessonBlock.endTime;
    const otherCabinetId = other.cabinetIdSnap ?? other.lessonBlock.cabinetId;
    const otherTeacherId = getEffectiveSessionTeacherId(other) ?? other.lessonBlock.teacherId;

    if (timeRangesOverlap(otherStartTime, otherEndTime, data.startTime, data.endTime)) {
      const groupName = other.lessonBlock.studentGroup?.level || other.lessonBlock.level || 'Неизвестная группа';

      const cabinetName = (other.cabinetIdSnap && other.cabinetIdSnap !== other.lessonBlock.cabinetId)
        ? `ID:${other.cabinetIdSnap}`
        : (other.lessonBlock.cabinet?.name || `ID:${otherCabinetId}`);

      const teacherName = other.teacher?.user
        ? `${other.teacher.user.firstName} ${other.teacher.user.lastName}`.trim()
        : 'Учитель не назначен';

      // 0. Check Student Group self-conflict — same group cannot have two overlapping sessions.
      // Grammar+Club blocks of the same group are intentionally at different times; if they overlap
      // it is a scheduling error that must be blocked regardless of cabinet/teacher.
      if (data.studentGroupId !== null && other.lessonBlock.studentGroupId === data.studentGroupId) {
        throw new ScheduleValidationError(
          `Конфликт: у группы уже есть занятие в это время (${otherStartTime}–${otherEndTime}). Нельзя назначить два урока одновременно.`
        );
      }

      // 1. Check Cabinet conflict
      if (otherCabinetId === data.cabinetId) {
        // Same group can share cabinet (Grammar + Club) — handled above if they overlap
        if (!data.studentGroupId || other.lessonBlock.studentGroupId !== data.studentGroupId) {
          throw new ScheduleValidationError(
            `Конфликт: Кабинет уже занят. ${teacherName} ведет группу '${groupName}' с ${otherStartTime} до ${otherEndTime}.`
          );
        }
      }

      // 2. Check Teacher conflict
      if (otherTeacherId === data.teacherId) {
        if (!data.studentGroupId || other.lessonBlock.studentGroupId !== data.studentGroupId) {
          throw new ScheduleValidationError(
            `Конфликт: Учитель ${teacherName} уже ведёт группу '${groupName}' с ${otherStartTime} до ${otherEndTime} в кабинете '${cabinetName}'.`
          );
        }
      }
    }
  }

  // 3. Capacity control
  // Tenant isolation: the cabinet must belong to this school (cabinetId comes
  // from the request body via the session-details handler, which writes it to
  // cabinetIdSnap — a foreign cabinet must not be attachable).
  const cabinet = await prisma.cabinet.findFirst({ where: { id: data.cabinetId, schoolId: data.schoolId } });
  if (!cabinet) {
    throw new ScheduleValidationError('Кабинет не найден.');
  }

  let realStudentsCount = 0;
  if (data.studentGroupId) {
    const snapshot = await prisma.sessionStudent.count({
      where: { lessonSessionId: data.sessionId }
    });
    if (snapshot > 0) {
      realStudentsCount = snapshot;
    } else {
      // GroupMembership is the enrollment source of truth (see findStudentScheduleConflicts
      // above) — StudentGroup.students is dead on write and would always count 0 here.
      realStudentsCount = await prisma.groupMembership.count({
        where: { studentGroupId: data.studentGroupId, status: 'ACTIVE', leftAt: null },
      });
    }
  }

  if (realStudentsCount > cabinet.capacity) {
    throw new ScheduleValidationError(`CAPACITY_WARNING:Кабинет рассчитан на ${cabinet.capacity} чел., а на уроке ${realStudentsCount} студ.`);
  }

  return true;
}

export async function checkTeacherWorkload(
  prisma: any,
  teacherId: number,
  days: number[],
  override: boolean = false,
  ignoreBlockId?: number | number[]
) {
  if (override) return;

  const staff = await prisma.staffProfile.findUnique({
    where: { id: teacherId },
    include: { user: { select: { firstName: true, lastName: true } } }
  });

  if (!staff) return;

  // 1. Проверка рабочих дней
  const workingDaysSet = new Set(staff.workingDays);
  const invalidDays = days.filter(d => !workingDaysSet.has(d));

  if (invalidDays.length > 0) {
    const names = invalidDays.map(d => DAY_NAMES[d] ?? d).join(', ');
    throw new ScheduleValidationError(
      `TEACHER_CONFLICT_WARNING:Учитель ${staff.user.firstName} ${staff.user.lastName} не работает в эти дни: ${names}`
    );
  }

  // 2. Проверка лимита уроков в день
  if (staff.maxLessonsPerDay !== null) {
    const ignoredIds = Array.isArray(ignoreBlockId) ? ignoreBlockId : (ignoreBlockId ? [ignoreBlockId] : []);
    const existingBlocks = await prisma.lessonBlock.findMany({
      where: {
        teacherId: teacherId,
        deletedAt: null,
        ...(ignoredIds.length > 0 ? { id: { notIn: ignoredIds } } : {}),
        ...stillLiveBlockFilter(),
      },
      select: { days: true }
    });

    const countsByDay: Record<number, number> = {};
    for (const b of existingBlocks) {
      for (const d of b.days) {
        countsByDay[d] = (countsByDay[d] || 0) + 1;
      }
    }

    for (const d of days) {
      const currentCount = countsByDay[d] || 0;
      if (currentCount + 1 > staff.maxLessonsPerDay) {
        throw new ScheduleValidationError(
          `TEACHER_CONFLICT_WARNING:Учитель ${staff.user.firstName} ${staff.user.lastName} превышает лимит уроков в день (${staff.maxLessonsPerDay}) в день ${DAY_NAMES[d] ?? d}`
        );
      }
    }
  }
}

/**
 * Validates that newStartTime/newEndTime fall within the policy active for targetDate.
 * Canonical working-time SOT used by moveSession and rescheduleSession.
 * Time strings are HH:mm — lexicographic comparison is valid for ISO time format.
 */
export async function validateSessionTimeBounds(
  prisma: DbClient,
  schoolId: number,
  startTime: string,
  endTime: string,
  targetDate: Date = new Date(),
): Promise<{ valid: true } | { valid: false; reason: string }> {
  const school = await prisma.school.findFirst({
    where: { id: schoolId, deletedAt: null },
    select: { id: true },
  });

  if (!school) return { valid: false, reason: 'School not found' };
  const policy = await getPolicyForDate(schoolId, targetDate, prisma as any);

  if (startTime < policy.workStart) {
    return {
      valid: false,
      reason: `Start time ${startTime} is before policy work start ${policy.workStart}`,
    };
  }

  if (endTime > policy.workEnd) {
    return {
      valid: false,
      reason: `End time ${endTime} is after policy work end ${policy.workEnd}`,
    };
  }

  return { valid: true };
}
