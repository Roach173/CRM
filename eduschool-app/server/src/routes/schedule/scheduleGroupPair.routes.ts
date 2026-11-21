import { Router } from 'express';
import prisma from '../../lib/prisma';
import { authenticate, AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { BlockType, MemberStatus } from '@prisma/client';
import { CacheKeys } from '../../lib/cacheKeys';
import { cacheInvalidate } from '../../lib/cache';
import {
  ScheduleValidationError,
  validateScheduleBlock,
  daysOverlap,
} from '../../services/scheduleValidation';
import {
  syncSessionsForBlock,
  cleanupInvalidSessions,
} from '../../services/sessionService';
import { archiveLessonBlockInTx, LessonBlockArchiveResult } from '../../services/blockArchiveService';
import {
  assertCanChangeLevelChapter,
  GroupLifecycleError,
} from '../../services/groupLifecycleService';
import { sendLifecycleError } from '../../lib/routeError';
import {
  log, isAdminOrOwner, PAUSED_GROUP_OPERATION_ERROR, GROUP_HAS_ARCHIVED_HISTORY_CODE, GROUP_HAS_ARCHIVED_HISTORY_MESSAGE,
  parseOptionalIntStrict as parseOptionalInt, normalizeScheduleDays as normalizeDays,
  parseScheduleDateInput, previousUtcDate,
  utcWeekRangeFor, notifyTeacherAssigned, isInactiveGroup,
  emitScheduleStructureChanged, mapTeacher,
  resolveWritableTimeSlot, sendTimeSlotError, findProtectedFutureSessionsForSplit, invalidateSupersededFutureSessions,
} from './scheduleRouteUtils';
import type { SupersededSessionPlan } from './scheduleRouteUtils';

const router = Router();

// ─── POST /group-pair — атомарное создание пары Grammar+Club ─────────────────

router.post('/group-pair', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const {
      studentGroupId,
      timeSlotId,
      startTime: bodyStartTime,
      endTime: bodyEndTime,
      cabinetId,
      level,
      chapter,
      maxStudents,
      grammarTeacherId,
      grammarDays,
      clubTeacherId,
      clubDays,
      startDate,
      targetDate,
      overrideCabinetConflict,
      overrideTeacherConflict,
      overrideStudentConflict,
      confirmNewHistory,
    } = req.body;

    const parsedStudentGroupId = parseOptionalInt(studentGroupId);
    const parsedCabinetId = parseOptionalInt(cabinetId);
    const parsedChapter = parseOptionalInt(chapter) ?? 1;
    const parsedMaxStudents = parseOptionalInt(maxStudents) ?? 15;
    const normalizedGrammarDays = normalizeDays(grammarDays);
    const normalizedClubDays = normalizeDays(clubDays);
    const hasClub = normalizedClubDays.length > 0 || !!parseOptionalInt(clubTeacherId);

    if (!parsedStudentGroupId) return res.status(400).json({ success: false, error: 'Группа не указана' });
    if (!parsedCabinetId) return res.status(400).json({ success: false, error: 'Кабинет не указан' });
    if (normalizedGrammarDays.length === 0) return res.status(400).json({ success: false, error: 'Выберите дни грамматики' });
    if (hasClub && daysOverlap(normalizedGrammarDays, normalizedClubDays)) {
      return res.status(400).json({
        success: false,
        error: 'GRAMMAR_CLUB_DAY_CONFLICT:Грамматика и разговорный клуб не могут идти в один день.',
      });
    }

    const [group, slotResolution, cabinet] = await Promise.all([
      prisma.studentGroup.findFirst({ where: { id: parsedStudentGroupId, schoolId, deletedAt: null } }),
      resolveWritableTimeSlot({
        schoolId,
        timeSlotId,
        startTime: bodyStartTime,
        endTime: bodyEndTime,
        targetDate: targetDate ?? startDate,
      }),
      prisma.cabinet.findFirst({ where: { id: parsedCabinetId, schoolId } }),
    ]);
    if (!group) return res.status(404).json({ success: false, error: 'Группа не найдена' });
    if (isInactiveGroup(group)) {
      return res.status(400).json({ success: false, error: PAUSED_GROUP_OPERATION_ERROR });
    }
    if (slotResolution.ok === false) return sendTimeSlotError(res, slotResolution);
    const slot = slotResolution.slot;
    if (!cabinet) return res.status(400).json({ success: false, error: 'Кабинет не найден' });

    const resolveStaffProfileId = async (teacherUserId: unknown): Promise<number | null> => {
      const uid = parseOptionalInt(teacherUserId);
      if (!uid) return null;
      const staff = await prisma.staffProfile.findFirst({ where: { userId: uid, user: { schoolId } } });
      if (!staff) throw new ScheduleValidationError('Учитель не найден');
      return staff.id;
    };

    let grammarTeacherProfileId: number | null;
    let clubTeacherProfileId: number | null;
    try {
      [grammarTeacherProfileId, clubTeacherProfileId] = await Promise.all([
        resolveStaffProfileId(grammarTeacherId),
        resolveStaffProfileId(clubTeacherId),
      ]);
    } catch (e: any) {
      if (e instanceof ScheduleValidationError || e.name === 'ScheduleValidationError') {
        return res.status(400).json({ success: false, error: e.message });
      }
      throw e;
    }

    const blockInclude = {
      studentGroup: {
        include: {
          memberships: { where: { status: MemberStatus.ACTIVE }, select: { studentProfile: { include: { user: { select: { firstName: true, lastName: true } } } } } },
        },
      },
      teacher: { include: { user: true } },
      cabinet: true,
    };

    const finalLevel = group.level;
    const finalChapter = group.chapter;
    const startDateParsed = typeof startDate === 'string' && startDate ? new Date(startDate) : new Date();
    const userIsAdminOrOwner = isAdminOrOwner(req.user!.role);
    const fallbackStartDate = Number.isNaN(startDateParsed.getTime()) ? new Date() : startDateParsed;
    const historyAnchorDate = parseScheduleDateInput(targetDate) ?? parseScheduleDateInput(startDate) ?? fallbackStartDate;
    const historyRange = utcWeekRangeFor(historyAnchorDate);

    // Guard: prevent creating a second group-pair for a studentGroup that already has active blocks.
    // Two pairs at different slots produce different mergeKeys in the frontend read model,
    // causing the same group to appear as a duplicate in the schedule grid.
    // The edit/reschedule flow uses PUT /group-pair which sets endDate on existing blocks first.
    const existingActiveBlock = await prisma.lessonBlock.findFirst({
      where: { schoolId, studentGroupId: parsedStudentGroupId, deletedAt: null, endDate: null },
      select: { id: true },
    });
    if (existingActiveBlock) {
      return res.status(409).json({
        success: false,
        code: 'GROUP_ALREADY_IN_SCHEDULE',
        error: 'Группа уже есть в расписании. Используйте "Редактировать пару" для изменения существующего расписания.',
      });
    }

    if (confirmNewHistory !== true) {
      const archivedHistoryBlock = await prisma.lessonBlock.findFirst({
        where: {
          schoolId,
          studentGroupId: parsedStudentGroupId,
          deletedAt: { not: null },
          sessions: {
            some: {
              deletedAt: null,
              date: { gte: historyRange.from, lt: historyRange.to },
              attendances: { some: {} },
            },
          },
        },
        select: {
          id: true,
          type: true,
          startDate: true,
          endDate: true,
          deletedAt: true,
          sessions: {
            where: {
              deletedAt: null,
              date: { gte: historyRange.from, lt: historyRange.to },
              attendances: { some: {} },
            },
            select: {
              id: true,
              date: true,
              status: true,
              _count: { select: { attendances: true } },
            },
            orderBy: { date: 'asc' },
            take: 3,
          },
        },
      });

      if (archivedHistoryBlock) {
        return res.status(409).json({
          success: false,
          code: GROUP_HAS_ARCHIVED_HISTORY_CODE,
          error: GROUP_HAS_ARCHIVED_HISTORY_MESSAGE,
          message: GROUP_HAS_ARCHIVED_HISTORY_MESSAGE,
          details: {
            studentGroupId: parsedStudentGroupId,
            weekFrom: historyRange.from.toISOString(),
            weekTo: historyRange.to.toISOString(),
            archivedBlock: {
              id: archivedHistoryBlock.id,
              type: archivedHistoryBlock.type,
              startDate: archivedHistoryBlock.startDate.toISOString(),
              endDate: archivedHistoryBlock.endDate?.toISOString() ?? null,
              deletedAt: archivedHistoryBlock.deletedAt?.toISOString() ?? null,
            },
            sessions: archivedHistoryBlock.sessions.map((session) => ({
              id: session.id,
              date: session.date.toISOString(),
              status: session.status,
              attendanceCount: session._count.attendances,
            })),
          },
        });
      }
    }

    const blockData = (type: BlockType, teacherId: number | null, days: number[]) => ({
      schoolId,
      cabinetId: parsedCabinetId,
      teacherId,
      studentGroupId: parsedStudentGroupId,
      timeSlotId: slot.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      days,
      level: finalLevel,
      chapter: finalChapter,
      type,
      maxStudents: parsedMaxStudents,
      startDate: startDateParsed,
      endDate: null,
    });

    let result: { grammarBlock: any; clubBlock: any | null };
    try {
      result = await prisma.$transaction(async (tx) => {
        await validateScheduleBlock(tx, {
          schoolId, cabinetId: parsedCabinetId, teacherId: grammarTeacherProfileId,
          startTime: slot.startTime, endTime: slot.endTime, days: normalizedGrammarDays,
          startDate: startDateParsed, endDate: null, maxStudents: parsedMaxStudents,
          policyDate: startDateParsed,
          studentGroupId: parsedStudentGroupId, overrideCabinetConflict, overrideTeacherConflict,
          overrideStudentConflict, blockId: undefined, excludeBlockIds: [], isAdminOrOwner: userIsAdminOrOwner,
          blockType: BlockType.GRAMMAR,
        });

        if (hasClub && normalizedClubDays.length > 0) {
          await validateScheduleBlock(tx, {
            schoolId, cabinetId: parsedCabinetId, teacherId: clubTeacherProfileId,
            startTime: slot.startTime, endTime: slot.endTime, days: normalizedClubDays,
            startDate: startDateParsed, endDate: null, maxStudents: parsedMaxStudents,
            policyDate: startDateParsed,
            studentGroupId: parsedStudentGroupId, overrideCabinetConflict, overrideTeacherConflict,
            overrideStudentConflict, blockId: undefined, excludeBlockIds: [], isAdminOrOwner: userIsAdminOrOwner,
            blockType: BlockType.SPEAKING_CLUB,
          });
        }

        const grammarBlock = await tx.lessonBlock.create({
          data: blockData(BlockType.GRAMMAR, grammarTeacherProfileId, normalizedGrammarDays),
          include: blockInclude,
        });

        const clubBlock = (hasClub && normalizedClubDays.length > 0)
          ? await tx.lessonBlock.create({
              data: blockData(BlockType.SPEAKING_CLUB, clubTeacherProfileId, normalizedClubDays),
              include: blockInclude,
            })
          : null;

        return { grammarBlock, clubBlock };
      });
    } catch (e: any) {
      if (e instanceof ScheduleValidationError || e.name === 'ScheduleValidationError') {
        return res.status(400).json({ success: false, error: e.message });
      }
      if (e instanceof GroupLifecycleError) {
        return res.status(e.statusCode).json({ success: false, error: e.message, code: e.code });
      }
      throw e;
    }

    await cleanupInvalidSessions(result.grammarBlock);
    await syncSessionsForBlock(result.grammarBlock);
    if (result.clubBlock) {
      await cleanupInvalidSessions(result.clubBlock);
      await syncSessionsForBlock(result.clubBlock);
    }
    await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});

    if (result.grammarBlock.teacherId) {
      await notifyTeacherAssigned(schoolId, result.grammarBlock.id, result.grammarBlock.teacherId).catch(() => {});
    }
    if (result.clubBlock && result.clubBlock.teacherId) {
      await notifyTeacherAssigned(schoolId, result.clubBlock.id, result.clubBlock.teacherId).catch(() => {});
    }

    await prisma.scheduleActionLog.create({
      data: {
        schoolId,
        blockId: result.grammarBlock.id,
        userId: req.user!.userId,
        action: 'CREATE_GROUP_PAIR',
        details: `Created group pair for studentGroup #${parsedStudentGroupId}`,
      },
    });

    emitScheduleStructureChanged(schoolId, 'group-pair-created', {
      blockId: result.grammarBlock.id,
      grammarBlockId: result.grammarBlock.id,
      clubBlockId: result.clubBlock?.id ?? null,
      studentGroupId: parsedStudentGroupId,
    });

    return res.status(201).json({
      success: true,
      data: {
        grammarBlockId: result.grammarBlock.id,
        clubBlockId: result.clubBlock?.id ?? null,
      },
    });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'create group pair error');
    res.status(500).json({ success: false, error: 'Failed to create group pair' });
  }
});

