import { Router } from 'express';
import {
  AttendanceStatus,
  ExpenseCategory,
  LeadStatus,
  MemberStatus,
  Prisma,
  Role,
} from '@prisma/client';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { createLogger } from '../lib/logger';

const log = createLogger('analytics');
import {
  AnalyticsRange,
  getAnalyticsPeriods,
  percentChange,
  rangeWhere,
  safePercent,
} from '../services/analyticsDate';
import { getFinanceKPIs, getReceivablesAging } from '../services/financeAnalyticsService';
import { getAcademicKPIs } from '../services/academicAnalyticsService';
import { getEffectiveSessionTeacherId } from '../services/sessionService';

const router = Router();

const STAGE_COLORS = ['#3b82f6', '#6366f1', '#8b5cf6', '#22c55e', '#10b981'];
const CHART_COLORS = ['#3b82f6', '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#10b981'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const CEFR_LEVELS = ['Pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

type TabBuilder = (schoolId: number, range: AnalyticsRange, previous?: AnalyticsRange, req?: AuthRequest) => Promise<unknown>;

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value == null) return 0;
  return Number(value);
}

function money(value: Prisma.Decimal | number | null | undefined): number {
  return Math.round(toNumber(value));
}

function serializeRange(range: AnalyticsRange) {
  return { from: range.from.toISOString(), to: range.to.toISOString() };
}

function withPeriods(currentPeriod: AnalyticsRange, previousPeriod: AnalyticsRange | undefined, payload: Record<string, unknown>) {
  return {
    currentPeriod: serializeRange(currentPeriod),
    previousPeriod: previousPeriod ? serializeRange(previousPeriod) : null,
    ...payload,
  };
}

async function sendTab(req: AuthRequest, res: any, builder: TabBuilder) {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const { currentPeriod, previousPeriod } = getAnalyticsPeriods(req.query);
    const data = await builder(schoolId, currentPeriod, previousPeriod, req);
    res.json({ success: true, data: withPeriods(currentPeriod, previousPeriod, data as Record<string, unknown>) });
  } catch (error) {
    log.error({ err: error }, 'analytics tab failed');
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
}

async function sumStudentPayments(schoolId: number, range: AnalyticsRange, studentProfileIds?: number[]) {
  const result = await prisma.studentPayment.aggregate({
    where: {
      schoolId,
      createdAt: rangeWhere(range),
      ...(studentProfileIds ? { studentProfileId: { in: studentProfileIds } } : {}),
    },
    _sum: { amount: true },
  });
  return money(result._sum.amount);
}

async function sumExpenses(schoolId: number, range: AnalyticsRange, category?: ExpenseCategory) {
  const result = await prisma.expense.aggregate({
    where: {
      schoolId,
      expenseDate: rangeWhere(range),
      ...(category ? { category } : {}),
    },
    _sum: { amount: true },
  });
  return money(result._sum.amount);
}

async function sumMarketingSpend(schoolId: number, range: AnalyticsRange, source?: string) {
  const result = await prisma.marketingSpend.aggregate({
    where: {
      schoolId,
      spendDate: rangeWhere(range),
      ...(source ? { source } : {}),
    },
    _sum: { amount: true },
  });
  return money(result._sum.amount);
}

async function activeStudentCount(schoolId: number) {
  return prisma.user.count({
    where: {
      schoolId,
      role: Role.STUDENT,
      deletedAt: null,
      studentProfile: { deletedAt: null, isFrozen: false },
    },
  });
}

async function groupFillRate(schoolId: number) {
  const groups = await prisma.studentGroup.findMany({
    where: { schoolId, deletedAt: null, status: 'ACTIVE' },
    select: { maxStudents: true, memberships: { where: { status: 'ACTIVE' }, select: { id: true } } },
  });
  const capacity = groups.reduce((sum, group) => sum + (group.maxStudents || 0), 0);
  const filled = groups.reduce((sum, group) => sum + group.memberships.length, 0);
  return safePercent(filled, capacity);
}

async function attendanceRate(schoolId: number, range: AnalyticsRange) {
  const [present, late, absent] = await Promise.all([
    prisma.attendance.count({ where: { schoolId, status: AttendanceStatus.PRESENT, lessonSession: { date: rangeWhere(range) } } }),
    prisma.attendance.count({ where: { schoolId, status: AttendanceStatus.LATE, lessonSession: { date: rangeWhere(range) } } }),
    prisma.attendance.count({ where: { schoolId, status: AttendanceStatus.ABSENT, lessonSession: { date: rangeWhere(range) } } }),
  ]);
  return { present, late, absent, total: present + late + absent, rate: safePercent(present + late, present + late + absent) };
}

async function churnRate(schoolId: number, range: AnalyticsRange) {
  const [withdrawn, active] = await Promise.all([
    prisma.groupMembership.count({ where: { schoolId, status: MemberStatus.WITHDRAWN, leftAt: rangeWhere(range) } }),
    prisma.groupMembership.count({
      where: {
        schoolId,
        joinedAt: { lte: range.to },
        OR: [{ leftAt: null }, { leftAt: { gte: range.from } }],
      },
    }),
  ]);
  return safePercent(withdrawn, active || withdrawn);
}

async function npsScore(schoolId: number, range: AnalyticsRange) {
  const agg = await prisma.npsResponse.aggregate({
    where: { schoolId, createdAt: rangeWhere(range) },
    _avg: { score: true },
  });
  return Math.round(Number(agg._avg.score ?? 0));
}

