import {
  CommunicationCampaign,
  CommunicationCampaignStatus,
  CommunicationChannel,
  CommunicationRecipientStatus,
  CommunicationTargetType,
  GroupStatus,
  MemberStatus,
  Prisma,
  Role,
} from '@prisma/client';
import prisma from '../lib/prisma';
import {
  COMMUNICATION_ENTITY_TYPE,
  COMMUNICATION_NOTIFICATION_TYPE,
  COMMUNICATION_SKIP_REASON,
  DEFAULT_COMMUNICATION_CHANNEL,
  CommunicationGroupAudience,
  isAllowedCommunicationGroupAudience,
  isAllowedCommunicationRecipientRole,
} from '../constants/communications';
import {
  createForUser,
  NotificationCategory,
  NotificationPriority,
} from './notificationService';

export class CommunicationValidationError extends Error {
  statusCode = 400;
}

export interface CommunicationTargetConfig {
  roles?: Role[];
  userIds?: number[];
  groupIds?: number[];
  audience?: CommunicationGroupAudience;
}

export interface CreateAndSendCampaignInput {
  schoolId: number;
  createdById: number;
  title: string;
  body: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channel?: CommunicationChannel;
  targetType: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
}

export interface CreateCampaignDraftInput {
  schoolId: number;
  createdById: number;
  title: string;
  body: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channel?: CommunicationChannel;
  targetType: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
}

export interface UpdateCampaignDraftInput {
  schoolId: number;
  campaignId: number;
  title?: string;
  body?: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channel?: CommunicationChannel;
  targetType?: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
}

export interface CreateScheduledCampaignInput {
  schoolId: number;
  createdById: number;
  title: string;
  body: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channel?: CommunicationChannel;
  targetType: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
  scheduledAt: Date;
}

export interface UpdateScheduledCampaignInput {
  schoolId: number;
  campaignId: number;
  title?: string;
  body?: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channel?: CommunicationChannel;
  targetType?: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
  scheduledAt?: Date;
}

export interface ListCampaignsInput {
  schoolId: number;
  page?: number;
  limit?: number;
  status?: CommunicationCampaignStatus;
}

export interface ListCampaignRecipientsInput {
  schoolId: number;
  campaignId: number;
  page?: number;
  limit?: number;
  status?: CommunicationRecipientStatus | 'ALL';
  search?: string;
}

export interface GetCampaignInput {
  schoolId: number;
  campaignId: number;
  includeRecipients?: boolean;
}

export interface ResolvedRecipient {
  id: number;
  email: string | null;
  firstName: string;
  lastName: string;
  role: Role;
}

const DEFAULT_CAMPAIGNS_PAGE = 1;
const DEFAULT_CAMPAIGNS_LIMIT = 20;
const MAX_CAMPAIGNS_LIMIT = 100;
const DEFAULT_CAMPAIGN_RECIPIENTS_LIMIT = 25;
const MAX_CAMPAIGN_RECIPIENTS_LIMIT = 100;
const RECIPIENT_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
} satisfies Prisma.UserSelect;

function uniqueNumbers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];

  const ids = values
    .map(value => Number.parseInt(String(value), 10))
    .filter(value => Number.isFinite(value) && value > 0);

  return [...new Set(ids)];
}

function uniqueRoles(values: unknown): Role[] {
  if (!Array.isArray(values)) return [];

  const roles = values
    .filter((value): value is Role => typeof value === 'string' && isAllowedCommunicationRecipientRole(value as Role));

  return [...new Set(roles)];
}

function normalizeTargetConfig(targetType: CommunicationTargetType, targetConfig?: CommunicationTargetConfig) {
  if (targetType === CommunicationTargetType.ROLES) {
    const roles = uniqueRoles(targetConfig?.roles);
    if (roles.length === 0) {
      throw new CommunicationValidationError('At least one recipient role is required');
    }
    return { roles };
  }

  if (targetType === CommunicationTargetType.USERS) {
    const userIds = uniqueNumbers(targetConfig?.userIds);
    if (userIds.length === 0) {
      throw new CommunicationValidationError('At least one user is required');
    }
    return { userIds };
  }

  if (targetType === CommunicationTargetType.GROUPS) {
    const groupIds = uniqueNumbers(targetConfig?.groupIds);
    if (groupIds.length === 0) {
      throw new CommunicationValidationError('At least one group is required');
    }

    if (!isAllowedCommunicationGroupAudience(targetConfig?.audience)) {
      throw new CommunicationValidationError('Invalid group audience');
    }

    return { groupIds, audience: targetConfig.audience };
  }

  throw new CommunicationValidationError('Invalid targetType');
}

