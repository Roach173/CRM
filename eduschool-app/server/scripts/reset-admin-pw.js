const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function run() {
  const hash = await bcrypt.hash('admin123', 10);
  const u = await prisma.user.update({ where: { email: 'admin@test.com' }, data: { password: hash } });
  console.log('Reset password for:', u.email, 'role:', u.role);
  await prisma.$disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
