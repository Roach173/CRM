import { describe, expect, it } from 'vitest';
import type { Notification } from '../types';
import {
  applyNotificationEventToList,
  applyUnreadCount,
  getNotificationItemsFromResponse,
  shouldRunThrottledRefetch,
  shouldShowNotificationToast,
} from './notificationsRealtime';
import {
  getNotificationStatusDotClass,
  groupNotificationsByDate
} from './notificationsHelpers';

function makeNotification(overrides: Partial<Notification> & { id: number }): Notification {
  return {
    id: overrides.id,
    userId: overrides.userId ?? 1,
    schoolId: overrides.schoolId ?? 1,
    type: overrides.type ?? 'ANNOUNCEMENT',
    category: overrides.category ?? 'ANNOUNCEMENT',
    priority: overrides.priority ?? 'NORMAL',
    title: overrides.title ?? `Notification ${overrides.id}`,
    body: overrides.body ?? '',
    actionUrl: overrides.actionUrl ?? null,
    entityType: overrides.entityType ?? null,
    entityId: overrides.entityId ?? null,
    isRead: overrides.isRead ?? false,
    readAt: overrides.readAt ?? null,
    data: overrides.data ?? null,
    createdAt: overrides.createdAt ?? '2026-06-05T00:00:00.000Z',
  };
}

describe('notifications realtime helpers', () => {
  it('adds a new notification once', () => {
    const notification = makeNotification({ id: 10 });
    const first = applyNotificationEventToList([], 'notification:new', { notification });
    const second = applyNotificationEventToList(first, 'notification:new', { notification });

    expect(first).toEqual([notification]);
    expect(second).toHaveLength(1);
  });

  it('applies read, read all, and deleted events idempotently', () => {
    const notifications = [
      makeNotification({ id: 1 }),
      makeNotification({ id: 2 }),
    ];

    const read = applyNotificationEventToList(
      notifications,
      'notification:read',
      { notificationId: 1 },
      '2026-06-05T12:00:00.000Z'
    );
    expect(read[0].isRead).toBe(true);
    expect(read[0].readAt).toBe('2026-06-05T12:00:00.000Z');

    const readAll = applyNotificationEventToList(read, 'notification:read_all', {}, '2026-06-05T12:01:00.000Z');
    expect(readAll.every(item => item.isRead)).toBe(true);

    const deleted = applyNotificationEventToList(readAll, 'notification:deleted', { notificationId: 2 });
    expect(deleted.map(item => item.id)).toEqual([1]);
  });

  it('uses server unread counts and safe fallbacks', () => {
    expect(applyUnreadCount(3, 'notification:new', { notification: makeNotification({ id: 3 }) })).toBe(4);
    expect(applyUnreadCount(3, 'notification:new', { notification: makeNotification({ id: 3 }), unreadCount: 9 })).toBe(9);
    expect(applyUnreadCount(3, 'notification:read_all', {})).toBe(0);
  });

  it('suppresses notification toasts inside the notifications page', () => {
    const notification = makeNotification({ id: 4, category: 'ANNOUNCEMENT' });

    expect(shouldShowNotificationToast(notification, '/school/owner/dashboard', 'visible')).toBe(true);
    expect(shouldShowNotificationToast(notification, '/school/owner/notifications', 'visible')).toBe(false);
    expect(shouldShowNotificationToast(notification, '/school/owner/dashboard', 'hidden')).toBe(false);
  });

  it('throttles reconnect and focus refetches', () => {
    expect(shouldRunThrottledRefetch(0, 1000, 500)).toBe(true);
    expect(shouldRunThrottledRefetch(1000, 1200, 500)).toBe(false);
    expect(shouldRunThrottledRefetch(1000, 1500, 500)).toBe(true);
  });

  it('extracts notifications from legacy and paginated API shapes', () => {
    const notification = makeNotification({ id: 5 });

    expect(getNotificationItemsFromResponse({ data: [notification] })).toEqual([notification]);
    expect(getNotificationItemsFromResponse({
      data: {
        items: [notification],
        pagination: {
          page: 1,
          limit: 20,
          total: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
        unreadCount: 1,
      },
    })).toEqual([notification]);
    expect(getNotificationItemsFromResponse({ data: null })).toEqual([]);
  });

  it('handles notification:unread event and updates list state', () => {
    const notifications = [
      makeNotification({ id: 1, isRead: true, readAt: '2026-06-05T12:00:00.000Z' }),
    ];
    const next = applyNotificationEventToList(notifications, 'notification:unread', { notificationId: 1 });
    expect(next[0].isRead).toBe(false);
    expect(next[0].readAt).toBeNull();
  });

  it('increments unread count on notification:unread event', () => {
    expect(applyUnreadCount(3, 'notification:unread', {})).toBe(4);
  });

  it('determines correct status dot color classes', () => {
    const read = makeNotification({ id: 1, isRead: true });
    const critical = makeNotification({ id: 2, isRead: false, priority: 'CRITICAL' });
    const actionReq = makeNotification({ id: 3, isRead: false, priority: 'HIGH' });
    const actionUrl = makeNotification({ id: 4, isRead: false, actionUrl: '/school/owner/groups' });
    const normal = makeNotification({ id: 5, isRead: false, priority: 'NORMAL' });

    expect(getNotificationStatusDotClass(read)).toBe('bg-slate-300');
    expect(getNotificationStatusDotClass(critical)).toBe('bg-red-500 animate-pulse');
    expect(getNotificationStatusDotClass(actionReq)).toBe('bg-yellow-500');
    expect(getNotificationStatusDotClass(actionUrl)).toBe('bg-yellow-500');
    expect(getNotificationStatusDotClass(normal)).toBe('bg-green-500');
  });

  it('groups notifications by today, yesterday, and earlier dates', () => {
    const todayStr = new Date().toISOString();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString();
    const earlierStr = '2026-05-01T10:00:00.000Z';

    const list = [
      makeNotification({ id: 1, createdAt: todayStr }),
      makeNotification({ id: 2, createdAt: yesterdayStr }),
      makeNotification({ id: 3, createdAt: earlierStr }),
    ];

    const groups = groupNotificationsByDate(list);
    expect(groups).toHaveLength(3);
    expect(groups[0].label).toBe('Сегодня');
    expect(groups[0].items[0].id).toBe(1);
    expect(groups[1].label).toBe('Вчера');
    expect(groups[1].items[0].id).toBe(2);
    expect(groups[2].label).toBe('Ранее');
    expect(groups[2].items[0].id).toBe(3);
  });
});
