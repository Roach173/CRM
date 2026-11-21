import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { createLogger } from '../lib/logger';

const log = createLogger('onboarding');
const router = Router();

const ALLOWED_STEPS = ['basic-info', 'format', 'cabinets', 'subjects', 'team', 'complete'];

// Middleware to restrict access only to OWNER
const requireOwner = (req: AuthRequest, res: Response, next: () => void) => {
  if (!req.user || req.user.role !== 'OWNER') {
    return res.status(403).json({ success: false, error: 'Доступ разрешен только владельцу школы' });
  }
  next();
};

// GET /api/v1/onboarding/status
router.get('/status', authenticate, requireOwner, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) {
      return res.status(404).json({ success: false, error: 'Школа не найдена' });
    }

    const school = await prisma.school.findFirst({
      where: { id: schoolId, deletedAt: null },
      select: {
        onboardingCompleted: true,
        onboardingStep: true,
        onboardingCompletedAt: true,
      },
    });

    if (!school) {
      return res.status(404).json({ success: false, error: 'Школа не найдена' });
    }

    res.json({
      success: true,
      data: {
        onboardingCompleted: school.onboardingCompleted,
        onboardingStep: school.onboardingStep,
        onboardingCompletedAt: school.onboardingCompletedAt?.toISOString() || null,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'failed to fetch onboarding status');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/v1/onboarding/save-step
router.post('/save-step', authenticate, requireOwner, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) {
      return res.status(404).json({ success: false, error: 'Школа не найдена' });
    }

    const { step } = req.body;
    if (!step || typeof step !== 'string') {
      return res.status(400).json({ success: false, error: 'Параметр step обязателен' });
    }

    if (!ALLOWED_STEPS.includes(step)) {
      return res.status(400).json({ success: false, error: 'Недопустимое значение шага онбординга' });
    }

    // Update school step
    const updatedSchool = await prisma.school.update({
      where: { id: schoolId },
      data: {
        onboardingStep: step,
      },
    });

    res.json({
      success: true,
      data: {
        onboardingCompleted: updatedSchool.onboardingCompleted,
        onboardingStep: updatedSchool.onboardingStep,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'failed to save onboarding step');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/v1/onboarding/complete
router.post('/complete', authenticate, requireOwner, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) {
      return res.status(404).json({ success: false, error: 'Школа не найдена' });
    }

    // Complete onboarding
    const updatedSchool = await prisma.school.update({
      where: { id: schoolId },
      data: {
        onboardingCompleted: true,
        onboardingStep: 'complete',
        onboardingCompletedAt: new Date(),
      },
    });

    res.json({
      success: true,
      data: {
        onboardingCompleted: updatedSchool.onboardingCompleted,
        onboardingStep: updatedSchool.onboardingStep,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'failed to complete onboarding');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
