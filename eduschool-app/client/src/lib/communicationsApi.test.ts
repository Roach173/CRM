import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from './api';
import {
  buildCommunicationRecipientPreviewRequest,
  buildCreateCommunicationCampaignRequest,
  canSubmitCampaign,
  COMMUNICATION_CATEGORY_LABELS,
  COMMUNICATION_CHANNEL_LABELS,
  COMMUNICATION_GROUP_AUDIENCE_LABELS,
  COMMUNICATION_PRIORITY_LABELS,
  COMMUNICATION_RECIPIENT_STATUS_LABELS,
  COMMUNICATION_ROLE_LABELS,
  COMMUNICATION_STATUS_LABELS,
  COMMUNICATION_TARGET_TYPE_LABELS,
  formatCommunicationDeliveryRate,
  formatRecipientSample,
  getCommunicationRecipientDisplayName,
  getCommunicationSkippedReasonLabel,
  listCommunicationCampaignRecipients,
  listCommunicationGroups,
  listCommunicationUsers,
  previewCommunicationRecipients,
  validateCommunicationCampaignDraft,
  type CommunicationCampaignDraft,
  listCommunicationTemplates,
  createCommunicationTemplate,
  updateCommunicationTemplate,
  archiveCommunicationTemplate,
  createCommunicationCampaignDraft,
  updateCommunicationCampaignDraft,
  sendCommunicationCampaignDraft,
  listCommunicationCampaigns,
  scheduleCommunicationCampaign,
  updateScheduledCommunicationCampaign,
  cancelScheduledCommunicationCampaign,
} from './communicationsApi';

vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const baseDraft: CommunicationCampaignDraft = {
  title: '  New schedule  ',
  body: '  Classes start at 10  ',
  category: 'ANNOUNCEMENT',
  priority: 'NORMAL',
  targetType: 'ROLES',
  roles: ['STUDENT'],
  userIds: [],
  groupIds: [],
  groupAudience: 'STUDENTS',
};

