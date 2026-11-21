import { Router } from 'express';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { dbIdempotency } from '../middleware/dbIdempotency';
import { recomputeAndPersistPaidUntil } from '../lib/paidUntilDerivation';
import { createLogger } from '../lib/logger';
import { sendLifecycleError } from '../lib/routeError';

const log = createLogger('credits');
const router = Router();

// POST /api/credits/add — Add or deduct credits
// Requires Idempotency-Key header (financial op — must be idempotent).
// Negative balance protection:
//   - ADMIN: atomic conditional SQL — rejects if balance would go negative.
//   - OWNER/SUPERADMIN: may pass overrideReason to bypass the guard (audit required).
router.post(
  '/add',
  authenticate,
  dbIdempotency({ required: true }),
  requirePermission('finance:write'),
  async (req: AuthRequest, res) => {
    try {
      const {
        studentProfileId,
        amount,
        reason,
        paymentAmount,
        paymentMethod,
        refundedLogId,
        overrideReason,
      } = req.body;

      if (!studentProfileId || typeof amount !== 'number' || !reason) {
        return res.status(400).json({ success: false, error: 'Invalid input. Missing required fields.' });
      }
      // Кредиты — целые уроки: дробное/NaN/за пределами разумного — это ошибка ввода,
      // отвечаем 400, а не 500 из Prisma.
      if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000) {
        return res.status(400).json({ success: false, error: 'amount must be a non-zero integer within ±10,000' });
      }
      if (refundedLogId != null && amount <= 0) {
        return res.status(400).json({ success: false, error: 'Refund amount must be positive' });
      }
      if (paymentAmount != null && (!Number.isFinite(Number(paymentAmount)) || Number(paymentAmount) < 0 || Number(paymentAmount) > 10_000_000)) {
        return res.status(400).json({ success: false, error: 'paymentAmount must be a non-negative number up to 10,000,000' });
      }

      const schoolId = req.user!.schoolId!;
      const profileId = parseInt(studentProfileId, 10);
      const actorRole = req.user!.role;

      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
      if (idempotencyKey) {
        const existingLog = await prisma.lessonCreditLog.findFirst({
          where: { schoolId, idempotencyKey },
          include: { payment: true }
        });
        if (existingLog) {
          // Use the profile from the original logged operation, not the replay
          // request's body — studentProfileId in the body is caller-supplied and
          // unscoped by schoolId, so trusting it here would let a replay with a
          // guessed/foreign id leak another school's student's credit balance.
          const updatedProfile = await prisma.studentProfile.findFirst({
            where: { id: existingLog.studentProfileId, user: { schoolId } },
            select: { id: true, credits: true },
          });
          const body = {
            success: true,
            data: {
              log: existingLog,
              updatedProfile,
              payment: existingLog.payment,
            }
          };
          await req.completeIdempotency?.(200, body);
          return res.json(body);
        }
      }

      // OWNER/SUPERADMIN can override the negative-balance guard with an explicit audit reason.
      const ownerOverride =
        amount < 0 &&
        (actorRole === 'OWNER' || actorRole === 'SUPERADMIN') &&
        typeof overrideReason === 'string' &&
        overrideReason.trim().length > 0;

      const result = await prisma.$transaction(async (tx) => {
        // Tenant safety: verify student belongs to the requesting school
        const studentProfile = await tx.studentProfile.findFirst({
          where: { id: profileId, user: { schoolId }, deletedAt: null },
        });

        if (!studentProfile) throw new Error('Student profile not found');

        // Validate refund target belongs to the same student
        if (refundedLogId != null) {
          const originalLog = await tx.lessonCreditLog.findFirst({
            where: { id: parseInt(refundedLogId, 10), studentProfileId: profileId },
            include: { issuance: { select: { id: true } } },
          });
          if (!originalLog) throw new Error('REFUND_TARGET_NOT_FOUND');
          // ponytail: CreditIssuance logs must be reversed via the dedicated reversal endpoint
          if (originalLog.issuance) throw new Error('USE_REFUND_ENDPOINT');
        }

        // Infer ledger type from context: linked refund > sign of amount
        const logType =
          refundedLogId != null ? 'REFUND'
          : amount > 0          ? 'MANUAL_ADD'
          :                       'MANUAL_DEDUCT';

        // ── Atomic balance update ──────────────────────────────────────────────
        // For deductions: conditional SQL prevents negative balance at DB level.
        // A row count of 0 means the balance would have gone negative → reject.
        // Owner override bypasses the guard but requires audit reason (logged below).
        if (amount < 0 && !ownerOverride) {
          const rowsUpdated: number = await tx.$executeRaw`
            UPDATE "StudentProfile"
            SET credits = credits + ${amount}
            WHERE id = ${profileId}
              AND (credits + ${amount}) >= 0
          `;
          if (rowsUpdated === 0) {
            throw new Error('INSUFFICIENT_CREDITS');
          }
        } else {
          await tx.studentProfile.update({
            where: { id: profileId },
            data: { credits: { increment: amount } },
          });
        }

        // Fetch updated balance for response (needed in both code paths above)
        const updatedProfile = await tx.studentProfile.findUnique({
          where: { id: profileId },
          select: { id: true, credits: true },
        });

        const creditLog = await tx.lessonCreditLog.create({
          data: {
            schoolId,
            studentProfileId: profileId,
            amount,
            reason: ownerOverride ? `[OWNER_OVERRIDE: ${overrideReason}] ${reason}` : reason,
            type:    logType,
            actorId: req.user!.userId,
            idempotencyKey: idempotencyKey ?? null,
            ...(refundedLogId != null && { refundedLogId: parseInt(refundedLogId, 10) }),
          },
        });

        // Purchase payment record (credit top-up with explicit payment)
        let payment = null;
        if (amount > 0 && paymentAmount != null && refundedLogId == null) {
          const paid = parseFloat(paymentAmount);
          payment = await tx.studentPayment.create({
            data: {
              schoolId,
              studentProfileId: profileId,
              creditsAdded:   amount,
              amount:         paid,
              pricePerCredit: paid / amount,
              method:         paymentMethod ?? 'CASH',
              note:           reason,
              createdById:    req.user!.userId,
              idempotencyKey: idempotencyKey ?? null,
            },
          });
        }

        // Balance changed → re-derive the display-only paidUntil from the new balance.
        await recomputeAndPersistPaidUntil(tx, profileId, schoolId);

        return { log: creditLog, updatedProfile, payment };
      });

      // FINAL PATCH 3: completeIdempotency called ONLY after prisma.$transaction() returns.
      // This guarantees COMPLETED is never written before the DB commit.
      const responseBody = { success: true, data: result };
      await req.completeIdempotency?.(200, responseBody);
      return res.json(responseBody);
    } catch (error: any) {
      log.error({ err: error }, 'add credits error');
      // Mark key FAILED so client can safely retry with the same key
      await req.failIdempotency?.();

      if (error.message === 'INSUFFICIENT_CREDITS') {
        return res.status(422).json({
          success: false,
          error: 'Insufficient credits — balance would go negative. Use overrideReason as OWNER to allow debt.',
          code:  'INSUFFICIENT_CREDITS',
        });
      }
      if (error.message === 'USE_REFUND_ENDPOINT') {
        return res.status(400).json({
          success: false,
          error: 'This credit log was issued via CreditIssuance. Use the dedicated reversal endpoint.',
          code:  'USE_REFUND_ENDPOINT',
        });
      }
      return sendLifecycleError(res, error, 'Failed to add credits');
    }
  }
);

