import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting cleanup...');
  const result = await prisma.school.deleteMany({
    where: {
      slug: {
        contains: '-177',
      },
    },
  });
  console.log(`Successfully deleted ${result.count} schools with timestamps in slugs.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