describe('communications campaign helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a roles targeting POST payload', () => {
    const payload = buildCreateCommunicationCampaignRequest({
      ...baseDraft,
      roles: ['STUDENT', 'TEACHER', 'STUDENT'],
    });

    expect(payload).toEqual({
      title: 'New schedule',
      body: 'Classes start at 10',
      category: 'ANNOUNCEMENT',
      priority: 'NORMAL',
      channel: 'IN_APP',
      targetType: 'ROLES',
      targetConfig: { roles: ['STUDENT', 'TEACHER'] },
    });
  });

  it('builds a users targeting POST payload with deduped user ids', () => {
    const payload = buildCreateCommunicationCampaignRequest({
      ...baseDraft,
      targetType: 'USERS',
      roles: [],
      userIds: [42, 42, 77, 0, -1],
    });

    expect(payload).toMatchObject({
      targetType: 'USERS',
      targetConfig: { userIds: [42, 77] },
    });
  });

  it('builds a groups targeting POST payload with deduped group ids and audience', () => {
    const payload = buildCreateCommunicationCampaignRequest({
      ...baseDraft,
      targetType: 'GROUPS',
      roles: [],
      userIds: [],
      groupIds: [301, 301, 302, 0],
      groupAudience: 'STUDENTS_AND_PARENTS',
    });

    expect(payload).toMatchObject({
      targetType: 'GROUPS',
      targetConfig: { groupIds: [301, 302], audience: 'STUDENTS_AND_PARENTS' },
    });
  });

  it('validates required title, body, and role selection', () => {
    const errors = validateCommunicationCampaignDraft({
      ...baseDraft,
      title: ' ',
      body: '',
      roles: [],
    });

    expect(errors).toEqual([
      'Укажите заголовок',
      'Укажите текст сообщения',
      'Выберите хотя бы одну роль',
    ]);
  });

  it('validates selected users for users targeting', () => {
    const errors = validateCommunicationCampaignDraft({
      ...baseDraft,
      targetType: 'USERS',
      roles: [],
      userIds: [],
    });

    expect(errors).toEqual(['Выберите хотя бы одного пользователя']);
  });

  it('validates selected groups and audience for groups targeting', () => {
    const errors = validateCommunicationCampaignDraft({
      ...baseDraft,
      targetType: 'GROUPS',
      roles: [],
      userIds: [],
      groupIds: [],
      groupAudience: '',
    });

    expect(errors).toEqual([
      'Выберите хотя бы одну группу',
      'Выберите аудиторию групп',
    ]);
  });

  it('maps campaign and recipient statuses to Russian labels', () => {
    expect(COMMUNICATION_STATUS_LABELS).toMatchObject({
      DRAFT: 'Черновик',
      SENDING: 'Отправляется',
      SENT: 'Отправлено',
      FAILED: 'Ошибка',
      CANCELLED: 'Отменено',
    });
    expect(COMMUNICATION_RECIPIENT_STATUS_LABELS).toMatchObject({
      PENDING: 'Ожидает',
      SENT: 'Отправлено',
      SKIPPED: 'Пропущено',
      FAILED: 'Ошибка',
    });
  });

  it('maps roles, category, priority, target, channel, and skipped reason labels', () => {
    expect(COMMUNICATION_ROLE_LABELS).toMatchObject({
      OWNER: 'Владельцы',
      ADMIN: 'Администраторы',
      TEACHER: 'Учителя',
      STUDENT: 'Студенты',
      PARENT: 'Родители',
    });
    expect(COMMUNICATION_CATEGORY_LABELS).toMatchObject({
      ANNOUNCEMENT: 'Объявления',
      FINANCE: 'Финансы',
      SCHEDULE: 'Расписание',
      STUDENTS: 'Ученики',
      STAFF: 'Сотрудники',
      SUBSCRIPTION: 'Подписка',
      ACADEMICS: 'Обучение',
      SYSTEM: 'Система',
    });
    expect(COMMUNICATION_PRIORITY_LABELS).toMatchObject({
      NORMAL: 'Обычное',
      HIGH: 'Важное',
      CRITICAL: 'Критическое',
    });
    expect(COMMUNICATION_TARGET_TYPE_LABELS).toMatchObject({
      ROLES: 'По ролям',
      USERS: 'Выбранные пользователи',
    });
    expect(COMMUNICATION_CHANNEL_LABELS).toEqual({ IN_APP: 'Внутри CRM' });
    expect(getCommunicationSkippedReasonLabel('PREFERENCE_DISABLED')).toBe('Отключено в настройках');
    expect(getCommunicationSkippedReasonLabel()).toBe('—');
  });

  it('formats delivery rates without dividing by zero', () => {
    expect(formatCommunicationDeliveryRate(90, 100)).toBe('90%');
    expect(formatCommunicationDeliveryRate(0, 0)).toBe('0%');
  });

  it('formats recipient display names with fallbacks', () => {
    expect(getCommunicationRecipientDisplayName({
      userId: 42,
      user: {
        id: 42,
        email: 'student@example.com',
        firstName: 'Айжан',
        lastName: 'Иванова',
        role: 'STUDENT',
      },
    })).toBe('Айжан Иванова');
    expect(getCommunicationRecipientDisplayName({
      userId: 43,
      user: {
        id: 43,
        email: 'parent@example.com',
        firstName: '',
        lastName: '',
        role: 'PARENT',
      },
    })).toBe('parent@example.com');
    expect(getCommunicationRecipientDisplayName({
      userId: 44,
      user: {
        id: 44,
        email: '',
        firstName: '',
        lastName: '',
        role: 'STUDENT',
      },
    })).toBe('Пользователь #44');
  });

  it('searches recipients through the communications endpoint with role, search, and limit params', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        success: true,
        data: {
          items: [
            {
              id: 42,
              email: 'student@example.com',
              firstName: 'Student',
              lastName: 'One',
              role: 'STUDENT',
              schoolId: 10,
            },
          ],
        },
      },
    });

    const users = await listCommunicationUsers({
      role: 'STUDENT',
      search: 'student',
      limit: 25,
    });

    expect(api.get).toHaveBeenCalledWith('/communications/recipients/search', {
      params: {
        role: 'STUDENT',
        search: 'student',
        limit: 25,
      },
    });
    expect(users).toEqual([
      expect.objectContaining({
        id: 42,
        email: 'student@example.com',
        role: 'STUDENT',
      }),
    ]);
  });

  it('searches groups through the communications endpoint', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: { success: true, data: { items: [{ id: 301, name: 'A1 Morning', level: 'A1', status: 'ACTIVE' }] } },
    });

    const groups = await listCommunicationGroups({ search: 'A1', status: 'ACTIVE', limit: 25 });

    expect(api.get).toHaveBeenCalledWith('/communications/groups/search', {
      params: { search: 'A1', status: 'ACTIVE', limit: 25 },
    });
    expect(groups).toEqual([expect.objectContaining({ id: 301, name: 'A1 Morning' })]);
  });

  it('builds and sends recipient preview requests', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { success: true, data: { recipientsCount: 2, sample: [] } } });

    const previewRequest = buildCommunicationRecipientPreviewRequest({
      ...baseDraft,
      targetType: 'GROUPS',
      groupIds: [301],
      groupAudience: 'PARENTS',
    });
    const preview = await previewCommunicationRecipients(previewRequest);

    expect(api.post).toHaveBeenCalledWith('/communications/recipients/preview', {
      targetType: 'GROUPS',
      targetConfig: { groupIds: [301], audience: 'PARENTS' },
    });
    expect(preview.recipientsCount).toBe(2);
  });

  it('maps group audience labels', () => {
    expect(COMMUNICATION_GROUP_AUDIENCE_LABELS).toEqual({
      STUDENTS: 'Ученики',
      PARENTS: 'Родители',
      STUDENTS_AND_PARENTS: 'Ученики и родители',
    });
  });

  it('keeps create campaign users payload unchanged', () => {
    const payload = buildCreateCommunicationCampaignRequest({
      ...baseDraft,
      targetType: 'USERS',
      roles: [],
      userIds: [42, 77],
    });

    expect(payload).toEqual(expect.objectContaining({
      targetType: 'USERS',
      targetConfig: { userIds: [42, 77] },
    }));
  });

  it('detects preview stale states based on draft changes', () => {
    const request1 = buildCommunicationRecipientPreviewRequest(baseDraft);

    // 1. Preview stale when targetType changes
    const draftTargetTypeChanged: CommunicationCampaignDraft = {
      ...baseDraft,
      targetType: 'USERS',
      userIds: [10],
    };
    const requestTargetTypeChanged = buildCommunicationRecipientPreviewRequest(draftTargetTypeChanged);
    expect(JSON.stringify(request1)).not.toBe(JSON.stringify(requestTargetTypeChanged));

    // 2. Preview stale when selected groups change
    const draftGroupsBase: CommunicationCampaignDraft = {
      ...baseDraft,
      targetType: 'GROUPS',
      groupIds: [301],
    };
    const requestGroupsBase = buildCommunicationRecipientPreviewRequest(draftGroupsBase);
    const draftGroupsChanged: CommunicationCampaignDraft = {
      ...draftGroupsBase,
      groupIds: [301, 302],
    };
    const requestGroupsChanged = buildCommunicationRecipientPreviewRequest(draftGroupsChanged);
    expect(JSON.stringify(requestGroupsBase)).not.toBe(JSON.stringify(requestGroupsChanged));

    // 3. Preview stale when audience changes
    const draftAudienceChanged: CommunicationCampaignDraft = {
      ...draftGroupsBase,
      groupAudience: 'PARENTS',
    };
    const requestAudienceChanged = buildCommunicationRecipientPreviewRequest(draftAudienceChanged);
    expect(JSON.stringify(requestGroupsBase)).not.toBe(JSON.stringify(requestAudienceChanged));

    // 4. Preview not stale when title/body changes
    const draftContentChanged: CommunicationCampaignDraft = {
      ...baseDraft,
      title: 'New Title',
      body: 'New Body text here',
    };
    const requestContentChanged = buildCommunicationRecipientPreviewRequest(draftContentChanged);
    expect(JSON.stringify(request1)).toBe(JSON.stringify(requestContentChanged));
  });

  it('determines if campaigns can be submitted via canSubmitCampaign', () => {
    const baseParams = {
      validationErrors: [],
      submitting: false,
      recipientPreviewLoading: false,
      recipientPreviewKey: '{"targetType":"ROLES","targetConfig":{"roles":["STUDENT"]}}',
      currentPreviewKey: '{"targetType":"ROLES","targetConfig":{"roles":["STUDENT"]}}',
      recipientsCount: 5,
    };

    // Valid state
    expect(canSubmitCampaign(baseParams)).toBe(true);

    // Disabled when validation errors present
    expect(canSubmitCampaign({ ...baseParams, validationErrors: ['Title required'] })).toBe(false);

    // Disabled when submitting
    expect(canSubmitCampaign({ ...baseParams, submitting: true })).toBe(false);

    // Disabled when preview is loading
    expect(canSubmitCampaign({ ...baseParams, recipientPreviewLoading: true })).toBe(false);

    // Disabled when preview is missing (empty key)
    expect(canSubmitCampaign({ ...baseParams, recipientPreviewKey: '' })).toBe(false);

    // Disabled when preview is stale (key mismatch)
    expect(canSubmitCampaign({ ...baseParams, recipientPreviewKey: '{"targetType":"ROLES","targetConfig":{"roles":["TEACHER"]}}' })).toBe(false);

    // Disabled when recipients count is 0
    expect(canSubmitCampaign({ ...baseParams, recipientsCount: 0 })).toBe(false);
    expect(canSubmitCampaign({ ...baseParams, recipientsCount: null })).toBe(false);
  });

  it('formats recipient sample correctly via formatRecipientSample', () => {
    const user = {
      firstName: 'Айжан',
      lastName: 'Иванова',
      email: 'user@example.com',
      role: 'STUDENT',
    };
    expect(formatRecipientSample(user)).toBe('Айжан Иванова, user@example.com, Студент');

    const parentUser = {
      firstName: 'Михаил',
      lastName: '',
      email: 'parent@example.com',
      role: 'PARENT',
    };
    expect(formatRecipientSample(parentUser)).toBe('Михаил, parent@example.com, Родитель');
  });

  describe('communication templates API', () => {
    it('lists communication templates', async () => {
      const templatesMock = [
        { id: 1, name: 'Template 1', title: 'T1', body: 'B1', isArchived: false },
      ];
      vi.mocked(api.get).mockResolvedValue({
        data: {
          success: true,
          data: {
            items: templatesMock,
            pagination: { total: 1 },
          },
        },
      });

      const res = await listCommunicationTemplates({ includeArchived: true, search: 'test' });

      expect(api.get).toHaveBeenCalledWith('/communications/templates', {
        params: { includeArchived: true, search: 'test' },
      });
      expect(res).toEqual({
        items: templatesMock,
        pagination: { total: 1 },
      });
    });

    it('creates a communication template', async () => {
      const payload = {
        name: 'New template',
        title: 'Title',
        body: 'Body',
        category: 'ANNOUNCEMENT',
        priority: 'NORMAL',
      };
      const createdMock = { id: 10, ...payload, channel: 'IN_APP', isArchived: false };
      vi.mocked(api.post).mockResolvedValue({
        data: {
          success: true,
          data: createdMock,
        },
      });

      const res = await createCommunicationTemplate(payload);

      expect(api.post).toHaveBeenCalledWith('/communications/templates', payload);
      expect(res).toEqual(createdMock);
    });

    it('updates a communication template', async () => {
      const payload = {
        name: 'Updated template name',
      };
      const updatedMock = { id: 10, name: 'Updated template name', title: 'Title', body: 'Body', isArchived: false };
      vi.mocked(api.patch).mockResolvedValue({
        data: {
          success: true,
          data: updatedMock,
        },
      });

      const res = await updateCommunicationTemplate(10, payload);

      expect(api.patch).toHaveBeenCalledWith('/communications/templates/10', payload);
      expect(res).toEqual(updatedMock);
    });

    it('archives a communication template', async () => {
      const archivedMock = { id: 10, name: 'Template', isArchived: true };
      vi.mocked(api.delete).mockResolvedValue({
        data: {
          success: true,
          data: archivedMock,
        },
      });

      const res = await archiveCommunicationTemplate(10);

      expect(api.delete).toHaveBeenCalledWith('/communications/templates/10');
      expect(res).toEqual(archivedMock);
    });
  });

  describe('communication delivery recipients API', () => {
    it('lists communication campaign recipients with delivery params', async () => {
      const responseMock = {
        items: [
          {
            id: 1,
            campaignId: 500,
            userId: 42,
            status: 'SENT',
            skippedReason: null,
            error: null,
            notificationId: 123,
            createdAt: '2026-06-05T12:00:00.000Z',
            updatedAt: '2026-06-05T12:00:00.000Z',
            user: {
              id: 42,
              email: 'student@example.com',
              firstName: 'Student',
              lastName: 'One',
              role: 'STUDENT',
            },
          },
        ],
        pagination: {
          page: 2,
          limit: 25,
          total: 30,
          totalPages: 2,
          hasNextPage: false,
          hasPrevPage: true,
        },
        stats: {
          recipientsCount: 30,
          sentCount: 20,
          skippedCount: 8,
          failedCount: 2,
        },
      };
      vi.mocked(api.get).mockResolvedValue({
        data: {
          success: true,
          data: responseMock,
        },
      });

      const res = await listCommunicationCampaignRecipients(500, {
        status: 'SENT',
        search: 'student',
        page: 2,
        limit: 25,
      });

      expect(api.get).toHaveBeenCalledWith('/communications/campaigns/500/recipients', {
        params: {
          status: 'SENT',
          search: 'student',
          page: 2,
          limit: 25,
        },
      });
      expect(res).toEqual(responseMock);
    });

    it('lists communication campaign recipients with status=ALL', async () => {
      vi.mocked(api.get).mockResolvedValue({
        data: {
          success: true,
          data: {
            items: [],
            pagination: { page: 1, limit: 25, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
            stats: { recipientsCount: 0, sentCount: 0, skippedCount: 0, failedCount: 0 },
          },
        },
      });

      await listCommunicationCampaignRecipients(500, { status: 'ALL', page: 1, limit: 25 });

      expect(api.get).toHaveBeenCalledWith('/communications/campaigns/500/recipients', {
        params: { status: 'ALL', page: 1, limit: 25 },
      });
    });
  });

  describe('communication drafts API', () => {
    it('lists communication campaign drafts with status filter', async () => {
      const draftsMock = [{ id: 100, title: 'Draft 1', status: 'DRAFT' }];
      vi.mocked(api.get).mockResolvedValue({
        data: {
          success: true,
          data: draftsMock,
          meta: { total: 1 },
        },
      });

      const res = await listCommunicationCampaigns({ status: 'DRAFT', page: 1, limit: 10 });

      expect(api.get).toHaveBeenCalledWith('/communications/campaigns', {
        params: { status: 'DRAFT', page: 1, limit: 10 },
      });
      expect(res).toEqual({
        items: draftsMock,
        pagination: { total: 1 },
      });
    });

    it('creates a communication campaign draft', async () => {
      const input = {
        title: 'Draft Title',
        body: 'Draft Body',
        targetType: 'ROLES' as const,
        targetConfig: { roles: ['STUDENT' as const] },
      };
      const createdMock = { id: 100, ...input, status: 'DRAFT' };
      vi.mocked(api.post).mockResolvedValue({
        data: {
          success: true,
          data: createdMock,
        },
      });

      const res = await createCommunicationCampaignDraft(input);

      expect(api.post).toHaveBeenCalledWith('/communications/campaigns/draft', input);
      expect(res).toEqual(createdMock);
    });

    it('updates a communication campaign draft', async () => {
      const input = {
        title: 'Updated Draft Title',
      };
      const updatedMock = { id: 100, title: 'Updated Draft Title', body: 'Draft Body', status: 'DRAFT' };
      vi.mocked(api.patch).mockResolvedValue({
        data: {
          success: true,
          data: updatedMock,
        },
      });

      const res = await updateCommunicationCampaignDraft(100, input);

      expect(api.patch).toHaveBeenCalledWith('/communications/campaigns/100/draft', input);
      expect(res).toEqual(updatedMock);
    });

    it('sends a communication campaign draft', async () => {
      const sentMock = { id: 100, status: 'SENT' };
      vi.mocked(api.post).mockResolvedValue({
        data: {
          success: true,
          data: sentMock,
        },
      });

      const res = await sendCommunicationCampaignDraft(100);

      expect(api.post).toHaveBeenCalledWith('/communications/campaigns/100/send');
      expect(res).toEqual(sentMock);
    });
  });

  describe('communication scheduled campaigns API', () => {
    it('creates/schedules a campaign', async () => {
      const input = {
        title: 'Title',
        body: 'Body',
        category: 'ANNOUNCEMENT' as const,
        priority: 'NORMAL' as const,
        channel: 'IN_APP' as const,
        targetType: 'ROLES' as const,
        targetConfig: { roles: ['STUDENT' as const] },
        scheduledAt: '2026-06-07T12:00:00.000Z',
      };
      const responseMock = { id: 200, ...input, status: 'SCHEDULED' };
      vi.mocked(api.post).mockResolvedValue({ data: { success: true, data: responseMock } });

      const res = await scheduleCommunicationCampaign(input);

      expect(api.post).toHaveBeenCalledWith('/communications/campaigns/schedule', input);
      expect(res).toEqual(responseMock);
    });

    it('updates a scheduled campaign', async () => {
      const input = {
        title: 'New Title',
      };
      const responseMock = { id: 200, title: 'New Title', status: 'SCHEDULED' };
      vi.mocked(api.patch).mockResolvedValue({ data: { success: true, data: responseMock } });

      const res = await updateScheduledCommunicationCampaign(200, input);

      expect(api.patch).toHaveBeenCalledWith('/communications/campaigns/200/schedule', input);
      expect(res).toEqual(responseMock);
    });

    it('cancels a scheduled campaign', async () => {
      const responseMock = { id: 200, status: 'CANCELLED' };
      vi.mocked(api.post).mockResolvedValue({ data: { success: true, data: responseMock } });

      const res = await cancelScheduledCommunicationCampaign(200);

      expect(api.post).toHaveBeenCalledWith('/communications/campaigns/200/cancel');
      expect(res).toEqual(responseMock);
    });
  });
});
