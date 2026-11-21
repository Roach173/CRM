import { Response, Router } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { checkStudentScheduleConflicts, ScheduleValidationError } from '../services/scheduleValidation';
import { reconcileRosterOnMemberAdd, reconcileRosterOnMemberRemove } from '../services/rosterService';
import { notify } from '../lib/notify';
import { logScheduleAction } from '../lib/auditLog';
import {
  assertCanChangeLevelChapter,
  assertGroupOperationallyActive,
  GroupLifecycleError,
  GroupLifecycleService,
} from '../services/groupLifecycleService';
import { assertGroupAction } from '../lib/groupLifecyclePolicy';
import { GroupPromotionError, GroupPromotionService } from '../services/groupPromotionService';
import { createLogger } from '../lib/logger';
import { assertStudentsBelongToSchool, isTenantNotFound } from '../lib/tenant';
import { cacheInvalidate } from '../lib/cache';
import { CacheKeys } from '../lib/cacheKeys';
import { emitToSchool } from '../lib/socket';
import { sendLifecycleError } from '../lib/routeError';

const log = createLogger('groups');
const router = Router();

function hasOwn(body: unknown, key: string) {
  return !!body && Object.prototype.hasOwnProperty.call(body, key);
}


async function runLifecycleAction(
  req: AuthRequest,
  res: Response,
  action: 'pause' | 'resume' | 'complete' | 'archive' | 'restore'
) {
  try {
    const schoolId = req.user?.schoolId;
    const actorId = req.user?.userId;
    const groupId = parseInt(req.params.id, 10);
    if (!schoolId || !actorId) return res.status(403).json({ success: false, error: 'No school' });
    if (!Number.isFinite(groupId)) return res.status(400).json({ success: false, error: 'Invalid group id' });

    const params = {
      groupId,
      schoolId,
      actorId,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
    };

    const data = action === 'pause'
      ? await GroupLifecycleService.pauseGroup(params)
      : action === 'resume'
        ? await GroupLifecycleService.resumeGroup(params)
        : action === 'complete'
          ? await GroupLifecycleService.completeGroup({ ...params, role: req.user!.role })
          : action === 'archive'
            ? await GroupLifecycleService.archiveGroup(params)
            : await GroupLifecycleService.restoreGroup(params);

    await cacheInvalidate(CacheKeys.schoolSchedule(schoolId)).catch(() => {});
    emitToSchool(schoolId, 'schedule:structure-changed', { action: `group-${action}`, groupId });

    return res.json({ success: true, data });
  } catch (error) {
    return sendLifecycleError(res, error, 'Failed to change group lifecycle');
  }
}

function daysOverlap(days1: number[], days2: number[]): boolean {
  const set1 = new Set(days1);
  return days2.some(d => set1.has(d));
}

function timeRangesOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  return s1 < e2 && s2 < e1;
}

function dateRangesOverlap(s1: Date | null, e1: Date | null, s2: Date | null, e2: Date | null): boolean {
  const a = s1 ?? new Date(0);
  const b = e1 ?? new Date('2099-12-31');
  const c = s2 ?? new Date(0);
  const d = e2 ?? new Date('2099-12-31');
  return a <= d && c <= b;
}

type BlockSlot = { id: number; days: number[]; startTime: string; endTime: string; startDate: Date | null; endDate: Date | null };

const studentProfileSelect = {
  id: true,
  userId: true,
  level: true,
  chapter: true,
  credits: true,
  isFrozen: true,
  paidUntil: true,
  isVerified: true,
  deletedAt: true,
  user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
} as const;

const activeMembershipsInclude = {
  where: { status: 'ACTIVE' as const, studentProfile: { deletedAt: null } },
  include: {
    studentProfile: { select: studentProfileSelect },
  },
  orderBy: { joinedAt: 'asc' as const },
};

/** Map GroupMembership[] → StudentProfile[] for backward-compat API response shape. */
function membershipsToStudents(memberships: Array<{ studentProfile: any; joinedAt: Date }>) {
  return memberships.map(m => ({ ...m.studentProfile, joinedAt: m.joinedAt }));
}


