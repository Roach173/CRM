import { Router } from 'express';
import { Prisma, Role } from '@prisma/client';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { subscriptionGuard } from '../middleware/subscriptionGuard';
import { createLogger } from '../lib/logger';

const router = Router();
const log = createLogger('schools');

// Private route for the current school (Settings)
router.get('/current/me', authenticate, subscriptionGuard, requirePermission('settings:read'), async (req: AuthRequest, res) => {
  try {
    if (!req.user?.schoolId) {
      return res.status(404).json({ success: false, error: 'School not found' });
    }

    const school = await prisma.school.findFirst({
      where: { id: req.user.schoolId, deletedAt: null },
      // Explicit fields only — never return the raw `settings` JSON blob (pixels,
      // attribution, lead config) here. Staff-only (settings:read).
      select: {
        id: true, name: true, slug: true, email: true, city: true, phone: true,
        address: true, description: true, timezone: true, createdAt: true,
        onboardingCompleted: true, onboardingStep: true, onboardingCompletedAt: true,
      },
    });

    res.json({ success: true, data: school });
  } catch (error) {
    log.error({ err: error }, 'failed to load current school');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Update current school details
router.put('/current/me', authenticate, subscriptionGuard, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const { name, city, phone, email, address } = req.body;

    const updated = await prisma.school.update({
      where: { id: req.user!.schoolId! },
      data: { name, city, phone, email, address },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    log.error({ err: error }, 'failed to update current school');
    res.status(500).json({ success: false, error: 'Update failed' });
  }
});

// Update school branding (logo, public landing hero photo, description) —
// narrower than settings:write (which also grants ADMIN): landing branding is
// OWNER/SUPERADMIN only, matching upload.ts's own role restriction.
// Keep this above /:slug — otherwise Express matches "current" as a slug.
router.patch('/current/branding', authenticate, subscriptionGuard, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const role = req.user!.role;
    if (role !== Role.OWNER && role !== Role.SUPERADMIN) {
      return res.status(403).json({ success: false, error: 'Forbidden: OWNER role required' });
    }

    const schoolId = req.user!.schoolId!;
    const { logoUrl, heroImageUrl, description } = req.body;

    const isValidUploadUrl = (v: unknown): v is string => typeof v === 'string' && (v === '' || v.startsWith('/uploads/'));
    if (logoUrl !== undefined && !isValidUploadUrl(logoUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid logo URL' });
    }
    if (heroImageUrl !== undefined && !isValidUploadUrl(heroImageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid hero image URL' });
    }

    const school = await prisma.school.findFirst({ where: { id: schoolId, deletedAt: null }, select: { id: true, settings: true } });
    if (!school) return res.status(404).json({ success: false, error: 'School not found' });

    const current = school.settings && typeof school.settings === 'object' && !Array.isArray(school.settings) ? school.settings as Record<string, unknown> : {};
    const existingLandingConfig = (current.landingConfig as Record<string, unknown> | undefined) ?? {};

    const landingConfig: Record<string, unknown> = {
      ...existingLandingConfig,
      ...(heroImageUrl !== undefined ? { heroImageUrl: heroImageUrl || null } : {}),
    };

    const schoolUpdate: Prisma.SchoolUpdateInput = {
      settings: { ...current, landingConfig } as Prisma.InputJsonObject,
    };
    if (typeof logoUrl === 'string') schoolUpdate.logoUrl = logoUrl || null;
    if (typeof description === 'string') schoolUpdate.description = description.trim().slice(0, 500) || null;

    const updated = await prisma.school.update({
      where: { id: schoolId },
      data: schoolUpdate,
      select: { logoUrl: true, description: true, settings: true },
    });

    const updatedSettings = updated.settings as Record<string, unknown>;
    res.json({
      success: true,
      data: {
        logoUrl: updated.logoUrl,
        description: updated.description,
        heroImageUrl: (updatedSettings.landingConfig as Record<string, unknown> | undefined)?.heroImageUrl ?? null,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'failed to update school branding');
    res.status(500).json({ success: false, error: 'Update failed' });
  }
});

// Public route to get school by slug. Keep this after /current/me and /current/branding.
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const school = await prisma.school.findFirst({
      where: { slug, deletedAt: null },
    });

    if (!school) {
      return res.status(404).json({ success: false, error: 'Школа не найдена' });
    }

    const settings = school.settings as any;

    const [studentCount, teacherCount] = await Promise.all([
      prisma.user.count({ where: { schoolId: school.id, role: Role.STUDENT, deletedAt: null } }),
      prisma.user.count({ where: { schoolId: school.id, role: Role.TEACHER, deletedAt: null } }),
    ]);

    res.json({
      success: true,
      data: {
        id: school.id,
        name: school.name,
        slug: school.slug,
        city: school.city,
        phone: school.phone,
        email: school.email,
        logoUrl: school.logoUrl,
        description: school.description,
        createdAt: school.createdAt,
        studentCount,
        teacherCount,
        landingConfig: settings?.landingConfig || null,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'failed to load school by slug');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
