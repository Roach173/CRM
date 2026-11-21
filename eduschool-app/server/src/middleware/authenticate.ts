import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { runWithContext } from '../lib/requestContext';
import { getCachedUser, getFreshUser } from '../lib/userCache';
import { getJwtSecret } from '../lib/jwtSecret';
import { Sentry } from '../instrument';

export interface AuthRequest extends Request {
  user?: {
    userId: number;
    schoolId: number; // runtime null for SUPERADMIN
    role: Role;
    tokenVersion: number;
  };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];

  let decoded: any;
  try {
    decoded = jwt.verify(token, getJwtSecret());
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  if (!decoded?.userId) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  // Freshness check — load from Redis (60s TTL) or DB
  let user: Awaited<ReturnType<typeof getCachedUser>>;
  try {
    user = await getCachedUser(decoded.userId);
    if (decoded.role === Role.SUPERADMIN || user?.role === Role.SUPERADMIN) {
      user = await getFreshUser(decoded.userId);
    }
  } catch {
    // DB unreachable — fail closed
    return res.status(503).json({ success: false, error: 'Service unavailable' });
  }

  if (!user) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // Soft-deleted account
  if (user.deletedAt) {
    return res.status(401).json({ success: false, error: 'Account deleted' });
  }

  // tokenVersion check — decoded.tokenVersion ?? 0 for backward compat with old JWTs
  const jwtVersion = (decoded.tokenVersion as number | undefined) ?? 0;
  if (jwtVersion !== user.tokenVersion) {
    return res.status(401).json({ success: false, error: 'Session expired' });
  }

  // School blocked check — hard block only after 7-day grace
  if (user.schoolBlockedAt) {
    const blockDeadline = new Date(user.schoolBlockedAt);
    blockDeadline.setDate(blockDeadline.getDate() + 7);
    if (new Date() > blockDeadline) {
      return res.status(403).json({ success: false, error: 'School access blocked' });
    }
  }

  req.user = {
    userId: user.id,
    schoolId: user.schoolId as any,
    role: user.role as Role,
    tokenVersion: user.tokenVersion,
  };

  const requestId = req.headers['x-request-id'] as string | undefined;

  // Tag all Sentry events with the authenticated user and request correlation ID
  Sentry.setUser({
    id: String(user.id),
    role: user.role,
    schoolId: user.schoolId ?? undefined,
  } as any);
  if (requestId) {
    Sentry.setTag('request_id', requestId);
  }

  if (user.schoolId) {
    runWithContext({ schoolId: user.schoolId, userId: user.id, role: user.role, requestId }, next);
  } else {
    runWithContext({ userId: user.id, role: user.role, requestId }, next);
  }
};