// ─── GET / — список всех групп школы (с pagination) ──────────────────────────

router.get('/', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const { status, level, search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 100));
    const skip  = (page - 1) * limit;

    const where: Record<string, any> = { schoolId, deletedAt: null };
    if (status) where.status = status as any;
    if (level)  where.level  = level as string;
    if (search) where.level  = { contains: search as string, mode: 'insensitive' };

    const [total, groups] = await Promise.all([
      prisma.studentGroup.count({ where }),
      prisma.studentGroup.findMany({
        where,
        skip,
        take: limit,
        include: {
          blocks: {
            where: { deletedAt: null },
            include: {
              teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
              cabinet: { select: { id: true, name: true, capacity: true } },
            },
          },
          memberships: activeMembershipsInclude,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const data = groups.map(({ memberships, ...g }) => ({
      ...g,
      students: membershipsToStudents(memberships),
      _count: { students: memberships.length },
    }));

    res.json({ success: true, data, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    log.error({ err: error }, 'GET /');
    res.status(500).json({ success: false, error: 'Failed to fetch groups' });
  }
});

// ─── GET /:id — профиль группы ────────────────────────────────────────────────

router.get('/:id', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const groupId = parseInt(req.params.id);

    const group = await prisma.studentGroup.findFirst({
      where: { id: groupId, schoolId, deletedAt: null },
      include: {
        blocks: {
          where: { deletedAt: null },
          include: {
            teacher: {
              select: { userId: true, user: { select: { firstName: true, lastName: true } } },
            },
            cabinet: { select: { id: true, name: true, capacity: true } },
            _count: { select: { sessions: true } },
          },
        },
        memberships: activeMembershipsInclude,
        enrollments: {
          where: { status: 'PENDING' },
          include: {
            studentProfile: {
              include: { user: { select: { firstName: true, lastName: true, email: true } } },
            },
          },
        },
      },
    });

    if (!group) return res.status(404).json({ success: false, error: 'Группа не найдена' });

    const { memberships, ...rest } = group;
    res.json({
      success: true,
      data: {
        ...rest,
        students: membershipsToStudents(memberships),
        _count: { students: memberships.length },
      },
    });
  } catch (error) {
    log.error({ err: error }, 'GET /:id');
    res.status(500).json({ success: false, error: 'Failed to fetch group' });
  }
});

// ─── POST / — создать группу ──────────────────────────────────────────────────

router.post('/', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const { level, chapter, maxStudents, startDate, endDate, studentIds } = req.body;

    if (!level) {
      return res.status(400).json({ success: false, error: 'level обязателен' });
    }

    const ids: number[] = studentIds && studentIds.length > 0 ? (studentIds as number[]) : [];

    // Validate all initial students belong to this school before enrolling them
    // (mirrors the same check on POST /:id/students — see assertStudentsBelongToSchool).
    await assertStudentsBelongToSchool(ids, schoolId);

    // Default maxStudents: explicit body value → school groupSize setting → 15
    let defaultMax = 15;
    if (!maxStudents) {
      const school = await prisma.school.findFirst({ where: { id: schoolId, deletedAt: null }, select: { settings: true } });
      const settings = school?.settings && typeof school.settings === 'object' && !Array.isArray(school.settings) ? school.settings as Record<string, unknown> : {};
      if (typeof settings.groupSize === 'number' && settings.groupSize > 0) defaultMax = settings.groupSize;
    }

    const group = await prisma.studentGroup.create({
      data: {
        schoolId,
        level,
        chapter: parseInt(chapter) || 1,
        maxStudents: parseInt(maxStudents) || defaultMax,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      },
      select: { id: true, schoolId: true, createdAt: true },
    });

    // Create GroupMembership for initial students
    if (ids.length > 0) {
      await prisma.groupMembership.createMany({
        data: ids.map(id => ({
          schoolId,
          studentProfileId: id,
          studentGroupId: group.id,
          joinedAt: group.createdAt,
          status: 'ACTIVE' as const,
        })),
        skipDuplicates: true,
      });
    }

    const full = await prisma.studentGroup.findUniqueOrThrow({
      where: { id: group.id },
      include: {
        memberships: activeMembershipsInclude,
        _count: { select: { memberships: true } },
      },
    });

    const { memberships, _count, ...rest } = full;
    res.json({
      success: true,
      data: {
        ...rest,
        students: membershipsToStudents(memberships),
        _count: { students: memberships.length },
      },
    });
  } catch (error) {
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'POST /');
    res.status(500).json({ success: false, error: 'Failed to create group' });
  }
});

