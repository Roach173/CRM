import prisma from '../lib/prisma';

async function main() {
  // 1. Orphan blocks: block alive but group soft-deleted
  const orphans = await prisma.lessonBlock.findMany({
    where: {
      deletedAt: null,
      studentGroupId: { not: null },
      studentGroup: { deletedAt: { not: null } },
    },
    select: { id: true, startTime: true, endTime: true, days: true, cabinetId: true, studentGroupId: true },
  });
  console.log('=== Orphan blocks (group deleted, block alive):', orphans.length);
  orphans.forEach(b => console.log('  ', JSON.stringify(b)));

  // 2. All active blocks
  const all = await prisma.lessonBlock.findMany({
    where: { deletedAt: null },
    select: {
      id: true, startTime: true, endTime: true, days: true, cabinetId: true,
      type: true, startDate: true, endDate: true, timeSlotId: true,
      studentGroupId: true,
      studentGroup: { select: { level: true, deletedAt: true } },
    },
    orderBy: [{ studentGroupId: 'asc' }, { startTime: 'asc' }, { id: 'asc' }],
  });
  console.log('\n=== All active blocks:', all.length);
  all.forEach(b => console.log('  ', JSON.stringify({
    ...b,
    startDate: b.startDate?.toISOString().slice(0, 10),
    endDate: b.endDate?.toISOString().slice(0, 10),
  })));
}

main().catch(console.error).finally(() => prisma.$disconnect());
