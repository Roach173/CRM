import { InvoiceStatus, Prisma, PrismaClient } from '@prisma/client';
import prismaDefault from '../lib/prisma';

type PrismaReader = Pick<
  PrismaClient,
  'invoice' | 'paymentAllocation' | 'paymentRefundAllocation' | 'financialAdjustment'
>;

const ACTIVE_RECEIVABLE_STATUSES: InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'];
const OVERDUE_ELIGIBLE_STATUSES: InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID'];

export interface ReceivableMathInput {
  totalAmount: Prisma.Decimal.Value;
  confirmedAllocated: Prisma.Decimal.Value;
  confirmedRefunded: Prisma.Decimal.Value;
}

export interface InvoiceOverdueInput extends ReceivableMathInput {
  status: InvoiceStatus;
  dueDate: Date | null;
}

export function calculateNetPaid(invoice: ReceivableMathInput): Prisma.Decimal {
  return new Prisma.Decimal(invoice.confirmedAllocated).minus(invoice.confirmedRefunded);
}

export function calculateOutstanding(invoice: ReceivableMathInput): Prisma.Decimal {
  const outstanding = new Prisma.Decimal(invoice.totalAmount).minus(calculateNetPaid(invoice));
  return Prisma.Decimal.max(outstanding, new Prisma.Decimal(0));
}

export function isInvoiceOverdue(invoice: InvoiceOverdueInput, asOf: Date): boolean {
  if (!OVERDUE_ELIGIBLE_STATUSES.includes(invoice.status)) return false;
  if (!invoice.dueDate || invoice.dueDate >= asOf) return false;
  return calculateOutstanding(invoice).gt(new Prisma.Decimal(0));
}

export interface InvoiceReceivable {
  invoiceId: number;
  schoolId: number;
  studentProfileId: number;
  status: InvoiceStatus;
  currencyCode: string;
  dueDate: Date | null;
  totalAmount: Prisma.Decimal;
  totalPaid: Prisma.Decimal;
  totalRefunded: Prisma.Decimal;
  netPaid: Prisma.Decimal;
  outstanding: Prisma.Decimal;
  isOverdue: boolean;
}

export interface StudentReceivableSummary {
  studentProfileId: number;
  totalIssued: Prisma.Decimal;
  totalPaid: Prisma.Decimal;
  totalRefunded: Prisma.Decimal;
  totalOutstanding: Prisma.Decimal;
  overdueOutstanding: Prisma.Decimal;
  activeInvoiceCount: number;
  overdueInvoiceCount: number;
  creditDebtAmount: number;
  moneyDebtAmount: Prisma.Decimal;
  invoices: InvoiceReceivable[];
}

export interface SchoolReceivableSummary {
  schoolId: number;
  totalIssued: Prisma.Decimal;
  totalPaid: Prisma.Decimal;
  totalRefunded: Prisma.Decimal;
  totalOutstanding: Prisma.Decimal;
  overdueOutstanding: Prisma.Decimal;
  activeInvoiceCount: number;
  overdueInvoiceCount: number;
  studentCountWithOutstanding: number;
  creditDebtAmount: number;
  moneyDebtAmount: Prisma.Decimal;
}

type InvoiceRow = Awaited<ReturnType<PrismaReader['invoice']['findMany']>>[number];

export async function computeInvoiceReceivable(
  invoiceId: number,
  asOf: Date = new Date(),
  prisma: PrismaReader = prismaDefault,
): Promise<InvoiceReceivable> {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: {
      id: invoiceId,
    },
  });
  return (await buildInvoiceReceivables(prisma, [invoice], asOf))[0];
}

export async function getStudentReceivableSummary(
  schoolId: number,
  studentProfileId: number,
  asOf: Date = new Date(),
  prisma: PrismaReader = prismaDefault,
): Promise<StudentReceivableSummary> {
  const invoices = await prisma.invoice.findMany({
    where: {
      schoolId,
      studentProfileId,
      status: { in: ACTIVE_RECEIVABLE_STATUSES },
    },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
  });

  const receivables = await buildInvoiceReceivables(prisma, invoices, asOf);
  const creditDebtAmount = await getCreditDebtAmount(prisma, schoolId, studentProfileId);

  return {
    studentProfileId,
    ...summarizeReceivables(receivables),
    creditDebtAmount,
    moneyDebtAmount: sumDecimal(receivables.map(r => r.outstanding)),
    invoices: receivables,
  };
}

export async function listOverdueInvoices(
  schoolId: number,
  asOf: Date = new Date(),
  prisma: PrismaReader = prismaDefault,
): Promise<InvoiceReceivable[]> {
  const invoices = await prisma.invoice.findMany({
    where: {
      schoolId,
      status: { in: OVERDUE_ELIGIBLE_STATUSES },
      dueDate: { lt: asOf },
    },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
  });

  const receivables = await buildInvoiceReceivables(prisma, invoices, asOf);
  return receivables.filter(r => r.isOverdue);
}

