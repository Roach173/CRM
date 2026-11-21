import { Router } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { createDraft, addLine, issueInvoice, voidInvoice } from '../services/invoiceService';
import { createLogger } from '../lib/logger';
import { sendLifecycleError } from '../lib/routeError';

const log = createLogger('invoices');
const router = Router();

// POST /api/v1/invoices — create draft invoice (optionally with lines)
router.post('/', authenticate, requirePermission('finance:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const { studentProfileId, dueDate, note, currencyCode, periodStart, periodEnd, lines } = req.body;

    if (!studentProfileId) {
      return res.status(400).json({ success: false, error: 'studentProfileId is required' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const invoice = await createDraft(tx, {
        schoolId,
        studentProfileId: parseInt(studentProfileId, 10),
        createdById:      req.user!.userId,
        dueDate:          dueDate     ? new Date(dueDate)     : undefined,
        note,
        currencyCode,
        periodStart:      periodStart ? new Date(periodStart) : undefined,
        periodEnd:        periodEnd   ? new Date(periodEnd)   : undefined,
      });

      if (Array.isArray(lines) && lines.length > 0) {
        for (const l of lines) {
          await addLine(tx, {
            invoiceId:      invoice.id,
            schoolId,
            type:           l.type,
            description:    l.description,
            quantity:       String(l.quantity),
            unitPrice:      String(l.unitPrice),
            creditsToIssue: l.creditsToIssue,
            groupId:        l.groupId,
            lessonBlockId:  l.lessonBlockId,
            periodStart:    l.periodStart ? new Date(l.periodStart) : undefined,
            periodEnd:      l.periodEnd   ? new Date(l.periodEnd)   : undefined,
          });
        }
      }

      return tx.invoice.findUniqueOrThrow({
        where:   { id: invoice.id },
        include: { lines: true, allocations: true },
      });
    });

    return res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    log.error({ err }, 'invoices route error');
    if (err.message === 'STUDENT_NOT_FOUND')
      return res.status(404).json({ success: false, error: 'Student not found' });
    return sendLifecycleError(res, err, 'Failed to create invoice');
  }
});

// GET /api/v1/invoices — paginated list for this school
router.get('/', authenticate, requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const { studentProfileId, status, page = '1', limit = '50' } = req.query;

    const pageNum  = Math.max(1, parseInt(String(page), 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10)));

    const where: Record<string, unknown> = { schoolId };
    if (studentProfileId) where.studentProfileId = parseInt(String(studentProfileId), 10);
    if (status)           where.status           = String(status);

    const [data, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (pageNum - 1) * limitNum,
        take:    limitNum,
        include: {
          studentProfile: { include: { user: { select: { firstName: true, lastName: true } } } },
          lines:          true,
          _count:         { select: { allocations: true } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);

    return res.json({
      success: true,
      data,
      meta: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (err: any) {
    log.error({ err }, 'invoices route error');
    return res.status(500).json({ success: false, error: 'Failed to fetch invoices' });
  }
});

// GET /api/v1/invoices/:id — single invoice with lines + allocations
router.get('/:id', authenticate, requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const id       = parseInt(req.params.id, 10);

    const invoice = await prisma.invoice.findFirst({
      where:   { id, schoolId },
      include: {
        lines: true,
        allocations: {
          include: {
            payment: {
              select: { id: true, amount: true, method: true, status: true, paidAt: true },
            },
          },
        },
        studentProfile: {
          include: { user: { select: { firstName: true, lastName: true, email: true } } },
        },
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    return res.json({ success: true, data: invoice });
  } catch (err: any) {
    log.error({ err }, 'invoices route error');
    return res.status(500).json({ success: false, error: 'Failed to fetch invoice' });
  }
});

// POST /api/v1/invoices/:id/lines — add a line to a DRAFT invoice
router.post('/:id/lines', authenticate, requirePermission('finance:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId  = req.user!.schoolId;
    const invoiceId = parseInt(req.params.id, 10);
    const { type, description, quantity, unitPrice, creditsToIssue, groupId, lessonBlockId, periodStart, periodEnd } = req.body;

    if (!type || !description || quantity == null || unitPrice == null) {
      return res.status(400).json({ success: false, error: 'type, description, quantity, unitPrice are required' });
    }

    const result = await prisma.$transaction((tx) =>
      addLine(tx, {
        invoiceId,
        schoolId,
        type,
        description,
        quantity:       String(quantity),
        unitPrice:      String(unitPrice),
        creditsToIssue: creditsToIssue != null ? parseInt(creditsToIssue, 10) : undefined,
        groupId:        groupId        ? parseInt(groupId, 10)        : undefined,
        lessonBlockId:  lessonBlockId  ? parseInt(lessonBlockId, 10)  : undefined,
        periodStart:    periodStart    ? new Date(periodStart)        : undefined,
        periodEnd:      periodEnd      ? new Date(periodEnd)          : undefined,
      }),
    );

    return res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    log.error({ err }, 'invoices route error');
    if (err.message === 'INVOICE_NOT_FOUND')
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (err.message === 'INVOICE_NOT_EDITABLE')
      return res.status(409).json({ success: false, error: 'Only DRAFT invoices can be edited' });
    return sendLifecycleError(res, err, 'Failed to add line');
  }
});

// POST /api/v1/invoices/:id/issue — DRAFT → ISSUED
router.post('/:id/issue', authenticate, requirePermission('finance:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const id       = parseInt(req.params.id, 10);

    const result = await prisma.$transaction((tx) =>
      issueInvoice(tx, { invoiceId: id, schoolId, actorId: req.user!.userId }),
    );

    return res.json({ success: true, data: result });
  } catch (err: any) {
    log.error({ err }, 'invoices route error');
    if (err.message === 'INVOICE_NOT_FOUND')
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (err.message === 'INVOICE_NOT_DRAFT')
      return res.status(409).json({ success: false, error: 'Invoice is not in DRAFT status' });
    if (err.message === 'INVOICE_HAS_NO_LINES')
      return res.status(422).json({ success: false, error: 'Invoice has no lines' });
    return sendLifecycleError(res, err, 'Failed to issue invoice');
  }
});

// POST /api/v1/invoices/:id/void — void an invoice
router.post('/:id/void', authenticate, requirePermission('finance:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    const id       = parseInt(req.params.id, 10);

    const result = await prisma.$transaction((tx) =>
      voidInvoice(tx, { invoiceId: id, schoolId, actorId: req.user!.userId }),
    );

    return res.json({ success: true, data: result });
  } catch (err: any) {
    log.error({ err }, 'invoices route error');
    if (err.message === 'INVOICE_NOT_FOUND')
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (err.message === 'INVOICE_ALREADY_VOID')
      return res.status(409).json({ success: false, error: 'Invoice is already void' });
    if (err.message === 'INVOICE_PAID_CANNOT_VOID')
      return res.status(409).json({ success: false, error: 'Paid invoice cannot be voided' });
    if (err.message === 'INVOICE_HAS_CONFIRMED_ALLOCATIONS')
      return res.status(409).json({ success: false, error: 'Invoice has confirmed payment allocations — void the payment first' });
    return sendLifecycleError(res, err, 'Failed to void invoice');
  }
});

export default router;
