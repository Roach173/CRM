import { PrismaClient } from '@prisma/client';
import { createLogger } from './logger';

const log = createLogger('prisma');
const connectionLimit = parseInt(process.env.DB_POOL_SIZE || '10');

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  // Default-deny secrets: these scalar fields never load unless a query explicitly
  // opts back in via `omit: { <field>: false }` (login, password-change, 2FA only).
  // Prevents accidental leakage through raw `res.json(user)` or `...user` spreads.
  omit: {
    user: {
      password: true,
      totpSecret: true,
      backupCodes: true,
    },
  },
  log: process.env.NODE_ENV === 'development'
    ? [{ level: 'warn', emit: 'event' }, { level: 'error', emit: 'event' }]
    : [{ level: 'error', emit: 'event' }],
});

prisma.$on('error' as never, (e: any) => {
  log.error({ err: e }, 'prisma error event');
});

if (process.env.NODE_ENV === 'development') {
  prisma.$on('warn' as never, (e: any) => {
    log.warn({ err: e }, 'prisma warn event');
  });
}

export { connectionLimit };
// The global `omit` above changes the client's generic type, which would otherwise
// ripple through every helper that annotates a param as the vanilla PrismaClient
// (DbClient, PrismaReader, …). The omit is a RUNTIME guarantee — secrets are stripped
// from query results whatever the static type says — so we export the base type to
// avoid that churn. Reads that need a secret opt back in with `omit: { <field>: false }`.
export default prisma as unknown as PrismaClient;
