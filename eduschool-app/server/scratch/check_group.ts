
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const groups = await prisma.studentGroup.findMany({
    where: { name: { contains: 'иришг' } },
    include: { blocks: true }
  });
  console.log(JSON.stringify(groups, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
