// Self-check for proportional billing math (mirrors the model in routes/students.ts).
// Run: node src/billing/proportionalBilling.selfcheck.mjs
// Invariant: lessons = floor(totalPaidSincePriceChange * billingDays / fee), computed
// with exact Decimal math. Full fee => exactly billingDays lessons; any amount allowed;
// no som is ever lost; a price change carries the sub-lesson leftover forward.
import { Prisma } from '@prisma/client';
import assert from 'node:assert';

const D = (x) => new Prisma.Decimal(x);

function newStudent() { return { credits: 0, moneyBalance: D(0), granted: 0, fee: null }; }

function setFee(s, newFee, days, basePrice) {
  const oldNum = s.fee != null ? Number(s.fee) : null;
  if (oldNum === newFee) { s.fee = newFee; return; }
  const oldFee = oldNum && oldNum > 0 ? D(oldNum) : D(basePrice);
  const grantedCost = D(s.granted).mul(oldFee).div(days);
  const leftover = s.moneyBalance.sub(grantedCost);
  s.moneyBalance = leftover.isNegative() ? D(0) : leftover;
  s.granted = 0;
  s.fee = newFee;
}

function pay(s, amount, days, basePrice) {
  s.moneyBalance = s.moneyBalance.add(amount);
  const fee = s.fee != null && s.fee > 0 ? D(s.fee) : D(basePrice);
  const owed = s.moneyBalance.mul(days).div(fee).floor().toNumber();
  const add = Math.max(0, owed - s.granted);
  if (add > 0) { s.credits += add; s.granted = owed; }
  return add;
}

const leftoverSom = (s, days, basePrice) => {
  const fee = s.fee != null && s.fee > 0 ? D(s.fee) : D(basePrice);
  return s.moneyBalance.sub(D(s.granted).mul(fee).div(days));
};

const DAYS = 26, BASE = 5000;

// 1) Full fee => exactly billingDays lessons, zero leftover.
let s = newStudent(); setFee(s, 4000, DAYS, BASE);
assert.strictEqual(pay(s, 4000, DAYS, BASE), 26, 'full fee should give 26');
assert.strictEqual(leftoverSom(s, DAYS, BASE).toNumber(), 0, 'full fee leftover 0');

// 2) Overpay 4025 => 26 lessons, 25 som banked.
s = newStudent(); setFee(s, 4000, DAYS, BASE);
assert.strictEqual(pay(s, 4025, DAYS, BASE), 26, '4025 should give 26');
assert.strictEqual(leftoverSom(s, DAYS, BASE).toNumber(), 25, '4025 leftover 25');

// 3) Four partial payments of 1000 => 26 total, no lesson lost to rounding.
s = newStudent(); setFee(s, 4000, DAYS, BASE);
const grants = [pay(s,1000,DAYS,BASE), pay(s,1000,DAYS,BASE), pay(s,1000,DAYS,BASE), pay(s,1000,DAYS,BASE)];
assert.deepStrictEqual(grants, [6,7,6,7], 'partial grants 6,7,6,7');
assert.strictEqual(s.credits, 26, 'four 1000s => 26');

// 4) Price change carries the sub-lesson leftover forward; only future money bills at new price.
s = newStudent(); setFee(s, 4000, DAYS, BASE);
assert.strictEqual(pay(s, 4025, DAYS, BASE), 26, 'pre-change 26');   // 25 som banked
setFee(s, 5000, DAYS, BASE);                                        // draw the line
assert.strictEqual(s.credits, 26, 'price change keeps earned lessons');
assert.strictEqual(pay(s, 4975, DAYS, BASE), 26, '25 banked + 4975 = a month at 5000 => 26');

// 5) No fee set => falls back to school basePrice (5000/26), guards divide-by-zero.
s = newStudent();
assert.strictEqual(pay(s, 5000, DAYS, BASE), 26, 'basePrice fallback: 5000 => 26');

console.log('proportional billing self-check: all passed');
