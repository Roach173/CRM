import { Router } from 'express';
import {
  CommunicationCampaignStatus,
  CommunicationChannel,
  CommunicationRecipientStatus,
  CommunicationTargetType,
  GroupStatus,
  Role,
} from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import prisma from '../lib/prisma';
import { createLogger } from '../lib/logger';
import {
  createAndSendCampaign,
  CommunicationValidationError,
  getCampaign,
  listCampaigns,
  listCampaignRecipients,
  previewCommunicationRecipients,
  createCampaignDraft,
  updateCampaignDraft,
  sendCampaignDraft,
  createScheduledCampaign,
  updateScheduledCampaign,
  cancelScheduledCampaign,
} from '../services/communicationService';
import {
  createTemplate,
  updateTemplate,
  archiveTemplate,
  listTemplates,
} from '../services/communicationTemplateService';
import { isAllowedCommunicationRecipientRole } from '../constants/communications';
import {
  isKnownNotificationCategory,
  NotificationCategory,
  NotificationPriority,
} from '../constants/notifications';

const log = createLogger('communications');
const router = Router();

const NOTIFICATION_PRIORITIES = new Set<string>(Object.values(NotificationPriority));
const GROUP_STATUSES = new Set<string>(Object.values(GroupStatus));
const CAMPAIGN_RECIPIENT_STATUSES = new Set<string>([
  'ALL',
  ...Object.values(CommunicationRecipientStatus),
]);
const RECIPIENT_SEARCH_DEFAULT_LIMIT = 20;
const RECIPIENT_SEARCH_MAX_LIMIT = 50;
const GROUP_SEARCH_DEFAULT_LIMIT = 20;
const GROUP_SEARCH_MAX_LIMIT = 50;

function parsePositiveInt(value: unknown, fallback: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCreateBody(body: any) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const message = typeof body?.body === 'string' ? body.body.trim() : '';
  const category = typeof body?.category === 'string' ? body.category : NotificationCategory.ANNOUNCEMENT;
  const priority = typeof body?.priority === 'string' ? body.priority : NotificationPriority.NORMAL;
  const channel = typeof body?.channel === 'string' ? body.channel : CommunicationChannel.IN_APP;
  const targetType = typeof body?.targetType === 'string' ? body.targetType : '';
  const targetConfig = body?.targetConfig && typeof body.targetConfig === 'object' ? body.targetConfig : {};

  if (!title || !message) {
    throw new CommunicationValidationError('title and body are required');
  }
  if (!isKnownNotificationCategory(category)) {
    throw new CommunicationValidationError('Invalid category');
  }
  if (!NOTIFICATION_PRIORITIES.has(priority)) {
    throw new CommunicationValidationError('Invalid priority');
  }
  if (channel !== CommunicationChannel.IN_APP) {
    throw new CommunicationValidationError('Only IN_APP channel is supported');
  }
  if (
    targetType !== CommunicationTargetType.ROLES
    && targetType !== CommunicationTargetType.USERS
    && targetType !== CommunicationTargetType.GROUPS
  ) {
    throw new CommunicationValidationError('Invalid targetType');
  }

  return {
    title,
    body: message,
    category: category as NotificationCategory,
    priority: priority as NotificationPriority,
    channel,
    targetType,
    targetConfig,
  };
}

function parsePreviewBody(body: any) {
  const targetType = typeof body?.targetType === 'string' ? body.targetType : '';
  const targetConfig = body?.targetConfig && typeof body.targetConfig === 'object' ? body.targetConfig : {};

  if (
    targetType !== CommunicationTargetType.ROLES
    && targetType !== CommunicationTargetType.USERS
    && targetType !== CommunicationTargetType.GROUPS
  ) {
    throw new CommunicationValidationError('Invalid targetType');
  }

  return { targetType, targetConfig };
}

function handleError(error: unknown, res: any) {
  if (error instanceof CommunicationValidationError) {
    return res.status(error.statusCode).json({ success: false, error: error.message });
  }

  log.error({ err: error }, 'request error');
  return res.status(500).json({ success: false, error: 'Ошибка сервера' });
}

function parseRecipientRole(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  if (typeof raw !== 'string' || !isAllowedCommunicationRecipientRole(raw as Role)) {
    throw new CommunicationValidationError('Invalid role');
  }
  return raw as Role;
}

