import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { getSubscriptionState } from '../lib/subscription';

const router = Router();

router.get('/status', authenticate, async (req: AuthRequest, res) => {
  try {
    if (!req.user?.schoolId) {
      return res.json({
        success: true,
        data: {
          status: 'ACTIVE',
          trialEndsAt: null,
          graceEndsAt: null,
          daysRemaining: null,
          canRead: true,
          canWrite: true,
          blockedReason: null,
          warning: null,
        },
      });
    }

    const state = await getSubscriptionState(req.user.schoolId);
    if (state.warning) {
      res.setHeader('X-Subscription-Warning', state.warning);
    }

    res.json({
      success: true,
      data: {
        status: state.status,
        trialEndsAt: state.trialEndsAt?.toISOString() ?? null,
        graceEndsAt: state.graceEndsAt?.toISOString() ?? null,
        daysRemaining: state.daysRemaining,
        canRead: state.canRead,
        canWrite: state.canWrite,
        blockedReason: state.blockedReason,
        warning: state.warning,
      },
    });
  } catch {
    res.status(503).json({ success: false, error: 'Subscription check unavailable' });
  }
});

export default router;
