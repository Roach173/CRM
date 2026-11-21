import { Router } from 'express';
import prisma from '../../lib/prisma';
import { authenticate, AuthRequest } from '../../middleware/authenticate';
import { MemberStatus } from '@prisma/client';
import {
  mapTeacher,
} from './scheduleRouteUtils';

const router = Router();

// ─── GET /available — доступные группы для студента ──────────────────────────

router.get('/available', authenticate, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const studentProfile = await prisma.studentProfile.findFirst({ where: { userId: req.user?.userId, deletedAt: null } });
    if (!studentProfile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const blocks = await prisma.lessonBlock.findMany({
      where: {
        schoolId,
        status: 'UPCOMING',
        deletedAt: null,
        NOT: { studentGroup: { memberships: { some: { studentProfileId: studentProfile.id, status: MemberStatus.ACTIVE } } } },
      },
      include: {
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        cabinet: { select: { id: true, name: true } },
        studentGroup: { select: { id: true } },
        enrollmentRequests: { where: { studentProfileId: studentProfile.id } },
      },
    });

    // GroupMembership is the enrollment source of truth — StudentGroup.students is dead
    // on write, so a `_count: { select: { students: true } }` here would always be 0.
    const groupIds = [...new Set(blocks.map(b => b.studentGroup?.id).filter((id): id is number => id != null))];
    const membershipCounts = groupIds.length > 0
      ? await prisma.groupMembership.groupBy({
          by: ['studentGroupId'],
          where: { studentGroupId: { in: groupIds }, status: MemberStatus.ACTIVE, leftAt: null },
          _count: { _all: true },
        })
      : [];
    const countByGroupId = new Map(membershipCounts.map(c => [c.studentGroupId, c._count._all]));

    res.json({
      success: true,
      data: blocks.map((b: any) => {
        // mapTeacher() overwrites level/chapter from studentGroup when present — this
        // route only ever selects studentGroup.id, so run it first without that field,
        // then attach the group (with seat count) after, or level/chapter come back undefined.
        const { studentGroup, ...rest } = b;
        return {
          ...mapTeacher(rest),
          studentGroup: studentGroup ? { ...studentGroup, _count: { students: countByGroupId.get(studentGroup.id) ?? 0 } } : null,
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

export default router;