function parseOptionalSearch(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function parseOptionalGroupStatus(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  if (typeof raw !== 'string' || !GROUP_STATUSES.has(raw)) {
    throw new CommunicationValidationError('Invalid status');
  }
  return raw as GroupStatus;
}

function parseOptionalCampaignRecipientStatus(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  if (typeof raw !== 'string' || !CAMPAIGN_RECIPIENT_STATUSES.has(raw)) {
    throw new CommunicationValidationError('Invalid recipient status');
  }
  return raw as CommunicationRecipientStatus | 'ALL';
}

router.get('/recipients/search', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const role = parseRecipientRole(req.query.role);
    const search = parseOptionalSearch(req.query.search);
    const limit = Math.min(
      RECIPIENT_SEARCH_MAX_LIMIT,
      parsePositiveInt(req.query.limit, RECIPIENT_SEARCH_DEFAULT_LIMIT),
    );

    const users = await prisma.user.findMany({
      where: {
        schoolId,
        deletedAt: null,
        role: role ? role : { in: [Role.OWNER, Role.ADMIN, Role.TEACHER, Role.STUDENT, Role.PARENT] },
        ...(search
          ? {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { email: 'asc' }],
      take: limit,
    });

    const items = users.map(user => ({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    }));

    res.json({ success: true, data: { items } });
  } catch (error) {
    handleError(error, res);
  }
});

router.get('/groups/search', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const status = parseOptionalGroupStatus(req.query.status);
    const search = parseOptionalSearch(req.query.search);
    const limit = Math.min(
      GROUP_SEARCH_MAX_LIMIT,
      parsePositiveInt(req.query.limit, GROUP_SEARCH_DEFAULT_LIMIT),
    );

    const groups = await prisma.studentGroup.findMany({
      where: {
        schoolId,
        deletedAt: null,
        ...(status ? { status } : {}),
        ...(search
          ? {
              level: { contains: search, mode: 'insensitive' },
            }
          : {}),
      },
      select: {
        id: true,
        level: true,
        status: true,
      },
      orderBy: { level: 'asc' },
      take: limit,
    });

    const items = groups.map(group => ({
      id: group.id,
      level: group.level,
      status: group.status,
    }));

    res.json({ success: true, data: { items } });
  } catch (error) {
    handleError(error, res);
  }
});

router.post('/recipients/preview', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const data = parsePreviewBody(req.body);
    const preview = await previewCommunicationRecipients({ schoolId, ...data });

    res.json({ success: true, data: preview });
  } catch (error) {
    handleError(error, res);
  }
});

router.get('/campaigns', authenticate, requirePermission('communications:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 20);
    const status = typeof req.query.status === 'string' && Object.values(CommunicationCampaignStatus).includes(req.query.status as any)
      ? (req.query.status as CommunicationCampaignStatus)
      : undefined;

    const result = await listCampaigns({ schoolId, page, limit, status });

    res.json({ success: true, data: result.items, meta: result.pagination });
  } catch (error) {
    handleError(error, res);
  }
});

router.post('/campaigns', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const data = parseCreateBody(req.body);
    const campaign = await createAndSendCampaign({
      schoolId,
      createdById: req.user!.userId,
      ...data,
    });

    res.status(201).json({ success: true, data: campaign });
  } catch (error) {
    handleError(error, res);
  }
});

router.get('/campaigns/:id/recipients', authenticate, requirePermission('communications:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const campaignId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(campaignId)) {
      return res.status(400).json({ success: false, error: 'Invalid campaign id' });
    }

    const result = await listCampaignRecipients({
      schoolId,
      campaignId,
      page: parsePositiveInt(req.query.page, 1),
      limit: parsePositiveInt(req.query.limit, 25),
      status: parseOptionalCampaignRecipientStatus(req.query.status),
      search: parseOptionalSearch(req.query.search),
    });

    res.json({
      success: true,
      data: {
        items: result.items,
        pagination: result.pagination,
        stats: result.stats,
      },
    });
  } catch (error) {
    handleError(error, res);
  }
});

router.get('/campaigns/:id', authenticate, requirePermission('communications:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const campaignId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(campaignId)) {
      return res.status(400).json({ success: false, error: 'Invalid campaign id' });
    }

    const campaign = await getCampaign({ schoolId, campaignId, includeRecipients: true });
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

    res.json({ success: true, data: campaign });
  } catch (error) {
    handleError(error, res);
  }
});

router.get('/templates', authenticate, requirePermission('communications:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(100, parsePositiveInt(req.query.limit, 50));
    const search = parseOptionalSearch(req.query.search);
    const includeArchived = req.query.includeArchived === 'true';

    const result = await listTemplates({
      schoolId,
      page,
      limit,
      search,
      includeArchived,
    });

    res.json({
      success: true,
      data: {
        items: result.items,
        pagination: result.pagination,
      },
    });
  } catch (error) {
    handleError(error, res);
  }
});

