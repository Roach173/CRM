import { Prisma, PrismaClient, BillingMode, MemberStatus, SessionStatus } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';

/**
 * paidUntilDerivation
 * ───────────────────
 * BALANCE (StudentProfile.credits) is the single source of truth for payment
 * status. `StudentProfile.paidUntil` is a DERIVED, display-only calendar date
 * recomputed from the balance on every balance-changing event (payments,
 * credit top-ups, void/refund, billing-mode toggle, backfill).
 *
 * Overdue is defined identically in BOTH billing modes:
 *     isOverdue = !isFrozen && credits <= 0
 * so the server filter (students.ts) and the client (Students.tsx) always agree.
 *
 * `billingMode` only changes HOW the display date is projected from the balance:
 *   - PER_LESSON     → date the credits run out, walking the real upcoming
 *                      schedule (1 credit = 1 lesson). Falls back to weekly
 *                      cadence when the schedule is unknown/exhausted.
 *   - CALENDAR_MONTH → today + (credits * pricePerLesson / basePrice) months.
 *
 * All money math uses Prisma.Decimal; conversion to whole days/months happens
 * only at the final step. Dates are anchored at UTC noon, matching the
 * LessonSession date sentinel convention (see tzUtils.ts).
 */

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const DEFAULT_BASE_PRICE = new Prisma.Decimal(5000);
const DEFAULT_PRICE_PER_LESSON = 193;

export interface DeriveStatusInput {
  credits: number;
  isFrozen: boolean;
  billingMode: BillingMode;
  basePrice: Prisma.Decimal;
  pricePerLesson: number;
  /** Today anchored at UTC noon, in the school's timezone. */
  todayNoon: Date;
  /** Upcoming UPCOMING session dates (UTC noon), ascending, date >= today. PER_LESSON only. */
  upcomingSessionDates: Date[];
  /** Lessons per week summed across the student's active blocks. 0 if unknown. */
  lessonsPerWeek: number;
}

export interface DeriveStatusResult {
  paidUntil: Date | null;
  isOverdue: boolean;
}

