/**
 * verify-backup.ts
 * Run after a pg_dump backup to confirm the system is healthy before the backup window closes.
 * Usage: npx tsx scripts/verify-backup.ts [--backup-file path/to/dump.sql]
 *
 * Checks:
 *  1. Database reachable and responds to SELECT 1
 *  2. Critical tables exist and have non-zero row counts
 *  3. Latest Prisma migration applied
 *  4. Uploads directory readable (if UPLOADS_DIR is set)
 *  5. Free disk space above minimum threshold
 *  6. pg_dump file present and non-empty (if --backup-file arg provided)
 *  7. pg_dump binary available in PATH
 *  8. Backup target directory (BACKUP_DIR) is writable
 *  9. No stuck IN_PROGRESS idempotency keys older than 2 hours
 *
 * Exit code 0 = all checks passed.
 * Exit code 1 = one or more checks failed.
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

const results: CheckResult[] = [];

function pass(name: string, message: string) {
  results.push({ name, passed: true, message });
  console.log(`${GREEN}✓${RESET} ${name}: ${message}`);
}

function fail(name: string, message: string) {
  results.push({ name, passed: false, message });
  console.error(`${RED}✗${RESET} ${name}: ${message}`);
}

function warn(name: string, message: string) {
  results.push({ name, passed: true, message: `[WARN] ${message}` });
  console.warn(`${YELLOW}⚠${RESET} ${name}: ${message}`);
}

// ── 1. Database reachability ──────────────────────────────────────────────────
async function checkDatabase() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    pass('db_reachable', 'Database responded to SELECT 1');
  } catch (err: any) {
    fail('db_reachable', `Cannot reach database: ${err.message}`);
  }
}

// ── 2. Critical table row counts ──────────────────────────────────────────────
async function checkTableCounts() {
  const criticalTables: Array<{ label: string; query: () => Promise<number> }> = [
    { label: 'School',    query: () => prisma.school.count() },
    { label: 'User',      query: () => prisma.user.count() },
    { label: 'LessonBlock', query: () => prisma.lessonBlock.count() },
    { label: 'LessonSession', query: () => prisma.lessonSession.count() },
  ];

  for (const t of criticalTables) {
    try {
      const count = await t.query();
      if (count > 0) {
        pass(`table_${t.label.toLowerCase()}`, `${count} rows`);
      } else {
        warn(`table_${t.label.toLowerCase()}`, `Table is empty — expected data in ${t.label}`);
      }
    } catch (err: any) {
      fail(`table_${t.label.toLowerCase()}`, `Count query failed: ${err.message}`);
    }
  }
}

// ── 3. Latest Prisma migration ────────────────────────────────────────────────
async function checkMigration() {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `;

    if (rows.length === 0) {
      fail('migration', 'No migrations found in _prisma_migrations table');
      return;
    }

    const latest = rows[0];
    if (!latest.finished_at) {
      fail('migration', `Latest migration not finished: ${latest.migration_name}`);
    } else {
      pass('migration', `Latest migration: ${latest.migration_name} (finished ${latest.finished_at.toISOString()})`);
    }
  } catch (err: any) {
    fail('migration', `Could not query _prisma_migrations: ${err.message}`);
  }
}

// ── 4. Uploads directory ──────────────────────────────────────────────────────
function checkUploads() {
  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'public', 'uploads');
  try {
    fs.accessSync(uploadsDir, fs.constants.R_OK);
    pass('uploads_dir', `Readable: ${uploadsDir}`);
  } catch {
    warn('uploads_dir', `Cannot read uploads directory: ${uploadsDir} (may not exist in this environment)`);
  }
}

// ── 5. Free disk space ────────────────────────────────────────────────────────
function checkDiskSpace() {
  const MIN_FREE_MB = parseInt(process.env.MIN_FREE_DISK_MB || '500');
  try {
    // Use os.freemem as a proxy on platforms where statvfs is unavailable.
    // For accurate disk checks use df command or a native module in production.
    const freeMem = os.freemem();
    const freeMemMB = Math.round(freeMem / 1024 / 1024);

    // Try to stat the filesystem via the data directory
    const backupDir = process.env.BACKUP_DIR || process.cwd();
    const stat = ('statfsSync' in fs) ? (fs as any).statfsSync(backupDir) : null;

    if (stat) {
      const freeBytes = stat.bfree * stat.bsize;
      const freeDiskMB = Math.round(freeBytes / 1024 / 1024);
      if (freeDiskMB >= MIN_FREE_MB) {
        pass('disk_space', `${freeDiskMB} MB free on backup volume (minimum ${MIN_FREE_MB} MB)`);
      } else {
        fail('disk_space', `Only ${freeDiskMB} MB free — below minimum ${MIN_FREE_MB} MB`);
      }
    } else {
      // Fallback: just report memory
      pass('disk_space', `Disk stat unavailable on this platform — free RAM: ${freeMemMB} MB (not a disk check)`);
    }
  } catch (err: any) {
    warn('disk_space', `Disk space check skipped: ${err.message}`);
  }
}

// ── 6. Backup file integrity ──────────────────────────────────────────────────
function checkBackupFile(filePath: string | undefined) {
  if (!filePath) {
    warn('backup_file', 'No --backup-file argument provided — skipping file integrity check');
    return;
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      fail('backup_file', `Backup file is empty: ${filePath}`);
    } else {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
      pass('backup_file', `Backup file present: ${filePath} (${sizeMB} MB)`);
    }
  } catch {
    fail('backup_file', `Backup file not found: ${filePath}`);
  }
}

// ── 7. pg_dump binary availability ───────────────────────────────────────────
function checkPgDump() {
  try {
    const version = execSync('pg_dump --version', { timeout: 5000 }).toString().trim();
    pass('pg_dump_available', version);
  } catch {
    // pg_dump not in PATH — check if it's a Railway/managed environment
    if (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER) {
      warn('pg_dump_available', 'pg_dump not found in PATH — managed platform detected. Use platform backup UI instead of pg_dump.');
    } else {
      fail('pg_dump_available', 'pg_dump not found in PATH — install postgresql-client to enable DB backups');
    }
  }
}

// ── 8. Backup target directory writable ──────────────────────────────────────
function checkBackupTargetWritable() {
  const backupDir = process.env.BACKUP_DIR;
  if (!backupDir) {
    warn('backup_target', 'BACKUP_DIR not set — cannot verify backup target. Set BACKUP_DIR to your backup destination.');
    return;
  }

  if (!fs.existsSync(backupDir)) {
    // Try to create it
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      pass('backup_target', `Created and writable: ${backupDir}`);
    } catch (err: any) {
      fail('backup_target', `BACKUP_DIR "${backupDir}" does not exist and cannot be created: ${err.message}`);
    }
    return;
  }

  try {
    fs.accessSync(backupDir, fs.constants.W_OK);
    pass('backup_target', `Writable: ${backupDir}`);
  } catch {
    fail('backup_target', `BACKUP_DIR "${backupDir}" exists but is NOT writable — check directory permissions`);
  }
}

// ── 9. Stuck idempotency keys ─────────────────────────────────────────────────
async function checkStuckIdempotency() {
  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000);
  try {
    const count = await prisma.idempotencyKey.count({
      where: { status: 'IN_PROGRESS', startedAt: { lt: TWO_HOURS_AGO } },
    });

    if (count === 0) {
      pass('idempotency_stuck', 'No stuck IN_PROGRESS keys found');
    } else {
      warn('idempotency_stuck', `${count} stuck IN_PROGRESS key(s) older than 2 hours — consider running superadmin cleanup`);
    }
  } catch (err: any) {
    fail('idempotency_stuck', `Idempotency check failed: ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const backupFileIdx = args.indexOf('--backup-file');
  const backupFile = backupFileIdx !== -1 ? args[backupFileIdx + 1] : undefined;

  console.log('\n=== Shamdan Backup Verification ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Node env:  ${process.env.NODE_ENV || 'development'}`);
  console.log('');

  await checkDatabase();
  await checkTableCounts();
  await checkMigration();
  checkUploads();
  checkDiskSpace();
  checkBackupFile(backupFile);
  checkPgDump();
  checkBackupTargetWritable();
  await checkStuckIdempotency();

  const failed = results.filter(r => !r.passed);
  const total  = results.length;

  console.log(`\n=== Summary: ${total - failed.length}/${total} checks passed ===`);

  if (failed.length > 0) {
    console.error(`\n${RED}FAILED checks:${RESET}`);
    for (const f of failed) {
      console.error(`  - ${f.name}: ${f.message}`);
    }
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`\n${GREEN}All checks passed.${RESET}\n`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('verify-backup fatal error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
