import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { AnalyticsRange, rangeWhere } from './analyticsDate';

async function listOverdueInvoices(schoolId: number, asOf: Date) {
  return prisma.invoice.findMany({
    where: {
      schoolId,
      status: { in: ['OVERDUE', 'ISSUED', 'PARTIALLY_PAID'] },
      dueDate: { lt: asOf },
    },
    select: { dueDate: true, totalAmount: true, paidAmount: true },
  }).then(rows =>
    rows.map(r => ({
      dueDate: r.dueDate,
      outstanding: Number(r.totalAmount) - Number(r.paidAmount ?? 0),
    }))
  );
}

function roundMoney(v: Prisma.Decimal | number | null | undefined): number {
  return Math.round(Number(v ?? 0));
}

export interface FinanceKPIs {
  collectedAmount: number;
  refundedAmount: number;
  refundRate: number;
  avgInvoiceValue: number;
  paidInvoiceCount: number;
  overdueInvoiceCount: number;
  totalOverdueOutstanding: number;
  collectionRate: number;
  prevCollectedAmount: number;
  prevRefundedAmount: number;
}

export async function getFinanceKPIs(
  schoolId: number,
  range: AnalyticsRange,
  prev?: AnalyticsRange,
): Promise<FinanceKPIs> {
  const asOf = range.to;

  const [collectedAgg, refundedAgg, issuedInvoices, overdueList] = await Promise.all([
    prisma.payment.aggregate({
      where: { schoolId, status: 'CONFIRMED', paidAt: rangeWhere(range) },
      _sum: { amount: true },
    }),
    prisma.paymentRefund.aggregate({
      where: { schoolId, status: 'CONFIRMED', confirmedAt: rangeWhere(range) },
      _sum: { amount: true },
    }),
    prisma.invoice.findMany({
      where: {
        schoolId,
        status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] },
        issuedAt: rangeWhere(range),
      },
      select: { totalAmount: true, status: true },
    }),
    listOverdueInvoices(schoolId, asOf),
  ]);

  const collected = roundMoney(collectedAgg._sum.amount);
  const refunded = roundMoney(refundedAgg._sum.amount);
  const refundRate = collected > 0 ? Math.round((refunded / collected) * 100) : 0;

  const issuedTotal = issuedInvoices.reduce((s, inv) => s + roundMoney(inv.totalAmount), 0);
  const paidInvoiceCount = issuedInvoices.filter(inv => inv.status === 'PAID').length;
  const avgInvoiceValue = issuedInvoices.length > 0 ? Math.round(issuedTotal / issuedInvoices.length) : 0;
  const collectionRate = issuedTotal > 0 ? Math.round((collected / issuedTotal) * 100) : 0;

  const overdueInvoiceCount = overdueList.length;
  const totalOverdueOutstanding = Math.round(
    overdueList.reduce((s, inv) => s + Number(inv.outstanding), 0),
  );

  let prevCollectedAmount = 0;
  let prevRefundedAmount = 0;
  if (prev) {
    const [prevCollected, prevRefunded] = await Promise.all([
      prisma.payment.aggregate({
        where: { schoolId, status: 'CONFIRMED', paidAt: rangeWhere(prev) },
        _sum: { amount: true },
      }),
      prisma.paymentRefund.aggregate({
        where: { schoolId, status: 'CONFIRMED', confirmedAt: rangeWhere(prev) },
        _sum: { amount: true },
      }),
    ]);
    prevCollectedAmount = roundMoney(prevCollected._sum.amount);
    prevRefundedAmount = roundMoney(prevRefunded._sum.amount);
  }

  return {
    collectedAmount: collected,
    refundedAmount: refunded,
    refundRate,
    avgInvoiceValue,
    paidInvoiceCount,
    overdueInvoiceCount,
    totalOverdueOutstanding,
    collectionRate,
    prevCollectedAmount,
    prevRefundedAmount,
  };
}

export interface AgingBucket {
  label: string;
  minDays: number;
  maxDays: number | null;
  count: number;
  amount: number;
}

export async function getReceivablesAging(
  schoolId: number,
  asOf: Date = new Date(),
): Promise<AgingBucket[]> {
  const overdueInvoices = await listOverdueInvoices(schoolId, asOf);

  const buckets: AgingBucket[] = [
    { label: '0–30 дн.', minDays: 0, maxDays: 30, count: 0, amount: 0 },
    { label: '31–60 дн.', minDays: 31, maxDays: 60, count: 0, amount: 0 },
    { label: '61–90 дн.', minDays: 61, maxDays: 90, count: 0, amount: 0 },
    { label: '90+ дн.', minDays: 91, maxDays: null, count: 0, amount: 0 },
  ];

  for (const inv of overdueInvoices) {
    if (!inv.dueDate) continue;
    const days = Math.floor((asOf.getTime() - inv.dueDate.getTime()) / 86_400_000);
    const amount = Math.round(Number(inv.outstanding));
    const bucket = buckets.find(
      b => days >= b.minDays && (b.maxDays === null || days <= b.maxDays),
    );
    if (bucket) {
      bucket.count++;
      bucket.amount += amount;
    }
  }

  return buckets;
}
