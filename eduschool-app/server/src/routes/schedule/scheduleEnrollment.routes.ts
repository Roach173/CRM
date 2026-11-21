import { Router } from 'express';
import prisma from '../../lib/prisma';
import { authenticate, AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { Role, EnrollmentStatus } from '@prisma/client';
import { notifySchoolAdmins } from '../../lib/notify';
import {
  assertGroupOperationallyActive,
  GroupLifecycleError,
} from '../../services/groupLifecycleService';
import { reconcileRosterOnMemberAdd } from '../../services/rosterService';
import {
  assertStudentBelongsToSchool,
  assertStudentsBelongToSchool,
  assertLessonBlockBelongsToSchool,
  isTenantNotFound,
} from '../../lib/tenant';
import {
  log,
  mapStudentScheduleConflicts,
} from './scheduleRouteUtils';

const router = Router();

// ─── POST /:id/apply — студент подаёт заявку ─────────────────────────────────

router.post('/:id/apply', authenticate, requirePermission('schedule:read'), async (req: AuthRequest, res) => {
  try {
    if (req.user?.role !== Role.STUDENT) return res.status(403).json({ success: false, error: 'Forbidden' });

    const studentProfile = await prisma.studentProfile.findFirst({ where: { userId: req.user!.userId, deletedAt: null } });
    if (!studentProfile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const lessonBlockId = parseInt(req.params.id);
    const block = await prisma.lessonBlock.findFirst({
      where: { id: lessonBlockId, schoolId: req.user!.schoolId! },
      select: { schoolId: true, level: true, studentGroupId: true },
    });
    if (!block) return res.status(404).json({ success: false, error: 'Группа не найдена' });

    const existing = await prisma.enrollmentRequest.findFirst({
      where: { lessonBlockId, studentProfileId: studentProfile.id },
    });
    let request;
    if (existing) {
      request = await prisma.enrollmentRequest.update({
        where: { id: existing.id },
        data: { status: EnrollmentStatus.PENDING },
      });
    } else {
      request = await prisma.enrollmentRequest.create({
        data: {
          schoolId: block.schoolId,
          lessonBlockId,
          studentGroupId: block.studentGroupId ?? undefined,
          studentProfileId: studentProfile.id,
          status: EnrollmentStatus.PENDING,
        },
      });
    }

    const student = await prisma.user.findFirst({ where: { id: req.user!.userId }, select: { firstName: true, lastName: true } });
    if (student) {
      await notifySchoolAdmins(block.schoolId, {
        type: 'ENROLLMENT_REQUEST',
        title: 'Новая заявка на обучение',
        body: `${student.firstName} ${student.lastName} подал заявку в группу ${block.level}`,
        data: { lessonBlockId, studentProfileId: studentProfile.id },
      });
    }

    res.json({ success: true, data: request });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// ─── PATCH /:id/approve/:studentProfileId ────────────────────────────────────

router.patch('/:id/approve/:studentProfileId', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {

    const lessonBlockId = parseInt(req.params.id);
    const studentProfileId = parseInt(req.params.studentProfileId);
    const schoolId = req.user!.schoolId!;

    // Validate block belongs to this school
    const block = await prisma.lessonBlock.findFirst({
      where: { id: lessonBlockId, schoolId, deletedAt: null },
      select: {
        studentGroupId: true,
        maxStudents: true,
        cabinet: { select: { capacity: true } },
        studentGroup: { select: { _count: { select: { memberships: { where: { status: 'ACTIVE' } } } } } },
      },
    });
    if (!block) return res.status(404).json({ success: false, error: 'Блок не найден' });

    // Validate student belongs to this school — prevents injecting foreign students
    await assertStudentBelongsToSchool(studentProfileId, schoolId);

    const enrollment = await prisma.enrollmentRequest.findFirst({ where: { lessonBlockId, studentProfileId } });
    const now = new Date();
    if (block.studentGroupId) {
      await assertGroupOperationallyActive(prisma, block.studentGroupId, schoolId);

      // Same capacity guard as /add/:studentProfileId — approving from the waitlist
      // must not silently overbook the group (matches CLAUDE.md's schedule-validation rule).
      const studentCount = block.studentGroup?._count.memberships ?? 0;
      const effectiveCap = Math.min(block.maxStudents, block.cabinet?.capacity ?? Infinity);
      if (studentCount >= effectiveCap) {
        return res.status(400).json({ success: false, error: `Группа заполнена (${studentCount}/${effectiveCap})` });
      }
    }

    await prisma.$transaction(async (tx) => {
      if (enrollment) {
        await tx.enrollmentRequest.update({
          where: { id: enrollment.id },
          data: { status: EnrollmentStatus.APPROVED },
        });
      }

      if (block.studentGroupId) {
        await tx.groupMembership.upsert({
          where: { studentProfileId_studentGroupId: { studentProfileId, studentGroupId: block.studentGroupId } },
          create: { schoolId, studentProfileId, studentGroupId: block.studentGroupId, joinedAt: now, status: 'ACTIVE' },
          update: { status: 'ACTIVE', leftAt: null, joinedAt: now },
        });

        // Снапшот для предстоящих сессий всех блоков группы
        await reconcileRosterOnMemberAdd(block.studentGroupId, schoolId, [studentProfileId], tx);
      }
    });

    res.json({ success: true });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'schedule enrollment error');
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// ─── PATCH /:id/reject/:studentProfileId ─────────────────────────────────────

router.patch('/:id/reject/:studentProfileId', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {

    const lessonBlockId = parseInt(req.params.id);
    const studentProfileId = parseInt(req.params.studentProfileId);
    const schoolId = req.user!.schoolId!;

    // Validate block belongs to this school before touching its enrollment requests
    await assertLessonBlockBelongsToSchool(lessonBlockId, schoolId);

    const enrollment = await prisma.enrollmentRequest.findFirst({ where: { lessonBlockId, studentProfileId, schoolId } });
    if (enrollment) {
      await prisma.enrollmentRequest.update({
        where: { id: enrollment.id },
        data: { status: EnrollmentStatus.REJECTED },
      });
    }
    res.json({ success: true });
  } catch (error) {
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// ─── PATCH /:id/add/:studentProfileId — добавить студента напрямую ────────────

router.patch('/:id/add/:studentProfileId', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {

    const lessonBlockId = parseInt(req.params.id);
    const studentProfileId = parseInt(req.params.studentProfileId);
    const schoolId = req.user!.schoolId!;

    const block = await prisma.lessonBlock.findFirst({
      where: { id: lessonBlockId, schoolId, deletedAt: null },
      include: {
        cabinet: { select: { capacity: true } },
        studentGroup: {
          include: {
            _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
          },
        },
      },
    });
    if (!block) return res.status(404).json({ success: false, error: 'Группа не найдена' });

    // Validate student belongs to this school — prevents cross-tenant injection
    await assertStudentBelongsToSchool(studentProfileId, schoolId);

    const studentCount = block.studentGroup?._count.memberships ?? 0;
    const effectiveCap = Math.min(
      block.maxStudents,
      block.cabinet?.capacity ?? Infinity,
    );
    if (studentCount >= effectiveCap) {
      return res.status(400).json({ success: false, error: `Группа заполнена (${studentCount}/${effectiveCap})` });
    }

    const conflicts = await mapStudentScheduleConflicts([studentProfileId], block);
    if (conflicts.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Конфликт расписания: ${conflicts[0].studentName} уже записан в ${conflicts[0].conflictLevel} (${conflicts[0].conflictDays})`,
      });
    }

    if (!block.studentGroupId) {
      return res.status(400).json({ success: false, error: 'Блок не привязан к группе' });
    }
    await assertGroupOperationallyActive(prisma, block.studentGroupId, schoolId);

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.groupMembership.upsert({
        where: { studentProfileId_studentGroupId: { studentProfileId, studentGroupId: block.studentGroupId! } },
        create: { schoolId, studentProfileId, studentGroupId: block.studentGroupId!, joinedAt: now, status: 'ACTIVE' },
        update: { status: 'ACTIVE', leftAt: null, joinedAt: now },
      });

      await reconcileRosterOnMemberAdd(block.studentGroupId!, schoolId, [studentProfileId], tx);
    });

    res.json({ success: true });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'schedule enrollment error');
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// ─── POST /:id/students — массовое добавление студентов ──────────────────────

router.post('/:id/students', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const { studentIds } = req.body;
    const lessonId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;

    const block = await prisma.lessonBlock.findFirst({
      where: { id: lessonId, schoolId, deletedAt: null },
      include: {
        cabinet: { select: { capacity: true } },
        studentGroup: { include: { _count: { select: { memberships: { where: { status: 'ACTIVE' } } } } } },
      },
    });
    if (!block) return res.status(404).json({ success: false, error: 'Группа не найдена' });

    // Validate all students belong to this school — prevents cross-tenant injection
    await assertStudentsBelongToSchool(studentIds as number[], schoolId);
    if (!block.studentGroupId) return res.status(400).json({ success: false, error: 'Блок не привязан к группе' });
    await assertGroupOperationallyActive(prisma, block.studentGroupId, schoolId);

    const studentCount = block.studentGroup?._count.memberships ?? 0;
    const effectiveCap = Math.min(block.maxStudents, block.cabinet?.capacity ?? Infinity);
    if (studentCount + studentIds.length > effectiveCap) {
      return res.status(400).json({ success: false, error: `Превышена вместимость группы (${studentCount}/${effectiveCap})` });
    }

    const conflicts = await mapStudentScheduleConflicts(studentIds, block);
    if (conflicts.length > 0) {
      const names = conflicts.map(c => `${c.studentName} (${c.conflictLevel}, ${c.conflictDays})`).join('; ');
      return res.status(400).json({ success: false, error: `Конфликт расписания: ${names}` });
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await Promise.all(
        (studentIds as number[]).map(id =>
          tx.groupMembership.upsert({
            where: { studentProfileId_studentGroupId: { studentProfileId: id, studentGroupId: block.studentGroupId! } },
            create: { schoolId, studentProfileId: id, studentGroupId: block.studentGroupId!, joinedAt: now, status: 'ACTIVE' },
            update: { status: 'ACTIVE', leftAt: null, joinedAt: now },
          })
        )
      );

      await reconcileRosterOnMemberAdd(block.studentGroupId!, schoolId, studentIds as number[], tx);
    });

    res.json({ success: true });
  } catch (error) {
    if (error instanceof GroupLifecycleError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'bulk add students error');
    res.status(500).json({ success: false, error: 'Failed to add students' });
  }
});

export default router;
