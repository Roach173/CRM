import { initOtel } from './lib/otel'; // Must be first — patches modules at load time
initOtel();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import { initSentry, Sentry } from './instrument';
initSentry();
import routes from './routes';
import { generalLimiter } from './middleware/rateLimiters';
import { ALLOWED_ORIGINS } from './lib/allowedOrigins';
import prisma from './lib/prisma';
import { initQueue, closeQueue } from './lib/queue';
import { initSocket } from './lib/socket';
import { initCache, pingRedis } from './lib/cache';
import { startCronJobs } from './lib/cronJobs';
import { createLogger, rootLogger } from './lib/logger';
import pinoHttp from 'pino-http';
import type { Level, Logger } from 'pino';
import { register } from './lib/metrics';
import { metricsMiddleware } from './middleware/metricsMiddleware';
import { getCronState } from './lib/cronJobs';

// ── Env validation ────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  // Pre-boot fatal: console is intentional — must survive immediate process.exit.
  console.error('[startup] FATAL: DATABASE_URL is not set — cannot connect to database'); // no-console-ok
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    // Pre-boot fatal: console is intentional — must survive immediate process.exit.
    console.error('[startup] FATAL: JWT_SECRET is missing or too weak (minimum 32 chars required in production)'); // no-console-ok
    process.exit(1);
  }

  if (!process.env.CLIENT_URL) {
    // Pre-boot fatal: console is intentional — must survive immediate process.exit.
    console.error('[startup] FATAL: CLIENT_URL is not set in production'); // no-console-ok
    process.exit(1);
  }
}

// ── Unhandled rejection / uncaught exception guards ──────────────────────────
const bootLog = createLogger('server');

const APP_VERSION = process.env.npm_package_version || process.env.SENTRY_RELEASE || 'unknown';
const BUILD_ENV   = process.env.NODE_ENV || 'development';

process.on('uncaughtException', (err) => {
  Sentry.captureException(err);
  bootLog.error({ err }, 'uncaughtException — shutting down');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  bootLog.error({ reason }, 'unhandledRejection — shutting down');
  process.exit(1);
});

// Enable serialization of BigInt to JSON
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app = express();
const port = process.env.PORT || 3001;

// Behind exactly one reverse proxy in production (Nginx or Render's LB).
// Without this, req.ip is the proxy's address: every user shares one
// rate-limit bucket (10 login attempts/15min for the whole school) and
// express-rate-limit rejects the X-Forwarded-For header it receives.
app.set('trust proxy', 1);

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({
  // CSP managed by frontend — disable here to avoid blocking API responses
  contentSecurityPolicy: false,
  // Allow cross-origin for API
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // HSTS: enforce HTTPS for 1 year in production only
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true }
    : false,
}));

// Disable unused browser features (defense-in-depth)
app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  next();
});

// ── Response compression ──────────────────────────────────────────────────────
// gzip/deflate every response. Large JSON payloads (schedule list, week sessions,
// analytics) shrink ~70–90% on the wire — a major win over high-latency tunnels
// and any remote client, with negligible CPU cost at this scale.
app.use(compression());

// Uploaded school branding images (logo, landing hero photo) — written by
// upload.ts into public/uploads/{schoolId}/{uuid}.webp; nothing served them
// until now, so every returned upload URL 404'd.
app.use('/uploads', express.static(path.join(process.cwd(), 'public', 'uploads'), { maxAge: '1d' }));

app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
  // Cache preflight (OPTIONS) results for a day — client and API are on
  // different origins in production, so without this every request pays
  // an extra preflight round-trip.
  maxAge: 86400
}));

// ── Correlation ID middleware ─────────────────────────────────────────────────
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('x-request-id', id);
  next();
});

