import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import prisma from './prisma';
import { syncSessionsForBlock } from '../services/sessionService';
import { createLogger } from './logger';

const log = createLogger('queue');
const REDIS_URL = process.env.REDIS_URL;

let redisConnection: IORedis | null = null;

// ─── Notification queue ───────────────────────────────────────────────────────

let notificationQueue: Queue | null = null;
let notificationWorker: Worker | null = null;

interface NotifyJob {
  userId: number;
  schoolId?: number | null;
  type: string;
  category?: string;
  priority?: string;
  title: string;
  body: string;
  actionUrl?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  data?: any;
}

const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: 100,
  removeOnFail: 200,
};

function makeJobId(payload: NotifyJob): string {
  const base = `notify:${payload.userId}:${payload.type}`;
  const sessionId = payload.data?.sessionId;
  const groupId = payload.data?.studentGroupId;
  if (sessionId) return `${base}:s${sessionId}`;
  if (groupId) return `${base}:g${groupId}`;
  return base;
}

async function insertNotificationDirect(job: NotifyJob) {
  await prisma.notification.create({
    data: {
      userId: job.userId,
      schoolId: job.schoolId ?? undefined,
      type: job.type,
      category: job.category ?? 'SYSTEM',
      priority: job.priority ?? 'NORMAL',
      title: job.title,
      body: job.body,
      actionUrl: job.actionUrl ?? undefined,
      entityType: job.entityType ?? undefined,
      entityId: job.entityId ?? undefined,
      data: job.data ?? {},
    },
  });
}

// ─── Session sync queue ───────────────────────────────────────────────────────
// Used when school activeDays grows — syncs each affected block via BullMQ
// instead of fire-and-forget Promise.allSettled, so DB connections are not
// exhausted under large schools (500+ blocks).
// Fallback: direct call when Redis is unavailable.

let sessionSyncQueue: Queue | null = null;
let sessionSyncWorker: Worker | null = null;

interface SyncBlockJob {
  blockId: number;
}

async function runSyncBlockDirect(blockId: number) {
  const block = await prisma.lessonBlock.findFirst({
    where: { id: blockId, deletedAt: null },
    select: {
      id: true, schoolId: true, days: true,
      startDate: true, endDate: true, studentGroupId: true,
      teacherId: true, cabinetId: true, startTime: true, endTime: true,
    },
  });
  if (block) await syncSessionsForBlock(block);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initQueue() {
  if (!REDIS_URL) {
    log.info('REDIS_URL not set — queues will be synchronous');
    return;
  }

  try {
    redisConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    redisConnection.on('error', (err) => log.error({ err }, 'redis connection error'));

    // Notification queue
    notificationQueue = new Queue('notifications', { connection: redisConnection });
    notificationWorker = new Worker<NotifyJob>(
      'notifications',
      async (job: Job<NotifyJob>) => { await insertNotificationDirect(job.data); },
      { connection: redisConnection, concurrency: 10 }
    );
    notificationWorker.on('failed', (job, err) => {
      const attempts = job?.attemptsMade ?? 0;
      const max = job?.opts?.attempts ?? DEFAULT_JOB_OPTS.attempts;
      if (attempts >= max) {
        log.error({ err, jobId: job?.id, attempts }, 'notification job exhausted retries');
      } else {
        log.warn({ err, jobId: job?.id, attempts, max }, 'notification job failed, will retry');
      }
    });

    // Session sync queue — concurrency 3: conservative to spare DB connection pool
    sessionSyncQueue = new Queue('session-sync', { connection: redisConnection });
    sessionSyncWorker = new Worker<SyncBlockJob>(
      'session-sync',
      async (job: Job<SyncBlockJob>) => { await runSyncBlockDirect(job.data.blockId); },
      { connection: redisConnection, concurrency: 3 }
    );
    sessionSyncWorker.on('failed', (job, err) => {
      log.error({ err, jobId: job?.id, blockId: job?.data?.blockId }, 'session-sync job failed');
    });

    log.info('BullMQ queues initialized (notifications + session-sync)');
  } catch (err: any) {
    log.error({ err }, 'failed to init BullMQ, falling back to sync');
    notificationQueue = null;
    notificationWorker = null;
    sessionSyncQueue = null;
    sessionSyncWorker = null;
  }
}

// ─── Notification exports ─────────────────────────────────────────────────────

export async function enqueueNotification(payload: NotifyJob): Promise<void> {
  if (notificationQueue) {
    await notificationQueue.add('notify', payload, {
      ...DEFAULT_JOB_OPTS,
      jobId: makeJobId(payload),
    });
  } else {
    await insertNotificationDirect(payload);
  }
}

export async function enqueueNotifications(payloads: NotifyJob[]): Promise<void> {
  if (payloads.length === 0) return;
  if (notificationQueue) {
    const jobs = payloads.map(p => ({
      name: 'notify',
      data: p,
      opts: { ...DEFAULT_JOB_OPTS, jobId: makeJobId(p) },
    }));
    await notificationQueue.addBulk(jobs);
  } else {
    await Promise.all(payloads.map(insertNotificationDirect));
  }
}

// ─── Session sync export ──────────────────────────────────────────────────────

/**
 * Enqueue a session sync job for the given block.
 * Job ID is deterministic — identical blockId within the same epoch deduplicates.
 * Fallback: runs syncSessionsForBlock directly when Redis is unavailable.
 */
export async function enqueueSyncBlock(blockId: number): Promise<void> {
  if (sessionSyncQueue) {
    await sessionSyncQueue.add(
      'sync-block',
      { blockId },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 50,
        removeOnFail: 100,
        // Dedup: if the same block is already queued, don't add again
        jobId: `sync-block:${blockId}`,
      }
    );
  } else {
    runSyncBlockDirect(blockId).catch(e =>
      log.error({ err: e, blockId }, 'sync-block fallback error')
    );
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

export async function closeQueue() {
  await notificationWorker?.close();
  await notificationQueue?.close();
  await sessionSyncWorker?.close();
  await sessionSyncQueue?.close();
  await redisConnection?.quit();
}
