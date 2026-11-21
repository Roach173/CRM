import { Router } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { AdjType, ManualEntryType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { cacheInvalidate } from '../lib/cache';
import { dbIdempotency } from '../middleware/dbIdempotency';
import { requirePermission } from '../middleware/requirePermission';
import { logFinanceAction } from '../lib/auditLog';
import { createLogger } from '../lib/logger';
import {
  assertStaffBelongsToSchool,
  isTenantNotFound,
  isPrismaNotFound,
} from '../lib/tenant';
import {
  createTeacherCorrection,
  reverseTeacherPaymentLesson,
  type CorrectionActor,
} from '../services/salaryCorrectionService';

const log = createLogger('salary');

// Default per-lesson rate for a teacher with no rate configured (null salaryRate, no rate log).
// ponytail: global constant; move to School settings if schools ever need different defaults.
const DEFAULT_SALARY_RATE = 500;
const router = Router();

/** "2026-05" → { gte: 2026-05-01T00:00:00Z, lte: 2026-05-31T23:59:59.999Z } */
function monthRange(period: string) {
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { gte: start, lte: end };
}

/** Вычисляем дельту вручную добавленных/удалённых уроков */
function manualDelta(entries: { type: ManualEntryType; count: number }[]): number {
  return entries.reduce((sum, e) => sum + (e.type === ManualEntryType.ADD ? e.count : -e.count), 0);
}

/** Чистый итог корректировок месяца: BONUS прибавляется, FINE и ADVANCE вычитаются. */
export function monthAdjustmentNet(
  adjs: Array<{ type: AdjType; amount: Prisma.Decimal | number }>,
): number {
  return adjs.reduce((sum, a) => {
    const v = Number(a.amount);
    return a.type === AdjType.BONUS ? sum + v : sum - v;
  }, 0);
}

/** Корректировки, ФАКТИЧЕСКИ применённые прошлыми выплатами периода.
 *  Для выплаты p применённая часть = p.amount − p.lessonsCount × p.rateSnapshot —
 *  включая эффект clamp(amount ≥ 0): недоприменённый штраф автоматически
 *  переносится на следующую выплату. rateSnapshot каждой выплаты свой, поэтому
 *  смена ставки между выплатами не искажает расчёт. */
export function appliedAdjustmentNet(
  payments: Array<{ amount: Prisma.Decimal | number; lessonsCount: number; rateSnapshot: Prisma.Decimal | number }>,
): number {
  return payments.reduce(
    (sum, p) => sum + (Number(p.amount) - p.lessonsCount * Number(p.rateSnapshot)),
    0,
  );
}

/** Остаток корректировок к применению следующей выплатой периода.
 *  Инвариант: по всем выплатам периода суммарно применяется РОВНО monthAdjustmentNet —
 *  ни двойного вычета штрафа пересекающимися окнами дат, ни потерянных корректировок.
 *  (Раньше корректировки отбирались по окну дат оплачиваемых сессий — два частичных
 *  платежа с пересекающимися окнами применяли один штраф дважды.) */
export function remainingAdjustmentNet(
  adjs: Array<{ type: AdjType; amount: Prisma.Decimal | number }>,
  priorPayments: Array<{ amount: Prisma.Decimal | number; lessonsCount: number; rateSnapshot: Prisma.Decimal | number }>,
): number {
  return monthAdjustmentNet(adjs) - appliedAdjustmentNet(priorPayments);
}

/** Единый источник правды: урок оплачивается ТОЛЬКО если по нему есть хотя бы одна
 *  запись посещаемости И он не отменён/не аннулирован. Используется в подсчёте зарплаты,
 *  в гарде выплаты и в allPayableCount — чтобы определение «оплачиваемого урока»
 *  больше не разъехалось между местами (раньше счётчик брал status:'COMPLETED' без
 *  attendance, вопреки собственному комментарию и тесту). */
const PAYABLE_SESSION: Prisma.LessonSessionWhereInput = {
  status: { notIn: ['CANCELLED', 'INVALIDATED'] },
  attendances: { some: {} },
};

/** Считаем количество проведённых уроков учителем за месяц.
 *  Урок считается проведённым по правилу PAYABLE_SESSION и атрибутируется учителю,
 *  если он был заменой (teacherId) ИЛИ основным по снимку (teacherIdSnap).
 *
 *  teacherIdSnap — снимок учителя на момент создания сессии. Обновляется только
 *  для UPCOMING-сессий при смене учителя блока. Терминальные сессии сохраняют
 *  оригинальный снимок → зарплата корректна при любой смене учителя.
 */
export async function countLessonsForStaff(staffProfileId: number, schoolId: number, period: string): Promise<number> {
  const range = monthRange(period);
  const count = await prisma.lessonSession.count({
    where: {
      schoolId,
      ...PAYABLE_SESSION,
      date: range,
      OR: [
        { teacherId: staffProfileId },                      // замена (substitute override)
        { teacherIdSnap: staffProfileId, teacherId: null }, // основной учитель (по снимку)
      ]
    }
  });
  return count;
}

/** Возвращает ставку, действовавшую на начало периода.
 *  Ищет последнюю запись TeacherRateLog с effectiveFrom <= первого дня периода.
 *  Если истории нет — fallback на текущую salaryRate (backward compat).
 */
async function getRateForPeriod(staffProfileId: number, period: string): Promise<number> {
  const [year, month] = period.split('-').map(Number);
  const periodStart = new Date(Date.UTC(year, month - 1, 1));

  const rateLog = await prisma.teacherRateLog.findFirst({
    where: { staffProfileId, effectiveFrom: { lte: periodStart } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });

  if (rateLog) return Number(rateLog.rate);

  // No history yet — use current rate (teachers created before rate logging)
  const staff = await prisma.staffProfile.findUnique({
    where: { id: staffProfileId },
    select: { salaryRate: true },
  });
  return Number(staff?.salaryRate ?? DEFAULT_SALARY_RATE);
}

/** Группирует записи по staffProfileId — используется батч-версией GET / ниже,
 *  чтобы не делать по 5-6 запросов на каждого сотрудника (N+1). */
function groupByStaff<T extends { staffProfileId: number }>(items: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const arr = map.get(item.staffProfileId);
    if (arr) arr.push(item); else map.set(item.staffProfileId, [item]);
  }
  return map;
}

// ─── GET /?period=2026-05 — список сотрудников с расчётом зарплаты ─────────

router.get('/', authenticate, requirePermission('salary:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const period = (req.query.period as string) || new Date().toISOString().slice(0, 7);
    const range = monthRange(period);
    const [rateYear, rateMonth] = period.split('-').map(Number);
    const periodStart = new Date(Date.UTC(rateYear, rateMonth - 1, 1));

    const staffList = await prisma.staffProfile.findMany({
      where: { deletedAt: null, user: { schoolId, deletedAt: null } },
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phone: true } }
      }
    });
    const staffIds = staffList.map(s => s.id);

    // Batched in place of one round-trip per staff member (was ~6 queries × N staff).
    // Each query below is schoolId/period-scoped across ALL staff at once, then
    // grouped in memory — same math as calculateNet(), just computed together.
    const [rateLogs, payableSessions, manualEntries, adjustments, payments] = await Promise.all([
      prisma.teacherRateLog.findMany({
        where: { staffProfileId: { in: staffIds }, effectiveFrom: { lte: periodStart } },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.lessonSession.findMany({
        where: {
          schoolId,
          ...PAYABLE_SESSION,
          date: range,
          OR: [
            { teacherId: { in: staffIds } },
            { teacherIdSnap: { in: staffIds }, teacherId: null },
          ],
        },
        select: { teacherId: true, teacherIdSnap: true },
      }),
      prisma.manualLessonEntry.findMany({
        where: { staffProfileId: { in: staffIds }, schoolId, month: period },
        orderBy: { createdAt: 'asc' },
        include: { createdBy: { select: { firstName: true, lastName: true } } },
      }),
      prisma.salaryAdjustment.findMany({
        where: { staffProfileId: { in: staffIds }, schoolId, month: period },
        orderBy: { date: 'asc' },
        include: { createdBy: { select: { firstName: true, lastName: true } } },
      }),
      prisma.teacherPayment.findMany({
        where: { staffProfileId: { in: staffIds }, period },
        orderBy: { paidAt: 'desc' },
        include: {
          sessions: { select: { lessonSessionId: true } },
          createdBy: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);

    // First rateLog per staff wins (list is ordered effectiveFrom desc) — mirrors getRateForPeriod().
    const rateByStaff = new Map<number, number>();
    for (const rl of rateLogs) {
      if (!rateByStaff.has(rl.staffProfileId)) rateByStaff.set(rl.staffProfileId, Number(rl.rate));
    }
    // Each session's teacherId (substitute override) or teacherIdSnap (original teacher) is
    // mutually exclusive per row, so this attributes every session to exactly one staff member —
    // same rule as countLessonsForStaff()'s per-staff OR filter, just counted together.
    const lessonCountByStaff = new Map<number, number>();
    for (const s of payableSessions) {
      const staffId = s.teacherId ?? s.teacherIdSnap;
      if (staffId == null) continue;
      lessonCountByStaff.set(staffId, (lessonCountByStaff.get(staffId) ?? 0) + 1);
    }
    const manualByStaff = groupByStaff(manualEntries);
    const adjByStaff = groupByStaff(adjustments);
    const paymentsByStaff = groupByStaff(payments);

    const data = staffList.map(staff => {
      const rate = rateByStaff.get(staff.id) ?? Number(staff.salaryRate ?? DEFAULT_SALARY_RATE);
      const lessonsCount = lessonCountByStaff.get(staff.id) ?? 0;
      const staffManualEntries = manualByStaff.get(staff.id) ?? [];
      const delta = manualDelta(staffManualEntries);
      const effectiveLessons = Math.max(0, lessonsCount + delta);
      const gross = effectiveLessons * rate;

      const staffAdjustments = adjByStaff.get(staff.id) ?? [];
      const bonuses = staffAdjustments.filter(a => a.type === AdjType.BONUS).reduce((s, a) => s + Number(a.amount), 0);
      const fines = staffAdjustments.filter(a => a.type === AdjType.FINE).reduce((s, a) => s + Number(a.amount), 0);
      const advances = staffAdjustments.filter(a => a.type === AdjType.ADVANCE).reduce((s, a) => s + Number(a.amount), 0);
      const net = gross + bonuses - fines - advances;

      const calc = { lessonsCount, manualDelta: delta, effectiveLessons, rateSnapshot: rate, gross, bonuses, fines, advances, net };
      const staffPayments = paymentsByStaff.get(staff.id) ?? [];

      // Voided payments stay in the list as a visible trail; every money total
      // is computed from confirmed payments only (same model as income Payment).
      const confirmedPayments = staffPayments.filter(p => p.status !== 'VOIDED');

      const totalPaidAmount = confirmedPayments.reduce((s, p) => s + Number(p.amount), 0);
      const paidLessonsCount = confirmedPayments.reduce((s, p) => s + p.lessonsCount, 0);
      const unpaidLessonsCount = Math.max(0, calc.effectiveLessons - paidLessonsCount);
      // Остаток к выплате: непроплаченные уроки + НЕПРИМЕНЁННАЯ часть корректировок
      // (не весь месячный итог — прошлые выплаты уже применили свою долю).
      const monthNet = calc.bonuses - calc.fines - calc.advances;
      const remainingAmount = unpaidLessonsCount * calc.rateSnapshot + (monthNet - appliedAdjustmentNet(confirmedPayments));

      // Legacy compat fields for list page badge
      const latestPayment = confirmedPayments[0] ?? null;

      return {
        staffProfileId: staff.id,
        userId: staff.userId,
        name: `${staff.user.firstName} ${staff.user.lastName}`,
        email: staff.user.email,
        phone: staff.user.phone,
        salaryRate: Number(staff.salaryRate ?? DEFAULT_SALARY_RATE),
        ...calc,
        adjustments: staffAdjustments.map(a => ({
          id: a.id,
          type: a.type,
          amount: Number(a.amount),
          reason: a.reason,
          month: a.month,
          date: a.date.toISOString(),
          createdByName: a.createdBy
            ? `${a.createdBy.firstName} ${a.createdBy.lastName}`
            : null,
        })),
        manualEntries: staffManualEntries.map(e => ({
          id: e.id,
          type: e.type,
          label: e.label,
          count: e.count,
          createdAt: e.createdAt.toISOString(),
          createdByName: e.createdBy
            ? `${e.createdBy.firstName} ${e.createdBy.lastName}`
            : null,
        })),
        // Payment summary
        paidLessonsCount,
        unpaidLessonsCount,
        totalPaidAmount,
        remainingAmount,
        // Legacy: true only when all effective lessons are fully paid
        isPaid: calc.effectiveLessons > 0 && paidLessonsCount >= calc.effectiveLessons,
        paidAmount: totalPaidAmount,
        paymentId: latestPayment?.id ?? null,
        paidAt: latestPayment?.paidAt?.toISOString() ?? null,
        payments: staffPayments.map(p => ({
          id: p.id,
          lessonsCount: p.lessonsCount,
          amount: Number(p.amount),
          adjustmentNet: Number(p.adjustmentNet),
          paidAt: p.paidAt.toISOString(),
          status: p.status,
          note: p.note,
          voidReason: p.voidReason,
          voidedAt: p.voidedAt?.toISOString() ?? null,
          createdByName: p.createdBy
            ? `${p.createdBy.firstName} ${p.createdBy.lastName}`
            : null,
          sessionIds: p.sessions.map(s => s.lessonSessionId),
        })),
      };
    });

    res.json({ success: true, period, data });
  } catch (error) {
    log.error({ err: error }, 'GET /');
    res.status(500).json({ success: false, error: 'Failed to fetch salary data' });
  }
});

// ─── GET /my — зарплата учителя за текущий месяц (для самого учителя) ──────────

router.get('/my', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    const schoolId = req.user?.schoolId;
    if (!userId || !schoolId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const staff = await prisma.staffProfile.findUnique({
      where: { userId },
      select: { id: true }
    });
    if (!staff) {
      return res.status(404).json({ success: false, error: 'StaffProfile not found' });
    }

    const period = (req.query.period as string) || new Date().toISOString().slice(0, 7);

    const lessonsCount = await countLessonsForStaff(staff.id, schoolId, period);

    const manualEntries = await prisma.manualLessonEntry.findMany({
      where: { staffProfileId: staff.id, schoolId, month: period },
      select: { id: true, type: true, label: true, count: true, createdAt: true }
    });
    const delta = manualDelta(manualEntries);
    const effectiveLessons = Math.max(0, lessonsCount + delta);

    const rate = await getRateForPeriod(staff.id, period);
    const gross = effectiveLessons * rate;

    const adjustments = await prisma.salaryAdjustment.findMany({
      where: { staffProfileId: staff.id, schoolId, month: period },
      select: { id: true, type: true, amount: true }
    });

    const bonuses = adjustments.filter(a => a.type === AdjType.BONUS).reduce((s, a) => s + Number(a.amount), 0);
    const fines = adjustments.filter(a => a.type === AdjType.FINE).reduce((s, a) => s + Number(a.amount), 0);
    const advances = adjustments.filter(a => a.type === AdjType.ADVANCE).reduce((s, a) => s + Number(a.amount), 0);
    const net = gross + bonuses - fines - advances;

    const payment = await prisma.teacherPayment.findFirst({
      where: { staffProfileId: staff.id, period, status: { not: 'VOIDED' } },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      period,
      data: {
        salaryRate: rate,
        lessonsCount,
        manualDelta: delta,
        manualEntries: manualEntries.map(e => ({
          id: e.id,
          type: e.type,
          label: e.label,
          count: e.count,
        })),
        effectiveLessons,
        gross,
        fines,
        advances,
        bonuses,
        net,
        isPaid: !!payment,
        paidAmount: payment ? Number(payment.amount) : 0,
      }
    });
  } catch (error) {
    log.error({ err: error }, 'GET /my');
    res.status(500).json({ success: false, error: 'Failed to fetch your salary data' });
  }
});

// ─── GET /:staffProfileId/history — история выплат сотрудника ────────────────

router.get('/:staffProfileId/history', authenticate, requirePermission('salary:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const staffProfileId = parseInt(req.params.staffProfileId);

    // Verify staff belongs to this school before exposing their payment history
    await assertStaffBelongsToSchool(staffProfileId, schoolId);

    const payments = await prisma.teacherPayment.findMany({
      where: { staffProfileId, schoolId },
      orderBy: { paidAt: 'desc' },
      include: { createdBy: { select: { firstName: true, lastName: true } } }
    });

    res.json({ success: true, data: payments });
  } catch (error) {
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'GET /:id/history');
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
});

// ─── GET /user/:userId/full-history — полный аудит-лог (выплаты + корректировки + ручные записи) ───

router.get('/user/:userId/full-history', authenticate, requirePermission('salary:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const userId = parseInt(req.params.userId);

    const staffProfile = await prisma.staffProfile.findFirst({
      where: { userId },
      select: {
        id: true,
        salaryRate: true,
        position: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });

    if (!staffProfile) return res.status(404).json({ success: false, error: 'Not found' });

    const staffProfileId = staffProfile.id;

    await assertStaffBelongsToSchool(staffProfileId, schoolId);

    const [payments, adjustments, manualEntries] = await Promise.all([
      prisma.teacherPayment.findMany({
        where: { staffProfileId, schoolId },
        orderBy: { paidAt: 'desc' },
        include: { createdBy: { select: { firstName: true, lastName: true } } },
      }),
      prisma.salaryAdjustment.findMany({
        where: { staffProfileId, schoolId },
        orderBy: { date: 'desc' },
        include: { createdBy: { select: { firstName: true, lastName: true } } },
      }),
      prisma.manualLessonEntry.findMany({
        where: { staffProfileId, schoolId },
        orderBy: { createdAt: 'desc' },
        include: { createdBy: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    const staff = {
      id: staffProfile.id,
      name: `${staffProfile.user.firstName} ${staffProfile.user.lastName}`.trim(),
      position: staffProfile.position,
      salaryRate: staffProfile.salaryRate,
    };

    res.json({ success: true, data: { staff, payments, adjustments, manualEntries } });
  } catch (error) {
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'GET /user/:userId/full-history');
    res.status(500).json({ success: false, error: 'Failed to fetch full history' });
  }
});

// ─── PATCH /rate/:staffProfileId — изменить ставку учителя ────────────────────

router.patch('/rate/:staffProfileId', authenticate, requirePermission('salary:pay'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const staffProfileId = parseInt(req.params.staffProfileId);
    const { salaryRate } = req.body;

    if (salaryRate === undefined || isNaN(parseFloat(salaryRate))) {
      return res.status(400).json({ success: false, error: 'salaryRate обязателен' });
    }
    const rate = parseFloat(salaryRate);
    if (rate < 0) {
      return res.status(400).json({ success: false, error: 'Ставка не может быть отрицательной' });
    }

    // Атомарно: обновляем ставку + создаём запись истории.
    // TeacherRateLog — источник правды для getRateForPeriod().
    // Без этой записи смена ставки задним числом исказит расчёты текущего месяца.
    const updated = await prisma.$transaction(async (tx) => {
      // Verify ownership inside the transaction to prevent TOCTOU races
      await assertStaffBelongsToSchool(staffProfileId, schoolId, tx);

      const staff = await tx.staffProfile.update({
        where: { id: staffProfileId },
        data: { salaryRate: rate },
        select: { id: true, salaryRate: true },
      });
      await tx.teacherRateLog.create({
        data: {
          staffProfileId,
          rate,
          effectiveFrom: new Date(),
          changedById: req.user!.userId,
        },
      });
      return staff;
    });

    res.json({ success: true, data: { staffProfileId: updated.id, salaryRate: Number(updated.salaryRate) } });
  } catch (error) {
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'PATCH /rate/:id');
    res.status(500).json({ success: false, error: 'Failed to update rate' });
  }
});

// ─── POST /adjustment — добавить штраф/аванс/бонус ───────────────────────────

router.post('/adjustment', authenticate, requirePermission('salary:write'), dbIdempotency({ required: true }), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const { staffProfileId, type, amount, reason, month } = req.body;

    if (!staffProfileId || !type || !amount || !month) {
      return res.status(400).json({ success: false, error: 'staffProfileId, type, amount, month обязательны' });
    }

    if (!Object.values(AdjType).includes(type)) {
      return res.status(400).json({ success: false, error: 'Неверный тип: FINE | ADVANCE | BONUS' });
    }

    // Финансовая величина: только конечное положительное число в разумных пределах.
    // Отрицательный «бонус» = скрытый штраф в обход OWNER-права; NaN портит net.
    const adjAmount = Number(amount);
    if (!Number.isFinite(adjAmount) || adjAmount <= 0 || adjAmount > 10_000_000) {
      return res.status(400).json({ success: false, error: 'amount должен быть положительным числом до 10 000 000' });
    }

    // FINE and ADVANCE are financial operations — OWNER/SUPERADMIN only.
    // BONUS is operational and can be created by any salary:write holder (including ADMIN).
    if (type === AdjType.FINE || type === AdjType.ADVANCE) {
      const role = req.user!.role;
      if (role !== 'OWNER' && role !== 'SUPERADMIN') {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: FINE and ADVANCE adjustments require OWNER role',
          code: 'OWNER_REQUIRED',
        });
      }
    }

    await assertStaffBelongsToSchool(parseInt(staffProfileId), schoolId);

    // Block retroactive adjustments: if salary already paid for this period, reject
    const existingPayment = await prisma.teacherPayment.findFirst({
      where: { schoolId, staffProfileId: parseInt(staffProfileId), period: month, status: { not: 'VOIDED' } },
      select: { id: true },
    });
    if (existingPayment) {
      return res.status(409).json({
        success: false,
        error: `Salary for period "${month}" is already paid. Create a separate adjustment for the next period.`,
        code: 'PERIOD_ALREADY_PAID',
      });
    }

    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
    if (idempotencyKey) {
      const existing = await prisma.salaryAdjustment.findFirst({
        where: { schoolId, idempotencyKey }
      });
      if (existing) {
        const body = { success: true, data: existing };
        await req.completeIdempotency?.(200, body);
        return res.json(body);
      }
    }

    const adj = await prisma.salaryAdjustment.create({
      data: {
        schoolId,
        staffProfileId: parseInt(staffProfileId),
        type: type as AdjType,
        amount: adjAmount,
        reason: reason?.trim() || type,
        month,
        createdById: req.user?.userId ?? null,
        idempotencyKey: idempotencyKey ?? null,
      }
    });

    logFinanceAction({
      client: prisma,
      schoolId,
      userId: req.user!.userId,
      action: 'SALARY_ADJUSTMENT_CREATE',
      entityType: 'adjustment',
      entityId: adj.id,
      after: { type, amount: adjAmount, staffProfileId: parseInt(staffProfileId), month },
    }).catch(err => log.error({ err }, 'audit log failed'));

    const body = { success: true, data: adj };
    await req.completeIdempotency?.(200, body);
    res.json(body);
  } catch (error) {
    await req.failIdempotency?.();
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'POST /adjustment');
    res.status(500).json({ success: false, error: 'Failed to create adjustment' });
  }
});

