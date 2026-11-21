import { Router } from 'express';
import prisma from '../../lib/prisma';
import { authenticate, AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { Role, EnrollmentStatus, MemberStatus } from '@prisma/client';
import { decodeCursor, buildCursorPage } from '../../lib/pagination';
import { CacheKeys } from '../../lib/cacheKeys';
import { cacheInvalidate } from '../../lib/cache';
import {
  ScheduleValidationError,
  validateScheduleBlock,
  classifyBlockVisibility,
  computeConflictEligible,
} from '../../services/scheduleValidation';
import {
  syncSessionsForBlock,
  cleanupInvalidSessions,
} from '../../services/sessionService';
import { archiveLessonBlock } from '../../services/blockArchiveService';
import { getPolicyForDate } from '../../services/policyService';
import {
  assertCanChangeLevelChapter,
  assertGroupOperationallyActive,
  GroupLifecycleError,
  GroupLifecycleService,
} from '../../services/groupLifecycleService';
import { canBlockTransition, BlockStatus } from '../../lib/blockStateMachine';
import {
  isPrismaNotFound,
} from '../../lib/tenant';
import {
  log, isAdminOrOwner, PAUSED_GROUP_OPERATION_ERROR,
  parseScheduleDateInput, dateStr, isSessionInsideBlockVersion,
  filterCanonicalVersionsForDate, notifyTeacherAssigned, isInactiveGroup, isActiveGroupOwnedBlock,
  emitScheduleStructureChanged, mapTeacher,
} from './scheduleRouteUtils';

const router = Router();

// ─── GET / — все блоки школы ──────────────────────────────────────────────────

router.get('/', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const includeRequests = req.user?.role === Role.ADMIN || req.user?.role === Role.OWNER;
    const { start, end } = req.query;
    const take = parseInt(String(req.query.take || '1000'));
    const cursor = req.query.cursor ? decodeCursor(req.query.cursor as string) : null;
    const rangeStart = parseScheduleDateInput(start);
    const rangeEnd = parseScheduleDateInput(end);
    // When no date range is given (reloadSchedule path), exclude blocks that fully
    // expired before today. This prevents superseded parent versions from reaching
    // the frontend's G map and triggering the selectedGid injection bug.
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const rangeFilter = rangeStart && rangeEnd
      ? [
          { startDate: { lte: rangeEnd } },
          { OR: [{ endDate: null }, { endDate: { gte: rangeStart } }] },
        ]
      : [
          { OR: [{ endDate: null }, { endDate: { gte: startOfToday } }] },
        ];

    const blockInclude = {
      teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
      cabinet: { select: { id: true, name: true, capacity: true } },
      timeSlot: { select: { id: true, startTime: true, endTime: true, order: true } },
      studentGroup: {
        include: {
          // Slim select: this endpoint feeds the schedule grid for the whole school
          // (~thousands of memberships per response). The client reads only
          // id + names + bookIssued — a full studentProfile include shipped every
          // financial/profile column and multiplied the payload several times over.
          memberships: { where: { status: MemberStatus.ACTIVE, studentProfile: { deletedAt: null } }, select: { bookIssued: true, studentProfile: { select: { id: true, chapter: true, credits: true, paidUntil: true, notes: true, isFrozen: true, user: { select: { firstName: true, lastName: true } } } } } },
        },
      },
      enrollmentRequests: includeRequests
        ? {
            where: { status: EnrollmentStatus.PENDING },
            include: { studentProfile: { include: { user: { select: { firstName: true, lastName: true } } } } },
          }
        : false,
      // Sessions are only embedded when an explicit start/end range is requested.
      // The schedule grid (the sole caller) never passes a range and reads sessions
      // from GET /schedule/sessions/week instead, so embedding 30 future sessions per
      // block here was pure wire payload + a per-block join on the hot path.
      sessions: (start && end)
        ? {
            where: { deletedAt: null, date: { gte: new Date(start as string), lte: new Date(end as string) } },
            include: { teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } } },
          }
        : false,
    } as const;

    const [blocks, policy] = await Promise.all([
      prisma.lessonBlock.findMany({
        where: {
          schoolId,
          deletedAt: null,
          AND: [
            {
              OR: [
                { studentGroupId: null },
                { studentGroup: { deletedAt: null } },
              ],
            },
            ...rangeFilter,
          ],
        },
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: 'asc' },
        include: blockInclude,
      }),
      getPolicyForDate(schoolId, new Date()),
    ]);

    // Soft-deleted blocks are truth-display-only diagnostic cards for the Owner/Admin
    // schedule grid, scoped strictly to the requested week — never fetched for the
    // no-range (structural/mount) call. Included only when the block's own lifecycle
    // intersects the range OR it has a real (non-deleted) session dated within the
    // range — the exact case that motivated this: a soft-deleted block whose sessions
    // still fall in the viewed week is historical truth an admin needs to see, not
    // garbage to hide. Bounded by the same range as the main query — no unbounded
    // history scan.
    const softDeletedBlocks = (rangeStart && rangeEnd)
      ? await prisma.lessonBlock.findMany({
          where: {
            schoolId,
            deletedAt: { not: null },
            AND: [
              { OR: [{ studentGroupId: null }, { studentGroup: { deletedAt: null } }] },
              {
                OR: [
                  { AND: [{ startDate: { lte: rangeEnd } }, { OR: [{ endDate: null }, { endDate: { gte: rangeStart } }] }] },
                  { sessions: { some: { deletedAt: null, date: { gte: rangeStart, lte: rangeEnd } } } },
                ],
              },
            ],
          },
          orderBy: { id: 'asc' },
          include: blockInclude,
        })
      : [];

    const schoolActiveDays = (policy.activeDays ?? []).length > 0 ? policy.activeDays : [0, 1, 2, 3, 4];

    const page = buildCursorPage(blocks as any[], take);
    const pageBlocks = rangeStart && rangeEnd && dateStr(rangeStart) === dateStr(rangeEnd)
      ? filterCanonicalVersionsForDate(page.data as any[], rangeStart)
      : page.data;
    // softDeletedBlocks is a small, week-bounded diagnostic addendum concatenated
    // after cursor pagination — it deliberately sits outside take/hasMore accounting
    // (never large enough to matter: bounded to one week's worth of tombstones).
    const allBlocks = [...pageBlocks, ...softDeletedBlocks];
    const mapped = allBlocks.map((b: any) => {
      const sessions = Array.isArray(b.sessions)
        ? b.sessions.filter((session: any) => isSessionInsideBlockVersion(session, b))
        : b.sessions;
      const effectiveDays = (b.days as number[]).filter((d: number) => schoolActiveDays.includes(d));
      const sessionCountInRange = Array.isArray(sessions) ? sessions.length : undefined;
      const { blockVisibility, visibilityReason } = classifyBlockVisibility(
        { deletedAt: b.deletedAt, status: b.status, endDate: b.endDate, effectiveDays, sessionCountInRange },
        b.studentGroup ? { status: b.studentGroup.status } : null,
        new Date(),
      );
      return {
        ...mapTeacher({ ...b, sessions }),
        effectiveDays,
        blockVisibility,
        visibilityReason,
        isScheduleActive: blockVisibility === 'ACTIVE',
        isReadOnly: blockVisibility !== 'ACTIVE',
        conflictEligible: computeConflictEligible(b),
        ...(sessionCountInRange !== undefined ? { sessionCountInRange } : {}),
      };
    });
    res.json({ success: true, data: mapped, nextCursor: page.nextCursor, hasMore: page.hasMore });
  } catch (error) {
    log.error({ err: error }, 'schedule blocks fetch error');
    res.status(500).json({ success: false, error: 'Failed to fetch schedule' });
  }
});

