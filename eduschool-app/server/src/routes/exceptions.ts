import { Router } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';

const router = Router();

router.get('/', authenticate, requirePermission('schedule:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const exceptions = await prisma.scheduleException.findMany({
      where: { schoolId },
      orderBy: { startDate: 'asc' },
    });
    res.json({ success: true, data: exceptions });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch exceptions' });
  }
});

router.post('/', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const { type, scope, recurring, days, startDate, endDate, teacherId, cabinetId, groupId, reason } = req.body;
    const ex = await prisma.scheduleException.create({
      data: {
        schoolId,
        type,
        scope,
        recurring: recurring ?? false,
        days: days ?? [],
        startDate: new Date(startDate),
        endDate: endDate ? new Date(endDate) : null,
        teacherId: teacherId ?? null,
        cabinetId: cabinetId ?? null,
        groupId: groupId ?? null,
        reason: reason ?? null,
        createdById: req.user!.userId,
      },
    });
    res.json({ success: true, data: ex });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create exception' });
  }
});

router.delete('/:id', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    await prisma.scheduleException.delete({ where: { id: parseInt(req.params.id), schoolId } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete exception' });
  }
});

export default router;