// ─── DELETE /adjustment/:id — удалить корректировку ──────────────────────────
// FINE/ADVANCE deletions require OWNER — same as creation. BONUS: salary:write is enough.

router.delete('/adjustment/:id', authenticate, requirePermission('salary:write'), async (req: AuthRequest, res) => {
  try {
    const adjId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;

    const adj = await prisma.salaryAdjustment.findFirst({ where: { id: adjId, schoolId } });
    if (!adj) return res.status(404).json({ success: false, error: 'Not found' });

    if (adj.type === AdjType.FINE || adj.type === AdjType.ADVANCE) {
      const role = req.user!.role;
      if (role !== 'OWNER' && role !== 'SUPERADMIN') {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: deleting FINE/ADVANCE adjustments requires OWNER role',
          code: 'OWNER_REQUIRED',
        });
      }
    }

    // Зеркально гарду создания (PERIOD_ALREADY_PAID): корректировку, уже применённую
    // выплатой этого периода, удалять нельзя — иначе применённый итог (adjustmentNet
    // выплат) перестаёт сходиться с корректировками месяца.
    const paidInPeriod = await prisma.teacherPayment.findFirst({
      where: { schoolId, staffProfileId: adj.staffProfileId, period: adj.month, status: { not: 'VOIDED' } },
      select: { id: true },
    });
    if (paidInPeriod) {
      return res.status(409).json({
        success: false,
        error: `Salary for period "${adj.month}" is already paid — the adjustment was applied and cannot be deleted.`,
        code: 'PERIOD_ALREADY_PAID',
      });
    }

    await prisma.salaryAdjustment.delete({ where: { id: adjId } });

    logFinanceAction({
      client: prisma,
      schoolId,
      userId: req.user!.userId,
      action: 'SALARY_ADJUSTMENT_DELETE',
      entityType: 'adjustment',
      entityId: adjId,
      before: { type: adj.type, amount: Number(adj.amount), staffProfileId: adj.staffProfileId, month: adj.month },
    }).catch(err => log.error({ err }, 'audit log failed'));

    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'DELETE /adjustment/:id');
    res.status(500).json({ success: false, error: 'Failed to delete adjustment' });
  }
});

