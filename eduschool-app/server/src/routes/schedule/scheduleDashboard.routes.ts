import { Router } from 'express';
import prisma from '../../lib/prisma';
import { authenticate, AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { cacheGet, cacheSet } from '../../lib/cache';
import {
  getEffectiveSessionTeacherId,
} from '../../services/sessionService';
import {
  blockAllowsSessionGeneration,
} from '../../lib/blockStateMachine';
import {
  log,
} from './scheduleRouteUtils';

const router = Router();

// ─── Recurring-schedule lesson synthesis (shared) ────────────────────────────
//
// LessonSession rows are only generated on a rolling horizon (ROLLING_DAYS in
// services/sessionService.ts). Both calendar endpoints below need to render
// lesson dates beyond that horizon straight from the LessonBlock's own
// recurrence (`days` + startDate/endDate) rather than depending on
// LessonSession rows existing yet. This is pure calendar math — never a real,
// persisted, payable lesson.
//
// Date arithmetic intentionally matches the pre-existing logic already used
// in this file (teacher-lesson-counts, teacher-lesson-calendar): local-time
// `new Date(year, month-1, d)` + `(getDay()+6)%7` for ISO weekday (0=Mon).
// Kept byte-for-byte so behavior cannot drift between endpoints at week
// boundaries (the reported bug is exactly a week-boundary miss).
function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function occurrenceDatesForBlock(
  block: { days: number[]; startDate: Date | null; endDate: Date | null },
  monthStart: Date,
  monthEnd: Date,
  year: number,
  month: number,
): string[] {
  const blockDayIndexes = new Set(block.days);
  const blockStart = block.startDate ?? monthStart;
  const blockEnd = block.endDate ?? new Date('2099-12-31');
  const daysInMonth = monthEnd.getDate();
  const dates: string[] = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    const dayIdx = (date.getDay() + 6) % 7;
    if (date >= blockStart && date <= blockEnd && blockDayIndexes.has(dayIdx)) {
      dates.push(ymd(year, month, d));
    }
  }
  return dates;
}

// ─── GET /teacher-lesson-counts ───────────────────────────────────────────────

router.get('/teacher-lesson-counts', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {

    const year = parseInt(req.query.year as string);
    const month = parseInt(req.query.month as string);
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ success: false, error: 'year and month (1-12) required' });
    }

    const schoolId = req.user!.schoolId;
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);

    const blocks = await prisma.lessonBlock.findMany({
      where: {
        schoolId,
        deletedAt: null,
        startDate: { lte: monthEnd },
        OR: [{ endDate: null }, { endDate: { gte: monthStart } }],
      },
      select: { days: true, startDate: true, endDate: true, teacherId: true },
    });

    const counts: Record<number, number> = {};
    const daysInMonth = monthEnd.getDate();

    for (const block of blocks) {
      if (!block.teacherId) continue;
      const blockDayIndexes = new Set(block.days);
      const blockStart = block.startDate ?? monthStart;
      const blockEnd = block.endDate ?? new Date('2099-12-31');

      let lessonCount = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month - 1, d);
        const dayIdx = (date.getDay() + 6) % 7;
        if (date >= blockStart && date <= blockEnd && blockDayIndexes.has(dayIdx)) lessonCount++;
      }
      if (lessonCount > 0) counts[block.teacherId] = (counts[block.teacherId] ?? 0) + lessonCount;
    }

    const cancelledSessions = await prisma.lessonSession.findMany({
      where: {
        schoolId,
        date: { gte: monthStart, lte: monthEnd },
        status: 'CANCELLED',
        deletedAt: null,
        lessonBlock: { schoolId, deletedAt: null },
      },
      select: { teacherId: true, teacherIdSnap: true, isManualTeacher: true, lessonBlock: { select: { teacherId: true } } },
    });

    for (const session of cancelledSessions) {
      const tid = getEffectiveSessionTeacherId(session) ?? session.lessonBlock.teacherId;
      if (tid != null && counts[tid] !== undefined) {
        counts[tid] = Math.max(0, counts[tid] - 1);
      }
    }

    res.json({ success: true, data: counts });
  } catch (error) {
    log.error({ err: error }, 'get lesson counts error');
    res.status(500).json({ success: false, error: 'Failed to fetch lesson counts' });
  }
});

// ─── GET /teacher-lesson-calendar ────────────────────────────────────────────