export async function getSchoolReceivableSummary(
  schoolId: number,
  asOf: Date = new Date(),
  prisma: PrismaReader = prismaDefault,
): Promise<SchoolReceivableSummary> {
  const invoices = await prisma.invoice.findMany({
    where: {
      schoolId,
      status: { in: ACTIVE_RECEIVABLE_STATUSES },
    },
  });

  const receivables = await buildInvoiceReceivables(prisma, invoices, asOf);
  const studentIdsWithOutstanding = new Set(
    receivables
      .filter(r => r.outstanding.gt(new Prisma.Decimal(0)))
      .map(r => r.studentProfileId),
  );

  const creditDebtRows = await prisma.financialAdjustment.findMany({
    where: { schoolId, type: 'BALANCE_DEBT', status: 'ACTIVE' },
    select: { amountCredits: true },
  });

  return {
    schoolId,
    ...summarizeReceivables(receivables),
    studentCountWithOutstanding: studentIdsWithOutstanding.size,
    creditDebtAmount: creditDebtRows.reduce((sum, row) => sum + (row.amountCredits ?? 0), 0),
    moneyDebtAmount: sumDecimal(receivables.map(r => r.outstanding)),
  };
}

async function buildInvoiceReceivables(
  prisma: PrismaReader,
  invoices: InvoiceRow[],
  asOf: Date,
): Promise<InvoiceReceivable[]> {
  if (invoices.length === 0) return [];

  const invoiceIds = invoices.map(i => i.id);
  const [allocations, refunds] = await Promise.all([
    prisma.paymentAllocation.findMany({
      where: { invoiceId: { in: invoiceIds }, payment: { status: 'CONFIRMED' } },
      select: { invoiceId: true, amount: true },
    }),
    prisma.paymentRefundAllocation.findMany({
      where: {
        paymentAllocation: { invoiceId: { in: invoiceIds } },
        refund: { status: 'CONFIRMED' },
      },
      select: {
        amount: true,
        paymentAllocation: { select: { invoiceId: true } },
      },
    }),
  ]);

  const paidByInvoice = new Map<number, Prisma.Decimal>();
  for (const allocation of allocations) {
    const prev = paidByInvoice.get(allocation.invoiceId) ?? new Prisma.Decimal(0);
    paidByInvoice.set(allocation.invoiceId, prev.plus(allocation.amount));
  }

  const refundedByInvoice = new Map<number, Prisma.Decimal>();
  for (const refund of refunds) {
    const invoiceId = refund.paymentAllocation.invoiceId;
    const prev = refundedByInvoice.get(invoiceId) ?? new Prisma.Decimal(0);
    refundedByInvoice.set(invoiceId, prev.plus(refund.amount));
  }

  return invoices.map((invoice) => {
    const totalPaid = paidByInvoice.get(invoice.id) ?? new Prisma.Decimal(0);
    const totalRefunded = refundedByInvoice.get(invoice.id) ?? new Prisma.Decimal(0);
    const mathInput = {
      totalAmount: invoice.totalAmount,
      confirmedAllocated: totalPaid,
      confirmedRefunded: totalRefunded,
    };
    const netPaid = calculateNetPaid(mathInput);
    const outstanding = calculateOutstanding(mathInput);
    const overdueInput = {
      ...mathInput,
      status: invoice.status,
      dueDate: invoice.dueDate,
    };

    return {
      invoiceId: invoice.id,
      schoolId: invoice.schoolId,
      studentProfileId: invoice.studentProfileId,
      status: invoice.status,
      currencyCode: invoice.currencyCode,
      dueDate: invoice.dueDate,
      totalAmount: new Prisma.Decimal(invoice.totalAmount),
      totalPaid,
      totalRefunded,
      netPaid,
      outstanding,
      isOverdue: isInvoiceOverdue(overdueInput, asOf),
    };
  });
}

async function getCreditDebtAmount(
  prisma: PrismaReader,
  schoolId: number,
  studentProfileId: number,
): Promise<number> {
  const rows = await prisma.financialAdjustment.findMany({
    where: { schoolId, studentProfileId, type: 'BALANCE_DEBT', status: 'ACTIVE' },
    select: { amountCredits: true },
  });

  return rows.reduce((sum, row) => sum + (row.amountCredits ?? 0), 0);
}

function summarizeReceivables(receivables: InvoiceReceivable[]) {
  const totalIssued = sumDecimal(receivables.map(r => r.totalAmount));
  const totalPaid = sumDecimal(receivables.map(r => r.totalPaid));
  const totalRefunded = sumDecimal(receivables.map(r => r.totalRefunded));
  const totalOutstanding = sumDecimal(receivables.map(r => r.outstanding));
  const overdueOutstanding = sumDecimal(
    receivables.filter(r => r.isOverdue).map(r => r.outstanding),
  );

  return {
    totalIssued,
    totalPaid,
    totalRefunded,
    totalOutstanding,
    overdueOutstanding,
    activeInvoiceCount: receivables.length,
    overdueInvoiceCount: receivables.filter(r => r.isOverdue).length,
  };
}

function sumDecimal(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((sum, value) => sum.plus(value), new Prisma.Decimal(0));
}