// ─── POST /manual-entry — добавить ручную запись об уроках ─────────────────────

router.post('/manual-entry', authenticate, requirePermission('salary:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const { staffProfileId, month, type, label, count } = req.body;

    if (!staffProfileId || !month || !type || !label || !count) {
      return res.status(400).json({ success: false, error: 'staffProfileId, month, type, label, count обязательны' });
    }
    if (!Object.values(ManualEntryType).includes(type)) {
      return res.status(400).json({ success: false, error: 'type должен быть ADD или REMOVE' });
    }
    const parsedCount = parseInt(count);
    if (isNaN(parsedCount) || parsedCount <= 0) {
      return res.status(400).json({ success: false, error: 'count должен быть положительным числом' });
    }

    await assertStaffBelongsToSchool(parseInt(staffProfileId), schoolId);

    const entry = await prisma.manualLessonEntry.create({
      data: {
        schoolId,
        staffProfileId: parseInt(staffProfileId),
        month,
        type: type as ManualEntryType,
        label: label.trim(),
        count: parsedCount,
        createdById: req.user?.userId ?? null,
      },
      include: {
        createdBy: { select: { firstName: true, lastName: true } }
      }
    });

    res.json({ success: true, data: {
      ...entry,
      createdByName: entry.createdBy
        ? `${entry.createdBy.firstName} ${entry.createdBy.lastName}`
        : null,
    }});
  } catch (error) {
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'POST /manual-entry');
    res.status(500).json({ success: false, error: 'Failed to create manual entry' });
  }
});