// ─── PUT /:id — обновить группу ───────────────────────────────────────────────

router.put('/:id', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const groupId = parseInt(req.params.id);

    const existing = await prisma.studentGroup.findFirst({ where: { id: groupId, schoolId, deletedAt: null } });
    if (!existing) return res.status(404).json({ success: false, error: 'Группа не найдена' });

    if (hasOwn(req.body, 'status')) {
      await logScheduleAction({
        client: prisma,
        schoolId: schoolId!,
        userId: req.user!.userId,
        entityType: 'group',
        groupId,
        action: 'GROUP_STATUS_CHANGE_REJECTED',
        before: { status: existing.status },
        after: { requestedStatus: req.body.status },
        reason: 'Direct status update through PUT /groups/:id',
      }).catch(() => {});
      return res.status(400).json({ success: false, error: 'Use lifecycle endpoints to change group status' });
    }

    const { level, chapter, maxStudents, startDate, endDate, comment } = req.body;
    const parsedChapter = chapter !== undefined ? parseInt(chapter) : undefined;
    const levelChanging = level !== undefined && level !== existing.level;
    const chapterChanging = parsedChapter !== undefined && parsedChapter !== existing.chapter;

    // Policy guards — each field category checked independently via canonical policy owner
    if (maxStudents !== undefined) {
      assertGroupAction(existing, 'edit:maxStudents');
    }
    if (startDate !== undefined || endDate !== undefined) {
      assertGroupAction(existing, 'edit:schedule');
    }

    if (levelChanging || chapterChanging) {
      await assertCanChangeLevelChapter(prisma, existing);
    }

    const group = await prisma.studentGroup.update({
      where: { id: groupId },
      data: {
        ...(level !== undefined && { level }),
        ...(chapter !== undefined && { chapter: parsedChapter }),
        ...(maxStudents !== undefined && { maxStudents: parseInt(maxStudents) }),
        ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
        ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : null }),
        ...(comment !== undefined && { comment: comment ? String(comment).slice(0, 2000) : null }),
      },
      include: {
        memberships: activeMembershipsInclude,
        blocks: { where: { deletedAt: null } },
      },
    });

    if (level !== undefined || chapter !== undefined) {
      await prisma.lessonBlock.updateMany({
        where: { studentGroupId: groupId, deletedAt: null },
        data: {
          ...(level !== undefined && { level }),
          ...(chapter !== undefined && { chapter: parsedChapter }),
        },
      });
    }

    const { memberships, ...rest } = group;
    res.json({
      success: true,
      data: {
        ...rest,
        students: membershipsToStudents(memberships),
        _count: { students: memberships.length },
      },
    });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'PUT /:id');
    res.status(500).json({ success: false, error: 'Failed to update group' });
  }
});

// ─── DELETE /:id — мягкое удаление группы ────────────────────────────────────

// pause/resume — operational: ADMIN + OWNER
router.post('/:id/lifecycle/pause',   authenticate, requirePermission('schedule:write'), (req: AuthRequest, res) => runLifecycleAction(req, res, 'pause'));
router.post('/:id/lifecycle/resume',  authenticate, requirePermission('schedule:write'), (req: AuthRequest, res) => runLifecycleAction(req, res, 'resume'));
// complete/archive/restore — destructive/irreversible: OWNER only
router.post('/:id/lifecycle/complete', authenticate, requirePermission('groups:archive'), (req: AuthRequest, res) => runLifecycleAction(req, res, 'complete'));
router.post('/:id/lifecycle/archive',  authenticate, requirePermission('groups:archive'), (req: AuthRequest, res) => runLifecycleAction(req, res, 'archive'));
router.post('/:id/lifecycle/restore',  authenticate, requirePermission('groups:archive'), (req: AuthRequest, res) => runLifecycleAction(req, res, 'restore'));