async function leadStageCounts(schoolId: number, range: AnalyticsRange) {
  const [leads, trials, paid, active, renewals] = await Promise.all([
    prisma.lead.count({ where: { schoolId, createdAt: rangeWhere(range) } }),
    prisma.lead.count({ where: { schoolId, trialAt: rangeWhere(range) } }),
    prisma.lead.count({ where: { schoolId, paidAt: rangeWhere(range) } }),
    prisma.lead.count({ where: { schoolId, becameActiveAt: rangeWhere(range) } }),
    prisma.lead.count({ where: { schoolId, renewedAt: rangeWhere(range) } }),
  ]);
  return { leads, trials, paid, active, renewals };
}

function makeFunnelStages(current: Awaited<ReturnType<typeof leadStageCounts>>, previous?: Awaited<ReturnType<typeof leadStageCounts>>) {
  const rows = [
    { key: 'leads', stage: 'Leads', desc: 'Входящие обращения из всех источников', count: current.leads, prev: previous?.leads ?? 0, avgDays: null },
    { key: 'trials', stage: 'Пробные занятия', desc: 'Записались на пробный урок', count: current.trials, prev: previous?.trials ?? 0, avgDays: 0 },
    { key: 'paid', stage: 'Первая оплата', desc: 'Оплатили первый период', count: current.paid, prev: previous?.paid ?? 0, avgDays: 0 },
    { key: 'active', stage: 'Активные студенты', desc: 'Начали обучение', count: current.active, prev: previous?.active ?? 0, avgDays: 0 },
    { key: 'renewals', stage: 'Продления', desc: 'Продлили следующий период', count: current.renewals, prev: previous?.renewals ?? 0, avgDays: null },
  ];
  return rows.map((row, index) => ({
    ...row,
    color: STAGE_COLORS[index],
    conversion: index === 0 ? null : safePercent(row.count, rows[index - 1].count),
    change: percentChange(row.count, row.prev),
  }));
}

async function sourceStats(schoolId: number, range: AnalyticsRange, source?: string) {
  const leadGroups = await prisma.lead.groupBy({
    by: ['source'],
    where: { schoolId, createdAt: rangeWhere(range), ...(source ? { source } : {}) },
    _count: { _all: true },
  });
  const spendGroups = await prisma.marketingSpend.groupBy({
    by: ['source'],
    where: { schoolId, spendDate: rangeWhere(range), ...(source ? { source } : {}) },
    _sum: { amount: true },
  });
  const paidGroups = await prisma.lead.groupBy({
    by: ['source'],
    where: { schoolId, paidAt: rangeWhere(range), ...(source ? { source } : {}) },
    _count: { _all: true },
  });
  const trialGroups = await prisma.lead.groupBy({
    by: ['source'],
    where: { schoolId, trialAt: rangeWhere(range), ...(source ? { source } : {}) },
    _count: { _all: true },
  });
  const activeGroups = await prisma.lead.groupBy({
    by: ['source'],
    where: { schoolId, becameActiveAt: rangeWhere(range), ...(source ? { source } : {}) },
    _count: { _all: true },
  });
  const sources = Array.from(new Set([
    ...leadGroups.map(row => row.source),
    ...spendGroups.map(row => row.source),
    ...paidGroups.map(row => row.source),
    ...trialGroups.map(row => row.source),
    ...activeGroups.map(row => row.source),
  ])).sort();

  return Promise.all(sources.map(async (name, index) => {
    const leads = leadGroups.find(row => row.source === name)?._count._all ?? 0;
    const cost = money(spendGroups.find(row => row.source === name)?._sum.amount);
    const paid = paidGroups.find(row => row.source === name)?._count._all ?? 0;
    const trials = trialGroups.find(row => row.source === name)?._count._all ?? 0;
    const active = activeGroups.find(row => row.source === name)?._count._all ?? 0;
    const linkedProfiles = (await prisma.lead.findMany({
      where: { schoolId, source: name, paidAt: { not: null }, studentProfileId: { not: null } },
      select: { studentProfileId: true },
      distinct: ['studentProfileId'],
    })).map(row => row.studentProfileId!).filter(Boolean);
    const revenue = linkedProfiles.length ? await sumStudentPayments(schoolId, range, linkedProfiles) : 0;
    return {
      source: name,
      leads,
      cost,
      paid,
      trials,
      active,
      conversion: safePercent(paid, leads),
      revenue,
      roi: cost > 0 ? Math.round(((revenue - cost) / cost) * 100) : null,
      color: CHART_COLORS[index % CHART_COLORS.length],
    };
  }));
}

async function buildMonthlySeries(schoolId: number, end: Date) {
  const months = Array.from({ length: 12 }, (_, index) => {
    const d = new Date(end.getFullYear(), end.getMonth() - 11 + index, 1);
    return {
      from: new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0),
      to: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999),
    };
  });

  return Promise.all(months.map(async range => {
    const [revenue, expenses, leads, students] = await Promise.all([
      sumStudentPayments(schoolId, range),
      sumExpenses(schoolId, range),
      prisma.lead.count({ where: { schoolId, createdAt: rangeWhere(range) } }),
      prisma.user.count({ where: { schoolId, role: Role.STUDENT, deletedAt: null, createdAt: { lte: range.to } } }),
    ]);
    return {
      month: range.from.toLocaleString('ru-RU', { month: 'short' }),
      revenue,
      income: revenue,
      expenses,
      profit: revenue - expenses,
      leads,
      students,
      activeStudents: students,
    };
  }));
}

