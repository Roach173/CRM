import { Router } from 'express';
import { emitToUser } from '../lib/socket';
import { createLogger } from '../lib/logger';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import {
  getUnreadCount,
  listPreferenceCategoriesForUser,
  listForUser,
  markAllRead,
  markRead,
  markUnread,
  parseNotificationListFilters,
  updatePreferenceCategoriesForUser,
  validatePreferenceUpdates,
} from '../services/notificationService';

const log = createLogger('notifications');
const router = Router();

function emitNotificationEvent(userId: number, event: string, payload: unknown) {
  try {
    emitToUser(userId, event, payload);
  } catch (error) {
    log.warn({ err: error, event }, 'realtime emit failed');
  }
}

router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    const filters = parseNotificationListFilters(req.query);
    const result = await listForUser(userId, filters);

    res.json({
      success: true,
      data: result,
      unreadCount: result.unreadCount,
    });
  } catch (error) {
    log.error({ err: error }, 'list notifications error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

router.get('/preferences', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const categories = await listPreferenceCategoriesForUser(userId);

    res.json({
      success: true,
      data: { categories },
    });
  } catch (error) {
    log.error({ err: error }, 'load notification preferences error');
    res.status(500).json({ success: false, error: 'Failed to load notification preferences' });
  }
});

router.patch('/preferences', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { updates, error } = validatePreferenceUpdates(req.body?.preferences);

    if (error) {
      return res.status(400).json({ success: false, error });
    }

    const categories = await updatePreferenceCategoriesForUser(userId, updates);

    res.json({
      success: true,
      data: { categories },
    });
  } catch (error) {
    log.error({ err: error }, 'update notification preferences error');
    res.status(500).json({ success: false, error: 'Failed to update notification preferences' });
  }
});

router.patch('/:id/read', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Некорректный id уведомления' });
    }

    await markRead(userId, id);
    const unreadCount = await getUnreadCount(userId);
    emitNotificationEvent(userId, 'notification:read', { notificationId: id, unreadCount });
    emitNotificationEvent(userId, 'notification:unread_count_changed', { unreadCount });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

router.patch('/:id/unread', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Некорректный id уведомления' });
    }

    await markUnread(userId, id);
    const unreadCount = await getUnreadCount(userId);
    emitNotificationEvent(userId, 'notification:unread', { notificationId: id, unreadCount });
    emitNotificationEvent(userId, 'notification:unread_count_changed', { unreadCount });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

router.patch('/read-all', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    await markAllRead(userId);
    emitNotificationEvent(userId, 'notification:read_all', { unreadCount: 0 });
    emitNotificationEvent(userId, 'notification:unread_count_changed', { unreadCount: 0 });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// Notifications are an append-only record: no route may delete or archive them,
// for any user, through any path. (Product decision — see NotificationsInbox.tsx
// for the corresponding client-side removal.)

export default router;
