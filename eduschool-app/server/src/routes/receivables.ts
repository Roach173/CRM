import { Router } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import {
  getSchoolReceivableSummary,
  getStudentReceivableSummary,
  listOverdueInvoices,
} from '../services/receivableService';
import { createLogger } from '../lib/logger';
import { sendLifecycleError } from '../lib/routeError';

const log = createLogger('receivables');
const router = Router();

// GET /api/v1/receivables/student/:studentProfileId
router.get('/student/:studentProfileId', authenticate, requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const studentProfileId = parseInt(req.params.studentProfileId, 10);
    const asOf = parseAsOf(req.query.asOf);

    const summary = await getStudentReceivableSummary(schoolId, studentProfileId, asOf, prisma);
    return res.json({ success: true, data: summary });
  } catch (err: any) {
    log.error({ err }, 'fetch student receivables error');
    if (err.message === 'INVALID_AS_OF')
      return res.status(400).json({ success: false, error: 'asOf must be a valid ISO date' });
    return sendLifecycleError(res, err, 'Failed to fetch student receivables');
  }
});

// GET /api/v1/receivables/overdue
router.get('/overdue', authenticate, requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const asOf = parseAsOf(req.query.asOf);

    const invoices = await listOverdueInvoices(schoolId, asOf, prisma);
    return res.json({ success: true, data: invoices });
  } catch (err: any) {
    log.error({ err }, 'fetch overdue receivables error');
    if (err.message === 'INVALID_AS_OF')
      return res.status(400).json({ success: false, error: 'asOf must be a valid ISO date' });
    return sendLifecycleError(res, err, 'Failed to fetch overdue receivables');
  }
});

// GET /api/v1/receivables/summary
router.get('/summary', authenticate, requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const asOf = parseAsOf(req.query.asOf);

    const summary = await getSchoolReceivableSummary(schoolId, asOf, prisma);
    return res.json({ success: true, data: summary });
  } catch (err: any) {
    log.error({ err }, 'fetch receivables summary error');
    if (err.message === 'INVALID_AS_OF')
      return res.status(400).json({ success: false, error: 'asOf must be a valid ISO date' });
    return sendLifecycleError(res, err, 'Failed to fetch receivables summary');
  }
});

function parseAsOf(value: unknown): Date {
  if (value == null || value === '') return new Date();
  const asOf = new Date(String(value));
  if (Number.isNaN(asOf.getTime())) throw new Error('INVALID_AS_OF');
  return asOf;
}

export default router;