function toJsonObject(value: CommunicationTargetConfig): Prisma.InputJsonObject {
  return value as unknown as Prisma.InputJsonObject;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function dedupeRecipients(recipients: ResolvedRecipient[]) {
  return [...new Map(recipients.map(recipient => [recipient.id, recipient])).values()];
}

async function getActiveSchoolGroupIds(schoolId: number, groupIds: number[]) {
  const groups = await prisma.studentGroup.findMany({
    where: {
      id: { in: groupIds },
      schoolId,
      deletedAt: null,
      status: GroupStatus.ACTIVE,
    },
    select: { id: true },
  });

  return groups.map(group => group.id);
}

async function resolveGroupStudents(schoolId: number, groupIds: number[]): Promise<ResolvedRecipient[]> {
  const memberships = await prisma.groupMembership.findMany({
    where: {
      schoolId,
      studentGroupId: { in: groupIds },
      status: MemberStatus.ACTIVE,
      studentProfile: {
        deletedAt: null,
        user: {
          schoolId,
          deletedAt: null,
        },
      },
    },
    select: {
      studentProfile: {
        select: {
          user: {
            select: RECIPIENT_USER_SELECT,
          },
        },
      },
    },
  });

  return memberships.map(membership => membership.studentProfile.user);
}

async function resolveGroupParents(schoolId: number, groupIds: number[]): Promise<ResolvedRecipient[]> {
  const memberships = await prisma.groupMembership.findMany({
    where: {
      schoolId,
      studentGroupId: { in: groupIds },
      status: MemberStatus.ACTIVE,
      studentProfile: {
        deletedAt: null,
        user: {
          schoolId,
          deletedAt: null,
        },
      },
    },
    select: {
      studentProfileId: true,
    },
  });
  const studentProfileIds = [...new Set(memberships.map(membership => membership.studentProfileId))];
  if (studentProfileIds.length === 0) return [];

  const parentLinks = await prisma.parentChild.findMany({
    where: {
      studentProfileId: { in: studentProfileIds },
      parentProfile: {
        schoolId,
        deletedAt: null,
        user: {
          schoolId,
          deletedAt: null,
        },
      },
    },
    select: {
      parentProfile: {
        select: {
          user: {
            select: RECIPIENT_USER_SELECT,
          },
        },
      },
    },
  });

  return parentLinks.map(link => link.parentProfile.user);
}

async function resolveGroupRecipients(
  schoolId: number,
  targetConfig: CommunicationTargetConfig,
): Promise<ResolvedRecipient[]> {
  const activeGroupIds = await getActiveSchoolGroupIds(schoolId, targetConfig.groupIds ?? []);
  if (activeGroupIds.length === 0) return [];

  const recipients: ResolvedRecipient[] = [];
  if (targetConfig.audience === 'STUDENTS' || targetConfig.audience === 'STUDENTS_AND_PARENTS') {
    recipients.push(...await resolveGroupStudents(schoolId, activeGroupIds));
  }

  if (targetConfig.audience === 'PARENTS' || targetConfig.audience === 'STUDENTS_AND_PARENTS') {
    recipients.push(...await resolveGroupParents(schoolId, activeGroupIds));
  }

  return dedupeRecipients(recipients);
}

export async function resolveRecipients(params: {
  schoolId: number;
  targetType: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
}): Promise<ResolvedRecipient[]> {
  const targetConfig = normalizeTargetConfig(params.targetType, params.targetConfig);

  if (params.targetType === CommunicationTargetType.ROLES) {
    const users = await prisma.user.findMany({
      where: {
        schoolId: params.schoolId,
        deletedAt: null,
        role: { in: targetConfig.roles },
      },
      select: RECIPIENT_USER_SELECT,
    });

    return users;
  }

  if (params.targetType === CommunicationTargetType.GROUPS) {
    return resolveGroupRecipients(params.schoolId, targetConfig);
  }

  const users = await prisma.user.findMany({
    where: {
      schoolId: params.schoolId,
      deletedAt: null,
      id: { in: targetConfig.userIds },
    },
    select: RECIPIENT_USER_SELECT,
  });

  return users;
}

export async function previewCommunicationRecipients(params: {
  schoolId: number;
  targetType: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
}) {
  const recipients = await resolveRecipients(params);
  const uniqueRecipients = dedupeRecipients(recipients);

  return {
    recipientsCount: uniqueRecipients.length,
    sample: uniqueRecipients.slice(0, 10).map(recipient => ({
      id: recipient.id,
      email: recipient.email,
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      role: recipient.role,
    })),
  };
}

export async function createAndSendCampaign(input: CreateAndSendCampaignInput) {
  const channel = input.channel ?? DEFAULT_COMMUNICATION_CHANNEL;
  if (channel !== CommunicationChannel.IN_APP) {
    throw new CommunicationValidationError('Only IN_APP channel is supported');
  }

  const targetConfig = normalizeTargetConfig(input.targetType, input.targetConfig);
  const recipients = await resolveRecipients({
    schoolId: input.schoolId,
    targetType: input.targetType,
    targetConfig,
  });
  const uniqueRecipients = dedupeRecipients(recipients);

  if (uniqueRecipients.length === 0) {
    throw new CommunicationValidationError('No recipients found for selected target');
  }

  const campaign = await prisma.communicationCampaign.create({
    data: {
      schoolId: input.schoolId,
      createdById: input.createdById,
      title: input.title,
      body: input.body,
      category: input.category ?? NotificationCategory.ANNOUNCEMENT,
      priority: input.priority ?? NotificationPriority.NORMAL,
      channel,
      status: CommunicationCampaignStatus.SENDING,
      targetType: input.targetType,
      targetConfig: toJsonObject(targetConfig),
      recipientsCount: uniqueRecipients.length,
    },
  });

  return deliverCampaign(campaign, uniqueRecipients);
}

async function deliverCampaign(campaign: CommunicationCampaign, uniqueRecipients: ResolvedRecipient[]) {
  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const recipient of uniqueRecipients) {
    const campaignRecipient = await prisma.communicationRecipient.create({
      data: {
        campaignId: campaign.id,
        userId: recipient.id,
        status: CommunicationRecipientStatus.PENDING,
      },
    });

    try {
      const result = await createForUser({
        userId: recipient.id,
        schoolId: campaign.schoolId,
        type: COMMUNICATION_NOTIFICATION_TYPE,
        category: campaign.category as NotificationCategory,
        priority: campaign.priority as NotificationPriority,
        title: campaign.title,
        body: campaign.body,
        entityType: COMMUNICATION_ENTITY_TYPE,
        entityId: campaign.id,
        data: {
          campaignId: campaign.id,
          targetType: campaign.targetType,
        },
      });

      if (result.created && result.notification) {
        sentCount += 1;
        await prisma.communicationRecipient.update({
          where: { id: campaignRecipient.id },
          data: {
            status: CommunicationRecipientStatus.SENT,
            notificationId: result.notification.id,
          },
        });
      } else {
        skippedCount += 1;
        await prisma.communicationRecipient.update({
          where: { id: campaignRecipient.id },
          data: {
            status: CommunicationRecipientStatus.SKIPPED,
            skippedReason: result.skippedReason === 'preference_disabled'
              ? COMMUNICATION_SKIP_REASON.PREFERENCE_DISABLED
              : result.skippedReason ?? 'UNKNOWN',
          },
        });
      }
    } catch (error) {
      failedCount += 1;
      await prisma.communicationRecipient.update({
        where: { id: campaignRecipient.id },
        data: {
          status: CommunicationRecipientStatus.FAILED,
          error: getErrorMessage(error),
        },
      });
    }
  }

  const status = failedCount === uniqueRecipients.length
    ? CommunicationCampaignStatus.FAILED
    : CommunicationCampaignStatus.SENT;

  return prisma.communicationCampaign.update({
    where: { id: campaign.id },
    data: {
      recipientsCount: uniqueRecipients.length,
      sentCount,
      skippedCount,
      failedCount,
      status,
      sentAt: new Date(),
    },
    include: {
      recipients: {
        orderBy: { id: 'asc' },
        include: {
          user: {
            select: RECIPIENT_USER_SELECT,
          },
        },
      },
    },
  });
}