router.delete('/:id', authenticate, requirePermission('groups:archive'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const groupId = parseInt(req.params.id);

    const existing = await prisma.studentGroup.findFirst({ where: { id: groupId, schoolId, deletedAt: null } });
    if (!existing) return res.status(404).json({ success: false, error: 'Группа не найдена' });

    await GroupLifecycleService.archiveGroup({
      groupId,
      schoolId: schoolId!,
      actorId: req.user!.userId,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : 'DELETE /groups/:id',
    });

    res.json({ success: true });
  } catch (error) {
    return sendLifecycleError(res, error, 'Failed to delete group');
  }
});

// ─── POST /:id/students — добавить студента(ов) в группу ─────────────────────

router.post('/:id/students', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const groupId = parseInt(req.params.id);
    const { studentProfileIds } = req.body;

    if (!Array.isArray(studentProfileIds) || studentProfileIds.length === 0) {
      return res.status(400).json({ success: false, error: 'studentProfileIds обязателен' });
    }

    const group = await prisma.studentGroup.findFirst({
      where: { id: groupId, schoolId, deletedAt: null },
      include: {
        _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
        blocks: {
          where: { deletedAt: null },
          select: { id: true, days: true, startTime: true, endTime: true, startDate: true, endDate: true, cabinet: { select: { name: true, capacity: true } } },
        },
      },
    });
    if (!group) return res.status(404).json({ success: false, error: 'Группа не найдена' });
    await assertGroupOperationallyActive(prisma, groupId, schoolId!);

    const currentCount = group._count.memberships;
    const newTotal = currentCount + studentProfileIds.length;
    const overflowCabinets = [];
    for (const b of group.blocks) {
      if (b.cabinet && newTotal > b.cabinet.capacity) {
        overflowCabinets.push(b.cabinet.name);
      }
    }

    if (overflowCabinets.length > 0 && !req.body.overrideCapacity) {
      const uniqueNames = Array.from(new Set(overflowCabinets));
      return res.status(400).json({
        success: false,
        error: `CAPACITY_WARNING:Группа не влезет в кабинеты: ${uniqueNames.join(', ')}. У них вместимость меньше, чем ${newTotal} чел.`,
      });
    }

    // Validate all students belong to this school before connecting them
    const parsedStudentIds = (studentProfileIds as number[]).map(id => parseInt(String(id), 10));
    await assertStudentsBelongToSchool(parsedStudentIds, schoolId!);

    try {
      for (const b of group.blocks) {
        await checkStudentScheduleConflicts(
          prisma, 
          studentProfileIds as number[], 
          {
            days: b.days,
            startTime: b.startTime,
            endTime: b.endTime,
            startDate: b.startDate,
            endDate: b.endDate,
            ignoreGroupId: groupId
          }, 
          req.body.overrideStudentConflict
        );
      }
    } catch (e: any) {
      if (e instanceof ScheduleValidationError) {
        return res.status(400).json({ success: false, error: e.message });
      }
      throw e;
    }

    const now = new Date();

    await prisma.$transaction([
      ...parsedStudentIds.map(id =>
        prisma.groupMembership.upsert({
          where: { studentProfileId_studentGroupId: { studentProfileId: id, studentGroupId: groupId } },
          create: { schoolId: schoolId!, studentProfileId: id, studentGroupId: groupId, joinedAt: now, status: 'ACTIVE' },
          update: { status: 'ACTIVE', leftAt: null, joinedAt: now },
        })
      ),
    ]);

    // Roster reconciliation: add students to upcoming session rosters via canonical owner.
    await reconcileRosterOnMemberAdd(groupId, schoolId!, parsedStudentIds);

    res.json({ success: true });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'POST /:id/students');
    res.status(500).json({ success: false, error: 'Failed to add students' });
  }
});

