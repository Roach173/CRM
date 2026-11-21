import { Role, type Notification, type Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { emitToUser } from '../lib/socket';
import { createLogger } from '../lib/logger';
import {
  NOTIFICATION_CATEGORY_DEFINITIONS,
  NotificationCategory,
  NotificationPriority,
  isKnownNotificationCategory,
  isLockedNotificationCategory,
} from '../constants/notifications';

const log = createLogger('notificationService');

export { NotificationCategory, NotificationPriority };

export type { NotificationCategoryDefinition } from '../constants/notifications';

type NotificationData = Record<string, unknown>;
type NotificationDbClient = Pick<typeof prisma, 'notification' | 'notificationPreference'>;

export interface CreateNotificationParams {
  userId: number;
  schoolId?: number | null;
  type: string;
  title: string;
  body: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  actionUrl?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  data?: NotificationData;
}

export interface CreateNotificationForRoleParams extends Omit<CreateNotificationParams, 'userId' | 'schoolId'> {
  schoolId: number;
  role?: Role;
  roles?: Role[];
}

export interface NotificationCreateResult {
  created: boolean;
  notification: Notification | null;
  skippedReason?: 'preference_disabled';
}

export interface NotificationPreferenceCategory {
  category: NotificationCategory;
  label: string;
  description: string;
  enabled: boolean;
  locked: boolean;
}

export interface NotificationPreferenceUpdate {
  category: string;
  enabled: boolean;
}

export type NotificationListStatus = 'all' | 'unread' | 'read';
export type NotificationListSort = 'createdAt_desc';

export interface NotificationListQuery {
  page?: unknown;
  limit?: unknown;
  status?: unknown;
  category?: unknown;
  priority?: unknown;
  search?: unknown;
  sort?: unknown;
}

export interface NotificationListFilters {
  page: number;
  limit: number;
  status: NotificationListStatus;
  category?: string;
  priority?: string;
  search?: string;
  sort: NotificationListSort;
}

export interface NotificationPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface NotificationListResult {
  items: Notification[];
  pagination: NotificationPagination;
  unreadCount: number;
}

const DEFAULT_NOTIFICATION_PAGE = 1;
const DEFAULT_NOTIFICATION_LIMIT = 20;
const MAX_NOTIFICATION_LIMIT = 100;

function normalizePayload(params: CreateNotificationParams) {
  if (!params.userId) {
    throw new Error('Notification userId is required');
  }

  return {
    userId: params.userId,
    schoolId: params.schoolId ?? null,
    type: params.type,
    category: params.category ?? NotificationCategory.SYSTEM,
    priority: params.priority ?? NotificationPriority.NORMAL,
    title: params.title,
    body: params.body,
    actionUrl: params.actionUrl ?? null,
    entityType: params.entityType ?? null,
    entityId: params.entityId ?? null,
    data: (params.data ?? {}) as Prisma.InputJsonObject,
  };
}

function shouldBypassPreferences(payload: ReturnType<typeof normalizePayload>) {
  return payload.priority === NotificationPriority.CRITICAL || isLockedNotificationCategory(payload.category);
}

async function isNotificationEnabledForUser(
  payload: ReturnType<typeof normalizePayload>,
  client: NotificationDbClient,
) {
  if (shouldBypassPreferences(payload)) return true;

  const preference = await client.notificationPreference.findUnique({
    where: {
      userId_category: {
        userId: payload.userId,
        category: payload.category,
      },
    },
    select: { inAppEnabled: true },
  });

  return preference?.inAppEnabled ?? true;
}

function parsePositiveInt(value: unknown, fallback: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalString(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseNotificationListFilters(query: NotificationListQuery): NotificationListFilters {
  const page = parsePositiveInt(query.page, DEFAULT_NOTIFICATION_PAGE);
  const limit = Math.min(parsePositiveInt(query.limit, DEFAULT_NOTIFICATION_LIMIT), MAX_NOTIFICATION_LIMIT);
  const statusValue = parseOptionalString(query.status)?.toLowerCase();
  const sortValue = parseOptionalString(query.sort);

  return {
    page,
    limit,
    status: statusValue === 'unread' || statusValue === 'read' ? statusValue : 'all',
    category: parseOptionalString(query.category),
    priority: parseOptionalString(query.priority),
    search: parseOptionalString(query.search),
    sort: sortValue === 'createdAt_desc' ? sortValue : 'createdAt_desc',
  };
}

function buildNotificationWhere(userId: number, filters: NotificationListFilters): Prisma.NotificationWhereInput {
  const and: Prisma.NotificationWhereInput[] = [{ userId }];

  if (filters.status === 'unread') {
    and.push({ OR: [{ isRead: false }, { readAt: null }] });
  } else if (filters.status === 'read') {
    and.push({ OR: [{ isRead: true }, { readAt: { not: null } }] });
  }

  if (filters.category) and.push({ category: filters.category });
  if (filters.priority) and.push({ priority: filters.priority });

  if (filters.search) {
    const search = filters.search;
    const searchFilters: Prisma.NotificationWhereInput[] = [
      { title: { contains: search, mode: 'insensitive' } },
      { body: { contains: search, mode: 'insensitive' } },
      { type: { contains: search, mode: 'insensitive' } },
      { category: { contains: search, mode: 'insensitive' } },
      { entityType: { contains: search, mode: 'insensitive' } },
    ];
    const entityId = Number.parseInt(search, 10);
    if (Number.isFinite(entityId)) searchFilters.push({ entityId });
    and.push({ OR: searchFilters });
  }

  return and.length === 1 ? and[0] : { AND: and };
}

async function emitNotificationCreated(notification: Notification, client: NotificationDbClient = prisma) {
  try {
    const unreadCount = await client.notification.count({
      where: { userId: notification.userId, isRead: false },
    });
    emitToUser(notification.userId, 'notification:new', { notification, unreadCount });
    emitToUser(notification.userId, 'notification:unread_count_changed', { unreadCount });
  } catch (error) {
    log.warn({ err: error }, 'realtime emit failed after create');
  }
}

export async function createForUser(
  params: CreateNotificationParams,
  client: NotificationDbClient = prisma,
): Promise<NotificationCreateResult> {
  const payload = normalizePayload(params);
  const enabled = await isNotificationEnabledForUser(payload, client);

  if (!enabled) {
    return { created: false, notification: null, skippedReason: 'preference_disabled' };
  }

  const notification = await client.notification.create({
    data: payload,
  });
  await emitNotificationCreated(notification, client);

  return { created: true, notification };
}

export async function createForUsers(
  userIds: number[],
  params: Omit<CreateNotificationParams, 'userId'>,
): Promise<NotificationCreateResult[]> {
  const uniqueUserIds = [...new Set(userIds)].filter(Boolean);
  if (uniqueUserIds.length === 0) return [];

  return Promise.all(
    uniqueUserIds.map(userId => createForUser({ ...params, userId })),
  );
}

export async function createForRole(params: CreateNotificationForRoleParams): Promise<number> {
  const roles = params.roles ?? (params.role ? [params.role] : []);
  if (roles.length === 0) return 0;

  const users = await prisma.user.findMany({
    where: {
      schoolId: params.schoolId,
      role: { in: roles },
      deletedAt: null,
    },
    select: { id: true },
  });

  const results = await createForUsers(
    users.map(user => user.id),
    params,
  );

  return results.filter(result => result.created).length;
}

export async function createForSchoolAdmins(
  params: Omit<CreateNotificationForRoleParams, 'role' | 'roles'>,
): Promise<number> {
  return createForRole({
    ...params,
    roles: [Role.OWNER, Role.ADMIN],
  });
}

export async function markRead(userId: number, notificationId: number): Promise<void> {
  const readAt = new Date();

  await prisma.$transaction([
    prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt },
    }),
    prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true },
    }),
  ]);
}

