import api from './api';
import type {
  CommunicationChannel,
  CommunicationCampaign,
  CommunicationCampaignRecipientDeliveryItem,
  CommunicationCampaignRecipientsResponse,
  CommunicationCampaignListResponse,
  CommunicationCampaignStatus,
  CommunicationGroup,
  CommunicationGroupAudience,
  CommunicationRecipientDeliveryStatusFilter,
  CommunicationRecipientPreview,
  CommunicationRecipientStatus,
  CommunicationTargetConfig,
  CommunicationTargetRole,
  CommunicationTargetType,
  CreateCommunicationCampaignRequest,
  CreateCommunicationCampaignDraftRequest,
  UpdateCommunicationCampaignDraftRequest,
  ScheduleCommunicationCampaignRequest,
  UpdateScheduledCommunicationCampaignRequest,
  NotificationCategory,
  NotificationPagination,
  NotificationPriority,
  User,
  CommunicationTemplate,
  CreateCommunicationTemplateRequest,
  UpdateCommunicationTemplateRequest,
} from '../types';

export const COMMUNICATION_CATEGORIES: NotificationCategory[] = [
  'ANNOUNCEMENT',
  'FINANCE',
  'SCHEDULE',
  'STUDENTS',
  'STAFF',
  'ACADEMICS',
];

export const COMMUNICATION_PRIORITIES: NotificationPriority[] = ['NORMAL', 'HIGH', 'CRITICAL'];

export const COMMUNICATION_TARGET_ROLES: CommunicationTargetRole[] = [
  'OWNER',
  'ADMIN',
  'TEACHER',
  'STUDENT',
  'PARENT',
];

export const COMMUNICATION_GROUP_AUDIENCES: CommunicationGroupAudience[] = [
  'STUDENTS',
  'PARENTS',
  'STUDENTS_AND_PARENTS',
];

export const COMMUNICATION_CATEGORY_LABELS: Record<string, string> = {
  ANNOUNCEMENT: 'Объявления',
  FINANCE: 'Финансы',
  SCHEDULE: 'Расписание',
  STUDENTS: 'Ученики',
  STAFF: 'Сотрудники',
  ACADEMICS: 'Обучение',
  SUBSCRIPTION: 'Подписка',
  SYSTEM: 'Система',
};

export const COMMUNICATION_PRIORITY_LABELS: Record<string, string> = {
  NORMAL: 'Обычное',
  HIGH: 'Важное',
  CRITICAL: 'Критическое',
};

export const COMMUNICATION_STATUS_LABELS: Record<CommunicationCampaignStatus, string> = {
  DRAFT: 'Черновик',
  SCHEDULED: 'Запланировано',
  SENDING: 'Отправляется',
  SENT: 'Отправлено',
  FAILED: 'Ошибка',
  CANCELLED: 'Отменено',
};

export const COMMUNICATION_RECIPIENT_STATUS_LABELS: Record<CommunicationRecipientStatus, string> = {
  PENDING: 'Ожидает',
  SENT: 'Отправлено',
  SKIPPED: 'Пропущено',
  FAILED: 'Ошибка',
};

export const COMMUNICATION_CHANNEL_LABELS: Record<CommunicationChannel, string> = {
  IN_APP: 'Внутри CRM',
};

export const COMMUNICATION_TARGET_TYPE_LABELS: Partial<Record<CommunicationTargetType, string>> = {
  ROLES: 'По ролям',
  USERS: 'Выбранные пользователи',
};

export const COMMUNICATION_SKIPPED_REASON_LABELS: Record<string, string> = {
  PREFERENCE_DISABLED: 'Отключено в настройках',
};

COMMUNICATION_TARGET_TYPE_LABELS.GROUPS = 'По группам';


export const COMMUNICATION_GROUP_AUDIENCE_LABELS: Record<CommunicationGroupAudience, string> = {
  STUDENTS: 'Ученики',
  PARENTS: 'Родители',
  STUDENTS_AND_PARENTS: 'Ученики и родители',
};

export const COMMUNICATION_ROLE_LABELS: Record<CommunicationTargetRole, string> = {
  OWNER: 'Владельцы',
  ADMIN: 'Администраторы',
  TEACHER: 'Учителя',
  STUDENT: 'Студенты',
  PARENT: 'Родители',
};

export const COMMUNICATION_ROLE_SINGULAR_LABELS: Record<CommunicationTargetRole, string> = {
  OWNER: 'Владелец',
  ADMIN: 'Администратор',
  TEACHER: 'Учитель',
  STUDENT: 'Студент',
  PARENT: 'Родитель',
};

export function getCommunicationSkippedReasonLabel(reason?: string | null) {
  if (!reason) return '—';
  return COMMUNICATION_SKIPPED_REASON_LABELS[reason] ?? reason;
}