async function overview(schoolId: number, current: AnalyticsRange, previous?: AnalyticsRange) {
  const [
    totalStudents,
    totalTeachers,
    activeLessons,
    revenue,
    expenses,
    marketingSpend,
    leads,
    paidLeads,
    attendance,
    fillRate,
    churn,
    nps,
    monthlySeries,
    currentFunnel,
    previousFunnel,
    traffic,
    lowBalance,
    cancelledSessions,
  ] = await Promise.all([
    activeStudentCount(schoolId),
    prisma.user.count({ where: { schoolId, role: Role.TEACHER, deletedAt: null, staffProfile: { deletedAt: null } } }),
    prisma.lessonBlock.count({ where: { schoolId, deletedAt: null, status: 'UPCOMING' } }),
    sumStudentPayments(schoolId, current),
    sumExpenses(schoolId, current),
    sumMarketingSpend(schoolId, current),
    prisma.lead.count({ where: { schoolId, createdAt: rangeWhere(current) } }),
    prisma.lead.count({ where: { schoolId, paidAt: rangeWhere(current) } }),
    attendanceRate(schoolId, current),
    groupFillRate(schoolId),
    churnRate(schoolId, current),
    npsScore(schoolId, current),
    buildMonthlySeries(schoolId, current.to),
    leadStageCounts(schoolId, current),
    previous ? leadStageCounts(schoolId, previous) : Promise.resolve(undefined),
    sourceStats(schoolId, current),
    prisma.studentProfile.count({ where: { user: { schoolId, deletedAt: null }, credits: { lte: 0 }, deletedAt: null } }),
    prisma.lessonSession.count({ where: { schoolId, deletedAt: null, status: 'CANCELLED', date: rangeWhere(current) } }),
  ]);

  const prevRevenue = previous ? await sumStudentPayments(schoolId, previous) : 0;
  const prevStudents = previous ? await activeStudentCount(schoolId) : 0;
  const prevAttendance = previous ? await attendanceRate(schoolId, previous) : undefined;
  const prevChurn = previous ? await churnRate(schoolId, previous) : 0;
  const prevSpend = previous ? await sumMarketingSpend(schoolId, previous) : 0;
  const prevPaid = previous ? await prisma.lead.count({ where: { schoolId, paidAt: rangeWhere(previous) } }) : 0;
  const arpu = totalStudents > 0 ? Math.round(revenue / totalStudents) : 0;
  const cac = paidLeads > 0 ? Math.round(marketingSpend / paidLeads) : 0;
  const romi = marketingSpend > 0 ? Math.round(((revenue - marketingSpend) / marketingSpend) * 100) : 0;
  const prevArpu = prevStudents > 0 ? Math.round(prevRevenue / prevStudents) : 0;
  const prevCac = prevPaid > 0 ? Math.round(prevSpend / prevPaid) : 0;

  const courses = await courseDistribution(schoolId);
  const heatmap = await scheduleHeatmap(schoolId, current);

  return {
    metrics: {
      totalStudents: { value: totalStudents, change: percentChange(totalStudents, prevStudents) },
      monthlyRevenue: { value: revenue, change: percentChange(revenue, prevRevenue) },
      activeLessons: { value: activeLessons, change: 0 },
      totalTeachers: { value: totalTeachers, change: 0 },
      retentionRate: { value: attendance.rate, change: percentChange(attendance.rate, prevAttendance?.rate ?? 0) },
      churnRate: { value: churn, change: percentChange(churn, prevChurn) },
      arpu: { value: arpu, change: percentChange(arpu, prevArpu) },
      cac: { value: cac, change: percentChange(cac, prevCac) },
      romi: { value: romi, change: 0 },
      groupFillRate: { value: fillRate, change: 0 },
      npsScore: { value: nps, change: 0 },
      newLeads: { value: leads, change: percentChange(currentFunnel.leads, previousFunnel?.leads ?? 0) },
    },
    charts: {
      revenueData: monthlySeries,
      funnelData: makeFunnelStages(currentFunnel, previousFunnel),
      courseDistribution: courses,
      heatmapData: heatmap,
      trafficSources: traffic,
    },
    alerts: [
      ...(lowBalance > 0 ? [{ type: 'warning', message: `Низкий баланс у ${lowBalance} студентов`, time: 'из БД' }] : []),
      ...(leads > 0 ? [{ type: 'info', message: `${leads} новых лидов за период`, time: 'из БД' }] : []),
    ],
    attendanceStats: attendance,
    lowBalance,
    cancelledSessions,
  };
}