// ─── PUT /group-pair/:studentGroupId — обновить пару Grammar+Club ─────────────

router.put('/group-pair/:studentGroupId', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const parsedStudentGroupId = parseInt(req.params.studentGroupId, 10);
    if (!Number.isFinite(parsedStudentGroupId)) {
      return res.status(400).json({ success: false, error: 'Некорректный ID группы' });
    }

    const {
      grammarBlockId,
      clubBlockId,
      timeSlotId,
      startTime: bodyStartTime,
      endTime: bodyEndTime,
      cabinetId,
      level,
      chapter,
      maxStudents,
      grammarTeacherId,
      grammarDays,
      clubTeacherId,
      clubDays,
      applyFrom,
      targetDate,
      overrideCabinetConflict,
      overrideTeacherConflict,
      overrideStudentConflict,
    } = req.body;

    const parsedCabinetId = parseOptionalInt(cabinetId);
    const parsedGrammarBlockId = parseOptionalInt(grammarBlockId);
    const parsedClubBlockId = parseOptionalInt(clubBlockId);
    const parsedChapter = parseOptionalInt(chapter) ?? 1;
    const parsedMaxStudents = parseOptionalInt(maxStudents) ?? 15;
    const normalizedGrammarDays = normalizeDays(grammarDays);
    const normalizedClubDays = normalizeDays(clubDays);

    if (!parsedCabinetId) {
      return res.status(400).json({ success: false, error: 'Кабинет не указан' });
    }
    if (normalizedGrammarDays.length === 0) {
      return res.status(400).json({ success: false, error: 'Выберите дни грамматики' });
    }
    if (normalizedClubDays.length > 0 && daysOverlap(normalizedGrammarDays, normalizedClubDays)) {
      return res.status(400).json({
        success: false,
        error: 'GRAMMAR_CLUB_DAY_CONFLICT:Грамматика и разговорный клуб не могут идти в один день для одной группы.',
      });
    }

    const [group, slotResolution, cabinet] = await Promise.all([
      prisma.studentGroup.findFirst({ where: { id: parsedStudentGroupId, schoolId, deletedAt: null } }),
      resolveWritableTimeSlot({
        schoolId,
        timeSlotId,
        startTime: bodyStartTime,
        endTime: bodyEndTime,
        targetDate: targetDate ?? applyFrom,
      }),
      prisma.cabinet.findFirst({ where: { id: parsedCabinetId, schoolId } }),
    ]);
    if (!group) return res.status(404).json({ success: false, error: 'Группа не найдена' });
    if (isInactiveGroup(group)) {
      return res.status(400).json({ success: false, error: PAUSED_GROUP_OPERATION_ERROR });
    }
    if (slotResolution.ok === false) return sendTimeSlotError(res, slotResolution);
    const slot = slotResolution.slot;
    if (!cabinet) return res.status(400).json({ success: false, error: 'Кабинет не найден' });

    const resolveStaffProfileId = async (teacherUserId: unknown): Promise<number | null> => {
      const parsedTeacherUserId = parseOptionalInt(teacherUserId);
      if (!parsedTeacherUserId) return null;
      const staff = await prisma.staffProfile.findFirst({ where: { userId: parsedTeacherUserId, user: { schoolId } } });
      if (!staff) throw new ScheduleValidationError('Учитель не найден');
      return staff.id;
    };

    let grammarTeacherProfileId: number | null;
    let clubTeacherProfileId: number | null;
    try {
      [grammarTeacherProfileId, clubTeacherProfileId] = await Promise.all([
        resolveStaffProfileId(grammarTeacherId),
        resolveStaffProfileId(clubTeacherId),
      ]);
    } catch (e: any) {
      if (e instanceof ScheduleValidationError || e.name === 'ScheduleValidationError') {
        return res.status(400).json({ success: false, error: e.message });
      }
      throw e;
    }

    const blockInclude = {
      studentGroup: {
        include: {
          memberships: { where: { status: MemberStatus.ACTIVE }, select: { studentProfile: { include: { user: { select: { firstName: true, lastName: true } } } } } },
        },
      },
      teacher: { include: { user: true } },
      cabinet: true,
    };

    const blockWhere = { schoolId, deletedAt: null as Date | null };
    const [providedGrammarBlock, providedClubBlock, activeBlocks] = await Promise.all([
      parsedGrammarBlockId
        ? prisma.lessonBlock.findFirst({ where: { ...blockWhere, id: parsedGrammarBlockId } })
        : Promise.resolve(null),
      parsedClubBlockId
        ? prisma.lessonBlock.findFirst({ where: { ...blockWhere, id: parsedClubBlockId } })
        : Promise.resolve(null),
      prisma.lessonBlock.findMany({
        where: { ...blockWhere, studentGroupId: parsedStudentGroupId, endDate: null },
        orderBy: { id: 'desc' },
      }),
    ]);

    if (parsedGrammarBlockId && !providedGrammarBlock) {
      return res.status(404).json({ success: false, error: 'Блок грамматики не найден' });
    }
    if (parsedClubBlockId && !providedClubBlock) {
      return res.status(404).json({ success: false, error: 'Блок разговорного клуба не найден' });
    }
    for (const block of [providedGrammarBlock, providedClubBlock].filter(Boolean) as any[]) {
      if (block.studentGroupId !== parsedStudentGroupId) {
        return res.status(400).json({ success: false, error: 'Блок не принадлежит выбранной группе' });
      }
    }

    const grammarExisting = providedGrammarBlock
      ?? activeBlocks.find((b) => b.type !== BlockType.SPEAKING_CLUB)
      ?? null;
    const clubExisting = providedClubBlock
      ?? activeBlocks.find((b) => b.type === BlockType.SPEAKING_CLUB)
      ?? null;
    const shouldSaveClub = Boolean(clubExisting) || normalizedClubDays.length > 0 || Boolean(clubTeacherProfileId);

    const applyFromDate = typeof applyFrom === 'string' && applyFrom ? new Date(applyFrom) : null;
    if (applyFromDate && Number.isNaN(applyFromDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Некорректная дата применения изменений' });
    }
    const finalLevel = typeof level === 'string' && level.trim() ? level.trim() : group.level;
    if (finalLevel !== group.level || parsedChapter !== group.chapter) {
      await assertCanChangeLevelChapter(prisma, group);
    }
    const userIsAdminOrOwner = isAdminOrOwner(req.user!.role);
    const excludedBlockIds = [grammarExisting?.id, clubExisting?.id]
      .filter((id): id is number => typeof id === 'number');
    let validationExcludeBlockIds = excludedBlockIds;

    const shouldSplitBlock = (block: any | null) => {
      if (!block || !applyFromDate || typeof applyFrom !== 'string') return false;
      const blockStartStr = block.startDate ? block.startDate.toISOString().slice(0, 10) : null;
      return !blockStartStr || applyFrom > blockStartStr;
    };
    const targetStartDate = (block: any | null) => (
      shouldSplitBlock(block)
        ? applyFromDate!
        : (block?.startDate ?? applyFromDate ?? new Date())
    );

    const buildValidationParams = (
      existing: any | null,
      type: BlockType,
      teacherId: number | null,
      days: number[],
    ) => ({
      schoolId,
      cabinetId: parsedCabinetId,
      teacherId,
      startTime: slot.startTime,
      endTime: slot.endTime,
      days,
      startDate: targetStartDate(existing),
      endDate: shouldSplitBlock(existing) ? null : (existing?.endDate ?? null),
      policyDate: applyFromDate ?? targetStartDate(existing),
      maxStudents: parsedMaxStudents,
      studentGroupId: parsedStudentGroupId,
      overrideCabinetConflict,
      overrideTeacherConflict,
      overrideStudentConflict,
      blockId: existing?.id,
      excludeBlockIds: validationExcludeBlockIds,
      isAdminOrOwner: userIsAdminOrOwner,
      blockType: type,
    });

    const splitOverlapPlans = new Map<BlockType, Array<{ id: number; startDate: Date | null; endDate: Date | null }>>();
    if (applyFromDate) {
      const splitTypes = [BlockType.GRAMMAR, ...(shouldSaveClub ? [BlockType.SPEAKING_CLUB] : [])];
      for (const type of splitTypes) {
        const overlapping = await prisma.lessonBlock.findMany({
          where: {
            ...blockWhere,
            studentGroupId: parsedStudentGroupId,
            type,
            OR: [{ endDate: null }, { endDate: { gte: applyFromDate } }],
          },
          select: { id: true, startDate: true, endDate: true },
        });
        splitOverlapPlans.set(type, overlapping);
      }

      const protectedSessions = await findProtectedFutureSessionsForSplit(
        prisma,
        schoolId,
        [...new Set([...splitOverlapPlans.values()].flat().map((block) => block.id))]
          .map((blockId) => ({ blockId, fromDate: applyFromDate })),
      );
      if (protectedSessions.length > 0) {
        return res.status(409).json({
          success: false,
          code: 'SPLIT_PROTECTED_FUTURE_SESSIONS',
          error: 'Нельзя изменить расписание с этой даты: будущие занятия уже содержат посещаемость, списания или выплаты.',
          data: {
            sessions: protectedSessions.map((session) => ({
              id: session.id,
              lessonBlockId: session.lessonBlockId,
              date: session.date.toISOString().slice(0, 10),
              status: session.status,
              attendanceCount: session._count.attendances,
              creditLogCount: session._count.creditLogs,
              hasTeacherPayment: Boolean(session.teacherPaymentLesson),
            })),
          },
        });
      }
      validationExcludeBlockIds = [
        ...new Set([
          ...excludedBlockIds,
          ...[...splitOverlapPlans.values()].flat().map((block) => block.id),
        ]),
      ];
    }

    let result: { grammarBlock: any; clubBlock: any | null; syncBlocks: any[]; supersededBlockIds: number[] };
    try {
      result = await prisma.$transaction(async (tx) => {
        await validateScheduleBlock(tx, buildValidationParams(
          grammarExisting,
          BlockType.GRAMMAR,
          grammarTeacherProfileId,
          normalizedGrammarDays,
        ));

        if (shouldSaveClub) {
          await validateScheduleBlock(tx, buildValidationParams(
            clubExisting,
            BlockType.SPEAKING_CLUB,
            clubTeacherProfileId,
            normalizedClubDays,
          ));
        }

        await tx.studentGroup.update({
          where: { id: parsedStudentGroupId },
          data: { level: finalLevel, chapter: parsedChapter, maxStudents: parsedMaxStudents },
        });

        await tx.lessonBlock.updateMany({
          where: { studentGroupId: parsedStudentGroupId, schoolId, deletedAt: null },
          data: { level: finalLevel, chapter: parsedChapter },
        });

        const syncBlocks: any[] = [];
        const supersededBlockIds = new Set<number>();
        const supersededSessionPlans: SupersededSessionPlan[] = [];
        const upsertPairBlock = async (
          existing: any | null,
          type: BlockType,
          teacherId: number | null,
          days: number[],
        ) => {
          const blockData = {
            schoolId,
            cabinetId: parsedCabinetId,
            teacherId,
            studentGroupId: parsedStudentGroupId,
            timeSlotId: slot.id,
            startTime: slot.startTime,
            endTime: slot.endTime,
            days,
            level: finalLevel,
            chapter: parsedChapter,
            type,
            maxStudents: parsedMaxStudents,
          };

          if (!existing) {
            const created = await tx.lessonBlock.create({
              data: {
                ...blockData,
                startDate: applyFromDate ?? new Date(),
                endDate: null,
              },
              include: blockInclude,
            });
            syncBlocks.push(created);
            return created;
          }

          if (shouldSplitBlock(existing)) {
            const oldEndDate = previousUtcDate(applyFromDate!);
            const existingStart = existing.startDate ?? applyFromDate!;
            const overlapPlan = splitOverlapPlans.get(type) ?? [{ id: existing.id, startDate: existing.startDate, endDate: existing.endDate }];
            const closedBlocks: any[] = [];
            for (const overlap of overlapPlan) {
              supersededBlockIds.add(overlap.id);
              const overlapStart = overlap.startDate ?? existingStart;
              const supersededFrom = overlap.id === existing.id
                ? applyFromDate!
                : overlapStart.getTime() < existingStart.getTime()
                  ? existingStart
                  : overlapStart;
              supersededSessionPlans.push({ blockId: overlap.id, fromDate: supersededFrom });

              if (overlap.id !== existing.id && overlapStart.getTime() >= existingStart.getTime()) {
                await tx.lessonBlock.update({
                  where: { id: overlap.id },
                  data: { deletedAt: new Date() },
                });
              } else {
                const endDateForOverlap = overlap.id === existing.id ? oldEndDate : previousUtcDate(existingStart);
                const closed = await tx.lessonBlock.update({
                  where: { id: overlap.id },
                  data: { endDate: endDateForOverlap },
                  include: blockInclude,
                });
                closedBlocks.push(closed);
              }
            }
            const created = await tx.lessonBlock.create({
              data: {
                ...blockData,
                parentBlockId: existing.id,
                startDate: applyFromDate!,
                endDate: existing.endDate && existing.endDate.getTime() >= applyFromDate!.getTime()
                  ? existing.endDate
                  : null,
              },
              include: blockInclude,
            });
            syncBlocks.push(...closedBlocks, created);
            return created;
          }

          const updated = await tx.lessonBlock.update({
            where: { id: existing.id },
            data: {
              ...blockData,
              startDate: existing.startDate,
              endDate: existing.endDate,
            },
            include: blockInclude,
          });
          syncBlocks.push(updated);
          return updated;
        };

        const grammarBlock = await upsertPairBlock(
          grammarExisting,
          BlockType.GRAMMAR,
          grammarTeacherProfileId,
          normalizedGrammarDays,
        );
        const clubBlock = shouldSaveClub
          ? await upsertPairBlock(
              clubExisting,
              BlockType.SPEAKING_CLUB,
              clubTeacherProfileId,
              normalizedClubDays,
            )
          : null;

        const protectedSessions = await findProtectedFutureSessionsForSplit(tx, schoolId, supersededSessionPlans);
        if (protectedSessions.length > 0) {
          throw Object.assign(new Error('SPLIT_PROTECTED_FUTURE_SESSIONS'), {
            code: 'SPLIT_PROTECTED_FUTURE_SESSIONS',
            protectedSessions,
          });
        }
        await invalidateSupersededFutureSessions(tx, schoolId, supersededSessionPlans);

        return { grammarBlock, clubBlock, syncBlocks, supersededBlockIds: [...supersededBlockIds] };
      });
    } catch (e: any) {
      if (e?.code === 'SPLIT_PROTECTED_FUTURE_SESSIONS') {
        return res.status(409).json({
          success: false,
          code: 'SPLIT_PROTECTED_FUTURE_SESSIONS',
          error: 'Protected future sessions prevent schedule split',
          data: {
            sessions: (e.protectedSessions ?? []).map((session: any) => ({
              id: session.id,
              lessonBlockId: session.lessonBlockId,
              date: session.date.toISOString().slice(0, 10),
              status: session.status,
              attendanceCount: session._count.attendances,
              creditLogCount: session._count.creditLogs,
              hasTeacherPayment: Boolean(session.teacherPaymentLesson),
            })),
          },
        });
      }
      if (e instanceof ScheduleValidationError || e.name === 'ScheduleValidationError') {
        return res.status(400).json({ success: false, error: e.message });
      }
      throw e;
    }

    for (const block of result.syncBlocks) {
      await cleanupInvalidSessions(block);
      await syncSessionsForBlock(block);
    }
    await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});

    if (result.grammarBlock.teacherId && grammarExisting?.teacherId !== result.grammarBlock.teacherId) {
      await notifyTeacherAssigned(schoolId, result.grammarBlock.id, result.grammarBlock.teacherId).catch(() => {});
    }
    if (result.clubBlock && result.clubBlock.teacherId && clubExisting?.teacherId !== result.clubBlock.teacherId) {
      await notifyTeacherAssigned(schoolId, result.clubBlock.id, result.clubBlock.teacherId).catch(() => {});
    }

    await prisma.scheduleActionLog.create({
      data: {
        schoolId,
        blockId: result.grammarBlock.id,
        userId: req.user!.userId,
        action: applyFromDate ? 'SPLIT_GROUP_PAIR' : 'UPDATE_GROUP_PAIR',
        details: `Saved group pair for studentGroup #${parsedStudentGroupId}`,
      },
    });

    log.info(
      {
        event: 'GROUP_PAIR_SAVED',
        schoolId,
        studentGroupId: parsedStudentGroupId,
        grammarBlockId: result.grammarBlock.id,
        clubBlockId: result.clubBlock?.id ?? null,
        applyFrom: applyFrom ?? null,
        userId: req.user!.userId,
      },
      'Schedule group pair saved atomically'
    );

    emitScheduleStructureChanged(schoolId, applyFromDate ? 'group-pair-split' : 'group-pair-updated', {
      blockId: result.grammarBlock.id,
      grammarBlockId: result.grammarBlock.id,
      clubBlockId: result.clubBlock?.id ?? null,
      studentGroupId: parsedStudentGroupId,
    });

    return res.json({
      success: true,
      data: {
        grammarBlock: mapTeacher(result.grammarBlock),
        clubBlock: result.clubBlock ? mapTeacher(result.clubBlock) : null,
        grammarBlockId: result.grammarBlock.id,
        clubBlockId: result.clubBlock?.id ?? null,
      },
    });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'update group pair error');
    res.status(500).json({ success: false, error: 'Failed to update group schedule' });
  }
});

