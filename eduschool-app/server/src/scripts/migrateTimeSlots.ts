/**
 * One-time migration: creates TimeSlot rows for all schools and links existing
 * LessonBlocks to them. Run once after the add_timeslot migration.
 *
 *   npx tsx src/scripts/migrateTimeSlots.ts
 */

import prisma from '../lib/prisma';

const DEFAULT_SLOTS = [
  { startTime: '08:20', endTime: '09:40', order: 0 },
  { startTime: '09:40', endTime: '11:00', order: 1 },
  { startTime: '11:00', endTime: '12:20', order: 2 },
  { startTime: '13:40', endTime: '15:00', order: 3 },
  { startTime: '15:00', endTime: '16:20', order: 4 },
  { startTime: '16:20', endTime: '17:40', order: 5 },
  { startTime: '17:40', endTime: '19:00', order: 6 },
  { startTime: '19:00', endTime: '20:20', order: 7 },
];

function generateSlotTimes(workStart: string, workEnd: string, slotDuration: number) {
  const parse = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

  const startMin = parse(workStart);
  const endMin = parse(workEnd);
  const dur = Math.max(30, Math.min(240, slotDuration));

  if (startMin >= endMin || dur <= 0) return null;

  const slots: { startTime: string; endTime: string; order: number }[] = [];
  let cur = startMin;
  let order = 0;
  while (cur + dur <= endMin) {
    slots.push({ startTime: fmt(cur), endTime: fmt(cur + dur), order });
    cur += dur;
    order++;
  }
  return slots.length ? slots : null;
}

async function main() {
  const schools = await prisma.school.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, workStart: true, workEnd: true, slotDuration: true },
  });

  console.log(`Found ${schools.length} school(s)\n`);

  for (const school of schools) {
    const slotDefs =
      school.workStart && school.workEnd && school.slotDuration
        ? generateSlotTimes(school.workStart, school.workEnd, school.slotDuration) ?? DEFAULT_SLOTS
        : DEFAULT_SLOTS;

    console.log(`School [${school.id}] "${school.name}": ${slotDefs.length} base slots`);

    // Upsert base slots from settings
    for (const def of slotDefs) {
      await prisma.timeSlot.upsert({
        where: { schoolId_startTime_endTime: { schoolId: school.id, startTime: def.startTime, endTime: def.endTime } },
        update: { order: def.order },
        create: { schoolId: school.id, startTime: def.startTime, endTime: def.endTime, order: def.order },
      });
    }

    // timeSlotId is now NOT NULL on LessonBlock — all blocks already migrated
    console.log(`  Done\n`);
  }

  console.log('Migration complete.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
