// Load .env.test before anything else in the suite: setupFilesAfterEnv runs
// before the test file's imports, and lib/prisma captures DATABASE_URL at
// module init. Without this, importing lib/prisma from here (or from any
// module loaded before testDb.ts) would point the singleton at the dev DB.
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.test'), override: true });

// Disconnect the lib/prisma singleton after every suite. Integration suites
// import real routes, which hold the singleton's pool; jest reuses one worker
// but resets the module registry per suite, so undisconnected pools accumulate
// until Postgres max_connections is exhausted mid-run. Lazy import: only the
// instance this suite actually created gets touched (no-op if never loaded).
afterAll(async () => {
  try {
    const { default: prisma } = (await import('../../lib/prisma')) as any;
    await prisma?.$disconnect?.();
  } catch {
    // Suite mocks lib/prisma (no $disconnect) or never loaded it — nothing to close.
  }
});
