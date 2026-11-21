import { PrismaClient, Prisma } from '@prisma/client';
import prismaDefault from '../lib/prisma';
import { daysOverlap, timeRangesOverlap, dateRangesOverlap } from './scheduleValidation';

export interface Violation {
  check: string;
  count: number;
  ids: number[];
  severity: 'CRITICAL' | 'WARNING';
}

// totalCount: pass when ids are a LIMIT-ed sample of a larger violation set.
type FailFn = (check: string, ids: number[], severity?: 'CRITICAL' | 'WARNING', totalCount?: number) => void;

// Check 1: Attendance on INVALIDATED session
async function check1(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const rows = await prisma.attendance.findMany({
    where: { schoolId, lessonSession: { status: 'INVALIDATED' } },
    select: { id: true },
  });
  if (rows.length > 0)
    fail('Attendance on INVALIDATED session (ghost billing risk)', rows.map(r => r.id));
}

// Check 2: TeacherPaymentLesson linked to CANCELLED/INVALIDATED session
async function check2(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const rows = await prisma.teacherPaymentLesson.findMany({
    where: { lessonSession: { schoolId, status: { in: ['CANCELLED', 'INVALIDATED'] } } },
    select: { id: true },
  });
  if (rows.length > 0)
    fail('TeacherPaymentLesson linked to CANCELLED/INVALIDATED session (phantom salary)', rows.map(r => r.id));
}

// Check 3: Multiple TeacherPaymentLesson for same lessonSessionId
async function check3(prisma: PrismaClient, _schoolId: number, fail: FailFn) {
  const grouped = await prisma.teacherPaymentLesson.groupBy({
    by: ['lessonSessionId'],
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  });
  if (grouped.length > 0)
    fail('Duplicate TeacherPaymentLesson (double salary payment)', grouped.map(r => r.lessonSessionId));
}

// Check 4: creditDeducted = true without corresponding LessonCreditLog
// N+1 loop preserved for correctness — at scale, replace with NOT EXISTS subquery.
async function check4(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const deducted = await prisma.attendance.findMany({
    where: { schoolId, creditDeducted: true },
    select: { id: true, lessonSessionId: true, studentProfileId: true },
  });

  const missingLog: number[] = [];
  for (const a of deducted) {
    const entry = await prisma.lessonCreditLog.findFirst({
      where: { sessionId: a.lessonSessionId, studentProfileId: a.studentProfileId, amount: { lt: 0 } },
    });
    if (!entry) missingLog.push(a.id);
  }
  if (missingLog.length > 0)
    fail('creditDeducted=true without LessonCreditLog deduction (balance mismatch)', missingLog);
}

// Check 5: LessonCreditLog deduction (amount < 0) for CANCELLED session
async function check5(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const rows = await prisma.lessonCreditLog.findMany({
    where: { schoolId, amount: { lt: 0 }, session: { status: 'CANCELLED' } },
    select: { id: true },
  });
  if (rows.length > 0)
    fail('LessonCreditLog deduction for CANCELLED session (invalid charge)', rows.map(r => r.id));
}