// ─── DELETE /manual-entry/:id — удалить ручную запись об уроках ────────────────

router.delete('/manual-entry/:id', authenticate, requirePermission('salary:write'), async (req: AuthRequest, res) => {
  try {
    const entryId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;

    // Verify entry belongs to this school — prevents cross-tenant delete
    const entry = await prisma.manualLessonEntry.findFirst({ where: { id: entryId, schoolId } });
    if (!entry) return res.status(404).json({ success: false, error: 'Not found' });

    await prisma.manualLessonEntry.delete({ where: { id: entryId } });
    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'DELETE /manual-entry/:id');
    res.status(500).json({ success: false, error: 'Failed to delete manual entry' });
  }
});

// ─── POST /pay/:staffProfileId — выплатить за конкретные уроки ──────────────

router.post('/pay/:staffProfileId', authenticate, requirePermission('salary:pay'), dbIdempotency({ required: true }), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const staffProfileId = parseInt(req.params.staffProfileId);
    const { period, sessionIds, note } = req.body as {
      period: string;
      sessionIds: number[];
      note?: string;
    };

    if (!period) return res.status(400).json({ success: false, error: 'period обязателен (2026-05)' });
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Выберите хотя бы один урок' });
    }

    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim();

    // Проверяем что сессии принадлежат этой школе и учителю
    const staff = await prisma.staffProfile.findFirst({
      where: { id: staffProfileId, user: { schoolId } }
    });
    if (!staff) return res.status(404).json({ success: false, error: 'Преподаватель не найден' });

    // Проверяем что все сессии принадлежат школе и данному учителю
    const sessions = await prisma.lessonSession.findMany({
      where: {
        id: { in: sessionIds },
        schoolId,
        OR: [
          { teacherId: staffProfileId },
          { teacherIdSnap: staffProfileId, teacherId: null },
        ],
      },
      select: {
        id: true,
        date: true,
        status: true,
        attendances: { select: { id: true }, take: 1 },
        lessonBlock: { select: { studentGroup: { select: { status: true, deletedAt: true } } } },
      },
    });
    if (sessions.length !== sessionIds.length) {
      return res.status(400).json({
        success: false,
        error: `Одна или несколько сессий не найдены или не принадлежат этому преподавателю`,
      });
    }
    const paused = sessions.filter(s => s.lessonBlock.studentGroup?.status === 'PAUSED' && !s.lessonBlock.studentGroup.deletedAt);
    if (paused.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Нельзя провести выплату по урокам группы на паузе. Некорректных: ${paused.length}`,
      });
    }
    const invalid = sessions.filter(s => s.status === 'CANCELLED' || s.status === 'INVALIDATED' || s.attendances.length === 0);
    if (invalid.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Оплатить можно только проведённые уроки с отмеченной посещаемостью. Некорректных: ${invalid.length}`,
      });
    }

    // Business uniqueness guard: if any session is already paid under a DIFFERENT key, reject.
    // Same-key replay is NOT handled by dbIdempotency on the stale-reclaim path — the
    // middleware reclaims the key and calls next(), so we must detect the replay here.
    const alreadyPaid = await prisma.teacherPaymentLesson.findFirst({
      where: {
        lessonSessionId: { in: sessionIds },
        payment: { schoolId },
      },
      include: { payment: { select: { idempotencyKey: true } } },
    });
    if (alreadyPaid) {
      const sameKey = idempotencyKey && alreadyPaid.payment.idempotencyKey === idempotencyKey;
      if (!sameKey) {
        return res.status(409).json({
          success: false,
          error: 'Одна или несколько сессий уже включены в другую выплату',
          code: 'SESSIONS_ALREADY_PAID',
        });
      }
      // Same key → stale-reclaim replay; fall through to transaction which returns cached data
    }

    const rate = await getRateForPeriod(staffProfileId, period);
    const lessonsAmount = sessionIds.length * rate;

    // Adjustments are computed INSIDE the transaction so a concurrent payment
    // cannot change the applied-net baseline between the read and the write.
    // Idempotency check is also inside the tx so the check+write is atomic (prevents race).
    const result = await prisma.$transaction(async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.teacherPayment.findFirst({
          where: { schoolId, idempotencyKey },
          include: { sessions: { select: { lessonSessionId: true } } },
        });
        if (existing) return { payment: existing, replay: true as const };
      }

      // Корректировки: применяем ОСТАТОК месяца (итог месяца минус уже применённое
      // прошлыми выплатами) — см. remainingAdjustmentNet. Оба запроса внутри tx,
      // конкурентная выплата не может применить один штраф дважды: unique-констрейнт
      // TeacherPaymentLesson.lessonSessionId сериализует выплаты по одним сессиям,
      // а idempotency-check выше отсекает реплеи.
      const [adjs, priorPayments] = await Promise.all([
        tx.salaryAdjustment.findMany({
          where: { staffProfileId, schoolId, month: period },
          select: { type: true, amount: true },
        }),
        tx.teacherPayment.findMany({
          // VOIDED payments never applied anything durable — their adjustment
          // share returns to the remaining pool for the next payout.
          where: { staffProfileId, schoolId, period, status: { not: 'VOIDED' } },
          select: { amount: true, lessonsCount: true, rateSnapshot: true },
        }),
      ]);
      const adjustmentNet = remainingAdjustmentNet(adjs, priorPayments);

      const amount = Math.max(0, lessonsAmount + adjustmentNet);

      const p = await tx.teacherPayment.create({
        data: {
          schoolId,
          staffProfileId,
          period,
          lessonsCount: sessionIds.length,
          rateSnapshot: rate,
          amount,
          adjustmentNet,
          note: note?.trim() || null,
          createdById: req.user?.userId ?? null,
          idempotencyKey: idempotencyKey ?? null,
        }
      });
      await tx.teacherPaymentLesson.createMany({
        data: sessionIds.map(sid => ({ paymentId: p.id, lessonSessionId: sid }))
      });
      return { payment: p, replay: false as const };
    });

    const { payment, replay } = result;

    // Инвалидируем Redis-кэш календаря для этого учителя (skip on replay — cache already invalid)
    if (!replay) {
      const [year, month] = period.split('-').map(Number);
      await cacheInvalidate(`teacher-cal:${schoolId}:${staff.userId}:${year}:${month}`);

      // Audit trail — salary payouts are financial events
      logFinanceAction({
        client: prisma,
        schoolId,
        userId: req.user!.userId,
        action: 'SALARY_PAY',
        entityType: 'payment',
        entityId: payment.id,
        after: { staffProfileId, period, lessonsCount: sessionIds.length, amount: Number(payment.amount), rateSnapshot: rate },
      }).catch(err => log.error({ err }, 'audit log failed'));
    }

    const body = { success: true, data: { ...payment, amount: Number(payment.amount) } };
    await req.completeIdempotency?.(200, body);
    res.json(body);
  } catch (error) {
    await req.failIdempotency?.();
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({
        success: false,
        error: 'Одна или несколько сессий уже включены в другую выплату (конкурентный запрос)',
        code: 'SESSIONS_ALREADY_PAID',
      });
    }
    log.error({ err: error }, 'POST /pay/:id');
    res.status(500).json({ success: false, error: 'Failed to process payment' });
  }
});

