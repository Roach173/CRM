import { Request, Response, NextFunction } from 'express';
import { httpRequestDuration, httpRequestTotal } from '../lib/metrics';

/**
 * Records HTTP request duration and count in Prometheus.
 * Route label is normalized to avoid high-cardinality from dynamic path segments.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    const route = normalizeRoute(req.path);
    const method = req.method;
    const statusCode = String(res.statusCode);

    httpRequestDuration.observe({ method, route, status_code: statusCode }, durationSec);
    httpRequestTotal.inc({ method, route, status_code: statusCode });
  });

  next();
}

/**
 * Normalizes route paths to avoid high cardinality metric labels.
 * Replaces numeric segments with :id and UUIDs with :uuid.
 */
function normalizeRoute(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id')
    // Keep the first 80 chars to avoid label value overflow
    .slice(0, 80);
}
