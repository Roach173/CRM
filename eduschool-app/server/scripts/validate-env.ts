/**
 * validate-env.ts
 * Pre-flight environment variable validation for Shamdan.
 *
 * Usage:
 *   npx tsx scripts/validate-env.ts
 *   npx tsx scripts/validate-env.ts --env production
 *
 * Exit 0  = all required vars present and valid.
 * Exit 1  = one or more REQUIRED vars missing or invalid.
 *
 * Warnings (YELLOW) do NOT fail the exit code but indicate configuration
 * gaps that should be addressed before production.
 *
 * Run this as part of the CI/CD pre-deploy gate:
 *   NODE_ENV=production npx tsx scripts/validate-env.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env without overriding real env vars (CI injects real ones)
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

const args = process.argv.slice(2);
const envFlagIdx = args.indexOf('--env');
const env = envFlagIdx !== -1
  ? args[envFlagIdx + 1]
  : (process.env.NODE_ENV ?? 'development');

const isProd = env === 'production';

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

let exitCode = 0;

function ok(key: string, msg: string) {
  console.log(`${GREEN}✓${RESET} ${key}: ${msg}`);
}
function fail(key: string, msg: string) {
  console.error(`${RED}✗${RESET} ${key}: ${msg}`);
  exitCode = 1;
}
function warn(key: string, msg: string) {
  console.warn(`${YELLOW}⚠${RESET} ${key}: ${msg}`);
}

console.log(`\n=== Shamdan Environment Validation (mode: ${env}) ===\n`);

// ── DATABASE_URL (required, always) ──────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  fail('DATABASE_URL', 'Required — PostgreSQL connection string not set');
} else if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
  fail('DATABASE_URL', `Must start with postgresql:// or postgres:// — got: ${dbUrl.slice(0, 20)}...`);
} else {
  const hasSsl = dbUrl.includes('sslmode=require') || dbUrl.includes('sslmode=verify-full');
  if (isProd && !hasSsl) {
    warn('DATABASE_URL', 'Production DB should include ?sslmode=require for encrypted transit');
  } else {
    ok('DATABASE_URL', isProd ? (hasSsl ? 'set, SSL enforced' : 'set') : 'set');
  }
}

// ── JWT_SECRET (required, 32+ chars in production) ───────────────────────────

const jwtSecret = process.env.JWT_SECRET;
const KNOWN_WEAK = new Set(['secret', 'changeme', 'your-secret-key', 'jwt-secret', 'password']);

if (!jwtSecret) {
  if (isProd) {
    fail('JWT_SECRET', 'Required in production — generate with: openssl rand -base64 32');
  } else {
    warn('JWT_SECRET', 'Not set — server will use a weak fallback (insecure, never deploy this)');
  }
} else if (KNOWN_WEAK.has(jwtSecret.toLowerCase())) {
  fail('JWT_SECRET', 'Default/placeholder value detected — must be a random secret');
} else if (jwtSecret.length < 32) {
  fail('JWT_SECRET', `Too short: ${jwtSecret.length} chars — minimum 32 chars required`);
} else {
  ok('JWT_SECRET', `set (${jwtSecret.length} chars)`);
}

// ── CLIENT_URL (required in production; CORS will block frontend if wrong) ───

const clientUrl = process.env.CLIENT_URL;
if (!clientUrl) {
  if (isProd) {
    fail('CLIENT_URL', 'Required in production — CORS will block all frontend requests without it');
  } else {
    warn('CLIENT_URL', 'Not set — CORS defaults to http://localhost:5173 (dev only)');
  }
} else if (clientUrl.endsWith('/')) {
  fail('CLIENT_URL', `Must NOT end with trailing slash — got: ${clientUrl}`);
} else {
  try {
    const url = new URL(clientUrl);
    if (isProd && url.protocol !== 'https:') {
      warn('CLIENT_URL', `Production should use https:// — got: ${clientUrl}`);
    } else {
      ok('CLIENT_URL', clientUrl);
    }
  } catch {
    fail('CLIENT_URL', `Not a valid URL: ${clientUrl}`);
  }
}

// ── PORT (optional, must be valid number if set) ──────────────────────────────

const port = process.env.PORT;
if (!port) {
  ok('PORT', 'not set — defaults to 3001');
} else {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    fail('PORT', `Invalid port number: ${port}`);
  } else {
    ok('PORT', port);
  }
}

// ── REDIS_URL (optional, but degrades features if absent) ────────────────────

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  warn(
    'REDIS_URL',
    'Not set — BullMQ queue, Socket.IO multi-instance scaling, and analytics cache are disabled. ' +
    'Acceptable for single-node closed beta; required before multi-instance scale-out.',
  );
} else {
  // Mask credentials in log output
  const safeUrl = redisUrl.replace(/\/\/(.*?)@/, '//***@');
  ok('REDIS_URL', `set — ${safeUrl}`);
}

// ── SENTRY_DSN (optional, but production monitoring is blind without it) ──────

const sentryDsn = process.env.SENTRY_DSN;
if (!sentryDsn) {
  if (isProd) {
    warn('SENTRY_DSN', 'Not set — production error monitoring is disabled. Strongly recommended.');
  } else {
    ok('SENTRY_DSN', 'not set — OK for non-production');
  }
} else {
  ok('SENTRY_DSN', 'set');
}

// ── RESEND_API_KEY / FROM_EMAIL (email verification, password reset, invites) ─

const resendKey = process.env.RESEND_API_KEY;
if (!resendKey) {
  if (isProd) {
    warn(
      'RESEND_API_KEY',
      'Not set — falls back to a dummy key. Verification/password-reset/invite emails will silently ' +
      'fail to send, and login is blocked for unverified users. Sign up at resend.com and set this before go-live.',
    );
  } else {
    ok('RESEND_API_KEY', 'not set — OK in dev, emails are logged instead of sent');
  }
} else {
  ok('RESEND_API_KEY', 'set');
}

const fromEmail = process.env.FROM_EMAIL;
if (!fromEmail || fromEmail === 'onboarding@resend.dev') {
  if (isProd) {
    warn(
      'FROM_EMAIL',
      'Not set (or using Resend\'s sandbox sender onboarding@resend.dev) — that address can only deliver ' +
      'to your own Resend account email, not real users. Verify a domain in Resend and set FROM_EMAIL to an address on it.',
    );
  } else {
    ok('FROM_EMAIL', 'not set — OK in dev');
  }
} else {
  ok('FROM_EMAIL', fromEmail);
}

// ── DISABLE_CRON (advisory in production) ────────────────────────────────────

if (isProd) {
  const disableCron = process.env.DISABLE_CRON;
  if (disableCron === 'true') {
    ok('DISABLE_CRON', 'true — this is an API instance (cron runs in separate worker)');
  } else {
    warn(
      'DISABLE_CRON',
      'Not set to "true" — this instance WILL run cron jobs. ' +
      'Ensure exactly ONE process has cron enabled (the worker). ' +
      'API instances must set DISABLE_CRON=true.',
    );
  }
}

// ── DB_POOL_SIZE (optional, must be valid if set) ─────────────────────────────

const poolSize = process.env.DB_POOL_SIZE;
if (poolSize !== undefined && poolSize !== '') {
  const n = Number(poolSize);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    fail('DB_POOL_SIZE', `Invalid value: "${poolSize}" — must be an integer 1–100`);
  } else {
    ok('DB_POOL_SIZE', `${n} connections per instance`);
  }
}

// ── RP_ID (WebAuthn/passkey relying party ID — no runtime guard, silently ──────
// breaks passkeys if left at the 'localhost' default in production) ──────────

const rpId = process.env.RP_ID;
if (!rpId || rpId === 'localhost') {
  if (isProd) {
    fail('RP_ID', 'Must be set to the bare production domain (e.g. "app.eduschool.com") — passkeys silently fail otherwise');
  } else {
    ok('RP_ID', 'not set — defaults to "localhost" (OK for dev)');
  }
} else {
  ok('RP_ID', rpId);
}

// ── GOOGLE_CLIENT_ID (server-side OAuth audience check — Google login 401s ────
// for every attempt if unset, but that fails closed, so this is a warning) ────

if (!process.env.GOOGLE_CLIENT_ID) {
  warn('GOOGLE_CLIENT_ID', 'Not set — "Sign in with Google" is unavailable (fails closed, not a security risk)');
} else {
  ok('GOOGLE_CLIENT_ID', 'set');
}

// ── RESEND_API_KEY (transactional email — falls back to a dummy key that ──────
// silently fails to send if unset) ─────────────────────────────────────────────

if (!process.env.RESEND_API_KEY) {
  if (isProd) {
    warn('RESEND_API_KEY', 'Not set — verification/reset/invite emails will silently fail to send in production');
  } else {
    ok('RESEND_API_KEY', 'not set — OK for non-production (emails logged instead of sent)');
  }
} else {
  ok('RESEND_API_KEY', 'set');
}

// ── BACKUP_DIR (optional, used by verify-backup.ts) ──────────────────────────

const backupDir = process.env.BACKUP_DIR;
if (!backupDir) {
  warn('BACKUP_DIR', 'Not set — verify-backup.ts will use CWD for disk space check');
} else {
  ok('BACKUP_DIR', backupDir);
}

// ── MIN_FREE_DISK_MB (optional) ───────────────────────────────────────────────

const minDisk = process.env.MIN_FREE_DISK_MB;
if (minDisk !== undefined && minDisk !== '') {
  const n = Number(minDisk);
  if (!Number.isInteger(n) || n < 100) {
    warn('MIN_FREE_DISK_MB', `Low value: ${minDisk} MB — recommend at least 500`);
  } else {
    ok('MIN_FREE_DISK_MB', `${n} MB threshold`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
if (exitCode === 0) {
  console.log(`${GREEN}Environment validation passed — OK to proceed.${RESET}\n`);
} else {
  console.error(
    `${RED}Environment validation FAILED — fix the above errors before deploying to ${env}.${RESET}\n`,
  );
}

process.exit(exitCode);
