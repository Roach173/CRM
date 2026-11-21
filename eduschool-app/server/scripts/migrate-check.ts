/**
 * migrate-check.ts
 * Verifies Prisma migration state before (or after) a production deploy.
 *
 * Usage:
 *   npx tsx scripts/migrate-check.ts
 *
 * Exit 0  = all migrations applied, none failed, none stuck.
 * Exit 1  = pending migrations, rolled-back migrations, DB unreachable,
 *           or _prisma_migrations table not found.
 *
 * Use this as a CI/CD gate:
 *   - PRE-DEPLOY : confirms the DB is in sync and no migration was left half-applied
 *   - POST-DEPLOY: confirms "npx prisma migrate deploy" succeeded
 *
 * Do NOT use "prisma migrate dev" — it requires a shadow DB and interactive
 * prompts and is never safe in CI. Always use "prisma migrate deploy".
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

let exitCode = 0;

function ok(msg: string)   { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg: string) { console.error(`${RED}✗${RESET} ${msg}`); exitCode = 1; }
function warn(msg: string) { console.warn(`${YELLOW}⚠${RESET} ${msg}`); }

// Row shape returned by _prisma_migrations
interface MigrationRow {
  id:             string;
  migration_name: string;
  started_at:     Date;
  finished_at:    Date | null;
  rolled_back_at: Date | null;
  logs:           string | null;
  applied_steps_count: number;
}

async function main() {
  console.log('\n=== Shamdan Migration State Check ===\n');

  // ── 1. DB reachable ────────────────────────────────────────────────────────
  try {
    await prisma.$queryRaw`SELECT 1`;
    ok('Database reachable');
  } catch (err: any) {
    fail(`Database unreachable: ${err.message}`);
    console.error('\nHint: ensure DATABASE_URL is set and the database is running.\n');
    await prisma.$disconnect();
    process.exit(1);
  }

  // ── 2. _prisma_migrations table accessible ────────────────────────────────
  let rows: MigrationRow[];
  try {
    rows = await prisma.$queryRaw<MigrationRow[]>`
      SELECT id, migration_name, started_at, finished_at, rolled_back_at, logs, applied_steps_count
      FROM "_prisma_migrations"
      ORDER BY started_at ASC
    `;
  } catch (err: any) {
    fail(`Cannot query _prisma_migrations: ${err.message}`);
    console.error('Hint: run "npx prisma migrate deploy" to initialize the migration history table.\n');
    await prisma.$disconnect();
    process.exit(1);
  }

  if (rows.length === 0) {
    fail('_prisma_migrations is empty — no migrations have been applied to this database');
    console.error('Hint: run "npx prisma migrate deploy" to apply all migrations.\n');
    await prisma.$disconnect();
    process.exit(1);
  }

  ok(`Found ${rows.length} migration record(s) in _prisma_migrations`);

  // ── 3. Rolled-back migrations (indicates a failed previous deploy) ─────────
  const rolledBack = rows.filter(r => r.rolled_back_at !== null);
  if (rolledBack.length > 0) {
    fail(`${rolledBack.length} migration(s) have been rolled back (indicates a previously failed deploy):`);
    for (const m of rolledBack) {
      console.error(`  ✗ ${m.migration_name} (rolled back: ${m.rolled_back_at!.toISOString()})`);
      if (m.logs) console.error(`    Log: ${m.logs.slice(0, 300).replace(/\n/g, ' ')}`);
    }
    console.error('  → Fix: manually resolve the rolled-back migration before proceeding.\n');
  } else {
    ok('No rolled-back migrations');
  }

  // ── 4. Stuck migrations (started but never finished) ──────────────────────
  const stuck = rows.filter(r => r.finished_at === null && r.rolled_back_at === null);
  if (stuck.length > 0) {
    fail(`${stuck.length} migration(s) started but never finished (interrupted deploy):`);
    for (const m of stuck) {
      console.error(`  ✗ ${m.migration_name}`);
      console.error(`    started: ${m.started_at.toISOString()}, steps applied: ${m.applied_steps_count}`);
      if (m.logs) console.error(`    Log: ${m.logs.slice(0, 300).replace(/\n/g, ' ')}`);
    }
    console.error('  → Fix: run "npx prisma migrate resolve --rolled-back <name>" then re-deploy.\n');
  } else {
    ok('No stuck (unfinished) migrations');
  }

  // ── 5. Compare file-system migrations against DB ──────────────────────────
  const migrationsDir = path.join(process.cwd(), 'prisma', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    warn(`Migration directory not found at ${migrationsDir} — skipping file vs DB comparison`);
  } else {
    const diskMigrations = fs.readdirSync(migrationsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'migration_lock.toml')
      .map(e => e.name)
      .sort();

    const appliedInDb = new Set(
      rows.filter(r => r.finished_at !== null).map(r => r.migration_name),
    );

    // Migrations on disk but NOT applied in DB = pending
    const pending = diskMigrations.filter(name => !appliedInDb.has(name));
    if (pending.length > 0) {
      fail(`${pending.length} migration file(s) on disk have NOT been applied to the database:`);
      for (const name of pending) {
        console.error(`  ✗ ${name}`);
      }
      console.error('  → Fix: run "npx prisma migrate deploy" to apply pending migrations.\n');
    } else {
      ok(`All ${diskMigrations.length} on-disk migration(s) are applied`);
    }

    // Migrations in DB without a file (might be OK if file was intentionally removed)
    const dbWithoutFile = rows
      .filter(r => r.finished_at !== null)
      .map(r => r.migration_name)
      .filter(name => !diskMigrations.includes(name));
    if (dbWithoutFile.length > 0) {
      warn(`${dbWithoutFile.length} DB migration record(s) have no corresponding file on disk:`);
      for (const name of dbWithoutFile) console.warn(`  ⚠ ${name}`);
      warn('This is OK if the files were intentionally removed from the repo post-deploy.');
    }
  }

  // ── 6. Report latest applied migration ───────────────────────────────────
  const applied = rows.filter(r => r.finished_at !== null);
  if (applied.length > 0) {
    const latest = applied[applied.length - 1];
    ok(`Latest applied: ${latest.migration_name}`);
    ok(`Finished at: ${latest.finished_at!.toISOString()}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  if (exitCode === 0) {
    console.log(`${GREEN}Migration state OK — safe to deploy / recently deployed.${RESET}\n`);
  } else {
    console.error(
      `${RED}Migration check FAILED — resolve the issues above before deploying.${RESET}\n`,
    );
  }

  await prisma.$disconnect();
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error('migrate-check fatal error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