// Check 6: UPCOMING SessionStudent where the student's membership in the session's
// OWN group is WITHDRAWN. Correlated per group: a withdrawal from group A must not
// flag the student's sessions in group B (the old `memberships: some` version did
// exactly that). count + LIMIT 20: never load every violating row into memory —
// load-test data produced 6.2M rows here.
// deletedAt IS NULL on both session and block: clear-all-data (settings.ts DELETE
// /clear-all-data) soft-deletes LessonSession/LessonBlock without touching `status`,
// so a wiped school's sessions stay status='UPCOMING' forever. Without this filter
// every soft-deleted session/block was misreported as a live ghost-attendee conflict
// — 66,836 false positives on one real dev school (see check9, which already filters
// this correctly for the same reason).
async function check6(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT ss.id
    FROM "SessionStudent" ss
    JOIN "LessonSession" ls ON ls.id = ss."lessonSessionId"
    JOIN "LessonBlock"   lb ON lb.id = ls."lessonBlockId"
    JOIN "GroupMembership" gm ON gm."studentGroupId" = lb."studentGroupId"
                             AND gm."studentProfileId" = ss."studentProfileId"
    WHERE ls.status = 'UPCOMING' AND ls."schoolId" = ${schoolId} AND gm.status = 'WITHDRAWN'
      AND ls."deletedAt" IS NULL AND lb."deletedAt" IS NULL
    LIMIT 20`;
  if (rows.length === 0) return;

  const [{ c }] = await prisma.$queryRaw<{ c: number }[]>`
    SELECT COUNT(*)::int AS c
    FROM "SessionStudent" ss
    JOIN "LessonSession" ls ON ls.id = ss."lessonSessionId"
    JOIN "LessonBlock"   lb ON lb.id = ls."lessonBlockId"
    JOIN "GroupMembership" gm ON gm."studentGroupId" = lb."studentGroupId"
                             AND gm."studentProfileId" = ss."studentProfileId"
    WHERE ls.status = 'UPCOMING' AND ls."schoolId" = ${schoolId} AND gm.status = 'WITHDRAWN'
      AND ls."deletedAt" IS NULL AND lb."deletedAt" IS NULL`;

  fail('UPCOMING SessionStudent for WITHDRAWN student (ghost attendee)', rows.map(r => r.id), 'WARNING', c);
}

// Check 7: LessonBlock with endDate < startDate (zombie block)
async function check7(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const blocks = await prisma.lessonBlock.findMany({
    where: { schoolId, deletedAt: null, endDate: { not: null } },
    select: { id: true, startDate: true, endDate: true },
  });
  const zombies = blocks.filter(b => b.endDate && b.startDate && b.endDate < b.startDate);
  if (zombies.length > 0)
    fail('LessonBlock with endDate < startDate (zombie block)', zombies.map(b => b.id));
}

// Check 8: School with no active SchoolSchedulePolicy (effectiveTo = null)
async function check8(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const active = await prisma.schoolSchedulePolicy.findFirst({
    where: { schoolId, effectiveTo: null },
  });
  if (!active)
    fail('School with no active SchoolSchedulePolicy (policy gap)', [schoolId], 'WARNING');
}

// Check 9: Active LessonSession whose parent LessonBlock is soft-deleted.
// Archived blocks may keep historical sessions for ERP audit; only active future
// sessions under an archived block are zombies.
async function check9(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const rows = await prisma.lessonSession.findMany({
    where: {
      schoolId,
      deletedAt: null,
      status: { in: ['UPCOMING', 'IN_PROGRESS'] },
      lessonBlock: { deletedAt: { not: null } },
    },
    select: { id: true },
  });
  if (rows.length > 0)
    fail('Active LessonSession with archived parent LessonBlock (zombie session)', rows.map(r => r.id));
}

// Check 10: TeacherPayment lessonsCount ≠ TeacherPaymentLesson count (denorm inconsistency)
// VOIDED payments are excluded: voiding intentionally removes the lesson links
// while keeping lessonsCount as a historical snapshot.
async function check10(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const payments = await prisma.teacherPayment.findMany({
    where: { schoolId, status: { not: 'VOIDED' } },
    select: { id: true, lessonsCount: true, _count: { select: { sessions: true } } },
  });
  const mismatched = payments.filter(p => p.lessonsCount !== p._count.sessions);
  if (mismatched.length > 0)
    fail('TeacherPayment lessonsCount ≠ TeacherPaymentLesson.count (denorm inconsistency)', mismatched.map(p => p.id), 'WARNING');
}

// Check 11: Teacher double-booking — same teacher in two overlapping active blocks
async function check11(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const blocks = await prisma.lessonBlock.findMany({
    where: { schoolId, deletedAt: null, teacherId: { not: null } },
    select: { id: true, teacherId: true, days: true, startTime: true, endTime: true, startDate: true, endDate: true },
  });

  const byTeacher = new Map<number, typeof blocks>();
  for (const b of blocks) {
    if (b.teacherId == null) continue;
    const arr = byTeacher.get(b.teacherId) ?? [];
    arr.push(b);
    byTeacher.set(b.teacherId, arr);
  }

  const conflictIds = new Set<number>();
  for (const [, tBlocks] of byTeacher) {
    for (let i = 0; i < tBlocks.length; i++) {
      for (let j = i + 1; j < tBlocks.length; j++) {
        const a = tBlocks[i], b = tBlocks[j];
        if (
          timeRangesOverlap(a.startTime, a.endTime, b.startTime, b.endTime) &&
          daysOverlap(a.days as number[], b.days as number[]) &&
          dateRangesOverlap(a.startDate, a.endDate, b.startDate, b.endDate)
        ) {
          conflictIds.add(a.id);
          conflictIds.add(b.id);
        }
      }
    }
  }

  if (conflictIds.size > 0)
    fail('Teacher double-booking: same teacher assigned to overlapping blocks simultaneously', [...conflictIds]);
}

// Check 13: Balance reconciliation — sum(LessonCreditLog.amount) must equal StudentProfile.credits.
// Full scan in id-ordered batches: a fixed take:500 sample left students 501+ permanently unchecked.
// Reports mismatch as WARNING (not CRITICAL) because legacy rows may predate the ledger.
async function check13(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const BATCH = 1000;
  const mismatched: number[] = [];
  let cursor = 0;

  for (;;) {
    const profiles = await prisma.studentProfile.findMany({
      where: { user: { schoolId }, deletedAt: null, id: { gt: cursor } },
      select: { id: true, credits: true },
      orderBy: { id: 'asc' },
      take: BATCH,
    });

    if (profiles.length === 0) break;
    cursor = profiles[profiles.length - 1].id;

    const profileIds = profiles.map(p => p.id);

    const aggregates = await prisma.lessonCreditLog.groupBy({
      by: ['studentProfileId'],
      where: { studentProfileId: { in: profileIds } },
      _sum: { amount: true },
    });

    const ledgerMap = new Map<number, number>();
    for (const agg of aggregates) {
      ledgerMap.set(agg.studentProfileId, agg._sum.amount ?? 0);
    }

    for (const p of profiles) {
      const ledgerBalance = ledgerMap.get(p.id) ?? 0;
      if (ledgerBalance !== p.credits) {
        mismatched.push(p.id);
      }
    }

    if (profiles.length < BATCH) break;
  }

  if (mismatched.length > 0) {
    fail(
      'StudentProfile.credits ≠ sum(LessonCreditLog.amount) — balance diverged from ledger',
      mismatched,
      'WARNING',
    );
  }
}

// Check 12: Grammar+Club same-group time overlap (student double-booking)
async function check12(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const blocks = await prisma.lessonBlock.findMany({
    where: { schoolId, deletedAt: null, studentGroupId: { not: null } },
    select: { id: true, studentGroupId: true, days: true, startTime: true, endTime: true, startDate: true, endDate: true },
  });

  const byGroup = new Map<number, typeof blocks>();
  for (const b of blocks) {
    if (b.studentGroupId == null) continue;
    const arr = byGroup.get(b.studentGroupId) ?? [];
    arr.push(b);
    byGroup.set(b.studentGroupId, arr);
  }

  const conflictIds = new Set<number>();
  for (const [, gBlocks] of byGroup) {
    for (let i = 0; i < gBlocks.length; i++) {
      for (let j = i + 1; j < gBlocks.length; j++) {
        const a = gBlocks[i], b = gBlocks[j];
        if (
          timeRangesOverlap(a.startTime, a.endTime, b.startTime, b.endTime) &&
          daysOverlap(a.days as number[], b.days as number[]) &&
          dateRangesOverlap(a.startDate, a.endDate, b.startDate, b.endDate)
        ) {
          conflictIds.add(a.id);
          conflictIds.add(b.id);
        }
      }
    }
  }

  if (conflictIds.size > 0)
    fail('Student double-booking: Grammar and Club of same group overlap in time/days', [...conflictIds], 'WARNING');
}

// Check 14: invoice.paidAmount must equal net paid:
// SUM(PaymentAllocation.amount WHERE payment.status=CONFIRMED)
// - SUM(PaymentRefundAllocation.amount WHERE refund.status=CONFIRMED)
// Sampled to 200 invoices per run. CRITICAL — a mismatch means the balance is wrong.
async function check14(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const invoices = await prisma.invoice.findMany({
    where:  { schoolId, status: { notIn: ['DRAFT', 'VOID'] } },
    select: { id: true, paidAmount: true },
    take:   200,
  });

  if (invoices.length === 0) return;

  const invoiceIds = invoices.map(i => i.id);

  const allocs = await prisma.paymentAllocation.findMany({
    where:  { invoiceId: { in: invoiceIds }, payment: { status: 'CONFIRMED' } },
    select: { invoiceId: true, amount: true },
  });

  const sumByInvoice = new Map<number, Prisma.Decimal>();
  for (const a of allocs) {
    const prev = sumByInvoice.get(a.invoiceId) ?? new Prisma.Decimal(0);
    sumByInvoice.set(a.invoiceId, prev.plus(a.amount));
  }

  const refundAllocs = await prisma.paymentRefundAllocation.findMany({
    where: {
      paymentAllocation: { invoiceId: { in: invoiceIds } },
      refund: { status: 'CONFIRMED' },
    },
    select: {
      amount: true,
      paymentAllocation: { select: { invoiceId: true } },
    },
  });

  for (const r of refundAllocs) {
    const invoiceId = r.paymentAllocation.invoiceId;
    const prev = sumByInvoice.get(invoiceId) ?? new Prisma.Decimal(0);
    sumByInvoice.set(invoiceId, prev.minus(r.amount));
  }

  const mismatched: number[] = [];
  for (const inv of invoices) {
    const expected = Prisma.Decimal.max(sumByInvoice.get(inv.id) ?? new Prisma.Decimal(0), new Prisma.Decimal(0));
    if (!new Prisma.Decimal(inv.paidAmount).eq(expected)) {
      mismatched.push(inv.id);
    }
  }

  if (mismatched.length > 0)
    fail('invoice.paidAmount ≠ SUM(confirmed allocations) — payment balance corrupted', mismatched);
}

// Check 15: invoice outstanding/status math must match source-of-truth flow:
// outstanding = max(totalAmount - (confirmed allocations - confirmed refunds), 0)
// There is no persisted outstandingAmount in Phase 7.4 v1; this check verifies
// status consistency and guards against overpaid/negative-outstanding states.
async function check15(prisma: PrismaClient, schoolId: number, fail: FailFn) {
  const invoices = await prisma.invoice.findMany({
    where: {
      schoolId,
      status: { notIn: ['DRAFT', 'VOID'] },
    },
    select: {
      id: true,
      status: true,
      totalAmount: true,
    },
    take: 200,
  });

  if (invoices.length === 0) return;

  const invoiceIds = invoices.map(i => i.id);
  const allocs = await prisma.paymentAllocation.findMany({
    where: { invoiceId: { in: invoiceIds }, payment: { status: 'CONFIRMED' } },
    select: { invoiceId: true, amount: true },
  });

  const netPaidByInvoice = new Map<number, Prisma.Decimal>();
  for (const a of allocs) {
    const prev = netPaidByInvoice.get(a.invoiceId) ?? new Prisma.Decimal(0);
    netPaidByInvoice.set(a.invoiceId, prev.plus(a.amount));
  }

  const refundAllocs = await prisma.paymentRefundAllocation.findMany({
    where: {
      paymentAllocation: { invoiceId: { in: invoiceIds } },
      refund: { status: 'CONFIRMED' },
    },
    select: {
      amount: true,
      paymentAllocation: { select: { invoiceId: true } },
    },
  });

  for (const r of refundAllocs) {
    const invoiceId = r.paymentAllocation.invoiceId;
    const prev = netPaidByInvoice.get(invoiceId) ?? new Prisma.Decimal(0);
    netPaidByInvoice.set(invoiceId, prev.minus(r.amount));
  }

  const negativeOutstandingRisk: number[] = [];
  const statusMismatch: number[] = [];

  for (const inv of invoices) {
    const netPaid = netPaidByInvoice.get(inv.id) ?? new Prisma.Decimal(0);
    const rawOutstanding = new Prisma.Decimal(inv.totalAmount).minus(netPaid);

    if (rawOutstanding.lt(new Prisma.Decimal(0))) {
      negativeOutstandingRisk.push(inv.id);
      continue;
    }

    if (inv.status === 'PAID' && rawOutstanding.gt(new Prisma.Decimal(0))) {
      statusMismatch.push(inv.id);
    } else if (inv.status === 'PARTIALLY_PAID' && (netPaid.lte(new Prisma.Decimal(0)) || rawOutstanding.lte(new Prisma.Decimal(0)))) {
      statusMismatch.push(inv.id);
    } else if (inv.status === 'ISSUED' && netPaid.gt(new Prisma.Decimal(0))) {
      statusMismatch.push(inv.id);
    }
  }

  if (negativeOutstandingRisk.length > 0) {
    fail('invoice net paid exceeds totalAmount — negative outstanding risk', negativeOutstandingRisk);
  }

  if (statusMismatch.length > 0) {
    fail('invoice status inconsistent with net-paid outstanding math', statusMismatch);
  }
}

export async function runChecks(
  schoolId: number,
  prismaClient?: PrismaClient
): Promise<Violation[]> {
  const prisma = (prismaClient ?? prismaDefault) as PrismaClient;
  const violations: Violation[] = [];

  const fail: FailFn = (check, ids, severity = 'CRITICAL', totalCount) => {
    violations.push({ check, count: totalCount ?? ids.length, ids: ids.slice(0, 20), severity });
  };

  await Promise.all([
    check1(prisma, schoolId, fail),
    check2(prisma, schoolId, fail),
    check3(prisma, schoolId, fail),
    check4(prisma, schoolId, fail),
    check5(prisma, schoolId, fail),
    check6(prisma, schoolId, fail),
    check7(prisma, schoolId, fail),
    check8(prisma, schoolId, fail),
    check9(prisma, schoolId, fail),
    check10(prisma, schoolId, fail),
    check11(prisma, schoolId, fail),
    check12(prisma, schoolId, fail),
    check13(prisma, schoolId, fail),
    check14(prisma, schoolId, fail),
    check15(prisma, schoolId, fail),
  ]);

  return violations;
}
