import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Bell,
  CheckCheck,
  Inbox,
  SlidersHorizontal,
  MoreHorizontal,
  Settings,
  CreditCard,
  Calendar,
  User,
  Users,
  Zap,
  Megaphone,
  GraduationCap,
  ArrowRight,
  Eye,
  ExternalLink,
  CheckCircle,
  Info
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import SearchInput from '../../components/ui/SearchInput';
import { Spinner } from '../../components/ui/Spinner';
import { Button } from '../../components/ui/Button';
import api from '../../lib/api';
import { getSocket } from '../../lib/socket';
import type { Notification, NotificationFilters, NotificationPagination } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import {
  applyNotificationEventToList,
  applyUnreadCount,
  createNotificationsChannel,
  fetchNotificationsPage,
  notifyNotificationsChanged,
  shouldRunThrottledRefetch,
  type NotificationActionPayload,
  type NotificationNewPayload,
  type NotificationRealtimeEvent,
  type NotificationRealtimePayload,
} from '../../lib/notificationsRealtime';

const NOTIFICATIONS_PAGE_LIMIT = 20;

const CATEGORY_LABELS: Record<string, string> = {
  SYSTEM: 'Система',
  FINANCE: 'Финансы',
  SCHEDULE: 'Расписание',
  STUDENTS: 'Ученики',
  STAFF: 'Сотрудники',
  SUBSCRIPTION: 'Подписка',
  ANNOUNCEMENT: 'Объявления',
  ACADEMICS: 'Обучение',
};

const CATEGORY_STYLES: Record<string, string> = {
  SYSTEM: 'border-slate-200 bg-slate-50 text-slate-700',
  FINANCE: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  SCHEDULE: 'border-blue-200 bg-blue-50 text-blue-700',
  STUDENTS: 'border-violet-200 bg-violet-50 text-violet-700',
  STAFF: 'border-teal-200 bg-teal-50 text-teal-700',
  SUBSCRIPTION: 'border-amber-200 bg-amber-50 text-amber-700',
  ANNOUNCEMENT: 'border-rose-200 bg-rose-50 text-rose-700',
  ACADEMICS: 'border-indigo-200 bg-indigo-50 text-indigo-700',
};



import {
  getActionUrl,
  getCategory,
  getNotificationStatusDotClass,
  getPriority,
  groupNotificationsByDate
} from '../../lib/notificationsHelpers';

function getNotificationCategoryIcon(category: string) {
  switch (category) {
    case 'SYSTEM':
      return Settings;
    case 'FINANCE':
      return CreditCard;
    case 'SCHEDULE':
      return Calendar;
    case 'STUDENTS':
      return User;
    case 'STAFF':
      return Users;
    case 'SUBSCRIPTION':
      return Zap;
    case 'ANNOUNCEMENT':
      return Megaphone;
    case 'ACADEMICS':
      return GraduationCap;
    default:
      return Bell;
  }
}

function formatNotificationTime(value: string, dateGroupLabel?: string) {
  const date = new Date(value);
  const timeStr = date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (dateGroupLabel === 'Ранее') {
    const dateStr = date.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
    });
    return `${dateStr}, ${timeStr}`;
  }
  return timeStr;
}

function getNotificationActionLabel(notification: Notification): string {
  const type = notification.type || '';
  const actionUrl = getActionUrl(notification) || '';
  
  if (actionUrl.includes('/groups/')) {
    return 'Открыть группу';
  }
  if (actionUrl.includes('/leads/')) {
    return 'Открыть лид';
  }
  if (actionUrl.includes('/classes/') || actionUrl.includes('/schedule')) {
    return 'Перейти';
  }
  if (type === 'ANNOUNCEMENT' || type.includes('ANNOUNCEMENT')) {
    return 'Посмотреть';
  }
  if (type.includes('PAYMENT') || type.includes('INVOICE') || type.includes('FINANCE')) {
    return 'Посмотреть';
  }
  return 'Открыть';
}

function getActionIcon(label: string) {
  switch (label) {
    case 'Открыть группу':
    case 'Открыть лид':
    case 'Открыть':
      return ExternalLink;
    case 'Посмотреть':
      return Eye;
    case 'Перейти':
      return ArrowRight;
    case 'Подтвердить':
      return CheckCircle;
    case 'Подробнее':
      return Info;
    default:
      return undefined;
  }
}


function emptyPagination(limit = NOTIFICATIONS_PAGE_LIMIT): NotificationPagination {
  return {
    page: 1,
    limit,
    total: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPrevPage: false,
  };
}