// ─── DELETE /pay/:paymentId — аннулировать выплату (только OWNER — salary:pay) ─
// Void, not delete: the record stays with status VOIDED (who/when/why) as a
// visible trail — same model as income Payment. TeacherPaymentLesson links are
// removed so the sessions become payable again.
// salary:pay is OWNER-only — ADMIN cannot reach this endpoint (403 from requirePermission).

router.delete('/pay/:paymentId', authenticate, requirePermission('salary:pay'), async (req: AuthRequest, res) => {
  try {
    const paymentId = parseInt(req.params.paymentId);
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const { reason } = req.body as { reason?: string };
    if (!reason?.trim()) {
      return res.status(400).json({ success: false, error: 'reason обязателен для отмены выплаты' });
    }

    // Атомарно: ownership check + void в одной транзакции → нет окна inconsistency
    const paymentRecord = await prisma.$transaction(async (tx) => {
      const p = await tx.teacherPayment.findFirst({
        where: { id: paymentId, schoolId },
        select: {
          staffProfileId: true,
          period: true,
          schoolId: true,
          amount: true,
          lessonsCount: true,
          status: true,
          staffProfile: { select: { userId: true } },
        },
      });
      if (!p) throw Object.assign(new Error('Payment not found'), { status: 404 });
      if (p.status === 'VOIDED') throw Object.assign(new Error('Payment already voided'), { status: 409 });
      await tx.teacherPaymentLesson.deleteMany({ where: { paymentId } });
      await tx.teacherPayment.update({
        where: { id: paymentId },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedById: req.user!.userId,
          voidReason: reason.trim(),
        },
      });
      return p;
    });

    // Audit trail — voiding a financial record must be traceable
    logFinanceAction({
      client: prisma,
      schoolId,
      userId: req.user!.userId,
      action: 'SALARY_PAYMENT_VOIDED',
      entityType: 'payment',
      entityId: paymentId,
      before: {
        staffProfileId: paymentRecord.staffProfileId,
        period: paymentRecord.period,
        amount: Number(paymentRecord.amount),
        lessonsCount: paymentRecord.lessonsCount,
      },
      after: { reason: reason.trim() },
    }).catch(err => log.error({ err }, 'audit log failed'));

    // Cache invalidation — только после успешного коммита транзакции
    const [year, month] = paymentRecord.period.split('-').map(Number);
    await cacheInvalidate(`teacher-cal:${paymentRecord.schoolId}:${paymentRecord.staffProfile.userId}:${year}:${month}`);

    res.json({ success: true });
  } catch (error) {
    const e = error as any;
    if (e?.status === 404) return res.status(404).json({ success: false, error: 'Payment not found' });
    if (e?.status === 409) return res.status(409).json({ success: false, error: 'Выплата уже аннулирована' });
    log.error({ err: error }, 'DELETE /pay/:id');
    res.status(500).json({ success: false, error: 'Failed to cancel payment' });
  }
});

