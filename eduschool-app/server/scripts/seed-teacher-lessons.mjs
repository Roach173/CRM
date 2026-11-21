import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const teacher = await p.user.findFirst({
  where: { email: 'test@teacher.com', deletedAt: null },
  select: { id: true, schoolId: true, firstName: true, lastName: true },
});

if (!teacher) {
  console.error('User test@teacher.com not found');
  await p.$disconnect();
  process.exit(1);
}

console.log(`Found teacher: ${teacher.firstName} ${teacher.lastName} (id=${teacher.id}, schoolId=${teacher.schoolId})`);

const today = new Date();
today.setUTCHours(12, 0, 0, 0);

const block1 = await p.lessonBlock.create({
  data: {
    schoolId: teacher.schoolId,
    cabinet: 'Кабинет 101',
    timeSlot: '09:00–10:30',
    days: 'Пн,Ср,Пт',
    level: 'Intermediate',
    chapter: 3,
    type: 'GRAMMAR',
    maxStudents: 12,
    grammarTeacherId: teacher.id,
    startDate: today,
    endDate: null,
  },
});

const block2 = await p.lessonBlock.create({
  data: {
    schoolId: teacher.schoolId,
    cabinet: 'Кабинет 202',
    timeSlot: '11:00–12:30',
    days: 'Вт,Чт',
    level: 'Pre-Intermediate',
    chapter: 1,
    type: 'GRAMMAR',
    maxStudents: 10,
    grammarTeacherId: teacher.id,
    startDate: today,
    endDate: null,
  },
});

// Generate sessions for 30 days
const DAY_MAP = { 'Вс': 0, 'Пн': 1, 'Вт': 2, 'Ср': 3, 'Чт': 4, 'Пт': 5, 'Сб': 6 };

async function seedSessions(block) {
  const daysArray = block.days.split(',').map(d => d.trim());
  const validDayIndexes = daysArray.map(d => DAY_MAP[d]).filter(d => d !== undefined);
  const sessions = [];
  const start = new Date(block.startDate);
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  let current = new Date(start);
  while (current <= end) {
    if (validDayIndexes.includes(current.getUTCDay())) {
      sessions.push({ lessonBlockId: block.id, date: new Date(current), status: 'UPCOMING' });
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  if (sessions.length > 0) {
    await p.lessonSession.createMany({ data: sessions });
  }
  console.log(`  → ${sessions.length} sessions created`);
}

console.log(`\nBlock 1: ${block1.level} (${block1.cabinet}) — ${block1.days} @ ${block1.timeSlot}`);
await seedSessions(block1);

console.log(`Block 2: ${block2.level} (${block2.cabinet}) — ${block2.days} @ ${block2.timeSlot}`);
await seedSessions(block2);

console.log('\nDone.');
await p.$disconnect();
