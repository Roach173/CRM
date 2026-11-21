const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const users = await prisma.user.findMany({ select: { email: true, role: true, firstName: true, lastName: true } });
  users.forEach(u => console.log(u.role.padEnd(12), u.email, '-', u.firstName, u.lastName));
  await prisma.$disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
