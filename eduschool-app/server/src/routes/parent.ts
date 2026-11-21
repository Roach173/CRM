import { Router } from 'express';
import bcrypt from 'bcrypt';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { Role } from '@prisma/client';
import { projectSessionsForParent } from '../services/sessionProjectionService';
import { getPasswordError } from '../lib/passwordPolicy';
import { createLogger } from '../lib/logger';

const log = createLogger('parent');
const router = Router();

function requireParent(req: AuthRequest, res: any, next: any) {
  if (req.user?.role !== Role.PARENT) {
    return res.status(403).json({ success: false, error: 'Только для родителей' });
  }
  next();
}

// students:read is also held by TEACHER, but the parent roster (contact info for every
// family in the school) is an administrative view — OWNER/ADMIN only, per the ADMIN
// route comments below.
function requireAdmin(req: AuthRequest, res: any, next: any) {
  if (req.user?.role !== Role.OWNER && req.user?.role !== Role.ADMIN && req.user?.role !== Role.SUPERADMIN) {
    return res.status(403).json({ success: false, error: 'Недостаточно прав' });
  }
  next();
}

// ─── ADMIN: POST /parent/create — создать родителя и привязать к ребёнку ──────

router.post('/create', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const { firstName, lastName, email, phone, password, studentProfileId } = req.body;

    if (!firstName || !lastName || !email || !password || !studentProfileId) {
      return res.status(400).json({ success: false, error: 'firstName, lastName, email, password, studentProfileId обязательны' });
    }

    const passwordError = getPasswordError(password);
    if (passwordError) {
      return res.status(400).json({ success: false, error: passwordError });
    }

    // Проверяем что студент принадлежит этой школе
    const student = await prisma.studentProfile.findFirst({
      where: { id: Number(studentProfileId), user: { schoolId } },
    });
    if (!student) return res.status(404).json({ success: false, error: 'Студент не найден' });

    const existing = await prisma.user.findFirst({ where: { email, schoolId } });
    if (existing) return res.status(409).json({ success: false, error: 'Email уже используется' });

    const hashed = await bcrypt.hash(password, 10);

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          firstName,
          lastName,
          email,
          phone: phone ?? null,
          password: hashed,
          role: Role.PARENT,
          schoolId,
        },
      });
      const pp = await tx.parentProfile.create({
        data: { userId: u.id, schoolId },
      });
      await tx.parentChild.create({
        data: { parentProfileId: pp.id, studentProfileId: Number(studentProfileId) },
      });
      return u;
    });

    res.status(201).json({ success: true, data: { userId: user.id } });
  } catch (error) {
    log.error({ err: error }, 'create parent error');
    res.status(500).json({ success: false, error: 'Ошибка создания родителя' });
  }
});

// ─── ADMIN: POST /parent/:parentProfileId/link — привязать ещё одного ребёнка

router.post('/:parentProfileId/link', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const parentProfileId = parseInt(req.params.parentProfileId);
    const { studentProfileId } = req.body;

    const pp = await prisma.parentProfile.findFirst({
      where: { id: parentProfileId, schoolId, deletedAt: null },
    });
    if (!pp) return res.status(404).json({ success: false, error: 'Родитель не найден' });

    const student = await prisma.studentProfile.findFirst({
      where: { id: Number(studentProfileId), user: { schoolId } },
    });
    if (!student) return res.status(404).json({ success: false, error: 'Студент не найден' });

    await prisma.parentChild.create({
      data: { parentProfileId, studentProfileId: Number(studentProfileId) },
    });

    res.json({ success: true });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'Студент уже привязан к этому родителю' });
    }
    res.status(500).json({ success: false, error: 'Ошибка привязки' });
  }
});

// ─── ADMIN: GET /parent — список родителей школы ──────────────────────────────

router.get('/', authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;

    const parents = await prisma.parentProfile.findMany({
      where: { schoolId, deletedAt: null },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        children: {
          include: {
            studentProfile: {
              include: {
                user: { select: { id: true, firstName: true, lastName: true } },
              },
            },
          },
        },
      },
    });

    res.json({ success: true, data: parents });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка загрузки' });
  }
});

// ─── PARENT: GET /parent/me/children — мои дети (базовая информация) ─────────

