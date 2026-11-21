import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

/** Sensitive header names to strip before sending to Sentry */
const REDACTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-refresh-token',
  'x-api-key',
]);

/** Body keys to strip from request/response payloads before sending to Sentry */
const REDACTED_BODY_KEYS = new Set([
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idempotencyKey',
  'secret',
  'totpSecret',
  'backupCodes',
]);

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = REDACTED_BODY_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return result;
}

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || process.env.npm_package_version,
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: 0.1,

    beforeSend(event) {
      // Strip sensitive request headers
      if (event.request?.headers) {
        const cleaned: Record<string, string> = {};
        for (const [k, v] of Object.entries(event.request.headers)) {
          cleaned[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : String(v);
        }
        event.request.headers = cleaned;
      }

      // Strip sensitive cookies entirely
      if (event.request?.cookies) {
        event.request.cookies = {};
      }

      // Strip sensitive keys from request body
      if (event.request?.data && typeof event.request.data === 'object') {
        event.request.data = redactObject(event.request.data as Record<string, unknown>);
      }

      return event;
    },
  });
}

export { Sentry };
