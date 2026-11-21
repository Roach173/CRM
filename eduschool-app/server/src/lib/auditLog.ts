import { PrismaClient, Prisma } from '@prisma/client';
import { Request } from 'express';
import { createLogger } from './logger';
import prismaClient from './prisma';
import { getRequestId } from './requestContext';

const secLog = createLogger('security');

type DbClient =
  | PrismaClient
  | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

type EntityType = 'session' | 'block' | 'group' | 'student';

interface AuditLogParams {
  client: DbClient;
  schoolId: number;
  userId: number;
  action: string;
  entityType?: EntityType;
  sessionId?: number;
  blockId?: number;
  groupId?: number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  req?: Request;
}

interface FinanceAuditParams {
  client: DbClient;
  schoolId: number;
  userId: number;
  action: string;
  entityType: 'invoice' | 'payment' | 'allocation' | 'refund' | 'adjustment';
  entityId: number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  req?: Request;
}

export async function logFinanceAction({
  client,
  schoolId,
  userId,
  action,
  entityType,
  entityId,
  before,
  after,
  req,
}: FinanceAuditParams): Promise<void> {
  const ip = req
    ? ((req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress)
    : undefined;

  await (client as PrismaClient).scheduleActionLog.create({
    data: {
      schoolId,
      userId,
      action,
      entityType,
      before: before !== undefined ? (before as Prisma.InputJsonValue) : Prisma.JsonNull,
      after:  after  !== undefined ? ({ entityId, ...after } as Prisma.InputJsonValue) : ({ entityId } as Prisma.InputJsonValue),
      reason: null,
      ipAddress: ip ?? null,
    },
  });
}

interface SecurityEventParams {
  /** Short machine-readable event identifier, e.g. 'SSRF_BLOCKED', 'UPLOAD_REJECTED', 'CLEAR_ALL_DATA' */
  event: string;
  schoolId?: number | null;
  userId?: number | null;
  details?: Record<string, unknown>;
  req?: Request;
}

/**
 * Logs a security-relevant event.
 * Always writes to structured pino log (observable via log aggregation without DB access).
 * Also persists to ScheduleActionLog when schoolId and userId are available.
 */
export async function logSecurityEvent({
  event,
  schoolId,
  userId,
  details,
  req,
}: SecurityEventParams): Promise<void> {
  const ip = req
    ? ((req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress)
    : undefined;

  const requestId = req
    ? (req.headers['x-request-id'] as string | undefined) ?? getRequestId()
    : getRequestId();

  secLog.warn({ event, schoolId, userId, ip, requestId, ...details }, `SECURITY_EVENT: ${event}`);

  if (schoolId != null && userId != null) {
    try {
      await (prismaClient as PrismaClient).scheduleActionLog.create({
        data: {
          schoolId,
          userId,
          action: `SECURITY:${event}`,
          entityType: 'security',
          before: Prisma.JsonNull,
          after: (details || requestId)
            ? ({ ...details, requestId } as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          reason: null,
          ipAddress: ip ?? null,
        },
      });
    } catch {
      // Non-fatal — DB log failure must not affect the calling request
      secLog.error({ event, schoolId, userId }, 'failed to persist security event to DB');
    }
  }
}

export async function logScheduleAction({
  client,
  schoolId,
  userId,
  action,
  entityType = 'session',
  sessionId,
  blockId,
  groupId,
  before,
  after,
  reason,
  req,
}: AuditLogParams): Promise<void> {
  const ip = req
    ? ((req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress)
    : undefined;

  await (client as PrismaClient).scheduleActionLog.create({
    data: {
      schoolId,
      userId,
      action,
      entityType,
      ...(sessionId !== undefined && { sessionId }),
      ...(blockId !== undefined && { blockId }),
      ...(groupId !== undefined && { groupId }),
      before: before !== undefined ? (before as Prisma.InputJsonValue) : Prisma.JsonNull,
      after: after !== undefined ? (after as Prisma.InputJsonValue) : Prisma.JsonNull,
      reason: reason ?? null,
      ipAddress: ip ?? null,
    },
  });
}
