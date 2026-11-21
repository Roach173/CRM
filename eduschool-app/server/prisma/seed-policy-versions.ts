/**
 * seed-policy-versions.ts
 *
 * One-time backfill script: reconstructs SchoolSchedulePolicy history from SchoolPolicyLog
 * for each school that has no policy versions, or reconciles effectiveTo gaps.
 *
 * Run: npx tsx prisma/seed-policy-versions.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const schools = await prisma.school.findMany({
    where: { deletedAt: null },
    select: { id: true, activeDays: true, workStart: true, workEnd: true, slotDuration: true, createdAt: true },
  });

  for (const school of schools) {
    console.log(`\nProcessing school ${school.id}...`);

    // Check for existing policy versions
    const existingVersions = await prisma.schoolSchedulePolicy.findMany({
      where: { schoolId: school.id },
      orderBy: { effectiveFrom: 'asc' },
    });

    // Get audit log sorted chronologically
    const logs = await prisma.schoolPolicyLog.findMany({
      where: { schoolId: school.id },
      orderBy: { changedAt: 'asc' },
    });

    if (existingVersions.length === 0) {
      // No versions at all — reconstruct from audit log
      if (logs.length === 0) {
        // No history either — create single version from current settings
        await prisma.schoolSchedulePolicy.create({
          data: {
            schoolId: school.id,
            activeDays: school.activeDays.length > 0 ? school.activeDays : [0, 1, 2, 3, 4],
            workStart: school.workStart,
            workEnd: school.workEnd,
            slotDuration: school.slotDuration,
            effectiveFrom: school.createdAt,
            effectiveTo: null,
            createdById: 0,
          },
        });
        console.log(`  Created initial policy version (no log history)`);
      } else {
        // Reconstruct from log entries
        for (let i = 0; i < logs.length; i++) {
          const log = logs[i];
          const nextLog = logs[i + 1];
          await prisma.schoolSchedulePolicy.create({
            data: {
              schoolId: school.id,
              activeDays: log.activeDays,
              workStart: log.workStart,
              workEnd: log.workEnd,
              slotDuration: log.slotDuration,
              effectiveFrom: i === 0 ? school.createdAt : log.changedAt,
              effectiveTo: nextLog ? nextLog.changedAt : null,
              createdById: log.changedById,
            },
          });
        }
        console.log(`  Reconstructed ${logs.length} policy versions from audit log`);
      }
    } else {
      // Versions exist — just ensure the latest one has effectiveTo = null
      const latest = existingVersions[existingVersions.length - 1];
      if (latest.effectiveTo !== null) {
        await prisma.schoolSchedulePolicy.update({
          where: { id: latest.id },
          data: { effectiveTo: null },
        });
        console.log(`  Fixed: latest version had non-null effectiveTo`);
      }

      // Close gaps between consecutive versions
      for (let i = 0; i < existingVersions.length - 1; i++) {
        const current = existingVersions[i];
        const next = existingVersions[i + 1];
        if (current.effectiveTo === null || current.effectiveTo > next.effectiveFrom) {
          await prisma.schoolSchedulePolicy.update({
            where: { id: current.id },
            data: { effectiveTo: next.effectiveFrom },
          });
          console.log(`  Closed interval for version ${current.id}`);
        }
      }

      console.log(`  ${existingVersions.length} existing versions reconciled`);
    }
  }

  console.log('\nBackfill complete.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
