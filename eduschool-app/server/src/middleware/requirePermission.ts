import { Response, NextFunction } from 'express';
import { AuthRequest } from './authenticate';
import { can, Permission } from '../lib/permissions';
import { logSecurityEvent } from '../lib/auditLog';

/**
 * Middleware: требует наличия всех указанных прав у пользователя.
 * Использовать вместо inline проверок req.user?.role !== Role.OWNER и т.д.
 *
 * Примеры:
 *   router.post('/', authenticate, requirePermission('schedule:write'), handler)
 *   router.delete('/:id', authenticate, requirePermission('schedule:delete'), handler)
 */
export function requirePermission(...permissions: Permission[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const hasAll = permissions.every(p => can(role, p));
    if (!hasAll) {
      // Awaited deliberately: a fire-and-forget write here left an unfinished
      // INSERT into ScheduleActionLog racing against the next request's work —
      // harmless in isolation, but under enough 403 volume it can still be
      // mid-flight when something needs a conflicting lock on that table.
      await logSecurityEvent({
        event: 'PERMISSION_DENIED',
        schoolId: req.user?.schoolId ?? null,
        userId: req.user?.userId ?? null,
        details: { permissions, role, path: req.path, method: req.method },
        req,
      });
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  };
}