// ─── PATCH /pay/:paymentId/note — комментарий к выплате ──────────────────────
// Note is display-only metadata (no financial impact) — plain update, no
// transaction. Allowed on any status (annotating a voided payout is valid).

router.patch('/pay/:paymentId/note', authenticate, requirePermission('salary:write'), async (req: AuthRequest, res) => {
  try {
    const paymentId = parseInt(req.params.paymentId);
    const schoolId = req.user!.schoolId!;
    const raw = req.body?.note;

    if (raw != null && typeof raw !== 'string') {
      return res.status(400).json({ success: false, error: 'note must be a string or null' });
    }
    const note = raw?.trim() ? raw.trim().slice(0, 500) : null;

    const { count } = await prisma.teacherPayment.updateMany({ where: { id: paymentId, schoolId }, data: { note } });
    if (count === 0) return res.status(404).json({ success: false, error: 'Payment not found' });
    res.json({ success: true, data: { id: paymentId, note } });
  } catch (error) {
    log.error({ err: error }, 'PATCH /pay/:id/note');
    res.status(500).json({ success: false, error: 'Failed to update note' });
  }
});

// ─── GET /history/:staffProfileId — история выплат преподавателя ─────────────

router.get('/history/:staffProfileId', authenticate, requirePermission('salary:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ success: false, error: 'No school' });

    const staffProfileId = parseInt(req.params.staffProfileId);

    await assertStaffBelongsToSchool(staffProfileId, schoolId);

    const payments = await prisma.teacherPayment.findMany({
      where: { staffProfileId, schoolId },
      orderBy: { paidAt: 'desc' },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
        sessions: { select: { lessonSessionId: true } }
      }
    });

    res.json({
      success: true,
      data: payments.map(p => ({
        id: p.id,
        period: p.period,
        lessonsCount: p.lessonsCount,
        rateSnapshot: Number(p.rateSnapshot),
        amount: Number(p.amount),
        adjustmentNet: Number(p.adjustmentNet),
        paidAt: p.paidAt.toISOString(),
        note: p.note,
        status: p.status,
        voidReason: p.voidReason,
        voidedAt: p.voidedAt?.toISOString() ?? null,
        createdByName: p.createdBy
          ? `${p.createdBy.firstName} ${p.createdBy.lastName}`
          : null,
        sessionIds: p.sessions.map(s => s.lessonSessionId),
      }))
    });
  } catch (error) {
    if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
    log.error({ err: error }, 'GET /history/:id');
    res.status(500).json({ success: false, error: 'Failed to fetch payment history' });
  }
});

