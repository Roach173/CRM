import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const blocks = await prisma.lessonBlock.findMany();
  let count = 0;
  for (const block of blocks) {
    if (!block.startDate || !block.endDate) continue;
    // block.days: number[] where 0=Mon…6=Sun (DB index)
    // JS getDay(): 0=Sun,1=Mon…6=Sat → convert: jsDay = (dbDay + 1) % 7
    const jsValidDays = new Set(block.days.map(d => (d + 1) % 7));

    const sessionsData = [];
    const start = new Date(block.startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(block.endDate);
    end.setHours(23, 59, 59, 999);

    let current = new Date(start);
    while (current <= end) {
      if (jsValidDays.has(current.getDay())) {
        sessionsData.push({
          lessonBlockId: block.id,
          date: new Date(current),
          status: 'UPCOMING' as any,
          schoolId: block.schoolId
        });
      }
      current.setDate(current.getDate() + 1);
    }
    
    // skip if sessions exist
    const existing = await prisma.lessonSession.findFirst({ where: { lessonBlockId: block.id } });
    if (!existing && sessionsData.length > 0) {
      await prisma.lessonSession.createMany({ data: sessionsData });
      console.log(`Generated ${sessionsData.length} sessions for block ${block.id}`);
      count++;
    }
  }
  console.log(`Migration complete. Processed ${count} new blocks.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