// ── HTTP access log (structured, one line per request) ───────────────────────
app.use(pinoHttp({
  // Cast: rootLogger's level comes from an env string, which widens pino's
  // CustomLevels generic to `string` and breaks pino-http's overload match.
  logger: rootLogger.child({ domain: 'http' }) as unknown as Logger<Level>,
  // Reuse the correlation ID set above; the ALS context is not available in the
  // response-finish callback, so the mixin can't inject it here.
  genReqId: (req) => req.headers['x-request-id'] as string,
  autoLogging: {
    ignore: (req) => (req.url ?? '').startsWith('/health') || req.url === '/metrics',
  },
  customLogLevel: (_req, res, err): Level =>
    err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  // Keep lines lean: default serializers dump full headers/query — method/url/status is enough.
  serializers: {
    req: (r: { id: string; method: string; url: string }) => ({ id: r.id, method: r.method, url: r.url }),
    res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
  },
}));

// ── Prometheus request metrics ────────────────────────────────────────────────
app.use(metricsMiddleware);

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// ── Liveness probe: process is alive (no DB check — fast path for k8s/Railway) ─
app.get('/health/live', (_req, res) => {
  res.status(200).json({ status: 'alive', ts: new Date().toISOString() });
});

// ── Readiness probe: DB reachable + required env configured ──────────────────
app.get('/health/ready', async (_req, res) => {
  const issues: string[] = [];

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    issues.push('database unreachable');
  }

  if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
    issues.push('JWT_SECRET not configured');
  }

  if (issues.length > 0) {
    return res.status(503).json({ status: 'not_ready', issues, ts: new Date().toISOString() });
  }
  res.status(200).json({ status: 'ready', ts: new Date().toISOString() });
});

// ── Combined health (backward-compat for existing infra) ────────────────────
app.get('/health', async (_req, res) => {
  const checks = { db: false, redis: false };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch {}
  checks.redis = await pingRedis();

  const healthy = checks.db;
  const status = healthy ? 200 : 503;
  res.status(status).json({
    status: healthy ? 'healthy' : 'degraded',
    db: checks.db ? 'ok' : 'error',
    redis: process.env.REDIS_URL ? (checks.redis ? 'ok' : 'error') : 'disabled',
    ts: new Date().toISOString(),
  });
});

// ── Deep health: includes queue, cron state, memory, uptime, version ─────────
app.get('/health/deep', async (_req, res) => {
  const mem = process.memoryUsage();
  const cronState = getCronState();
  const redisOk = await pingRedis();

  let dbOk = false;
  let migrationVersion: string | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    const result = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 1
    `;
    migrationVersion = result[0]?.migration_name ?? null;
  } catch {}

  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    version: APP_VERSION,
    env: BUILD_ENV,
    uptime: Math.floor(process.uptime()),
    ts: new Date().toISOString(),
    db: { status: dbOk ? 'ok' : 'error', lastMigration: migrationVersion },
    redis: { status: redisOk ? 'ok' : (process.env.REDIS_URL ? 'error' : 'disabled') },
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      heap: `${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
    },
    cron: cronState,
  });
});

// ── Prometheus metrics endpoint ────────────────────────────────────────────────
// Restrict to internal network in production (no auth token — must be behind VPC/firewall)
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(String(err));
  }
});

// Floor rate limit for every API route. Endpoints with tighter needs (login,
// attendance, credits, ...) layer their own stricter limiter on top of this.
app.use('/api/v1', generalLimiter, routes);

app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  Sentry.captureException(err);
  const reqId = req.headers['x-request-id'] as string | undefined;
  bootLog.error({ err, reqId }, 'unhandled route error');
  const status = err.status || err.statusCode || 500;
  const message = status === 413 ? 'Payload too large' : 'Internal Server Error';
  res.status(status).json({ success: false, error: message });
});

const httpServer = createServer(app);
initSocket(httpServer);

const server = httpServer.listen(port, () => {
  bootLog.info({ port, version: APP_VERSION, env: BUILD_ENV }, 'Server running');
  if (process.env.REDIS_URL) initCache(process.env.REDIS_URL);
  // Production: set DISABLE_CRON=true and run worker.ts as a separate process.
  // Development: cron runs inline — no second process needed.
  if (process.env.DISABLE_CRON !== 'true') {
    initQueue();
    startCronJobs();
  }
});

process.on('SIGTERM', async () => {
  bootLog.info('SIGTERM received, shutting down gracefully');
  server.close(async () => {
    await closeQueue();
    await prisma.$disconnect();
    process.exit(0);
  });
});
