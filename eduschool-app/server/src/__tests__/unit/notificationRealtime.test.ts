import express from 'express';
import request from 'supertest';
import prisma from '../../lib/prisma';
import { emitToUser } from '../../lib/socket';
import notificationsRouter from '../../routes/notifications';
import { createForUser, createForUsers, NotificationCategory } from '../../services/notificationService';

jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: (() => {
    const prismaMock = {
    notification: {
      create: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    notificationPreference: {
      findUnique: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
      $transaction: jest.fn(),
    };
    prismaMock.$transaction.mockImplementation(async (opsOrFn: Array<Promise<unknown>> | Function) => (
      typeof opsOrFn === 'function' ? opsOrFn(prismaMock) : Promise.all(opsOrFn)
    ));
    return prismaMock;
  })(),
}));

jest.mock('../../lib/socket', () => ({
  emitToUser: jest.fn(),
}));

jest.mock('../../middleware/authenticate', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 10, schoolId: 1, role: 'OWNER', tokenVersion: 0 };
    next();
  },
}));

jest.mock('../../middleware/requirePermission', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const notification = {
  id: 101,
  userId: 10,
  schoolId: 1,
  type: 'PAYMENT_CREATED',
  category: NotificationCategory.FINANCE,
  priority: 'NORMAL',
  title: 'Payment received',
  body: 'A payment was recorded',
  actionUrl: null,
  entityType: null,
  entityId: null,
  isRead: false,
  readAt: null,
  data: {},
  createdAt: new Date('2026-06-01T10:00:00.000Z'),
};

function appWithNotificationsRouter() {
  const app = express();
  app.use(express.json());
  app.use('/notifications', notificationsRouter);
  return app;
}

describe('realtime notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.notification.count as jest.Mock).mockResolvedValue(3);
    (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue(null);
  });

  it('emits notification:new only to the target user after createForUser persists', async () => {
    (prisma.notification.create as jest.Mock).mockResolvedValue(notification);

    await createForUser({
      userId: 10,
      schoolId: 1,
      type: 'PAYMENT_CREATED',
      category: NotificationCategory.FINANCE,
      title: 'Payment received',
      body: 'A payment was recorded',
    });

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 10,
        schoolId: 1,
        category: NotificationCategory.FINANCE,
      }),
    });
    expect(emitToUser).toHaveBeenCalledWith(10, 'notification:new', { notification, unreadCount: 3 });
    expect(emitToUser).toHaveBeenCalledWith(10, 'notification:unread_count_changed', { unreadCount: 3 });
    expect((emitToUser as jest.Mock).mock.calls.some(([userId]) => userId !== 10)).toBe(false);
  });

  it('dedupes createForUsers recipients and emits once per created notification', async () => {
    (prisma.notification.create as jest.Mock).mockImplementation(({ data }) => ({
      ...notification,
      id: data.userId,
      userId: data.userId,
    }));

    await createForUsers([10, 10, 20], {
      schoolId: 1,
      type: 'ANNOUNCEMENT',
      category: NotificationCategory.ANNOUNCEMENT,
      title: 'Announcement',
      body: 'New message',
    });

    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(emitToUser).toHaveBeenCalledWith(10, 'notification:new', expect.any(Object));
    expect(emitToUser).toHaveBeenCalledWith(20, 'notification:new', expect.any(Object));
    expect((emitToUser as jest.Mock).mock.calls.some(([userId]) => userId === 30)).toBe(false);
  });

  it('emits notification:read with unreadCount after marking the authenticated user notification read', async () => {
    (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.notification.count as jest.Mock).mockResolvedValue(2);

    const res = await request(appWithNotificationsRouter())
      .patch('/notifications/101/read')
      .send();

    expect(res.status).toBe(200);
    expect(emitToUser).toHaveBeenCalledWith(10, 'notification:read', {
      notificationId: 101,
      unreadCount: 2,
    });
    expect((emitToUser as jest.Mock).mock.calls.some(([userId]) => userId !== 10)).toBe(false);
  });

  it('emits notification:unread with unreadCount after marking the authenticated user notification unread', async () => {
    (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.notification.count as jest.Mock).mockResolvedValue(3);

    const res = await request(appWithNotificationsRouter())
      .patch('/notifications/101/unread')
      .send();

    expect(res.status).toBe(200);
    expect(emitToUser).toHaveBeenCalledWith(10, 'notification:unread', {
      notificationId: 101,
      unreadCount: 3,
    });
    expect((emitToUser as jest.Mock).mock.calls.some(([userId]) => userId !== 10)).toBe(false);
  });

  it('emits notification:read_all with zero unread count after marking all read', async () => {
    (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

    const res = await request(appWithNotificationsRouter())
      .patch('/notifications/read-all')
      .send();

    expect(res.status).toBe(200);
    expect(emitToUser).toHaveBeenCalledWith(10, 'notification:read_all', { unreadCount: 0 });
    expect(emitToUser).toHaveBeenCalledWith(10, 'notification:unread_count_changed', { unreadCount: 0 });
  });

  it('has no DELETE route — notifications are append-only and cannot be deleted via the API', async () => {
    const res = await request(appWithNotificationsRouter())
      .delete('/notifications/101')
      .send();

    expect(res.status).toBe(404);
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
    expect(
      (emitToUser as jest.Mock).mock.calls.some(([, event]) => event === 'notification:deleted'),
    ).toBe(false);
  });
});