function addDaysNoon(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function daysInMonthOf(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Adds a fractional number of months to a UTC-noon date. Integer part via
 *  calendar-month arithmetic; fractional remainder rounded to whole days of
 *  the resulting target month. */
function addMonthsFractional(base: Date, months: number): Date {
  const whole = Math.floor(months);
  const frac = months - whole;
  const d = new Date(base);
  d.setUTCMonth(d.getUTCMonth() + whole);
  if (frac > 0) {
    const extraDays = Math.round(frac * daysInMonthOf(d));
    d.setUTCDate(d.getUTCDate() + extraDays);
  }
  return d;
}

/**
 * Pure derivation — no DB access, fully unit-testable.
 */
export function deriveStatus(input: DeriveStatusInput): DeriveStatusResult {
  const { credits, isFrozen, billingMode, basePrice, pricePerLesson, todayNoon, upcomingSessionDates, lessonsPerWeek } = input;

  const isOverdue = !isFrozen && credits <= 0;

  // Zero / negative balance: nothing is paid ahead. Display date = today.
  if (credits <= 0) {
    return { paidUntil: todayNoon, isOverdue };
  }

  if (billingMode === BillingMode.CALENDAR_MONTH) {
    const base = basePrice.gt(0) ? basePrice : DEFAULT_BASE_PRICE;
    const ppl = pricePerLesson > 0 ? pricePerLesson : DEFAULT_PRICE_PER_LESSON;
    // months = (credits * pricePerLesson) / basePrice
    const months = new Prisma.Decimal(credits).mul(ppl).div(base).toNumber();
    return { paidUntil: addMonthsFractional(todayNoon, months), isOverdue };
  }

  // PER_LESSON: walk the real upcoming schedule, one credit per session.
  if (credits <= upcomingSessionDates.length) {
    // The credits-th upcoming session is the last paid lesson.
    return { paidUntil: upcomingSessionDates[credits - 1], isOverdue };
  }

  // Credits exceed the known horizon → extrapolate by weekly cadence.
  const remaining = credits - upcomingSessionDates.length;
  if (lessonsPerWeek > 0) {
    const anchor = upcomingSessionDates.length > 0
      ? upcomingSessionDates[upcomingSessionDates.length - 1]
      : todayNoon;
    const extraDays = Math.ceil(remaining / lessonsPerWeek) * 7;
    return { paidUntil: addDaysNoon(anchor, extraDays), isOverdue };
  }

  // No schedule at all: cannot project a calendar date. Status still driven by credits.
  if (upcomingSessionDates.length > 0) {
    return { paidUntil: upcomingSessionDates[upcomingSessionDates.length - 1], isOverdue };
  }
  return { paidUntil: null, isOverdue };
}

/** Today anchored at UTC noon, computed in the school's timezone. */
export function todayNoonInTz(tz: string): Date {
  const todayStr = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
  return new Date(`${todayStr}T12:00:00.000Z`);
}

/**
 * Loads everything needed inside the given transaction, derives the status, and
 * persists the derived `paidUntil`. Call at the end of any balance-changing
 * transaction (after credits are final). Pure read+write on StudentProfile —
 * does not touch idempotency keys, creditDeducted flags, or CreditIssuance.
 */
export async function recomputeAndPersistPaidUntil(
  tx: PrismaTx,
  studentProfileId: number,
  schoolId: number,
  opts: { persist?: boolean } = {},
): Promise<DeriveStatusResult> {
  const persist = opts.persist ?? true;
  const profile = await tx.studentProfile.findFirst({
    where: { id: studentProfileId, user: { schoolId } },
    select: { id: true, credits: true, isFrozen: true, user: { select: { school: { select: { timezone: true } } } } },
  });
  if (!profile) return { paidUntil: null, isOverdue: false };

  const config = await tx.schoolFinanceConfig.findUnique({
    where: { schoolId },
    select: { billingMode: true, basePrice: true, pricePerLesson: true },
  });

  const billingMode = config?.billingMode ?? BillingMode.PER_LESSON;
  const basePrice = config ? new Prisma.Decimal(config.basePrice) : DEFAULT_BASE_PRICE;
  const pricePerLesson = config?.pricePerLesson ?? DEFAULT_PRICE_PER_LESSON;
  const tz = profile.user?.school?.timezone ?? 'UTC';
  const todayNoon = todayNoonInTz(tz);

  let upcomingSessionDates: Date[] = [];
  let lessonsPerWeek = 0;

  // Schedule projection is only needed in PER_LESSON mode with positive credits.
  if (billingMode === BillingMode.PER_LESSON && profile.credits > 0) {
    const [sessions, blocks] = await Promise.all([
      tx.lessonSession.findMany({
        where: {
          schoolId,
          deletedAt: null,
          status: SessionStatus.UPCOMING,
          date: { gte: todayNoon },
          lessonBlock: {
            deletedAt: null,
            studentGroup: {
              memberships: { some: { studentProfileId, status: MemberStatus.ACTIVE, leftAt: null } },
            },
          },
        },
        select: { date: true },
        orderBy: { date: 'asc' },
        take: 400,
      }),
      tx.lessonBlock.findMany({
        where: {
          schoolId,
          deletedAt: null,
          studentGroup: {
            memberships: { some: { studentProfileId, status: MemberStatus.ACTIVE, leftAt: null } },
          },
        },
        select: { days: true },
      }),
    ]);
    upcomingSessionDates = sessions.map((s) => s.date);
    lessonsPerWeek = blocks.reduce((sum, b) => sum + (b.days?.length ?? 0), 0);
  }

  const result = deriveStatus({
    credits: profile.credits,
    isFrozen: profile.isFrozen,
    billingMode,
    basePrice,
    pricePerLesson,
    todayNoon,
    upcomingSessionDates,
    lessonsPerWeek,
  });

  if (persist) {
    await tx.studentProfile.update({
      where: { id: studentProfileId },
      data: { paidUntil: result.paidUntil },
    });
  }

  return result;
}

/**
 * Recomputes the derived `paidUntil` for every (non-deleted) student in a
 * school, in id-cursor batches so it scales to 50k+ students. Reused by the
 * backfill script and by the settings PATCH /finance handler when billingMode
 * changes (the projection formula changes, so dates must be re-derived).
 */
export async function recomputePaidUntilForSchool(
  prisma: PrismaClient,
  schoolId: number,
  opts: { dryRun?: boolean; batchSize?: number } = {},
): Promise<{ checked: number; changed: number }> {
  const dryRun = opts.dryRun ?? false;
  const batchSize = opts.batchSize ?? 500;
  let cursor = 0;
  let checked = 0;
  let changed = 0;

  for (;;) {
    const batch = await prisma.studentProfile.findMany({
      where: { deletedAt: null, user: { schoolId }, id: { gt: cursor } },
      select: { id: true, paidUntil: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (batch.length === 0) break;

    for (const p of batch) {
      checked++;
      const before = p.paidUntil?.getTime() ?? null;
      const res = dryRun
        ? await recomputeAndPersistPaidUntil(prisma, p.id, schoolId, { persist: false })
        : await prisma.$transaction((tx) => recomputeAndPersistPaidUntil(tx, p.id, schoolId));
      const after = res.paidUntil?.getTime() ?? null;
      if (before !== after) changed++;
    }

    cursor = batch[batch.length - 1].id;
  }

  return { checked, changed };
}
