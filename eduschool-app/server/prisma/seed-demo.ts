/**
 * seed-demo.ts — Demo school seed for Shamdan ERP
 *
 * Creates a complete demo environment:
 *   - 1 demo school (slug: demo)
 *   - 1 owner + 1 admin + 2 teachers + 4 students
 *   - 3 student groups (Beginner, Pre-Int, Upper-Int)
 *   - Lesson blocks (Grammar + Club) for current week
 *
 * Run: npx tsx prisma/seed-demo.ts
 *
 * Login credentials:
 *   owner@demo.edu   / Demo1234!
 *   admin@demo.edu   / Demo1234!
 *   teacher@demo.edu / Demo1234!
 *   student@demo.edu / Demo1234!
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const PASS = 'Demo1234!';
const SLUG = 'demo';

async function main() {
  console.log('🌱 Seeding demo school...\n');

  const hash = await bcrypt.hash(PASS, 10);

  // ── School ──────────────────────────────────────────────────────────────────
  const school = await prisma.school.upsert({
    where: { slug: SLUG },
    update: {},
    create: {
      name: 'Shamdan Demo',
      slug: SLUG,
      city: 'Bishkek',
      email: 'school@demo.edu',
      timezone: 'Asia/Bishkek',
      activeDays: [0, 1, 2, 3, 4],   // Mon–Fri
      workStart: '08:00',
      workEnd: '20:00',
      slotDuration: 80,
      isActive: true,
    },
  });
  console.log(`✅ School: "${school.name}" (slug: ${school.slug}, id: ${school.id})`);

  // ── Users ────────────────────────────────────────────────────────────────────
  const owner = await prisma.user.upsert({
    where: { schoolId_email: { schoolId: school.id, email: 'owner@demo.edu' } },
    update: {},
    create: {
      email: 'owner@demo.edu',
      password: hash,
      firstName: 'Адиль',
      lastName: 'Директор',
      role: 'OWNER',
      schoolId: school.id,
    },
  });

  const admin = await prisma.user.upsert({
    where: { schoolId_email: { schoolId: school.id, email: 'admin@demo.edu' } },
    update: {},
    create: {
      email: 'admin@demo.edu',
      password: hash,
      firstName: 'Айгерим',
      lastName: 'Администратор',
      role: 'ADMIN',
      schoolId: school.id,
    },
  });

  const teacher1 = await prisma.user.upsert({
    where: { schoolId_email: { schoolId: school.id, email: 'teacher@demo.edu' } },
    update: {},
    create: {
      email: 'teacher@demo.edu',
      password: hash,
      firstName: 'Марат',
      lastName: 'Сейткали',
      role: 'TEACHER',
      schoolId: school.id,
    },
  });

  const teacher2 = await prisma.user.upsert({
    where: { schoolId_email: { schoolId: school.id, email: 'teacher2@demo.edu' } },
    update: {},
    create: {
      email: 'teacher2@demo.edu',
      password: hash,
      firstName: 'Нурия',
      lastName: 'Бекова',
      role: 'TEACHER',
      schoolId: school.id,
    },
  });

  console.log(`✅ Users: owner, admin, 2 teachers`);

  // ── Staff profiles ────────────────────────────────────────────────────────
  const staff1 = await prisma.staffProfile.upsert({
    where: { userId: teacher1.id },
    update: {},
    create: {
      userId: teacher1.id,
      position: 'Grammar Teacher',
      salaryRate: 3000,
      hireDate: new Date('2024-09-01'),
    },
  });

  const staff2 = await prisma.staffProfile.upsert({
    where: { userId: teacher2.id },
    update: {},
    create: {
      userId: teacher2.id,
      position: 'Club Teacher',
      salaryRate: 2500,
      hireDate: new Date('2024-09-01'),
    },
  });

  console.log(`✅ Staff profiles created`);

  // ── Cabinet ───────────────────────────────────────────────────────────────
  const cab1 = await prisma.cabinet.upsert({
    where: { schoolId_name: { schoolId: school.id, name: 'Кабинет 1' } },
    update: {},
    create: { schoolId: school.id, name: 'Кабинет 1', capacity: 12 },
  });
  const cab2 = await prisma.cabinet.upsert({
    where: { schoolId_name: { schoolId: school.id, name: 'Кабинет 2' } },
    update: {},
    create: { schoolId: school.id, name: 'Кабинет 2', capacity: 10 },
  });

  // ── TimeSlots ─────────────────────────────────────────────────────────────
  const slotDefs = [
    { s: '08:20', e: '09:40', order: 1 },
    { s: '10:00', e: '11:20', order: 2 },
    { s: '11:40', e: '13:00', order: 3 },
    { s: '14:00', e: '15:20', order: 4 },
    { s: '15:40', e: '17:00', order: 5 },
  ];

  const slots = [];
  for (const sd of slotDefs) {
    const slot = await prisma.timeSlot.upsert({
      where: { schoolId_startTime: { schoolId: school.id, startTime: sd.s } },
      update: {},
      create: { schoolId: school.id, startTime: sd.s, endTime: sd.e, order: sd.order },
    });
    slots.push(slot);
  }
  console.log(`✅ ${slots.length} time slots`);

  // ── Student groups ────────────────────────────────────────────────────────
  const groupDefs = [
    { name: 'Beginner A', level: 'Beginner', max: 10 },
    { name: 'Pre-Intermediate B', level: 'Pre-Intermediate', max: 10 },
    { name: 'Upper-Intermediate C', level: 'Upper-Intermediate', max: 8 },
  ];

  const groups = [];
  for (const gd of groupDefs) {
    const existing = await prisma.studentGroup.findFirst({
      where: { schoolId: school.id, name: gd.name },
    });
    if (existing) {
      groups.push(existing);
      continue;
    }
    const g = await prisma.studentGroup.create({
      data: {
        schoolId: school.id,
        name: gd.name,
        level: gd.level,
        maxStudents: gd.max,
        status: 'ACTIVE',
      },
    });
    groups.push(g);
  }
  console.log(`✅ ${groups.length} student groups`);

  // ── Lesson blocks ─────────────────────────────────────────────────────────
  // Each group gets 1 Grammar block (Mon/Wed/Fri) + 1 Club block (Tue/Thu)
  const monday = (() => {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  const blockDefs = [
    { group: groups[0], slot: slots[0], grammarDays: [0, 2, 4], clubDays: [1, 3], teacherId: staff1.id, clubTeacherId: staff2.id, cabinetId: cab1.id },
    { group: groups[1], slot: slots[1], grammarDays: [0, 2, 4], clubDays: [1, 3], teacherId: staff1.id, clubTeacherId: staff2.id, cabinetId: cab1.id },
    { group: groups[2], slot: slots[2], grammarDays: [0, 2, 4], clubDays: [1, 3], teacherId: staff2.id, clubTeacherId: staff2.id, cabinetId: cab2.id },
  ];

  for (const bd of blockDefs) {
    const existingG = await prisma.lessonBlock.findFirst({
      where: { schoolId: school.id, studentGroupId: bd.group.id, type: 'GRAMMAR' },
    });
    if (!existingG) {
      await prisma.lessonBlock.create({
        data: {
          schoolId: school.id,
          studentGroupId: bd.group.id,
          timeSlotId: bd.slot.id,
          type: 'GRAMMAR',
          days: bd.grammarDays,
          teacherId: bd.teacherId,
          cabinetId: bd.cabinetId,
          startDate: monday,
          startTime: bd.slot.startTime,
          endTime: bd.slot.endTime,
        },
      });
    }
    const existingC = await prisma.lessonBlock.findFirst({
      where: { schoolId: school.id, studentGroupId: bd.group.id, type: 'SPEAKING_CLUB' },
    });
    if (!existingC) {
      await prisma.lessonBlock.create({
        data: {
          schoolId: school.id,
          studentGroupId: bd.group.id,
          timeSlotId: bd.slot.id,
          type: 'SPEAKING_CLUB',
          days: bd.clubDays,
          teacherId: bd.clubTeacherId,
          cabinetId: bd.cabinetId,
          startDate: monday,
          startTime: bd.slot.startTime,
          endTime: bd.slot.endTime,
        },
      });
    }
  }
  console.log(`✅ Lesson blocks created (Grammar + Club for each group)`);

  // ── Students ──────────────────────────────────────────────────────────────
  const studentDefs = [
    { email: 'student@demo.edu',  first: 'Айбек',  last: 'Уулу',    group: groups[0] },
    { email: 'student2@demo.edu', first: 'Зарина', last: 'Асанова', group: groups[0] },
    { email: 'student3@demo.edu', first: 'Рустам', last: 'Нуров',   group: groups[1] },
    { email: 'student4@demo.edu', first: 'Гульнара', last: 'Сатыбалдиева', group: groups[2] },
  ];

  for (const sd of studentDefs) {
    const user = await prisma.user.upsert({
      where: { schoolId_email: { schoolId: school.id, email: sd.email } },
      update: {},
      create: {
        email: sd.email,
        password: hash,
        firstName: sd.first,
        lastName: sd.last,
        role: 'STUDENT',
        schoolId: school.id,
      },
    });

    const existing = await prisma.studentProfile.findUnique({ where: { userId: user.id } });
    if (!existing) {
      await prisma.studentProfile.create({
        data: {
          userId: user.id,
          schoolId: school.id,
          credits: 20,
          studentGroupId: sd.group.id,
        },
      });
    }
  }
  console.log(`✅ ${studentDefs.length} students created`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ DEMO SEED COMPLETE

🌐 URL:  http://localhost:5173/demo

👤 Логины (все пароль: Demo1234!):
   owner@demo.edu    → OWNER (директор)
   admin@demo.edu    → ADMIN  (администратор)
   teacher@demo.edu  → TEACHER
   student@demo.edu  → STUDENT

📚 Группы: Beginner A, Pre-Intermediate B, Upper-Intermediate C
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

main()
  .catch(e => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