// ─── POST / — создать блок ────────────────────────────────────────────────────

router.post('/', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {

    const {
      cabinetId, timeSlotId, startTime: bodyStartTime, endTime: bodyEndTime,
      days, type, teacherId, maxStudents,
      startDate, endDate, studentGroupId, overrideCabinetConflict,
      overrideTeacherConflict, overrideStudentConflict,
    } = req.body;
    const schoolId = req.user!.schoolId!;

    // Блок расписания не может существовать без привязки к StudentGroup —
    // непривязанные ("без привязки") блоки запрещены на уровне API.
    const parsedStudentGroupId = parseInt(studentGroupId, 10);
    if (!Number.isFinite(parsedStudentGroupId) || parsedStudentGroupId <= 0) {
      return res.status(400).json({
        success: false,
        code: 'STUDENT_GROUP_REQUIRED',
        error: 'Блок расписания нельзя создать без привязки к группе',
      });
    }
    const existingActiveBlock = await prisma.lessonBlock.findFirst({
      where: { schoolId, studentGroupId: parsedStudentGroupId, deletedAt: null, endDate: null },
      select: { id: true },
    });
    if (existingActiveBlock) {
      return res.status(409).json({
        success: false,
        code: 'GROUP_ALREADY_IN_SCHEDULE',
        error: 'StudentGroup is already scheduled. Use group-pair endpoint.',
      });
    }

    let startTime = bodyStartTime;
    let endTime = bodyEndTime;
    if (timeSlotId) {
      const slot = await prisma.timeSlot.findFirst({ where: { id: parseInt(timeSlotId), schoolId } });
      if (!slot) return res.status(400).json({ success: false, error: 'Временной слот не найден' });
      startTime = slot.startTime;
      endTime = slot.endTime;
    }
    if (!startTime || !endTime) {
      return res.status(400).json({ success: false, error: 'Укажите timeSlotId или startTime/endTime' });
    }

    let resolvedSlotId: number;
    if (timeSlotId) {
      resolvedSlotId = parseInt(timeSlotId);
    } else {
      const matchSlot = await prisma.timeSlot.findFirst({ where: { schoolId, startTime, endTime } });
      if (!matchSlot) return res.status(400).json({ success: false, error: 'Временной слот не найден, укажите timeSlotId' });
      resolvedSlotId = matchSlot.id;
    }

    let staffProfileId: number | null = null;
    if (teacherId) {
      const staff = await prisma.staffProfile.findFirst({ where: { userId: parseInt(teacherId), user: { schoolId } } });
      if (!staff) return res.status(400).json({ error: 'Учитель не найден' });
      staffProfileId = staff.id;
    }
    const newStart = startDate ? new Date(startDate) : new Date();
    const newEnd = endDate ? new Date(endDate) : null;

    const parsedMax = parseInt(maxStudents) || 15;
    let cabinetCap: number | null = null;
    if (cabinetId) {
      const cab = await prisma.cabinet.findFirst({ where: { id: parseInt(cabinetId), schoolId } });
      cabinetCap = cab?.capacity ?? null;
    }
    const effectiveCap = cabinetCap !== null ? Math.min(parsedMax, cabinetCap) : parsedMax;
    const userIsAdminOrOwner = isAdminOrOwner(req.user!.role);

    let block: Awaited<ReturnType<typeof prisma.lessonBlock.create>>;
    try {
      block = await prisma.$transaction(async (tx) => {
        await validateScheduleBlock(tx, {
          schoolId,
          cabinetId: cabinetId ? parseInt(cabinetId) : null,
          teacherId: staffProfileId,
          startTime,
          endTime,
          days,
          startDate: newStart,
          endDate: newEnd,
          policyDate: newStart,
          maxStudents: parsedMax,
          studentGroupId: studentGroupId ? parseInt(studentGroupId) : null,
          overrideCabinetConflict,
          overrideTeacherConflict,
          overrideStudentConflict,
          isAdminOrOwner: userIsAdminOrOwner,
          blockType: type,
        });

        const finalStudentGroupId = parsedStudentGroupId;

        const grp = await tx.studentGroup.findFirst({
          where: { id: finalStudentGroupId, schoolId, deletedAt: null },
        });
        if (!grp) {
          throw Object.assign(new Error('Группа не найдена'), { httpStatus: 404 });
        }
        if (isInactiveGroup(grp)) {
          throw Object.assign(new Error(PAUSED_GROUP_OPERATION_ERROR), { httpStatus: 400 });
        }
        const finalLevel = grp.level;
        const finalChapter = grp.chapter;

        return tx.lessonBlock.create({
          data: {
            schoolId,
            cabinetId: cabinetId ? parseInt(cabinetId) : null,
            teacherId: staffProfileId,
            studentGroupId: finalStudentGroupId,
            timeSlotId: resolvedSlotId,
            startTime,
            endTime,
            days,
            level: finalLevel,
            chapter: finalChapter,
            type: type || 'GRAMMAR',
            maxStudents: effectiveCap,
            startDate: startDate ? new Date(startDate) : new Date(),
            endDate: endDate ? new Date(endDate) : null,
          },
        });
      });
    } catch (e: any) {
      if (e instanceof ScheduleValidationError || e.name === 'ScheduleValidationError') {
        return res.status(400).json({ success: false, error: e.message });
      }
      if (typeof e?.httpStatus === 'number') {
        return res.status(e.httpStatus).json({ success: false, error: e.message });
      }
      throw e;
    }

    await syncSessionsForBlock(block);
    await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});

    if (block.teacherId) {
      await notifyTeacherAssigned(schoolId, block.id, block.teacherId).catch(() => {});
    }

    emitScheduleStructureChanged(schoolId, 'block-created', { blockId: block.id });

    // Reload with teacher relation so mapTeacher has firstName/lastName available
    const blockWithTeacher = await prisma.lessonBlock.findUnique({
      where: { id: block.id },
      include: { teacher: { include: { user: { select: { firstName: true, lastName: true } } } } },
    });
    res.json({ success: true, data: mapTeacher(blockWithTeacher ?? block) });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'create lesson block error');
    res.status(500).json({ success: false, error: 'Failed to create lesson block' });
  }
});

