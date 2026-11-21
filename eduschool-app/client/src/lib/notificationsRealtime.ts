import api from './api';
import type { Notification, NotificationFilters, NotificationListResponse, NotificationPagination } from '../types';

export const NOTIFICATIONS_CHANGED_EVENT = 'notifications:changed';
export const NOTIFICATION_BROADCAST_CHANNEL = 'linguacrm:notifications';
export const NOTIFICATION_REFETCH_THROTTLE_MS = 30_000;
export const NOTIFICATION_TOAST_GROUP_MS = 900;

const TOAST_CATEGORIES = new Set([
  'ANNOUNCEMENT',
  'FINANCE',
  'SUBSCRIPTION',
  'STAFF',
  'STUDENTS',
  'SCHEDULE',
  'ACADEMICS',
]);

export type NotificationRealtimeEvent =
  | 'notification:new'
  | 'notification:read'
  | 'notification:unread'
  | 'notification:read_all'
  | 'notification:deleted'
  | 'notification:unread_count_changed';

export type NotificationNewPayload = {
  notification?: Notification;
  unreadCount?: number;
};

export type NotificationActionPayload = {
  notificationId?: number;
  unreadCount?: number;
};

export type NotificationRealtimePayload = NotificationNewPayload | NotificationActionPayload;

export type NotificationsSummary = {
  notifications: Notification[];
  unreadCount: number;
};

export type NotificationsPage = {
  notifications: Notification[];
  pagination: NotificationPagination;
  unreadCount: number;
};

export type NotificationBroadcastMessage =
  | {
      type: 'event';
      userId?: number;
      event: NotificationRealtimeEvent;
      payload: NotificationRealtimePayload;
    }
  | {
      type: 'summary';
      userId?: number;
      unreadCount: number;
      notifications?: Notification[];
    };

type NotificationsApiResponse = {
  data?: Notification[] | NotificationListResponse;
  unreadCount?: number;
};

function isNotificationListResponse(value: unknown): value is NotificationListResponse {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray((value as NotificationListResponse).items) &&
    (value as NotificationListResponse).pagination
  );
}

export function getNotificationItemsFromResponse(responseData: unknown): Notification[] {
  const payload = (responseData as { data?: unknown } | null)?.data;
  if (Array.isArray(payload)) return payload;
  if (isNotificationListResponse(payload)) return payload.items;
  return [];
}

function buildNotificationQuery(filters: NotificationFilters = {}) {
  const params = new URLSearchParams();

  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.category) params.set('category', filters.category);
  if (filters.priority) params.set('priority', filters.priority);
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  params.set('sort', filters.sort ?? 'createdAt_desc');

  return params.toString();
}

export async function fetchNotificationsPage(filters: NotificationFilters = {}): Promise<NotificationsPage> {
  const query = buildNotificationQuery(filters);
  const response = await api.get<NotificationsApiResponse>(`/notifications${query ? `?${query}` : ''}`);
  const payload = response.data.data;

  if (isNotificationListResponse(payload)) {
    return {
      notifications: payload.items,
      pagination: payload.pagination,
      unreadCount: payload.unreadCount,
    };
  }

  const notifications = Array.isArray(payload) ? payload : [];
  return {
    notifications,
    pagination: {
      page: filters.page ?? 1,
      limit: filters.limit ?? notifications.length,
      total: notifications.length,
      totalPages: notifications.length > 0 ? 1 : 0,
      hasNextPage: false,
      hasPrevPage: false,
    },
    unreadCount: typeof response.data.unreadCount === 'number' ? response.data.unreadCount : 0,
  };
}

export async function fetchNotificationsSummary(): Promise<NotificationsSummary> {
  const page = await fetchNotificationsPage();
  return {
    notifications: page.notifications,
    unreadCount: page.unreadCount,
  };
}

export function notifyNotificationsChanged(detail?: unknown) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail }));
}

export function shouldRunThrottledRefetch(lastRunAt: number, now: number, throttleMs = NOTIFICATION_REFETCH_THROTTLE_MS) {
  return lastRunAt <= 0 || now - lastRunAt >= throttleMs;
}

export function shouldShowNotificationToast(
  notification: Notification | undefined,
  pathname: string,
  visibilityState: DocumentVisibilityState | 'visible' | 'hidden' | 'prerender' = 'visible'
) {
  if (!notification) return false;
  if (pathname.includes('/notifications')) return false;
  if (visibilityState !== 'visible') return false;
  return TOAST_CATEGORIES.has(String(notification.category ?? ''));
}

export function getNotificationToastText(notification: Notification) {
  return notification.body ? `${notification.title}: ${notification.body}` : notification.title;
}

export function getGroupedNotificationToastText(count: number) {
  return `Новых уведомлений: ${count}`;
}

export function applyNotificationEventToList(
  notifications: Notification[],
  event: NotificationRealtimeEvent,
  payload: NotificationRealtimePayload,
  readAt = new Date().toISOString()
) {
  switch (event) {
    case 'notification:new': {
      const notification = (payload as NotificationNewPayload).notification;
      if (!notification || notifications.some(item => item.id === notification.id)) return notifications;
      return [notification, ...notifications];
    }
    case 'notification:read': {
      const notificationId = (payload as NotificationActionPayload).notificationId;
      if (typeof notificationId !== 'number') return notifications;
      return notifications.map(item => (
        item.id === notificationId
          ? { ...item, isRead: true, readAt: item.readAt ?? readAt }
          : item
      ));
    }
    case 'notification:unread': {
      const notificationId = (payload as NotificationActionPayload).notificationId;
      if (typeof notificationId !== 'number') return notifications;
      return notifications.map(item => (
        item.id === notificationId
          ? { ...item, isRead: false, readAt: null }
          : item
      ));
    }
    case 'notification:read_all':
      return notifications.map(item => ({ ...item, isRead: true, readAt: item.readAt ?? readAt }));
    case 'notification:deleted': {
      const notificationId = (payload as NotificationActionPayload).notificationId;
      if (typeof notificationId !== 'number') return notifications;
      return notifications.filter(item => item.id !== notificationId);
    }
    case 'notification:unread_count_changed':
    default:
      return notifications;
  }
}

export function applyUnreadCount(
  current: number,
  event: NotificationRealtimeEvent,
  payload: NotificationRealtimePayload
) {
  if (typeof payload?.unreadCount === 'number') return payload.unreadCount;
  if (event === 'notification:new') {
    const notification = (payload as NotificationNewPayload).notification;
    return notification && !notification.isRead ? current + 1 : current;
  }
  if (event === 'notification:unread') {
    return current + 1;
  }
  if (event === 'notification:read_all') return 0;
  return current;
}

export function isNotificationBroadcastMessage(value: unknown): value is NotificationBroadcastMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<NotificationBroadcastMessage>;
  return message.type === 'event' || message.type === 'summary';
}

export function createNotificationsChannel(onMessage: (message: NotificationBroadcastMessage) => void) {
  if (typeof BroadcastChannel === 'undefined') return null;

  try {
    const channel = new BroadcastChannel(NOTIFICATION_BROADCAST_CHANNEL);
    channel.onmessage = event => {
      if (isNotificationBroadcastMessage(event.data)) onMessage(event.data);
    };

    return {
      post(message: NotificationBroadcastMessage) {
        channel.postMessage(message);
      },
      close() {
        channel.close();
      },
    };
  } catch {
    return null;
  }
}
