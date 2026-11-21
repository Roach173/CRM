import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  const newPassword = process.argv[3];

  if (!email || !newPassword) {
    console.log("Usage: npx tsx reset_pass.ts <email> <newPassword>");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email: email.toLowerCase().trim() } });
  
  if (!user) {
    console.log("User not found!");
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  
  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashedPassword, emailVerified: true }
  });

  console.log(`Password for ${email} has been updated to: ${newPassword}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
