import rateLimit, { Store, Options, ClientRateLimitInfo } from 'express-rate-limit';
import { getRawRedis } from '../lib/cache';
import { logSecurityEvent } from '../lib/auditLog';
import type { AuthRequest } from './authenticate';

// Lua: atomic INCR + first-hit EXPIRE + return [count, pttl]
const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local pttl = redis.call('PTTL', KEYS[1])
return {c, pttl}
`;

class RedisRateLimitStore implements Store {
  private windowMs = 60_000;
  private localHits = new Map<string, { count: number; resetAt: number }>();

  constructor(private _prefix: string) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const r = getRawRedis();

    if (r) {
      try {
        const redisKey = this._prefix + key;
        const windowSecs = String(Math.ceil(this.windowMs / 1000));
        const result = await r.eval(INCR_SCRIPT, 1, redisKey, windowSecs) as [number, number];
        return {
          totalHits: result[0],
          resetTime: result[1] > 0 ? new Date(Date.now() + result[1]) : undefined,
        };
      } catch {
        // Redis error → fall through to in-memory
      }
    }

    // In-memory fallback (single-instance mode or Redis unavailable)
    const now = Date.now();
    const existing = this.localHits.get(key);
    if (!existing || now > existing.resetAt) {
      const entry = { count: 1, resetAt: now + this.windowMs };
      this.localHits.set(key, entry);
      return { totalHits: 1, resetTime: new Date(entry.resetAt) };
    }
    existing.count++;
    return { totalHits: existing.count, resetTime: new Date(existing.resetAt) };
  }

  async decrement(key: string): Promise<void> {
    const r = getRawRedis();
    if (r) {
      await r.decr(this._prefix + key).catch(() => {});
    } else {
      const e = this.localHits.get(key);
      if (e && e.count > 0) e.count--;
    }
  }

  async resetKey(key: string): Promise<void> {
    const r = getRawRedis();
    if (r) {
      await r.del(this._prefix + key).catch(() => {});
    } else {
      this.localHits.delete(key);
    }
  }
}

function limiter(windowMs: number, max: number, message: string, storePrefix: string) {
  const body = { success: false, error: message };
  return rateLimit({
    windowMs,
    max,
    message: body,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    store: new RedisRateLimitStore(storePrefix),
    // Default handler sends `message` silently — a 429 is a security-relevant
    // signal (brute force, abuse) and previously left no trace anywhere.
    // Awaited — see requirePermission.ts for why a fire-and-forget write here
    // is worth avoiding.
    handler: async (req, res) => {
      const authReq = req as AuthRequest;
      await logSecurityEvent({
        event: 'RATE_LIMIT_TRIGGERED',
        schoolId: authReq.user?.schoolId ?? null,
        userId: authReq.user?.userId ?? null,
        details: { path: req.path, method: req.method, limiter: storePrefix },
        req,
      });
      res.status(429).json(body);
    },
  });
}

// Attendance: 60 marks per minute per IP
export const attendanceLimiter   = limiter(60_000,  60,  'Слишком много запросов. Подождите минуту.',           'rl:att:');

// Session ensure: 30 per minute
export const sessionEnsureLimiter = limiter(60_000, 30,  'Слишком много запросов. Подождите минуту.',           'rl:ens:');

// Notifications: 20 reads per minute
export const notificationsLimiter = limiter(60_000, 20,  'Слишком много запросов. Подождите минуту.',           'rl:ntf:');

// Enrollment apply: 10 per 5 min
export const enrollmentLimiter   = limiter(300_000, 10,  'Слишком много заявок. Подождите 5 минут.',            'rl:enr:');

// Credit operations: 30 per minute
export const creditsLimiter      = limiter(60_000,  30,  'Слишком много запросов к кредитам. Подождите минуту.', 'rl:crd:');

// General API: 200 per minute (fallback)
export const generalLimiter      = limiter(60_000,  200, 'Слишком много запросов. Подождите минуту.',            'rl:gen:');

// Upload: 10 per minute per IP (prevents upload abuse / quota exhaustion)
export const uploadLimiter       = limiter(60_000,  10,  'Слишком много загрузок. Подождите минуту.',             'rl:upl:');
