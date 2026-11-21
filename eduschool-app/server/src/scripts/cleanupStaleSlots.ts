/**
 * One-time cleanup: removes TimeSlot rows that are no longer
 * in the current school's schedule configuration and are not
 * referenced by any LessonBlock.
 *
 * Run once: npx ts-node src/scripts/cleanupStaleSlots.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function generateSlotDefs(workStart: string, workEnd: string, slotDuration: number) {
  const parse = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  const startMin = parse(workStart);
  const endMin = parse(workEnd);
  const dur = Math.max(30, Math.min(240, slotDuration));
  if (startMin >= endMin || dur <= 0) return null;
  const slots: { startTime: string; endTime: string }[] = [];
  let cur = startMin;
  while (cur + dur <= endMin) {
    slots.push({ startTime: fmt(cur), endTime: fmt(cur + dur) });
    cur += dur;
  }
  return slots.length ? slots : null;
}

async function main() {
  const schools = await prisma.school.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, settings: true },
  });

  for (const school of schools) {
    const sett: any = school.settings ?? {};
    const workStart: string = sett.workStart ?? '08:00';
    const workEnd: string   = sett.workEnd   ?? '20:00';
    const slotDuration: number = sett.slotDuration ?? 80;

    const defs = generateSlotDefs(workStart, workEnd, slotDuration);
    if (!defs) {
      console.log(`School [${school.id}] "${school.name}": invalid settings, skipping`);
      continue;
    }

    const newKeys = new Set(defs.map(d => `${d.startTime}|${d.endTime}`));

    const allSlots = await prisma.timeSlot.findMany({
      where: { schoolId: school.id },
      include: { _count: { select: { blocks: true } } },
    });

    let deleted = 0;
    let kept = 0;
    for (const slot of allSlots) {
      const key = `${slot.startTime}|${slot.endTime}`;
      if (!newKeys.has(key) && (slot as any)._count.blocks === 0) {
        await prisma.timeSlot.delete({ where: { id: slot.id } });
        console.log(`  Deleted stale slot [${slot.id}] ${slot.startTime}-${slot.endTime}`);
        deleted++;
      } else {
        kept++;
      }
    }
    console.log(`School [${school.id}] "${school.name}": deleted ${deleted}, kept ${kept} slots`);
  }

  console.log('\nDone.');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
