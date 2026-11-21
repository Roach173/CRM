import { Router } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import {
  createFreeze,
  cancelFreeze,
  listFreezes,
} from '../services/freezeService';
import type { FreezeActor } from '../services/freezeService';
import { assertStudentBelongsToSchool } from '../lib/tenant';
import { sendLifecycleError } from '../lib/routeError';

const router = Router();

// ─── POST /freeze — create a freeze ──────────────────────────────────────────
// Body: { studentProfileId, type, lessonSessionId?, startDate?, endDate?, reason? }
// authenticate is applied at router level in routes/index.ts — no inline duplicate needed.
router.post('/', requirePermission('freeze:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const { studentProfileId, type, lessonSessionId, startDate, endDate, reason } = req.body;

    if (!studentProfileId || !type) {
      return res.status(400).json({ success: false, error: 'studentProfileId и type обязательны' });
    }
    if (!['LESSON_SKIP', 'PERIOD'].includes(type)) {
      return res.status(400).json({ success: false, error: 'type должен быть LESSON_SKIP или PERIOD' });
    }
    if (type === 'LESSON_SKIP' && !lessonSessionId) {
      return res.status(400).json({ success: false, error: 'lessonSessionId обязателен для LESSON_SKIP' });
    }
    if (type === 'PERIOD' && !startDate) {
      return res.status(400).json({ success: false, error: 'startDate обязателен для PERIOD' });
    }

    const actor: FreezeActor = {
      userId:   req.user!.userId,
      role:     req.user!.role,
      schoolId,
    };

    const freeze = await createFreeze({
      studentProfileId: Number(studentProfileId),
      schoolId,
      actor,
      type,
      lessonSessionId:  lessonSessionId ? Number(lessonSessionId) : undefined,
      startDate:        startDate ? new Date(startDate) : undefined,
      endDate:          endDate   ? new Date(endDate)   : null,
      reason,
    });

    res.status(201).json({ success: true, data: freeze });
  } catch (err: any) {
    sendLifecycleError(res, err, 'Failed to create freeze');
  }
});

// ─── DELETE /freeze/:id — cancel a freeze ─────────────────────────────────────
// Requires freeze:write (OWNER/ADMIN/SUPERADMIN).
// Product decision: STUDENT cannot self-cancel freeze — must contact admin.
// Role enforcement inside cancelFreeze: TEACHER always 403, non-admin non-creator 403.
router.delete('/:id', requirePermission('freeze:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const freezeId = Number(req.params.id);
    const { reason } = req.body;

    if (isNaN(freezeId)) {
      return res.status(400).json({ success: false, error: 'Некорректный freezeId' });
    }

    const actor: FreezeActor = {
      userId:   req.user!.userId,
      role:     req.user!.role,
      schoolId,
    };

    const updated = await cancelFreeze({ freezeId, schoolId, actor, reason });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendLifecycleError(res, err, 'Failed to cancel freeze');
  }
});

// ─── GET /freeze?studentProfileId=X — list freezes for a student ─────────────
router.get('/', requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const studentProfileId = Number(req.query.studentProfileId);
    const statusFilter = req.query.status as 'ACTIVE' | 'CANCELLED' | undefined;

    if (!studentProfileId || isNaN(studentProfileId)) {
      return res.status(400).json({ success: false, error: 'studentProfileId обязателен' });
    }

    await assertStudentBelongsToSchool(studentProfileId, schoolId);

    const freezes = await listFreezes({
      studentProfileId,
      schoolId,
      status: statusFilter,
    });

    res.json({ success: true, data: freezes });
  } catch (err: any) {
    sendLifecycleError(res, err, 'Failed to list freezes');
  }
});

export default router;
