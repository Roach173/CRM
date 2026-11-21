import express from 'express';
import request from 'supertest';
import prisma from '../../lib/prisma';
import notificationsRouter from '../../routes/notifications';

const schoolRoles = ['OWNER', 'ADMIN', 'TEACHER', 'STUDENT', 'PARENT'] as const;

let mockUser: { userId: number; schoolId: number; role: typeof schoolRoles[number]; tokenVersion: number } = {
  userId: 10,
  schoolId: 1,
  role: 'OWNER',
  tokenVersion: 0,
};

jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: (() => {
    const prismaMock = {
    notification: {
      count: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
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
    req.user = mockUser;
    next();
  },
}));

jest.mock('../../middleware/requirePermission', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const unreadNotification = {
  id: 101,
  userId: 10,
  schoolId: 1,
  type: 'PAYMENT_CREATED',
  category: 'FINANCE',
  priority: 'HIGH',
  title: 'Payment received',
  body: 'A payment was recorded',
  actionUrl: null,
  entityType: 'Payment',
  entityId: 55,
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

function mockListQuery(items = [unreadNotification], total = items.length, unreadCount = 7) {
  (prisma.notification.findMany as jest.Mock).mockResolvedValue(items);
  (prisma.notification.count as jest.Mock)
    .mockResolvedValueOnce(total)
    .mockResolvedValueOnce(unreadCount);
}

describe('notification pagination and filtering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { userId: 10, schoolId: 1, role: 'OWNER', tokenVersion: 0 };
    (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.notification.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  it.each(schoolRoles)('%s can list own notifications', async (role) => {
    mockUser = { userId: 10, schoolId: 1, role, tokenVersion: 0 };
    mockListQuery([unreadNotification], 1, 1);

    const res = await request(appWithNotificationsRouter())
      .get('/notifications')
      .send();

    expect(res.status).toBe(200);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 10 },
    }));
  });

  it('GET /notifications returns a paginated result with unreadCount', async () => {
    mockListQuery([unreadNotification], 45, 12);

    const res = await request(appWithNotificationsRouter())
      .get('/notifications?page=2&limit=20')
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        items: [expect.objectContaining({ id: 101, userId: 10 })],
        pagination: {
          page: 2,
          limit: 20,
          total: 45,
          totalPages: 3,
          hasNextPage: true,
          hasPrevPage: true,
        },
        unreadCount: 12,
      },
      unreadCount: 12,
    });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 20,
      take: 20,
      orderBy: { createdAt: 'desc' },
      where: { userId: 10 },
    }));
  });

  it('caps limit at 100 and defaults invalid page/filter values safely', async () => {
    mockListQuery([], 0, 0);

    await request(appWithNotificationsRouter())
      .get('/notifications?page=-4&limit=500&status=unexpected&sort=oldest')
      .send();

    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 0,
      take: 100,
      where: { userId: 10 },
    }));
  });

  it('applies unread, read, category, and priority filters to the scoped user query', async () => {
    mockListQuery();

    await request(appWithNotificationsRouter())
      .get('/notifications?status=unread&category=FINANCE&priority=HIGH')
      .send();

    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { userId: 10 },
          { OR: [{ isRead: false }, { readAt: null }] },
          { category: 'FINANCE' },
          { priority: 'HIGH' },
        ],
      },
    }));

    jest.clearAllMocks();
    mockListQuery();

    await request(appWithNotificationsRouter())
      .get('/notifications?status=read')
      .send();

    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { userId: 10 },
          { OR: [{ isRead: true }, { readAt: { not: null } }] },
        ],
      },
    }));
  });

  it('searches title, body, type, category, entityType, and numeric entityId', async () => {
    mockListQuery();

    await request(appWithNotificationsRouter())
      .get('/notifications?search=55')
      .send();

    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { userId: 10 },
          {
            OR: [
              { title: { contains: '55', mode: 'insensitive' } },
              { body: { contains: '55', mode: 'insensitive' } },
              { type: { contains: '55', mode: 'insensitive' } },
              { category: { contains: '55', mode: 'insensitive' } },
              { entityType: { contains: '55', mode: 'insensitive' } },
              { entityId: 55 },
            ],
          },
        ],
      },
    }));
  });

  it('keeps unreadCount as the full scoped count, not the current page total', async () => {
    mockListQuery([unreadNotification], 1, 9);

    const res = await request(appWithNotificationsRouter())
      .get('/notifications?status=read')
      .send();

    expect(res.body.data.pagination.total).toBe(1);
    expect(res.body.data.unreadCount).toBe(9);
    expect(prisma.notification.count).toHaveBeenNthCalledWith(2, {
      where: { userId: 10, isRead: false },
    });
  });

  it('mark read and read-all keep existing user-scoped behavior', async () => {
    (prisma.notification.count as jest.Mock).mockResolvedValue(2);

    await request(appWithNotificationsRouter()).patch('/notifications/101/read').send();
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 101, userId: 10, readAt: null },
      data: { readAt: expect.any(Date) },
    });

    await request(appWithNotificationsRouter()).patch('/notifications/read-all').send();
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 10, isRead: false },
      data: { isRead: true, readAt: expect.any(Date) },
    });
  });

  it('has no DELETE route — notifications are append-only and cannot be deleted via the API', async () => {
    const res = await request(appWithNotificationsRouter()).delete('/notifications/101').send();

    expect(res.status).toBe(404);
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
  });
});