export async function createCampaignDraft(input: CreateCampaignDraftInput) {
  const channel = input.channel ?? DEFAULT_COMMUNICATION_CHANNEL;
  if (channel !== CommunicationChannel.IN_APP) {
    throw new CommunicationValidationError('Only IN_APP channel is supported');
  }

  const title = input.title?.trim();
  const body = input.body?.trim();

  if (!title) throw new CommunicationValidationError('title is required');
  if (!body) throw new CommunicationValidationError('body is required');

  const targetConfig = normalizeTargetConfig(input.targetType, input.targetConfig);

  return prisma.communicationCampaign.create({
    data: {
      schoolId: input.schoolId,
      createdById: input.createdById,
      title,
      body,
      category: input.category ?? NotificationCategory.ANNOUNCEMENT,
      priority: input.priority ?? NotificationPriority.NORMAL,
      channel,
      status: CommunicationCampaignStatus.DRAFT,
      targetType: input.targetType,
      targetConfig: toJsonObject(targetConfig),
      recipientsCount: 0,
      sentCount: 0,
      skippedCount: 0,
      failedCount: 0,
      sentAt: null,
    },
  });
}

export async function updateCampaignDraft(input: UpdateCampaignDraftInput) {
  const campaign = await prisma.communicationCampaign.findFirst({
    where: {
      id: input.campaignId,
      schoolId: input.schoolId,
    },
  });

  if (!campaign) {
    throw new CommunicationValidationError('Draft not found');
  }

  if (campaign.status !== CommunicationCampaignStatus.DRAFT) {
    throw new CommunicationValidationError('Only draft campaigns can be updated');
  }

  const title = input.title !== undefined ? input.title.trim() : undefined;
  const body = input.body !== undefined ? input.body.trim() : undefined;

  if (title !== undefined && !title) throw new CommunicationValidationError('title is required');
  if (body !== undefined && !body) throw new CommunicationValidationError('body is required');

  const channel = input.channel !== undefined ? input.channel : undefined;
  if (channel !== undefined && channel !== CommunicationChannel.IN_APP) {
    throw new CommunicationValidationError('Only IN_APP channel is supported');
  }

  const targetType = input.targetType !== undefined ? input.targetType : campaign.targetType;
  const rawTargetConfig = input.targetConfig !== undefined ? input.targetConfig : (campaign.targetConfig as any);
  const targetConfig = normalizeTargetConfig(targetType, rawTargetConfig);

  return prisma.communicationCampaign.update({
    where: { id: input.campaignId },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(channel !== undefined ? { channel } : {}),
      targetType,
      targetConfig: toJsonObject(targetConfig),
    },
  });
}

