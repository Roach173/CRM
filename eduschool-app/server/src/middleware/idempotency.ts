import { Request, Response, NextFunction } from 'express';
import { getRawRedis } from '../lib/cache';

const HEADER = 'idempotency-key';
const TTL_SECONDS = 86_400; // 24 hours
const localCache = new Map<string, { status: number; body: unknown; expiresAt: number }>();

function makeKey(schoolId: number | undefined, key: string): string {
  return `idem:${schoolId ?? 'anon'}:${key}`;
}

/**
 * HTTP-level idempotency guard.
 *
 * Client sends `Idempotency-Key: <uuid>` on write requests.
 * On the first call the middleware passes through and caches the response.
 * On retries with the same key the cached response is returned immediately —
 * no double credit deduction, no double payment record.
 *
 * Storage: Redis (preferred, distributed) with fallback to in-process Map.
 * Scope: per schoolId + key — cross-tenant key collision is impossible.
 *
 * Apply only to non-idempotent write endpoints (attendance, credits, makeup).
 */
export function idempotency(req: Request, res: Response, next: NextFunction): void {
  const key = (req.headers[HEADER] as string | undefined)?.trim();
  if (!key) {
    next();
    return;
  }

  // req.user is attached by authenticate() middleware before this — cast to any
  const schoolId = (req as any).user?.schoolId as number | undefined;
  const redisKey = makeKey(schoolId, key);

  const r = getRawRedis();

  const sendCached = (status: number, body: unknown) => {
    res.setHeader('Idempotent-Replayed', 'true');
    res.status(status).json(body);
  };

  const tryRedis = async () => {
    if (!r) return false;
    try {
      const raw = await r.get(redisKey);
      if (raw) {
        const cached = JSON.parse(raw) as { status: number; body: unknown };
        sendCached(cached.status, cached.body);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const tryLocal = (): boolean => {
    const cached = localCache.get(redisKey);
    if (cached && Date.now() < cached.expiresAt) {
      sendCached(cached.status, cached.body);
      return true;
    }
    if (cached) localCache.delete(redisKey);
    return false;
  };

  const storeResult = async (status: number, body: unknown) => {
    const payload = JSON.stringify({ status, body });
    if (r) {
      await r.set(redisKey, payload, 'EX', TTL_SECONDS).catch(() => {});
    } else {
      localCache.set(redisKey, { status, body, expiresAt: Date.now() + TTL_SECONDS * 1000 });
      // Evict old entries if map grows large (safety valve)
      if (localCache.size > 10_000) {
        const now = Date.now();
        for (const [k, v] of localCache) {
          if (now > v.expiresAt) localCache.delete(k);
        }
      }
    }
  };

  // Intercept res.json to capture and cache the response
  const originalJson = res.json.bind(res);
  (res as any).json = function (body: unknown) {
    // Only cache successful (non-5xx) responses
    if (res.statusCode < 500) {
      storeResult(res.statusCode, body).catch(() => {});
    }
    return originalJson(body);
  };

  // Check cache first (async, but we need to do it before next())
  Promise.resolve()
    .then(() => tryRedis())
    .then((hit) => {
      if (hit) return;
      if (tryLocal()) return;
      next();
    })
    .catch(() => next()); // Never block request on idempotency errors
}
