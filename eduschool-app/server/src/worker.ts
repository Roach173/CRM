/**
 * Worker process — запускается отдельно от API сервера.
 *
 * Prod:
 *   API:    node dist/src/index.js   (DISABLE_CRON=true)
 *   Worker: node dist/src/worker.js
 *
 * Dev (одним процессом):
 *   Оставить DISABLE_CRON не заданным — index.ts сам запустит cron.
 *   Или: tsx src/worker.ts  (отдельный терминал)
 */
import { initOtel } from './lib/otel'; // Must be first — patches modules at load time
initOtel();

import dotenv from 'dotenv';
dotenv.config();

import prisma from './lib/prisma';
import { initQueue, closeQueue } from './lib/queue';
import { initCache } from './lib/cache';
import { startCronJobs } from './lib/cronJobs';
import { createLogger } from './lib/logger';

const log = createLogger('worker');

log.info('starting');

if (process.env.REDIS_URL) {
  initCache(process.env.REDIS_URL);
}

initQueue();
startCronJobs();

process.on('SIGTERM', async () => {
  log.info('SIGTERM — graceful shutdown');
  await closeQueue();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT — graceful shutdown');
  await closeQueue();
  await prisma.$disconnect();
  process.exit(0);
});

log.info('ready');
