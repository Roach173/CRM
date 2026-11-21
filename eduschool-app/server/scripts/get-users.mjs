import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const users = await p.user.findMany({ where: { role: 'OWNER' }, select: { email: true, firstName: true, lastName: true } });
console.log(JSON.stringify(users, null, 2));
await p.$disconnect();
