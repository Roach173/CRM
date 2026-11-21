import { AdjType } from '@prisma/client';
import { monthAdjustmentNet, appliedAdjustmentNet, remainingAdjustmentNet } from '../../routes/salary';

// Pins the partial-payment adjustment invariant:
// across ALL payments of a period, adjustments are applied EXACTLY once
// (the old date-window selection double-applied a fine when two payment
// windows overlapped, and could miss one dated outside every window).

const RATE = 500;

/** Simulates POST /pay amount math for one payment. */
function payAmount(lessons: number, adjustmentNet: number): number {
  return Math.max(0, lessons * RATE + adjustmentNet);
}

describe('salary adjustment math — applied exactly once per period', () => {
  it('monthAdjustmentNet: BONUS adds, FINE and ADVANCE subtract', () => {
    expect(monthAdjustmentNet([
      { type: AdjType.BONUS, amount: 900 },
      { type: AdjType.FINE, amount: 300 },
      { type: AdjType.ADVANCE, amount: 200 },
    ])).toBe(400);
  });

  it('a FINE is deducted once across two partial payments (regression: overlapping date windows deducted it twice)', () => {
    const adjs = [{ type: AdjType.FINE, amount: 1000 }];
    const payments: Array<{ amount: number; lessonsCount: number; rateSnapshot: number }> = [];

    // Payment 1: 4 lessons — fine applies here
    const net1 = remainingAdjustmentNet(adjs, payments);
    expect(net1).toBe(-1000);
    const amount1 = payAmount(4, net1);
    expect(amount1).toBe(1000); // 2000 - 1000
    payments.push({ amount: amount1, lessonsCount: 4, rateSnapshot: RATE });

    // Payment 2: 6 remaining lessons — fine must NOT apply again
    const net2 = remainingAdjustmentNet(adjs, payments);
    expect(net2).toBe(0);
    expect(payAmount(6, net2)).toBe(3000); // full lesson pay, no second deduction

    // Total paid = lessons*rate + monthNet, exactly
    expect(amount1 + 3000).toBe(10 * RATE - 1000);
  });

  it('clamp carry: a FINE bigger than one payment rolls into the next payment, nothing is lost', () => {
    const adjs = [{ type: AdjType.FINE, amount: 5000 }];
    const payments: Array<{ amount: number; lessonsCount: number; rateSnapshot: number }> = [];

    // Payment 1: 2 lessons (1000) — fine clamps amount to 0, only 1000 of it absorbed
    const net1 = remainingAdjustmentNet(adjs, payments);
    const amount1 = payAmount(2, net1);
    expect(amount1).toBe(0);
    payments.push({ amount: amount1, lessonsCount: 2, rateSnapshot: RATE });
    expect(appliedAdjustmentNet(payments)).toBe(-1000); // only what was actually absorbed

    // Payment 2: 8 lessons (4000) — remaining 4000 of the fine absorbs it fully
    const net2 = remainingAdjustmentNet(adjs, payments);
    expect(net2).toBe(-4000);
    const amount2 = payAmount(8, net2);
    expect(amount2).toBe(0);
    payments.push({ amount: amount2, lessonsCount: 8, rateSnapshot: RATE });

    // Whole fine recovered: total paid = 10*500 - 5000 = 0
    expect(appliedAdjustmentNet(payments)).toBe(-5000);
  });

  it('a BONUS is paid once, not once per partial payment', () => {
    const adjs = [{ type: AdjType.BONUS, amount: 900 }];
    const payments: Array<{ amount: number; lessonsCount: number; rateSnapshot: number }> = [];

    const amount1 = payAmount(3, remainingAdjustmentNet(adjs, payments));
    expect(amount1).toBe(3 * RATE + 900);
    payments.push({ amount: amount1, lessonsCount: 3, rateSnapshot: RATE });

    const amount2 = payAmount(5, remainingAdjustmentNet(adjs, payments));
    expect(amount2).toBe(5 * RATE); // bonus not paid twice
  });

  it('rate change between payments does not distort applied net (per-payment rateSnapshot)', () => {
    const adjs = [{ type: AdjType.FINE, amount: 600 }];
    // Payment 1 at rate 500 absorbed the fine
    const payments = [{ amount: 4 * 500 - 600, lessonsCount: 4, rateSnapshot: 500 }];
    // Payment 2 at NEW rate 700 — nothing left to apply
    expect(remainingAdjustmentNet(adjs, payments)).toBe(0);
  });
});
