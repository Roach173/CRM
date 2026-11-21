/**
 * One-time migration: moves activeDays from school.settings JSON → School.activeDays column.
 *
 *   npx tsx src/scripts/migrateActiveDays.ts
 */

import prisma from '../lib/prisma';

async function main() {
  const schools = await prisma.school.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, settings: true, activeDays: true },
  });

  for (const school of schools) {
    const sett = (school.settings ?? {}) as Record<string, unknown>;
    const jsonDays = sett.activeDays;

    const days: number[] =
      Array.isArray(jsonDays) && jsonDays.every(d => typeof d === 'number')
        ? (jsonDays as number[]).filter(d => d >= 0 && d <= 6).sort()
        : [0, 1, 2, 3, 4, 5]; // Mon–Sat default

    // Remove activeDays from JSON blob
    const { activeDays: _removed, ...restSettings } = sett as any;

    await prisma.school.update({
      where: { id: school.id },
      data: {
        activeDays: days,
        settings: restSettings,
      },
    });

    console.log(`School [${school.id}] "${school.name}": activeDays = [${days.join(',')}]`);
  }

  console.log('Done.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
