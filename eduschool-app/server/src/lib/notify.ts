import {
  createForSchoolAdmins,
  createForUser,
  createForUsers,
  NotificationCategory,
  NotificationPriority,
} from '../services/notificationService';

type NotifyPayload = {
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
  data?: Record<string, unknown>;
};

export async function notify(payload: NotifyPayload) {
  await createForUser({ ...payload, data: payload.data ?? {} });
}

export async function notifyMany(userIds: number[], payload: Omit<NotifyPayload, 'userId'>) {
  if (userIds.length === 0) return;
  await createForUsers(userIds, { ...payload, data: payload.data ?? {} });
}

export async function notifySchoolAdmins(schoolId: number, payload: Omit<NotifyPayload, 'userId' | 'schoolId'>) {
  await createForSchoolAdmins({ schoolId, ...payload, data: payload.data ?? {} });
}