router.put('/:id', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {

    const {
      cabinetId, timeSlotId, startTime: bodyStartTime, endTime: bodyEndTime,
      days, level, chapter, teacherId, maxStudents,
      startDate, endDate, studentGroupId, overrideCabinetConflict,
      overrideTeacherConflict, overrideStudentConflict,
      applyFrom, // ISO date string "YYYY-MM-DD" — if set, split block at this date
    } = req.body;
    const lessonId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;

    const existing = await prisma.lessonBlock.findFirst({ where: { id: lessonId, schoolId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Блок не найден' });
    if (isActiveGroupOwnedBlock(existing)) {
      return res.status(409).json({
        success: false,
        code: 'GROUP_PAIR_OWNED',
        error: 'Use group-pair endpoint to edit grouped schedule blocks',
      });
    }
    if (existing.studentGroupId) {
      const group = await prisma.studentGroup.findUnique({
        where: { id: existing.studentGroupId },
        select: { status: true, deletedAt: true },
      });
      if (isInactiveGroup(group)) {
        return res.status(400).json({ success: false, error: PAUSED_GROUP_OPERATION_ERROR });
      }
    }

    // Блок не может остаться без привязки к StudentGroup: отвязка запрещена,
    // а легаси-блок «без привязки» нельзя сохранить, не привязав его к группе.
    const requestedGroupId = studentGroupId !== undefined
      ? (studentGroupId ? parseInt(studentGroupId, 10) : null)
      : existing.studentGroupId;
    if (!requestedGroupId || !Number.isFinite(requestedGroupId)) {
      return res.status(400).json({
        success: false,
        code: 'STUDENT_GROUP_REQUIRED',
        error: 'Блок расписания не может остаться без привязки к группе',
      });
    }
    if (requestedGroupId !== existing.studentGroupId) {
      const targetGroup = await prisma.studentGroup.findFirst({
        where: { id: requestedGroupId, schoolId, deletedAt: null },
        select: { id: true },
      });
      if (!targetGroup) return res.status(404).json({ success: false, error: 'Группа не найдена' });
      // Зеркало POST-guard: привязка к уже расписанной группе создала бы дубль пары в сетке.
      const activeForTarget = await prisma.lessonBlock.findFirst({
        where: { schoolId, studentGroupId: requestedGroupId, deletedAt: null, endDate: null, id: { not: lessonId } },
        select: { id: true },
      });
      if (activeForTarget) {
        return res.status(409).json({
          success: false,
          code: 'GROUP_ALREADY_IN_SCHEDULE',
          error: 'Группа уже есть в расписании. Используйте group-pair endpoint.',
        });
      }
    }

    let startTime = bodyStartTime;
    let endTime = bodyEndTime;
    if (timeSlotId) {
      const slot = await prisma.timeSlot.findFirst({ where: { id: parseInt(timeSlotId), schoolId } });
      if (!slot) return res.status(400).json({ success: false, error: 'Временной слот не найден' });
      startTime = slot.startTime;
      endTime = slot.endTime;
    }

    let staffProfileId: number | null = null;
    if (teacherId) {
      const staff = await prisma.staffProfile.findFirst({ where: { userId: parseInt(teacherId), user: { schoolId } } });
      if (!staff) return res.status(400).json({ error: 'Учитель не найден' });
      staffProfileId = staff.id;
    }

    const updStart = startDate ? new Date(startDate) : existing.startDate;
    const updEnd = endDate ? new Date(endDate) : existing.endDate;

    const validationParams = {
      schoolId,
      cabinetId: cabinetId !== undefined ? (cabinetId ? parseInt(cabinetId) : null) : existing.cabinetId,
      teacherId: staffProfileId ?? existing.teacherId,
      startTime: startTime || existing.startTime,
      endTime: endTime || existing.endTime,
      days: (Array.isArray(days) ? days : existing.days) as number[],
      startDate: updStart,
      endDate: updEnd,
      policyDate: applyFrom ? new Date(applyFrom) : updStart,
      maxStudents: maxStudents ? parseInt(maxStudents) : existing.maxStudents,
      studentGroupId: studentGroupId !== undefined ? (studentGroupId ? parseInt(studentGroupId) : null) : existing.studentGroupId,
      overrideCabinetConflict,
      overrideTeacherConflict,
      overrideStudentConflict,
      blockId: lessonId,
      isAdminOrOwner: isAdminOrOwner(req.user!.role),
      blockType: existing.type,
    };

    const blockInclude = {
      studentGroup: {
        include: {
          memberships: { where: { status: MemberStatus.ACTIVE }, select: { studentProfile: { include: { user: { select: { firstName: true, lastName: true } } } } } },
        },
      },
      teacher: { include: { user: true } },
      cabinet: true,
    };

    // ── SPLIT FLOW: applyFrom = first day of new block version ────────────────
    // Guard: don't split if applyFrom <= block.startDate — would set oldEndDate < startDate (invalid).
    // In that case, treat as in-place update (block already starts at this date).
    const blockStartStr = existing.startDate
      ? existing.startDate.toISOString().slice(0, 10)
      : null;
    const shouldSplit = applyFrom && (!blockStartStr || applyFrom > blockStartStr);

    if (shouldSplit) {
      const splitDate = new Date(applyFrom); // first day of new block (inclusive)
      // Last day old block should generate sessions for: the day before splitDate
      const oldEndDate = new Date(splitDate.getTime() - 24 * 60 * 60 * 1000);

      const finalStudentGroupId = studentGroupId !== undefined
        ? (studentGroupId ? parseInt(studentGroupId) : null)
        : existing.studentGroupId;

      let closedBlock: any, newBlock: any;
      try {
        ({ closedBlock, newBlock } = await prisma.$transaction(async (tx) => {
          // Validate inside the transaction — no TOCTOU window
          await validateScheduleBlock(tx, validationParams);

          // 1. Close old block
          const closed = await tx.lessonBlock.update({
            where: { id: lessonId },
            data: { endDate: oldEndDate },
            include: blockInclude,
          });

          // 2. Optionally update StudentGroup metadata
          if (finalStudentGroupId && (level !== undefined || chapter !== undefined || maxStudents !== undefined)) {
            const finalGroup = await tx.studentGroup.findFirst({
              where: { id: finalStudentGroupId, schoolId },
            });
            if (!finalGroup) throw Object.assign(new Error('Группа не найдена'), { httpStatus: 404 });
            await assertGroupOperationallyActive(tx, finalStudentGroupId, schoolId);
            const parsedChapter = chapter !== undefined ? parseInt(chapter) : undefined;
            if ((level !== undefined && level !== finalGroup.level) || (parsedChapter !== undefined && parsedChapter !== finalGroup.chapter)) {
              await assertCanChangeLevelChapter(tx, finalGroup);
            }
            await tx.studentGroup.update({
              where: { id: finalStudentGroupId },
              data: {
                ...(level !== undefined && { level }),
                ...(chapter !== undefined && { chapter: parsedChapter }),
                ...(maxStudents !== undefined && { maxStudents: parseInt(maxStudents) }),
              },
            });
          }

          // 3. Create new block version (child)
          const created = await tx.lessonBlock.create({
            data: {
              schoolId,
              parentBlockId: lessonId,
              startDate: splitDate,
              endDate: null,
              type: existing.type,
              cabinetId: cabinetId !== undefined ? (cabinetId ? parseInt(cabinetId) : null) : existing.cabinetId,
              timeSlotId: (timeSlotId !== undefined && timeSlotId) ? parseInt(timeSlotId) : existing.timeSlotId,
              startTime: startTime || existing.startTime,
              endTime: endTime || existing.endTime,
              days: Array.isArray(days) ? days : existing.days,
              level: level ?? existing.level,
              chapter: chapter !== undefined ? parseInt(chapter) : existing.chapter,
              teacherId: staffProfileId !== undefined ? staffProfileId : existing.teacherId,
              maxStudents: maxStudents ? parseInt(maxStudents) : existing.maxStudents,
              studentGroupId: finalStudentGroupId,
            },
            include: blockInclude,
          });

          return { closedBlock: closed, newBlock: created };
        }));
      } catch (e: any) {
        if (e instanceof ScheduleValidationError || e.name === 'ScheduleValidationError') {
          return res.status(400).json({ success: false, error: e.message });
        }
        throw e;
      }

      // Session sync outside transaction (idempotent)
      await cleanupInvalidSessions(closedBlock);
      await syncSessionsForBlock(closedBlock);
      await syncSessionsForBlock(newBlock);
      await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});

      if (newBlock.teacherId && existing.teacherId !== newBlock.teacherId) {
        await notifyTeacherAssigned(schoolId, newBlock.id, newBlock.teacherId).catch(() => {});
      }

      await prisma.scheduleActionLog.create({
        data: {
          schoolId,
          blockId: newBlock.id,
          userId: req.user!.userId,
          action: 'SPLIT_BLOCK',
          details: `Блок разделён от ${applyFrom}: старый #${lessonId} закрыт, новый #${newBlock.id} создан`,
        },
      });

      log.info(
        { event: 'BLOCK_SPLIT', schoolId, oldBlockId: lessonId, newBlockId: newBlock.id,
          applyFrom, splitBy: req.user!.userId,
          oldEndDate: oldEndDate.toISOString() },
        'Block split: old block closed, new version created'
      );

      emitScheduleStructureChanged(schoolId, 'block-split', { blockId: newBlock.id, oldBlockId: lessonId });

      return res.json({ success: true, data: mapTeacher(newBlock), split: true, newBlockId: newBlock.id });
    }

    // ── IN-PLACE UPDATE (existing behaviour) ─────────────────────────────────
    let updatedData: any;
    try {
      updatedData = await prisma.$transaction(async (tx) => {
        // Validate inside the transaction — no TOCTOU window
        await validateScheduleBlock(tx, validationParams);

        const targetBlock = await tx.lessonBlock.findUnique({ where: { id: lessonId } });
        if (!targetBlock) throw new Error('Блок не найден');

        const finalStudentGroupId = studentGroupId !== undefined
        ? (studentGroupId ? parseInt(studentGroupId) : null)
        : targetBlock.studentGroupId;

      if (finalStudentGroupId && (level !== undefined || chapter !== undefined || maxStudents !== undefined)) {
        const finalGroup = await tx.studentGroup.findFirst({
          where: { id: finalStudentGroupId, schoolId },
        });
        if (!finalGroup) throw Object.assign(new Error('Группа не найдена'), { httpStatus: 404 });
        await assertGroupOperationallyActive(tx, finalStudentGroupId, schoolId);
        const parsedChapter = chapter !== undefined ? parseInt(chapter) : undefined;
        if ((level !== undefined && level !== finalGroup.level) || (parsedChapter !== undefined && parsedChapter !== finalGroup.chapter)) {
          await assertCanChangeLevelChapter(tx, finalGroup);
        }
        await tx.studentGroup.update({
          where: { id: finalStudentGroupId },
          data: {
            ...(level !== undefined && { level }),
            ...(chapter !== undefined && { chapter: parsedChapter }),
            ...(maxStudents !== undefined && { maxStudents: parseInt(maxStudents) }),
          },
        });

        await tx.lessonBlock.updateMany({
          where: { studentGroupId: finalStudentGroupId, deletedAt: null },
          data: {
            ...(level !== undefined && { level }),
            ...(chapter !== undefined && { chapter: parsedChapter }),
          },
        });
      }

      return tx.lessonBlock.update({
        where: { id: lessonId },
        data: {
          cabinetId: cabinetId !== undefined ? (cabinetId ? parseInt(cabinetId) : null) : undefined,
          timeSlotId: (timeSlotId !== undefined && timeSlotId) ? parseInt(timeSlotId) : undefined,
          startTime,
          endTime,
          days: Array.isArray(days) ? days : undefined,
          level,
          chapter: chapter !== undefined ? parseInt(chapter) : undefined,
          teacherId: staffProfileId !== undefined ? staffProfileId : undefined,
          maxStudents: maxStudents ? parseInt(maxStudents) : undefined,
          startDate: updStart,
          endDate: updEnd,
          studentGroupId: studentGroupId !== undefined ? (studentGroupId ? parseInt(studentGroupId) : null) : undefined,
        },
        include: blockInclude,
      });
      });
    } catch (e: any) {
      if (e instanceof ScheduleValidationError || e.name === 'ScheduleValidationError') {
        return res.status(400).json({ success: false, error: e.message });
      }
      throw e;
    }

    await cleanupInvalidSessions(updatedData);
    await syncSessionsForBlock(updatedData);
    await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});

    if (updatedData.teacherId && existing.teacherId !== updatedData.teacherId) {
      await notifyTeacherAssigned(schoolId, updatedData.id, updatedData.teacherId).catch(() => {});
    }

    // Логируем изменение блока
    await prisma.scheduleActionLog.create({
      data: {
        schoolId,
        blockId: lessonId,
        userId: req.user!.userId,
        action: 'UPDATE_BLOCK',
        details: 'Изменены параметры шаблона (постоянного расписания)'
      }
    });

    emitScheduleStructureChanged(schoolId, 'block-updated', { blockId: lessonId });

    res.json({ success: true, data: mapTeacher(updatedData) });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'update lesson block error');
    res.status(500).json({ success: false, error: 'Failed to update lesson' });
  }
});

