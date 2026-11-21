import { Outlet, useLocation } from 'react-router';
import { useAuth } from '../../hooks/useAuth';
import { AlertTriangle, AlertCircle, Clock, ExternalLink, X } from 'lucide-react';
import Sidebar from './Sidebar';
import { MobileChromeProvider } from '../../context/MobileChromeContext';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '../../lib/socket';
import { prefetchDashboardRoutes } from '../../lib/prefetchRoutes';
import toast from 'react-hot-toast';
import type { Notification } from '../../types';
import {
  applyUnreadCount,
  createNotificationsChannel,
  fetchNotificationsSummary,
  getGroupedNotificationToastText,
  getNotificationToastText,
  NOTIFICATION_TOAST_GROUP_MS,
  notifyNotificationsChanged,
  shouldRunThrottledRefetch,
  shouldShowNotificationToast,
  type NotificationActionPayload,
  type NotificationNewPayload,
  type NotificationRealtimeEvent,
  type NotificationRealtimePayload,
} from '../../lib/notificationsRealtime';

function getBlockWarning(blockedAt: string): { daysLeft: number; isUrgent: boolean } | null {
  const deadline = new Date(blockedAt);
  deadline.setDate(deadline.getDate() + 7);
  const daysLeft = Math.ceil((deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft <= 0) return null;
  return { daysLeft, isUrgent: daysLeft <= 2 };
}

function getDaysText(days: number): string {
  if (days === 1) return '1 день';
  if (days >= 2 && days <= 4) return `${days} дня`;
  return `${days} дней`;
}

export default function Layout() {
  const { user, school, subscriptionInfo, logout } = useAuth();
  const location = useLocation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [trialBannerDismissed, setTrialBannerDismissed] = useState(false);
  const [graceBannerDismissed, setGraceBannerDismissed] = useState(false);
  const lastRefetchAtRef = useRef(0);
  const pathnameRef = useRef(location.pathname);
  const seenNotificationIdsRef = useRef<Set<number>>(new Set());
  const toastQueueRef = useRef<Notification[]>([]);
  const toastTimerRef = useRef<number | null>(null);
  const hasNotifications = user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'TEACHER' || user?.role === 'STUDENT' || user?.role === 'PARENT';

  // Warm the heavy dashboard chunks on idle so the first Schedule<->Groups switch is instant.
  useEffect(() => {
    prefetchDashboardRoutes(user?.role);
  }, [user?.role]);

  const refetchUnreadCount = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && !shouldRunThrottledRefetch(lastRefetchAtRef.current, now)) return;

    lastRefetchAtRef.current = now;

    try {
      const summary = await fetchNotificationsSummary();
      setUnreadCount(summary.unreadCount);
      notifyNotificationsChanged({ unreadCount: summary.unreadCount, source: 'refetch' });
    } catch {
      // Realtime events continue to keep the badge best-effort if the fallback GET fails.
    }
  }, []);

  useEffect(() => {
    pathnameRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    if (!hasNotifications || !user?.id) return;

    const socket = getSocket();
    const applyUnreadCountFromEvent = (event: NotificationRealtimeEvent, payload: NotificationRealtimePayload) => {
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
    };

    const channel = createNotificationsChannel(message => {
      if (message.userId && message.userId !== user.id) return;

      if (message.type === 'summary') {
        setUnreadCount(message.unreadCount);
        notifyNotificationsChanged({ unreadCount: message.unreadCount, source: 'broadcast' });
        return;
      }

      applyUnreadCountFromEvent(message.event, message.payload);
      notifyNotificationsChanged({ source: 'broadcast', event: message.event });
    });

    const postMessage = (event: NotificationRealtimeEvent, payload: NotificationRealtimePayload) => {
      channel?.post({ type: 'event', userId: user.id, event, payload });
    };

    const queueToast = (notification: Notification) => {
      toastQueueRef.current = [...toastQueueRef.current, notification];
      if (toastTimerRef.current !== null) return;

      toastTimerRef.current = window.setTimeout(() => {
        const queuedNotifications = toastQueueRef.current;
        toastQueueRef.current = [];
        toastTimerRef.current = null;

        if (queuedNotifications.length === 1) {
          toast(getNotificationToastText(queuedNotifications[0]), { duration: 5000 });
          return;
        }

        if (queuedNotifications.length > 1) {
          toast(getGroupedNotificationToastText(queuedNotifications.length), { duration: 5000 });
        }
      }, NOTIFICATION_TOAST_GROUP_MS);
    };

    const onNotificationNew = (payload: NotificationNewPayload) => {
      applyUnreadCountFromEvent('notification:new', payload);
      notifyNotificationsChanged({ source: 'socket', event: 'notification:new' });
      postMessage('notification:new', payload);

      const notification = payload.notification;
      if (!notification || !shouldShowNotificationToast(notification, pathnameRef.current, document.visibilityState)) return;

      queueToast(notification);
    };
    const onNotificationCountChanged = (event: NotificationRealtimeEvent) => (payload: NotificationActionPayload) => {
      applyUnreadCountFromEvent(event, payload);
      notifyNotificationsChanged({ source: 'socket', event });
      postMessage(event, payload);
    };
    const onUnreadCountChanged = onNotificationCountChanged('notification:unread_count_changed');
    const onNotificationRead = onNotificationCountChanged('notification:read');
    const onNotificationReadAll = onNotificationCountChanged('notification:read_all');
    const onNotificationDeleted = onNotificationCountChanged('notification:deleted');
    const onSocketConnect = () => void refetchUnreadCount();
    const onWindowFocus = () => void refetchUnreadCount();

    socket.on('notification:new', onNotificationNew);
    socket.on('notification:unread_count_changed', onUnreadCountChanged);
    socket.on('notification:read', onNotificationRead);
    socket.on('notification:read_all', onNotificationReadAll);
    socket.on('notification:deleted', onNotificationDeleted);
    socket.on('connect', onSocketConnect);
    window.addEventListener('focus', onWindowFocus);
    void refetchUnreadCount(true);

    return () => {
      socket.off('notification:new', onNotificationNew);
      socket.off('notification:unread_count_changed', onUnreadCountChanged);
      socket.off('notification:read', onNotificationRead);
      socket.off('notification:read_all', onNotificationReadAll);
      socket.off('notification:deleted', onNotificationDeleted);
      socket.off('connect', onSocketConnect);
      window.removeEventListener('focus', onWindowFocus);
      channel?.close();
      toastQueueRef.current = [];
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [hasNotifications, refetchUnreadCount, user?.id]);

  // The trial banner is dismissible. We remember the dismissal against the current
  // remaining-days value so it stays closed until the countdown changes (re-nags once
  // per day), surviving reloads and navigation.
  useEffect(() => {
    if (subscriptionInfo?.status !== 'TRIALING') {
      setTrialBannerDismissed(false);
      return;
    }
    try {
      const stored = localStorage.getItem('trialBannerDismissedDays');
      setTrialBannerDismissed(stored !== null && Number(stored) === subscriptionInfo.trialDaysLeft);
    } catch {
      setTrialBannerDismissed(false);
    }
  }, [subscriptionInfo?.status, subscriptionInfo?.trialDaysLeft]);

  const dismissTrialBanner = useCallback(() => {
    setTrialBannerDismissed(true);
    if (subscriptionInfo?.status !== 'TRIALING') return;
    try {
      localStorage.setItem('trialBannerDismissedDays', String(subscriptionInfo.trialDaysLeft));
    } catch {
      // localStorage unavailable (private mode etc.) — dismissal stays in-memory only.
    }
  }, [subscriptionInfo?.status, subscriptionInfo?.trialDaysLeft]);

  // The grace-period banner is dismissible too. We remember the dismissal against the
  // current remaining-days value so it re-nags once per day as the deadline approaches.
  useEffect(() => {
    if (subscriptionInfo?.status !== 'GRACE_PERIOD') {
      setGraceBannerDismissed(false);
      return;
    }
    try {
      const stored = localStorage.getItem('graceBannerDismissedDays');
      setGraceBannerDismissed(stored !== null && Number(stored) === subscriptionInfo.graceDaysLeft);
    } catch {
      setGraceBannerDismissed(false);
    }
  }, [subscriptionInfo?.status, subscriptionInfo?.graceDaysLeft]);

  const dismissGraceBanner = useCallback(() => {
    setGraceBannerDismissed(true);
    if (subscriptionInfo?.status !== 'GRACE_PERIOD') return;
    try {
      localStorage.setItem('graceBannerDismissedDays', String(subscriptionInfo.graceDaysLeft));
    } catch {
      // localStorage unavailable (private mode etc.) — dismissal stays in-memory only.
    }
  }, [subscriptionInfo?.status, subscriptionInfo?.graceDaysLeft]);

  const showWarning =
    school?.blockedAt &&
    (user?.role === 'OWNER' || user?.role === 'ADMIN');

  const warning = showWarning ? getBlockWarning(school!.blockedAt!) : null;

  return (
    <MobileChromeProvider>
    <div className="min-h-screen bg-background font-sans text-textPrimary">
      <Sidebar
        hasUnreadNotifications={unreadCount > 0}
        onCollapsedChange={setSidebarCollapsed}
        onLogout={logout}
      />
      <main className={`${sidebarCollapsed ? 'md:ml-[80px]' : 'md:ml-[272px]'} relative min-h-screen flex flex-col`}>
        <div className="mx-auto w-full max-w-[1600px] flex-1 px-4 pb-24 pt-4 sm:px-6 md:px-8 md:pb-0 md:pt-5 xl:px-10">
          {subscriptionInfo?.status === 'TRIALING' && !trialBannerDismissed && (
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#cfe5dc] bg-[#E3F1EC] px-4 py-3 text-sm font-medium text-[#008060] shadow-sm">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 shrink-0 text-[#008060]" />
                <span>
                  Пробный период: осталось {getDaysText(subscriptionInfo.trialDaysLeft)}. Для бесперебойной работы выберите тариф.
                </span>
              </div>
              <button
                type="button"
                onClick={dismissTrialBanner}
                aria-label="Закрыть"
                className="shrink-0 rounded p-1 text-[#008060] transition-colors hover:bg-[#cfe5dc]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {subscriptionInfo?.status === 'GRACE_PERIOD' && !graceBannerDismissed && (
            <div className={`mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#F5C77B] bg-[#FFF5E9] px-4 py-3 text-sm font-medium text-[#916A00] shadow-sm ${
              subscriptionInfo.graceDaysLeft <= 2 ? 'animate-pulse' : ''
            }`}>
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-[#916A00]" />
                <span>
                  Внимание: оплата подписки просрочена. Доступ будет заблокирован через {getDaysText(subscriptionInfo.graceDaysLeft)}.
                </span>
              </div>
              <div className="flex items-center gap-2">
                {user?.role === 'OWNER' && (
                  <a
                    href="https://t.me/eduschool_support"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-bold underline hover:text-[#7a5900] transition-colors"
                  >
                    Оплатить подписку
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={dismissGraceBanner}
                  aria-label="Закрыть"
                  className="shrink-0 rounded p-1 text-[#916A00] transition-colors hover:bg-[#F5E2C0]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {subscriptionInfo?.status === 'OVERDUE' && (
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-4 py-3 text-sm font-semibold text-[#D72C0D] shadow-sm animate-pulse">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-[#D72C0D]" />
                <span>
                  Режим чтения: подписка истекла. Запись и редактирование данных заблокированы. Продлите подписку для восстановления доступа.
                </span>
              </div>
              {user?.role === 'OWNER' && (
                <a
                  href="https://t.me/eduschool_support"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-bold underline hover:text-[#b71c1c] transition-colors"
                >
                  Продлить подписку
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          {warning && (
            <div className={`mb-6 flex items-center gap-2 rounded-lg px-3.5 py-2 text-caption font-semibold ${
              warning.isUrgent
                ? 'bg-[#FFF4F4] text-critical animate-pulse border border-[#F5C0BC]'
                : 'bg-[#FFF5E9] text-[#916A00] border border-[#F5C77B]'
            }`}>
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              <span>
                Доступ закроется через {warning.daysLeft} {warning.daysLeft === 1 ? 'день' : warning.daysLeft < 5 ? 'дня' : 'дней'} - свяжитесь с администратором
              </span>
            </div>
          )}
          <Outlet />
        </div>
      </main>
    </div>
    </MobileChromeProvider>
  );
}
