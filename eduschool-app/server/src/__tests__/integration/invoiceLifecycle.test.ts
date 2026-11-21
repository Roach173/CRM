/**
 * Integration: Phase 7.1 — Invoice Infrastructure Foundation (real DB).
 *
 * Verifies:
 * - invoice draft creation + tenant isolation
 * - amount computed server-side (Decimal, quantity × unitPrice)
 * - totalAmount recomputed after each addLine
 * - addLine blocked on non-DRAFT invoices (immutability)
 * - issue lifecycle: DRAFT → ISSUED, requires ≥1 line
 * - partial payment → PARTIALLY_PAID status
 * - full payment → PAID status
 * - one payment → many invoices (allocation split)
 * - many payments → one invoice (paidAmount accumulates)
 * - void invoice: allowed with no confirmed allocations
 * - void invoice: blocked with confirmed allocations
 * - void invoice: blocked on already-VOID invoice
 * - void payment: allocations remain (audit trail), paidAmount drops
 * - allocation overpayment guard (single and cumulative)
 * - paidAmount consistency: always equals SUM(confirmed allocations)
 */

import {
  prisma, cleanDb, createSchool, createUser, createStudentProfile,
} from '../helpers/testDb';
import { createDraft, addLine, issueInvoice, voidInvoice } from '../../services/invoiceService';
import { createPayment, createAllocation, voidPayment } from '../../services/paymentService';
import { Prisma } from '@prisma/client';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// ─── Shared fixture ────────────────────────────────────────────────────────────

async function setup() {
  const school    = await createSchool({ timezone: 'UTC' });
  const ownerUser = await createUser(school.id, 'OWNER');
  const stuUser   = await createUser(school.id, 'STUDENT');
  const student   = await createStudentProfile(stuUser.id, school.id, 0);
  return { school, ownerUser, student };
}

/** Create a ready-to-pay ISSUED invoice with one TUITION line. */
async function makeIssuedInvoice(
  school: { id: number },
  student: { id: number },
  ownerUser: { id: number },
  totalStr: string,
) {
  const inv = await prisma.$transaction(tx =>
    createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
  );
  await prisma.$transaction(tx =>
    addLine(tx, {
      invoiceId: inv.id, schoolId: school.id,
      type: 'TUITION', description: 'Monthly fee',
      quantity: '1', unitPrice: totalStr,
    }),
  );
  return prisma.$transaction(tx =>
    issueInvoice(tx, { invoiceId: inv.id, schoolId: school.id, actorId: ownerUser.id }),
  );
}

// ─── Draft creation ────────────────────────────────────────────────────────────

describe('invoice — draft creation', () => {
  it('creates invoice in DRAFT with zero totalAmount and paidAmount', async () => {
    const { school, ownerUser, student } = await setup();

    const inv = await prisma.$transaction(tx =>
      createDraft(tx, {
        schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id,
        note: 'Test invoice',
      }),
    );

    expect(inv.status).toBe('DRAFT');
    expect(new Prisma.Decimal(inv.totalAmount).eq(new Prisma.Decimal(0))).toBe(true);
    expect(new Prisma.Decimal(inv.paidAmount).eq(new Prisma.Decimal(0))).toBe(true);
    expect(inv.schoolId).toBe(school.id);
    expect(inv.studentProfileId).toBe(student.id);
    expect(inv.issuedAt).toBeNull();
  });

  it('rejects draft for student belonging to another school (tenant isolation)', async () => {
    const { school, ownerUser } = await setup();

    const school2  = await createSchool({ timezone: 'UTC' });
    const stuUser2 = await createUser(school2.id, 'STUDENT');
    const student2 = await createStudentProfile(stuUser2.id, school2.id, 0);

    await expect(
      prisma.$transaction(tx =>
        createDraft(tx, {
          schoolId: school.id, studentProfileId: student2.id, createdById: ownerUser.id,
        }),
      ),
    ).rejects.toThrow('STUDENT_NOT_FOUND');
  });
});

