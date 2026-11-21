import pino from 'pino';
import { getContext } from './requestContext';

const isDev = process.env.NODE_ENV !== 'production';

export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: isDev ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } } : undefined,
  mixin() {
    const ctx = getContext();
    if (!ctx) return {};
    const fields: Record<string, unknown> = {};
    if (ctx.requestId) fields.requestId = ctx.requestId;
    if (ctx.schoolId)  fields.schoolId  = ctx.schoolId;
    if (ctx.userId)    fields.userId    = ctx.userId;
    return fields;
  },
});

export function createLogger(domain: string) {
  return rootLogger.child({ domain });
}