export async function sendCampaignDraft(params: { schoolId: number; campaignId: number }) {
  const updateResult = await prisma.communicationCampaign.updateMany({
    where: {
      id: params.campaignId,
      schoolId: params.schoolId,
      status: CommunicationCampaignStatus.DRAFT,
    },
    data: { status: CommunicationCampaignStatus.SENDING },
  });

  if (updateResult.count === 0) {
    const campaignExists = await prisma.communicationCampaign.findFirst({
      where: { id: params.campaignId, schoolId: params.schoolId },
    });
    if (!campaignExists) {
      throw new CommunicationValidationError('Draft not found');
    }
    throw new CommunicationValidationError('Only draft campaigns can be sent');
  }

  const campaign = await prisma.communicationCampaign.findUnique({
    where: { id: params.campaignId },
  });

  if (!campaign) {
    throw new CommunicationValidationError('Draft not found');
  }

  try {
    const targetConfig = campaign.targetConfig as unknown as CommunicationTargetConfig;
    const recipients = await resolveRecipients({
      schoolId: params.schoolId,
      targetType: campaign.targetType,
      targetConfig,
    });
    const uniqueRecipients = dedupeRecipients(recipients);

    if (uniqueRecipients.length === 0) {
      throw new CommunicationValidationError('No recipients found for selected target');
    }

    return await deliverCampaign(campaign, uniqueRecipients);
  } catch (error) {
    await prisma.communicationCampaign.update({
      where: { id: campaign.id },
      data: { status: CommunicationCampaignStatus.FAILED },
    });
    throw error;
  }
}

