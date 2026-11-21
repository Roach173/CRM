import { createLogger } from './logger';

const log = createLogger('serializableRetry');

// Prisma error code for serialization failure (PostgreSQL: 40001 / 40P01)
const SERIALIZATION_CODES = new Set(['P2034']);
const SERIALIZATION_MESSAGES = [
  'could not serialize access',
  'deadlock detected',
  'concurrent update',
];

function isSerializationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  if (typeof e.code === 'string' && SERIALIZATION_CODES.has(e.code)) return true;
  if (typeof e.message === 'string') {
    const msg = (e.message as string).toLowerCase();
    return SERIALIZATION_MESSAGES.some(m => msg.includes(m));
  }
  return false;
}

/**
 * Retries a function on PostgreSQL serialization conflicts (P2034 / deadlock).
 *
 * Use this to wrap prisma.$transaction(..., { isolationLevel: Serializable })
 * calls or any block that may fail with a serialization error under concurrent
 * load. Backoff is exponential with jitter to avoid thundering herd.
 *
 * @param fn        Function to retry — must be safe to call multiple times.
 * @param maxRetries Max retry attempts after the first failure (default: 3).
 * @param baseDelayMs Base delay in ms; doubles each attempt (default: 50ms).
 */
export async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 50,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isSerializationError(err) || attempt === maxRetries) {
        throw err;
      }
      // Exponential backoff with ±50% jitter to avoid thundering herd
      const jitter = baseDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
      log.warn(
        { attempt, nextRetryMs: Math.round(jitter), errCode: (err as any)?.code },
        'Serialization conflict — retrying',
      );
      await new Promise(r => setTimeout(r, jitter));
    }
  }
  // Unreachable — TypeScript requires explicit throw after loop
  throw new Error('withSerializableRetry: unreachable');
}