router.post('/templates', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const { name, title, body, category, priority, channel } = req.body;
    const template = await createTemplate({
      schoolId,
      createdById: req.user!.userId,
      name,
      title,
      body,
      category,
      priority,
      channel,
    });

    res.status(201).json({ success: true, data: template });
  } catch (error) {
    handleError(error, res);
  }
});

router.patch('/templates/:id', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const templateId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(templateId)) {
      return res.status(400).json({ success: false, error: 'Invalid template id' });
    }

    const { name, title, body, category, priority, channel } = req.body;
    const template = await updateTemplate({
      schoolId,
      templateId,
      name,
      title,
      body,
      category,
      priority,
      channel,
    });

    res.json({ success: true, data: template });
  } catch (error) {
    handleError(error, res);
  }
});

router.delete('/templates/:id', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const templateId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(templateId)) {
      return res.status(400).json({ success: false, error: 'Invalid template id' });
    }

    const template = await archiveTemplate({ schoolId, templateId });
    res.json({ success: true, data: template });
  } catch (error) {
    handleError(error, res);
  }
});

router.post('/campaigns/draft', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const data = parseCreateBody(req.body);
    const campaign = await createCampaignDraft({
      schoolId,
      createdById: req.user!.userId,
      ...data,
    });

    res.status(201).json({ success: true, data: campaign });
  } catch (error) {
    handleError(error, res);
  }
});

router.patch('/campaigns/:id/draft', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const campaignId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(campaignId)) {
      return res.status(400).json({ success: false, error: 'Invalid campaign id' });
    }

    const data = parseCreateBody(req.body);
    const campaign = await updateCampaignDraft({
      schoolId,
      campaignId,
      ...data,
    });

    res.json({ success: true, data: campaign });
  } catch (error) {
    handleError(error, res);
  }
});

router.post('/campaigns/:id/send', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const campaignId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(campaignId)) {
      return res.status(400).json({ success: false, error: 'Invalid campaign id' });
    }

    const campaign = await sendCampaignDraft({ schoolId, campaignId });
    res.json({ success: true, data: campaign });
  } catch (error) {
    handleError(error, res);
  }
});

router.post('/campaigns/schedule', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const data = parseCreateBody(req.body);
    
    const { scheduledAt } = req.body;
    if (!scheduledAt) {
      throw new CommunicationValidationError('Scheduled time is required');
    }
    
    const parsedScheduledAt = new Date(scheduledAt);

    const campaign = await createScheduledCampaign({
      schoolId,
      createdById: req.user!.userId,
      ...data,
      scheduledAt: parsedScheduledAt,
    });

    res.status(201).json({ success: true, data: campaign });
  } catch (error) {
    handleError(error, res);
  }
});

router.patch('/campaigns/:id/schedule', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const campaignId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(campaignId)) {
      return res.status(400).json({ success: false, error: 'Invalid campaign id' });
    }

    const title = typeof req.body.title === 'string' ? req.body.title.trim() : undefined;
    const bodyText = typeof req.body.body === 'string' ? req.body.body.trim() : undefined;
    const category = typeof req.body.category === 'string' ? req.body.category : undefined;
    const priority = typeof req.body.priority === 'string' ? req.body.priority : undefined;
    const channel = typeof req.body.channel === 'string' ? req.body.channel : undefined;
    const targetType = typeof req.body.targetType === 'string' ? req.body.targetType : undefined;
    const targetConfig = req.body.targetConfig && typeof req.body.targetConfig === 'object' ? req.body.targetConfig : undefined;
    
    let scheduledAtDate = undefined;
    if (req.body.scheduledAt !== undefined) {
      if (!req.body.scheduledAt) {
        throw new CommunicationValidationError('Scheduled time is required');
      }
      scheduledAtDate = new Date(req.body.scheduledAt);
    }

    const campaign = await updateScheduledCampaign({
      schoolId,
      campaignId,
      title,
      body: bodyText,
      category: category as any,
      priority: priority as any,
      channel: channel as any,
      targetType: targetType as any,
      targetConfig: targetConfig as any,
      scheduledAt: scheduledAtDate,
    });

    res.json({ success: true, data: campaign });
  } catch (error) {
    handleError(error, res);
  }
});

router.post('/campaigns/:id/cancel', authenticate, requirePermission('communications:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId;
    if (!schoolId) return res.status(400).json({ success: false, error: 'schoolId is required' });

    const campaignId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(campaignId)) {
      return res.status(400).json({ success: false, error: 'Invalid campaign id' });
    }

    const campaign = await cancelScheduledCampaign({ schoolId, campaignId });
    res.json({ success: true, data: campaign });
  } catch (error) {
    handleError(error, res);
  }
});

export default router;
