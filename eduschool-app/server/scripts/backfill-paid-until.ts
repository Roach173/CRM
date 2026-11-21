/**
 * paidUntil backfill / reconciliation script.
 *
 * Recomputes the derived StudentProfile.paidUntil for every student from their
 * current balance (credits) using each school's active billingMode. Run once
 * after deploying the "balance = source of truth" change, or any time paidUntil
 * dates look stale. Idempotent — a second run reports 0 changes.
 *
 * Usage:
 *   npx tsx scripts/backfill-paid-until.ts            # all schools
 *   npx tsx scripts/backfill-paid-until.ts 3          # school id = 3
 *   npx tsx scripts/backfill-paid-until.ts 3 --dry    # preview only, no writes
 */

import { PrismaClient } from '@prisma/client';
import { recomputePaidUntilForSchool } from '../src/lib/paidUntilDerivation';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const schoolIdArg = args.find(a => /^\d+$/.test(a));
  const dryRun = args.includes('--dry');
  const schoolId = schoolIdArg ? parseInt(schoolIdArg) : undefined;

  console.log(`\n=== paidUntil Backfill ${dryRun ? '[DRY RUN]' : '[LIVE]'} ===`);
  if (schoolId) console.log(`School filter: ${schoolId}`);
  console.log('');

  const schools = await prisma.school.findMany({
    where: { deletedAt: null, ...(schoolId ? { id: schoolId } : {}) },
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });

  console.log(`Found ${schools.length} school(s) to process.\n`);

  let totalChecked = 0;
  let totalChanged = 0;

  for (const school of schools) {
    try {
      const { checked, changed } = await recomputePaidUntilForSchool(prisma, school.id, { dryRun });
      totalChecked += checked;
      totalChanged += changed;
      console.log(`School #${school.id} (${school.name}): checked=${checked}, ${dryRun ? 'would change' : 'changed'}=${changed}`);
    } catch (err: any) {
      console.error(`[ERROR] school #${school.id}: ${err.message}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Schools processed : ${schools.length}`);
  console.log(`Students checked   : ${totalChecked}`);
  console.log(`${dryRun ? 'Would change' : 'Changed'}       : ${totalChanged}`);
  if (dryRun && totalChanged > 0) {
    console.log('\nRun without --dry to apply.');
  }
  if (totalChanged === 0) {
    console.log('\n✅ All paidUntil dates already aligned with balances.');
  }
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