export function formatCommunicationDeliveryRate(numerator: number, denominator: number) {
  if (denominator <= 0) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

export function getCommunicationRecipientDisplayName(
  recipient: Pick<CommunicationCampaignRecipientDeliveryItem, 'user' | 'userId'>,
) {
  const name = `${recipient.user?.firstName ?? ''} ${recipient.user?.lastName ?? ''}`.trim();
  return name || recipient.user?.email || `Пользователь #${recipient.userId}`;
}

export interface CommunicationCampaignDraft {
  title: string;
  body: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  targetType: CommunicationTargetType;
  roles: CommunicationTargetRole[];
  userIds: number[];
  groupIds: number[];
  groupAudience: CommunicationGroupAudience | '';
}

export interface CampaignListParams {
  page?: number;
  limit?: number;
  status?: CommunicationCampaignStatus;
}

export interface CampaignRecipientsListParams {
  status?: CommunicationRecipientDeliveryStatusFilter;
  search?: string;
  page?: number;
  limit?: number;
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values.filter(value => Number.isFinite(value) && value > 0))];
}

function uniqueRoles(values: CommunicationTargetRole[]) {
  return [...new Set(values.filter(role => COMMUNICATION_TARGET_ROLES.includes(role)))];
}

export function validateCommunicationCampaignDraft(draft: CommunicationCampaignDraft): string[] {
  const errors: string[] = [];

  if (!draft.title.trim()) errors.push('Укажите заголовок');
  if (!draft.body.trim()) errors.push('Укажите текст сообщения');
  if (draft.targetType === 'ROLES' && uniqueRoles(draft.roles).length === 0) {
    errors.push('Выберите хотя бы одну роль');
  }
  if (draft.targetType === 'USERS' && uniqueNumbers(draft.userIds).length === 0) {
    errors.push('Выберите хотя бы одного пользователя');
  }

  if (draft.targetType === 'GROUPS') {
    if (uniqueNumbers(draft.groupIds).length === 0) {
      errors.push('Выберите хотя бы одну группу');
    }
    if (!draft.groupAudience || !COMMUNICATION_GROUP_AUDIENCES.includes(draft.groupAudience)) {
      errors.push('Выберите аудиторию групп');
    }
  }

  return errors;
}

export function buildCommunicationTargetConfig(draft: CommunicationCampaignDraft): CommunicationTargetConfig {
  if (draft.targetType === 'ROLES') {
    return { roles: uniqueRoles(draft.roles) };
  }

  if (draft.targetType === 'USERS') {
    return { userIds: uniqueNumbers(draft.userIds) };
  }

  return {
    groupIds: uniqueNumbers(draft.groupIds),
    audience: draft.groupAudience || undefined,
  };
}

export function buildCommunicationRecipientPreviewRequest(draft: CommunicationCampaignDraft) {
  return {
    targetType: draft.targetType,
    targetConfig: buildCommunicationTargetConfig(draft),
  };
}

export function buildCreateCommunicationCampaignRequest(
  draft: CommunicationCampaignDraft,
): CreateCommunicationCampaignRequest {
  return {
    title: draft.title.trim(),
    body: draft.body.trim(),
    category: draft.category,
    priority: draft.priority,
    channel: 'IN_APP',
    targetType: draft.targetType,
    targetConfig: buildCommunicationTargetConfig(draft),
  };
}

export async function listCommunicationCampaigns(params: CampaignListParams = {}) {
  const response = await api.get<CommunicationCampaignListResponse & { success: boolean }>(
    '/communications/campaigns',
    { params },
  );
  return { items: response.data.data, pagination: response.data.meta };
}

export async function createCommunicationCampaign(input: CreateCommunicationCampaignRequest) {
  const response = await api.post<{ success: boolean; data: CommunicationCampaign }>(
    '/communications/campaigns',
    input,
  );
  return response.data.data;
}

export async function getCommunicationCampaign(id: number) {
  const response = await api.get<{ success: boolean; data: CommunicationCampaign }>(
    `/communications/campaigns/${id}`,
  );
  return response.data.data;
}

export async function listCommunicationCampaignRecipients(
  campaignId: number,
  params: CampaignRecipientsListParams = {},
) {
  const response = await api.get<{ success: boolean; data: CommunicationCampaignRecipientsResponse }>(
    `/communications/campaigns/${campaignId}/recipients`,
    { params },
  );
  return response.data.data;
}