router.get('/teacher-lesson-calendar', authenticate, requirePermission('session:write'), async (req: AuthRequest, res) => {
  try {

    const year = parseInt(req.query.year as string);
    const month = parseInt(req.query.month as string);
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ success: false, error: 'year and month (1-12) required' });
    }

    const schoolId = req.user!.schoolId;
    const staff = await prisma.staffProfile.findUnique({ where: { userId: req.user!.userId } });
    if (!staff) return res.status(404).json({ success: false, error: 'Profile not found' });

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);

    const blocks = await prisma.lessonBlock.findMany({
      where: {
        schoolId,
        deletedAt: null,
        teacherId: staff.id,
        startDate: { lte: monthEnd },
        AND: { OR: [{ endDate: null }, { endDate: { gte: monthStart } }] },
      },
      select: { id: true, days: true, startTime: true, endTime: true, level: true, cabinet: { select: { name: true } }, startDate: true, endDate: true },
    });

    const lessons: { date: string; time: string; level: string; cabinet: string }[] = [];

    for (const block of blocks) {
      for (const date of occurrenceDatesForBlock(block, monthStart, monthEnd, year, month)) {
        lessons.push({
          date,
          time: `${block.startTime}–${block.endTime}`,
          level: block.level,
          cabinet: block.cabinet?.name ?? '—',
        });
      }
    }

    const cancelledSessions = await prisma.lessonSession.findMany({
      where: {
        schoolId,
        date: { gte: monthStart, lte: monthEnd },
        status: 'CANCELLED',
        deletedAt: null,
        lessonBlock: { schoolId, deletedAt: null, teacherId: staff.id },
      },
      select: { date: true, lessonBlock: { select: { startTime: true, endTime: true } } },
    });

    const cancelledKeys = new Set(
      cancelledSessions.map(s => {
        const d = s.date;
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return `${ds}|${s.lessonBlock.startTime}–${s.lessonBlock.endTime}`;
      })
    );

    const primaryLessons = lessons.filter(l => !cancelledKeys.has(`${l.date}|${l.time}`));

    // Добавляем замены: сессии где этот учитель — substitute (teacherId = staff.id),
    // но основной учитель блока — другой. Такие уроки не попадают в primaryLessons.
    const subSessions = await prisma.lessonSession.findMany({
      where: {
        schoolId,
        deletedAt: null,
        status: { not: 'INVALIDATED' },
        date: { gte: monthStart, lte: monthEnd },
        teacherId: staff.id,
        lessonBlock: { teacherId: { not: staff.id }, deletedAt: null },
      },
      select: {
        date: true,
        startTimeSnap: true,
        endTimeSnap: true,
        lessonBlock: {
          select: {
            startTime: true, endTime: true, level: true,
            cabinet: { select: { name: true } },
          },
        },
      },
    });

    const subLessons = subSessions.map(s => {
      const d = s.date;
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return {
        date: ds,
        time: `${s.startTimeSnap ?? s.lessonBlock.startTime}–${s.endTimeSnap ?? s.lessonBlock.endTime}`,
        level: s.lessonBlock.level,
        cabinet: s.lessonBlock.cabinet?.name ?? '—',
        isSubstitution: true,
      };
    });

    const result = [...primaryLessons, ...subLessons]
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

    res.json({ success: true, data: result });
  } catch (error) {
    log.error({ err: error }, 'teacher calendar error');
    res.status(500).json({ success: false, error: 'Failed to fetch teacher calendar' });
  }
});

// ─── GET /teacher-lesson-calendar-admin ──────────────────────────────────────