// GET /api/credits/history/:studentProfileId — credit ledger for one student
router.get('/history/:studentProfileId', requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const { studentProfileId } = req.params;

    if (!studentProfileId) {
      return res.status(400).json({ success: false, error: 'Invalid profile ID' });
    }

    const profileId = parseInt(studentProfileId, 10);
    const schoolId  = req.user!.schoolId!;

    // Tenant safety: ensure the student belongs to this school
    const profile = await prisma.studentProfile.findFirst({
      where: { id: profileId, user: { schoolId }, deletedAt: null },
      select: { id: true },
    });
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    const logs = await prisma.lessonCreditLog.findMany({
      where:   { studentProfileId: profileId, schoolId },
      orderBy: { createdAt: 'desc' },
      include: {
        actor:       { select: { firstName: true, lastName: true } },
        refundedLog: { select: { id: true, sessionId: true, reason: true, amount: true } },
        refunds:     { select: { id: true, reason: true, createdAt: true } },
      },
    });

    return res.json({ success: true, data: logs });
  } catch (error) {
    log.error({ err: error }, 'fetch credit history error');
    return res.status(500).json({ success: false, error: 'Failed to fetch credit history' });
  }
});

// ─── Monthly roll-forward statement over the credit ledger ────────────────────
// opening (sum before month) + added − deducted = closing.
// The schedule must foot; if profile.credits diverges from the full ledger sum,
// the discrepancy is surfaced (foots=false) — never plugged.
// Month boundaries are midnight-to-midnight in the school's timezone.

class BadMonthError extends Error {}