// ─── DELETE /group-pair/:studentGroupId — атомарное удаление Grammar/Club пары ──
// StudentGroup может иметь не более одной активной пары (см. guard в POST /group-pair,
// та же definition активного блока: deletedAt: null И endDate: null — блоки с endDate
// в прошлом это закрытая история от предыдущего reschedule/split, их трогать нельзя).
// Сервер сам находит активные блоки группы и архивирует их в одной transaction —
// self-healing для групп, уже оставшихся в half-deleted состоянии.

router.delete('/group-pair/:studentGroupId', authenticate, requirePermission('schedule:delete'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const studentGroupId = parseInt(req.params.studentGroupId, 10);
    if (!Number.isFinite(studentGroupId)) {
      return res.status(400).json({ success: false, error: 'Некорректный ID группы' });
    }

    const group = await prisma.studentGroup.findFirst({ where: { id: studentGroupId, schoolId, deletedAt: null } });
    if (!group) {
      return res.status(404).json({ success: false, error: 'Группа не найдена' });
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'schedule-delete-pair';

    const archived = await prisma.$transaction(async (tx) => {
      const activeBlocks = await tx.lessonBlock.findMany({
        where: { schoolId, studentGroupId, deletedAt: null, endDate: null },
        select: { id: true },
      });
      if (activeBlocks.length === 0) {
        throw Object.assign(new Error('Активная пара для этой группы не найдена'), { httpStatus: 404 });
      }

      const results: LessonBlockArchiveResult[] = [];
      for (const block of activeBlocks) {
        results.push(await archiveLessonBlockInTx(tx, {
          blockId: block.id,
          schoolId,
          actorId: req.user!.userId,
          role: req.user!.role,
          reason,
        }));
      }

      await tx.scheduleActionLog.create({
        data: {
          schoolId,
          blockId: results[0].blockId,
          userId: req.user!.userId,
          action: 'DELETE_GROUP_PAIR',
          details: `Deleted group pair for studentGroup #${studentGroupId}`,
        },
      });

      return results;
    });

    await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});
    emitScheduleStructureChanged(schoolId, 'group-pair-deleted', {
      studentGroupId,
      blockIds: archived.map(a => a.blockId),
    });

    res.json({ success: true, data: { studentGroupId, archived } });
  } catch (error: any) {
    sendLifecycleError(res, error, 'Failed to delete group pair');
  }
});

export default router;