async function courseDistribution(schoolId: number) {
  const groups = await prisma.groupMembership.groupBy({
    by: ['studentGroupId'],
    where: { schoolId, status: 'ACTIVE' },
    _count: { _all: true },
  });
  const groupRows = await prisma.studentGroup.findMany({
    where: { schoolId, id: { in: groups.map(row => row.studentGroupId) } },
    select: { id: true, level: true },
  });
  const byLevel = new Map<string, number>();
  for (const row of groups) {
    const level = groupRows.find(group => group.id === row.studentGroupId)?.level ?? 'Не указан';
    byLevel.set(level, (byLevel.get(level) ?? 0) + row._count._all);
  }
  const total = Array.from(byLevel.values()).reduce((sum, value) => sum + value, 0);
  return Array.from(byLevel.entries()).map(([name, count], index) => ({
    name,
    value: safePercent(count, total),
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));
}

async function scheduleHeatmap(schoolId: number, range: AnalyticsRange) {
  const sessions = await prisma.lessonSession.findMany({
    where: { schoolId, deletedAt: null, date: rangeWhere(range), status: { notIn: ['CANCELLED', 'INVALIDATED'] } },
    select: { date: true, startTimeSnap: true, lessonBlock: { select: { startTime: true } } },
    take: 5000,
  });
  const map = new Map<string, number>();
  for (const session of sessions) {
    const dayIndex = (session.date.getDay() + 6) % 7;
    const hour = `${parseInt((session.startTimeSnap ?? session.lessonBlock.startTime).split(':')[0], 10)}:00`;
    const key = `${DAY_LABELS[dayIndex]}|${hour}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  const max = Math.max(1, ...Array.from(map.values()));
  const hours = Array.from({ length: 12 }, (_, i) => `${i + 8}:00`);
  return DAY_LABELS.flatMap(day => hours.map(hour => ({
    day,
    hour,
    value: Math.round(((map.get(`${day}|${hour}`) ?? 0) / max) * 100),
  })));
}

async function funnel(schoolId: number, current: AnalyticsRange, previous?: AnalyticsRange) {
  const currentCounts = await leadStageCounts(schoolId, current);
  const previousCounts = previous ? await leadStageCounts(schoolId, previous) : undefined;
  const stages = makeFunnelStages(currentCounts, previousCounts);
  const bySource = await sourceStats(schoolId, current);
  return {
    metrics: {},
    charts: { stageDetails: stages, convBySource: bySource.map(row => ({
      source: row.source,
      leads: row.leads,
      trials: row.trials,
      paid: row.paid,
      active: row.active,
    })) },
    tables: { stageDetails: stages },
  };
}

async function traffic(schoolId: number, current: AnalyticsRange, _previous?: AnalyticsRange, req?: AuthRequest) {
  const source = typeof req?.query.source === 'string' && req.query.source !== 'all' ? req.query.source : undefined;
  const sources = await sourceStats(schoolId, current, source);
  const campaigns = await prisma.marketingCampaign.findMany({
    where: { schoolId, ...(source ? { source } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  const campaignBreakdown = await Promise.all(campaigns.map(async campaign => {
    const [leads, paid, spend] = await Promise.all([
      prisma.lead.count({ where: { schoolId, campaignId: campaign.id, createdAt: rangeWhere(current) } }),
      prisma.lead.count({ where: { schoolId, campaignId: campaign.id, paidAt: rangeWhere(current) } }),
      prisma.marketingSpend.aggregate({ where: { schoolId, campaignId: campaign.id, spendDate: rangeWhere(current) }, _sum: { amount: true } }),
    ]);
    const cost = money(spend._sum.amount);
    return {
      ad: campaign.name,
      source: campaign.source,
      leads,
      cost,
      cpl: leads > 0 ? Math.round(cost / leads) : 0,
      conversion: safePercent(paid, leads),
    };
  }));
  const weekdayLeads = await prisma.lead.findMany({
    where: { schoolId, createdAt: rangeWhere(current), ...(source ? { source } : {}) },
    select: { createdAt: true, paidAt: true },
    take: 2000,
  });
  const conversionByDay = DAY_LABELS.map((day, index) => {
    const rows = weekdayLeads.filter(lead => ((lead.createdAt.getDay() + 6) % 7) === index);
    return { day, rate: safePercent(rows.filter(row => row.paidAt).length, rows.length) };
  });
  return { metrics: {}, charts: { trafficSources: sources, conversionByDay }, tables: { campaignBreakdown } };
}

async function operations(schoolId: number, current: AnalyticsRange) {
  const [groups, attendanceRows, studentsByLevel, teacherRows, academicKPIs] = await Promise.all([
    prisma.studentGroup.findMany({
      where: { schoolId, deletedAt: null },
      include: { memberships: { where: { status: 'ACTIVE' }, select: { id: true } } },
      orderBy: { level: 'asc' },
    }),
    prisma.attendance.findMany({
      where: { schoolId, lessonSession: { date: rangeWhere(current) } },
      select: { status: true, lessonSession: { select: { lessonBlock: { select: { studentGroup: { select: { level: true } } } } } } },
      take: 10000,
    }),
    prisma.studentProfile.groupBy({
      by: ['level'],
      where: { user: { schoolId, deletedAt: null }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.staffProfile.findMany({
      where: { deletedAt: null, user: { schoolId, deletedAt: null } },
      select: { id: true, user: { select: { firstName: true, lastName: true } } },
    }),
    getAcademicKPIs(schoolId, current),
  ]);

  const groupFillData = groups.map(group => ({
    group: `${group.level} · Гл.${group.chapter}`,
    fill: safePercent(group.memberships.length, group.maxStudents),
    capacity: group.maxStudents,
  }));

  const attendanceByGroup = new Map<string, { present: number; total: number }>();
  for (const row of attendanceRows) {
    const group = row.lessonSession.lessonBlock.studentGroup?.level ?? 'Без группы';
    const entry = attendanceByGroup.get(group) ?? { present: 0, total: 0 };
    entry.total++;
    if (row.status === AttendanceStatus.PRESENT || row.status === AttendanceStatus.LATE) entry.present++;
    attendanceByGroup.set(group, entry);
  }
  const attendanceData = Array.from(attendanceByGroup.entries()).map(([group, value]) => ({
    group,
    attendance: safePercent(value.present, value.total),
  }));

  const cefrProgress = CEFR_LEVELS.map(level => ({
    level,
    count: studentsByLevel.find(row => row.level === level)?._count._all ?? 0,
  }));

  // Batch teacher heatmap: single query for all teachers, aggregate in memory
  const teacherIds = teacherRows.map(t => t.id);
  const allTeacherSessions = teacherIds.length > 0
    ? await prisma.lessonSession.findMany({
        where: {
          schoolId,
          deletedAt: null,
          date: rangeWhere(current),
          status: { notIn: ['CANCELLED', 'INVALIDATED'] },
          OR: [
            { teacherId: { in: teacherIds } },
            { teacherId: null, lessonBlock: { teacherId: { in: teacherIds } } },
          ],
        },
        select: {
          date: true,
          teacherId: true,
          teacherIdSnap: true,
          isManualTeacher: true,
          lessonBlock: { select: { teacherId: true } },
        },
      })
    : [];

  const teacherHeatData = teacherRows.map(teacher => {
    const row: Record<string, string | number> = {
      teacher: `${teacher.user.lastName} ${teacher.user.firstName.charAt(0)}.`,
    };
    DAY_KEYS.forEach(key => { row[key] = 0; });
    allTeacherSessions
      .filter(s => (getEffectiveSessionTeacherId(s) ?? s.lessonBlock.teacherId) === teacher.id)
      .forEach(s => {
        const index = (s.date.getDay() + 6) % 7;
        row[DAY_KEYS[index]] = Number(row[DAY_KEYS[index]]) + 1;
      });
    return row;
  });

  return {
    metrics: {
      studentActive: academicKPIs.students.active,
      studentPaused: academicKPIs.students.paused,
      studentFrozen: academicKPIs.students.frozen,
      studentTotal: academicKPIs.students.total,
      groupActive: academicKPIs.groups.active,
      groupPaused: academicKPIs.groups.paused,
      groupCompleted: academicKPIs.groups.completed,
      avgCredits: academicKPIs.avgCredits,
      attendanceRate: academicKPIs.attendance.rate,
      sessionCancelled: academicKPIs.attendance.cancelled,
      sessionInvalidated: academicKPIs.attendance.invalidated,
    },
    charts: { groupFillData, attendanceData, cefrProgress, teacherHeatData },
  };
}

async function finance(schoolId: number, current: AnalyticsRange, previous?: AnalyticsRange) {
  const [series, income, expenses, prevIncome, prevExpenses, debtors, incomeByCategory, kpis, aging] = await Promise.all([
    buildMonthlySeries(schoolId, current.to),
    sumStudentPayments(schoolId, current),
    sumExpenses(schoolId, current),
    previous ? sumStudentPayments(schoolId, previous) : Promise.resolve(0),
    previous ? sumExpenses(schoolId, previous) : Promise.resolve(0),
    debtorRows(schoolId),
    incomeByCourse(schoolId, current),
    getFinanceKPIs(schoolId, current, previous),
    getReceivablesAging(schoolId, current.to),
  ]);
  const profit = income - expenses;
  const prevProfit = prevIncome - prevExpenses;
  return {
    metrics: {
      income: { value: income, change: percentChange(income, prevIncome) },
      expenses: { value: expenses, change: percentChange(expenses, prevExpenses) },
      profit: { value: profit, change: percentChange(profit, prevProfit) },
      debt: { value: debtors.reduce((sum, row) => sum + row.amount, 0), change: 0 },
      collectedAmount: { value: kpis.collectedAmount, change: percentChange(kpis.collectedAmount, kpis.prevCollectedAmount) },
      refundedAmount: { value: kpis.refundedAmount, change: percentChange(kpis.refundedAmount, kpis.prevRefundedAmount) },
      refundRate: { value: kpis.refundRate, change: 0 },
      collectionRate: { value: kpis.collectionRate, change: 0 },
      avgInvoiceValue: { value: kpis.avgInvoiceValue, change: 0 },
      paidInvoiceCount: { value: kpis.paidInvoiceCount, change: 0 },
      overdueInvoiceCount: { value: kpis.overdueInvoiceCount, change: 0 },
      totalOverdueOutstanding: { value: kpis.totalOverdueOutstanding, change: 0 },
    },
    charts: { financeData: series, incomeByCategory },
    tables: { debtors, agingBuckets: aging },
  };
}

async function debtorRows(schoolId: number) {
  const config = await prisma.schoolFinanceConfig.findUnique({ where: { schoolId } });
  const price = config?.pricePerLesson ?? 0;
  const rows = await prisma.studentProfile.findMany({
    where: { user: { schoolId, deletedAt: null }, deletedAt: null, credits: { lte: 0 } },
    take: 10,
    orderBy: { credits: 'asc' },
    include: {
      user: { select: { firstName: true, lastName: true } },
      memberships: { where: { status: 'ACTIVE', studentGroup: { deletedAt: null } }, take: 1, include: { studentGroup: { select: { level: true } } } },
    },
  });
  return rows.map(row => {
    const days = row.paidUntil && row.paidUntil < new Date()
      ? Math.max(1, Math.floor((Date.now() - row.paidUntil.getTime()) / 86_400_000))
      : Math.max(1, Math.abs(row.credits));
    return {
      name: `${row.user.lastName} ${row.user.firstName.charAt(0)}.`,
      amount: Math.max(1, Math.abs(row.credits) || 1) * price,
      days,
      group: row.memberships[0]?.studentGroup.level ?? 'Без группы',
    };
  });
}

async function incomeByCourse(schoolId: number, range: AnalyticsRange) {
  const payments = await prisma.studentPayment.findMany({
    where: { schoolId, createdAt: rangeWhere(range) },
    include: {
      studentProfile: {
        include: { memberships: { where: { status: 'ACTIVE', studentGroup: { deletedAt: null } }, take: 1, include: { studentGroup: { select: { level: true } } } } },
      },
    },
  });
  const byLevel = new Map<string, number>();
  for (const payment of payments) {
    const level = payment.studentProfile.memberships[0]?.studentGroup.level ?? payment.studentProfile.level ?? 'Не указан';
    byLevel.set(level, (byLevel.get(level) ?? 0) + money(payment.amount));
  }
  const total = Array.from(byLevel.values()).reduce((sum, value) => sum + value, 0);
  return Array.from(byLevel.entries()).map(([name, amount], index) => ({
    name,
    value: safePercent(amount, total),
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));
}

async function students(schoolId: number, current: AnalyticsRange, previous?: AnalyticsRange) {
  const [revenue, active, churn, retention, nps, cohorts, churnReasons, riskStudents] = await Promise.all([
    sumStudentPayments(schoolId, current),
    activeStudentCount(schoolId),
    churnRate(schoolId, current),
    attendanceRate(schoolId, current),
    npsScore(schoolId, current),
    cohortData(schoolId, current.to),
    churnReasonRows(schoolId, current),
    riskStudentRows(schoolId),
  ]);
  const prevRevenue = previous ? await sumStudentPayments(schoolId, previous) : 0;
  const ltv = active > 0 ? Math.round(revenue / active) : 0;
  const prevLtv = active > 0 ? Math.round(prevRevenue / active) : 0;
  return {
    metrics: {
      ltv: { value: ltv, change: percentChange(ltv, prevLtv) },
      retention: { value: retention.rate, change: 0 },
      churn: { value: churn, change: 0 },
      nps: { value: nps, change: 0 },
    },
    charts: { cohortData: cohorts, churnReasons },
    tables: { riskStudents },
  };
}

async function cohortData(schoolId: number, end: Date) {
  const months = Array.from({ length: 6 }, (_, index) => {
    const d = new Date(end.getFullYear(), end.getMonth() - 5 + index, 1);
    return { from: new Date(d.getFullYear(), d.getMonth(), 1), to: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999) };
  });
  return Promise.all(months.map(async month => {
    const joined = await prisma.groupMembership.findMany({
      where: { schoolId, joinedAt: rangeWhere(month) },
      select: { studentProfileId: true, joinedAt: true, leftAt: true },
      distinct: ['studentProfileId'],
    });
    const base = joined.length || 1;
    const row: Record<string, number | string | null> = {
      cohort: month.from.toLocaleString('ru-RU', { month: 'short', year: 'numeric' }),
      m0: 100,
    };
    for (let i = 1; i <= 6; i++) {
      const cutoff = new Date(month.from.getFullYear(), month.from.getMonth() + i, 1);
      if (cutoff > end) {
        row[`m${i}`] = null;
      } else {
        const retained = joined.filter(item => !item.leftAt || item.leftAt >= cutoff).length;
        row[`m${i}`] = safePercent(retained, base);
      }
    }
    return row;
  }));
}

async function churnReasonRows(schoolId: number, range: AnalyticsRange) {
  const rows = await prisma.groupMembership.groupBy({
    by: ['leftReason'],
    where: { schoolId, status: MemberStatus.WITHDRAWN, leftAt: rangeWhere(range) },
    _count: { _all: true },
  });
  const total = rows.reduce((sum, row) => sum + row._count._all, 0);
  return rows.map((row, index) => ({
    reason: row.leftReason ?? 'Не указано',
    value: safePercent(row._count._all, total),
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));
}

async function riskStudentRows(schoolId: number) {
  const rows = await prisma.studentProfile.findMany({
    where: { user: { schoolId, deletedAt: null }, deletedAt: null, OR: [{ atRiskSince: { not: null } }, { credits: { lte: 1 } }] },
    include: { user: { select: { firstName: true, lastName: true } } },
    orderBy: [{ atRiskSince: 'desc' }, { credits: 'asc' }],
    take: 5,
  });
  return rows.map(row => ({
    name: `${row.user.firstName} ${row.user.lastName.charAt(0)}.`,
    risk: row.atRiskSince ? 'Высокий' : row.credits <= 0 ? 'Средний' : 'Низкий',
    reason: row.atRiskSince ? 'Пропуски подряд' : 'Низкий баланс',
    days: row.atRiskSince ? Math.max(1, Math.floor((Date.now() - row.atRiskSince.getTime()) / 86_400_000)) : 0,
  }));
}

async function teachers(schoolId: number, current: AnalyticsRange) {
  const rows = await prisma.staffProfile.findMany({
    where: { deletedAt: null, user: { schoolId, deletedAt: null } },
    include: {
      user: { select: { firstName: true, lastName: true } },
      taughtBlocks: {
        where: { deletedAt: null },
        include: { studentGroup: { include: { memberships: { where: { status: 'ACTIVE', studentGroup: { deletedAt: null } } } } } },
      },
    },
  });

  if (rows.length === 0) {
    return { metrics: {}, charts: { utilizationData: [], retentionByTeacher: [] }, tables: { teacherData: [] } };
  }

  const teacherIds = rows.map(t => t.id);

  // Build per-teacher student sets first (needed for revenue batch)
  const teacherStudentMap = new Map<number, Set<number>>();
  for (const t of rows) {
    const ids = new Set<number>();
    t.taughtBlocks.forEach(b => b.studentGroup?.memberships.forEach(m => ids.add(m.studentProfileId)));
    teacherStudentMap.set(t.id, ids);
  }
  const allStudentIds = Array.from(new Set(Array.from(teacherStudentMap.values()).flatMap(s => Array.from(s))));

  // Batch 1: all sessions for all teachers in period
  const [allSessions, allAttendance, revenueByStudent] = await Promise.all([
    prisma.lessonSession.findMany({
      where: {
        schoolId,
        deletedAt: null,
        date: rangeWhere(current),
        status: { not: 'CANCELLED' },
        OR: [
          { teacherId: { in: teacherIds } },
          { teacherId: null, lessonBlock: { teacherId: { in: teacherIds } } },
        ],
      },
      select: { teacherId: true, teacherIdSnap: true, isManualTeacher: true, lessonBlock: { select: { teacherId: true } } },
    }),
    prisma.attendance.findMany({
      where: {
        schoolId,
        lessonSession: {
          date: rangeWhere(current),
          OR: [
            { teacherId: { in: teacherIds } },
            { teacherId: null, lessonBlock: { teacherId: { in: teacherIds } } },
          ],
        },
      },
      select: {
        status: true,
        lessonSession: { select: { teacherId: true, teacherIdSnap: true, isManualTeacher: true, lessonBlock: { select: { teacherId: true } } } },
      },
    }),
    // Batch 2: revenue per student in one groupBy
    allStudentIds.length > 0
      ? prisma.studentPayment.groupBy({
          by: ['studentProfileId'],
          where: { schoolId, createdAt: rangeWhere(current), studentProfileId: { in: allStudentIds } },
          _sum: { amount: true },
        })
      : Promise.resolve([] as Array<{ studentProfileId: number; _sum: { amount: Prisma.Decimal | null } }>),
  ]);

  // Build lookup maps
  const revenueMap = new Map(revenueByStudent.map(r => [r.studentProfileId, Math.round(Number(r._sum.amount ?? 0))]));

  const sessionCountMap = new Map<number, number>();
  for (const s of allSessions) {
    const tid = getEffectiveSessionTeacherId(s) ?? s.lessonBlock.teacherId;
    if (tid) sessionCountMap.set(tid, (sessionCountMap.get(tid) ?? 0) + 1);
  }

  const attMap = new Map<number, { present: number; total: number }>();
  for (const a of allAttendance) {
    const tid = getEffectiveSessionTeacherId(a.lessonSession) ?? a.lessonSession.lessonBlock.teacherId;
    if (!tid) continue;
    const entry = attMap.get(tid) ?? { present: 0, total: 0 };
    entry.total++;
    if (a.status === AttendanceStatus.PRESENT || a.status === AttendanceStatus.LATE) entry.present++;
    attMap.set(tid, entry);
  }

  const teacherData = rows.map((teacher, index) => {
    const groups = teacher.taughtBlocks.filter(b => b.studentGroupId).length;
    const studentIds = teacherStudentMap.get(teacher.id) ?? new Set<number>();
    const sessions = sessionCountMap.get(teacher.id) ?? 0;
    const att = attMap.get(teacher.id) ?? { present: 0, total: 0 };
    const revenue = Array.from(studentIds).reduce((sum, sid) => sum + (revenueMap.get(sid) ?? 0), 0);
    const fullName = `${teacher.user.firstName} ${teacher.user.lastName}`;
    const avatar = `${teacher.user.firstName[0] ?? ''}${teacher.user.lastName[0] ?? ''}`.toUpperCase();
    return {
      name: fullName,
      avatar,
      groups,
      students: studentIds.size,
      utilization: safePercent(sessions, 80),
      retention: safePercent(att.present, att.total),
      rating: Number(teacher.rating ?? 0),
      revenue,
      hours: sessions,
      target: 80,
      rank: index + 1,
    };
  });

  teacherData.sort((a, b) => b.revenue - a.revenue);

  return {
    metrics: {},
    charts: {
      utilizationData: teacherData.map(row => ({ name: row.avatar, fullName: row.name, hours: row.hours, target: row.target })),
      retentionByTeacher: teacherData.map(row => ({ name: row.avatar, fullName: row.name, retention: row.retention })),
    },
    tables: { teacherData },
  };
}

router.get('/overview', authenticate, requirePermission('analytics:read'), (req: AuthRequest, res) => sendTab(req, res, overview));
router.get('/funnel', authenticate, requirePermission('analytics:read'), (req: AuthRequest, res) => sendTab(req, res, funnel));
router.get('/traffic', authenticate, requirePermission('analytics:read'), (req: AuthRequest, res) => sendTab(req, res, traffic));
router.get('/operations', authenticate, requirePermission('analytics:read'), (req: AuthRequest, res) => sendTab(req, res, operations));
router.get('/finance', authenticate, requirePermission('analytics:read'), (req: AuthRequest, res) => sendTab(req, res, finance));
router.get('/students', authenticate, requirePermission('analytics:read'), (req: AuthRequest, res) => sendTab(req, res, students));
router.get('/teachers', authenticate, requirePermission('analytics:read'), (req: AuthRequest, res) => sendTab(req, res, teachers));

async function teacherWorkload(schoolId: number) {
  const staffRows = await prisma.staffProfile.findMany({
    where: { deletedAt: null, user: { schoolId, deletedAt: null } },
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });

  if (staffRows.length === 0) return [];

  const teacherIds = staffRows.map(t => t.id);
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday));
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  const sessions = await prisma.lessonSession.findMany({
    where: {
      schoolId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      date: { gte: weekStart, lt: weekEnd },
      OR: [
        { teacherId: { in: teacherIds } },
        { teacherId: null, lessonBlock: { teacherId: { in: teacherIds } } },
      ],
    },
    select: {
      teacherId: true,
      teacherIdSnap: true,
      isManualTeacher: true,
      lessonBlock: { select: { teacherId: true } },
    },
  });

  const countMap = new Map<number, number>();
  for (const s of sessions) {
    const tid = getEffectiveSessionTeacherId(s) ?? s.lessonBlock.teacherId;
    if (tid) countMap.set(tid, (countMap.get(tid) ?? 0) + 1);
  }

  return staffRows
    .map(t => ({
      name: `${t.user.firstName} ${t.user.lastName}`,
      sessions: countMap.get(t.id) ?? 0,
      target: 20,
    }))
    .sort((a, b) => b.sessions - a.sessions);
}

router.get('/teacher-workload', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });
    const data = await teacherWorkload(schoolId);
    res.json({ success: true, data });
  } catch (error) {
    log.error({ err: error }, 'teacher workload failed');
    res.status(500).json({ success: false, error: 'Failed to fetch teacher workload' });
  }
});

router.get('/receivables-aging', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });
    const asOf = new Date();
    const buckets = await getReceivablesAging(schoolId, asOf);
    const total = {
      count: buckets.reduce((s, b) => s + b.count, 0),
      amount: buckets.reduce((s, b) => s + b.amount, 0),
    };
    res.json({ success: true, data: { buckets, total, asOf: asOf.toISOString() } });
  } catch (error) {
    log.error({ err: error }, 'receivables aging failed');
    res.status(500).json({ success: false, error: 'Failed to fetch receivables aging' });
  }
});

async function dashboardStats(schoolId: number) {
  const [totalStudents, totalTeachers, activeLessons] = await Promise.all([
    prisma.user.count({ where: { schoolId, role: Role.STUDENT, deletedAt: null } }),
    prisma.user.count({ where: { schoolId, role: Role.TEACHER, deletedAt: null } }),
    prisma.lessonBlock.count({ where: { schoolId, deletedAt: null, status: 'UPCOMING' } }),
  ]);

  const profileIds = (await prisma.studentProfile.findMany({
    where: { user: { schoolId } },
    select: { id: true },
  })).map(p => p.id);

  let recentEvents: { id: string; text: string; type: string; date: Date }[] = [];
  if (profileIds.length > 0) {
    const recentLogs = await prisma.lessonCreditLog.findMany({
      where: { studentProfileId: { in: profileIds } },
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        amount: true,
        createdAt: true,
        studentProfile: { select: { user: { select: { firstName: true, lastName: true } } } },
      },
    });
    recentEvents = recentLogs.map(log => ({
      id: `log-${log.id}`,
      text: `${log.studentProfile.user.firstName} ${log.studentProfile.user.lastName}: ${log.amount > 0 ? '+' : ''}${log.amount} кр.`,
      type: log.amount > 0 ? 'TOPUP' : 'ADJUSTMENT',
      date: log.createdAt,
    }));
  }

  // Overdue is defined identically everywhere: not frozen (StudentFreeze is SOT)
  // and credits <= 0. Must match students.ts withStatus('overdue') and the client
  // stuStatus() — do NOT use credits < 3 (that is "low balance", a different thing).
  const overdueCount = await prisma.studentProfile.count({
    where: {
      user: { schoolId, deletedAt: null },
      deletedAt: null,
      credits: { lte: 0 },
      NOT: { freezes: { some: { status: 'ACTIVE' } } },
    },
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const todaySessionsRaw = await prisma.lessonSession.findMany({
    where: { schoolId, deletedAt: null, date: { gte: todayStart, lte: todayEnd } },
    select: {
      id: true,
      startTimeSnap: true,
      lessonBlock: {
        select: {
          level: true,
          startTime: true,
          cabinet: { select: { name: true } },
          teacher: { select: { user: { select: { firstName: true, lastName: true } } } },
        },
      },
      teacher: { select: { user: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: { date: 'asc' },
  });

  const todayLessons = todaySessionsRaw.map(s => {
    const t = s.teacher ?? s.lessonBlock.teacher;
    return {
      id: s.id,
      time: s.startTimeSnap ?? s.lessonBlock.startTime,
      level: s.lessonBlock.level,
      cabinet: s.lessonBlock.cabinet?.name ?? null,
      teacherName: t ? `${t.user.firstName} ${t.user.lastName}` : null,
    };
  });

  const pendingEnrollments = await prisma.enrollmentRequest.count({
    where: { schoolId, status: 'PENDING' },
  });

  const lowBalanceStudentsRaw = await prisma.studentProfile.findMany({
    where: { user: { schoolId, deletedAt: null }, credits: { lt: 3 }, deletedAt: null },
    include: { user: { select: { firstName: true, lastName: true } } },
    orderBy: { credits: 'asc' },
    take: 5,
  });

  const lowBalanceStudents = lowBalanceStudentsRaw.map(p => ({
    id: p.id,
    name: `${p.user.firstName} ${p.user.lastName}`,
    credits: p.credits,
  }));

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cancelledSessions = await prisma.lessonSession.count({
    where: { schoolId, deletedAt: null, status: 'CANCELLED', date: { gte: sevenDaysAgo } },
  });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const attWhere = { schoolId, lessonSession: { date: { gte: thirtyDaysAgo } } };

  const [presentCount, absentCount, lateCount] = await Promise.all([
    prisma.attendance.count({ where: { ...attWhere, status: AttendanceStatus.PRESENT } }),
    prisma.attendance.count({ where: { ...attWhere, status: AttendanceStatus.ABSENT } }),
    prisma.attendance.count({ where: { ...attWhere, status: AttendanceStatus.LATE } }),
  ]);
  const totalAtt = presentCount + absentCount + lateCount;
  const attRate = totalAtt > 0 ? Math.round(((presentCount + lateCount) / totalAtt) * 100) : 0;

  const rawAttendances = await prisma.attendance.findMany({
    where: { schoolId, lessonSession: { date: { gte: thirtyDaysAgo } } },
    select: {
      status: true,
      lessonSession: {
        select: { lessonBlock: { select: { id: true, level: true, startTime: true } } },
      },
    },
  });

  const blockMap = new Map<number, { level: string; startTime: string; present: number; total: number }>();
  for (const a of rawAttendances) {
    const block = a.lessonSession.lessonBlock;
    if (!blockMap.has(block.id)) {
      blockMap.set(block.id, { level: block.level, startTime: block.startTime, present: 0, total: 0 });
    }
    const entry = blockMap.get(block.id)!;
    entry.total++;
    if (a.status === AttendanceStatus.PRESENT || a.status === AttendanceStatus.LATE) entry.present++;
  }

  const blockAttendance = Array.from(blockMap.entries())
    .map(([id, b]) => ({ id, level: b.level, startTime: b.startTime, rate: b.total > 0 ? Math.round((b.present / b.total) * 100) : 0, total: b.total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return {
    totalStudents,
    totalTeachers,
    activeLessons,
    overdueCount,
    recentEvents,
    attendanceStats: { presentCount, absentCount, lateCount, total: totalAtt, rate: attRate },
    blockAttendance,
    todayLessons,
    pendingEnrollments,
    lowBalanceStudents,
    cancelledSessions,
  };
}

router.get('/dashboard', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });
    const data = await dashboardStats(schoolId);
    res.json({ success: true, data });
  } catch (error) {
    log.error({ err: error }, 'dashboard stats failed');
    res.status(500).json({ success: false, error: 'Failed to fetch dashboard stats' });
  }
});

export default router;
