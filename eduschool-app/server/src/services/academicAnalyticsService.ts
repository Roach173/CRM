import { AttendanceStatus, GroupStatus, MemberStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { AnalyticsRange, rangeWhere } from './analyticsDate';

export interface StudentStatusCounts {
  active: number;
  paused: number;
  frozen: number;
  total: number;
}

export interface GroupStatusCounts {
  active: number;
  paused: number;
  completed: number;
  total: number;
}

export interface AttendanceSummary {
  rate: number;
  present: number;
  absent: number;
  late: number;
  total: number;
  cancelled: number;
  invalidated: number;
}

export interface AcademicKPIs {
  students: StudentStatusCounts;
  groups: GroupStatusCounts;
  avgCredits: number;
  attendance: AttendanceSummary;
}

export async function getStudentStatusCounts(schoolId: number): Promise<StudentStatusCounts> {
  const [activeCount, pausedUniqueCount, frozenCount, total] = await Promise.all([
    prisma.studentProfile.count({
      where: {
        user: { schoolId, deletedAt: null },
        deletedAt: null,
        isFrozen: false,
        memberships: { some: { status: MemberStatus.ACTIVE, schoolId, studentGroup: { deletedAt: null } } },
      },
    }),
    prisma.groupMembership
      .findMany({
        where: { schoolId, status: MemberStatus.PAUSED },
        select: { studentProfileId: true },
        distinct: ['studentProfileId'],
      })
      .then(rows => rows.length),
    prisma.studentProfile.count({
      where: { user: { schoolId, deletedAt: null }, deletedAt: null, isFrozen: true },
    }),
    prisma.studentProfile.count({
      where: { user: { schoolId, deletedAt: null }, deletedAt: null },
    }),
  ]);

  return { active: activeCount, paused: pausedUniqueCount, frozen: frozenCount, total };
}

export async function getGroupStatusCounts(schoolId: number): Promise<GroupStatusCounts> {
  const groups = await prisma.studentGroup.groupBy({
    by: ['status'],
    where: { schoolId, deletedAt: null },
    _count: { _all: true },
  });

  const byStatus = new Map(groups.map(g => [g.status as GroupStatus, g._count._all]));
  const active = byStatus.get(GroupStatus.ACTIVE) ?? 0;
  const paused = byStatus.get(GroupStatus.PAUSED) ?? 0;
  const completed = byStatus.get(GroupStatus.COMPLETED) ?? 0;

  return { active, paused, completed, total: active + paused + completed };
}

export async function getAcademicKPIs(schoolId: number, range: AnalyticsRange): Promise<AcademicKPIs> {
  const [students, groups, avgCreditsResult, attendanceRows, sessionRows] = await Promise.all([
    getStudentStatusCounts(schoolId),
    getGroupStatusCounts(schoolId),
    prisma.studentProfile.aggregate({
      where: { user: { schoolId, deletedAt: null }, deletedAt: null },
      _avg: { credits: true },
    }),
    prisma.attendance.groupBy({
      by: ['status'],
      where: { schoolId, lessonSession: { date: rangeWhere(range) } },
      _count: { _all: true },
    }),
    prisma.lessonSession.groupBy({
      by: ['status'],
      where: { schoolId, deletedAt: null, date: rangeWhere(range) },
      _count: { _all: true },
    }),
  ]);

  const avgCredits = Math.round(Number(avgCreditsResult._avg.credits ?? 0));

  const attByStatus = new Map(attendanceRows.map(r => [r.status, r._count._all]));
  const present = attByStatus.get(AttendanceStatus.PRESENT) ?? 0;
  const late = attByStatus.get(AttendanceStatus.LATE) ?? 0;
  const absent = attByStatus.get(AttendanceStatus.ABSENT) ?? 0;
  const total = present + late + absent;
  const rate = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

  const sessByStatus = new Map(sessionRows.map(s => [s.status as string, s._count._all]));
  const cancelled = sessByStatus.get('CANCELLED') ?? 0;
  const invalidated = sessByStatus.get('INVALIDATED') ?? 0;

  return {
    students,
    groups,
    avgCredits,
    attendance: { rate, present, late, absent, total, cancelled, invalidated },
  };
}
