import { NextFunction, Response } from 'express';
import { Role } from '@prisma/client';
import { AuthRequest } from './authenticate';
import { getSubscriptionState, isWriteMethod, SubscriptionState } from '../lib/subscription';

declare global {
  namespace Express {
    interface Request {
      subscription?: SubscriptionState;
    }
  }
}

export async function subscriptionGuard(req: AuthRequest, res: Response, next: NextFunction) {
  const schoolId = req.user?.schoolId;
  if (!schoolId) return next();
  if (req.user?.role === Role.SUPERADMIN) return next();

  let state: SubscriptionState;
  try {
    state = await getSubscriptionState(schoolId);
  } catch {
    return res.status(503).json({ success: false, error: 'Subscription check unavailable' });
  }

  req.subscription = state;

  if (state.warning) {
    res.setHeader('X-Subscription-Warning', state.warning);
  }

  if (!state.canRead) {
    return res.status(403).json({
      success: false,
      error: 'Subscription blocked',
      code: 'SUBSCRIPTION_BLOCKED',
      blockedReason: state.blockedReason,
    });
  }

  if (isWriteMethod(req.method) && !state.canWrite) {
    return res.status(402).json({
      success: false,
      error: 'Payment required',
      code: 'PAYMENT_REQUIRED',
      blockedReason: state.blockedReason,
    });
  }

  next();
}
