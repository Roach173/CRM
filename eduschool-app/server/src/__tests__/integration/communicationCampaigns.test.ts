import express from 'express';
import request from 'supertest';
import {
  CommunicationCampaignStatus,
  CommunicationRecipientStatus,
  CommunicationTargetType,
  GroupStatus,
  MemberStatus,
  Role,
} from '@prisma/client';
import prisma from '../../lib/prisma';
import communicationsRouter from '../../routes/communications';
import { NotificationCategory, NotificationPriority } from '../../services/notificationService';
import { processDueScheduledCampaigns } from '../../services/communicationService';

let mockUser: { userId: number; schoolId: number; role: Role; tokenVersion: number } = {
  userId: 1,
  schoolId: 10,
  role: Role.OWNER,
  tokenVersion: 0,
};

jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findMany: jest.fn(),
    },
    studentGroup: {
      findMany: jest.fn(),
    },
    groupMembership: {
      findMany: jest.fn(),
    },
    parentChild: {
      findMany: jest.fn(),
    },
    notification: {
      create: jest.fn(),
      count: jest.fn(),
    },
    notificationPreference: {
      findUnique: jest.fn(),
    },
    communicationCampaign: {
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    communicationRecipient: {
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
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

function appWithCommunicationsRouter() {
  const app = express();
  app.use(express.json());
  app.use('/communications', communicationsRouter);
  return app;
}

const basePayload = {
  title: 'Important announcement',
  body: 'School message',
  category: NotificationCategory.ANNOUNCEMENT,
  priority: NotificationPriority.NORMAL,
  targetType: CommunicationTargetType.ROLES,
  targetConfig: { roles: [Role.STUDENT] },
};

const groupPayload = {
  ...basePayload,
  targetType: CommunicationTargetType.GROUPS,
  targetConfig: { groupIds: [301], audience: 'STUDENTS' },
};

const forbiddenCommunicationRoles = [Role.TEACHER, Role.STUDENT, Role.PARENT] as const;
type ForbiddenCampaignEndpoint = [
  label: string,
  method: 'get' | 'post' | 'patch',
  path: string,
  body?: Record<string, unknown>,
];

const forbiddenCampaignEndpoints: ForbiddenCampaignEndpoint[] = [
  ['campaign list', 'get', '/communications/campaigns', undefined],
  ['campaign create', 'post', '/communications/campaigns', basePayload],
  ['campaign detail', 'get', '/communications/campaigns/500', undefined],
  ['delivery recipients', 'get', '/communications/campaigns/500/recipients', undefined],
  ['recipient preview', 'post', '/communications/recipients/preview', {
    targetType: CommunicationTargetType.ROLES,
    targetConfig: { roles: [Role.STUDENT] },
  }],
  ['recipient search', 'get', '/communications/recipients/search', undefined],
  ['group search', 'get', '/communications/groups/search', undefined],
  ['draft create', 'post', '/communications/campaigns/draft', basePayload],
  ['draft update', 'patch', '/communications/campaigns/600/draft', basePayload],
  ['draft send', 'post', '/communications/campaigns/600/send', undefined],
  ['scheduled create', 'post', '/communications/campaigns/schedule', {
    ...basePayload,
    scheduledAt: '2099-06-07T12:00:00.000Z',
  }],
  ['scheduled update', 'patch', '/communications/campaigns/701/schedule', {
    title: 'Scheduled update',
    scheduledAt: '2099-06-08T12:00:00.000Z',
  }],
  ['scheduled cancel', 'post', '/communications/campaigns/701/cancel', undefined],
];

function safeUser(id: number, role: Role = Role.STUDENT) {
  return {
    id,
    email: `user${id}@example.com`,
    firstName: `First${id}`,
    lastName: `Last${id}`,
    role,
  };
}

function studentMembership(userId: number, studentProfileId = userId + 1000) {
  return {
    studentProfileId,
    studentProfile: {
      user: safeUser(userId, Role.STUDENT),
    },
  };
}

function parentLink(userId: number) {
  return {
    parentProfile: {
      user: safeUser(userId, Role.PARENT),
    },
  };
}

function setupPersistence() {
  let recipientId = 900;
  const recipientUpdates: any[] = [];
  const createdRecipients: any[] = [];
  let createdCampaign: any;

  (prisma.communicationCampaign.create as jest.Mock).mockImplementation(async ({ data }) => {
    createdCampaign = {
      id: 500,
      ...data,
      createdAt: new Date('2026-06-05T12:00:00.000Z'),
      updatedAt: new Date('2026-06-05T12:00:00.000Z'),
      sentAt: null,
    };
    return createdCampaign;
  });

  (prisma.communicationRecipient.create as jest.Mock).mockImplementation(async ({ data }) => {
    const recipient = {
      id: ++recipientId,
      ...data,
      createdAt: new Date('2026-06-05T12:00:00.000Z'),
      updatedAt: new Date('2026-06-05T12:00:00.000Z'),
    };
    createdRecipients.push(recipient);
    return recipient;
  });

  (prisma.communicationRecipient.update as jest.Mock).mockImplementation(async ({ where, data }) => {
    recipientUpdates.push({ where, data });
    return { id: where.id, ...data };
  });

  (prisma.communicationCampaign.update as jest.Mock).mockImplementation(async ({ where, data }) => ({
    ...createdCampaign,
    id: where.id,
    ...data,
    recipients: createdRecipients.map(recipient => ({
      ...recipient,
      ...(recipientUpdates.find(update => update.where.id === recipient.id)?.data ?? {}),
    })),
  }));

  return { recipientUpdates, createdRecipients };
}

function setupNotifications() {
  (prisma.notification.count as jest.Mock).mockResolvedValue(1);
  (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue(null);
  (prisma.notification.create as jest.Mock).mockImplementation(async ({ data }) => ({
    id: data.userId + 1000,
    ...data,
    isRead: false,
    readAt: null,
    createdAt: new Date('2026-06-05T12:00:00.000Z'),
  }));
}

function callCommunicationsEndpoint(
  method: 'get' | 'post' | 'patch',
  path: string,
  body?: Record<string, unknown>,
) {
  const app = appWithCommunicationsRouter();
  if (method === 'get') return request(app).get(path).send();
  if (method === 'post') return request(app).post(path).send(body ?? {});
  return request(app).patch(path).send(body ?? {});
}

describe('communication campaigns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { userId: 1, schoolId: 10, role: Role.OWNER, tokenVersion: 0 };
    setupPersistence();
    setupNotifications();
  });

  it('OWNER can create an IN_APP campaign targeting STUDENT role', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101 }, { id: 102 }]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send(basePayload);

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(expect.objectContaining({
      schoolId: 10,
      createdById: 1,
      recipientsCount: 2,
      sentCount: 2,
      skippedCount: 0,
      failedCount: 0,
      status: CommunicationCampaignStatus.SENT,
    }));
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { schoolId: 10, deletedAt: null, role: { in: [Role.STUDENT] } },
    }));
  });

  it('ADMIN can create campaign', async () => {
    mockUser = { userId: 2, schoolId: 10, role: Role.ADMIN, tokenVersion: 0 };
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 201 }]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send(basePayload);

    expect(res.status).toBe(201);
    expect(res.body.data.createdById).toBe(2);
  });

  it.each([Role.OWNER, Role.ADMIN])('%s can search communication recipients', async (role) => {
    mockUser = { userId: 2, schoolId: 10, role, tokenVersion: 0 };
    (prisma.user.findMany as jest.Mock).mockResolvedValue([
      {
        id: 101,
        email: 'student@example.com',
        firstName: 'Student',
        lastName: 'One',
        role: Role.STUDENT,
      },
    ]);

    const res = await request(appWithCommunicationsRouter())
      .get('/communications/recipients/search?search=student&role=STUDENT&limit=10')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      {
        id: 101,
        email: 'student@example.com',
        firstName: 'Student',
        lastName: 'One',
        role: Role.STUDENT,
      },
    ]);
  });

  it.each([Role.TEACHER, Role.STUDENT, Role.PARENT])('%s cannot search communication recipients', async (role) => {
    mockUser = { userId: 3, schoolId: 10, role, tokenVersion: 0 };

    const res = await request(appWithCommunicationsRouter())
      .get('/communications/recipients/search')
      .send();

    expect(res.status).toBe(403);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('recipient search is school scoped, filters role/search, caps limit, and returns safe fields only', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([
      {
        id: 101,
        email: 'student@example.com',
        firstName: 'Student',
        lastName: 'One',
        role: Role.STUDENT,
        phone: '+77000000000',
        passwordHash: 'secret',
      },
    ]);

    const res = await request(appWithCommunicationsRouter())
      .get('/communications/recipients/search?search=stu&role=STUDENT&limit=999')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      {
        id: 101,
        email: 'student@example.com',
        firstName: 'Student',
        lastName: 'One',
        role: Role.STUDENT,
      },
    ]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        schoolId: 10,
        deletedAt: null,
        role: Role.STUDENT,
        OR: [
          { firstName: { contains: 'stu', mode: 'insensitive' } },
          { lastName: { contains: 'stu', mode: 'insensitive' } },
          { email: { contains: 'stu', mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
      take: 50,
    }));
  });

  it.each([Role.TEACHER, Role.STUDENT, Role.PARENT])('%s cannot create campaign', async (role) => {
    mockUser = { userId: 3, schoolId: 10, role, tokenVersion: 0 };

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send(basePayload);

    expect(res.status).toBe(403);
    expect(prisma.communicationCampaign.create).not.toHaveBeenCalled();
  });

  it.each(forbiddenCampaignEndpoints)('TEACHER/STUDENT/PARENT cannot access %s', async (_label, method, path, body) => {
    for (const role of forbiddenCommunicationRoles) {
      mockUser = { userId: 3, schoolId: 10, role, tokenVersion: 0 };

      const res = await callCommunicationsEndpoint(method, path, body);

      expect(res.status).toBe(403);
    }
  });

  it('ROLES targeting is school scoped', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101 }]);

    await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send({ ...basePayload, targetConfig: { roles: [Role.STUDENT, Role.TEACHER] } });

    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        schoolId: 10,
        deletedAt: null,
        role: { in: [Role.STUDENT, Role.TEACHER] },
      },
    }));
  });

  it('USERS targeting ignores users from another school through the school-scoped query', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101 }]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send({
        ...basePayload,
        targetType: CommunicationTargetType.USERS,
        targetConfig: { userIds: [101, 202] },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.recipientsCount).toBe(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        schoolId: 10,
        deletedAt: null,
        id: { in: [101, 202] },
      },
    }));
  });

  it('GROUPS targeting sends to active students in active school groups', async () => {
    (prisma.studentGroup.findMany as jest.Mock).mockResolvedValue([{ id: 301 }]);
    (prisma.groupMembership.findMany as jest.Mock).mockResolvedValue([
      studentMembership(101, 1001),
      studentMembership(102, 1002),
    ]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send(groupPayload);

    expect(res.status).toBe(201);
    expect(res.body.data.recipientsCount).toBe(2);
    expect(prisma.studentGroup.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [301] },
        schoolId: 10,
        deletedAt: null,
        status: GroupStatus.ACTIVE,
      },
      select: { id: true },
    });
    expect(prisma.groupMembership.findMany).toHaveBeenCalledWith({
      where: {
        schoolId: 10,
        studentGroupId: { in: [301] },
        status: MemberStatus.ACTIVE,
        studentProfile: {
          deletedAt: null,
          user: {
            schoolId: 10,
            deletedAt: null,
          },
        },
      },
      select: {
        studentProfile: {
          select: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                role: true,
              },
            },
          },
        },
      },
    });
    expect(prisma.parentChild.findMany).not.toHaveBeenCalled();
  });

  it('GROUPS targeting ignores other-school groups before resolving memberships', async () => {
    (prisma.studentGroup.findMany as jest.Mock).mockResolvedValue([{ id: 301 }]);
    (prisma.groupMembership.findMany as jest.Mock).mockResolvedValue([studentMembership(101, 1001)]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send({
        ...groupPayload,
        targetConfig: { groupIds: [301, 999], audience: 'STUDENTS' },
      });

    expect(res.status).toBe(201);
    expect(prisma.studentGroup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: [301, 999] },
        schoolId: 10,
        deletedAt: null,
      }),
    }));
    expect(prisma.groupMembership.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        schoolId: 10,
        studentGroupId: { in: [301] },
      }),
    }));
  });

  it('GROUPS parents targeting resolves parents through active student memberships', async () => {
    (prisma.studentGroup.findMany as jest.Mock).mockResolvedValue([{ id: 301 }]);
    (prisma.groupMembership.findMany as jest.Mock).mockResolvedValue([
      { studentProfileId: 1001 },
      { studentProfileId: 1002 },
    ]);
    (prisma.parentChild.findMany as jest.Mock).mockResolvedValue([
      parentLink(201),
      parentLink(202),
    ]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send({
        ...groupPayload,
        targetConfig: { groupIds: [301], audience: 'PARENTS' },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.recipientsCount).toBe(2);
    expect(prisma.parentChild.findMany).toHaveBeenCalledWith({
      where: {
        studentProfileId: { in: [1001, 1002] },
        parentProfile: {
          schoolId: 10,
          deletedAt: null,
          user: {
            schoolId: 10,
            deletedAt: null,
          },
        },
      },
      select: {
        parentProfile: {
          select: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                role: true,
              },
            },
          },
        },
      },
    });
  });

  it('GROUPS students and parents targeting dedupes users across groups', async () => {
    (prisma.studentGroup.findMany as jest.Mock).mockResolvedValue([{ id: 301 }, { id: 302 }]);
    (prisma.groupMembership.findMany as jest.Mock)
      .mockResolvedValueOnce([
        studentMembership(101, 1001),
        studentMembership(101, 1001),
        studentMembership(102, 1002),
      ])
      .mockResolvedValueOnce([
        { studentProfileId: 1001 },
        { studentProfileId: 1002 },
      ]);
    (prisma.parentChild.findMany as jest.Mock).mockResolvedValue([
      parentLink(201),
      parentLink(201),
    ]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send({
        ...groupPayload,
        targetConfig: { groupIds: [301, 302], audience: 'STUDENTS_AND_PARENTS' },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.recipientsCount).toBe(3);
    expect(prisma.communicationRecipient.create).toHaveBeenCalledTimes(3);
  });

  it('GROUPS targeting rejects empty recipient sets', async () => {
    (prisma.studentGroup.findMany as jest.Mock).mockResolvedValue([{ id: 301 }]);
    (prisma.groupMembership.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send(groupPayload);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No recipients found for selected target');
    expect(prisma.communicationCampaign.create).not.toHaveBeenCalled();
  });

  it('duplicate recipients are deduped', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101 }, { id: 102 }]);

    await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send({
        ...basePayload,
        targetType: CommunicationTargetType.USERS,
        targetConfig: { userIds: [101, 101, 102] },
      });

    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [101, 102] } }),
    }));
    expect(prisma.communicationRecipient.create).toHaveBeenCalledTimes(2);
  });

  it('campaign creates Notifications through notificationService payload', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101 }]);

    await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send(basePayload);

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 101,
        schoolId: 10,
        type: 'ANNOUNCEMENT',
        category: NotificationCategory.ANNOUNCEMENT,
        entityType: 'CommunicationCampaign',
        entityId: 500,
      }),
    });
  });

  it('respects notification preferences and marks disabled recipients skipped', async () => {
    const { recipientUpdates } = setupPersistence();
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101 }, { id: 102 }]);
    (prisma.notificationPreference.findUnique as jest.Mock).mockImplementation(async ({ where }) => (
      where.userId_category.userId === 101 ? { inAppEnabled: false } : null
    ));

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send(basePayload);

    expect(res.status).toBe(201);
    expect(res.body.data.sentCount).toBe(1);
    expect(res.body.data.skippedCount).toBe(1);
    expect(recipientUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          status: CommunicationRecipientStatus.SKIPPED,
          skippedReason: 'PREFERENCE_DISABLED',
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          status: CommunicationRecipientStatus.SENT,
          notificationId: 1102,
        }),
      }),
    ]));
  });

  it('CRITICAL priority bypasses preferences', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101 }]);
    (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue({ inAppEnabled: false });

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send({ ...basePayload, priority: NotificationPriority.CRITICAL });

    expect(res.status).toBe(201);
    expect(res.body.data.sentCount).toBe(1);
    expect(res.body.data.skippedCount).toBe(0);
    expect(prisma.notificationPreference.findUnique).not.toHaveBeenCalled();
  });

  it('GROUPS CRITICAL priority bypasses preferences', async () => {
    (prisma.studentGroup.findMany as jest.Mock).mockResolvedValue([{ id: 301 }]);
    (prisma.groupMembership.findMany as jest.Mock).mockResolvedValue([studentMembership(101, 1001)]);
    (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue({ inAppEnabled: false });

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send({ ...groupPayload, priority: NotificationPriority.CRITICAL });

    expect(res.status).toBe(201);
    expect(res.body.data.sentCount).toBe(1);
    expect(res.body.data.skippedCount).toBe(0);
    expect(prisma.notificationPreference.findUnique).not.toHaveBeenCalled();
  });

  it('campaign counters include failed sends', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101 }, { id: 102 }]);
    (prisma.notification.create as jest.Mock).mockImplementation(async ({ data }) => {
      if (data.userId === 102) throw new Error('send failed');
      return {
        id: data.userId + 1000,
        ...data,
        isRead: false,
        readAt: null,
        createdAt: new Date('2026-06-05T12:00:00.000Z'),
      };
    });

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/campaigns')
      .send(basePayload);

    expect(res.status).toBe(201);
    expect(res.body.data.sentCount).toBe(1);
    expect(res.body.data.failedCount).toBe(1);
    expect(res.body.data.status).toBe(CommunicationCampaignStatus.SENT);
  });

  it('GET list returns only school campaigns', async () => {
    const item = { id: 500, schoolId: 10, title: 'A' };
    (prisma.communicationCampaign.count as jest.Mock).mockResolvedValue(1);
    (prisma.communicationCampaign.findMany as jest.Mock).mockResolvedValue([item]);

    const res = await request(appWithCommunicationsRouter())
      .get('/communications/campaigns?page=1&limit=10')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ id: 500, schoolId: 10 })]);
    expect(prisma.communicationCampaign.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { schoolId: 10 },
      skip: 0,
      take: 10,
    }));
  });

  it.each([Role.OWNER, Role.ADMIN])('%s can search communication groups with school scope and safe fields', async (role) => {
    mockUser = { userId: 2, schoolId: 10, role, tokenVersion: 0 };
    (prisma.studentGroup.findMany as jest.Mock).mockResolvedValue([
      {
        id: 301,
        level: 'A1',
        status: GroupStatus.ACTIVE,
        pricePerMonth: 1000,
      },
    ]);

    const res = await request(appWithCommunicationsRouter())
      .get('/communications/groups/search?search=A1&status=ACTIVE&limit=999')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      {
        id: 301,
        level: 'A1',
        status: GroupStatus.ACTIVE,
      },
    ]);
    expect(prisma.studentGroup.findMany).toHaveBeenCalledWith({
      where: {
        schoolId: 10,
        deletedAt: null,
        status: GroupStatus.ACTIVE,
        level: { contains: 'A1', mode: 'insensitive' },
      },
      select: {
        id: true,
        level: true,
        status: true,
      },
      orderBy: { level: 'asc' },
      take: 50,
    });
  });

  it.each([Role.TEACHER, Role.STUDENT, Role.PARENT])('%s cannot search communication groups', async (role) => {
    mockUser = { userId: 3, schoolId: 10, role, tokenVersion: 0 };

    const res = await request(appWithCommunicationsRouter())
      .get('/communications/groups/search')
      .send();

    expect(res.status).toBe(403);
    expect(prisma.studentGroup.findMany).not.toHaveBeenCalled();
  });

  it('recipient preview works for ROLES without creating campaign or notifications', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([
      safeUser(101, Role.STUDENT),
      safeUser(102, Role.STUDENT),
    ]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/recipients/preview')
      .send({
        targetType: CommunicationTargetType.ROLES,
        targetConfig: { roles: [Role.STUDENT] },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.recipientsCount).toBe(2);
    expect(res.body.data.sample).toHaveLength(2);
    expect(prisma.communicationCampaign.create).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('recipient preview works for USERS with school-scoped lookup', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([safeUser(101, Role.STUDENT)]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/recipients/preview')
      .send({
        targetType: CommunicationTargetType.USERS,
        targetConfig: { userIds: [101, 202] },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.recipientsCount).toBe(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        schoolId: 10,
        deletedAt: null,
        id: { in: [101, 202] },
      },
    }));
  });

  it('recipient preview works for GROUPS and samples safe user fields', async () => {
    (prisma.studentGroup.findMany as jest.Mock).mockResolvedValue([{ id: 301 }]);
    (prisma.groupMembership.findMany as jest.Mock).mockResolvedValue([
      studentMembership(101, 1001),
      studentMembership(102, 1002),
    ]);

    const res = await request(appWithCommunicationsRouter())
      .post('/communications/recipients/preview')
      .send({
        targetType: CommunicationTargetType.GROUPS,
        targetConfig: { groupIds: [301], audience: 'STUDENTS' },
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      recipientsCount: 2,
      sample: [
        safeUser(101, Role.STUDENT),
        safeUser(102, Role.STUDENT),
      ],
    });
    expect(prisma.communicationCampaign.create).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('GET detail is school scoped and includes recipients', async () => {
    (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue({
      id: 500,
      schoolId: 10,
      recipients: [{ id: 901, userId: 101 }],
    });

    const res = await request(appWithCommunicationsRouter())
      .get('/communications/campaigns/500')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.recipients).toEqual([expect.objectContaining({ userId: 101 })]);
    expect(prisma.communicationCampaign.findFirst).toHaveBeenCalledWith({
      where: { id: 500, schoolId: 10 },
      include: {
        recipients: {
          orderBy: { id: 'asc' },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                role: true,
              },
            },
          },
        },
      },
    });
  });

  describe('communication campaign recipients delivery logs', () => {
    const campaignCounters = {
      id: 500,
      schoolId: 10,
      recipientsCount: 4,
      sentCount: 2,
      skippedCount: 1,
      failedCount: 1,
    };

    function deliveryRecipient(
      id: number,
      status: CommunicationRecipientStatus = CommunicationRecipientStatus.SENT,
      user = safeUser(id + 100, Role.STUDENT),
    ) {
      return {
        id,
        campaignId: 500,
        userId: user.id,
        status,
        skippedReason: status === CommunicationRecipientStatus.SKIPPED ? 'PREFERENCE_DISABLED' : null,
        error: status === CommunicationRecipientStatus.FAILED ? 'Notification failed' : null,
        notificationId: status === CommunicationRecipientStatus.SENT ? id + 1000 : null,
        createdAt: new Date(`2026-06-05T12:0${id % 10}:00.000Z`),
        updatedAt: new Date(`2026-06-05T12:0${id % 10}:10.000Z`),
        user,
      };
    }

    function mockCampaignAndRecipients(items: any[], total = items.length, campaign = campaignCounters) {
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue(campaign);
      (prisma.communicationRecipient.count as jest.Mock).mockResolvedValue(total);
      (prisma.communicationRecipient.findMany as jest.Mock).mockResolvedValue(items);
    }

    it.each([Role.OWNER, Role.ADMIN])('%s can list campaign recipients', async (role) => {
      mockUser.role = role;
      const items = [
        deliveryRecipient(1, CommunicationRecipientStatus.SENT),
        deliveryRecipient(2, CommunicationRecipientStatus.SKIPPED),
      ];
      mockCampaignAndRecipients(items, 4);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.pagination).toMatchObject({
        page: 1,
        limit: 25,
        total: 4,
        totalPages: 1,
        hasNextPage: false,
      });
      expect(res.body.data.stats).toEqual({
        recipientsCount: 4,
        sentCount: 2,
        skippedCount: 1,
        failedCount: 1,
      });
      expect(prisma.communicationCampaign.findFirst).toHaveBeenCalledWith({
        where: { id: 500, schoolId: 10 },
        select: {
          id: true,
          recipientsCount: true,
          sentCount: true,
          skippedCount: true,
          failedCount: true,
        },
      });
    });

    it.each([Role.TEACHER, Role.STUDENT, Role.PARENT])('%s cannot list campaign recipients', async (role) => {
      mockUser.role = role;

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients')
        .send();

      expect(res.status).toBe(403);
      expect(prisma.communicationCampaign.findFirst).not.toHaveBeenCalled();
      expect(prisma.communicationRecipient.findMany).not.toHaveBeenCalled();
    });

    it('does not expose recipients for another school campaign', async () => {
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients')
        .send();

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Campaign not found');
      expect(prisma.communicationCampaign.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 500, schoolId: 10 },
      }));
      expect(prisma.communicationRecipient.findMany).not.toHaveBeenCalled();
    });

    it.each([
      CommunicationRecipientStatus.SENT,
      CommunicationRecipientStatus.SKIPPED,
      CommunicationRecipientStatus.FAILED,
    ])('filters recipients by status=%s', async (status) => {
      mockCampaignAndRecipients([deliveryRecipient(1, status)]);

      const res = await request(appWithCommunicationsRouter())
        .get(`/communications/campaigns/500/recipients?status=${status}`)
        .send();

      expect(res.status).toBe(200);
      expect(prisma.communicationRecipient.count).toHaveBeenCalledWith({
        where: {
          campaignId: 500,
          status,
        },
      });
      expect(prisma.communicationRecipient.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          campaignId: 500,
          status,
        },
      }));
    });

    it('status=ALL returns all recipient statuses without status filter', async () => {
      mockCampaignAndRecipients([
        deliveryRecipient(1, CommunicationRecipientStatus.SENT),
        deliveryRecipient(2, CommunicationRecipientStatus.SKIPPED),
        deliveryRecipient(3, CommunicationRecipientStatus.FAILED),
        deliveryRecipient(4, CommunicationRecipientStatus.PENDING),
      ]);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients?status=ALL')
        .send();

      expect(res.status).toBe(200);
      expect(prisma.communicationRecipient.count).toHaveBeenCalledWith({
        where: { campaignId: 500 },
      });
      expect(res.body.data.items).toHaveLength(4);
    });

    it('rejects invalid recipient status', async () => {
      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients?status=DELIVERED')
        .send();

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid recipient status');
      expect(prisma.communicationCampaign.findFirst).not.toHaveBeenCalled();
    });

    it('searches recipients by email', async () => {
      mockCampaignAndRecipients([deliveryRecipient(1)]);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients?search=student@example.com')
        .send();

      expect(res.status).toBe(200);
      expect(prisma.communicationRecipient.count).toHaveBeenCalledWith({
        where: {
          campaignId: 500,
          user: {
            OR: [
              { email: { contains: 'student@example.com', mode: 'insensitive' } },
              { firstName: { contains: 'student@example.com', mode: 'insensitive' } },
              { lastName: { contains: 'student@example.com', mode: 'insensitive' } },
            ],
          },
        },
      });
    });

    it('searches recipients by firstName and lastName', async () => {
      mockCampaignAndRecipients([deliveryRecipient(1)]);

      const firstNameRes = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients?search=First')
        .send();
      const lastNameRes = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients?search=Last')
        .send();

      expect(firstNameRes.status).toBe(200);
      expect(lastNameRes.status).toBe(200);
      expect(prisma.communicationRecipient.count).toHaveBeenNthCalledWith(1, {
        where: expect.objectContaining({
          user: expect.objectContaining({
            OR: expect.arrayContaining([
              { firstName: { contains: 'First', mode: 'insensitive' } },
              { lastName: { contains: 'First', mode: 'insensitive' } },
            ]),
          }),
        }),
      });
      expect(prisma.communicationRecipient.count).toHaveBeenNthCalledWith(2, {
        where: expect.objectContaining({
          user: expect.objectContaining({
            OR: expect.arrayContaining([
              { firstName: { contains: 'Last', mode: 'insensitive' } },
              { lastName: { contains: 'Last', mode: 'insensitive' } },
            ]),
          }),
        }),
      });
    });

    it('paginates recipients with page, limit, total, and hasNextPage', async () => {
      mockCampaignAndRecipients([deliveryRecipient(3)], 5);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients?page=2&limit=2')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.pagination).toEqual({
        page: 2,
        limit: 2,
        total: 5,
        totalPages: 3,
        hasNextPage: true,
        hasPrevPage: true,
      });
      expect(prisma.communicationRecipient.findMany).toHaveBeenCalledWith(expect.objectContaining({
        skip: 2,
        take: 2,
        orderBy: { createdAt: 'desc' },
      }));
    });

    it('caps recipient limit at 100', async () => {
      mockCampaignAndRecipients([], 101);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients?limit=999')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.pagination.limit).toBe(100);
      expect(prisma.communicationRecipient.findMany).toHaveBeenCalledWith(expect.objectContaining({
        take: 100,
      }));
    });

    it('returns empty recipient list with campaign stats', async () => {
      mockCampaignAndRecipients([], 0, {
        ...campaignCounters,
        recipientsCount: 0,
        sentCount: 0,
        skippedCount: 0,
        failedCount: 0,
      });

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.pagination.total).toBe(0);
      expect(res.body.data.stats).toEqual({
        recipientsCount: 0,
        sentCount: 0,
        skippedCount: 0,
        failedCount: 0,
      });
    });

    it('selects and returns safe user fields only', async () => {
      mockCampaignAndRecipients([deliveryRecipient(1, CommunicationRecipientStatus.SENT, {
        id: 101,
        email: 'student@example.com',
        firstName: 'Student',
        lastName: 'Safe',
        role: Role.STUDENT,
      })]);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns/500/recipients')
        .send();

      expect(res.status).toBe(200);
      expect(prisma.communicationRecipient.findMany).toHaveBeenCalledWith(expect.objectContaining({
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              role: true,
            },
          },
        },
      }));
      expect(res.body.data.items[0].user).toEqual({
        id: 101,
        email: 'student@example.com',
        firstName: 'Student',
        lastName: 'Safe',
        role: Role.STUDENT,
      });
      expect(res.body.data.items[0].user).not.toHaveProperty('password');
      expect(res.body.data.items[0].user).not.toHaveProperty('studentProfile');
      expect(res.body.data.items[0].user).not.toHaveProperty('staffProfile');
      expect(res.body.data.items[0].user).not.toHaveProperty('parentProfile');
    });
  });

  describe('communication campaign drafts', () => {
    const validDraftPayload = {
      title: 'Draft Campaign Title',
      body: 'Draft body text',
      category: 'ANNOUNCEMENT',
      priority: 'NORMAL',
      targetType: 'ROLES',
      targetConfig: { roles: [Role.STUDENT] },
    };

    it('OWNER can create draft without sending or creating recipients/notifications', async () => {
      mockUser.role = Role.OWNER;
      const createdDraft = {
        id: 600,
        schoolId: 10,
        createdById: 1,
        ...validDraftPayload,
        status: 'DRAFT',
        recipientsCount: 0,
        sentCount: 0,
        skippedCount: 0,
        failedCount: 0,
        sentAt: null,
      };

      (prisma.communicationCampaign.create as jest.Mock).mockResolvedValue(createdDraft);

      const res = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/draft')
        .send(validDraftPayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(expect.objectContaining({
        id: 600,
        status: 'DRAFT',
        recipientsCount: 0,
      }));
      expect(prisma.communicationCampaign.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          title: 'Draft Campaign Title',
        }),
      }));
      expect(prisma.communicationRecipient.create).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('ADMIN can create draft, while TEACHER/STUDENT/PARENT cannot', async () => {
      mockUser.role = Role.ADMIN;
      (prisma.communicationCampaign.create as jest.Mock).mockResolvedValue({ id: 600 });
      const resAdmin = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/draft')
        .send(validDraftPayload);
      expect(resAdmin.status).toBe(201);

      const forbiddenRoles = [Role.TEACHER, Role.STUDENT, Role.PARENT];
      for (const role of forbiddenRoles) {
        mockUser.role = role;
        const res = await request(appWithCommunicationsRouter())
          .post('/communications/campaigns/draft')
          .send(validDraftPayload);
        expect(res.status).toBe(403);
      }
    });

    it('lists only campaigns matching status=DRAFT', async () => {
      mockUser.role = Role.OWNER;
      const mockDrafts = [
        { id: 601, title: 'Draft 1', status: 'DRAFT' },
      ];
      (prisma.communicationCampaign.count as jest.Mock).mockResolvedValue(1);
      (prisma.communicationCampaign.findMany as jest.Mock).mockResolvedValue(mockDrafts);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns?status=DRAFT')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(mockDrafts);
      expect(prisma.communicationCampaign.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { schoolId: 10, status: 'DRAFT' },
      }));
    });

    it('updates draft works for same school and rejects updates on non-draft campaign', async () => {
      mockUser.role = Role.OWNER;
      const existingDraft = { id: 600, schoolId: 10, status: 'DRAFT', targetType: 'ROLES', targetConfig: { roles: [] } };
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue(existingDraft);
      (prisma.communicationCampaign.update as jest.Mock).mockResolvedValue({
        ...existingDraft,
        title: 'New Title',
      });

      // 1. Success update
      const res = await request(appWithCommunicationsRouter())
        .patch('/communications/campaigns/600/draft')
        .send({ ...validDraftPayload, title: 'New Title' });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('New Title');

      // 2. Reject other school
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue(null);
      const resOtherSchool = await request(appWithCommunicationsRouter())
        .patch('/communications/campaigns/600/draft')
        .send({ ...validDraftPayload, title: 'New Title' });
      expect(resOtherSchool.status).toBe(400);
      expect(resOtherSchool.body.error).toContain('Draft not found');

      // 3. Reject SENT campaign update
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue({ id: 600, schoolId: 10, status: 'SENT' });
      const resNonDraft = await request(appWithCommunicationsRouter())
        .patch('/communications/campaigns/600/draft')
        .send({ ...validDraftPayload, title: 'New Title' });
      expect(resNonDraft.status).toBe(400);
      expect(resNonDraft.body.error).toContain('Only draft campaigns can be updated');
    });

    it('sends draft and delivers campaign to resolved recipients', async () => {
      mockUser.role = Role.OWNER;
      const draftCampaign = {
        id: 600,
        schoolId: 10,
        title: 'Draft Campaign Title',
        body: 'Draft body text',
        category: 'ANNOUNCEMENT',
        priority: 'NORMAL',
        status: 'DRAFT',
        targetType: 'ROLES',
        targetConfig: { roles: ['STUDENT'] },
      };

      (prisma.communicationCampaign.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.communicationCampaign.findUnique as jest.Mock).mockResolvedValue(draftCampaign);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101 }, { id: 102 }]);

      // Mock deliverCampaign update
      let updatedCampaign: any;
      (prisma.communicationCampaign.update as jest.Mock).mockImplementation(async ({ data }) => {
        updatedCampaign = { ...draftCampaign, ...data };
        return updatedCampaign;
      });

      const res = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/600/send')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('SENT');
      expect(res.body.data.recipientsCount).toBe(2);
      expect(res.body.data.sentCount).toBe(2);
      expect(prisma.communicationRecipient.create).toHaveBeenCalledTimes(2);
      expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    });

    it('sending draft locks the DRAFT status atomically and throws if campaign is not a draft', async () => {
      mockUser.role = Role.OWNER;
      (prisma.communicationCampaign.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue(null);

      // Draft not found
      const resNotFound = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/600/send')
        .send();
      expect(resNotFound.status).toBe(400);
      expect(resNotFound.body.error).toContain('Draft not found');

      // Draft exists but already sent
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue({ id: 600, schoolId: 10, status: 'SENT' });
      const resAlreadySent = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/600/send')
        .send();
      expect(resAlreadySent.status).toBe(400);
      expect(resAlreadySent.body.error).toContain('Only draft campaigns can be sent');
    });

    it('sending draft fails if no recipients found', async () => {
      mockUser.role = Role.OWNER;
      const draftCampaign = {
        id: 600,
        schoolId: 10,
        title: 'Draft',
        body: 'Body',
        status: 'DRAFT',
        targetType: 'ROLES',
        targetConfig: { roles: ['STUDENT'] },
      };

      (prisma.communicationCampaign.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.communicationCampaign.findUnique as jest.Mock).mockResolvedValue(draftCampaign);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]); // zero recipients

      const res = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/600/send')
        .send();

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('No recipients found for selected target');
      expect(prisma.communicationCampaign.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 600 },
        data: { status: 'FAILED' },
      }));
    });
  });

  describe('scheduled campaigns', () => {
    it('OWNER/ADMIN can create a scheduled campaign', async () => {
      mockUser.role = Role.OWNER;
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const res = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/schedule')
        .send({
          ...basePayload,
          scheduledAt: futureDate,
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(expect.objectContaining({
        status: 'SCHEDULED',
        title: 'Important announcement',
        recipientsCount: 0,
      }));
      expect(prisma.communicationRecipient.create).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('TEACHER/STUDENT/PARENT cannot create a scheduled campaign', async () => {
      mockUser.role = Role.TEACHER;
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const res = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/schedule')
        .send({
          ...basePayload,
          scheduledAt: futureDate,
        });

      expect(res.status).toBe(403);
    });

    it('create scheduled rejects missing or past scheduledAt', async () => {
      mockUser.role = Role.OWNER;
      // missing
      const resMissing = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/schedule')
        .send(basePayload);
      expect(resMissing.status).toBe(400);
      expect(resMissing.body.error).toContain('Scheduled time is required');

      // past
      const pastDate = new Date(Date.now() - 60000).toISOString();
      const resPast = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/schedule')
        .send({
          ...basePayload,
          scheduledAt: pastDate,
        });
      expect(resPast.status).toBe(400);
      expect(resPast.body.error).toContain('Scheduled time must be in the future');
    });

    it('lists campaigns with status=SCHEDULED', async () => {
      mockUser.role = Role.OWNER;
      const scheduledCampaigns = [
        { id: 701, title: 'Scheduled 1', status: 'SCHEDULED' },
      ];
      (prisma.communicationCampaign.findMany as jest.Mock).mockResolvedValue(scheduledCampaigns);
      (prisma.communicationCampaign.count as jest.Mock).mockResolvedValue(1);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/campaigns?status=SCHEDULED')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(701);
      expect(prisma.communicationCampaign.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'SCHEDULED',
          }),
        })
      );
    });

    it('updates a scheduled campaign for same school', async () => {
      mockUser.role = Role.OWNER;
      const scheduledCampaign = {
        id: 701,
        schoolId: 10,
        title: 'Scheduled Old',
        status: 'SCHEDULED',
        targetType: 'ROLES',
        targetConfig: { roles: ['STUDENT'] },
      };
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue(scheduledCampaign);
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const res = await request(appWithCommunicationsRouter())
        .patch('/communications/campaigns/701/schedule')
        .send({
          title: 'Scheduled New',
          scheduledAt: futureDate,
        });

      expect(res.status).toBe(200);
      expect(prisma.communicationCampaign.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 701 },
          data: expect.objectContaining({
            title: 'Scheduled New',
            scheduledAt: new Date(futureDate),
          }),
        })
      );
    });

    it('update scheduled rejects other school or non-scheduled campaign', async () => {
      mockUser.role = Role.OWNER;
      // not found/other school
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue(null);
      const resNotFound = await request(appWithCommunicationsRouter())
        .patch('/communications/campaigns/701/schedule')
        .send({ title: 'New' });
      expect(resNotFound.status).toBe(400);
      expect(resNotFound.body.error).toContain('Scheduled campaign not found');

      // non-scheduled campaign (e.g. SENT)
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue({
        id: 701,
        schoolId: 10,
        status: 'SENT',
      });
      const resNonScheduled = await request(appWithCommunicationsRouter())
        .patch('/communications/campaigns/701/schedule')
        .send({ title: 'New' });
      expect(resNonScheduled.status).toBe(400);
      expect(resNonScheduled.body.error).toContain('Only scheduled campaigns can be updated');
    });

    it('cancelling a scheduled campaign sets status to CANCELLED', async () => {
      mockUser.role = Role.OWNER;
      const scheduledCampaign = {
        id: 701,
        schoolId: 10,
        status: 'SCHEDULED',
      };
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue(scheduledCampaign);

      const res = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/701/cancel')
        .send();

      expect(res.status).toBe(200);
      expect(prisma.communicationCampaign.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 701 },
          data: { status: 'CANCELLED' },
        })
      );
    });

    it('cancelling a scheduled campaign rejects other school or non-scheduled campaign', async () => {
      mockUser.role = Role.OWNER;
      // not found/other school
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue(null);
      const resNotFound = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/701/cancel')
        .send();
      expect(resNotFound.status).toBe(400);
      expect(resNotFound.body.error).toContain('Scheduled campaign not found');

      // non-scheduled campaign (e.g. DRAFT)
      (prisma.communicationCampaign.findFirst as jest.Mock).mockResolvedValue({
        id: 701,
        schoolId: 10,
        status: 'DRAFT',
      });
      const resNonScheduled = await request(appWithCommunicationsRouter())
        .post('/communications/campaigns/701/cancel')
        .send();
      expect(resNonScheduled.status).toBe(400);
      expect(resNonScheduled.body.error).toContain('Only scheduled campaigns can be cancelled');
    });
  });

  describe('processDueScheduledCampaigns service method', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      setupPersistence();
      setupNotifications();
    });

    it('processes and delivers a due scheduled campaign', async () => {
      const dueCampaign = {
        id: 701,
        schoolId: 10,
        title: 'Due Campaign',
        body: 'Body',
        status: 'SCHEDULED',
        targetType: 'ROLES',
        targetConfig: { roles: ['STUDENT'] },
        scheduledAt: new Date(Date.now() - 5000),
      };

      (prisma.communicationCampaign.findMany as jest.Mock).mockResolvedValue([dueCampaign]);
      (prisma.communicationCampaign.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 101, role: 'STUDENT', email: 's@ex.com', firstName: 'S', lastName: 'O' }]);

      const result = await processDueScheduledCampaigns();

      expect(result).toEqual({
        checked: 1,
        processed: 1,
        sent: 1,
        failed: 0,
        skippedLocked: 0,
      });

      // Verify status transitions to SENDING, then SENT/FAILED via deliverCampaign
      expect(prisma.communicationCampaign.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 701, schoolId: 10, status: 'SCHEDULED' },
          data: { status: 'SENDING' },
        })
      );

      expect(prisma.communicationCampaign.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 701 },
          data: expect.objectContaining({
            status: 'SENT',
            sentCount: 1,
          }),
        })
      );
    });

    it('ignores future scheduled campaigns', async () => {
      const futureCampaign = {
        id: 702,
        schoolId: 10,
        title: 'Future Campaign',
        status: 'SCHEDULED',
        scheduledAt: new Date(Date.now() + 10000),
      };

      (prisma.communicationCampaign.findMany as jest.Mock).mockImplementation(async ({ where }) => {
        const scheduledAtLte = where.scheduledAt?.lte;
        if (scheduledAtLte && futureCampaign.scheduledAt <= scheduledAtLte) {
          return [futureCampaign];
        }
        return [];
      });

      const result = await processDueScheduledCampaigns();

      expect(result.checked).toBe(0);
      expect(prisma.communicationCampaign.updateMany).not.toHaveBeenCalled();
    });

    it('skips campaign if lock count is 0 (atomic lock skip)', async () => {
      const dueCampaign = {
        id: 701,
        schoolId: 10,
        title: 'Due Campaign',
        status: 'SCHEDULED',
        scheduledAt: new Date(Date.now() - 5000),
      };

      (prisma.communicationCampaign.findMany as jest.Mock).mockResolvedValue([dueCampaign]);
      (prisma.communicationCampaign.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const result = await processDueScheduledCampaigns();

      expect(result).toEqual({
        checked: 1,
        processed: 0,
        sent: 0,
        failed: 0,
        skippedLocked: 1,
      });

      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.communicationCampaign.update).not.toHaveBeenCalled();
    });

    it('marks campaign FAILED if zero recipients resolved', async () => {
      const dueCampaign = {
        id: 701,
        schoolId: 10,
        title: 'Due Campaign',
        body: 'Body',
        status: 'SCHEDULED',
        targetType: 'ROLES',
        targetConfig: { roles: ['STUDENT'] },
        scheduledAt: new Date(Date.now() - 5000),
      };

      (prisma.communicationCampaign.findMany as jest.Mock).mockResolvedValue([dueCampaign]);
      (prisma.communicationCampaign.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      const result = await processDueScheduledCampaigns();

      expect(result).toEqual({
        checked: 1,
        processed: 1,
        sent: 0,
        failed: 1,
        skippedLocked: 0,
      });

      expect(prisma.communicationCampaign.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 701 },
          data: expect.objectContaining({
            status: 'FAILED',
            recipientsCount: 0,
          }),
        })
      );
    });

    it('does not abort processing batch if one campaign delivery throws error', async () => {
      const dueCampaign1 = {
        id: 701,
        schoolId: 10,
        title: 'Due Campaign 1',
        body: 'Body 1',
        status: 'SCHEDULED',
        targetType: 'ROLES',
        targetConfig: { roles: ['STUDENT'] },
        scheduledAt: new Date(Date.now() - 5000),
      };
      const dueCampaign2 = {
        id: 702,
        schoolId: 10,
        title: 'Due Campaign 2',
        body: 'Body 2',
        status: 'SCHEDULED',
        targetType: 'ROLES',
        targetConfig: { roles: ['STUDENT'] },
        scheduledAt: new Date(Date.now() - 4000),
      };

      (prisma.communicationCampaign.findMany as jest.Mock).mockResolvedValue([dueCampaign1, dueCampaign2]);
      (prisma.communicationCampaign.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      
      (prisma.user.findMany as jest.Mock)
        .mockRejectedValueOnce(new Error('DB Error resolving recipients'))
        .mockResolvedValueOnce([{ id: 101, role: 'STUDENT', email: 's@ex.com', firstName: 'S', lastName: 'O' }]);

      const result = await processDueScheduledCampaigns();

      expect(result).toEqual({
        checked: 2,
        processed: 2,
        sent: 1,
        failed: 1,
        skippedLocked: 0,
      });

      expect(prisma.communicationCampaign.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 701 },
          data: { status: 'FAILED' },
        })
      );

      expect(prisma.communicationCampaign.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 702 },
          data: expect.objectContaining({
            status: 'SENT',
          }),
        })
      );
    });
  });
});
