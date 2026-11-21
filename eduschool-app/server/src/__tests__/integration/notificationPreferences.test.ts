import express from 'express';
import request from 'supertest';
import { Role } from '@prisma/client';
import prisma from '../../lib/prisma';
import { emitToUser } from '../../lib/socket';
import notificationsRouter from '../../routes/notifications';
import {
  createForRole,
  createForUser,
  NotificationCategory,
  NotificationPriority,
} from '../../services/notificationService';

const schoolRoles = [Role.OWNER, Role.ADMIN, Role.TEACHER, Role.STUDENT, Role.PARENT] as const;

let mockUser: { userId: number; schoolId: number; role: Role; tokenVersion: number } = {
  userId: 10,
  schoolId: 1,
  role: Role.OWNER,
  tokenVersion: 0,
};

jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: {
    notification: {
      create: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    notificationPreference: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  },
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

const notification = {
  id: 101,
  userId: 10,
  schoolId: 1,
  type: 'PAYMENT_CREATED',
  category: NotificationCategory.FINANCE,
  priority: NotificationPriority.NORMAL,
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

describe('notification preferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { userId: 10, schoolId: 1, role: Role.OWNER, tokenVersion: 0 };
    (prisma.notification.count as jest.Mock).mockResolvedValue(3);
    (prisma.notification.create as jest.Mock).mockImplementation(({ data }) => ({
      ...notification,
      ...data,
      id: data.userId,
      isRead: false,
      readAt: null,
      createdAt: notification.createdAt,
    }));
    (prisma.notificationPreference.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.notificationPreference.upsert as jest.Mock).mockResolvedValue({});
  });

  it('GET /notifications/preferences returns all categories with defaults', async () => {
    const res = await request(appWithNotificationsRouter())
      .get('/notifications/preferences')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'SYSTEM', enabled: true, locked: true }),
        expect.objectContaining({ category: 'FINANCE', enabled: true, locked: false }),
        expect.objectContaining({ category: 'SUBSCRIPTION', enabled: true, locked: true }),
      ]),
    );
    expect(res.body.data.categories).toHaveLength(8);
    expect(prisma.notificationPreference.findMany).toHaveBeenCalledWith({
      where: { userId: 10 },
      select: { category: true, inAppEnabled: true },
    });
  });

  it.each(schoolRoles)('%s can load own notification preferences', async (role) => {
    mockUser = { userId: 10, schoolId: 1, role, tokenVersion: 0 };

    const res = await request(appWithNotificationsRouter())
      .get('/notifications/preferences')
      .send();

    expect(res.status).toBe(200);
    expect(prisma.notificationPreference.findMany).toHaveBeenCalledWith({
      where: { userId: 10 },
      select: { category: true, inAppEnabled: true },
    });
  });

  it.each(schoolRoles)('%s can update own notification preferences', async (role) => {
    mockUser = { userId: 10, schoolId: 1, role, tokenVersion: 0 };

    const res = await request(appWithNotificationsRouter())
      .patch('/notifications/preferences')
      .send({
        preferences: [
          { category: 'STUDENTS', enabled: false, userId: 999 },
        ],
      });

    expect(res.status).toBe(200);
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId_category: {
          userId: 10,
          category: 'STUDENTS',
        },
      },
    }));
  });

  it('PATCH /notifications/preferences updates unlocked categories for the current user only', async () => {
    (prisma.notificationPreference.findMany as jest.Mock).mockResolvedValue([
      { category: 'STUDENTS', inAppEnabled: false },
    ]);

    const res = await request(appWithNotificationsRouter())
      .patch('/notifications/preferences')
      .send({
        preferences: [
          { category: 'STUDENTS', enabled: false, userId: 999 },
        ],
      });

    expect(res.status).toBe(200);
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith({
      where: {
        userId_category: {
          userId: 10,
          category: 'STUDENTS',
        },
      },
      create: {
        userId: 10,
        category: 'STUDENTS',
        inAppEnabled: false,
      },
      update: {
        inAppEnabled: false,
      },
    });
    expect(res.body.data.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'STUDENTS', enabled: false }),
      ]),
    );
  });

  it('PATCH /notifications/preferences rejects invalid and locked categories', async () => {
    const invalidRes = await request(appWithNotificationsRouter())
      .patch('/notifications/preferences')
      .send({ preferences: [{ category: 'UNKNOWN', enabled: false }] });

    expect(invalidRes.status).toBe(400);
    expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();

    const lockedRes = await request(appWithNotificationsRouter())
      .patch('/notifications/preferences')
      .send({ preferences: [{ category: 'SYSTEM', enabled: false }] });

    expect(lockedRes.status).toBe(400);
    expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
  });

  it('skips disabled non-critical category notifications without realtime emit', async () => {
    (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue({ inAppEnabled: false });

    const result = await createForUser({
      userId: 10,
      schoolId: 1,
      type: 'PAYMENT_CREATED',
      category: NotificationCategory.FINANCE,
      priority: NotificationPriority.NORMAL,
      title: 'Payment received',
      body: 'A payment was recorded',
    });

    expect(result).toEqual({
      created: false,
      notification: null,
      skippedReason: 'preference_disabled',
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled();
  });

  it('creates critical notifications even when category preference is disabled', async () => {
    (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue({ inAppEnabled: false });

    const result = await createForUser({
      userId: 10,
      schoolId: 1,
      type: 'FINANCE_CRITICAL_ALERT',
      category: NotificationCategory.FINANCE,
      priority: NotificationPriority.CRITICAL,
      title: 'Critical issue',
      body: 'Finance critical issue needs review',
    });

    expect(result.created).toBe(true);
    expect(prisma.notificationPreference.findUnique).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        priority: NotificationPriority.CRITICAL,
        category: NotificationCategory.FINANCE,
      }),
    });
    expect(emitToUser).toHaveBeenCalledWith(10, 'notification:new', expect.any(Object));
  });

  it('createForRole respects each recipient preference', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 10 }, { id: 20 }]);
    (prisma.notificationPreference.findUnique as jest.Mock).mockImplementation(({ where }) => (
      where.userId_category.userId === 10 ? { inAppEnabled: false } : null
    ));

    const created = await createForRole({
      schoolId: 1,
      role: Role.OWNER,
      type: 'STUDENT_CREATED',
      category: NotificationCategory.STUDENTS,
      priority: NotificationPriority.NORMAL,
      title: 'Student added',
      body: 'A new student joined',
    });

    expect(created).toBe(1);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 20, category: NotificationCategory.STUDENTS }),
    });
  });
});
