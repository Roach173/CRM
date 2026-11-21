import { PrismaClient } from '@prisma/client';
import { createLogger } from './logger';
import { runChecks, Violation } from '../services/consistencyCheckService';

export interface RepairContext {
  dryRun: boolean;
  schoolId?: number;
  log: ReturnType<typeof createLogger>;
  prisma: PrismaClient;
}

export async function createRepairContext(domain: string): Promise<RepairContext> {
  const dryRun = process.env.DRY_RUN !== 'false';
  const schoolId = process.env.SCHOOL_ID ? parseInt(process.env.SCHOOL_ID) : undefined;
  const log = createLogger(domain);
  const prisma = new PrismaClient();
  return { dryRun, schoolId, log, prisma };
}

export async function runRepair(
  ctx: RepairContext,
  name: string,
  fn: (ctx: RepairContext) => Promise<{ affected: number; detail?: string[] }>
): Promise<void> {
  const { dryRun, schoolId, log, prisma } = ctx;

  log.info({ event: 'REPAIR_START', name, dryRun, schoolId }, `Starting repair: ${name}`);

  let preViolations: Violation[] = [];
  if (!dryRun && schoolId) {
    try {
      preViolations = await runChecks(schoolId, prisma);
      log.info({ event: 'PRE_CHECK', name, violations: preViolations.length },
        `Pre-repair consistency check: ${preViolations.length} violation(s)`);
    } catch (err: any) {
      log.warn({ event: 'PRE_CHECK_FAILED', name, err: err.message },
        'Pre-repair consistency check threw — continuing');
    }
  }

  let result: { affected: number; detail?: string[] };
  try {
    result = await fn(ctx);
  } catch (err: any) {
    log.error({ event: 'REPAIR_ERROR', name, err: err.message }, `Repair failed: ${name}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  if (!dryRun && schoolId) {
    try {
      const postViolations = await runChecks(schoolId, prisma);
      const resolved = preViolations.length - postViolations.length;
      log.info({ event: 'POST_CHECK', name, before: preViolations.length,
        after: postViolations.length, resolved },
        `Post-repair consistency check: ${postViolations.length} violation(s) remaining`);
    } catch (err: any) {
      log.warn({ event: 'POST_CHECK_FAILED', name, err: err.message },
        'Post-repair consistency check threw');
    }
  }

  log.info({ event: 'REPAIR_COMPLETE', name, dryRun, affected: result.affected },
    dryRun ? `DRY RUN complete — no changes made (would affect ${result.affected})` : `Repair complete: ${result.affected} record(s) affected`);

  await prisma.$disconnect();
}
