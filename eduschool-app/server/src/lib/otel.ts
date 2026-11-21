/**
 * OpenTelemetry tracing module.
 *
 * Activation: set OTLP_ENDPOINT env var (e.g. http://localhost:4318/v1/traces).
 * Without it the module loads but all spans are no-ops — zero overhead in dev.
 *
 * Import this file FIRST in index.ts / worker.ts (before express, ioredis, etc.)
 * so that auto-instrumentations can patch modules at load time.
 */

import { trace, context, SpanStatusCode, Span } from '@opentelemetry/api';
import { createLogger } from './logger';

const log = createLogger('otel');
let sdkStarted = false;

export function initOtel(): void {
  const endpoint = process.env.OTLP_ENDPOINT;
  if (!endpoint || sdkStarted) return;

  try {
    // Dynamic require so the heavy SDK is only loaded when OTLP_ENDPOINT is set.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

    const sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME || 'eduschool-api',
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable noisy low-value instrumentations
          '@opentelemetry/instrumentation-fs':  { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
        }),
      ],
    });

    sdk.start();
    sdkStarted = true;
    log.info({ endpoint }, 'tracing started');

    // Graceful shutdown on SIGTERM (called before server.close)
    process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
  } catch (err: any) {
    log.warn({ err }, 'failed to start SDK');
  }
}

/** Returns the shared tracer for manual instrumentation. */
function getTracer() {
  return trace.getTracer('eduschool', '1.0.0');
}

/**
 * Wraps an async function in an OpenTelemetry span.
 * Sets OK status on success, records exception + ERROR status on failure.
 * When SDK is not initialized spans are no-ops.
 *
 * @example
 * return withSpan('cron.extendAllBlockSessions', async (span) => {
 *   span.setAttribute('blockCount', blocks.length);
 *   return doWork();
 * });
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {}
): Promise<T> {
  const span = getTracer().startSpan(name);

  if (Object.keys(attributes).length > 0) {
    span.setAttributes(attributes);
  }

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}
