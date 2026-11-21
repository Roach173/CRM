import { Router } from 'express';
import prisma from '../../lib/prisma';
import { authenticate, AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { BlockType } from '@prisma/client';
import { dateInTz } from '../../lib/tzUtils';
import { generatePolicySlotDefs, getFirstWorkingDateStr, getPolicyForDate, makeCachedPolicyResolver } from '../../services/policyService';
import {
  log,
} from './scheduleRouteUtils';

const router = Router();

// ─── GET /policy-conflicts — sessions and blocks outside current school policy ─

router.get('/policy-conflicts', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;

    const now = new Date();
    const [currentPolicy, school, currentPolicyVersion] = await Promise.all([
      getPolicyForDate(schoolId, now),
      prisma.school.findFirst({ where: { id: schoolId, deletedAt: null }, select: { timezone: true } }),
      prisma.schoolSchedulePolicy.findFirst({
        where: {
          schoolId,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        orderBy: [
          { effectiveFrom: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        select: { effectiveFrom: true },
      }),
    ]);
    const tz = school?.timezone ?? 'UTC';
    const policyStartStr = dateInTz(currentPolicyVersion?.effectiveFrom ?? now, tz);
    const firstWorkingDate = getFirstWorkingDateStr(
      policyStartStr,
      currentPolicy.activeDays.length > 0 ? currentPolicy.activeDays : [0, 1, 2, 3, 4],
    );

    const parseMin = (t: string) => {
      const [h, m] = (t ?? '00:00').split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const wsMin = parseMin(currentPolicy.workStart);
    const weMin = parseMin(currentPolicy.workEnd);
    const activeSet = new Set(currentPolicy.activeDays);

    const firstWorkingDateStart = firstWorkingDate
      ? new Date(`${firstWorkingDate}T00:00:00.000Z`)
      : now;
    // Conflict horizon must cover current+future dates, not just the old policy's start.
    // firstWorkingDate can be far in the past (old policy effectiveFrom) — in that case
    // the 14-day scan would cover only past dates and miss upcoming conflicts.
    // Use max(today, firstWorkingDate) so we always scan forward from now.
    const todayStr = dateInTz(now, tz);
    const horizonStart = (firstWorkingDate && firstWorkingDate > todayStr) ? firstWorkingDate : todayStr;
    const addDaysStr = (baseDateStr: string, offset: number) => {
      const [y, m, d] = baseDateStr.split('-').map(Number);
      const date = new Date(Date.UTC(y, m - 1, d + offset));
      return date.toISOString().slice(0, 10);
    };
    const blockDateStart = (block: { startDate: Date | null }) =>
      block.startDate ? dateInTz(block.startDate, tz) : null;
    const blockDateEnd = (block: { endDate: Date | null }) =>
      block.endDate ? dateInTz(block.endDate, tz) : null;
    const isBlockActiveOnDateStr = (block: { startDate: Date | null; endDate: Date | null }, targetDateStr: string) => {
      const start = blockDateStart(block);
      const end = blockDateEnd(block);
      return !!start && targetDateStr >= start && (!end || targetDateStr <= end);
    };
    type CanonicalPolicyBlock = {
      id: number;
      studentGroupId: number | null;
      type: BlockType;
      days: number[];
      startDate: Date | null;
      endDate: Date | null;
    };
    const isCanonicalBlockForDate = (
      block: CanonicalPolicyBlock,
      blocks: CanonicalPolicyBlock[],
      targetDateStr: string,
      dayIdx: number,
    ) => {
      const sameSlotCandidates = blocks
        .filter(candidate =>
          candidate.studentGroupId === block.studentGroupId
          && candidate.type === block.type
          && candidate.days.includes(dayIdx)
          && isBlockActiveOnDateStr(candidate, targetDateStr),
        )
        .sort((a, b) => {
          const aStart = blockDateStart(a) ?? '';
          const bStart = blockDateStart(b) ?? '';
          return bStart.localeCompare(aStart) || b.id - a.id;
        });
      return sameSlotCandidates[0]?.id === block.id;
    };

    const blocks = await prisma.lessonBlock.findMany({
      where: {
        schoolId,
        deletedAt: null,
        status: 'UPCOMING',
        OR: [{ endDate: null }, { endDate: { gte: now } }],
      },
      select: {
        id: true,
        type: true,
        startTime: true,
        endTime: true,
        days: true,
        startDate: true,
        endDate: true,
        cabinetId: true,
        studentGroupId: true,
        studentGroup: { select: { id: true, level: true, status: true } },
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        sessions: {
          where: { deletedAt: null, status: 'UPCOMING', date: { gte: now } },
          select: { id: true },
          take: 20,
        },
      },
      take: 100,
    });
    const truncatedBlocks = blocks.length === 100;

    const sessions = await prisma.lessonSession.findMany({
      where: { schoolId, deletedAt: null, status: 'UPCOMING', date: { gte: now } },
      select: {
        id: true,
        date: true,
        startTimeSnap: true,
        endTimeSnap: true,
        version: true,
        cabinetIdSnap: true,
        teacher: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } },
        lessonBlock: {
          select: {
            id: true,
            type: true,
            startTime: true,
            endTime: true,
            days: true,
            startDate: true,
            endDate: true,
            deletedAt: true,
            cabinetId: true,
            studentGroupId: true,
            studentGroup: { select: { id: true, level: true } },
            teacher: {
              select: {
                id: true,
                user: { select: { id: true, firstName: true, lastName: true } },
              },
            },
          },
        },
      },
      orderBy: { date: 'asc' },
      take: 300,
    });
    const truncatedSessions = sessions.length === 300;

    type TimeConflictReason = 'OUTSIDE_WORK_HOURS' | 'OUTSIDE_POLICY_SLOT';

    type SessionConflict = {
      sessionId: number; date: string; dayIdx: number;
      groupName: string | null; level: string | null; teacherName: string | null;
      startTime: string; endTime: string;
      blockId: number;
      sessionVersion: number;
      cabinetId: number | null;
      teacherUserId: number | null;
      studentGroupId: number | null;
      days: number[];
      startDate: string | null;
      endDate: string | null;
      sessionIds: number[];
      reason?: TimeConflictReason;
    };

    const outsideDays: SessionConflict[] = [];
    const outsideHours: SessionConflict[] = [];

    // Both loops below resolve policies for the same ~14 distinct dates; the
    // uncached per-iteration getPolicyForDate calls made this endpoint ~1.4s.
    const policyForDate = makeCachedPolicyResolver(schoolId);

    for (const s of sessions) {
      if (!s.lessonBlock || s.lessonBlock.deletedAt) continue;
      const sessionPolicy = await policyForDate(s.date);
      const sessionActiveSet = new Set(sessionPolicy.activeDays);
      const sessionWsMin = parseMin(sessionPolicy.workStart);
      const sessionWeMin = parseMin(sessionPolicy.workEnd);
      const dayIdx = (new Date(s.date).getUTCDay() + 6) % 7;
      const startTime = s.startTimeSnap ?? s.lessonBlock.startTime;
      const endTime = s.endTimeSnap ?? s.lessonBlock.endTime;
      const startMin = parseMin(startTime);
      const endMin = parseMin(endTime);
      const dateStr = new Date(s.date).toISOString().slice(0, 10);
      const blockStartDate = s.lessonBlock.startDate ? dateInTz(s.lessonBlock.startDate, tz) : null;
      const blockEndDate = s.lessonBlock.endDate ? dateInTz(s.lessonBlock.endDate, tz) : null;
      if ((blockStartDate && dateStr < blockStartDate) || (blockEndDate && dateStr > blockEndDate)) {
        continue;
      }
      if (!isCanonicalBlockForDate(s.lessonBlock, blocks, dateStr, dayIdx)) {
        continue;
      }
      const groupName = s.lessonBlock.studentGroup?.level ?? null;
      const level = s.lessonBlock.studentGroup?.level ?? null;
      const effectiveTeacher = s.teacher?.user
        ? { id: s.teacher.userId, firstName: s.teacher.user.firstName, lastName: s.teacher.user.lastName }
        : s.lessonBlock.teacher?.user
          ? { id: s.lessonBlock.teacher.user.id, firstName: s.lessonBlock.teacher.user.firstName, lastName: s.lessonBlock.teacher.user.lastName }
          : null;
      const teacherName = effectiveTeacher ? `${effectiveTeacher.firstName} ${effectiveTeacher.lastName}`.trim() : null;

      const extra = {
        blockId: s.lessonBlock.id,
        sessionVersion: s.version,
        cabinetId: s.cabinetIdSnap ?? s.lessonBlock.cabinetId ?? null,
        teacherUserId: effectiveTeacher?.id ?? null,
        studentGroupId: s.lessonBlock.studentGroupId ?? null,
        days: s.lessonBlock.days,
        startDate: blockStartDate,
        endDate: blockEndDate,
        sessionIds: [s.id],
      };

      const sessionSlotDefs = generatePolicySlotDefs(sessionPolicy);
      const outsideHoursRange = startMin < sessionWsMin || endMin > sessionWeMin;
      const outsideSlot = sessionSlotDefs.length > 0 &&
        !sessionSlotDefs.some(sd => sd.startTime === startTime && sd.endTime === endTime);

      if (!sessionActiveSet.has(dayIdx) && outsideDays.length < 20) {
        outsideDays.push({ sessionId: s.id, date: dateStr, dayIdx, groupName, level, teacherName, startTime, endTime, ...extra });
      }
      if ((outsideHoursRange || outsideSlot) && outsideHours.length < 20) {
        const reason: TimeConflictReason = outsideHoursRange ? 'OUTSIDE_WORK_HOURS' : 'OUTSIDE_POLICY_SLOT';
        outsideHours.push({ sessionId: s.id, date: dateStr, dayIdx, groupName, level, teacherName, startTime, endTime, reason, ...extra });
      }
    }

    type BlockConflict = {
      blockId: number; groupName: string | null; level: string | null;
      teacherName: string | null; startTime: string; endTime: string;
      days: number[]; daysOutsidePolicy: number[]; timeOutsidePolicy: boolean;
      timeConflictReason?: TimeConflictReason;
      groupStatus: string | null; studentGroupId: number | null;
      cabinetId: number | null; teacherUserId: number | null;
      startDate: string | null; endDate: string | null; sessionIds: number[];
      conflictDates: { date: string; dayIdx: number }[];
    };

    const blocksOutsidePolicy: BlockConflict[] = [];
    const conflictHorizonDays = 14;
    for (const b of blocks) {
      const conflictDates: { date: string; dayIdx: number }[] = [];
      const daysOutsideSet = new Set<number>();
      let timeOutsidePolicy = false;
      let timeConflictReason: TimeConflictReason | undefined;
      for (let offset = 0; offset < conflictHorizonDays; offset++) {
        const candidateStr = addDaysStr(horizonStart, offset);
        const dayIdx = (new Date(`${candidateStr}T12:00:00.000Z`).getUTCDay() + 6) % 7;
        if (!b.days.includes(dayIdx)) continue;
        if (!isBlockActiveOnDateStr(b, candidateStr)) continue;
        if (!isCanonicalBlockForDate(b, blocks, candidateStr, dayIdx)) continue;
        const candidatePolicy = await policyForDate(new Date(`${candidateStr}T12:00:00.000Z`));
        const candidateActiveSet = new Set(candidatePolicy.activeDays);
        const candidateWsMin = parseMin(candidatePolicy.workStart);
        const candidateWeMin = parseMin(candidatePolicy.workEnd);
        const blockStartMin = parseMin(b.startTime);
        const blockEndMin = parseMin(b.endTime);
        const candidateSlotDefs = generatePolicySlotDefs(candidatePolicy);
        const outsideDay = !candidateActiveSet.has(dayIdx);
        const outsideHoursRange = blockStartMin < candidateWsMin || blockEndMin > candidateWeMin;
        const outsideSlot = candidateSlotDefs.length > 0 &&
          !candidateSlotDefs.some(sd => sd.startTime === b.startTime && sd.endTime === b.endTime);
        if (!outsideDay && !outsideHoursRange && !outsideSlot) continue;
        if (outsideDay) daysOutsideSet.add(dayIdx);
        if (outsideHoursRange || outsideSlot) {
          timeOutsidePolicy = true;
          // OUTSIDE_WORK_HOURS is more severe; keep the worst reason seen across all candidate days
          if (!timeConflictReason || outsideHoursRange) {
            timeConflictReason = outsideHoursRange ? 'OUTSIDE_WORK_HOURS' : 'OUTSIDE_POLICY_SLOT';
          }
        }
        conflictDates.push({ date: candidateStr, dayIdx });
      }
      const daysOutsidePolicy = [...daysOutsideSet].sort((a, b) => a - b);
      if (daysOutsidePolicy.length > 0 || timeOutsidePolicy) {
        if (blocksOutsidePolicy.length < 20) {
          const u = b.teacher?.user;
          blocksOutsidePolicy.push({
            blockId: b.id,
            groupName: b.studentGroup?.level ?? null,
            level: b.studentGroup?.level ?? null,
            teacherName: u ? `${u.firstName} ${u.lastName}`.trim() : null,
            startTime: b.startTime,
            endTime: b.endTime,
            days: b.days,
            daysOutsidePolicy,
            timeOutsidePolicy,
            timeConflictReason,
            groupStatus: b.studentGroup?.status ?? null,
            studentGroupId: b.studentGroupId ?? null,
            cabinetId: b.cabinetId ?? null,
            teacherUserId: b.teacher?.userId ?? null,
            startDate: b.startDate ? dateInTz(b.startDate, tz) : null,
            endDate: b.endDate ? dateInTz(b.endDate, tz) : null,
            sessionIds: b.sessions.map(s => s.id),
            conflictDates,
          });
        }
      }
    }

    for (const s of outsideDays) {
      let blockConflict = blocksOutsidePolicy.find(b => b.blockId === s.blockId);
      if (!blockConflict && blocksOutsidePolicy.length < 20) {
        blockConflict = {
          blockId: s.blockId,
          groupName: s.groupName,
          level: s.level,
          teacherName: s.teacherName,
          startTime: s.startTime,
          endTime: s.endTime,
          days: [s.dayIdx],
          daysOutsidePolicy: [s.dayIdx],
          timeOutsidePolicy: false,
          groupStatus: null,
          studentGroupId: s.studentGroupId,
          cabinetId: s.cabinetId,
          teacherUserId: s.teacherUserId,
          startDate: s.startDate,
          endDate: s.endDate,
          sessionIds: [...s.sessionIds],
          conflictDates: [],
        };
        blocksOutsidePolicy.push(blockConflict);
      }
      if (blockConflict) {
        blockConflict.sessionIds = [...new Set([...blockConflict.sessionIds, ...s.sessionIds])];
        if (!blockConflict.days.includes(s.dayIdx)) blockConflict.days.push(s.dayIdx);
        if (!blockConflict.daysOutsidePolicy.includes(s.dayIdx)) blockConflict.daysOutsidePolicy.push(s.dayIdx);
        if (!blockConflict.conflictDates.some(d => d.date === s.date)) {
          blockConflict.conflictDates.push({ date: s.date, dayIdx: s.dayIdx });
        }
      }
    }

    res.json({
      success: true,
      data: {
        summary: {
          sessionsOutsideDays: outsideDays.length,
          sessionsOutsideHours: outsideHours.length,
          blocksOutsidePolicy: blocksOutsidePolicy.length,
        },
        firstWorkingDate,
        sessionsOutsideDays: outsideDays,
        sessionsOutsideHours: outsideHours,
        blocksOutsidePolicy,
        truncatedSessions,
        truncatedBlocks,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'policy-conflicts query failed');
    res.status(500).json({ success: false, error: 'Failed to fetch policy conflicts' });
  }
});

export default router;
