/**
 * Phase 5 — DB Invariant Pre-Check
 *
 * Run this script BEFORE applying migration
 * 20260527030000_phase5_db_invariants.
 *
 * If it exits with code 1, repair all BLOCKER violations first.
 *
 * Usage (from eduschool-app/server/):
 *   npx tsx scripts/precheck-db-invariants.ts
 *
 * Exit code 0 = clean, safe to migrate.
 * Exit code 1 = BLOCKER violations found.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { runDbInvariantPrecheck, InvariantViolation } from '../src/services/dbInvariantService';

const prisma = new PrismaClient();

function printSummary(violations: InvariantViolation[]): void {
  const blockers = violations.filter(v => v.severity === 'BLOCKER');
  const warnings = violations.filter(v => v.severity === 'WARNING');

  const bar = '─'.repeat(70);

  console.log(`\n┌${bar}┐`);
  console.log(`│  Phase 5 DB Invariant Pre-Check${' '.repeat(38)}│`);
  console.log(`│  ${violations.length === 0 ? '✅  No violations' : `❌  ${blockers.length} BLOCKER(s), ⚠️  ${warnings.length} WARNING(s)`}${' '.repeat(Math.max(0, 67 - (violations.length === 0 ? 17 : 10 + String(blockers.length).length + String(warnings.length).length)))}│`);
  console.log(`└${bar}┘\n`);

  if (violations.length === 0) {
    return;
  }

  if (blockers.length > 0) {
    console.log(`❌  BLOCKERS — migration cannot proceed until repaired:\n`);
    for (const v of blockers) {
      console.log(`  check:    ${v.check}`);
      console.log(`  count:    ${v.count}`);
      console.log(`  samples:  [${v.sampleIds.slice(0, 5).join(', ')}]`);
      console.log(`  repair:   ${v.repairStrategy}`);
      console.log();
    }
  }

  if (warnings.length > 0) {
    console.log(`⚠️   WARNINGS:\n`);
    for (const v of warnings) {
      console.log(`  check:   ${v.check}`);
      console.log(`  count:   ${v.count}`);
      console.log(`  samples: [${v.sampleIds.slice(0, 5).join(', ')}]`);
      console.log(`  repair:  ${v.repairStrategy}`);
      console.log();
    }
  }
}

async function main(): Promise<void> {
  console.log('\n🔍  Running Phase 5 DB Invariant Pre-Check...\n');

  const violations = await runDbInvariantPrecheck(prisma);
  printSummary(violations);

  const blockers = violations.filter(v => v.severity === 'BLOCKER');
  if (blockers.length > 0) {
    console.log(
      '❌  Cannot proceed. Repair all BLOCKER violations before applying\n' +
      '    migration 20260527030000_phase5_db_invariants.\n'
    );
    process.exit(1);
  }

  console.log('✅  Precheck passed. Safe to apply Phase 5 migration.\n');
  process.exit(0);
}

main()
  .catch(err => {
    console.error('\nFatal error during precheck:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