// ─── DELETE /:id — безопасная архивация блока ────────────────────────────────

router.delete('/:id', authenticate, requirePermission('schedule:delete'), async (req: AuthRequest, res) => {
  try {
    const blockId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;

    const block = await prisma.lessonBlock.findFirst({
      where: { id: blockId, schoolId },
      select: { studentGroupId: true, endDate: true, deletedAt: true },
    });
    if (!block) return res.status(404).json({ success: false, error: 'Блок не найден' });
    if (isActiveGroupOwnedBlock(block)) {
      return res.status(409).json({
        success: false,
        code: 'GROUP_PAIR_OWNED',
        error: 'Use group-pair endpoint to delete grouped schedule blocks',
      });
    }

    const result = await archiveLessonBlock({
      blockId,
      schoolId,
      actorId: req.user!.userId,
      role: req.user!.role,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : 'schedule-delete',
    });

    await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});
    emitScheduleStructureChanged(schoolId, 'block-archived', { blockId });
    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error?.httpStatus === 404) {
      return res.status(404).json({ success: false, error: 'Блок не найден' });
    }
    log.error({ err: error }, 'archive block error');
    res.status(500).json({ success: false, error: 'Failed to archive block' });
  }
});

// ─── POST /blocks/:id/complete-group — завершить группу с даты ───────────────
// Закрывает ВСЕ блоки StudentGroup: будущие сессии после fromDate помечает
// INVALIDATED, выставляет endDate = fromDate (крон не генерирует, история видна),
// ставит StudentGroup.status = COMPLETED. Реальные CANCELLED и история не трогаются.

