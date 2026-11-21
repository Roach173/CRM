import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Eye, RefreshCw, Search, Send, Users, X, Plus, Trash2, Edit } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import SearchInput from '../../../components/ui/SearchInput';
import { Spinner } from '../../../components/ui/Spinner';
import { Textarea } from '../../../components/ui/Textarea';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, ModalTitle } from '../../../components/ui/Modal';
import {
  COMMUNICATION_CATEGORIES,
  COMMUNICATION_CATEGORY_LABELS,
  COMMUNICATION_CHANNEL_LABELS,
  COMMUNICATION_GROUP_AUDIENCES,
  COMMUNICATION_GROUP_AUDIENCE_LABELS,
  COMMUNICATION_PRIORITIES,
  COMMUNICATION_PRIORITY_LABELS,
  COMMUNICATION_RECIPIENT_STATUS_LABELS,
  COMMUNICATION_ROLE_LABELS,
  COMMUNICATION_STATUS_LABELS,
  COMMUNICATION_TARGET_ROLES,
  COMMUNICATION_TARGET_TYPE_LABELS,
  buildCommunicationRecipientPreviewRequest,
  buildCreateCommunicationCampaignRequest,
  buildCommunicationTargetConfig,
  canSubmitCampaign,
  createCommunicationCampaign,
  formatCommunicationDeliveryRate,
  formatRecipientSample,
  getCommunicationRecipientDisplayName,
  getCommunicationSkippedReasonLabel,
  getCommunicationCampaign,
  listCommunicationCampaignRecipients,
  listCommunicationCampaigns,
  listCommunicationGroups,
  listCommunicationUsers,
  previewCommunicationRecipients,
  validateCommunicationCampaignDraft,
  listCommunicationTemplates,
  createCommunicationTemplate,
  updateCommunicationTemplate,
  archiveCommunicationTemplate,
  createCommunicationCampaignDraft,
  updateCommunicationCampaignDraft,
  sendCommunicationCampaignDraft,
  scheduleCommunicationCampaign,
  updateScheduledCommunicationCampaign,
  cancelScheduledCommunicationCampaign,
} from '../../../lib/communicationsApi';
import type {
  CommunicationCampaign,
  CommunicationCampaignRecipientDeliveryItem,
  CommunicationCampaignRecipientsStats,
  CommunicationRecipientDeliveryStatusFilter,
  CommunicationGroup,
  CommunicationGroupAudience,
  CommunicationRecipientPreview,
  CommunicationTargetRole,
  CommunicationTargetType,
  NotificationPagination,
  NotificationCategory,
  NotificationPriority,
  User,
  CommunicationTemplate,
} from '../../../types';

const PAGE_LIMIT = 20;
const DELIVERY_RECIPIENTS_LIMIT = 25;
const DELIVERY_STATUS_FILTERS: Array<{ value: CommunicationRecipientDeliveryStatusFilter; label: string }> = [
  { value: 'ALL', label: 'Все' },
  { value: 'SENT', label: 'Отправлено' },
  { value: 'SKIPPED', label: 'Пропущено' },
  { value: 'FAILED', label: 'Ошибки' },
  { value: 'PENDING', label: 'Ожидает' },
];

function formatDate(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function userLabel(user?: Pick<User, 'email' | 'firstName' | 'lastName'> | null, fallback?: number) {
  if (!user) return fallback ? `Пользователь #${fallback}` : '—';
  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return name || user.email || (fallback ? `Пользователь #${fallback}` : '—');
}

function statusClass(status: string) {
  if (status === 'SENT') return 'border-[#B8D9C6] bg-[#E7F3EF] text-primary';
  if (status === 'SENDING' || status === 'PENDING') return 'border-[#B8D9C6] bg-[#F0F8F4] text-primary';
  if (status === 'SKIPPED') return 'border-[#F5D59B] bg-[#FFF8E6] text-[#8A5A00]';
  if (status === 'FAILED') return 'border-[#F5C0BC] bg-[#FFF4F4] text-critical';
  if (status === 'CANCELLED') return 'border-borderSubdued bg-surfaceLow text-textSecondary';
  return 'border-border bg-surfaceLow text-textSecondary';
}

function targetLabel(campaign: CommunicationCampaign) {
  if (campaign.targetType === 'ROLES') {
    const roles = (campaign.targetConfig.roles ?? [])
      .map(role => COMMUNICATION_ROLE_LABELS[role])
      .join(', ');
    const label = COMMUNICATION_TARGET_TYPE_LABELS.ROLES ?? 'По ролям';
    return roles ? label + ': ' + roles : label;
  }

  if (campaign.targetType === 'GROUPS') {
    const groupsCount = campaign.targetConfig.groupIds?.length ?? 0;
    const audience = campaign.targetConfig.audience ? COMMUNICATION_GROUP_AUDIENCE_LABELS[campaign.targetConfig.audience] : '';
    const suffix = [groupsCount ? String(groupsCount) + ' групп' : '', audience].filter(Boolean).join(', ');
    const label = COMMUNICATION_TARGET_TYPE_LABELS.GROUPS ?? 'По группам';
    return suffix ? label + ': ' + suffix : label;
  }

  return (COMMUNICATION_TARGET_TYPE_LABELS.USERS ?? 'Выбранные пользователи') + ': ' + (campaign.targetConfig.userIds?.length ?? campaign.recipientsCount);
}

function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { data?: { error?: string } } }).response;
    const backendError = response?.data?.error;
    if (typeof backendError === 'string') {
      if (
        backendError.includes('No recipients found') ||
        backendError.includes('no recipients')
      ) {
        return 'В выбранной аудитории нет получателей';
      }
      return backendError;
    }
  }
  return fallback;
}

function getRecipientNote(recipient: CommunicationCampaignRecipientDeliveryItem) {
  if (recipient.status === 'FAILED' && recipient.error) return recipient.error;
  if (recipient.status === 'SKIPPED') return getCommunicationSkippedReasonLabel(recipient.skippedReason);
  if (recipient.notificationId) return `Уведомление #${recipient.notificationId}`;
  return formatDate(recipient.createdAt);
}

function campaignStatsFromCampaign(campaign: CommunicationCampaign): CommunicationCampaignRecipientsStats {
  return {
    recipientsCount: campaign.recipientsCount,
    sentCount: campaign.sentCount,
    skippedCount: campaign.skippedCount,
    failedCount: campaign.failedCount,
  };
}