export async function markUnread(userId: number, notificationId: number): Promise<void> {
  await prisma.$transaction([
    prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: false, readAt: null },
    }),
  ]);
}

export async function markAllRead(userId: number): Promise<void> {
  const readAt = new Date();

  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt },
  });
}

export async function getUnreadCount(userId: number): Promise<number> {
  return prisma.notification.count({
    where: { userId, isRead: false },
  });
}

export async function listPreferenceCategoriesForUser(userId: number): Promise<NotificationPreferenceCategory[]> {
  const preferences = await prisma.notificationPreference.findMany({
    where: { userId },
    select: { category: true, inAppEnabled: true },
  });
  const preferenceByCategory = new Map(preferences.map(preference => [preference.category, preference.inAppEnabled]));

  return NOTIFICATION_CATEGORY_DEFINITIONS.map(definition => ({
    category: definition.category,
    label: definition.label,
    description: definition.description,
    enabled: preferenceByCategory.get(definition.category) ?? definition.defaultEnabled,
    locked: definition.locked,
  }));
}

export async function updatePreferenceCategoriesForUser(
  userId: number,
  updates: NotificationPreferenceUpdate[],
): Promise<NotificationPreferenceCategory[]> {
  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map(update => prisma.notificationPreference.upsert({
        where: {
          userId_category: {
            userId,
            category: update.category,
          },
        },
        create: {
          userId,
          category: update.category,
          inAppEnabled: update.enabled,
        },
        update: {
          inAppEnabled: update.enabled,
        },
      })),
    );
  }

  return listPreferenceCategoriesForUser(userId);
}

export function validatePreferenceUpdates(value: unknown): { updates: NotificationPreferenceUpdate[]; error?: string } {
  if (!Array.isArray(value)) {
    return { updates: [], error: 'preferences must be an array' };
  }

  const updates: NotificationPreferenceUpdate[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return { updates: [], error: 'Each preference must be an object' };
    }

    const category = (item as { category?: unknown }).category;
    const enabled = (item as { enabled?: unknown }).enabled;

    if (typeof category !== 'string' || !isKnownNotificationCategory(category)) {
      return { updates: [], error: 'Invalid notification category' };
    }

    if (isLockedNotificationCategory(category)) {
      return { updates: [], error: 'Locked notification category cannot be changed' };
    }

    if (typeof enabled !== 'boolean') {
      return { updates: [], error: 'enabled must be boolean' };
    }

    updates.push({ category, enabled });
  }

  return { updates };
}

export async function listForUser(userId: number, filters: NotificationListFilters): Promise<NotificationListResult> {
  const where = buildNotificationWhere(userId, filters);
  const skip = (filters.page - 1) * filters.limit;

  const [items, total, unreadCount] = await prisma.$transaction([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: filters.limit,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / filters.limit);

  return {
    items,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages,
      hasNextPage: filters.page < totalPages,
      hasPrevPage: filters.page > 1,
    },
    unreadCount,
  };
}
