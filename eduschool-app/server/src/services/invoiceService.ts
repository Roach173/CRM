import { Prisma, InvoiceLineType, PrismaClient } from '@prisma/client';
import { logFinanceAction } from '../lib/auditLog';

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// ─── createDraft ──────────────────────────────────────────────────────────────

export async function createDraft(
  tx: PrismaTx,
  params: {
    schoolId: number;
    studentProfileId: number;
    createdById: number;
    dueDate?: Date;
    note?: string;
    currencyCode?: string;
    periodStart?: Date;
    periodEnd?: Date;
  },
) {
  // Tenant isolation: verify student belongs to this school
  const profile = await tx.studentProfile.findFirst({
    where: { id: params.studentProfileId, user: { schoolId: params.schoolId }, deletedAt: null },
    select: { id: true },
  });
  if (!profile) throw new Error('STUDENT_NOT_FOUND');

  const invoice = await tx.invoice.create({
    data: {
      schoolId:         params.schoolId,
      studentProfileId: params.studentProfileId,
      createdById:      params.createdById,
      status:           'DRAFT',
      totalAmount:      new Prisma.Decimal(0),
      paidAmount:       new Prisma.Decimal(0),
      currencyCode:     params.currencyCode ?? 'KGS',
      dueDate:          params.dueDate,
      note:             params.note,
      periodStart:      params.periodStart,
      periodEnd:        params.periodEnd,
    },
    include: { lines: true, allocations: true },
  });

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.createdById,
    action: 'INVOICE_CREATED',
    entityType: 'invoice',
    entityId: invoice.id,
    after: { studentProfileId: params.studentProfileId, status: 'DRAFT' },
  });

  return invoice;
}

// ─── addLine ──────────────────────────────────────────────────────────────────

export async function addLine(
  tx: PrismaTx,
  params: {
    invoiceId: number;
    schoolId: number;
    type: InvoiceLineType;
    description: string;
    quantity: string | number;
    unitPrice: string | number;
    creditsToIssue?: number;
    groupId?: number;
    lessonBlockId?: number;
    periodStart?: Date;
    periodEnd?: Date;
  },
) {
  const invoice = await tx.invoice.findFirst({
    where: { id: params.invoiceId, schoolId: params.schoolId },
  });
  if (!invoice) throw new Error('INVOICE_NOT_FOUND');
  if (invoice.status !== 'DRAFT') throw new Error('INVOICE_NOT_EDITABLE');

  // Amount computed server-side — Decimal arithmetic, no JS float
  const qty   = new Prisma.Decimal(String(params.quantity));
  const price = new Prisma.Decimal(String(params.unitPrice));
  const amount = qty.mul(price);

  const line = await tx.invoiceLine.create({
    data: {
      invoiceId:      params.invoiceId,
      type:           params.type,
      description:    params.description,
      quantity:       qty,
      unitPrice:      price,
      amount,
      creditsToIssue: params.creditsToIssue,
      groupId:        params.groupId,
      lessonBlockId:  params.lessonBlockId,
      periodStart:    params.periodStart,
      periodEnd:      params.periodEnd,
    },
  });

  // Recompute totalAmount from all lines — Decimal reduce, no float
  const allLines = await tx.invoiceLine.findMany({
    where:  { invoiceId: params.invoiceId },
    select: { amount: true },
  });
  const newTotal = allLines.reduce(
    (sum, l) => sum.plus(l.amount),
    new Prisma.Decimal(0),
  );

  const updatedInvoice = await tx.invoice.update({
    where:   { id: params.invoiceId },
    data:    { totalAmount: newTotal },
    include: { lines: true },
  });

  return { line, invoice: updatedInvoice };
}

// ─── issueInvoice ─────────────────────────────────────────────────────────────

export async function issueInvoice(
  tx: PrismaTx,
  params: { invoiceId: number; schoolId: number; actorId: number },
) {
  const invoice = await tx.invoice.findFirst({
    where:   { id: params.invoiceId, schoolId: params.schoolId },
    include: { lines: true },
  });
  if (!invoice)                   throw new Error('INVOICE_NOT_FOUND');
  if (invoice.status !== 'DRAFT') throw new Error('INVOICE_NOT_DRAFT');
  if (invoice.lines.length === 0) throw new Error('INVOICE_HAS_NO_LINES');

  const updated = await tx.invoice.update({
    where:   { id: params.invoiceId },
    data:    { status: 'ISSUED', issuedAt: new Date() },
    include: { lines: true, allocations: true },
  });

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.actorId,
    action: 'INVOICE_ISSUED',
    entityType: 'invoice',
    entityId: params.invoiceId,
    before: { status: 'DRAFT' },
    after: { status: 'ISSUED', totalAmount: String(invoice.totalAmount) },
  });

  return updated;
}

// ─── voidInvoice ──────────────────────────────────────────────────────────────

export async function voidInvoice(
  tx: PrismaTx,
  params: { invoiceId: number; schoolId: number; actorId: number },
) {
  const invoice = await tx.invoice.findFirst({
    where: { id: params.invoiceId, schoolId: params.schoolId },
  });
  if (!invoice)                   throw new Error('INVOICE_NOT_FOUND');
  if (invoice.status === 'VOID')  throw new Error('INVOICE_ALREADY_VOID');
  if (invoice.status === 'PAID')  throw new Error('INVOICE_PAID_CANNOT_VOID');

  // Cannot void if there are confirmed allocations — audit trail must be preserved
  const confirmedCount = await tx.paymentAllocation.count({
    where: { invoiceId: params.invoiceId, payment: { status: 'CONFIRMED' } },
  });
  if (confirmedCount > 0) throw new Error('INVOICE_HAS_CONFIRMED_ALLOCATIONS');

  const voided = await tx.invoice.update({
    where: { id: params.invoiceId },
    data:  { status: 'VOID', voidedAt: new Date() },
  });

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.actorId,
    action: 'INVOICE_VOIDED',
    entityType: 'invoice',
    entityId: params.invoiceId,
    before: { status: invoice.status },
    after:  { status: 'VOID' },
  });

  return voided;
}
