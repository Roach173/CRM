import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import IORedis from 'ioredis';
import jwt from 'jsonwebtoken';
import { getCachedUser } from './userCache';
import { getSubscriptionState } from './subscription';
import { getJwtSecret } from './jwtSecret';
import { createLogger } from './logger';

const log = createLogger('socket');
let io: SocketServer | null = null;

interface TokenPayload {
  userId: number;
  schoolId: number | null;
  role: string;
  tokenVersion?: number;
}

function isSocketWriteEvent(event: string): boolean {
  // TODO: register future write-capable socket events explicitly here.
  const normalized = event.toLowerCase();
  return [
    'add',
    'attendance',
    'broadcast',
    'create',
    'delete',
    'ensure',
    'mark',
    'patch',
    'post',
    'put',
    'remove',
    'save',
    'submit',
    'sync',
    'update',
    'write',
  ].some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}:`) || normalized.startsWith(`${prefix}-`));
}

export function initSocket(httpServer: HttpServer) {
  io = new SocketServer(httpServer, {
    cors: {
      origin: [
        process.env.CLIENT_URL || 'http://localhost:5173',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:5174',
        'http://127.0.0.1:5174',
      ],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Redis adapter — enables Socket.IO events across multiple API instances.
  // Without this, emits from instance A won't reach clients on instance B.
  // Graceful fallback: if REDIS_URL is absent, in-memory adapter is used (single-instance only).
  if (process.env.REDIS_URL) {
    try {
      const pubClient = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
      const subClient = pubClient.duplicate();
      pubClient.on('error', (e) => log.error({ err: e }, 'redis pub client error'));
      subClient.on('error', (e) => log.error({ err: e }, 'redis sub client error'));
      io.adapter(createAdapter(pubClient, subClient));
      log.info('Redis adapter enabled — multi-instance ready');
    } catch (e: any) {
      log.error({ err: e }, 'Redis adapter failed, falling back to in-memory');
    }
  }

  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Unauthorized'));
    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, getJwtSecret()) as TokenPayload;
    } catch {
      return next(new Error('Unauthorized'));
    }

    try {
      const user = await getCachedUser(payload.userId);
      if (!user || user.deletedAt) return next(new Error('Unauthorized'));
      const jwtVersion = payload.tokenVersion ?? 0;
      if (jwtVersion !== user.tokenVersion) return next(new Error('Unauthorized'));

      const schoolId = user.schoolId ?? payload.schoolId ?? null;
      if (schoolId && user.role !== 'SUPERADMIN') {
        const subscription = await getSubscriptionState(schoolId);
        if (!subscription.canRead) return next(new Error('Subscription blocked'));
        (socket as any).subscription = subscription;
      }

      (socket as any).user = {
        userId: user.id,
        schoolId,
        role: user.role,
        tokenVersion: user.tokenVersion,
      };
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user as TokenPayload;
    socket.join(`user:${user.userId}`);

    // Each school gets its own room for broadcast isolation
    if (user.schoolId) {
      socket.join(`school:${user.schoolId}`);
    }
    socket.use(([event], next) => {
      const subscription = (socket as any).subscription as Awaited<ReturnType<typeof getSubscriptionState>> | undefined;
      if (subscription && !subscription.canWrite && isSocketWriteEvent(String(event))) {
        return next(new Error('Payment required'));
      }
      next();
    });
    socket.on('disconnect', () => {});
  });

  log.info('Socket.IO initialized');
  return io;
}

export function emitToSchool(schoolId: number, event: string, data: unknown) {
  if (!io) return;
  io.to(`school:${schoolId}`).emit(event, data);
}

export function emitToUser(userId: number, event: string, data: unknown) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

export function getIo() {
  return io;
}