router.post('/blocks/:id/complete-group', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const blockId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;
    const { fromDate } = req.body;

    if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
      return res.status(400).json({ success: false, error: 'fromDate required (YYYY-MM-DD)' });
    }

    const block = await prisma.lessonBlock.findFirst({
      where: { id: blockId, schoolId, deletedAt: null },
      select: { id: true, studentGroupId: true },
    });
    if (!block) return res.status(404).json({ success: false, error: 'Блок не найден' });

    const fromDateUtc = new Date(`${fromDate}T00:00:00.000Z`);

    if (!block.studentGroupId) {
      return res.status(400).json({ success: false, error: 'Блок не привязан к группе' });
    }

    await GroupLifecycleService.completeGroup({
      groupId: block.studentGroupId,
      schoolId,
      actorId: req.user!.userId,
      role: req.user!.role,
      reason: `complete-group from ${fromDate}`,
      effectiveDate: fromDateUtc,
      sourceBlockId: blockId,
    });

    await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});
    emitScheduleStructureChanged(schoolId, 'group-completed', {
      blockId,
      studentGroupId: block.studentGroupId,
      fromDate,
    });
    res.json({ success: true });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'complete-group error');
    res.status(500).json({ success: false, error: 'Не удалось завершить группу' });
  }
});

// ─── PATCH /:id/status ────────────────────────────────────────────────────────

