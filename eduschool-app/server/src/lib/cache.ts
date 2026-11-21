import IORedis from 'ioredis';
import { createLogger } from './logger';

const log = createLogger('cache');
let redis: IORedis | null = null;

export function initCache(redisUrl: string) {
  redis = new IORedis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
  redis.on('error', (e) => log.warn({ err: e }, 'Redis error'));
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // cache miss is non-fatal
  }
}

export async function cacheInvalidate(pattern: string) {
  if (!redis) return;
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  } catch {}
}

export async function pingRedis(): Promise<boolean> {
  if (!redis) return false;
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

/** Raw Redis client — used by rate limiters and distributed locks. */
export function getRawRedis(): IORedis | null {
  return redis;
}
