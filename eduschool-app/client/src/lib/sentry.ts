import * as Sentry from '@sentry/react';

// Loaded via dynamic import from main.tsx so the ~40 KB gzip of @sentry/react
// stays out of the critical startup path. Init runs right after first paint;
// the pageload trace starts a few ms later than with a static import — acceptable.
export function initSentry() {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || import.meta.env.VITE_APP_VERSION,
    tracesSampleRate: import.meta.env.MODE === 'production' ? 0.1 : 1.0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    // Route-based performance tracing + replay on errors only
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    // Only trace API calls to our own backend
    tracePropagationTargets: [/^\/api\//],
    beforeSend(event) {
      // Strip sensitive data before sending to Sentry
      if (event.request?.headers) {
        const cleaned: Record<string, string> = {};
        for (const [k, v] of Object.entries(event.request.headers)) {
          const lower = k.toLowerCase();
          if (lower === 'authorization' || lower === 'cookie') {
            cleaned[k] = '[REDACTED]';
          } else {
            cleaned[k] = String(v);
          }
        }
        event.request.headers = cleaned;
      }
      return event;
    },
  });
}

export const captureException = Sentry.captureException;