async function buildCreditStatement(profileId: number, schoolId: number, monthParam: string) {
  // Tenant safety + school timezone in one query
  const profile = await prisma.studentProfile.findFirst({
    where: { id: profileId, user: { schoolId }, deletedAt: null },
    select: {
      id: true,
      credits: true,
      user: { select: { school: { select: { timezone: true } } } },
    },
  });
  if (!profile) return null;
  const tz = profile.user.school?.timezone || 'UTC';

  const m = /^(\d{4})-(\d{2})$/.exec(monthParam);
  let year: number, month: number;
  if (m) {
    year  = parseInt(m[1], 10);
    month = parseInt(m[2], 10);
    if (month < 1 || month > 12) throw new BadMonthError('month must be YYYY-MM');
  } else {
    // Default: the current month as the school sees it, not as UTC sees it
    [year, month] = formatInTimeZone(new Date(), tz, 'yyyy-MM').split('-').map(Number);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const monthStart = fromZonedTime(`${year}-${pad(month)}-01T00:00:00`, tz);
  const monthEnd   = month === 12
    ? fromZonedTime(`${year + 1}-01-01T00:00:00`, tz)
    : fromZonedTime(`${year}-${pad(month + 1)}-01T00:00:00`, tz);

  const ledgerWhere = { studentProfileId: profileId, schoolId };
  const [openingAgg, totalAgg, lines] = await Promise.all([
    prisma.lessonCreditLog.aggregate({
      where: { ...ledgerWhere, createdAt: { lt: monthStart } },
      _sum: { amount: true },
    }),
    prisma.lessonCreditLog.aggregate({
      where: ledgerWhere,
      _sum: { amount: true },
    }),
    prisma.lessonCreditLog.findMany({
      where:   { ...ledgerWhere, createdAt: { gte: monthStart, lt: monthEnd } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, amount: true, reason: true, type: true, sessionId: true, createdAt: true,
        actor:   { select: { firstName: true, lastName: true } },
        session: { select: { date: true } },
      },
    }),
  ]);

  const opening  = openingAgg._sum.amount ?? 0;
  const added    = lines.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0);
  const deducted = lines.reduce((s, l) => s + (l.amount < 0 ? l.amount : 0), 0);
  const closing  = opening + added + deducted;
  const ledgerBalance  = totalAgg._sum.amount ?? 0;
  const profileBalance = profile.credits;

  return {
    month: `${year}-${pad(month)}`,
    opening,
    added,
    deducted,
    closing,
    ledgerBalance,
    profileBalance,
    foots: ledgerBalance === profileBalance,
    lines: lines.map(l => ({
      id:        l.id,
      date:      l.createdAt.toISOString(),
      amount:    l.amount,
      reason:    l.reason,
      type:      l.type,
      sessionId: l.sessionId,
      sessionDate: l.session?.date?.toISOString() ?? null,
      actorName: l.actor ? `${l.actor.firstName} ${l.actor.lastName}` : null,
    })),
  };
}

// GET /api/credits/statement/:studentProfileId?month=YYYY-MM — admin/owner view
router.get('/statement/:studentProfileId', requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const profileId = parseInt(req.params.studentProfileId, 10);
    if (!Number.isInteger(profileId)) {
      return res.status(400).json({ success: false, error: 'Invalid profile ID' });
    }
    const monthParam = typeof req.query.month === 'string' ? req.query.month : '';
    const data = await buildCreditStatement(profileId, req.user!.schoolId!, monthParam);
    if (!data) return res.status(404).json({ success: false, error: 'Student not found' });
    return res.json({ success: true, data });
  } catch (error) {
    if (error instanceof BadMonthError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    log.error({ err: error }, 'build credit statement error');
    return res.status(500).json({ success: false, error: 'Failed to build credit statement' });
  }
});

// GET /api/credits/my-statement?month=YYYY-MM — student's own statement.
// Self-scoped by construction: the profile is resolved from the JWT userId,
// so no finance:read permission is needed and no foreign id is accepted.
router.get('/my-statement', async (req: AuthRequest, res) => {
  try {
    const profile = await prisma.studentProfile.findFirst({
      where: { userId: req.user!.userId, deletedAt: null },
      select: { id: true },
    });
    if (!profile) return res.status(404).json({ success: false, error: 'Student profile not found' });

    const monthParam = typeof req.query.month === 'string' ? req.query.month : '';
    const data = await buildCreditStatement(profile.id, req.user!.schoolId!, monthParam);
    if (!data) return res.status(404).json({ success: false, error: 'Student not found' });
    return res.json({ success: true, data });
  } catch (error) {
    if (error instanceof BadMonthError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    log.error({ err: error }, 'build credit statement error');
    return res.status(500).json({ success: false, error: 'Failed to build credit statement' });
  }
});

// GET /api/credits/logs — all credit logs for the school
router.get('/logs', authenticate, requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;

    const logs = await prisma.lessonCreditLog.findMany({
      where: { studentProfile: { user: { schoolId } } },
      orderBy: { createdAt: 'desc' },
      include: {
        studentProfile: {
          include: {
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
    });

    return res.json({ success: true, data: logs });
  } catch (error) {
    log.error({ err: error }, 'fetch credit logs error');
    return res.status(500).json({ success: false, error: 'Failed to fetch credit logs' });
  }
});

export default router;
