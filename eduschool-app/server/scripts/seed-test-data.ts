import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const SCHOOL_ID = 1;
const PASSWORD_HASH = bcrypt.hashSync('test1234', 10);

const TEACHERS = [
  { firstName: 'Анна',      lastName: 'Петрова',    email: 'teacher1@test.com', position: 'Преподаватель', salaryRate: 1500 },
  { firstName: 'Михаил',    lastName: 'Смирнов',    email: 'teacher2@test.com', position: 'Преподаватель', salaryRate: 1600 },
  { firstName: 'Екатерина', lastName: 'Иванова',    email: 'teacher3@test.com', position: 'Старший преподаватель', salaryRate: 1800 },
  { firstName: 'Дмитрий',   lastName: 'Козлов',     email: 'teacher4@test.com', position: 'Преподаватель', salaryRate: 1400 },
  { firstName: 'Ольга',     lastName: 'Новикова',   email: 'teacher5@test.com', position: 'Преподаватель', salaryRate: 1500 },
  { firstName: 'Алексей',   lastName: 'Морозов',    email: 'teacher6@test.com', position: 'Преподаватель', salaryRate: 1550 },
  { firstName: 'Наталья',   lastName: 'Волкова',    email: 'teacher7@test.com', position: 'Старший преподаватель', salaryRate: 1750 },
  { firstName: 'Сергей',    lastName: 'Соколов',    email: 'teacher8@test.com', position: 'Преподаватель', salaryRate: 1450 },
  { firstName: 'Марина',    lastName: 'Лебедева',   email: 'teacher9@test.com', position: 'Преподаватель', salaryRate: 1500 },
  { firstName: 'Андрей',    lastName: 'Козлов',     email: 'teacher10@test.com', position: 'Куратор', salaryRate: 1700 },
];

const STUDENTS = [
  { firstName: 'Айгерим', lastName: 'Асанова',   email: 'student1@test.com', level: 'A1', credits: 8  },
  { firstName: 'Бекзат',  lastName: 'Токтосунов', email: 'student2@test.com', level: 'A2', credits: 4  },
  { firstName: 'Дана',    lastName: 'Жумалиева',  email: 'student3@test.com', level: 'B1', credits: 12 },
  { firstName: 'Эрлан',   lastName: 'Мамытов',    email: 'student4@test.com', level: 'A1', credits: 0  },
  { firstName: 'Зарина',  lastName: 'Ибрагимова', email: 'student5@test.com', level: 'B2', credits: 6  },
  { firstName: 'Нурлан',  lastName: 'Сейтбеков',  email: 'student6@test.com', level: 'A2', credits: 10 },
  { firstName: 'Камилла', lastName: 'Байсалова',  email: 'student7@test.com', level: 'C1', credits: 3  },
  { firstName: 'Руслан',  lastName: 'Алиев',      email: 'student8@test.com', level: 'A1', credits: 16 },
  { firstName: 'Айна',    lastName: 'Джаксыбеков', email: 'student9@test.com', level: 'B1', credits: 5 },
  { firstName: 'Тимур',   lastName: 'Карабеков',  email: 'student10@test.com', level: 'A2', credits: 9 },
];

async function main() {
  console.log('🌱 Seeding test data for school id =', SCHOOL_ID);

  // ── Teachers ──────────────────────────────────────────────────────────────
  let teachersCreated = 0;
  for (const t of TEACHERS) {
    const exists = await prisma.user.findFirst({ where: { email: t.email } });
    if (exists) {
      console.log(`  ⏩ Учитель ${t.email} уже существует, пропускаем`);
      continue;
    }
    await prisma.user.create({
      data: {
        email: t.email,
        password: PASSWORD_HASH,
        firstName: t.firstName,
        lastName: t.lastName,
        role: 'TEACHER',
        schoolId: SCHOOL_ID,
        staffProfile: {
          create: {
            position: t.position,
            salaryRate: t.salaryRate,
            hireDate: new Date('2025-09-01'),
          },
        },
      },
    });
    teachersCreated++;
    console.log(`  ✅ Учитель: ${t.firstName} ${t.lastName} (${t.email})`);
  }

  // ── Students ──────────────────────────────────────────────────────────────
  let studentsCreated = 0;
  for (const s of STUDENTS) {
    const exists = await prisma.user.findFirst({ where: { email: s.email } });
    if (exists) {
      console.log(`  ⏩ Студент ${s.email} уже существует, пропускаем`);
      continue;
    }
    await prisma.user.create({
      data: {
        email: s.email,
        password: PASSWORD_HASH,
        firstName: s.firstName,
        lastName: s.lastName,
        role: 'STUDENT',
        schoolId: SCHOOL_ID,
        studentProfile: {
          create: {
            level: s.level,
            credits: s.credits,
            isVerified: true,
          },
        },
      },
    });
    studentsCreated++;
    console.log(`  ✅ Студент: ${s.firstName} ${s.lastName} (${s.email}) — уровень ${s.level}, кредитов ${s.credits}`);
  }

  console.log(`\n🎉 Готово! Создано учителей: ${teachersCreated}, студентов: ${studentsCreated}`);
  console.log('🔑 Пароль для всех аккаунтов: test1234');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
