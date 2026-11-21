import { CommunicationChannel } from '@prisma/client';
import prisma from '../lib/prisma';
import { CommunicationValidationError } from './communicationService';
import {
  isKnownNotificationCategory,
  NotificationCategory,
  NotificationPriority,
} from '../constants/notifications';

const NOTIFICATION_PRIORITIES = new Set<string>(Object.values(NotificationPriority));

export interface ListTemplatesParams {
  schoolId: number;
  includeArchived?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}

export interface CreateTemplateParams {
  schoolId: number;
  createdById: number;
  name: string;
  title: string;
  body: string;
  category?: string;
  priority?: string;
  channel?: CommunicationChannel;
}

export interface UpdateTemplateParams {
  schoolId: number;
  templateId: number;
  name?: string;
  title?: string;
  body?: string;
  category?: string;
  priority?: string;
  channel?: CommunicationChannel;
}

export interface ArchiveTemplateParams {
  schoolId: number;
  templateId: number;
}

function validateCategoryAndPriority(category?: string, priority?: string) {
  if (category !== undefined && !isKnownNotificationCategory(category)) {
    throw new CommunicationValidationError('Invalid category');
  }
  if (priority !== undefined && !NOTIFICATION_PRIORITIES.has(priority)) {
    throw new CommunicationValidationError('Invalid priority');
  }
}

export async function createTemplate(params: CreateTemplateParams) {
  const name = params.name?.trim();
  const title = params.title?.trim();
  const body = params.body?.trim();
  const category = params.category ?? NotificationCategory.ANNOUNCEMENT;
  const priority = params.priority ?? NotificationPriority.NORMAL;
  const channel = params.channel ?? CommunicationChannel.IN_APP;

  if (!name) throw new CommunicationValidationError('Name is required');
  if (!title) throw new CommunicationValidationError('Title is required');
  if (!body) throw new CommunicationValidationError('Body is required');
  if (channel !== CommunicationChannel.IN_APP) {
    throw new CommunicationValidationError('Only IN_APP channel is supported');
  }

  validateCategoryAndPriority(category, priority);

  return prisma.communicationTemplate.create({
    data: {
      schoolId: params.schoolId,
      createdById: params.createdById,
      name,
      title,
      body,
      category,
      priority,
      channel,
      isArchived: false,
    },
  });
}

export async function updateTemplate(params: UpdateTemplateParams) {
  const template = await prisma.communicationTemplate.findFirst({
    where: {
      id: params.templateId,
      schoolId: params.schoolId,
    },
  });

  if (!template) {
    throw new CommunicationValidationError('Template not found');
  }

  if (template.isArchived) {
    throw new CommunicationValidationError('Cannot update archived template');
  }

  const name = params.name !== undefined ? params.name.trim() : undefined;
  const title = params.title !== undefined ? params.title.trim() : undefined;
  const body = params.body !== undefined ? params.body.trim() : undefined;
  const category = params.category;
  const priority = params.priority;
  const channel = params.channel;

  if (name !== undefined && !name) throw new CommunicationValidationError('Name cannot be empty');
  if (title !== undefined && !title) throw new CommunicationValidationError('Title cannot be empty');
  if (body !== undefined && !body) throw new CommunicationValidationError('Body cannot be empty');
  if (channel !== undefined && channel !== CommunicationChannel.IN_APP) {
    throw new CommunicationValidationError('Only IN_APP channel is supported');
  }

  validateCategoryAndPriority(category, priority);

  return prisma.communicationTemplate.update({
    where: { id: params.templateId },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(channel !== undefined ? { channel } : {}),
    },
  });
}

export async function archiveTemplate(params: ArchiveTemplateParams) {
  const template = await prisma.communicationTemplate.findFirst({
    where: {
      id: params.templateId,
      schoolId: params.schoolId,
    },
  });

  if (!template) {
    throw new CommunicationValidationError('Template not found');
  }

  return prisma.communicationTemplate.update({
    where: { id: params.templateId },
    data: { isArchived: true },
  });
}

export async function listTemplates(params: ListTemplatesParams) {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 50));
  const skip = (page - 1) * limit;

  const search = params.search?.trim();

  const where: any = {
    schoolId: params.schoolId,
    ...(params.includeArchived ? {} : { isArchived: false }),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { title: { contains: search, mode: 'insensitive' } },
            { body: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, items] = await prisma.$transaction([
    prisma.communicationTemplate.count({ where }),
    prisma.communicationTemplate.findMany({
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