// ─── Line amount computed server-side ─────────────────────────────────────────

describe('invoice — line amount server-side (Decimal)', () => {
  it('amount = quantity × unitPrice with no float rounding error', async () => {
    const { school, ownerUser, student } = await setup();
    const inv = await prisma.$transaction(tx =>
      createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
    );

    const { line } = await prisma.$transaction(tx =>
      addLine(tx, {
        invoiceId: inv.id, schoolId: school.id,
        type: 'TUITION', description: '10 lessons',
        quantity: '10', unitPrice: '193.50',
        creditsToIssue: 10,
      }),
    );

    // 10 × 193.50 = 1935.00 (would be 1934.9999... with JS float)
    expect(new Prisma.Decimal(line.amount).eq(new Prisma.Decimal('1935.00'))).toBe(true);
  });

  it('totalAmount recomputed after each addLine', async () => {
    const { school, ownerUser, student } = await setup();
    const inv = await prisma.$transaction(tx =>
      createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
    );

    await prisma.$transaction(tx =>
      addLine(tx, {
        invoiceId: inv.id, schoolId: school.id,
        type: 'TUITION', description: 'Tuition', quantity: '10', unitPrice: '500',
      }),
    );
    const { invoice: after } = await prisma.$transaction(tx =>
      addLine(tx, {
        invoiceId: inv.id, schoolId: school.id,
        type: 'MATERIAL', description: 'Books', quantity: '1', unitPrice: '300',
      }),
    );

    // 5000 + 300 = 5300
    expect(new Prisma.Decimal(after.totalAmount).eq(new Prisma.Decimal('5300'))).toBe(true);
    expect(after.lines).toHaveLength(2);
  });

  it('addLine on ISSUED invoice throws INVOICE_NOT_EDITABLE (immutability)', async () => {
    const { school, ownerUser, student } = await setup();
    const issued = await makeIssuedInvoice(school, student, ownerUser, '5000');

    await expect(
      prisma.$transaction(tx =>
        addLine(tx, {
          invoiceId: issued.id, schoolId: school.id,
          type: 'MATERIAL', description: 'Extra', quantity: '1', unitPrice: '100',
        }),
      ),
    ).rejects.toThrow('INVOICE_NOT_EDITABLE');
  });

  it('addLine on VOID invoice throws INVOICE_NOT_EDITABLE', async () => {
    const { school, ownerUser, student } = await setup();
    const inv = await prisma.$transaction(tx =>
      createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
    );
    await prisma.$transaction(tx =>
      voidInvoice(tx, { invoiceId: inv.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    await expect(
      prisma.$transaction(tx =>
        addLine(tx, {
          invoiceId: inv.id, schoolId: school.id,
          type: 'TUITION', description: 'x', quantity: '1', unitPrice: '100',
        }),
      ),
    ).rejects.toThrow('INVOICE_NOT_EDITABLE');
  });
});

// ─── Issue lifecycle ───────────────────────────────────────────────────────────

describe('invoice — issue lifecycle', () => {
  it('DRAFT → ISSUED sets status and issuedAt', async () => {
    const { school, ownerUser, student } = await setup();
    const inv = await prisma.$transaction(tx =>
      createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
    );
    await prisma.$transaction(tx =>
      addLine(tx, {
        invoiceId: inv.id, schoolId: school.id,
        type: 'TUITION', description: 'Monthly fee', quantity: '1', unitPrice: '5000',
      }),
    );

    const issued = await prisma.$transaction(tx =>
      issueInvoice(tx, { invoiceId: inv.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    expect(issued.status).toBe('ISSUED');
    expect(issued.issuedAt).not.toBeNull();
  });

  it('cannot issue invoice with no lines', async () => {
    const { school, ownerUser, student } = await setup();
    const inv = await prisma.$transaction(tx =>
      createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
    );

    await expect(
      prisma.$transaction(tx =>
        issueInvoice(tx, { invoiceId: inv.id, schoolId: school.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('INVOICE_HAS_NO_LINES');
  });

  it('cannot issue invoice that is already ISSUED', async () => {
    const { school, ownerUser, student } = await setup();
    const issued = await makeIssuedInvoice(school, student, ownerUser, '5000');

    await expect(
      prisma.$transaction(tx =>
        issueInvoice(tx, { invoiceId: issued.id, schoolId: school.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('INVOICE_NOT_DRAFT');
  });
});

// ─── Partial payment ───────────────────────────────────────────────────────────

describe('invoice — partial payment', () => {
  it('partial allocation → PARTIALLY_PAID, paidAmount equals allocation', async () => {
    const { school, ownerUser, student } = await setup();
    const issued  = await makeIssuedInvoice(school, student, ownerUser, '5000');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '2500', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, {
        paymentId: payment.id, invoiceId: issued.id, amount: '2500', schoolId: school.id, actorId: ownerUser.id,
      }),
    );

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(updated.status).toBe('PARTIALLY_PAID');
    expect(new Prisma.Decimal(updated.paidAmount).eq(new Prisma.Decimal('2500'))).toBe(true);
  });
});

// ─── Full payment ──────────────────────────────────────────────────────────────

describe('invoice — full payment', () => {
  it('full allocation → PAID, paidAmount equals totalAmount', async () => {
    const { school, ownerUser, student } = await setup();
    const issued  = await makeIssuedInvoice(school, student, ownerUser, '5000');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '5000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, {
        paymentId: payment.id, invoiceId: issued.id, amount: '5000', schoolId: school.id, actorId: ownerUser.id,
      }),
    );

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(updated.status).toBe('PAID');
    expect(new Prisma.Decimal(updated.paidAmount).eq(new Prisma.Decimal('5000'))).toBe(true);
  });
});

// ─── One payment → many invoices ──────────────────────────────────────────────

describe('invoice — one payment to many invoices', () => {
  it('single payment split across two invoices, both reach PAID', async () => {
    const { school, ownerUser, student } = await setup();

    const inv1 = await makeIssuedInvoice(school, student, ownerUser, '3000');
    const inv2 = await makeIssuedInvoice(school, student, ownerUser, '2000');

    // One payment covers both
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '5000', method: 'TRANSFER', receivedById: ownerUser.id,
      }),
    );

    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: payment.id, invoiceId: inv1.id, amount: '3000', schoolId: school.id, actorId: ownerUser.id }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: payment.id, invoiceId: inv2.id, amount: '2000', schoolId: school.id, actorId: ownerUser.id }),
    );

    const [u1, u2] = await Promise.all([
      prisma.invoice.findUniqueOrThrow({ where: { id: inv1.id } }),
      prisma.invoice.findUniqueOrThrow({ where: { id: inv2.id } }),
    ]);
    expect(u1.status).toBe('PAID');
    expect(u2.status).toBe('PAID');

    const allocs = await prisma.paymentAllocation.findMany({ where: { paymentId: payment.id } });
    expect(allocs).toHaveLength(2);
  });
});

// ─── Many payments → one invoice ──────────────────────────────────────────────

describe('invoice — many payments to one invoice', () => {
  it('three separate payments accumulate paidAmount correctly', async () => {
    const { school, ownerUser, student } = await setup();
    const issued = await makeIssuedInvoice(school, student, ownerUser, '9000');

    for (const amt of ['3000', '3000', '3000']) {
      const pmt = await prisma.$transaction(tx =>
        createPayment(tx, {
          schoolId: school.id, studentProfileId: student.id,
          amount: amt, method: 'CASH', receivedById: ownerUser.id,
        }),
      );
      await prisma.$transaction(tx =>
        createAllocation(tx, { paymentId: pmt.id, invoiceId: issued.id, amount: amt, schoolId: school.id, actorId: ownerUser.id }),
      );
    }

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(updated.status).toBe('PAID');
    expect(new Prisma.Decimal(updated.paidAmount).eq(new Prisma.Decimal('9000'))).toBe(true);
  });
});

// ─── Void invoice ─────────────────────────────────────────────────────────────

describe('invoice — void', () => {
  it('can void DRAFT invoice with no allocations', async () => {
    const { school, ownerUser, student } = await setup();
    const inv = await prisma.$transaction(tx =>
      createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
    );

    const voided = await prisma.$transaction(tx =>
      voidInvoice(tx, { invoiceId: inv.id, schoolId: school.id, actorId: ownerUser.id }),
    );
    expect(voided.status).toBe('VOID');
    expect(voided.voidedAt).not.toBeNull();
  });

  it('can void ISSUED invoice that has no confirmed allocations', async () => {
    const { school, ownerUser, student } = await setup();
    const issued = await makeIssuedInvoice(school, student, ownerUser, '5000');

    const voided = await prisma.$transaction(tx =>
      voidInvoice(tx, { invoiceId: issued.id, schoolId: school.id, actorId: ownerUser.id }),
    );
    expect(voided.status).toBe('VOID');
  });

  it('cannot void invoice with confirmed allocations', async () => {
    const { school, ownerUser, student } = await setup();
    const issued  = await makeIssuedInvoice(school, student, ownerUser, '5000');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '1000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: payment.id, invoiceId: issued.id, amount: '1000', schoolId: school.id, actorId: ownerUser.id }),
    );

    await expect(
      prisma.$transaction(tx =>
        voidInvoice(tx, { invoiceId: issued.id, schoolId: school.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('INVOICE_HAS_CONFIRMED_ALLOCATIONS');
  });

  it('cannot void an already-VOID invoice', async () => {
    const { school, ownerUser, student } = await setup();
    const inv = await prisma.$transaction(tx =>
      createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
    );
    await prisma.$transaction(tx =>
      voidInvoice(tx, { invoiceId: inv.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    await expect(
      prisma.$transaction(tx =>
        voidInvoice(tx, { invoiceId: inv.id, schoolId: school.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('INVOICE_ALREADY_VOID');
  });

  it('cannot void a PAID invoice', async () => {
    const { school, ownerUser, student } = await setup();
    const issued  = await makeIssuedInvoice(school, student, ownerUser, '5000');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '5000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: payment.id, invoiceId: issued.id, amount: '5000', schoolId: school.id, actorId: ownerUser.id }),
    );

    await expect(
      prisma.$transaction(tx =>
        voidInvoice(tx, { invoiceId: issued.id, schoolId: school.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('INVOICE_PAID_CANNOT_VOID');
  });
});

// ─── Allocation overpayment guard ─────────────────────────────────────────────

describe('invoice — allocation overpayment guard', () => {
  it('single allocation exceeding totalAmount is rejected', async () => {
    const { school, ownerUser, student } = await setup();
    const issued  = await makeIssuedInvoice(school, student, ownerUser, '5000');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '9000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );

    await expect(
      prisma.$transaction(tx =>
        createAllocation(tx, {
          paymentId: payment.id, invoiceId: issued.id,
          amount: '6000', // exceeds totalAmount 5000
          schoolId: school.id, actorId: ownerUser.id,
        }),
      ),
    ).rejects.toThrow('ALLOCATION_EXCEEDS_INVOICE_BALANCE');

    // Invoice must remain ISSUED and unpaid
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(inv.status).toBe('ISSUED');
    expect(new Prisma.Decimal(inv.paidAmount).eq(new Prisma.Decimal(0))).toBe(true);
  });

  it('cumulative allocations cannot exceed totalAmount', async () => {
    const { school, ownerUser, student } = await setup();
    const issued = await makeIssuedInvoice(school, student, ownerUser, '5000');

    const pmt1 = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '3000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    const pmt2 = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '3000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );

    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: pmt1.id, invoiceId: issued.id, amount: '3000', schoolId: school.id, actorId: ownerUser.id }),
    );

    // Remaining = 2000, attempting 3000 → should fail
    await expect(
      prisma.$transaction(tx =>
        createAllocation(tx, { paymentId: pmt2.id, invoiceId: issued.id, amount: '3000', schoolId: school.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('ALLOCATION_EXCEEDS_INVOICE_BALANCE');

    // Invoice stays at PARTIALLY_PAID with paidAmount=3000
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(inv.status).toBe('PARTIALLY_PAID');
    expect(new Prisma.Decimal(inv.paidAmount).eq(new Prisma.Decimal('3000'))).toBe(true);
  });
});

// ─── Payment void semantics ────────────────────────────────────────────────────

describe('payment — void semantics', () => {
  it('voiding a payment keeps allocations (audit trail) and drops paidAmount to zero', async () => {
    const { school, ownerUser, student } = await setup();
    const issued  = await makeIssuedInvoice(school, student, ownerUser, '5000');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '5000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: payment.id, invoiceId: issued.id, amount: '5000', schoolId: school.id, actorId: ownerUser.id }),
    );

    // Invoice is PAID before void
    const beforeVoid = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(beforeVoid.status).toBe('PAID');

    await prisma.$transaction(tx =>
      voidPayment(tx, { paymentId: payment.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    // Allocation still exists — immutable audit trail
    const allocs = await prisma.paymentAllocation.findMany({ where: { paymentId: payment.id } });
    expect(allocs).toHaveLength(1);

    // Invoice paidAmount recalculated from confirmed-only allocations (none now)
    const afterVoid = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(new Prisma.Decimal(afterVoid.paidAmount).eq(new Prisma.Decimal(0))).toBe(true);
    expect(afterVoid.status).toBe('ISSUED');
  });

  it('voiding one of two payments leaves the other credited', async () => {
    const { school, ownerUser, student } = await setup();
    const issued = await makeIssuedInvoice(school, student, ownerUser, '6000');

    const pmt1 = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '4000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    const pmt2 = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '2000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: pmt1.id, invoiceId: issued.id, amount: '4000', schoolId: school.id, actorId: ownerUser.id }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: pmt2.id, invoiceId: issued.id, amount: '2000', schoolId: school.id, actorId: ownerUser.id }),
    );

    // Void only pmt2
    await prisma.$transaction(tx =>
      voidPayment(tx, { paymentId: pmt2.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(new Prisma.Decimal(inv.paidAmount).eq(new Prisma.Decimal('4000'))).toBe(true);
    expect(inv.status).toBe('PARTIALLY_PAID');
  });

  it('cannot void an already-voided payment', async () => {
    const { school, ownerUser, student } = await setup();
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '1000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      voidPayment(tx, { paymentId: payment.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    await expect(
      prisma.$transaction(tx =>
        voidPayment(tx, { paymentId: payment.id, schoolId: school.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('PAYMENT_NOT_CONFIRMED');
  });
});

// ─── paidAmount consistency ────────────────────────────────────────────────────

describe('invoice — paidAmount consistency invariant', () => {
  it('paidAmount always equals SUM(confirmed allocations) after mixed void scenario', async () => {
    const { school, ownerUser, student } = await setup();
    const issued = await makeIssuedInvoice(school, student, ownerUser, '9000');

    const pmt1 = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '4000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    const pmt2 = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '2000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );

    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: pmt1.id, invoiceId: issued.id, amount: '4000', schoolId: school.id, actorId: ownerUser.id }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, { paymentId: pmt2.id, invoiceId: issued.id, amount: '2000', schoolId: school.id, actorId: ownerUser.id }),
    );

    // Void pmt2 — its allocation stays, but not counted
    await prisma.$transaction(tx =>
      voidPayment(tx, { paymentId: pmt2.id, schoolId: school.id, actorId: ownerUser.id }),
    );

    // Ground truth from DB
    const confirmedAllocs = await prisma.paymentAllocation.findMany({
      where:  { invoiceId: issued.id, payment: { status: 'CONFIRMED' } },
      select: { amount: true },
    });
    const trueSum = confirmedAllocs.reduce(
      (acc, a) => acc.plus(a.amount),
      new Prisma.Decimal(0),
    );

    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });

    // paidAmount in Invoice must exactly match ground truth
    expect(new Prisma.Decimal(inv.paidAmount).eq(trueSum)).toBe(true);
    expect(new Prisma.Decimal(inv.paidAmount).eq(new Prisma.Decimal('4000'))).toBe(true);
    expect(inv.status).toBe('PARTIALLY_PAID');
  });

  it('allocation to DRAFT invoice is rejected (must be ISSUED first)', async () => {
    const { school, ownerUser, student } = await setup();
    const inv = await prisma.$transaction(tx =>
      createDraft(tx, { schoolId: school.id, studentProfileId: student.id, createdById: ownerUser.id }),
    );
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '1000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );

    await expect(
      prisma.$transaction(tx =>
        createAllocation(tx, { paymentId: payment.id, invoiceId: inv.id, amount: '1000', schoolId: school.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('INVOICE_NOT_ISSUED');
  });

  it('allocation to VOID invoice is rejected', async () => {
    const { school, ownerUser, student } = await setup();
    const issued = await makeIssuedInvoice(school, student, ownerUser, '5000');
    await prisma.$transaction(tx =>
      voidInvoice(tx, { invoiceId: issued.id, schoolId: school.id, actorId: ownerUser.id }),
    );
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '1000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );

    await expect(
      prisma.$transaction(tx =>
        createAllocation(tx, { paymentId: payment.id, invoiceId: issued.id, amount: '1000', schoolId: school.id, actorId: ownerUser.id }),
      ),
    ).rejects.toThrow('INVOICE_IS_VOID');
  });
});

// ─── Cross-school isolation ────────────────────────────────────────────────────

describe('invoice — cross-school allocation rejected', () => {
  it('cannot allocate a payment from school1 to an invoice from school2', async () => {
    const { school, ownerUser, student } = await setup();

    const school2   = await createSchool({ timezone: 'UTC' });
    const owner2    = await createUser(school2.id, 'OWNER');
    const stuUser2  = await createUser(school2.id, 'STUDENT');
    const student2  = await createStudentProfile(stuUser2.id, school2.id, 0);
    const invoice2  = await makeIssuedInvoice(school2, student2, owner2, '5000');

    // Payment belongs to school1
    const payment1 = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '5000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );

    // Allocation attempt uses school1 — invoice2 is in school2, invisible
    await expect(
      prisma.$transaction(tx =>
        createAllocation(tx, {
          paymentId: payment1.id, invoiceId: invoice2.id,
          amount: '5000', schoolId: school.id, actorId: ownerUser.id,
        }),
      ),
    ).rejects.toThrow('INVOICE_NOT_FOUND');
  });
});

// ─── Allocation after void ─────────────────────────────────────────────────────

describe('invoice — allocation to PAID invoice blocked', () => {
  it('cannot allocate again after invoice is already fully paid', async () => {
    const { school, ownerUser, student } = await setup();
    const issued  = await makeIssuedInvoice(school, student, ownerUser, '3000');
    const pmt1    = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '3000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, {
        paymentId: pmt1.id, invoiceId: issued.id, amount: '3000', schoolId: school.id, actorId: ownerUser.id,
      }),
    );

    // Invoice is now PAID — second payment cannot be allocated
    const pmt2 = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '1000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await expect(
      prisma.$transaction(tx =>
        createAllocation(tx, {
          paymentId: pmt2.id, invoiceId: issued.id, amount: '1000', schoolId: school.id, actorId: ownerUser.id,
        }),
      ),
    ).rejects.toThrow('INVOICE_ALREADY_PAID');
  });
});

// ─── Decimal serialization stability ──────────────────────────────────────────

describe('invoice — decimal serialization stable', () => {
  it('paidAmount and totalAmount survive JSON round-trip without drift', async () => {
    const { school, ownerUser, student } = await setup();
    const issued  = await makeIssuedInvoice(school, student, ownerUser, '1234.56');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '1234.56', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, {
        paymentId: payment.id, invoiceId: issued.id, amount: '1234.56', schoolId: school.id, actorId: ownerUser.id,
      }),
    );

    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });

    // Simulate JSON serialization (as API would do)
    const serialized = JSON.stringify(inv);
    const parsed     = JSON.parse(serialized);

    // Amounts must round-trip without float drift
    expect(new Prisma.Decimal(parsed.totalAmount).eq(new Prisma.Decimal('1234.56'))).toBe(true);
    expect(new Prisma.Decimal(parsed.paidAmount).eq(new Prisma.Decimal('1234.56'))).toBe(true);
    expect(inv.status).toBe('PAID');
  });
});

// ─── Audit trail ──────────────────────────────────────────────────────────────

describe('invoice — audit events written', () => {
  it('INVOICE_CREATED, INVOICE_ISSUED, PAYMENT_CREATED, PAYMENT_ALLOCATED written to ScheduleActionLog', async () => {
    const { school, ownerUser, student } = await setup();
    const issued  = await makeIssuedInvoice(school, student, ownerUser, '2000');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '2000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, {
        paymentId: payment.id, invoiceId: issued.id, amount: '2000', schoolId: school.id, actorId: ownerUser.id,
      }),
    );

    const logs = await prisma.scheduleActionLog.findMany({
      where:   { schoolId: school.id },
      select:  { action: true, entityType: true },
      orderBy: { createdAt: 'asc' },
    });
    const actions = logs.map(l => l.action);
    expect(actions).toContain('INVOICE_CREATED');
    expect(actions).toContain('INVOICE_ISSUED');
    expect(actions).toContain('PAYMENT_CREATED');
    expect(actions).toContain('PAYMENT_ALLOCATED');

    // All finance logs should have entityType 'invoice', 'payment', or 'allocation'
    const financeTypes = new Set(['invoice', 'payment', 'allocation']);
    for (const log of logs) {
      if (log.entityType) expect(financeTypes.has(log.entityType)).toBe(true);
    }
  });
});

// ─── Check 14 catches mismatch ────────────────────────────────────────────────

describe('check14 — invoice.paidAmount vs SUM(confirmed allocs)', () => {
  it('detects diverged paidAmount and reports it as CRITICAL', async () => {
    const { school, ownerUser, student } = await setup();
    const { runChecks } = await import('../../services/consistencyCheckService');

    const issued  = await makeIssuedInvoice(school, student, ownerUser, '3000');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '3000', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, {
        paymentId: payment.id, invoiceId: issued.id, amount: '3000', schoolId: school.id, actorId: ownerUser.id,
      }),
    );

    // Manually corrupt paidAmount — simulates a bug that bypassed the service
    await prisma.invoice.update({
      where: { id: issued.id },
      data:  { paidAmount: '999' },
    });

    const violations = await runChecks(school.id, prisma as any);
    const check14   = violations.find(v => v.check.includes('paidAmount'));
    expect(check14).toBeDefined();
    expect(check14!.severity).toBe('CRITICAL');
    expect(check14!.ids).toContain(issued.id);
  });

  it('no false positives when paidAmount is correct', async () => {
    const { school, ownerUser, student } = await setup();
    const { runChecks } = await import('../../services/consistencyCheckService');

    const issued  = await makeIssuedInvoice(school, student, ownerUser, '1500');
    const payment = await prisma.$transaction(tx =>
      createPayment(tx, {
        schoolId: school.id, studentProfileId: student.id,
        amount: '1500', method: 'CASH', receivedById: ownerUser.id,
      }),
    );
    await prisma.$transaction(tx =>
      createAllocation(tx, {
        paymentId: payment.id, invoiceId: issued.id, amount: '1500', schoolId: school.id, actorId: ownerUser.id,
      }),
    );

    const violations = await runChecks(school.id, prisma as any);
    const check14   = violations.find(v => v.check.includes('paidAmount'));
    expect(check14).toBeUndefined();
  });
});
