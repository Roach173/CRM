import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
const p = new PrismaClient();
const hash = await bcrypt.hash('owner123', 10);
await p.user.update({ where: { email: '1@gmail.com' }, data: { password: hash } });
console.log('Password reset to: owner123');
await p.$disconnect();