export default function CommunicationsPage() {
  const [activeTab, setActiveTab] = useState<'history' | 'scheduled' | 'drafts' | 'templates'>('history');

  const [templates, setTemplates] = useState<CommunicationTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState('');

  // For Template Modal
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<CommunicationTemplate | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [templateTitle, setTemplateTitle] = useState('');
  const [templateBody, setTemplateBody] = useState('');
  const [templateCategory, setTemplateCategory] = useState<NotificationCategory>('ANNOUNCEMENT');
  const [templatePriority, setTemplatePriority] = useState<NotificationPriority>('NORMAL');
  const [templateSubmitting, setTemplateSubmitting] = useState(false);

  const [campaigns, setCampaigns] = useState<CommunicationCampaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [campaignsError, setCampaignsError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [drafts, setDrafts] = useState<CommunicationCampaign[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState('');
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);

  const [scheduled, setScheduled] = useState<CommunicationCampaign[]>([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [scheduledError, setScheduledError] = useState('');
  const [editingScheduledId, setEditingScheduledId] = useState<number | null>(null);
  const [scheduledAtValue, setScheduledAtValue] = useState('');
  const [showScheduler, setShowScheduler] = useState(false);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<NotificationCategory>('ANNOUNCEMENT');
  const [priority, setPriority] = useState<NotificationPriority>('NORMAL');
  const [targetType, setTargetType] = useState<CommunicationTargetType>('ROLES');
  const [roles, setRoles] = useState<CommunicationTargetRole[]>(['STUDENT']);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [selectedUsersById, setSelectedUsersById] = useState<Record<number, User>>({});
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [selectedGroupsById, setSelectedGroupsById] = useState<Record<number, CommunicationGroup>>({});
  const [groupAudience, setGroupAudience] = useState<CommunicationGroupAudience | ''>('STUDENTS');

  const [userRoleFilter, setUserRoleFilter] = useState<CommunicationTargetRole | ''>('STUDENT');
  const [userSearch, setUserSearch] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [groups, setGroups] = useState<CommunicationGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState('');
  const [recipientPreview, setRecipientPreview] = useState<CommunicationRecipientPreview | null>(null);
  const [recipientPreviewKey, setRecipientPreviewKey] = useState('');
  const [recipientPreviewLoading, setRecipientPreviewLoading] = useState(false);
  const [recipientPreviewError, setRecipientPreviewError] = useState('');

  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<CommunicationCampaign | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deliveryRecipients, setDeliveryRecipients] = useState<CommunicationCampaignRecipientDeliveryItem[]>([]);
  const [deliveryPagination, setDeliveryPagination] = useState<NotificationPagination | null>(null);
  const [deliveryStats, setDeliveryStats] = useState<CommunicationCampaignRecipientsStats | null>(null);
  const [deliveryStatusFilter, setDeliveryStatusFilter] = useState<CommunicationRecipientDeliveryStatusFilter>('ALL');
  const [deliverySearch, setDeliverySearch] = useState('');
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryError, setDeliveryError] = useState('');

  const draft = useMemo(() => ({
    title,
    body,
    category,
    priority,
    targetType,
    roles,
    userIds: selectedUserIds,
    groupIds: selectedGroupIds,
    groupAudience,
  }), [body, category, groupAudience, priority, roles, selectedGroupIds, selectedUserIds, targetType, title]);

  const validationErrors = useMemo(() => validateCommunicationCampaignDraft(draft), [draft]);
  const currentPreviewKey = useMemo(() => JSON.stringify(buildCommunicationRecipientPreviewRequest(draft)), [draft]);
  const hasCurrentPreview = recipientPreviewKey === currentPreviewKey && recipientPreview !== null;
  const isPreviewStale = recipientPreviewKey !== '' && recipientPreviewKey !== currentPreviewKey;
  const canSubmit = canSubmitCampaign({
    validationErrors,
    submitting,
    recipientPreviewLoading,
    recipientPreviewKey,
    currentPreviewKey,
    recipientsCount: recipientPreview?.recipientsCount,
  });

  async function loadCampaigns() {
    setCampaignsLoading(true);
    setCampaignsError('');

    try {
      const result = await listCommunicationCampaigns({ page: 1, limit: PAGE_LIMIT });
      setCampaigns(result.items);
    } catch (error) {
      setCampaignsError(getErrorMessage(error, 'Не удалось загрузить кампании'));
    } finally {
      setCampaignsLoading(false);
    }
  }

  async function loadDrafts() {
    setDraftsLoading(true);
    setDraftsError('');
    try {
      const result = await listCommunicationCampaigns({ status: 'DRAFT', page: 1, limit: 100 });
      setDrafts(result.items);
    } catch (error) {
      setDraftsError(getErrorMessage(error, 'Не удалось загрузить черновики'));
    } finally {
      setDraftsLoading(false);
    }
  }

  async function loadScheduled() {
    setScheduledLoading(true);
    setScheduledError('');
    try {
      const result = await listCommunicationCampaigns({ status: 'SCHEDULED', page: 1, limit: 100 });
      setScheduled(result.items);
    } catch (error) {
      setScheduledError(getErrorMessage(error, 'Не удалось загрузить запланированные рассылки'));
    } finally {
      setScheduledLoading(false);
    }
  }

  async function loadTemplates() {
    setTemplatesLoading(true);
    setTemplatesError('');
    try {
      const result = await listCommunicationTemplates({ page: 1, limit: 100 });
      setTemplates(result.items);
    } catch (error) {
      setTemplatesError(getErrorMessage(error, 'Не удалось загрузить шаблоны'));
    } finally {
      setTemplatesLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === 'templates') {
      void loadTemplates();
    } else if (activeTab === 'drafts') {
      void loadDrafts();
    } else if (activeTab === 'scheduled') {
      void loadScheduled();
    }
  }, [activeTab]);

  function openCreateTemplate() {
    setEditingTemplate(null);
    setTemplateName('');
    setTemplateTitle('');
    setTemplateBody('');
    setTemplateCategory('ANNOUNCEMENT');
    setTemplatePriority('NORMAL');
    setIsTemplateModalOpen(true);
  }

  function openEditTemplate(template: CommunicationTemplate) {
    setEditingTemplate(template);
    setTemplateName(template.name);
    setTemplateTitle(template.title);
    setTemplateBody(template.body);
    setTemplateCategory(template.category);
    setTemplatePriority(template.priority);
    setIsTemplateModalOpen(true);
  }

  async function handleSaveTemplate(event: FormEvent) {
    event.preventDefault();
    const name = templateName.trim();
    const title = templateTitle.trim();
    const body = templateBody.trim();

    if (!name) {
      toast.error('Укажите название шаблона');
      return;
    }
    if (!title) {
      toast.error('Укажите заголовок сообщения');
      return;
    }
    if (!body) {
      toast.error('Укажите текст сообщения');
      return;
    }

    setTemplateSubmitting(true);
    try {
      if (editingTemplate) {
        await updateCommunicationTemplate(editingTemplate.id, {
          name,
          title,
          body,
          category: templateCategory,
          priority: templatePriority,
        });
        toast.success('Шаблон изменен');
      } else {
        await createCommunicationTemplate({
          name,
          title,
          body,
          category: templateCategory,
          priority: templatePriority,
        });
        toast.success('Шаблон создан');
      }
      setIsTemplateModalOpen(false);
      void loadTemplates();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Не удалось сохранить шаблон'));
    } finally {
      setTemplateSubmitting(false);
    }
  }

  async function handleArchiveTemplate(templateId: number) {
    if (!window.confirm('Вы действительно хотите архивировать этот шаблон?')) {
      return;
    }

    try {
      await archiveCommunicationTemplate(templateId);
      toast.success('Шаблон архивирован');
      void loadTemplates();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Не удалось архивировать шаблон'));
    }
  }

  function handleApplyTemplate(template: CommunicationTemplate) {
    setTitle(template.title);
    setBody(template.body);
    setCategory(template.category);
    setPriority(template.priority);
    toast.success('Шаблон применен');
  }

  useEffect(() => {
    void loadCampaigns();
  }, []);

  useEffect(() => {
    if (targetType !== 'USERS') return;

    let active = true;
    const timeout = window.setTimeout(async () => {
      setUsersLoading(true);
      setUsersError('');

      try {
        const result = await listCommunicationUsers({
          role: userRoleFilter,
          search: userSearch.trim(),
          limit: 50,
        });
        if (!active) return;
        setUsers(result);
      } catch (error) {
        if (!active) return;
        setUsersError(getErrorMessage(error, 'Не удалось загрузить пользователей'));
      } finally {
        if (active) setUsersLoading(false);
      }
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [targetType, userRoleFilter, userSearch]);

  useEffect(() => {
    if (targetType !== 'GROUPS') return;
    let active = true;
    const timeout = window.setTimeout(async () => {
      setGroupsLoading(true);
      setGroupsError('');
      try {
        const result = await listCommunicationGroups({ search: groupSearch.trim(), status: 'ACTIVE', limit: 50 });
        if (!active) return;
        setGroups(result);
      } catch (error) {
        if (!active) return;
        setGroupsError(getErrorMessage(error, 'Не удалось загрузить группы'));
      } finally {
        if (active) setGroupsLoading(false);
      }
    }, 250);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [groupSearch, targetType]);

  useEffect(() => {
    setRecipientPreviewError('');
  }, [currentPreviewKey]);

  function toggleRole(role: CommunicationTargetRole) {
    setRoles(prev => (
      prev.includes(role)
        ? prev.filter(item => item !== role)
        : [...prev, role]
    ));
  }

  function toggleUser(user: User) {
    setSelectedUsersById(prev => ({ ...prev, [user.id]: user }));
    setSelectedUserIds(prev => (
      prev.includes(user.id)
        ? prev.filter(id => id !== user.id)
        : [...prev, user.id]
    ));
  }

  function clearSelectedUser(userId: number) {
    setSelectedUserIds(prev => prev.filter(id => id !== userId));
  }

  function toggleGroup(group: CommunicationGroup) {
    setSelectedGroupsById(prev => ({ ...prev, [group.id]: group }));
    setSelectedGroupIds(prev => (prev.includes(group.id) ? prev.filter(id => id !== group.id) : [...prev, group.id]));
  }

  function clearSelectedGroup(groupId: number) {
    setSelectedGroupIds(prev => prev.filter(id => id !== groupId));
  }

  async function handlePreviewRecipients() {
    const errors = validateCommunicationCampaignDraft(draft);
    if (errors.length) { toast.error(errors[0]); return; }
    setRecipientPreviewLoading(true);
    setRecipientPreviewError('');
    try {
      const request = buildCommunicationRecipientPreviewRequest(draft);
      const preview = await previewCommunicationRecipients(request);
      setRecipientPreview(preview);
      setRecipientPreviewKey(JSON.stringify(request));
    } catch (error) {
      setRecipientPreview(null);
      setRecipientPreviewKey('');
      setRecipientPreviewError(getErrorMessage(error, 'Не удалось посчитать получателей'));
    } finally {
      setRecipientPreviewLoading(false);
    }
  }

  function handleResetForm() {
    setTitle('');
    setBody('');
    setCategory('ANNOUNCEMENT');
    setPriority('NORMAL');
    setTargetType('ROLES');
    setRoles(['STUDENT']);
    setSelectedUserIds([]);
    setSelectedUsersById({});
    setSelectedGroupIds([]);
    setSelectedGroupsById({});
    setGroupSearch('');
    setGroupAudience('STUDENTS');
    setRecipientPreview(null);
    setRecipientPreviewKey('');
    setRecipientPreviewError('');
    setUserSearch('');
    setEditingDraftId(null);
    setEditingScheduledId(null);
    setScheduledAtValue('');
    setShowScheduler(false);
  }

  function handleOpenScheduled(campaign: CommunicationCampaign) {
    handleResetForm();
    setEditingScheduledId(campaign.id);
    setTitle(campaign.title);
    setBody(campaign.body);
    setCategory(campaign.category);
    setPriority(campaign.priority);
    setTargetType(campaign.targetType);

    const config = campaign.targetConfig;
    if (campaign.targetType === 'ROLES') {
      setRoles(config.roles ?? []);
    } else if (campaign.targetType === 'USERS') {
      setSelectedUserIds(config.userIds ?? []);
      const mappedUsers: Record<number, User> = {};
      if (campaign.recipients) {
        campaign.recipients.forEach(r => {
          if (r.user) {
            mappedUsers[r.userId] = {
              id: r.userId,
              email: r.user.email ?? '',
              firstName: r.user.firstName ?? '',
              lastName: r.user.lastName ?? '',
              role: r.user.role as any,
              schoolId: campaign.schoolId,
            };
          }
        });
      }
      setSelectedUsersById(mappedUsers);
    } else if (campaign.targetType === 'GROUPS') {
      setSelectedGroupIds(config.groupIds ?? []);
      setGroupAudience(config.audience ?? 'STUDENTS');
    }

    if (campaign.scheduledAt) {
      const date = new Date(campaign.scheduledAt);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      setScheduledAtValue(`${year}-${month}-${day}T${hours}:${minutes}`);
    } else {
      setScheduledAtValue('');
    }
    setShowScheduler(true);
    toast.success('Запланированная рассылка открыта для редактирования');
  }

  async function handleCancelScheduled(campaignId: number) {
    if (!window.confirm('Вы действительно хотите отменить запланированную рассылку?')) {
      return;
    }

    try {
      await cancelScheduledCommunicationCampaign(campaignId);
      toast.success('Запланированная рассылка отменена');
      void loadScheduled();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Не удалось отменить рассылку'));
    }
  }

  async function handleScheduleSubmit() {
    const errors = validateCommunicationCampaignDraft(draft);
    if (errors.length) {
      toast.error(errors[0]);
      return;
    }
    if (!scheduledAtValue) {
      toast.error('Укажите дату и время отправки');
      return;
    }
    const scheduledAtDate = new Date(scheduledAtValue);
    if (scheduledAtDate.getTime() <= Date.now()) {
      toast.error('Время отправки должно быть в будущем');
      return;
    }
    if (!recipientPreviewKey) {
      toast.error('Сначала посчитайте получателей');
      return;
    }
    if (isPreviewStale) {
      toast.error('Получатели изменились — пересчитайте перед отправкой');
      return;
    }
    if ((recipientPreview?.recipientsCount ?? 0) === 0) {
      toast.error('Получатели не найдены');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        title: title.trim(),
        body: body.trim(),
        category,
        priority,
        channel: 'IN_APP' as const,
        targetType,
        targetConfig: buildCommunicationTargetConfig(draft),
        scheduledAt: scheduledAtDate.toISOString(),
      };

      if (editingScheduledId) {
        await updateScheduledCommunicationCampaign(editingScheduledId, payload);
        toast.success('Запланированная рассылка обновлена');
      } else {
        await scheduleCommunicationCampaign(payload);
        toast.success('Рассылка запланирована');
      }

      handleResetForm();
      setActiveTab('scheduled');
      void loadScheduled();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Не удалось запланировать рассылку'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveDraft() {
    const t = title.trim();
    const b = body.trim();
    if (!t) {
      toast.error('Укажите заголовок черновика');
      return;
    }
    if (!b) {
      toast.error('Укажите текст черновика');
      return;
    }

    setSubmitting(true);
    try {
      const draftPayload = {
        title: t,
        body: b,
        category,
        priority,
        channel: 'IN_APP' as const,
        targetType,
        targetConfig: buildCommunicationTargetConfig(draft),
      };

      if (editingDraftId) {
        await updateCommunicationCampaignDraft(editingDraftId, draftPayload);
        toast.success('Черновик обновлен');
      } else {
        const created = await createCommunicationCampaignDraft(draftPayload);
        setEditingDraftId(created.id);
        toast.success('Черновик сохранен');
      }

      void loadDrafts();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Не удалось сохранить черновик'));
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenDraft(campaign: CommunicationCampaign) {
    handleResetForm();
    setEditingDraftId(campaign.id);
    setTitle(campaign.title);
    setBody(campaign.body);
    setCategory(campaign.category);
    setPriority(campaign.priority);
    setTargetType(campaign.targetType);

    const config = campaign.targetConfig;
    if (campaign.targetType === 'ROLES') {
      setRoles(config.roles ?? []);
    } else if (campaign.targetType === 'USERS') {
      setSelectedUserIds(config.userIds ?? []);
      const mappedUsers: Record<number, User> = {};
      if (campaign.recipients) {
        campaign.recipients.forEach(r => {
          if (r.user) {
            mappedUsers[r.userId] = {
              id: r.userId,
              email: r.user.email ?? '',
              firstName: r.user.firstName ?? '',
              lastName: r.user.lastName ?? '',
              role: r.user.role as any,
              schoolId: campaign.schoolId,
            };
          }
        });
      }
      setSelectedUsersById(mappedUsers);
    } else if (campaign.targetType === 'GROUPS') {
      setSelectedGroupIds(config.groupIds ?? []);
      setGroupAudience(config.audience ?? 'STUDENTS');
    }

    toast.success('Черновик открыт для редактирования');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validateCommunicationCampaignDraft(draft);
    if (errors.length) {
      toast.error(errors[0]);
      return;
    }
    if (!recipientPreviewKey) {
      toast.error('Сначала посчитайте получателей');
      return;
    }
    if (isPreviewStale) {
      toast.error('Получатели изменились — пересчитайте перед отправкой');
      return;
    }
    if ((recipientPreview?.recipientsCount ?? 0) === 0) {
      toast.error('Получатели не найдены');
      return;
    }

    setSubmitting(true);
    try {
      let created;
      if (editingDraftId) {
        await updateCommunicationCampaignDraft(editingDraftId, {
          title: title.trim(),
          body: body.trim(),
          category,
          priority,
          targetType,
          targetConfig: buildCommunicationTargetConfig(draft),
        });
        created = await sendCommunicationCampaignDraft(editingDraftId);
      } else {
        created = await createCommunicationCampaign(buildCreateCommunicationCampaignRequest(draft));
      }

      toast.success(editingDraftId ? 'Черновик отправлен' : 'Кампания отправлена');
      handleResetForm();
      setSelectedCampaignId(created.id);
      setSelectedCampaign(created);
      setDeliveryRecipients([]);
      setDeliveryPagination(null);
      setDeliveryStats(campaignStatsFromCampaign(created));
      setDeliveryStatusFilter('ALL');
      setDeliverySearch('');
      setDeliveryError('');
      setActiveTab('history');
      await loadCampaigns();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Не удалось отправить кампанию'));
    } finally {
      setSubmitting(false);
    }
  }

  const loadDeliveryRecipients = useCallback(async (campaignId: number, page = 1, append = false) => {
    setDeliveryLoading(true);
    setDeliveryError('');
    if (!append) {
      setDeliveryRecipients([]);
      setDeliveryPagination(null);
    }

    try {
      const result = await listCommunicationCampaignRecipients(campaignId, {
        status: deliveryStatusFilter,
        search: deliverySearch.trim() || undefined,
        page,
        limit: DELIVERY_RECIPIENTS_LIMIT,
      });

      setDeliveryRecipients(current => append ? [...current, ...result.items] : result.items);
      setDeliveryPagination(result.pagination);
      setDeliveryStats(result.stats);
    } catch (error) {
      setDeliveryError(getErrorMessage(error, 'Не удалось загрузить получателей'));
      if (!append) {
        setDeliveryRecipients([]);
        setDeliveryPagination(null);
      }
    } finally {
      setDeliveryLoading(false);
    }
  }, [deliverySearch, deliveryStatusFilter]);

  async function openCampaign(campaign: CommunicationCampaign) {
    setSelectedCampaignId(campaign.id);
    setDetailLoading(true);
    setSelectedCampaign(campaign);
    setDeliveryRecipients([]);
    setDeliveryPagination(null);
    setDeliveryStats(campaignStatsFromCampaign(campaign));
    setDeliveryStatusFilter('ALL');
    setDeliverySearch('');
    setDeliveryError('');

    try {
      const detail = await getCommunicationCampaign(campaign.id);
      setSelectedCampaign(detail);
      setDeliveryStats(campaignStatsFromCampaign(detail));
    } catch (error) {
      toast.error(getErrorMessage(error, 'Не удалось открыть кампанию'));
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedCampaignId || activeTab !== 'history') return;
    void loadDeliveryRecipients(selectedCampaignId, 1, false);
  }, [activeTab, loadDeliveryRecipients, selectedCampaignId]);

  const selectedDeliveryStats = useMemo(() => {
    if (!selectedCampaign) return null;
    return deliveryStats ?? campaignStatsFromCampaign(selectedCampaign);
  }, [deliveryStats, selectedCampaign]);
  const deliveryRates = selectedDeliveryStats
    ? {
        sent: formatCommunicationDeliveryRate(selectedDeliveryStats.sentCount, selectedDeliveryStats.recipientsCount),
        skipped: formatCommunicationDeliveryRate(selectedDeliveryStats.skippedCount, selectedDeliveryStats.recipientsCount),
        failed: formatCommunicationDeliveryRate(selectedDeliveryStats.failedCount, selectedDeliveryStats.recipientsCount),
      }
    : { sent: '0%', skipped: '0%', failed: '0%' };
  const hasDeliveryFilter = deliveryStatusFilter !== 'ALL' || deliverySearch.trim() !== '';

  const selectedUsers = useMemo(() => {
    return selectedUserIds.map(id => {
      return selectedUsersById[id] || {
        id,
        email: '',
        firstName: 'Пользователь',
        lastName: `#${id}`,
        role: 'STUDENT',
        schoolId: 0,
      };
    });
  }, [selectedUserIds, selectedUsersById]);

  const selectedGroups = useMemo(() => {
    return selectedGroupIds.map(id => {
      return selectedGroupsById[id] || {
        id,
        name: `Группа #${id}`,
        level: '',
        status: 'ACTIVE',
      };
    });
  }, [selectedGroupIds, selectedGroupsById]);
  const previewAudience = targetType === 'ROLES'
    ? roles.map(role => COMMUNICATION_ROLE_LABELS[role]).join(', ')
    : targetType === 'GROUPS'
      ? [selectedGroups.length ? selectedGroups.map(group => group.level).join(', ') : String(selectedGroupIds.length) + ' групп', groupAudience ? COMMUNICATION_GROUP_AUDIENCE_LABELS[groupAudience] : ''].filter(Boolean).join(' / ')
      : selectedUsers.length
        ? selectedUsers.map(user => userLabel(user)).join(', ')
        : String(selectedUserIds.length) + ' пользователей';

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Send className="h-5 w-5" />
          </div>
          <h1 className="font-serif text-2xl text-textPrimary">Коммуникации</h1>
          <p className="mt-2 text-sm text-textSecondary">In-app кампании для школьных объявлений</p>
        </div>

        <Button type="button" variant="outline" onClick={() => void loadCampaigns()} disabled={campaignsLoading}>
          <RefreshCw className={`h-4 w-4 ${campaignsLoading ? 'animate-spin' : ''}`} />
          Обновить
        </Button>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,480px)_minmax(0,1fr)]">
        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
            <h2 className="text-base font-bold text-textPrimary">
              {editingScheduledId ? 'Редактирование рассылки' : editingDraftId ? 'Редактирование черновика' : 'Новая кампания'}
            </h2>
            <span className="rounded-sm border border-border bg-surfaceLow px-2 py-1 text-xs font-bold text-textSecondary">
              Внутри CRM
            </span>
          </div>

          {editingDraftId && (
            <div className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary font-medium">
              <span>Редактируемый черновик #{editingDraftId}</span>
              <button
                type="button"
                onClick={handleResetForm}
                className="text-xs font-bold text-primary hover:underline"
              >
                Сбросить
              </button>
            </div>
          )}

          {editingScheduledId && (
            <div className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary font-medium">
              <span>Редактирование запланированной рассылки #{editingScheduledId}</span>
              <button
                type="button"
                onClick={handleResetForm}
                className="text-xs font-bold text-primary hover:underline"
              >
                Сбросить
              </button>
            </div>
          )}

          <Input
            label="Заголовок"
            value={title}
            maxLength={120}
            onChange={event => setTitle(event.target.value)}
          />

          <Textarea
            label="Текст"
            value={body}
            rows={5}
            onChange={event => setBody(event.target.value)}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-semibold text-textPrimary">
              Категория
              <select
                value={category}
                onChange={event => setCategory(event.target.value as NotificationCategory)}
                className="h-11 w-full rounded-sm border border-border bg-white px-3 text-sm font-medium text-textPrimary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                {COMMUNICATION_CATEGORIES.map(item => (
                  <option key={item} value={item}>{COMMUNICATION_CATEGORY_LABELS[item] ?? item}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5 text-sm font-semibold text-textPrimary">
              Приоритет
              <select
                value={priority}
                onChange={event => setPriority(event.target.value as NotificationPriority)}
                className="h-11 w-full rounded-sm border border-border bg-white px-3 text-sm font-medium text-textPrimary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                {COMMUNICATION_PRIORITIES.map(item => (
                  <option key={item} value={item}>{COMMUNICATION_PRIORITY_LABELS[item] ?? item}</option>
                ))}
              </select>
            </label>
          </div>

          {priority === 'CRITICAL' && (
            <div className="flex items-start gap-2 rounded-lg border border-[#F5D59B] bg-[#FFF8E6] px-3 py-2 text-sm font-medium text-[#8A5A00]">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              Критические уведомления обходят пользовательские настройки.
            </div>
          )}

          <div className="space-y-3">
            <div className="grid grid-cols-3 rounded-lg border border-border bg-surfaceLow p-1">
              {(['ROLES', 'USERS', 'GROUPS'] as CommunicationTargetType[]).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setTargetType(type)}
                  className={`flex h-10 items-center justify-center gap-2 rounded-md text-sm font-bold transition-colors ${
                    targetType === type ? 'bg-white text-primary shadow-sm' : 'text-textSecondary hover:text-textPrimary'
                  }`}
                >
                  <Users className="h-4 w-4" />
                  {COMMUNICATION_TARGET_TYPE_LABELS[type] ?? type}
                </button>
              ))}
            </div>

            {targetType === 'ROLES' ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {COMMUNICATION_TARGET_ROLES.map(role => (
                  <label
                    key={role}
                    className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                      roles.includes(role)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-white text-textPrimary hover:border-borderSubdued'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={roles.includes(role)}
                      onChange={() => toggleRole(role)}
                      className="h-4 w-4 accent-primary"
                    />
                    {COMMUNICATION_ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
            ) : targetType === 'USERS' ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                  <label className="space-y-1.5 text-sm font-semibold text-textPrimary">
                    Роль
                    <select
                      value={userRoleFilter}
                      onChange={event => setUserRoleFilter(event.target.value as CommunicationTargetRole | '')}
                      className="h-11 w-full rounded-sm border border-border bg-white px-3 text-sm font-medium text-textPrimary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    >
                      <option value="">Все</option>
                      {COMMUNICATION_TARGET_ROLES.map(role => (
                        <option key={role} value={role}>{COMMUNICATION_ROLE_LABELS[role]}</option>
                      ))}
                    </select>
                  </label>

                  <Input
                    label="Поиск"
                    value={userSearch}
                    onChange={event => setUserSearch(event.target.value)}
                    prefix={<Search className="h-4 w-4" />}
                  />
                </div>

                {selectedUsers.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {selectedUsers.map(user => (
                      <button
                        key={user.id}
                        type="button"
                        onClick={() => clearSelectedUser(user.id)}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-bold text-primary"
                      >
                        <span className="truncate">{userLabel(user)}</span>
                        <X className="h-3 w-3 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                  {usersLoading ? (
                    <div className="flex min-h-28 items-center justify-center">
                      <Spinner />
                    </div>
                  ) : usersError ? (
                    <div className="flex items-center gap-2 p-3 text-sm font-medium text-critical">
                      <AlertCircle className="h-4 w-4" />
                      {usersError}
                    </div>
                  ) : users.length === 0 ? (
                    <div className="p-3 text-sm text-textSecondary">Пользователи не найдены</div>
                  ) : (
                    users.map(user => (
                      <label
                        key={user.id}
                        className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surfaceLow"
                      >
                        <input
                          type="checkbox"
                          checked={selectedUserIds.includes(user.id)}
                          onChange={() => toggleUser(user)}
                          className="h-4 w-4 accent-primary"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-textPrimary">{userLabel(user)}</span>
                          <span className="block truncate text-xs text-textSecondary">{user.email}</span>
                        </span>
                        <span className="flex-shrink-0 text-xs font-bold text-textSecondary">
                          {COMMUNICATION_ROLE_LABELS[user.role as CommunicationTargetRole] ?? user.role}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Input label="Поиск групп" value={groupSearch} onChange={event => setGroupSearch(event.target.value)} prefix={<Search className="h-4 w-4" />} />
                <label className="space-y-1.5 text-sm font-semibold text-textPrimary">Аудитория<select value={groupAudience} onChange={event => setGroupAudience(event.target.value as CommunicationGroupAudience)} className="h-11 w-full rounded-sm border border-border bg-white px-3 text-sm font-medium text-textPrimary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20">{COMMUNICATION_GROUP_AUDIENCES.map(audience => (<option key={audience} value={audience}>{COMMUNICATION_GROUP_AUDIENCE_LABELS[audience]}</option>))}</select></label>
                {selectedGroups.length > 0 && (<div className="flex flex-wrap gap-2">{selectedGroups.map(group => (<button key={group.id} type="button" onClick={() => clearSelectedGroup(group.id)} className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-bold text-primary"><span className="truncate">{group.level}</span><X className="h-3 w-3 flex-shrink-0" /></button>))}</div>)}
                <div className="max-h-64 overflow-y-auto rounded-lg border border-border">{groupsLoading ? (<div className="flex min-h-28 items-center justify-center"><Spinner /></div>) : groupsError ? (<div className="flex items-center gap-2 p-3 text-sm font-medium text-critical"><AlertCircle className="h-4 w-4" />{groupsError}</div>) : groups.length === 0 ? (<div className="p-3 text-sm text-textSecondary">Группы не найдены</div>) : (groups.map(group => (<label key={group.id} className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surfaceLow"><input type="checkbox" checked={selectedGroupIds.includes(group.id)} onChange={() => toggleGroup(group)} className="h-4 w-4 accent-primary" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-textPrimary">{group.level}</span><span className="block truncate text-xs text-textSecondary">{group.level}</span></span><span className="flex-shrink-0 text-xs font-bold text-textSecondary">{group.status}</span></label>)))}</div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-surfaceLow p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-textSecondary">
              <CheckCircle2 className="h-4 w-4" />
              Предпросмотр
            </div>
            <h3 className="line-clamp-2 text-sm font-bold text-textPrimary">{title.trim() || 'Заголовок'}</h3>
            <p className="mt-1 line-clamp-4 whitespace-pre-line text-sm text-textSecondary">{body.trim() || 'Текст сообщения'}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-textSecondary">
              <span>{COMMUNICATION_CATEGORY_LABELS[category] ?? category}</span>
              <span>{COMMUNICATION_PRIORITY_LABELS[priority] ?? priority}</span>
              <span className="truncate">{previewAudience || 'Получатели'}</span>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-white p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-textSecondary">
                  Получатели
                </div>
                {recipientPreviewKey === '' ? (
                  <div className="mt-1 text-sm text-textSecondary">
                    Проверьте получателей перед отправкой
                  </div>
                ) : isPreviewStale ? (
                  <div className="mt-1 text-sm font-semibold text-[#8A5A00]">
                    Получатели изменились — пересчитайте перед отправкой
                  </div>
                ) : recipientPreview ? (
                  recipientPreview.recipientsCount === 0 ? (
                    <div className="mt-1 text-sm font-semibold text-critical">
                      Получатели не найдены
                    </div>
                  ) : (
                    <div className="mt-1 text-sm font-semibold text-primary">
                      Найдено получателей: {recipientPreview.recipientsCount}
                    </div>
                  )
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handlePreviewRecipients()}
                isLoading={recipientPreviewLoading}
                disabled={recipientPreviewLoading || validationErrors.length > 0}
              >
                <Users className="h-4 w-4" />
                Посчитать получателей
              </Button>
            </div>

            {recipientPreviewError && (
              <div className="mt-3 rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-3 py-2 text-sm font-medium text-critical">
                {recipientPreviewError}
              </div>
            )}

            {hasCurrentPreview && recipientPreview?.sample && recipientPreview.sample.length > 0 && (
              <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                <div className="text-xs font-semibold text-textSecondary">
                  Первые получатели:
                </div>
                <ul className="space-y-1 text-xs text-textPrimary">
                  {recipientPreview.sample.map(sampleUser => (
                    <li key={sampleUser.id} className="truncate">
                      {formatRecipientSample(sampleUser)}
                    </li>
                  ))}
                </ul>
                {recipientPreview.recipientsCount > recipientPreview.sample.length && (
                  <div className="text-xs text-textSecondary italic">
                    и ещё {recipientPreview.recipientsCount - recipientPreview.sample.length} получателей
                  </div>
                )}
              </div>
            )}
          </div>

          {validationErrors.length > 0 && (
            <div className="rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-3 py-2 text-sm font-medium text-critical">
              {validationErrors[0]}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {editingScheduledId ? (
              <div className="space-y-3">
                <div className="space-y-2 rounded-lg border border-border bg-surfaceLow p-3">
                  <label className="block text-sm font-semibold text-textPrimary">
                    Дата и время отправки
                    <input
                      type="datetime-local"
                      value={scheduledAtValue}
                      onChange={e => setScheduledAtValue(e.target.value)}
                      className="mt-1.5 h-11 w-full rounded-sm border border-border bg-white px-3 text-sm font-medium text-textPrimary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </label>
                  <p className="text-xs text-textSecondary">
                    Получатели будут пересчитаны в момент отправки. Время указано по вашему локальному часовому поясу.
                  </p>
                </div>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    fullWidth
                    onClick={handleResetForm}
                    disabled={submitting}
                  >
                    Сбросить
                  </Button>
                  <Button
                    type="button"
                    fullWidth
                    isLoading={submitting}
                    disabled={submitting || !canSubmit}
                    onClick={() => void handleScheduleSubmit()}
                  >
                    Сохранить изменения
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    fullWidth
                    onClick={() => void handleSaveDraft()}
                    disabled={submitting || !!editingDraftId}
                  >
                    Сохранить черновик
                  </Button>
                  <Button
                    type="submit"
                    fullWidth
                    isLoading={submitting}
                    disabled={!canSubmit}
                  >
                    <Send className="h-4 w-4" />
                    {submitting ? 'Отправляем...' : 'Отправить'}
                  </Button>
                </div>

                <div className="border-t border-border pt-3">
                  {showScheduler ? (
                    <div className="space-y-3 rounded-lg border border-border bg-surfaceLow p-3">
                      <label className="block text-sm font-semibold text-textPrimary">
                        Дата и время отправки
                        <input
                          type="datetime-local"
                          value={scheduledAtValue}
                          onChange={e => setScheduledAtValue(e.target.value)}
                          className="mt-1.5 h-11 w-full rounded-sm border border-border bg-white px-3 text-sm font-medium text-textPrimary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      </label>
                      <p className="text-xs text-textSecondary">
                        Получатели будут пересчитаны в момент отправки. Время указано по вашему локальному часовому поясу.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          fullWidth
                          onClick={() => {
                            setShowScheduler(false);
                            setScheduledAtValue('');
                          }}
                        >
                          Отмена
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          fullWidth
                          disabled={submitting || !canSubmit}
                          onClick={() => void handleScheduleSubmit()}
                        >
                          Запланировать
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      fullWidth
                      onClick={() => setShowScheduler(true)}
                    >
                      Запланировать на будущее...
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </form>

        <div className="space-y-4">
          <div className="flex border-b border-border bg-white rounded-lg p-1 shadow-sm">
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-2 text-center text-sm font-bold rounded-md transition ${
                activeTab === 'history'
                  ? 'bg-primary/10 text-primary'
                  : 'text-textSecondary hover:text-textPrimary'
              }`}
            >
              История
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('scheduled')}
              className={`flex-1 py-2 text-center text-sm font-bold rounded-md transition ${
                activeTab === 'scheduled'
                  ? 'bg-primary/10 text-primary'
                  : 'text-textSecondary hover:text-textPrimary'
              }`}
            >
              Запланированные
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('drafts')}
              className={`flex-1 py-2 text-center text-sm font-bold rounded-md transition ${
                activeTab === 'drafts'
                  ? 'bg-primary/10 text-primary'
                  : 'text-textSecondary hover:text-textPrimary'
              }`}
            >
              Черновики
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('templates')}
              className={`flex-1 py-2 text-center text-sm font-bold rounded-md transition ${
                activeTab === 'templates'
                  ? 'bg-primary/10 text-primary'
                  : 'text-textSecondary hover:text-textPrimary'
              }`}
            >
              Шаблоны
            </button>
          </div>

          {activeTab === 'history' && (
            <section className="rounded-lg border border-border bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-base font-bold text-textPrimary">История кампаний</h2>
                <span className="text-sm font-semibold text-textSecondary">{campaigns.length}</span>
              </div>

              {campaignsLoading ? (
                <div className="flex min-h-64 items-center justify-center">
                  <Spinner />
                </div>
              ) : campaignsError ? (
                <div className="m-4 flex items-center gap-2 rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-3 py-2 text-sm font-medium text-critical">
                  <AlertCircle className="h-4 w-4" />
                  {campaignsError}
                </div>
              ) : campaigns.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm leading-6 text-textSecondary">
                  Рассылок пока нет. Создайте первое объявление для учеников, родителей или преподавателей.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[780px] text-left">
                    <thead className="border-b border-border bg-surfaceLow text-xs font-bold uppercase tracking-wider text-textSecondary">
                      <tr>
                        <th className="px-4 py-3">Кампания</th>
                        <th className="px-4 py-3">Статус</th>
                        <th className="px-4 py-3">Получатели</th>
                        <th className="px-4 py-3">Счетчики</th>
                        <th className="px-4 py-3">Даты</th>
                        <th className="px-4 py-3 text-right">Открыть</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {campaigns.map(campaign => (
                        <tr key={campaign.id} className={selectedCampaignId === campaign.id ? 'bg-primary/5' : 'bg-white'}>
                          <td className="px-4 py-3">
                            <div className="max-w-xs">
                              <p className="truncate text-sm font-bold text-textPrimary">{campaign.title}</p>
                              <p className="mt-1 text-xs text-textSecondary">
                                {COMMUNICATION_CATEGORY_LABELS[campaign.category] ?? campaign.category}
                                {' · '}
                                {COMMUNICATION_PRIORITY_LABELS[campaign.priority] ?? campaign.priority}
                              </p>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-bold ${statusClass(campaign.status)}`}>
                              {COMMUNICATION_STATUS_LABELS[campaign.status] ?? campaign.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-textSecondary">{targetLabel(campaign)}</td>
                          <td className="px-4 py-3 text-sm font-semibold text-textPrimary">
                            Отправлено {campaign.sentCount} из {campaign.recipientsCount}
                            <span className="mt-1 block text-xs text-textSecondary">
                              Пропущено {campaign.skippedCount} · Ошибки {campaign.failedCount}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-textSecondary">
                            <div>Создано: {formatDate(campaign.createdAt)}</div>
                            <div className="text-xs">Отправлено: {formatDate(campaign.sentAt)}</div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button type="button" size="sm" variant="outline" onClick={() => void openCampaign(campaign)}>
                              <Eye className="h-4 w-4" />
                              Детали
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {activeTab === 'history' && selectedCampaign && (
            <section className="rounded-lg border border-border bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-bold text-textPrimary">{selectedCampaign.title}</h2>
                  <p className="mt-1 text-sm text-textSecondary">{targetLabel(selectedCampaign)}</p>
                </div>
                <span className={`inline-flex w-fit rounded-full border px-2 py-1 text-xs font-bold ${statusClass(selectedCampaign.status)}`}>
                  {COMMUNICATION_STATUS_LABELS[selectedCampaign.status] ?? selectedCampaign.status}
                </span>
              </div>

              <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-4">
                <Counter label="Всего" value={selectedDeliveryStats?.recipientsCount ?? selectedCampaign.recipientsCount} detail="получателей" />
                <Counter label="Отправлено" value={selectedDeliveryStats?.sentCount ?? selectedCampaign.sentCount} detail={deliveryRates.sent} />
                <Counter label="Пропущено" value={selectedDeliveryStats?.skippedCount ?? selectedCampaign.skippedCount} detail={deliveryRates.skipped} />
                <Counter label="Ошибки" value={selectedDeliveryStats?.failedCount ?? selectedCampaign.failedCount} detail={deliveryRates.failed} />
              </div>

              <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-2 lg:grid-cols-5">
                <MetaItem label="Категория" value={COMMUNICATION_CATEGORY_LABELS[selectedCampaign.category] ?? selectedCampaign.category} />
                <MetaItem label="Приоритет" value={COMMUNICATION_PRIORITY_LABELS[selectedCampaign.priority] ?? selectedCampaign.priority} />
                <MetaItem label="Канал" value={COMMUNICATION_CHANNEL_LABELS[selectedCampaign.channel] ?? selectedCampaign.channel} />
                <MetaItem label="Создано" value={formatDate(selectedCampaign.createdAt)} />
                <MetaItem label="Отправлено" value={formatDate(selectedCampaign.sentAt)} />
              </div>

              <div className="p-4">
                <p className="whitespace-pre-line rounded-lg border border-border bg-surfaceLow p-3 text-sm leading-6 text-textPrimary">
                  {selectedCampaign.body}
                </p>
              </div>

              <div className="border-t border-border">
                <div className="space-y-3 px-4 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h3 className="text-sm font-bold text-textPrimary">Получатели</h3>
                    {(detailLoading || deliveryLoading) && <Spinner />}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {DELIVERY_STATUS_FILTERS.map(filter => (
                      <button
                        key={filter.value}
                        type="button"
                        onClick={() => setDeliveryStatusFilter(filter.value)}
                        className={`rounded-sm border px-3 py-1.5 text-xs font-bold transition-colors ${
                          deliveryStatusFilter === filter.value
                            ? 'border-primary bg-primary text-white'
                            : 'border-border bg-white text-textSecondary hover:border-primary hover:text-primary'
                        }`}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>

                  <SearchInput
                    value={deliverySearch}
                    onChange={setDeliverySearch}
                    placeholder="Поиск по имени или email"
                    className="max-w-2xl"
                  />

                  {deliveryError && (
                    <div className="flex flex-col gap-2 rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-3 py-2 text-sm font-medium text-critical sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-2">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 break-words">{deliveryError}</span>
                      </div>
                      {selectedCampaignId && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void loadDeliveryRecipients(selectedCampaignId, 1, false)}
                          disabled={deliveryLoading}
                        >
                          Повторить
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                <div className="max-h-80 overflow-y-auto">
                  {deliveryLoading && deliveryRecipients.length === 0 ? (
                    <div className="flex min-h-28 items-center justify-center">
                      <Spinner />
                    </div>
                  ) : deliveryRecipients.length > 0 ? (
                    deliveryRecipients.map(recipient => (
                      <DeliveryRecipientRow key={recipient.id} recipient={recipient} />
                    ))
                  ) : (
                    <div className="px-4 py-6 text-sm text-textSecondary">
                      {hasDeliveryFilter ? 'По этому фильтру получателей нет' : 'Получатели не найдены'}
                    </div>
                  )}
                </div>

                {deliveryPagination?.hasNextPage && (
                  <div className="border-t border-border px-4 py-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => selectedCampaignId && void loadDeliveryRecipients(selectedCampaignId, deliveryPagination.page + 1, true)}
                      disabled={deliveryLoading}
                    >
                      {deliveryLoading ? <Spinner /> : null}
                      Загрузить ещё
                    </Button>
                  </div>
                )}
              </div>
            </section>
          )}

          {activeTab === 'scheduled' && (
            <section className="rounded-lg border border-border bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-base font-bold text-textPrimary">Запланированные рассылки</h2>
                <span className="text-sm font-semibold text-textSecondary">{scheduled.length}</span>
              </div>

              {scheduledLoading ? (
                <div className="flex min-h-64 items-center justify-center">
                  <Spinner />
                </div>
              ) : scheduledError ? (
                <div className="m-4 flex items-center gap-2 rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-3 py-2 text-sm font-medium text-critical">
                  <AlertCircle className="h-4 w-4" />
                  {scheduledError}
                </div>
              ) : scheduled.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm leading-6 text-textSecondary">
                  Запланированных рассылок пока нет. Выберите дату отправки и сохраните рассылку на будущее.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {scheduled.map(campaign => (
                    <div key={campaign.id} className="p-4 hover:bg-surfaceLow transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-bold text-textPrimary text-sm truncate">{campaign.title}</h3>
                          <p className="mt-2 text-sm text-textSecondary line-clamp-2 leading-relaxed">
                            {campaign.body}
                          </p>
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-bold text-textSecondary">
                            <span className="rounded-full bg-surfaceMedium px-2 py-0.5">
                              {COMMUNICATION_CATEGORY_LABELS[campaign.category] ?? campaign.category}
                            </span>
                            <span className={`rounded-full px-2 py-0.5 ${
                              campaign.priority === 'CRITICAL' ? 'bg-[#FFF4F4] text-critical' :
                              campaign.priority === 'HIGH' ? 'bg-[#FFF8E6] text-[#8A5A00]' :
                              'bg-surfaceMedium'
                            }`}>
                              {COMMUNICATION_PRIORITY_LABELS[campaign.priority] ?? campaign.priority}
                            </span>
                            <span className="rounded-full bg-surfaceMedium px-2 py-0.5">
                              {targetLabel(campaign)}
                            </span>
                            <span>·</span>
                            <span className="text-primary font-semibold">
                              Отправка: {campaign.scheduledAt ? formatDate(campaign.scheduledAt) : '—'}
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-shrink-0">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => handleOpenScheduled(campaign)}
                            className="bg-primary/10 hover:bg-primary/20 text-primary border-none shadow-none font-bold"
                          >
                            Открыть
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleCancelScheduled(campaign.id)}
                            className="text-critical border-critical/30 hover:bg-critical/5 font-bold"
                          >
                            Отменить
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeTab === 'drafts' && (
            <section className="rounded-lg border border-border bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-base font-bold text-textPrimary">Черновики рассылок</h2>
                <span className="text-sm font-semibold text-textSecondary">{drafts.length}</span>
              </div>

              {draftsLoading ? (
                <div className="flex min-h-64 items-center justify-center">
                  <Spinner />
                </div>
              ) : draftsError ? (
                <div className="m-4 flex items-center gap-2 rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-3 py-2 text-sm font-medium text-critical">
                  <AlertCircle className="h-4 w-4" />
                  {draftsError}
                </div>
              ) : drafts.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm leading-6 text-textSecondary">
                  Черновиков пока нет. Сохраните рассылку как черновик, чтобы вернуться к ней позже.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {drafts.map(campaign => (
                    <div key={campaign.id} className="p-4 hover:bg-surfaceLow transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-bold text-textPrimary text-sm truncate">{campaign.title}</h3>
                          <p className="mt-2 text-sm text-textSecondary line-clamp-2 leading-relaxed">
                            {campaign.body}
                          </p>
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-bold text-textSecondary">
                            <span className="rounded-full bg-surfaceMedium px-2 py-0.5">
                              {COMMUNICATION_CATEGORY_LABELS[campaign.category] ?? campaign.category}
                            </span>
                            <span className={`rounded-full px-2 py-0.5 ${
                              campaign.priority === 'CRITICAL' ? 'bg-[#FFF4F4] text-critical' :
                              campaign.priority === 'HIGH' ? 'bg-[#FFF8E6] text-[#8A5A00]' :
                              'bg-surfaceMedium'
                            }`}>
                              {COMMUNICATION_PRIORITY_LABELS[campaign.priority] ?? campaign.priority}
                            </span>
                            <span className="rounded-full bg-surfaceMedium px-2 py-0.5">
                              {targetLabel(campaign)}
                            </span>
                            <span>·</span>
                            <span>Обновлено: {formatDate(campaign.updatedAt)}</span>
                          </div>
                        </div>

                        <div className="flex-shrink-0">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => handleOpenDraft(campaign)}
                            className="bg-primary/10 hover:bg-primary/20 text-primary border-none shadow-none font-bold"
                          >
                            Открыть
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeTab === 'templates' && (
            <section className="rounded-lg border border-border bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-base font-bold text-textPrimary">Шаблоны сообщений</h2>
                <Button type="button" size="sm" onClick={openCreateTemplate}>
                  <Plus className="h-4 w-4" />
                  Создать шаблон
                </Button>
              </div>

              {templatesLoading ? (
                <div className="flex min-h-64 items-center justify-center">
                  <Spinner />
                </div>
              ) : templatesError ? (
                <div className="m-4 flex items-center gap-2 rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-3 py-2 text-sm font-medium text-critical">
                  <AlertCircle className="h-4 w-4" />
                  {templatesError}
                </div>
              ) : templates.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm leading-6 text-textSecondary">
                  Шаблонов пока нет. Создайте шаблон для частых сообщений школы.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {templates.map(template => (
                    <div key={template.id} className="p-4 hover:bg-surfaceLow transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-bold text-textPrimary text-sm truncate">{template.name}</h3>
                          <p className="mt-1 text-xs text-textSecondary font-semibold">
                            Тема: <span className="text-textPrimary">{template.title}</span>
                          </p>
                          <p className="mt-2 text-sm text-textSecondary line-clamp-2 leading-relaxed">
                            {template.body}
                          </p>
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-bold text-textSecondary">
                            <span className="rounded-full bg-surfaceMedium px-2 py-0.5">
                              {COMMUNICATION_CATEGORY_LABELS[template.category] ?? template.category}
                            </span>
                            <span className={`rounded-full px-2 py-0.5 ${
                              template.priority === 'CRITICAL' ? 'bg-[#FFF4F4] text-critical' :
                              template.priority === 'HIGH' ? 'bg-[#FFF8E6] text-[#8A5A00]' :
                              'bg-surfaceMedium'
                            }`}>
                              {COMMUNICATION_PRIORITY_LABELS[template.priority] ?? template.priority}
                            </span>
                            <span>·</span>
                            <span>Обновлено: {formatDate(template.updatedAt)}</span>
                          </div>
                        </div>

                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-shrink-0">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => handleApplyTemplate(template)}
                            className="bg-primary/10 hover:bg-primary/20 text-primary border-none shadow-none font-bold"
                          >
                            Применить
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => openEditTemplate(template)}
                            className="p-2 min-w-0"
                            title="Изменить"
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleArchiveTemplate(template.id)}
                            className="p-2 min-w-0 text-critical border-critical/30 hover:bg-critical/5"
                            title="Архивировать"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <Modal open={isTemplateModalOpen} onOpenChange={setIsTemplateModalOpen}>
            <ModalContent className="max-w-lg">
              <ModalHeader>
                <ModalTitle>{editingTemplate ? 'Изменить шаблон' : 'Создать шаблон'}</ModalTitle>
              </ModalHeader>
              <form onSubmit={handleSaveTemplate}>
                <ModalBody className="space-y-4">
                  <Input
                    label="Название шаблона"
                    placeholder="Например, Напоминание об оплате"
                    value={templateName}
                    onChange={event => setTemplateName(event.target.value)}
                    required
                  />

                  <Input
                    label="Заголовок сообщения"
                    placeholder="Например, Внимание! Напоминание об оплате"
                    value={templateTitle}
                    maxLength={120}
                    onChange={event => setTemplateTitle(event.target.value)}
                    required
                  />

                  <Textarea
                    label="Текст сообщения"
                    placeholder="Введите текст сообщения..."
                    value={templateBody}
                    rows={5}
                    onChange={event => setTemplateBody(event.target.value)}
                    required
                  />

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5 text-sm font-semibold text-textPrimary">
                      Категория
                      <select
                        value={templateCategory}
                        onChange={event => setTemplateCategory(event.target.value as NotificationCategory)}
                        className="h-11 w-full rounded-sm border border-border bg-white px-3 text-sm font-medium text-textPrimary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                      >
                        {COMMUNICATION_CATEGORIES.map(item => (
                          <option key={item} value={item}>{COMMUNICATION_CATEGORY_LABELS[item] ?? item}</option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1.5 text-sm font-semibold text-textPrimary">
                      Приоритет
                      <select
                        value={templatePriority}
                        onChange={event => setTemplatePriority(event.target.value as NotificationPriority)}
                        className="h-11 w-full rounded-sm border border-border bg-white px-3 text-sm font-medium text-textPrimary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                      >
                        {COMMUNICATION_PRIORITIES.map(item => (
                          <option key={item} value={item}>{COMMUNICATION_PRIORITY_LABELS[item] ?? item}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label className="space-y-1.5 text-sm font-semibold text-textPrimary opacity-50">
                    Канал доставки
                    <select
                      disabled
                      value="IN_APP"
                      className="h-11 w-full rounded-sm border border-border bg-surfaceLow px-3 text-sm font-medium text-textSecondary cursor-not-allowed"
                    >
                      <option value="IN_APP">Внутри CRM (In-app)</option>
                    </select>
                  </label>
                </ModalBody>
                <ModalFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsTemplateModalOpen(false)}
                    disabled={templateSubmitting}
                  >
                    Отмена
                  </Button>
                  <Button type="submit" isLoading={templateSubmitting} disabled={templateSubmitting}>
                    Сохранить
                  </Button>
                </ModalFooter>
              </form>
            </ModalContent>
          </Modal>
        </div>
      </div>
    </div>
  );
}

function Counter({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surfaceLow px-3 py-2">
      <div className="text-xs font-bold uppercase tracking-wider text-textSecondary">{label}</div>
      <div className="mt-1 text-xl font-bold text-textPrimary">{value}</div>
      {detail && <div className="mt-0.5 text-xs font-semibold text-textSecondary">{detail}</div>}
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-bold uppercase tracking-wider text-textSecondary">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-textPrimary">{value}</div>
    </div>
  );
}

function DeliveryRecipientRow({ recipient }: { recipient: CommunicationCampaignRecipientDeliveryItem }) {
  const roleLabel = recipient.user?.role
    ? COMMUNICATION_ROLE_LABELS[recipient.user.role as CommunicationTargetRole] ?? recipient.user.role
    : '—';
  const note = getRecipientNote(recipient);

  return (
    <div className="grid gap-2 border-t border-border px-4 py-3 text-sm sm:grid-cols-[minmax(0,1.2fr)_120px_130px_minmax(0,1fr)] sm:items-center">
      <div className="min-w-0">
        <p className="truncate font-semibold text-textPrimary">{getCommunicationRecipientDisplayName(recipient)}</p>
        {recipient.user?.email && <p className="truncate text-xs text-textSecondary">{recipient.user.email}</p>}
      </div>
      <span className="truncate text-xs font-bold text-textSecondary">{roleLabel}</span>
      <span className={`inline-flex w-fit rounded-full border px-2 py-1 text-xs font-bold ${statusClass(recipient.status)}`}>
        {COMMUNICATION_RECIPIENT_STATUS_LABELS[recipient.status] ?? recipient.status}
      </span>
      <div className={`truncate text-xs ${recipient.status === 'FAILED' ? 'text-critical' : 'text-textSecondary'}`}>
        {note}
      </div>
    </div>
  );
}