// ─── POST /corrections — salary correction flow (OWNER/SUPERADMIN only) ────────
// PR 9: Controlled correction for salary records attributed to the wrong teacher
// or to sessions that were subsequently invalidated.
//
// Two correction types:
//   TEACHER_REPLACEMENT — session was paid to wrong teacher
//   INVALIDATED_SESSION — session was paid but later invalidated
//
// Does NOT delete TeacherPayment or TeacherPaymentLesson.
// Adjustments are made via ManualLessonEntry (ADD/REMOVE) with machine-parseable
// labels so that reconciliation can detect whether a correction exists.
//
// Idempotency-Key is required. Reason ≥ 5 chars.
// Auth: salary:pay (OWNER only per requirePermission)

router.post(
  '/corrections',
  authenticate,
  requirePermission('salary:pay'),
  dbIdempotency({ required: true }),
  async (req: AuthRequest, res) => {
    try {
      const schoolId = req.user!.schoolId!;

      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
      if (idempotencyKey) {
        const existing = await prisma.manualLessonEntry.findFirst({
          where: {
            schoolId,
            OR: [
              { idempotencyKey },
              { idempotencyKey: `${idempotencyKey}:remove` }
            ]
          }
        });
        if (existing) {
          const allEntries = await prisma.manualLessonEntry.findMany({
            where: {
              schoolId,
              OR: [
                { idempotencyKey },
                { idempotencyKey: `${idempotencyKey}:remove` },
                { idempotencyKey: `${idempotencyKey}:add` }
              ]
            }
          });
          let sessionId = 0;
          let correctionType: 'TEACHER_REPLACEMENT' | 'INVALIDATED_SESSION' = 'INVALIDATED_SESSION';
          if (allEntries.length > 0) {
            const match = allEntries[0].label.match(/SALARY_CORRECTION:session:(\d+):/);
            if (match) {
              sessionId = parseInt(match[1], 10);
            }
            if (allEntries.some(e => e.label.endsWith(':added'))) {
              correctionType = 'TEACHER_REPLACEMENT';
            }
          }
          const body = {
            success: true,
            data: {
              correctionType,
              sessionId,
              period: allEntries[0]?.month,
              entries: allEntries.map(e => ({
                id: e.id,
                staffProfileId: e.staffProfileId,
                type: e.type,
                label: e.label,
                count: e.count
              }))
            }
          };
          await req.completeIdempotency?.(200, body);
          return res.json(body);
        }
      }

      const {
        correctionType,
        sessionId,
        reason,
        oldStaffProfileId,
        newStaffProfileId,
        paymentLessonId,
      } = req.body as {
        correctionType: string;
        sessionId?: number;
        reason?: string;
        oldStaffProfileId?: number;
        newStaffProfileId?: number;
        paymentLessonId?: number;
      };

      if (!correctionType) {
        return res.status(400).json({ success: false, error: 'correctionType is required: TEACHER_REPLACEMENT | INVALIDATED_SESSION' });
      }

      const actor: CorrectionActor = {
        userId:  req.user!.userId,
        role:    req.user!.role,
        schoolId,
      };

      let result;

      if (correctionType === 'TEACHER_REPLACEMENT') {
        if (!sessionId || !oldStaffProfileId || !newStaffProfileId || !reason) {
          return res.status(400).json({
            success: false,
            error: 'TEACHER_REPLACEMENT requires: sessionId, oldStaffProfileId, newStaffProfileId, reason',
          });
        }
        // Derive period from the TeacherPaymentLesson for the session
        const paymentLink = await prisma.teacherPaymentLesson.findFirst({
          where: { lessonSessionId: sessionId, payment: { schoolId } },
          include: { payment: { select: { period: true } } },
        });
        if (!paymentLink) {
          return res.status(404).json({ success: false, error: 'No salary payment found for this session' });
        }

        result = await createTeacherCorrection({
          sessionId,
          schoolId,
          actor,
          oldStaffProfileId,
          newStaffProfileId,
          period: paymentLink.payment.period,
          reason,
          idempotencyKey,
        });

      } else if (correctionType === 'INVALIDATED_SESSION') {
        if (!paymentLessonId || !reason) {
          return res.status(400).json({
            success: false,
            error: 'INVALIDATED_SESSION requires: paymentLessonId, reason',
          });
        }

        result = await reverseTeacherPaymentLesson({
          paymentLessonId,
          schoolId,
          actor,
          reason,
          idempotencyKey,
        });

      } else {
        return res.status(400).json({
          success: false,
          error: `Unknown correctionType: ${correctionType}. Valid values: TEACHER_REPLACEMENT | INVALIDATED_SESSION`,
        });
      }

      const body = { success: true, data: result };
      await req.completeIdempotency?.(200, body);
      res.json(body);
    } catch (error: any) {
      await req.failIdempotency?.();
      if (error?.httpStatus === 400) return res.status(400).json({ success: false, error: error.message });
      if (error?.httpStatus === 403) return res.status(403).json({ success: false, error: error.message });
      if (error?.httpStatus === 404) return res.status(404).json({ success: false, error: error.message });
      if (error?.httpStatus === 409) return res.status(409).json({ success: false, error: error.message, details: error.details });
      if (isTenantNotFound(error)) return res.status(404).json({ success: false, error: 'Not found' });
      log.error({ err: error }, 'POST /corrections');
      res.status(500).json({ success: false, error: 'Failed to apply salary correction' });
    }
  },
);

export default router;
