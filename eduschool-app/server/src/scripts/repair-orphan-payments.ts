/**
 * One-time data repair: deletes TeacherPayment records that have no
 * TeacherPaymentLesson links (orphaned by the block-delete bug).
 *
 * Run from eduschool-app/server/:
 *   npx tsx src/scripts/repair-orphan-payments.ts
 *
 * Set DRY_RUN=false to actually delete:
 *   DRY_RUN=false npx tsx src/scripts/repair-orphan-payments.ts
 *
 * Optionally scope to one school:
 *   SCHOOL_ID=3 DRY_RUN=false npx tsx src/scripts/repair-orphan-payments.ts
 */
import 'dotenv/config';
import { createRepairContext, runRepair } from '../lib/repairBase';

async function main() {
  const ctx = await createRepairContext('repair-orphan-payments');

  await runRepair(ctx, 'orphan-payments', async ({ dryRun, schoolId, prisma, log }) => {
    const orphans = await prisma.teacherPayment.findMany({
      where: {
        ...(schoolId ? { schoolId } : {}),
        sessions: { none: {} },
        // Voided payments legitimately have no lesson links — they are an
        // audit trail, not orphans.
        status: { not: 'VOIDED' },
      },
      select: {
        id: true, schoolId: true, staffProfileId: true,
        period: true, lessonsCount: true, amount: true, paidAt: true,
      },
    });

    log.info({ event: 'ORPHANS_FOUND', count: orphans.length },
      `Found ${orphans.length} orphaned TeacherPayment record(s)`);

    for (const p of orphans) {
      log.info({ event: 'ORPHAN_DETAIL', paymentId: p.id, schoolId: p.schoolId,
        staffProfileId: p.staffProfileId, period: p.period,
        lessonsCount: p.lessonsCount, amount: Number(p.amount),
        paidAt: p.paidAt.toISOString() });
    }

    if (dryRun || orphans.length === 0) return { affected: orphans.length };

    const { count } = await prisma.teacherPayment.deleteMany({
      where: { id: { in: orphans.map(p => p.id) } },
    });
    return { affected: count };
  });
}

main();