export async function listCampaigns(input: ListCampaignsInput) {
  const page = Math.max(1, input.page ?? DEFAULT_CAMPAIGNS_PAGE);
  const limit = Math.min(MAX_CAMPAIGNS_LIMIT, Math.max(1, input.limit ?? DEFAULT_CAMPAIGNS_LIMIT));
  const skip = (page - 1) * limit;
  const where: any = {
    schoolId: input.schoolId,
    ...(input.status ? { status: input.status } : {}),
  };

  const [total, items] = await prisma.$transaction([
    prisma.communicationCampaign.count({ where }),
    prisma.communicationCampaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
  };
}

export async function listCampaignRecipients(input: ListCampaignRecipientsInput) {
  const page = Math.max(1, input.page ?? DEFAULT_CAMPAIGNS_PAGE);
  const limit = Math.min(
    MAX_CAMPAIGN_RECIPIENTS_LIMIT,
    Math.max(1, input.limit ?? DEFAULT_CAMPAIGN_RECIPIENTS_LIMIT),
  );
  const skip = (page - 1) * limit;
  const search = input.search?.trim();

  const campaign = await prisma.communicationCampaign.findFirst({
    where: {
      id: input.campaignId,
      schoolId: input.schoolId,
    },
    select: {
      id: true,
      recipientsCount: true,
      sentCount: true,
      skippedCount: true,
      failedCount: true,
    },
  });

  if (!campaign) {
    const error = new CommunicationValidationError('Campaign not found');
    error.statusCode = 404;
    throw error;
  }

  const where: Prisma.CommunicationRecipientWhereInput = {
    campaignId: campaign.id,
    ...(input.status && input.status !== 'ALL' ? { status: input.status } : {}),
    ...(search
      ? {
          user: {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
            ],
          },
        }
      : {}),
  };

  const [total, items] = await prisma.$transaction([
    prisma.communicationRecipient.count({ where }),
    prisma.communicationRecipient.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        user: {
          select: RECIPIENT_USER_SELECT,
        },
      },
    }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
    stats: {
      recipientsCount: campaign.recipientsCount,
      sentCount: campaign.sentCount,
      skippedCount: campaign.skippedCount,
      failedCount: campaign.failedCount,
    },
  };
}

export async function getCampaign(input: GetCampaignInput) {
  return prisma.communicationCampaign.findFirst({
    where: {
      id: input.campaignId,
      schoolId: input.schoolId,
    },
    include: input.includeRecipients
      ? {
          recipients: {
            orderBy: { id: 'asc' },
            include: {
              user: {
                select: RECIPIENT_USER_SELECT,
              },
            },
          },
        }
      : undefined,
  });
}

export async function createScheduledCampaign(input: CreateScheduledCampaignInput) {
  const channel = input.channel ?? DEFAULT_COMMUNICATION_CHANNEL;
  if (channel !== CommunicationChannel.IN_APP) {
    throw new CommunicationValidationError('Only IN_APP channel is supported');
  }

  const title = input.title?.trim();
  const body = input.body?.trim();

  if (!title) throw new CommunicationValidationError('title is required');
  if (!body) throw new CommunicationValidationError('body is required');
  if (!input.scheduledAt) {
    throw new CommunicationValidationError('Scheduled time is required');
  }

  const scheduledAtDate = new Date(input.scheduledAt);
  if (isNaN(scheduledAtDate.getTime())) {
    throw new CommunicationValidationError('Invalid scheduled time format');
  }

  if (scheduledAtDate.getTime() <= Date.now()) {
    throw new CommunicationValidationError('Scheduled time must be in the future');
  }

  const targetConfig = normalizeTargetConfig(input.targetType, input.targetConfig);

  return prisma.communicationCampaign.create({
    data: {
      schoolId: input.schoolId,
      createdById: input.createdById,
      title,
      body,
      category: input.category ?? NotificationCategory.ANNOUNCEMENT,
      priority: input.priority ?? NotificationPriority.NORMAL,
      channel,
      status: CommunicationCampaignStatus.SCHEDULED,
      targetType: input.targetType,
      targetConfig: toJsonObject(targetConfig),
      scheduledAt: scheduledAtDate,
      recipientsCount: 0,
      sentCount: 0,
      skippedCount: 0,
      failedCount: 0,
      sentAt: null,
    },
  });
}