router.get('/teacher-lesson-calendar-admin', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {

    const year = parseInt(req.query.year as string);
    const month = parseInt(req.query.month as string);
    const teacherUserId = parseInt(req.query.teacherId as string);
    if (!year || !month || month < 1 || month > 12 || !teacherUserId) {
      return res.status(400).json({ success: false, error: 'year, month (1-12) and teacherId required' });
    }

    const schoolId = req.user!.schoolId;

    const staff = await prisma.staffProfile.findFirst({ where: { userId: teacherUserId, user: { schoolId: schoolId! } } });
    if (!staff) return res.status(404).json({ success: false, error: 'Teacher not found' });

    const cacheKey = `teacher-cal:${schoolId}:${teacherUserId}:${year}:${month}`;
    const noCache = req.query._nocache === '1';
    if (!noCache) {
      const cached = await cacheGet(cacheKey);
      if (cached) return res.json({ success: true, data: cached });
    }

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);

    // Ищем все сессии, где этот учитель либо основной, либо замена.
    // teacherIdSnap — снимок учителя на момент создания сессии (не меняется при смене учителя в блоке).
    // Это корректно: завершённые уроки остаются за тем, кто их вёл, даже если потом сменили учителя блока.
    const sessions = await prisma.lessonSession.findMany({
      where: {
        schoolId,
        deletedAt: null,
        status: { not: 'INVALIDATED' },
        date: { gte: monthStart, lte: monthEnd },
        OR: [
          { teacherId: staff.id },               // Он был заменой (substitute override)
          { teacherIdSnap: staff.id, teacherId: null }, // Он основной учитель (по снимку, без замены)
        ]
      },
      include: {
        lessonBlock: {
          include: {
            studentGroup: { select: { level: true } },
            cabinet: { select: { name: true } }
          }
        },
        teacherPaymentLesson: { select: { paymentId: true } }
      },
      orderBy: [
        { date: 'asc' },
        { startTimeSnap: 'asc' }
      ]
    });

    type AdminCalendarLesson = {
      id: number;
      date: string;
      time: string;
      level: string;
      groupName: string;
      cabinet: string;
      status: string;
      cancelled: boolean;
      isSubstitution: boolean;
      paymentId: number | null;
      isSynthesized: boolean;
    };

    const realLessons: AdminCalendarLesson[] = sessions.map(s => {
      const isSub = s.teacherId === staff.id;
      return {
        id: s.id,
        date: s.date.toISOString().split('T')[0],
        time: `${s.startTimeSnap ?? s.lessonBlock.startTime}–${s.endTimeSnap ?? s.lessonBlock.endTime}`,
        level: s.lessonBlock.studentGroup?.level ?? s.lessonBlock.level,
        groupName: s.lessonBlock.studentGroup?.level ?? '—',
        cabinet: s.lessonBlock.cabinet?.name ?? '—',
        status: s.status,
        cancelled: s.status === 'CANCELLED',
        isSubstitution: isSub,
        paymentId: s.teacherPaymentLesson?.paymentId ?? null,
        isSynthesized: false,
      };
    });

    // ── Beyond the rolling session-generation horizon ──────────────────────
    // LessonSession rows only exist ~ROLLING_DAYS ahead (sessionService.ts).
    // Past that, `sessions` above simply has no rows for the tail of the
    // requested month — the reported bug (e.g. the week of 31 Aug–6 Sep
    // renders blank here while the teacher's own calendar above, which has
    // always synthesized from LessonBlock recurrence, renders fine).
    //
    // We reuse the exact same recurrence synthesis here (occurrenceDatesForBlock),
    // scoped so a synthesized entry can never be mistaken for, or paid as, a
    // real lesson:
    //   - never for a (block, date) that already has ANY real LessonSession
    //     row — checked against every session for this teacher's blocks,
    //     not just the ones attributed to this teacher, so a date already
    //     covered by a substitute (real row, different teacherId) is never
    //     double-booked with a phantom entry for the regular teacher
    //   - never for a past date (string-compared in the same local Y-M-D
    //     form the recurrence dates themselves are built in)
    //   - never for a block whose status no longer allows session generation
    //     (blockAllowsSessionGeneration — the same canonical check
    //     syncSessionsForBlock itself uses before creating real rows)
    //   - never for a block whose StudentGroup is paused/completed/archived
    //   - always attributed to the block's own regular teacher — a
    //     synthesized entry is never marked isSubstitution:true; real
    //     substitutions only ever exist as real LessonSession rows, which
    //     win by the dedup rule above
    //
    // Marker contract: mirrors the boolean-flag convention already used by
    // GET /teacher-lesson-calendar's `isSubstitution: true` (a flag present
    // only when it applies) — `isSynthesized` here is the analogous flag for
    // "derived from recurrence, not a persisted row", set explicitly on both
    // real (false) and synthesized (true) entries so client code always sees
    // it rather than having to treat "missing" as meaningful.
    //
    // Payability: synthesized entries get status 'UPCOMING' and
    // paymentId: null, so the client's own `payableLessons` filter
    // (status === 'COMPLETED' || 'IN_PROGRESS') already excludes them from
    // anything payable — see requirement trace in the accompanying report.
    // Defense in depth: `id` is a negative sentinel that can never collide
    // with a real (positive, auto-increment) LessonSession id, and even if
    // one leaked into POST /salary/:staffProfileId/pay-with-sessions, that
    // route re-fetches sessionIds from LessonSession by id/schoolId/teacher
    // and 400s if the count doesn't match — a synthesized id would never be
    // found there.
    const recurringBlocks = await prisma.lessonBlock.findMany({
      where: {
        schoolId,
        deletedAt: null,
        teacherId: staff.id,
        startDate: { lte: monthEnd },
        OR: [{ endDate: null }, { endDate: { gte: monthStart } }],
      },
      select: {
        id: true, days: true, startTime: true, endTime: true, level: true, status: true,
        startDate: true, endDate: true,
        cabinet: { select: { name: true } },
        studentGroup: { select: { level: true, status: true, deletedAt: true } },
      },
    });

    const recurringBlockIds = recurringBlocks.map(b => b.id);
    const blockSessionDates = recurringBlockIds.length > 0
      ? await prisma.lessonSession.findMany({
          where: {
            schoolId,
            lessonBlockId: { in: recurringBlockIds },
            date: { gte: monthStart, lte: monthEnd },
            deletedAt: null,
          },
          select: { lessonBlockId: true, date: true },
        })
      : [];

    const dedupKeys = new Set(
      blockSessionDates.map(s => `${s.lessonBlockId}|${s.date.toISOString().split('T')[0]}`)
    );

    const now = new Date();
    const todayStr = ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());

    const synthesized: AdminCalendarLesson[] = [];
    let syntheticId = -1;

    for (const block of recurringBlocks) {
      if (!blockAllowsSessionGeneration(block.status)) continue;
      if (block.studentGroup && (block.studentGroup.status !== 'ACTIVE' || block.studentGroup.deletedAt)) continue;

      for (const date of occurrenceDatesForBlock(block, monthStart, monthEnd, year, month)) {
        if (date < todayStr) continue;
        const key = `${block.id}|${date}`;
        if (dedupKeys.has(key)) continue;
        dedupKeys.add(key);
        synthesized.push({
          id: syntheticId--,
          date,
          time: `${block.startTime}–${block.endTime}`,
          level: block.studentGroup?.level ?? block.level,
          groupName: block.studentGroup?.level ?? '—',
          cabinet: block.cabinet?.name ?? '—',
          status: 'UPCOMING',
          cancelled: false,
          isSubstitution: false,
          paymentId: null,
          isSynthesized: true,
        });
      }
    }

    const result = [...realLessons, ...synthesized]
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

    await cacheSet(cacheKey, result, 120);
    res.json({ success: true, data: result });
  } catch (error) {
    log.error({ err: error }, 'teacher calendar error');
    res.status(500).json({ success: false, error: 'Failed to fetch teacher calendar' });
  }
});