export async function listCommunicationUsers(params: {
  role?: CommunicationTargetRole | '';
  search?: string;
  limit?: number;
}) {
  const response = await api.get<{ success: boolean; data: { items: User[] }; meta?: NotificationPagination }>(
    '/communications/recipients/search',
    {
      params: {
        role: params.role || undefined,
        search: params.search || undefined,
        limit: params.limit ?? 50,
      },
    },
  );
  return response.data.data.items;
}
export async function listCommunicationGroups(params: {
  search?: string;
  status?: CommunicationGroup['status'] | '';
  limit?: number;
}) {
  const response = await api.get<{ success: boolean; data: { items: CommunicationGroup[] } }>(
    '/communications/groups/search',
    {
      params: {
        search: params.search || undefined,
        status: params.status || undefined,
        limit: params.limit ?? 50,
      },
    },
  );
  return response.data.data.items;
}

export async function previewCommunicationRecipients(input: {
  targetType: CommunicationTargetType;
  targetConfig: CommunicationTargetConfig;
}) {
  const response = await api.post<{ success: boolean; data: CommunicationRecipientPreview }>(
    '/communications/recipients/preview',
    input,
  );
  return response.data.data;
}

export interface TemplateListParams {
  page?: number;
  limit?: number;
  search?: string;
  includeArchived?: boolean;
}

export async function listCommunicationTemplates(params: TemplateListParams = {}) {
  const response = await api.get<{
    success: boolean;
    data: {
      items: CommunicationTemplate[];
      pagination: NotificationPagination;
    };
  }>('/communications/templates', { params });
  return response.data.data;
}

export async function createCommunicationTemplate(input: CreateCommunicationTemplateRequest) {
  const response = await api.post<{ success: boolean; data: CommunicationTemplate }>(
    '/communications/templates',
    input,
  );
  return response.data.data;
}

export async function updateCommunicationTemplate(id: number, input: UpdateCommunicationTemplateRequest) {
  const response = await api.patch<{ success: boolean; data: CommunicationTemplate }>(
    `/communications/templates/${id}`,
    input,
  );
  return response.data.data;
}

export async function archiveCommunicationTemplate(id: number) {
  const response = await api.delete<{ success: boolean; data: CommunicationTemplate }>(
    `/communications/templates/${id}`,
  );
  return response.data.data;
}


export interface CanSubmitCampaignParams {
  validationErrors: string[];
  submitting: boolean;
  recipientPreviewLoading: boolean;
  recipientPreviewKey: string;
  currentPreviewKey: string;
  recipientsCount: number | null | undefined;
}

export function canSubmitCampaign(params: CanSubmitCampaignParams): boolean {
  const hasCurrentPreview = params.recipientPreviewKey !== '' && params.recipientPreviewKey === params.currentPreviewKey;
  return (
    params.validationErrors.length === 0 &&
    !params.submitting &&
    !params.recipientPreviewLoading &&
    hasCurrentPreview &&
    (params.recipientsCount ?? 0) > 0
  );
}

export function formatRecipientSample(user: { firstName?: string | null; lastName?: string | null; email?: string | null; role: string }): string {
  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || '—';
  const roleLabel = COMMUNICATION_ROLE_SINGULAR_LABELS[user.role as CommunicationTargetRole] ?? user.role;
  return `${name}, ${user.email ?? ''}, ${roleLabel}`;
}

export async function createCommunicationCampaignDraft(input: CreateCommunicationCampaignDraftRequest) {
  const response = await api.post<{ success: boolean; data: CommunicationCampaign }>(
    '/communications/campaigns/draft',
    input,
  );
  return response.data.data;
}

export async function updateCommunicationCampaignDraft(id: number, input: UpdateCommunicationCampaignDraftRequest) {
  const response = await api.patch<{ success: boolean; data: CommunicationCampaign }>(
    `/communications/campaigns/${id}/draft`,
    input,
  );
  return response.data.data;
}

export async function sendCommunicationCampaignDraft(id: number) {
  const response = await api.post<{ success: boolean; data: CommunicationCampaign }>(
    `/communications/campaigns/${id}/send`,
  );
  return response.data.data;
}

export async function scheduleCommunicationCampaign(input: ScheduleCommunicationCampaignRequest) {
  const response = await api.post<{ success: boolean; data: CommunicationCampaign }>(
    '/communications/campaigns/schedule',
    input,
  );
  return response.data.data;
}

export async function updateScheduledCommunicationCampaign(id: number, input: UpdateScheduledCommunicationCampaignRequest) {
  const response = await api.patch<{ success: boolean; data: CommunicationCampaign }>(
    `/communications/campaigns/${id}/schedule`,
    input,
  );
  return response.data.data;
}

export async function cancelScheduledCommunicationCampaign(id: number) {
  const response = await api.post<{ success: boolean; data: CommunicationCampaign }>(
    `/communications/campaigns/${id}/cancel`,
  );
  return response.data.data;
}
