/**
 * One-time backfill: copies all existing StudentGroup ↔ StudentProfile M2M rows
 * into the new GroupMembership table.
 *
 * Run once after the `add_group_membership` migration:
 *   npx tsx src/scripts/backfill-memberships.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const groups = await prisma.studentGroup.findMany({
    where: { deletedAt: null },
    include: {
      students: { where: { deletedAt: null }, select: { id: true } },
    },
  });

  let created = 0;
  let skipped = 0;

  for (const group of groups) {
    for (const student of group.students) {
      try {
        await prisma.groupMembership.upsert({
          where: {
            studentProfileId_studentGroupId: {
              studentProfileId: student.id,
              studentGroupId: group.id,
            },
          },
          create: {
            schoolId: group.schoolId,
            studentProfileId: student.id,
            studentGroupId: group.id,
            joinedAt: group.createdAt,
            status: 'ACTIVE',
          },
          update: {},
        });
        created++;
      } catch {
        skipped++;
      }
    }
  }

  console.log(`Done. Created: ${created}, Skipped (already exist): ${skipped}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