router.get('/attendance-dashboard', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '14')), 1), 30);
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [pendingSessions, submittedSessions] = await Promise.all([
      // Pending: past sessions that were never completed
      prisma.lessonSession.findMany({
        where: {
          schoolId,
          deletedAt: null,
          date: { gte: since, lt: now },
          status: { in: ['UPCOMING', 'IN_PROGRESS'] },
        },
        include: {
          lessonBlock: {
            include: {
              studentGroup: {
                include: {
                  _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
                },
              },
            },
          },
        },
        orderBy: { date: 'asc' },
      }),

      // Submitted: recently completed sessions with first submitter info
      prisma.lessonSession.findMany({
        where: {
          schoolId,
          deletedAt: null,
          date: { gte: since, lte: now },
          status: 'COMPLETED',
        },
        include: {
          lessonBlock: {
            include: {
              studentGroup: { select: { level: true } },
            },
          },
          attendances: {
            where: { submittedById: { not: null } },
            select: {
              createdAt: true,
              submittedBy: { select: { firstName: true, lastName: true } },
            },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
          _count: { select: { attendances: true } },
        },
        orderBy: { date: 'desc' },
      }),
    ]);

    const pending = pendingSessions.map(s => ({
      sessionId: s.id,
      date: s.date,
      lessonBlockId: s.lessonBlockId,
      groupName: s.lessonBlock.studentGroup?.level ?? null,
      level: s.lessonBlock.studentGroup?.level ?? null,
      lessonType: s.lessonBlock.type,
      studentCount: s.lessonBlock.studentGroup?._count.memberships ?? 0,
      daysSince: Math.floor((now.getTime() - s.date.getTime()) / 86_400_000),
    }));

    const submitted = submittedSessions.map(s => {
      const first = s.attendances[0];
      const name = first?.submittedBy
        ? `${first.submittedBy.firstName} ${first.submittedBy.lastName}`.trim()
        : null;
      return {
        sessionId: s.id,
        date: s.date,
        groupName: s.lessonBlock.studentGroup?.level ?? null,
        level: s.lessonBlock.studentGroup?.level ?? null,
        lessonType: s.lessonBlock.type,
        attendanceCount: s._count.attendances,
        submittedByName: name,
        submittedAt: first?.createdAt ?? null,
      };
    });

    res.json({ success: true, data: { pending, submitted } });
  } catch (error) {
    log.error({ err: error }, 'attendance-dashboard error');
    res.status(500).json({ success: false, error: 'Failed to fetch attendance dashboard' });
  }
});

export default router;
