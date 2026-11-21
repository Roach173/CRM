import { Router } from 'express';
import { authenticate, AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { runChecks } from '../../services/consistencyCheckService';
import {
  log,
} from './scheduleRouteUtils';

const router = Router();

router.get('/integrity', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const violations = await runChecks(req.user!.schoolId);
    res.json({ violations });
  } catch (err) {
    log.error({ err }, 'integrity check error');
    res.status(500).json({ error: 'Integrity check failed' });
  }
});

export default router;