export async function updateScheduledCampaign(input: UpdateScheduledCampaignInput) {
  const campaign = await prisma.communicationCampaign.findFirst({
    where: {
      id: input.campaignId,
      schoolId: input.schoolId,
    },
  });

  if (!campaign) {
    throw new CommunicationValidationError('Scheduled campaign not found');
  }

  if (campaign.status !== CommunicationCampaignStatus.SCHEDULED) {
    throw new CommunicationValidationError('Only scheduled campaigns can be updated');
  }

  const title = input.title !== undefined ? input.title.trim() : undefined;
  const body = input.body !== undefined ? input.body.trim() : undefined;

  if (title !== undefined && !title) throw new CommunicationValidationError('title is required');
  if (body !== undefined && !body) throw new CommunicationValidationError('body is required');

  const channel = input.channel !== undefined ? input.channel : undefined;
  if (channel !== undefined && channel !== CommunicationChannel.IN_APP) {
    throw new CommunicationValidationError('Only IN_APP channel is supported');
  }

  let scheduledAtDate = undefined;
  if (input.scheduledAt !== undefined) {
    if (!input.scheduledAt) {
      throw new CommunicationValidationError('Scheduled time is required');
    }
    scheduledAtDate = new Date(input.scheduledAt);
    if (isNaN(scheduledAtDate.getTime())) {
      throw new CommunicationValidationError('Invalid scheduled time format');
    }
    if (scheduledAtDate.getTime() <= Date.now()) {
      throw new CommunicationValidationError('Scheduled time must be in the future');
    }
  }

  const targetType = input.targetType !== undefined ? input.targetType : campaign.targetType;
  const rawTargetConfig = input.targetConfig !== undefined ? input.targetConfig : (campaign.targetConfig as any);
  const targetConfig = normalizeTargetConfig(targetType, rawTargetConfig);

  return prisma.communicationCampaign.update({
    where: { id: input.campaignId },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(channel !== undefined ? { channel } : {}),
      ...(scheduledAtDate !== undefined ? { scheduledAt: scheduledAtDate } : {}),
      targetType,
      targetConfig: toJsonObject(targetConfig),
    },
  });
}

export async function cancelScheduledCampaign(params: { schoolId: number; campaignId: number }) {
  const campaign = await prisma.communicationCampaign.findFirst({
    where: {
      id: params.campaignId,
      schoolId: params.schoolId,
    },
  });

  if (!campaign) {
    throw new CommunicationValidationError('Scheduled campaign not found');
  }

  if (campaign.status !== CommunicationCampaignStatus.SCHEDULED) {
    throw new CommunicationValidationError('Only scheduled campaigns can be cancelled');
  }

  return prisma.communicationCampaign.update({
    where: { id: params.campaignId },
    data: {
      status: CommunicationCampaignStatus.CANCELLED,
    },
  });
}

export async function processDueScheduledCampaigns() {
  const campaigns = await prisma.communicationCampaign.findMany({
    where: {
      status: CommunicationCampaignStatus.SCHEDULED,
      scheduledAt: { lte: new Date() },
    },
    orderBy: { scheduledAt: 'asc' },
    take: 50,
  });

  const stats = {
    checked: campaigns.length,
    processed: 0,
    sent: 0,
    failed: 0,
    skippedLocked: 0,
  };

  for (const campaign of campaigns) {
    try {
      const lockResult = await prisma.communicationCampaign.updateMany({
        where: {
          id: campaign.id,
          schoolId: campaign.schoolId,
          status: CommunicationCampaignStatus.SCHEDULED,
        },
        data: { status: CommunicationCampaignStatus.SENDING },
      });

      if (lockResult.count === 0) {
        stats.skippedLocked++;
        continue;
      }

      stats.processed++;

      const targetConfig = campaign.targetConfig as unknown as CommunicationTargetConfig;
      const recipients = await resolveRecipients({
        schoolId: campaign.schoolId,
        targetType: campaign.targetType,
        targetConfig,
      });
      const uniqueRecipients = dedupeRecipients(recipients);

      if (uniqueRecipients.length === 0) {
        await prisma.communicationCampaign.update({
          where: { id: campaign.id },
          data: {
            status: CommunicationCampaignStatus.FAILED,
            recipientsCount: 0,
            sentCount: 0,
            skippedCount: 0,
            failedCount: 0,
          },
        });
        stats.failed++;
        continue;
      }

      await deliverCampaign(campaign, uniqueRecipients);
      stats.sent++;
    } catch (error) {
      stats.failed++;
      try {
        await prisma.communicationCampaign.update({
          where: { id: campaign.id },
          data: { status: CommunicationCampaignStatus.FAILED },
        });
      } catch (updateErr) {
        // ignore update error to not block processing
      }
    }
  }

  return stats;
}

