import { Prisma, BillingMode } from '@prisma/client';
import { deriveStatus } from '../../lib/paidUntilDerivation';

// Pins the display invariants that were violated in production (Part 16):
//   credits <= 0  →  paidUntil = today (never a future date)
//   credits  > 0  →  paidUntil >= today (never a past date)
// If either regresses, "0 ур. / оплачено до <future>" or
// "25 ур. / оплачено до <past>" comes back.

const todayNoon = new Date('2026-07-08T12:00:00.000Z');

function base(over: Partial<Parameters<typeof deriveStatus>[0]> = {}) {
  return {
    credits: 0,
    isFrozen: false,
    billingMode: BillingMode.PER_LESSON,
    basePrice: new Prisma.Decimal(5000),
    pricePerLesson: 193,
    todayNoon,
    upcomingSessionDates: [] as Date[],
    lessonsPerWeek: 0,
    ...over,
  };
}

function noon(iso: string) {
  return new Date(`${iso}T12:00:00.000Z`);
}

describe('deriveStatus — balance is the single source of truth for paidUntil', () => {
  it('zero balance → paidUntil is today and overdue (never a future date)', () => {
    const r = deriveStatus(base({ credits: 0 }));
    expect(r.paidUntil).toEqual(todayNoon);
    expect(r.isOverdue).toBe(true);
  });

  it('negative balance (debt) → same as zero: today + overdue', () => {
    const r = deriveStatus(base({ credits: -3 }));
    expect(r.paidUntil).toEqual(todayNoon);
    expect(r.isOverdue).toBe(true);
  });

  it('frozen student with zero balance is not overdue', () => {
    const r = deriveStatus(base({ credits: 0, isFrozen: true }));
    expect(r.isOverdue).toBe(false);
  });

  it('PER_LESSON: paidUntil = date of the credits-th upcoming session (never in the past)', () => {
    const sessions = [noon('2026-07-09'), noon('2026-07-11'), noon('2026-07-14')];
    const r = deriveStatus(base({ credits: 2, upcomingSessionDates: sessions }));
    expect(r.paidUntil).toEqual(noon('2026-07-11'));
    expect(r.isOverdue).toBe(false);
    expect(r.paidUntil!.getTime()).toBeGreaterThanOrEqual(todayNoon.getTime());
  });

  it('PER_LESSON: credits beyond the known horizon extrapolate by weekly cadence', () => {
    const sessions = [noon('2026-07-09'), noon('2026-07-11')];
    const r = deriveStatus(base({ credits: 6, upcomingSessionDates: sessions, lessonsPerWeek: 2 }));
    // 4 remaining / 2 per week = 2 weeks past the last known session
    expect(r.paidUntil).toEqual(noon('2026-07-25'));
    expect(r.isOverdue).toBe(false);
  });

  it('PER_LESSON: positive balance with no schedule at all → null date, still not overdue', () => {
    const r = deriveStatus(base({ credits: 25 }));
    expect(r.paidUntil).toBeNull();
    expect(r.isOverdue).toBe(false);
  });

  it('CALENDAR_MONTH: credits worth exactly the base price project one month ahead', () => {
    // 5000 / 193 ≈ 25.9 credits per month; use credits*ppl == basePrice exactly.
    const r = deriveStatus(base({
      billingMode: BillingMode.CALENDAR_MONTH,
      credits: 25,
      pricePerLesson: 200,
      basePrice: new Prisma.Decimal(5000),
    }));
    expect(r.paidUntil).toEqual(noon('2026-08-08'));
    expect(r.isOverdue).toBe(false);
  });

  it('positive balance never yields a paidUntil in the past (Луна: 25 ур., дата в прошлом)', () => {
    for (const credits of [1, 5, 25]) {
      const r = deriveStatus(base({
        credits,
        upcomingSessionDates: [noon('2026-07-09'), noon('2026-07-11'), noon('2026-07-14')],
        lessonsPerWeek: 2,
      }));
      expect(r.paidUntil).not.toBeNull();
      expect(r.paidUntil!.getTime()).toBeGreaterThanOrEqual(todayNoon.getTime());
      expect(r.isOverdue).toBe(false);
    }
  });
});
