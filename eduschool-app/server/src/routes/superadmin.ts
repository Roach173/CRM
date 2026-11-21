import { Router } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { Prisma, Role, SubscriptionStatus } from '@prisma/client';
import { invalidateSubscriptionCache } from '../lib/subscription';
import { logSecurityEvent } from '../lib/auditLog';
import { createLogger } from '../lib/logger';
import { HelpTopicsError, readHelpTopics, sanitizeHelpTopicsInput } from '../lib/helpTopics';

const log = createLogger('superadmin');

const router = Router();

function requireSuperAdmin(req: AuthRequest, res: any, next: any) {
  if (req.user?.role !== Role.SUPERADMIN) {
    return res.status(403).json({ success: false, error: 'Только для SuperAdmin' });
  }
  next();
}

// GET /superadmin/schools — все школы с метриками
router.get('/schools', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const schools = await prisma.school.findMany({
      where: { deletedAt: null },
      include: {
        subscription: true,
        _count: {
          select: {
            users: true,
            blocks: true,
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Batched instead of 3 count queries per school (was ~150 round trips at 50 schools).
    const schoolIds = schools.map(s => s.id);
    const [studentCounts, teacherCounts, activeBlockCounts] = await Promise.all([
      prisma.user.groupBy({ by: ['schoolId'], where: { schoolId: { in: schoolIds }, role: Role.STUDENT, deletedAt: null }, _count: { _all: true } }),
      prisma.user.groupBy({ by: ['schoolId'], where: { schoolId: { in: schoolIds }, role: Role.TEACHER, deletedAt: null }, _count: { _all: true } }),
      prisma.lessonBlock.groupBy({ by: ['schoolId'], where: { schoolId: { in: schoolIds }, deletedAt: null, status: 'UPCOMING' }, _count: { _all: true } }),
    ]);
    const studentsBySchool = new Map(studentCounts.map(r => [r.schoolId, r._count._all]));
    const teachersBySchool = new Map(teacherCounts.map(r => [r.schoolId, r._count._all]));
    const activeBlocksBySchool = new Map(activeBlockCounts.map(r => [r.schoolId, r._count._all]));

    const result = schools.map((school) => {
      const students = studentsBySchool.get(school.id) ?? 0;
      const teachers = teachersBySchool.get(school.id) ?? 0;
      const activeBlocks = activeBlocksBySchool.get(school.id) ?? 0;

      return {
        id: school.id,
        name: school.name,
        city: school.city,
        slug: school.slug,
        email: school.email,
        phone: school.phone,
        createdAt: school.createdAt,
        isActive: (school as any).isActive ?? true,
        blockedAt: (school as any).blockedAt ?? null,
        subscription: (school as any).subscription
          ? {
              status: (school as any).subscription.status,
              plan: (school as any).subscription.plan,
              trialEndsAt: (school as any).subscription.trialEndsAt ?? null,
              graceEndsAt: (school as any).subscription.graceEndsAt ?? null,
              paidUntil: (school as any).subscription.paidUntil ?? null,
            }
          : null,
        stats: {
          students,
          teachers,
          activeBlocks,
        }
      };
    });

    res.json({ success: true, data: result });
  } catch (error) {
    log.error({ err: error }, 'list schools error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// GET /superadmin/stats — общая статистика платформы
router.get('/stats', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const [totalSchools, totalStudents, totalTeachers, totalBlocks] = await Promise.all([
      prisma.school.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { role: Role.STUDENT, deletedAt: null } }),
      prisma.user.count({ where: { role: Role.TEACHER, deletedAt: null } }),
      prisma.lessonBlock.count({ where: { deletedAt: null, status: 'UPCOMING' } }),
    ]);

    res.json({
      success: true,
      data: {
        totalSchools,
        totalStudents,
        totalTeachers,
        totalBlocks,
      }
    });
  } catch (error) {
    log.error({ err: error }, 'platform stats error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// GET /superadmin/schools/:id — детали одной школы
router.get('/schools/:id', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const schoolId = parseInt(req.params.id);

    const school = await prisma.school.findFirst({
      where: { id: schoolId, deletedAt: null },
    });

    if (!school) return res.status(404).json({ success: false, error: 'Школа не найдена' });

    const [students, teachers, admins, activeBlocks, completedBlocks] = await Promise.all([
      prisma.user.findMany({
        where: { schoolId, role: Role.STUDENT, deletedAt: null },
        select: { id: true, firstName: true, lastName: true, createdAt: true }
      }),
      prisma.user.findMany({
        where: { schoolId, role: Role.TEACHER, deletedAt: null },
        select: { id: true, firstName: true, lastName: true }
      }),
      prisma.user.findMany({
        where: { schoolId, role: Role.ADMIN, deletedAt: null },
        select: { id: true, firstName: true, lastName: true }
      }),
      prisma.lessonBlock.count({ where: { schoolId, deletedAt: null, status: 'UPCOMING' } }),
      prisma.lessonBlock.count({ where: { schoolId, deletedAt: null, status: 'COMPLETED' } }),
    ]);

    res.json({
      success: true,
      data: {
        ...school,
        students,
        teachers,
        admins,
        stats: { activeBlocks, completedBlocks }
      }
    });
  } catch (error) {
    log.error({ err: error }, 'school details error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// PATCH /superadmin/schools/:id/toggle-active — заблокировать / разблокировать школу
router.patch('/schools/:id/toggle-active', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const schoolId = parseInt(req.params.id);

    const school = await prisma.school.findFirst({
      where: { id: schoolId, deletedAt: null }
    });

    if (!school) return res.status(404).json({ success: false, error: 'Школа не найдена' });

    const currentlyActive = (school as any).isActive ?? true;

    const updated = await prisma.school.update({
      where: { id: schoolId },
      data: {
        isActive: !currentlyActive,
        // При блокировке — ставим дату, при разблокировке — очищаем
        blockedAt: currentlyActive ? new Date() : null
      }
    });
    await invalidateSubscriptionCache(schoolId);

    res.json({
      success: true,
      isActive: (updated as any).isActive,
      blockedAt: (updated as any).blockedAt
    });
  } catch (error) {
    log.error({ err: error }, 'toggle school active error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// ── Recovery tools (SUPERADMIN-only, all require reason + audit log) ──────────

/**
 * POST /superadmin/schools/:id/invalidate-sessions
 * Bumps tokenVersion for all users in the school (invalidates all JWTs)
 * and revokes all refresh tokens. Use during incident response.
 */
router.post('/schools/:id/invalidate-sessions', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const schoolId = parseInt(req.params.id);
    const reason   = (req.body?.reason as string | undefined)?.trim();

    if (!reason || reason.length < 5) {
      return res.status(400).json({ success: false, error: 'reason обязателен (минимум 5 символов)' });
    }

    const school = await prisma.school.findFirst({ where: { id: schoolId, deletedAt: null } });
    if (!school) return res.status(404).json({ success: false, error: 'Школа не найдена' });

    // Bump tokenVersion for all active users → invalidates all outstanding JWTs
    const { count: usersAffected } = await prisma.user.updateMany({
      where: { schoolId, deletedAt: null },
      data:  { tokenVersion: { increment: 1 } },
    });

    // Revoke all outstanding refresh tokens for school users
    const userIds = (await prisma.user.findMany({
      where:  { schoolId, deletedAt: null },
      select: { id: true },
    })).map(u => u.id);

    const { count: tokensRevoked } = await prisma.refreshToken.updateMany({
      where: { userId: { in: userIds }, revokedAt: null },
      data:  { revokedAt: new Date() },
    });

    await logSecurityEvent({
      event: 'SESSIONS_INVALIDATED',
      schoolId,
      userId: req.user!.userId,
      details: { reason, usersAffected, tokensRevoked },
      req,
    });

    log.warn({ schoolId, usersAffected, tokensRevoked, reason }, 'RECOVERY: sessions invalidated');
    res.json({ success: true, data: { usersAffected, tokensRevoked } });
  } catch (error) {
    log.error({ err: error }, 'invalidate-sessions failed');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

/**
 * POST /superadmin/webhooks/:id/disable
 * Force-disables a webhook endpoint. Use when a webhook is causing delivery storms
 * or pointing to a compromised URL.
 */
router.post('/webhooks/:id/disable', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const webhookId = parseInt(req.params.id);
    const reason    = (req.body?.reason as string | undefined)?.trim();

    if (!reason || reason.length < 5) {
      return res.status(400).json({ success: false, error: 'reason обязателен (минимум 5 символов)' });
    }

    const webhook = await prisma.webhook.findFirst({ where: { id: webhookId } });
    if (!webhook) return res.status(404).json({ success: false, error: 'Webhook не найден' });

    if (webhook.isActive) {
      await prisma.webhook.update({
        where: { id: webhookId },
        data:  { isActive: false },
      });
    }

    await logSecurityEvent({
      event: 'WEBHOOK_FORCE_DISABLED',
      schoolId: webhook.schoolId,
      userId: req.user!.userId,
      details: { webhookId, url: webhook.url, reason },
      req,
    });

    log.warn({ webhookId, schoolId: webhook.schoolId, reason }, 'RECOVERY: webhook force-disabled');
    res.json({ success: true, data: { webhookId, wasActive: webhook.isActive } });
  } catch (error) {
    log.error({ err: error }, 'webhook-disable failed');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

/**
 * POST /superadmin/idempotency/cleanup-stuck
 * Deletes IN_PROGRESS idempotency keys older than a threshold.
 * Default threshold: 60 minutes. Use when stuck keys are blocking retries.
 */
router.post('/idempotency/cleanup-stuck', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const reason         = (req.body?.reason as string | undefined)?.trim();
    const olderThanMins  = Math.min(
      10080, // max 1 week
      Math.max(5, parseInt(req.body?.olderThanMinutes) || 60),
    );

    if (!reason || reason.length < 5) {
      return res.status(400).json({ success: false, error: 'reason обязателен (минимум 5 символов)' });
    }

    const cutoff = new Date(Date.now() - olderThanMins * 60 * 1000);

    const { count } = await prisma.idempotencyKey.deleteMany({
      where: { status: 'IN_PROGRESS', startedAt: { lt: cutoff } },
    });

    await logSecurityEvent({
      event: 'IDEMPOTENCY_STUCK_CLEANUP',
      schoolId: null,
      userId: req.user!.userId,
      details: { reason, olderThanMins, deletedCount: count, cutoff: cutoff.toISOString() },
      req,
    });

    log.warn({ count, olderThanMins, reason }, 'RECOVERY: stuck idempotency keys deleted');
    res.json({ success: true, data: { deletedCount: count, olderThanMinutes: olderThanMins } });
  } catch (error) {
    log.error({ err: error }, 'idempotency cleanup-stuck failed');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

/**
 * PATCH /superadmin/schools/:id/subscription
 * Manually override subscription status. Use to manually activate/block a school's subscription.
 */
router.patch('/schools/:id/subscription', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const schoolId = parseInt(req.params.id);
    const reason   = (req.body?.reason as string | undefined)?.trim();
    const status   = req.body?.status as string | undefined;

    if (!reason || reason.length < 5) {
      return res.status(400).json({ success: false, error: 'reason обязателен (минимум 5 символов)' });
    }

    const validStatuses = Object.values(SubscriptionStatus) as string[];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `status должен быть одним из: ${validStatuses.join(', ')}`,
      });
    }

    const school = await prisma.school.findFirst({ where: { id: schoolId, deletedAt: null } });
    if (!school) return res.status(404).json({ success: false, error: 'Школа не найдена' });

    const subscription = await prisma.subscription.findUnique({ where: { schoolId } });
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Подписка не найдена для этой школы' });
    }

    const previousStatus = subscription.status;

    const updated = await prisma.subscription.update({
      where: { schoolId },
      data:  { status: status as SubscriptionStatus },
    });
    await invalidateSubscriptionCache(schoolId);

    await logSecurityEvent({
      event: 'SUBSCRIPTION_OVERRIDE',
      schoolId,
      userId: req.user!.userId,
      details: { reason, previousStatus, newStatus: status },
      req,
    });

    log.warn({ schoolId, previousStatus, newStatus: status, reason }, 'RECOVERY: subscription status overridden');
    res.json({ success: true, data: { schoolId, status: updated.status, previousStatus } });
  } catch (error) {
    log.error({ err: error }, 'subscription override failed');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// ─── Help topics (platform-wide, shown on every school's /help page) ────────────
// Storage: PlatformSettings singleton (id=1), not School.settings — this is
// authored once by SUPERADMIN for all tenants, not per-school. Public read is
// GET /api/settings/help (routes/settings.ts); only the write is SUPERADMIN-gated.
router.get('/help', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  const settings = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { help: true } });
  res.json({ success: true, data: readHelpTopics({ help: settings?.help ?? [] }) });
});

router.patch('/help', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const topics = sanitizeHelpTopicsInput(req.body?.help);
    await prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, help: topics as unknown as Prisma.InputJsonValue },
      update: { help: topics as unknown as Prisma.InputJsonValue },
    });
    res.json({ success: true, data: topics });
  } catch (error) {
    if (error instanceof HelpTopicsError) return res.status(400).json({ success: false, error: error.message });
    res.status(500).json({ success: false, error: 'Failed to update help topics' });
  }
});

export default router;
