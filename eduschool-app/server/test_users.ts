import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    include: { school: true }
  });
  console.log("Users in DB:");
  users.forEach(u => {
    console.log(`Email: ${u.email}`);
    console.log(`Role: ${u.role}`);
    console.log(`School Slug: ${u.school?.slug}`);
    console.log(`Email Verified: ${u.emailVerified}`);
    console.log(`Password Hash: ${u.password}`);
    console.log('---');
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
