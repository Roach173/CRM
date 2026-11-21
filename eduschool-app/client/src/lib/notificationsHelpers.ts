import type { Notification } from '../types';

export function isInternalActionUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return false;
  return !/^(https?:|javascript:)/i.test(trimmed);
}

export function getActionUrl(notification: Notification): string {
  const dataActionUrl = notification.data?.actionUrl;
  const actionUrl = notification.actionUrl || (typeof dataActionUrl === 'string' ? dataActionUrl : '');
  return isInternalActionUrl(actionUrl) ? actionUrl : '';
}

export function getCategory(notification: Notification): string {
  return notification.category || notification.type || 'SYSTEM';
}

export function getPriority(notification: Notification): string {
  return notification.priority || 'NORMAL';
}

export function getNotificationStatusDotClass(notification: Notification): string {
  const read = notification.isRead || Boolean(notification.readAt);
  if (read) {
    return 'bg-slate-300';
  }
  const priority = getPriority(notification);
  const actionUrl = getActionUrl(notification);
  if (priority === 'CRITICAL') {
    return 'bg-red-500 animate-pulse';
  }
  if (priority === 'HIGH' || actionUrl) {
    return 'bg-yellow-500';
  }
  return 'bg-green-500';
}

export function groupNotificationsByDate(items: Notification[]) {
  const groups: { label: string; items: Notification[] }[] = [
    { label: 'Сегодня', items: [] },
    { label: 'Вчера', items: [] },
    { label: 'Ранее', items: [] },
  ];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const item of items) {
    const itemDate = new Date(item.createdAt);
    itemDate.setHours(0, 0, 0, 0);

    if (itemDate.getTime() === today.getTime()) {
      groups[0].items.push(item);
    } else if (itemDate.getTime() === yesterday.getTime()) {
      groups[1].items.push(item);
    } else {
      groups[2].items.push(item);
    }
  }

  return groups.filter(g => g.items.length > 0);
}
