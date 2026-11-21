/**
 * Emergency credit reconciliation script.
 *
 * Rebuilds StudentProfile.credits by summing all LessonCreditLog entries.
 * Run this if credits become inconsistent (e.g. after a failed migration,
 * manual DB edit, or suspected data corruption).
 *
 * Usage:
 *   npx tsx scripts/rebuild-credits.ts            # all schools
 *   npx tsx scripts/rebuild-credits.ts 3          # school id = 3
 *   npx tsx scripts/rebuild-credits.ts 3 --dry    # preview only, no writes
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const schoolIdArg = args.find(a => /^\d+$/.test(a));
  const dryRun = args.includes('--dry');

  const schoolId = schoolIdArg ? parseInt(schoolIdArg) : undefined;

  console.log(`\n=== Credit Rebuild ${dryRun ? '[DRY RUN]' : '[LIVE]'} ===`);
  if (schoolId) console.log(`School filter: ${schoolId}`);
  console.log('');

  // Get all students (optionally filtered by school via User relation)
  const students = await prisma.studentProfile.findMany({
    where: {
      deletedAt: null,
      ...(schoolId
        ? { user: { schoolId } }
        : {}),
    },
    select: { id: true, credits: true, user: { select: { schoolId: true, firstName: true, lastName: true } } },
    orderBy: { id: 'asc' },
  });

  console.log(`Found ${students.length} student profiles to check.\n`);

  let changed = 0;
  let errors = 0;

  for (const student of students) {
    try {
      const result = await prisma.lessonCreditLog.aggregate({
        where: { studentProfileId: student.id },
        _sum: { amount: true },
      });

      const correctBalance = result._sum.amount ?? 0;
      const currentBalance = student.credits;
      const diff = correctBalance - currentBalance;

      if (diff !== 0) {
        changed++;
        const name = `${student.user.firstName} ${student.user.lastName}`;
        console.log(
          `[MISMATCH] profile #${student.id} (${name}, school #${student.user.schoolId}): ` +
          `current=${currentBalance}, correct=${correctBalance}, diff=${diff > 0 ? '+' : ''}${diff}`
        );

        if (!dryRun) {
          await prisma.studentProfile.update({
            where: { id: student.id },
            data: { credits: correctBalance },
          });
        }
      }
    } catch (err: any) {
      errors++;
      console.error(`[ERROR] profile #${student.id}: ${err.message}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total checked : ${students.length}`);
  console.log(`Mismatches    : ${changed}`);
  console.log(`Errors        : ${errors}`);
  if (dryRun && changed > 0) {
    console.log('\nRun without --dry to apply corrections.');
  }
  if (!dryRun && changed > 0) {
    console.log(`\n✅ ${changed} profiles updated.`);
  }
  if (changed === 0) {
    console.log('\n✅ All credits are consistent — nothing to fix.');
  }
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