// ─── DELETE /:id/students/:studentProfileId — удалить студента из группы ─────

router.delete('/:id/students/:studentProfileId', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const groupId = parseInt(req.params.id);
    const studentProfileId = parseInt(req.params.studentProfileId);

    const group = await prisma.studentGroup.findFirst({ where: { id: groupId, schoolId, deletedAt: null } });
    if (!group) return res.status(404).json({ success: false, error: 'Группа не найдена' });
    assertGroupAction(group, 'remove:students');

    await prisma.$transaction([
      prisma.groupMembership.updateMany({
        where: { studentGroupId: groupId, studentProfileId, status: 'ACTIVE' },
        data: { status: 'WITHDRAWN', leftAt: new Date() },
      }),
    ]);

    // Roster reconciliation: remove student from upcoming session rosters via canonical owner.
    // Protects sessions where attendance has already been submitted.
    await reconcileRosterOnMemberRemove(groupId, schoolId!, studentProfileId);

    // Notify the first PENDING student in the waitlist that a spot opened up
    const waitlistEntry = await prisma.enrollmentRequest.findFirst({
      where: { studentGroupId: groupId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { studentProfile: { include: { user: true } } },
    });
    if (waitlistEntry?.studentProfile?.user?.id) {
      const grpInfo = await prisma.studentGroup.findUnique({ where: { id: groupId }, select: { level: true } });
      await notify({
        userId: waitlistEntry.studentProfile.user.id,
        type: 'WAITLIST_SPOT_AVAILABLE',
        title: 'Освободилось место в группе',
        body: `В группе ${grpInfo?.level ?? ''} появилось свободное место. Ваша заявка на рассмотрении у администратора.`,
        data: { studentGroupId: groupId },
      });
    }

    res.json({ success: true });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'DELETE /:id/students/:sid');
    res.status(500).json({ success: false, error: 'Failed to remove student' });
  }
});

// ─── PATCH /:id/students/book — отметить выдачу книги (одному или всем) ──────
// Body: { studentProfileIds?: number[], bookIssued: boolean }.
// Без studentProfileIds применяется ко всем активным участникам группы.

router.patch('/:id/students/book', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const groupId = parseInt(req.params.id);
    const { studentProfileIds, bookIssued } = req.body;

    if (typeof bookIssued !== 'boolean') {
      return res.status(400).json({ success: false, error: 'bookIssued обязателен' });
    }
    if (studentProfileIds !== undefined && (!Array.isArray(studentProfileIds) || studentProfileIds.some(id => !Number.isInteger(id)))) {
      return res.status(400).json({ success: false, error: 'studentProfileIds должен быть массивом чисел' });
    }

    const group = await prisma.studentGroup.findFirst({ where: { id: groupId, schoolId, deletedAt: null } });
    if (!group) return res.status(404).json({ success: false, error: 'Группа не найдена' });

    const result = await prisma.groupMembership.updateMany({
      where: {
        studentGroupId: groupId,
        schoolId: schoolId!,
        status: 'ACTIVE',
        ...(studentProfileIds ? { studentProfileId: { in: studentProfileIds as number[] } } : {}),
      },
      data: { bookIssued },
    });

    res.json({ success: true, data: { updated: result.count } });
  } catch (error) {
    log.error({ err: error }, 'PATCH /:id/students/book');
    res.status(500).json({ success: false, error: 'Failed to update book status' });
  }
});

// ─── PATCH /:id/chapter — сменить текущую главу (кнопки −/+ в расписании) ─────
// Body: { chapter: number, studentProfileIds?: number[] }.
//   Без studentProfileIds — bulk: глава группы + блоков + StudentProfile.chapter
//   всех ACTIVE участников. С ids — только главы указанных участников (глава
//   группы не трогается).
// Deliberately skips the level/chapter identity lock (groupHasLifecycleHistory):
// bumping the current chapter is routine progress tracking, not a cohort identity
// change. Level edits still go through PUT /schedule/group-pair with the full lock.

