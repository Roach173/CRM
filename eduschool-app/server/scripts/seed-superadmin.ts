import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = 'super@admin.com';

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    console.log('Superadmin already exists:', existing.email);
    return;
  }

  const hash = await bcrypt.hash('admin123', 10);
  const user = await prisma.user.create({
    data: {
      email,
      password: hash,
      firstName: 'Super',
      lastName: 'Admin',
      role: 'SUPERADMIN',
    },
  });

  console.log('Created:', user.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