router.patch('/:id/status', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const VALID_STATUSES = ['UPCOMING', 'COMPLETED', 'CANCELLED'];
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `Недопустимый статус. Допустимые: ${VALID_STATUSES.join(', ')}` });
    }
    const schoolId = req.user!.schoolId!;
    const existing = await prisma.lessonBlock.findFirst({
      where: { id: parseInt(req.params.id), schoolId },
      select: { id: true, status: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Block not found' });

    const transition = canBlockTransition(existing.status as BlockStatus, status as BlockStatus, req.user!.role);
    if (!transition.allowed) {
      return res.status(422).json({ success: false, error: transition.reason });
    }

    const block = await prisma.lessonBlock.update({ where: { id: existing.id }, data: { status } });
    emitScheduleStructureChanged(schoolId, 'block-status-changed', { blockId: block.id, status });
    res.json({ success: true, data: block });
  } catch (error) {
    if (isPrismaNotFound(error)) return res.status(404).json({ success: false, error: 'Block not found' });
    log.error({ err: error }, 'update block status error');
    res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

// ─── GET /teacher ─────────────────────────────────────────────────────────────

router.get('/teacher', authenticate, requirePermission('session:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const teacherId = req.user!.userId;

    const staff = await prisma.staffProfile.findUnique({ where: { userId: teacherId } });
    if (!staff) return res.status(404).json({ success: false, error: 'Staff profile not found' });

    const policy = await getPolicyForDate(schoolId, new Date());
    const schoolActiveDays = (policy.activeDays ?? []).length > 0 ? policy.activeDays : [0, 1, 2, 3, 4];

    const blocks = await prisma.lessonBlock.findMany({
      where: { schoolId, deletedAt: null, teacherId: staff.id },
      include: {
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        cabinet: { select: { id: true, name: true } },
        sessions: {
          where: { deletedAt: null },
          include: { teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } } },
        },
        studentGroup: { include: { memberships: { where: { status: MemberStatus.ACTIVE }, select: { studentProfile: { include: { user: { select: { firstName: true, lastName: true } } } } } } } },
        _count: { select: { sessions: true } },
      },
    });

    const substituteSessions = await prisma.lessonSession.findMany({
      where: { schoolId, teacherId: staff.id, deletedAt: null, lessonBlock: { schoolId, deletedAt: null } },
      include: {
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        lessonBlock: {
          include: {
            teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
            cabinet: { select: { id: true, name: true } },
            studentGroup: { include: { memberships: { where: { status: MemberStatus.ACTIVE }, select: { studentProfile: { include: { user: { select: { firstName: true, lastName: true } } } } } } } },
            _count: { select: { sessions: true } },
          },
        },
      },
    });

    const existingBlockIds = new Set(blocks.map((b: any) => b.id));
    const substituteBlocks: any[] = [];

    for (const session of substituteSessions) {
      const block = session.lessonBlock;
      if (existingBlockIds.has(block.id)) {
        const existing = blocks.find((b: any) => b.id === block.id);
        if (existing && !existing.sessions.find((s: any) => s.id === session.id)) {
          const { lessonBlock: _, ...sessionWithoutBlock } = session as any;
          existing.sessions.push(sessionWithoutBlock);
        }
      } else {
        existingBlockIds.add(block.id);
        const { lessonBlock: _, ...sessionWithoutBlock } = session as any;
        substituteBlocks.push({ ...block, isSubstituteBlock: true, sessions: [sessionWithoutBlock] });
      }
    }

    // Same truth-display fields as GET / (admin/owner) — without them every block here
    // reads isScheduleActive=undefined, and the client's shared merge logic
    // (scheduleBlockMerge.ts) treats that as "not active" for EVERY card, forcing
    // group.isReadOnly=true across the whole teacher view. That silently blocked the
    // "lesson started, session row not generated yet" attendance fallback
    // (todayUpcomingMarkable in groupRowActionState.ts) for any lesson without a
    // pre-existing LessonSession — teachers saw "Посещаемость сейчас недоступна" with
    // no way to submit, even for a lesson that had clearly already happened.
    const withVisibility = (b: any) => {
      const effectiveDays = (b.days as number[]).filter((d: number) => schoolActiveDays.includes(d));
      const sessionCountInRange = Array.isArray(b.sessions) ? b.sessions.length : undefined;
      const { blockVisibility, visibilityReason } = classifyBlockVisibility(
        { deletedAt: b.deletedAt, status: b.status, endDate: b.endDate, effectiveDays, sessionCountInRange },
        b.studentGroup ? { status: b.studentGroup.status } : null,
        new Date(),
      );
      return {
        ...mapTeacher(b),
        effectiveDays,
        blockVisibility,
        visibilityReason,
        isScheduleActive: blockVisibility === 'ACTIVE',
        isReadOnly: blockVisibility !== 'ACTIVE',
        conflictEligible: computeConflictEligible(b),
        ...(sessionCountInRange !== undefined ? { sessionCountInRange } : {}),
      };
    };

    res.json({ success: true, data: [...blocks, ...substituteBlocks].map((b: any) => withVisibility(b)) });
  } catch (error) {
    log.error({ err: error }, 'schedule blocks fetch error');
    res.status(500).json({ success: false, error: 'Failed to fetch schedule' });
  }
});

