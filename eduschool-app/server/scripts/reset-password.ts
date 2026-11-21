import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'OWNER', 'SUPERADMIN'] } },
    select: { id: true, email: true, role: true, firstName: true, lastName: true },
  });
  console.log('Admin accounts found:', JSON.stringify(admins, null, 2));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
