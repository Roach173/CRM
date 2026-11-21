export const NotificationCategory = {
  SYSTEM: 'SYSTEM',
  FINANCE: 'FINANCE',
  SCHEDULE: 'SCHEDULE',
  STUDENTS: 'STUDENTS',
  STAFF: 'STAFF',
  SUBSCRIPTION: 'SUBSCRIPTION',
  ANNOUNCEMENT: 'ANNOUNCEMENT',
  ACADEMICS: 'ACADEMICS',
} as const;

export type NotificationCategory = typeof NotificationCategory[keyof typeof NotificationCategory];

export const NotificationPriority = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;

export type NotificationPriority = typeof NotificationPriority[keyof typeof NotificationPriority];

export interface NotificationCategoryDefinition {
  category: NotificationCategory;
  label: string;
  description: string;
  defaultEnabled: boolean;
  locked: boolean;
}

export const NOTIFICATION_CATEGORY_DEFINITIONS: NotificationCategoryDefinition[] = [
  {
    category: NotificationCategory.SYSTEM,
    label: 'Система',
    description: 'Важные системные сообщения и безопасность аккаунта.',
    defaultEnabled: true,
    locked: true,
  },
  {
    category: NotificationCategory.FINANCE,
    label: 'Финансы',
    description: 'Оплаты, сверка финансов и денежные события школы.',
    defaultEnabled: true,
    locked: false,
  },
  {
    category: NotificationCategory.SCHEDULE,
    label: 'Расписание',
    description: 'Изменения уроков, групп и расписания.',
    defaultEnabled: true,
    locked: false,
  },
  {
    category: NotificationCategory.STUDENTS,
    label: 'Ученики',
    description: 'События по ученикам, заявкам и профилям.',
    defaultEnabled: true,
    locked: false,
  },
  {
    category: NotificationCategory.STAFF,
    label: 'Сотрудники',
    description: 'События по сотрудникам и приглашениям.',
    defaultEnabled: true,
    locked: false,
  },
  {
    category: NotificationCategory.SUBSCRIPTION,
    label: 'Подписка',
    description: 'Состояние подписки школы и доступ к сервису.',
    defaultEnabled: true,
    locked: true,
  },
  {
    category: NotificationCategory.ANNOUNCEMENT,
    label: 'Объявления',
    description: 'Рассылки и объявления от школы.',
    defaultEnabled: true,
    locked: false,
  },
  {
    category: NotificationCategory.ACADEMICS,
    label: 'Обучение',
    description: 'Учебные события, задания и материалы.',
    defaultEnabled: true,
    locked: false,
  },
];

const NOTIFICATION_CATEGORY_BY_NAME = new Map(
  NOTIFICATION_CATEGORY_DEFINITIONS.map(definition => [definition.category, definition]),
);

export function getNotificationCategoryDefinition(category: string) {
  return NOTIFICATION_CATEGORY_BY_NAME.get(category as NotificationCategory);
}

export function isKnownNotificationCategory(category: string) {
  return NOTIFICATION_CATEGORY_BY_NAME.has(category as NotificationCategory);
}

export function isLockedNotificationCategory(category: string) {
  return getNotificationCategoryDefinition(category)?.locked === true;
}