function toNotificationStatus(status: 'ALL' | 'UNREAD' | 'READ' | 'ATTENTION'): NotificationFilters['status'] {
  if (status === 'UNREAD' || status === 'ATTENTION') return 'unread';
  if (status === 'READ') return 'read';
  return 'all';
}

function notificationMatchesFilters(
  notification: Notification,
  filters: Pick<NotificationFilters, 'status' | 'category' | 'priority' | 'search'>
) {
  const read = notification.isRead || Boolean(notification.readAt);
  if (filters.status === 'unread' && read) return false;
  if (filters.status === 'read' && !read) return false;
  if (filters.category && getCategory(notification) !== filters.category) return false;
  if (filters.priority && getPriority(notification) !== filters.priority) return false;

  const query = filters.search?.trim().toLowerCase();
  if (!query) return true;

  const values = [
    notification.title,
    notification.body,
    notification.type,
    getCategory(notification),
    CATEGORY_LABELS[getCategory(notification)],
    notification.entityType,
    typeof notification.entityId === 'number' ? String(notification.entityId) : undefined,
  ];

  return values.some(value => value?.toLowerCase().includes(query));
}

export default function NotificationsInbox() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pagination, setPagination] = useState<NotificationPagination>(() => emptyPagination());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);

  useEffect(() => {
    const handleOutsideClick = () => setOpenMenuId(null);
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  // Filter States
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'UNREAD' | 'READ' | 'ATTENTION'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'>('ALL');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const lastRefetchAtRef = useRef(0);
  const seenNotificationIdsRef = useRef<Set<number>>(new Set());
  const channelRef = useRef<ReturnType<typeof createNotificationsChannel> | null>(null);
  const filtersRef = useRef<NotificationFilters>({
    page: 1,
    limit: NOTIFICATIONS_PAGE_LIMIT,
    status: 'all',
    sort: 'createdAt_desc',
  });

  const postEvent = useCallback((event: NotificationRealtimeEvent, payload: NotificationRealtimePayload) => {
    if (!user?.id) return;
    channelRef.current?.post({ type: 'event', userId: user.id, event, payload });
  }, [user?.id]);

  const getListFilters = useCallback((page = 1): NotificationFilters => ({
    page,
    limit: NOTIFICATIONS_PAGE_LIMIT,
    status: toNotificationStatus(statusFilter),
    category: categoryFilter === 'ALL' ? undefined : categoryFilter,
    priority: priorityFilter === 'ALL' ? undefined : priorityFilter,
    search: debouncedSearchQuery.trim() || undefined,
    sort: 'createdAt_desc',
  }), [categoryFilter, debouncedSearchQuery, priorityFilter, statusFilter]);

  const loadNotificationsPage = useCallback(async (page = 1, append = false, showSpinner = true) => {
    const filters = getListFilters(page);
    filtersRef.current = filters;

    if (append) setLoadingMore(true);
    else if (showSpinner) setLoading(true);
    setError('');

    try {
      const result = await fetchNotificationsPage(filters);
      setNotifications(prev => (append ? [...prev, ...result.notifications] : result.notifications));
      setPagination(result.pagination);
      setUnreadCount(result.unreadCount);
      lastRefetchAtRef.current = Date.now();
      notifyNotificationsChanged({ unreadCount: result.unreadCount, source: append ? 'load-more' : 'refetch' });
    } catch {
      setError('Не удалось загрузить уведомления');
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, [getListFilters]);

  const applyRealtimeEvent = useCallback((
    event: NotificationRealtimeEvent,
    payload: NotificationRealtimePayload,
    source: 'socket' | 'broadcast' | 'local',
    broadcast = false
  ) => {
    setNotifications(prev => {
      const activeFilters = filtersRef.current;
      const next = applyNotificationEventToList(prev, event, payload);

      if (event === 'notification:new') {
        const notification = (payload as NotificationNewPayload).notification;
        if (!notification || !notificationMatchesFilters(notification, activeFilters)) return prev;
      }

      if (event === 'notification:read' || event === 'notification:read_all' || event === 'notification:unread') {
        return next.filter(notification => notificationMatchesFilters(notification, activeFilters));
      }

      return next;
    });
    if (event === 'notification:new') {
      const notification = (payload as NotificationNewPayload).notification;
      if (notification && notificationMatchesFilters(notification, filtersRef.current)) {
        setPagination(prev => ({ ...prev, total: prev.total + 1 }));
      }
    }
    setUnreadCount(prev => {
      if (event === 'notification:new') {
        const notificationId = (payload as NotificationNewPayload).notification?.id;
        const hasServerCount = typeof payload.unreadCount === 'number';
        if (typeof notificationId === 'number') {
          const alreadySeen = seenNotificationIdsRef.current.has(notificationId);
          seenNotificationIdsRef.current.add(notificationId);
          if (alreadySeen && !hasServerCount) return prev;
        }
      }

      return applyUnreadCount(prev, event, payload);
    });
    notifyNotificationsChanged({ source, event });
    if (broadcast) postEvent(event, payload);
  }, [postEvent]);

  const refetchNotifications = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && !shouldRunThrottledRefetch(lastRefetchAtRef.current, now)) return;

    try {
      await loadNotificationsPage(1, false, false);
    } catch {
      // The visible list keeps its current state if a reconnect/focus refresh fails.
    }
  }, [loadNotificationsPage]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);

    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  useEffect(() => {
    void loadNotificationsPage(1);
  }, [loadNotificationsPage]);

  useEffect(() => {
    if (!user?.id) return;

    const socket = getSocket();
    const channel = createNotificationsChannel(message => {
      if (message.userId && message.userId !== user.id) return;

      if (message.type === 'summary') {
        const activeFilters = filtersRef.current;
        const canReplaceVisibleList = !activeFilters.search && activeFilters.status === 'all' && !activeFilters.category && !activeFilters.priority;
        if (message.notifications && canReplaceVisibleList) setNotifications(message.notifications);
        setUnreadCount(message.unreadCount);
        notifyNotificationsChanged({ unreadCount: message.unreadCount, source: 'broadcast' });
        return;
      }

      applyRealtimeEvent(message.event, message.payload, 'broadcast');
    });
    channelRef.current = channel;

    const onNotificationNew = (payload: NotificationNewPayload) => applyRealtimeEvent('notification:new', payload, 'socket', true);
    const onNotificationRead = (payload: NotificationActionPayload) => applyRealtimeEvent('notification:read', payload, 'socket', true);
    const onNotificationUnread = (payload: NotificationActionPayload) => applyRealtimeEvent('notification:unread', payload, 'socket', true);
    const onNotificationReadAll = (payload: NotificationActionPayload) => applyRealtimeEvent('notification:read_all', payload, 'socket', true);
    const onNotificationDeleted = (payload: NotificationActionPayload) => applyRealtimeEvent('notification:deleted', payload, 'socket', true);
    const onNotificationCountChanged = (payload: NotificationActionPayload) => applyRealtimeEvent('notification:unread_count_changed', payload, 'socket', true);

    socket.on('notification:new', onNotificationNew);
    socket.on('notification:read', onNotificationRead);
    socket.on('notification:unread', onNotificationUnread);
    socket.on('notification:read_all', onNotificationReadAll);
    socket.on('notification:deleted', onNotificationDeleted);
    socket.on('notification:unread_count_changed', onNotificationCountChanged);

    return () => {
      socket.off('notification:new', onNotificationNew);
      socket.off('notification:read', onNotificationRead);
      socket.off('notification:unread', onNotificationUnread);
      socket.off('notification:read_all', onNotificationReadAll);
      socket.off('notification:deleted', onNotificationDeleted);
      socket.off('notification:unread_count_changed', onNotificationCountChanged);
      channel?.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [applyRealtimeEvent, user?.id]);

  useEffect(() => {
    const socket = getSocket();
    const onSocketConnect = () => void refetchNotifications();
    const onWindowFocus = () => void refetchNotifications();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refetchNotifications();
    };

    socket.on('connect', onSocketConnect);
    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      socket.off('connect', onSocketConnect);
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refetchNotifications]);

  async function markNotificationRead(id: number) {
    const wasUnread = notifications.find(item => item.id === id)?.isRead === false;
    setBusyId(id);

    try {
      await api.patch(`/notifications/${id}/read`);
      const nextUnreadCount = wasUnread ? Math.max(0, unreadCount - 1) : unreadCount;
      setNotifications(prev => prev
        .map(item => (item.id === id ? { ...item, isRead: true, readAt: item.readAt ?? new Date().toISOString() } : item))
        .filter(item => notificationMatchesFilters(item, filtersRef.current)));
      setUnreadCount(nextUnreadCount);
      notifyNotificationsChanged({ unreadCount: nextUnreadCount, source: 'local', event: 'notification:read' });
      postEvent('notification:read', { notificationId: id, unreadCount: nextUnreadCount });
    } catch {
      toast.error('Не удалось отметить уведомление');
    } finally {
      setBusyId(null);
    }
  }

  async function markNotificationUnread(id: number) {
    const wasRead = notifications.find(item => item.id === id)?.isRead === true;
    setBusyId(id);

    try {
      await api.patch(`/notifications/${id}/unread`);
      const nextUnreadCount = wasRead ? unreadCount + 1 : unreadCount;
      setNotifications(prev => prev
        .map(item => (item.id === id ? { ...item, isRead: false, readAt: null } : item))
        .filter(item => notificationMatchesFilters(item, filtersRef.current)));
      setUnreadCount(nextUnreadCount);
      notifyNotificationsChanged({ unreadCount: nextUnreadCount, source: 'local', event: 'notification:unread' });
      postEvent('notification:unread', { notificationId: id, unreadCount: nextUnreadCount });
    } catch {
      toast.error('Не удалось отметить как непрочитанное');
    } finally {
      setBusyId(null);
    }
  }

  async function markAllNotificationsRead() {
    setMarkingAll(true);
    try {
      await api.patch('/notifications/read-all');
      const readAt = new Date().toISOString();
      setNotifications(prev => prev
        .map(item => ({ ...item, isRead: true, readAt: item.readAt ?? readAt }))
        .filter(item => notificationMatchesFilters(item, filtersRef.current)));
      setUnreadCount(0);
      notifyNotificationsChanged({ unreadCount: 0, source: 'local', event: 'notification:read_all' });
      postEvent('notification:read_all', { unreadCount: 0 });
      toast.success('Все уведомления отмечены как прочитанные');
    } catch {
      toast.error('Не удалось отметить уведомления');
    } finally {
      setMarkingAll(false);
    }
  }

  const filteredNotifications = notifications.filter(notification => {
    if (statusFilter !== 'ATTENTION') return true;
    const priority = getPriority(notification);
    const actionUrl = getActionUrl(notification);
    return priority === 'CRITICAL' || priority === 'HIGH' || Boolean(actionUrl);
  });

  const sortedNotifications = [...filteredNotifications].sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    return sortOrder === 'newest' ? timeB - timeA : timeA - timeB;
  });

  const groupedNotifications = groupNotificationsByDate(sortedNotifications);

  if (loading) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center">
        <Spinner />
        <p className="mt-4 animate-pulse text-sm italic text-textSecondary">Загрузка уведомлений...</p>
      </div>
    );
  }

  const hasAnyFiltersActive = searchQuery !== '' || statusFilter !== 'ALL' || categoryFilter !== 'ALL' || priorityFilter !== 'ALL';

  return (
    <div className="text-textPrimary">
      <header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <h1 className="font-serif text-2xl text-textPrimary">Уведомления</h1>
          {unreadCount > 0 && (
            <span className="rounded-full bg-primary px-3 py-1 text-xs font-black text-white">
              {unreadCount}
            </span>
          )}
        </div>

        {unreadCount > 0 && (
          <Button variant="outline" size="sm" onClick={markAllNotificationsRead} isLoading={markingAll}>
            <CheckCheck className="h-4 w-4" />
            Отметить все прочитанными
          </Button>
        )}
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-4 py-3 text-sm font-medium text-critical">
          {error}
        </div>
      )}

      {/* Tabs */}
      {!error && (
        <div className="mb-6 flex flex-wrap gap-2">
          {([
            { id: 'ALL', label: 'Все', count: pagination.total },
            { id: 'UNREAD', label: 'Непрочитанные', count: unreadCount },
            { id: 'ATTENTION', label: 'Требуют внимания', count: notifications.filter(n => {
                const priority = getPriority(n);
                const actionUrl = getActionUrl(n);
                return !n.isRead && (priority === 'CRITICAL' || priority === 'HIGH' || Boolean(actionUrl));
              }).length }
          ] as const).map(tab => {
            const isActive = statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-semibold transition ${
                  isActive
                    ? 'border-primary bg-primary/5 text-primary font-bold'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <span>{tab.label}</span>
                {tab.count > 0 && (
                  <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${
                    isActive ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600'
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Search and Sort row */}
      {!error && (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          {/* Search */}
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Поиск по уведомлениям..."
            className="flex-1"
          />

          {/* Filter Toggle */}
          <button
            type="button"
            onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
            className={`flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-semibold transition ${
              showAdvancedFilters || categoryFilter !== 'ALL' || priorityFilter !== 'ALL'
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span>Фильтр</span>
          </button>

          {/* Sort Select */}
          <div className="relative">
            <select
              value={sortOrder}
              onChange={e => setSortOrder(e.target.value as 'newest' | 'oldest')}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 pr-8 text-sm font-semibold text-slate-600 focus:border-primary focus:outline-none appearance-none cursor-pointer"
            >
              <option value="newest">Сначала новые</option>
              <option value="oldest">Сначала старые</option>
            </select>
            <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 border-slate-500 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[4px] border-t-slate-500" />
          </div>
        </div>
      )}

      {/* Advanced Filters Expandable Panel */}
      {!error && (showAdvancedFilters || categoryFilter !== 'ALL' || priorityFilter !== 'ALL') && (
        <div className="mb-6 rounded-xl border border-slate-150 bg-slate-50/50 p-4">
          <div className="flex flex-wrap items-center gap-4">
            {/* Category Dropdown */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Категория</span>
              <select
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 focus:border-primary focus:outline-none"
              >
                <option value="ALL">Все категории</option>
                {Object.entries(CATEGORY_LABELS).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value}
                  </option>
                ))}
              </select>
            </div>

            {/* Priority Dropdown */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Важность</span>
              <select
                value={priorityFilter}
                onChange={e => setPriorityFilter(e.target.value as 'ALL' | 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL')}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 focus:border-primary focus:outline-none"
              >
                <option value="ALL">Все важности</option>
                <option value="LOW">LOW</option>
                <option value="NORMAL">NORMAL</option>
                <option value="HIGH">Важные (HIGH)</option>
                <option value="CRITICAL">Критические (CRITICAL)</option>
              </select>
            </div>

            {/* Reset Filters Link */}
            {hasAnyFiltersActive && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setStatusFilter('ALL');
                  setCategoryFilter('ALL');
                  setPriorityFilter('ALL');
                }}
                className="mt-5 text-xs font-bold text-critical hover:underline"
              >
                Сбросить фильтры
              </button>
            )}
          </div>
        </div>
      )}

      {/* Empty state: No notifications at all */}
      {!error && notifications.length === 0 && !hasAnyFiltersActive && (
        <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-surfaceLow">
            <Inbox className="h-9 w-9 text-textSecondary/40" />
          </div>
          <p className="font-serif text-base italic text-textSecondary">Уведомлений пока нет</p>
          <p className="max-w-md text-xs font-bold uppercase tracking-[0.16em] text-textSecondary/60">
            Здесь появятся сообщения от системы и администрации школы
          </p>
        </div>
      )}

      {/* Empty state: Filters returned no results */}
      {!error && filteredNotifications.length === 0 && hasAnyFiltersActive && (
        <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-surfaceLow">
            <SlidersHorizontal className="h-9 w-9 text-textSecondary/40" />
          </div>
          <p className="font-serif text-base italic text-textSecondary">По выбранным фильтрам уведомлений нет</p>
          <p className="max-w-md text-xs font-bold uppercase tracking-[0.16em] text-textSecondary/60">
            Попробуйте сбросить фильтры или изменить поисковый запрос
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSearchQuery('');
              setStatusFilter('ALL');
              setCategoryFilter('ALL');
              setPriorityFilter('ALL');
            }}
            className="mt-2"
          >
            Сбросить фильтры
          </Button>
        </div>
      )}

      {/* Notification Table-Row List */}
      {!error && notifications.length > 0 && filteredNotifications.length > 0 && (
        <div className="space-y-6">
          {groupedNotifications.map(group => (
            <div key={group.label}>
              <h3 className="font-bold text-xs uppercase tracking-wider text-slate-400 mb-3 px-1">{group.label}</h3>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden bg-white shadow-sm">
                {group.items.map(notification => {
                  const actionUrl = getActionUrl(notification);
                  const category = getCategory(notification);
                  const read = notification.isRead || Boolean(notification.readAt);
                  const IconComponent = getNotificationCategoryIcon(category);
                  const dotClass = getNotificationStatusDotClass(notification);

                  const actionLabel = getNotificationActionLabel(notification);
                  const ActionIcon = getActionIcon(actionLabel);

                  return (
                    <div
                      key={notification.id}
                      className={`grid grid-cols-[12px_32px_1fr_auto] md:grid-cols-[12px_40px_minmax(0,1fr)_136px_128px_128px_32px] items-center gap-x-3 gap-y-2 md:gap-x-4 px-4 py-3.5 transition-colors hover:bg-slate-50/50 border-b border-slate-100 last:border-0 ${
                        read ? 'bg-white text-slate-700/80' : 'bg-primary/[0.01]'
                      }`}
                      data-testid="notification-row"
                    >
                      {/* Color dot */}
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 self-center justify-self-center ${dotClass}`}
                        data-testid="notification-status-dot"
                      />

                      {/* Category Icon */}
                      <div className="flex h-8 w-8 md:h-10 md:w-10 items-center justify-center rounded-full bg-slate-50 text-slate-600 border border-slate-100 shrink-0 self-center justify-self-center">
                        <IconComponent className="h-4 w-4 md:h-5 md:w-5" />
                      </div>

                      {/* Title and Description */}
                      <div className="min-w-0 flex flex-col justify-center">
                        <p className={`text-sm leading-snug truncate ${read ? 'text-slate-700 font-medium' : 'text-slate-900 font-bold'}`}>
                          {notification.title}
                        </p>
                        <p className="text-xs text-slate-500 truncate mt-0.5">{notification.body}</p>
                      </div>

                      {/* Category Badge (desktop only) */}
                      <div className="hidden md:flex items-center justify-end min-w-0 w-full">
                        {category ? (
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold border truncate whitespace-nowrap ${CATEGORY_STYLES[category] ?? CATEGORY_STYLES.SYSTEM}`}
                            data-testid="notification-category-badge"
                          >
                            {CATEGORY_LABELS[category] ?? category}
                          </span>
                        ) : null}
                      </div>

                      {/* Time (desktop only) */}
                      <div
                        className="hidden md:block text-right text-xs text-slate-400 font-medium whitespace-nowrap tabular-nums min-w-max justify-self-end w-full"
                        data-testid="notification-time"
                      >
                        {formatNotificationTime(notification.createdAt, group.label)}
                      </div>

                      {/* Action Button (desktop only) */}
                      <div className="hidden md:flex items-center justify-end min-w-[128px] w-full shrink-0" data-testid="notification-action-slot">
                        {actionUrl ? (
                          <Link
                            to={actionUrl}
                            className="h-9 min-w-[112px] px-4 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-1.5 border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs font-bold text-primary transition hover:bg-primary hover:text-white"
                            data-testid="notification-action-button"
                          >
                            <span>{actionLabel}</span>
                            {ActionIcon && <ActionIcon className="h-4 w-4" />}
                          </Link>
                        ) : null}
                      </div>

                      {/* Dropdown Menu */}
                      <div className="relative shrink-0 justify-self-end w-8 flex justify-center" onClick={e => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => setOpenMenuId(openMenuId === notification.id ? null : notification.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
                          aria-label="Опции"
                          data-testid="notification-actions-menu"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                        {openMenuId === notification.id && (
                          <div className="absolute right-0 mt-1 w-48 rounded-lg bg-white py-1 shadow-lg ring-1 ring-black ring-opacity-5 z-10 border border-slate-100">
                            {read ? (
                              <button
                                type="button"
                                onClick={() => {
                                  void markNotificationUnread(notification.id);
                                  setOpenMenuId(null);
                                }}
                                disabled={busyId === notification.id}
                                className="flex w-full items-center px-4 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              >
                                Отметить как непрочитанное
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  void markNotificationRead(notification.id);
                                  setOpenMenuId(null);
                                }}
                                disabled={busyId === notification.id}
                                className="flex w-full items-center px-4 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              >
                                Отметить как прочитанное
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Mobile metadata row */}
                      <div className="col-start-3 col-span-2 md:hidden flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-0.5">
                        {category && (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold border ${CATEGORY_STYLES[category] ?? CATEGORY_STYLES.SYSTEM}`}>
                            {CATEGORY_LABELS[category] ?? category}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400 font-medium whitespace-nowrap">
                          {formatNotificationTime(notification.createdAt, group.label)}
                        </span>
                        {actionUrl && (
                          <Link
                            to={actionUrl}
                            className="inline-flex items-center gap-0.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-[10px] font-bold text-primary transition hover:bg-primary hover:text-white"
                          >
                            <span>{actionLabel}</span>
                            {ActionIcon && <ActionIcon className="h-3 w-3" />}
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {pagination.hasNextPage && (
            <div className="flex justify-center pt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadNotificationsPage(pagination.page + 1, true, false)}
                isLoading={loadingMore}
              >
                Загрузить ещё
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