// ─── GET /student ─────────────────────────────────────────────────────────────

router.get('/student', authenticate, requirePermission('schedule:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;

    const studentProfile = await prisma.studentProfile.findFirst({ where: { userId: req.user!.userId, deletedAt: null } });
    if (!studentProfile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const blocks = await prisma.lessonBlock.findMany({
      where: {
        schoolId,
        deletedAt: null,
        studentGroup: { deletedAt: null, memberships: { some: { studentProfileId: studentProfile.id, status: MemberStatus.ACTIVE } } },
      },
      include: {
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        cabinet: { select: { id: true, name: true } },
        studentGroup: { select: { id: true } },
        sessions: {
          where: { deletedAt: null },
          select: {
            date: true,
            status: true,
            attendances: { where: { studentProfileId: studentProfile.id } },
          },
          orderBy: { date: 'desc' },
          take: 30,
        },
      },
    });

    // Active seat count per group (for the "X/Y мест" display) — GroupMembership is
    // the sole enrollment source of truth (see groupPromotionService.ts).
    const groupIds = [...new Set(blocks.map(b => b.studentGroupId).filter((id): id is number => id != null))];
    const membershipCounts = groupIds.length > 0
      ? await prisma.groupMembership.groupBy({
          by: ['studentGroupId'],
          where: { studentGroupId: { in: groupIds }, status: MemberStatus.ACTIVE },
          _count: { _all: true },
        })
      : [];
    const countByGroupId = new Map(membershipCounts.map(c => [c.studentGroupId, c._count._all]));

    res.json({
      success: true,
      data: blocks.map((b: any) => {
        // mapTeacher() overwrites level/chapter from studentGroup when present — this
        // route only selects studentGroup.id, so run it first without that field (see
        // the identical fix in scheduleAvailability.routes.ts's GET /available).
        const { studentGroup, ...rest } = b;
        return {
          ...mapTeacher(rest),
          studentGroup: studentGroup ? { ...studentGroup, activeStudentCount: countByGroupId.get(studentGroup.id) ?? 0 } : null,
        };
      }),
    });
  } catch (error) {
    log.error({ err: error }, 'schedule blocks fetch error');
    res.status(500).json({ success: false, error: 'Failed to fetch schedule' });
  }
});

// Legacy policy mutation endpoint disabled: conflicts are warnings only.
router.post('/fix-block-days', authenticate, requirePermission('users:manage'), async (_req: AuthRequest, res) => {
  return res.status(410).json({
    success: false,
    error: 'LEGACY_POLICY_MUTATION_DISABLED',
    message: 'This legacy endpoint modified block days and invalidated sessions from legacy school schedule columns. Schedule policy conflicts are warnings only and must be resolved manually.',
  });
});

export default router;
