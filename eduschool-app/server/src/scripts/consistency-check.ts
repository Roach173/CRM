/**
 * DB consistency checker — validates all forbidden states from SYSTEM_BLUEPRINT Section 5b.
 *
 * Run from eduschool-app/server/:
 *   npx tsx src/scripts/consistency-check.ts
 *
 * Optionally scope to one school:
 *   SCHOOL_ID=3 npx tsx src/scripts/consistency-check.ts
 *
 * Exit code 0 = clean. Exit code 1 = CRITICAL violations found.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { runChecks, Violation } from '../services/consistencyCheckService';

const prisma = new PrismaClient();
const SCHOOL_ID = process.env.SCHOOL_ID ? parseInt(process.env.SCHOOL_ID) : undefined;

function printResults(violations: Violation[], scope: string) {
  if (violations.length === 0) {
    console.log(`✅  All checks passed — no forbidden states found (${scope}).\n`);
    return;
  }

  const critical = violations.filter(v => v.severity === 'CRITICAL');
  const warnings = violations.filter(v => v.severity === 'WARNING');

  if (critical.length > 0) {
    console.log(`❌  CRITICAL violations (${critical.length}):\n`);
    for (const v of critical) {
      console.log(`  [CRITICAL] ${v.check}`);
      console.log(`             count=${v.count}  sample_ids=${JSON.stringify(v.ids)}\n`);
    }
  }
  if (warnings.length > 0) {
    console.log(`⚠️   Warnings (${warnings.length}):\n`);
    for (const v of warnings) {
      console.log(`  [WARNING]  ${v.check}`);
      console.log(`             count=${v.count}  sample_ids=${JSON.stringify(v.ids)}\n`);
    }
  }
}

async function main() {
  if (SCHOOL_ID) {
    console.log(`\n🔍  Shamdan consistency check — school ${SCHOOL_ID}\n`);
    const violations = await runChecks(SCHOOL_ID, prisma);
    printResults(violations, `school ${SCHOOL_ID}`);
    process.exit(violations.some(v => v.severity === 'CRITICAL') ? 1 : 0);
  }

  // No SCHOOL_ID — run for all active schools
  console.log(`\n🔍  Shamdan consistency check — all schools\n`);
  const schools = await prisma.school.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  const allViolations: Violation[] = [];
  for (const school of schools) {
    const v = await runChecks(school.id, prisma);
    allViolations.push(...v);
  }

  printResults(allViolations, `${schools.length} schools`);
  process.exit(allViolations.some(v => v.severity === 'CRITICAL') ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