router.patch('/:id/chapter', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const groupId = parseInt(req.params.id);
    const { studentProfileIds } = req.body;
    const chapter = parseInt(req.body.chapter);

    if (!Number.isInteger(chapter) || chapter < 1 || chapter > 999) {
      return res.status(400).json({ success: false, error: 'chapter должен быть числом от 1 до 999' });
    }
    if (studentProfileIds !== undefined && (!Array.isArray(studentProfileIds) || studentProfileIds.length === 0 || studentProfileIds.some(id => !Number.isInteger(id)))) {
      return res.status(400).json({ success: false, error: 'studentProfileIds должен быть непустым массивом чисел' });
    }

    const group = await prisma.studentGroup.findFirst({ where: { id: groupId, schoolId, deletedAt: null } });
    if (!group) return res.status(404).json({ success: false, error: 'Группа не найдена' });
    assertGroupAction(group, 'edit:level-chapter'); // lifecycle status gate (ACTIVE only)

    // Membership join keeps this tenant-safe: only profiles ACTIVE in this group.
    const memberProfilesWhere = {
      deletedAt: null,
      memberships: { some: { studentGroupId: group.id, schoolId: schoolId!, status: 'ACTIVE' as const } },
      ...(studentProfileIds ? { id: { in: studentProfileIds as number[] } } : {}),
    };

    const result = await prisma.$transaction(async (tx) => {
      const students = await tx.studentProfile.updateMany({ where: memberProfilesWhere, data: { chapter } });
      if (!studentProfileIds) {
        await tx.studentGroup.update({ where: { id: group.id }, data: { chapter } });
        await tx.lessonBlock.updateMany({
          where: { studentGroupId: group.id, schoolId, deletedAt: null },
          data: { chapter },
        });
      }
      return students.count;
    });

    res.json({ success: true, data: { chapter, studentsUpdated: result } });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    log.error({ err: error }, 'PATCH /:id/chapter');
    res.status(500).json({ success: false, error: 'Failed to update chapter' });
  }
});

// ─── POST /:id/promote — academic promotion: creates a new group at the next level ──
// Source group stays historical. Students + blocks are copied. A GroupProgression
// record links old → new. If completeSourceGroup=true (default), source is closed
// via Phase-3 semantics (future sessions INVALIDATED, blocks COMPLETED).

router.post('/:id/promote', authenticate, requirePermission('groups:archive'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const actorId = req.user?.userId;
    const groupId = parseInt(req.params.id, 10);
    if (!schoolId || !actorId) return res.status(403).json({ success: false, error: 'No school' });
    if (!Number.isFinite(groupId)) return res.status(400).json({ success: false, error: 'Invalid group id' });

    const { newLevel, newChapter, completeSourceGroup, reason } = req.body;
    if (!newLevel) return res.status(400).json({ success: false, error: 'newLevel обязателен' });

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: groupId,
      schoolId,
      actorId,
      role: req.user!.role,
      targetLevel: String(newLevel),
      targetChapter: typeof newChapter === 'number' ? newChapter : 1,
      completeSourceGroup: completeSourceGroup !== false,
      reason: typeof reason === 'string' ? reason : undefined,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    sendLifecycleError(res, error, 'Failed to promote group');
  }
});

// ─── GET /:id/progression — цепочка academic progression ─────────────────────

router.get('/:id/progression', authenticate, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const groupId = parseInt(req.params.id, 10);
    if (!schoolId || !Number.isFinite(groupId)) {
      return res.status(400).json({ success: false, error: 'Invalid params' });
    }

    const groupFields = { id: true, level: true, chapter: true, status: true };

    const [fromLink, toLink] = await Promise.all([
      prisma.groupProgression.findFirst({
        where: { toGroupId: groupId, schoolId },
        select: { fromGroup: { select: groupFields } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.groupProgression.findFirst({
        where: { fromGroupId: groupId, schoolId },
        select: { toGroup: { select: groupFields } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({
      success: true,
      data: {
        promotedFrom: fromLink?.fromGroup ?? null,
        promotedTo: toLink?.toGroup ?? null,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'GET /:id/progression');
    res.status(500).json({ success: false, error: 'Failed to load progression' });
  }
});


export default router;
