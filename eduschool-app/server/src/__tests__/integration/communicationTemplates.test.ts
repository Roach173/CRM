import express from 'express';
import request from 'supertest';
import {
  CommunicationChannel,
  Role,
} from '@prisma/client';
import prisma from '../../lib/prisma';
import communicationsRouter from '../../routes/communications';
import { NotificationCategory, NotificationPriority } from '../../constants/notifications';

let mockUser: { userId: number; schoolId: number; role: Role; tokenVersion: number } = {
  userId: 1,
  schoolId: 10,
  role: Role.OWNER,
  tokenVersion: 0,
};

const forbiddenCommunicationRoles = [Role.TEACHER, Role.STUDENT, Role.PARENT] as const;
type ForbiddenTemplateEndpoint = [
  label: string,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
];

jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: {
    communicationTemplate: {
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  },
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

function callTemplateEndpoint(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
) {
  const req = request(appWithCommunicationsRouter())[method](path);
  return method === 'get' || method === 'delete' ? req.send() : req.send(body ?? {});
}

describe('communication templates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { userId: 1, schoolId: 10, role: Role.OWNER, tokenVersion: 0 };
  });

  describe('POST /communications/templates', () => {
    const validPayload = {
      name: 'Template name',
      title: 'Template title',
      body: 'Template body',
      category: NotificationCategory.ANNOUNCEMENT,
      priority: NotificationPriority.NORMAL,
      channel: CommunicationChannel.IN_APP,
    };
    const forbiddenTemplateEndpoints: ForbiddenTemplateEndpoint[] = [
      ['list templates', 'get', '/communications/templates', undefined],
      ['create template', 'post', '/communications/templates', validPayload],
      ['update template', 'patch', '/communications/templates/100', { name: 'Updated template' }],
      ['archive template', 'delete', '/communications/templates/100', undefined],
    ];

    it('OWNER can create template', async () => {
      mockUser.role = Role.OWNER;
      const createdTemplate = { id: 100, schoolId: 10, createdById: 1, ...validPayload, isArchived: false };
      (prisma.communicationTemplate.create as jest.Mock).mockResolvedValue(createdTemplate);

      const res = await request(appWithCommunicationsRouter())
        .post('/communications/templates')
        .send(validPayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(createdTemplate);
      expect(prisma.communicationTemplate.create).toHaveBeenCalledWith({
        data: {
          schoolId: 10,
          createdById: 1,
          name: 'Template name',
          title: 'Template title',
          body: 'Template body',
          category: 'ANNOUNCEMENT',
          priority: 'NORMAL',
          channel: 'IN_APP',
          isArchived: false,
        },
      });
    });

    it('ADMIN can create template', async () => {
      mockUser.role = Role.ADMIN;
      const createdTemplate = { id: 100, schoolId: 10, createdById: 1, ...validPayload, isArchived: false };
      (prisma.communicationTemplate.create as jest.Mock).mockResolvedValue(createdTemplate);

      const res = await request(appWithCommunicationsRouter())
        .post('/communications/templates')
        .send(validPayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('TEACHER/STUDENT/PARENT cannot create template', async () => {
      const forbiddenRoles = [Role.TEACHER, Role.STUDENT, Role.PARENT];
      for (const role of forbiddenRoles) {
        mockUser.role = role;
        const res = await request(appWithCommunicationsRouter())
          .post('/communications/templates')
          .send(validPayload);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      }
    });

    it.each(forbiddenTemplateEndpoints)('TEACHER/STUDENT/PARENT cannot %s', async (_label, method, path, body) => {
      for (const role of forbiddenCommunicationRoles) {
        mockUser.role = role;

        const res = await callTemplateEndpoint(method, path, body);

        expect(res.status).toBe(403);
      }
    });

    it('validation rejects empty name', async () => {
      const res = await request(appWithCommunicationsRouter())
        .post('/communications/templates')
        .send({ ...validPayload, name: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Name is required');
    });

    it('validation rejects empty title', async () => {
      const res = await request(appWithCommunicationsRouter())
        .post('/communications/templates')
        .send({ ...validPayload, title: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Title is required');
    });

    it('validation rejects empty body', async () => {
      const res = await request(appWithCommunicationsRouter())
        .post('/communications/templates')
        .send({ ...validPayload, body: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Body is required');
    });

    it('validation rejects invalid category', async () => {
      const res = await request(appWithCommunicationsRouter())
        .post('/communications/templates')
        .send({ ...validPayload, category: 'INVALID_CATEGORY' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid category');
    });

    it('validation rejects invalid priority', async () => {
      const res = await request(appWithCommunicationsRouter())
        .post('/communications/templates')
        .send({ ...validPayload, priority: 'INVALID_PRIORITY' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid priority');
    });

    it('validation rejects non-IN_APP channel', async () => {
      const res = await request(appWithCommunicationsRouter())
        .post('/communications/templates')
        .send({ ...validPayload, channel: 'SMS' as any });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Only IN_APP channel is supported');
    });
  });

  describe('GET /communications/templates', () => {
    it('returns school templates list without archived ones by default', async () => {
      const templates = [
        { id: 1, schoolId: 10, name: 'T1', title: 'T1', body: 'B1', category: 'ANNOUNCEMENT', priority: 'NORMAL', channel: 'IN_APP', isArchived: false },
        { id: 2, schoolId: 10, name: 'T2', title: 'T2', body: 'B2', category: 'ANNOUNCEMENT', priority: 'NORMAL', channel: 'IN_APP', isArchived: false },
      ];
      (prisma.communicationTemplate.count as jest.Mock).mockResolvedValue(2);
      (prisma.communicationTemplate.findMany as jest.Mock).mockResolvedValue(templates);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/templates');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toEqual(templates);
      expect(prisma.communicationTemplate.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          schoolId: 10,
          isArchived: false,
        },
      }));
    });

    it('returns school templates list including archived if includeArchived=true', async () => {
      (prisma.communicationTemplate.count as jest.Mock).mockResolvedValue(0);
      (prisma.communicationTemplate.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/templates?includeArchived=true');

      expect(res.status).toBe(200);
      expect(prisma.communicationTemplate.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          schoolId: 10,
        },
      }));
      // should omit isArchived filter
      expect(prisma.communicationTemplate.findMany).not.toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          isArchived: expect.any(Boolean),
        }),
      }));
    });

    it('searches by query string', async () => {
      (prisma.communicationTemplate.count as jest.Mock).mockResolvedValue(0);
      (prisma.communicationTemplate.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(appWithCommunicationsRouter())
        .get('/communications/templates?search=hello');

      expect(res.status).toBe(200);
      expect(prisma.communicationTemplate.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { name: { contains: 'hello', mode: 'insensitive' } },
            { title: { contains: 'hello', mode: 'insensitive' } },
            { body: { contains: 'hello', mode: 'insensitive' } },
          ],
        }),
      }));
    });
  });

  describe('PATCH /communications/templates/:id', () => {
    const existingTemplate = {
      id: 100,
      schoolId: 10,
      name: 'Old Name',
      title: 'Old Title',
      body: 'Old Body',
      category: 'ANNOUNCEMENT',
      priority: 'NORMAL',
      channel: 'IN_APP',
      isArchived: false,
    };

    it('updates template fields', async () => {
      (prisma.communicationTemplate.findFirst as jest.Mock).mockResolvedValue(existingTemplate);
      (prisma.communicationTemplate.update as jest.Mock).mockResolvedValue({
        ...existingTemplate,
        name: 'New Name',
      });

      const res = await request(appWithCommunicationsRouter())
        .patch('/communications/templates/100')
        .send({ name: 'New Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('New Name');
      expect(prisma.communicationTemplate.update).toHaveBeenCalledWith({
        where: { id: 100 },
        data: { name: 'New Name' },
      });
    });

    it('rejects update if template does not exist or belongs to another school', async () => {
      (prisma.communicationTemplate.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(appWithCommunicationsRouter())
        .patch('/communications/templates/100')
        .send({ name: 'New Name' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Template not found');
    });

    it('rejects update if template is archived', async () => {
      (prisma.communicationTemplate.findFirst as jest.Mock).mockResolvedValue({
        ...existingTemplate,
        isArchived: true,
      });

      const res = await request(appWithCommunicationsRouter())
        .patch('/communications/templates/100')
        .send({ name: 'New Name' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot update archived template');
    });

    it('rejects update with empty name', async () => {
      (prisma.communicationTemplate.findFirst as jest.Mock).mockResolvedValue(existingTemplate);

      const res = await request(appWithCommunicationsRouter())
        .patch('/communications/templates/100')
        .send({ name: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Name cannot be empty');
    });
  });

  describe('DELETE /communications/templates/:id', () => {
    const existingTemplate = {
      id: 100,
      schoolId: 10,
      name: 'Template',
      isArchived: false,
    };

    it('archives template by setting isArchived to true', async () => {
      (prisma.communicationTemplate.findFirst as jest.Mock).mockResolvedValue(existingTemplate);
      (prisma.communicationTemplate.update as jest.Mock).mockResolvedValue({
        ...existingTemplate,
        isArchived: true,
      });

      const res = await request(appWithCommunicationsRouter())
        .delete('/communications/templates/100');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isArchived).toBe(true);
      expect(prisma.communicationTemplate.update).toHaveBeenCalledWith({
        where: { id: 100 },
        data: { isArchived: true },
      });
    });

    it('rejects delete if template does not exist or belongs to another school', async () => {
      (prisma.communicationTemplate.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(appWithCommunicationsRouter())
        .delete('/communications/templates/100');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Template not found');
    });
  });
});