router.get('/me/children', authenticate, requireParent, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const userId = req.user!.userId;

    const pp = await prisma.parentProfile.findFirst({
      where: { userId, schoolId, deletedAt: null },
      include: {
        children: {
          include: {
            studentProfile: {
              include: {
                user: { select: { id: true, firstName: true, lastName: true, phone: true } },
                memberships: {
                  where: { status: 'ACTIVE', studentGroup: { deletedAt: null } },
                  include: {
                    studentGroup: {
                      select: {
                        id: true, level: true,
                        blocks: {
                          where: { deletedAt: null },
                          select: { id: true, type: true, days: true, startTime: true, endTime: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!pp) return res.status(404).json({ success: false, error: 'Профиль родителя не найден' });

    const children = pp.children.map(c => ({
      studentProfileId: c.studentProfileId,
      name: `${c.studentProfile.user.firstName} ${c.studentProfile.user.lastName}`,
      phone: c.studentProfile.user.phone,
      credits: c.studentProfile.credits,
      level: c.studentProfile.level,
      isFrozen: c.studentProfile.isFrozen,
      atRiskSince: c.studentProfile.atRiskSince,
      groups: c.studentProfile.memberships.map(m => ({
        id: m.studentGroup.id,
        level: m.studentGroup.level,
        blocks: m.studentGroup.blocks,
      })),
    }));

    res.json({ success: true, data: children });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка загрузки' });
  }
});

// ─── PARENT: GET /parent/me/children/:studentProfileId/attendance ─────────────

router.get('/me/children/:studentProfileId/attendance', authenticate, requireParent, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const userId = req.user!.userId;
    const studentProfileId = parseInt(req.params.studentProfileId);

    // Проверяем что этот студент — ребёнок данного родителя
    const pp = await prisma.parentProfile.findFirst({ where: { userId, schoolId, deletedAt: null } });
    if (!pp) return res.status(403).json({ success: false, error: 'Нет доступа' });

    const link = await prisma.parentChild.findFirst({ where: { parentProfileId: pp.id, studentProfileId } });
    if (!link) return res.status(403).json({ success: false, error: 'Нет доступа к этому студенту' });

    const { from, to } = req.query;
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from as string);
    if (to) dateFilter.lte = new Date(to as string);

    const attendance = await prisma.attendance.findMany({
      where: {
        studentProfileId,
        schoolId,
        ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        status: true,
        createdAt: true,
        creditDeducted: true,
        lessonSession: {
          select: {
            date: true,
            startTimeSnap: true,
            endTimeSnap: true,
            lessonBlock: { select: { type: true, studentGroup: { select: { level: true } } } },
          },
        },
      },
    });

    res.json({ success: true, data: attendance });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка загрузки' });
  }
});

// ─── PARENT: GET /parent/me/children/:studentProfileId/schedule ──────────────

router.get('/me/children/:studentProfileId/schedule', authenticate, requireParent, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const userId = req.user!.userId;
    const studentProfileId = parseInt(req.params.studentProfileId);

    const pp = await prisma.parentProfile.findFirst({ where: { userId, schoolId, deletedAt: null } });
    if (!pp) return res.status(403).json({ success: false, error: 'Нет доступа' });

    const link = await prisma.parentChild.findFirst({ where: { parentProfileId: pp.id, studentProfileId } });
    if (!link) return res.status(403).json({ success: false, error: 'Нет доступа к этому студенту' });

    const now = new Date();
    const twoWeeksAhead = new Date(now.getTime() + 14 * 86_400_000);

    const sessions = await prisma.lessonSession.findMany({
      where: {
        schoolId,
        date: { gte: now, lte: twoWeeksAhead },
        deletedAt: null,
        status: { not: 'INVALIDATED' },
        sessionStudents: { some: { studentProfileId } },
      },
      orderBy: { date: 'asc' },
      select: {
        id: true,
        date: true,
        status: true,
        startTimeSnap: true,
        endTimeSnap: true,
        isMakeup: true,
        makeupForSessionId: true,
        teacherId: true,
        teacherIdSnap: true,
        isManualTeacher: true,
        teacher: { select: { user: { select: { firstName: true, lastName: true } } } },
        lessonBlock: {
          select: {
            type: true,
            studentGroup: { select: { level: true } },
            cabinet: { select: { name: true } },
            teacher: { select: { user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    });

    res.json({ success: true, data: projectSessionsForParent(sessions) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка загрузки' });
  }
});

export default router;
