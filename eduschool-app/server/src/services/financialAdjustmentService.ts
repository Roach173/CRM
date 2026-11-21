import { FinancialAdjustmentType, Prisma, PrismaClient } from '@prisma/client';
import { logFinanceAction } from '../lib/auditLog';
import { recomputeAndPersistPaidUntil } from '../lib/paidUntilDerivation';

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export async function createFinancialAdjustment(
  tx: PrismaTx,
  params: {
    schoolId: number;
    studentProfileId: number;
    type: FinancialAdjustmentType;
    reason: string;
    createdById: number;
    amountCredits?: number;
    amountMoney?: string | number;
  },
) {
  if (!params.reason.trim()) throw new Error('ADJUSTMENT_REASON_REQUIRED');

  const profile = await tx.studentProfile.findFirst({
    where: { id: params.studentProfileId, user: { schoolId: params.schoolId }, deletedAt: null },
    select: { id: true },
  });
  if (!profile) throw new Error('STUDENT_NOT_FOUND');

  const amountCredits = params.amountCredits ?? null;
  if (
    ['CREDIT_GRANT', 'CREDIT_DEDUCT'].includes(params.type) &&
    (amountCredits == null || amountCredits <= 0)
  ) {
    throw new Error('ADJUSTMENT_CREDITS_MUST_BE_POSITIVE');
  }

  let lessonCreditLogId: number | undefined;
  if (params.type === 'CREDIT_GRANT' || params.type === 'CREDIT_DEDUCT') {
    const signedAmount = params.type === 'CREDIT_GRANT' ? amountCredits! : -amountCredits!;
    const log = await tx.lessonCreditLog.create({
      data: {
        schoolId: params.schoolId,
        studentProfileId: params.studentProfileId,
        amount: signedAmount,
        type: params.type === 'CREDIT_GRANT' ? 'MANUAL_ADD' : 'MANUAL_DEDUCT',
        reason: params.reason,
        actorId: params.createdById,
      },
    });
    lessonCreditLogId = log.id;

    await tx.studentProfile.update({
      where: { id: params.studentProfileId },
      data: { credits: { increment: signedAmount } },
    });

    // Balance changed → refresh the derived paidUntil display date.
    await recomputeAndPersistPaidUntil(tx, params.studentProfileId, params.schoolId);
  }

  const adjustment = await tx.financialAdjustment.create({
    data: {
      schoolId: params.schoolId,
      studentProfileId: params.studentProfileId,
      type: params.type,
      amountCredits,
      amountMoney: params.amountMoney != null ? new Prisma.Decimal(String(params.amountMoney)) : undefined,
      reason: params.reason,
      createdById: params.createdById,
      lessonCreditLogId,
    },
  });

  await logFinanceAction({
    client: tx as unknown as PrismaClient,
    schoolId: params.schoolId,
    userId: params.createdById,
    action: 'FINANCIAL_ADJUSTMENT_CREATED',
    entityType: 'adjustment',
    entityId: adjustment.id,
    after: {
      type: params.type,
      amountCredits,
      amountMoney: params.amountMoney != null ? String(params.amountMoney) : null,
      lessonCreditLogId: lessonCreditLogId ?? null,
    },
  });

  return adjustment;
}
