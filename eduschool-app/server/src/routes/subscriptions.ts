import { Router } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { Role } from '@prisma/client';
import { invalidateSubscriptionCache } from '../lib/subscription';
import { createLogger } from '../lib/logger';
import * as notificationService from '../services/notificationService';

const log = createLogger('subscriptions');
const router = Router();

function requireSuperAdmin(req: AuthRequest, res: any, next: any) {
  if (req.user?.role !== Role.SUPERADMIN) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
}

// List all subscriptions
router.get('/', authenticate, requireSuperAdmin, async (_req, res) => {
  try {
    const subs = await prisma.subscription.findMany({
      include: { school: { select: { id: true, name: true, slug: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: subs });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Extend trial or paid period
router.patch('/:schoolId/extend', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const schoolId = parseInt(req.params.schoolId);
    if (isNaN(schoolId) || schoolId <= 0) {
      return res.status(400).json({ success: false, error: 'schoolId must be a positive integer' });
    }

    const { days, plan } = req.body as { days: number; plan?: string };

    if (days === undefined || days === null || typeof days !== 'number' || isNaN(days) || !Number.isInteger(days) || days < 1 || days > 3650) {
      return res.status(400).json({ success: false, error: 'days must be an integer between 1 and 3650' });
    }

    if (plan && !['TRIAL', 'STARTER', 'OPTIMA', 'NETWORK'].includes(plan)) {
      return res.status(400).json({ success: false, error: 'Invalid plan' });
    }

    const sub = await prisma.subscription.findUnique({ where: { schoolId } });
    if (!sub) return res.status(404).json({ success: false, error: 'Subscription not found' });

    const base = sub.paidUntil && sub.paidUntil > new Date()
      ? sub.paidUntil
      : new Date();

    const newPaidUntil = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    const graceEndsAt = new Date(newPaidUntil.getTime() + 3 * 24 * 60 * 60 * 1000);

    const updated = await prisma.subscription.update({
      where: { schoolId },
      data: {
        paidUntil: newPaidUntil,
        graceEndsAt,
        status: 'ACTIVE',
        ...(plan ? { plan: plan as any } : {}),
      },
    });

    await invalidateSubscriptionCache(schoolId);

    try {
      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { slug: true }
      });
      const schoolSlug = school?.slug || '';
      const planText = plan || sub.plan;

      await notificationService.createForRole({
        schoolId,
        role: Role.OWNER,
        type: 'SUBSCRIPTION_EXTENDED',
        title: 'Подписка продлена',
        body: `Доступ продлен на ${days} дней. Тариф: ${planText}.`,
        category: 'SUBSCRIPTION',
        priority: 'HIGH',
        actionUrl: `/${schoolSlug}/owner/dashboard`,
        entityType: 'Subscription',
        entityId: updated.schoolId,
        data: { days, plan: planText }
      });

      await notificationService.createForRole({
        schoolId,
        role: Role.ADMIN,
        type: 'SUBSCRIPTION_EXTENDED',
        title: 'Подписка продлена',
        body: `Доступ продлен на ${days} дней. Тариф: ${planText}.`,
        category: 'SUBSCRIPTION',
        priority: 'HIGH',
        actionUrl: `/${schoolSlug}/admin/dashboard`,
        entityType: 'Subscription',
        entityId: updated.schoolId,
        data: { days, plan: planText }
      });
    } catch (err) {
      log.error({ err }, 'Failed to create subscription extended notifications');
    }

    // Logging action
    log.info({
      superadminId: req.user?.userId,
      action: 'extend',
      schoolId,
      days,
      plan: plan || sub.plan,
      old: { status: sub.status, paidUntil: sub.paidUntil?.toISOString() ?? null },
      new: { status: updated.status, paidUntil: updated.paidUntil?.toISOString() ?? null }
    }, 'Superadmin extended subscription');

    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Manually block a subscription
router.patch('/:schoolId/block', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const schoolId = parseInt(req.params.schoolId);
    if (isNaN(schoolId) || schoolId <= 0) {
      return res.status(400).json({ success: false, error: 'schoolId must be a positive integer' });
    }

    const sub = await prisma.subscription.findUnique({ where: { schoolId } });
    if (!sub) return res.status(404).json({ success: false, error: 'Subscription not found' });

    const updated = await prisma.subscription.update({
      where: { schoolId },
      data: { status: 'BLOCKED' },
    });

    await invalidateSubscriptionCache(schoolId);

    try {
      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { slug: true }
      });
      const schoolSlug = school?.slug || '';

      await notificationService.createForRole({
        schoolId,
        role: Role.OWNER,
        type: 'SUBSCRIPTION_BLOCKED',
        title: 'Доступ заблокирован',
        body: 'Срок действия подписки вашей школы истек или она заблокирована.',
        category: 'SUBSCRIPTION',
        priority: 'CRITICAL',
        actionUrl: `/${schoolSlug}/owner/dashboard`,
        entityType: 'Subscription',
        entityId: updated.schoolId,
      });

      await notificationService.createForRole({
        schoolId,
        role: Role.ADMIN,
        type: 'SUBSCRIPTION_BLOCKED',
        title: 'Доступ заблокирован',
        body: 'Срок действия подписки вашей школы истек или она заблокирована.',
        category: 'SUBSCRIPTION',
        priority: 'CRITICAL',
        actionUrl: `/${schoolSlug}/admin/dashboard`,
        entityType: 'Subscription',
        entityId: updated.schoolId,
      });
    } catch (err) {
      log.error({ err }, 'Failed to create subscription blocked notifications');
    }

    // Logging action
    log.info({
      superadminId: req.user?.userId,
      action: 'block',
      schoolId,
      old: { status: sub.status, paidUntil: sub.paidUntil?.toISOString() ?? null },
      new: { status: updated.status, paidUntil: updated.paidUntil?.toISOString() ?? null }
    }, 'Superadmin blocked subscription');

    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Mark as paid (manual cash/bank payment)
router.patch('/:schoolId/mark-paid', authenticate, requireSuperAdmin, async (req: AuthRequest, res) => {
  try {
    const schoolId = parseInt(req.params.schoolId);
    if (isNaN(schoolId) || schoolId <= 0) {
      return res.status(400).json({ success: false, error: 'schoolId must be a positive integer' });
    }

    const { days = 30, plan } = req.body as { days?: number; plan?: string };

    if (days === undefined || days === null || typeof days !== 'number' || isNaN(days) || !Number.isInteger(days) || days < 1 || days > 3650) {
      return res.status(400).json({ success: false, error: 'days must be an integer between 1 and 3650' });
    }

    if (plan && !['TRIAL', 'STARTER', 'OPTIMA', 'NETWORK'].includes(plan)) {
      return res.status(400).json({ success: false, error: 'Invalid plan' });
    }

    const sub = await prisma.subscription.findUnique({ where: { schoolId } });
    if (!sub) return res.status(404).json({ success: false, error: 'Subscription not found' });

    const newPaidUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const graceEndsAt = new Date(newPaidUntil.getTime() + 3 * 24 * 60 * 60 * 1000);

    const updated = await prisma.subscription.update({
      where: { schoolId },
      data: {
        paidUntil: newPaidUntil,
        graceEndsAt,
        status: 'ACTIVE',
        ...(plan ? { plan: plan as any } : {}),
      },
    });

    await invalidateSubscriptionCache(schoolId);

    try {
      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { slug: true }
      });
      const schoolSlug = school?.slug || '';
      const planText = plan || sub.plan;

      await notificationService.createForRole({
        schoolId,
        role: Role.OWNER,
        type: 'SUBSCRIPTION_MARK_PAID',
        title: 'Оплата подписки подтверждена',
        body: `Подписка активирована на ${days} дней. Тариф: ${planText}.`,
        category: 'SUBSCRIPTION',
        priority: 'HIGH',
        actionUrl: `/${schoolSlug}/owner/dashboard`,
        entityType: 'Subscription',
        entityId: updated.schoolId,
        data: { days, plan: planText }
      });

      await notificationService.createForRole({
        schoolId,
        role: Role.ADMIN,
        type: 'SUBSCRIPTION_MARK_PAID',
        title: 'Оплата подписки подтверждена',
        body: `Подписка активирована на ${days} дней. Тариф: ${planText}.`,
        category: 'SUBSCRIPTION',
        priority: 'HIGH',
        actionUrl: `/${schoolSlug}/admin/dashboard`,
        entityType: 'Subscription',
        entityId: updated.schoolId,
        data: { days, plan: planText }
      });
    } catch (err) {
      log.error({ err }, 'Failed to create subscription mark-paid notifications');
    }

    // Logging action
    log.info({
      superadminId: req.user?.userId,
      action: 'mark-paid',
      schoolId,
      days,
      plan: plan || sub.plan,
      old: { status: sub.status, paidUntil: sub.paidUntil?.toISOString() ?? null },
      new: { status: updated.status, paidUntil: updated.paidUntil?.toISOString() ?? null }
    }, 'Superadmin marked subscription as paid');

    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
