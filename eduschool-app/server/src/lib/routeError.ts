import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { createLogger } from './logger';

const log = createLogger('routeError');
const SAFE_HTTP_STATUSES = new Set([400, 403, 404, 409, 422]);

/**
 * Unified lifecycle error → HTTP response mapping.
 * Handles: P2025 optimistic-lock miss → 409, safe httpStatus passthrough,
 * GroupLifecycleError statusCode + code, unknown → 500 (no message leak).
 */
export function sendLifecycleError(res: Response, err: any, fallback: string): void {
  // Prisma optimistic lock miss
  if (err?.code === 'P2025') {
    res.status(409).json({ success: false, error: 'STALE_DATA' });
    return;
  }

  // GroupLifecycleError uses statusCode (not httpStatus)
  const status: number = err?.httpStatus ?? err?.statusCode ?? 0;

  if (SAFE_HTTP_STATUSES.has(status)) {
    const body: Record<string, unknown> = { success: false, error: err.message };
    if (err?.code) body.code = err.code;
    if (err?.details) Object.assign(body, err.details);
    res.status(status).json(body);
    return;
  }

  Sentry.captureException(err);
  log.error({ err }, 'unhandled lifecycle error');
  res.status(500).json({ success: false, error: fallback });
}
