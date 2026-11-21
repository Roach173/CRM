import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const schools = await p.school.findMany({ select: { slug: true, name: true } });
console.log(JSON.stringify(schools, null, 2));
await p.$disconnect();
