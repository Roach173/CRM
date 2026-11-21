import {
  BarChart3,
  BellRing,
  BookOpenCheck,
  CalendarClock,
  ChartNoAxesCombined,
  ClipboardCheck,
  CreditCard,
  FileDown,
  GraduationCap,
  KeyRound,
  Landmark,
  LayoutDashboard,
  Megaphone,
  MessageCircle,
  Network,
  ReceiptText,
  ShieldCheck,
  UserRoundCog,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

export type CTAType = 'audit' | 'demo' | 'consultation';

export type FeatureItem = {
  title: string;
  icon: LucideIcon;
};

export const painItems = [
  {
    title: 'Заявки теряются в мессенджерах',
    text: 'Лид написал, администратор отвлекся, через час клиент уже у конкурента. Это не случайность, это дырка в системе.',
    signal: 'lead lost',
  },
  {
    title: 'Администраторы забывают дожимать клиентов',
    text: 'Если заявка не дошла до оплаты, владелец должен видеть, где именно оборвалась цепочка.',
    signal: 'no follow-up',
  },
  {
    title: 'Преподаватели ведут учет как получится',
    text: 'Посещаемость, прогресс и домашние задания не должны жить в разных блокнотах и личных чатах.',
    signal: 'manual chaos',
  },
  {
    title: 'Долги всплывают слишком поздно',
    text: 'Деньги должны быть видны сегодня, а не после ручной сверки в конце месяца.',
    signal: 'debt risk',
  },
  {
    title: 'Расписание конфликтует и ломается',
    text: 'Группы, кабинеты, преподаватели и переносы требуют системы, а не героизма координатора.',
    signal: 'slot conflict',
  },
  {
    title: 'Руководитель видит цифры постфактум',
    text: 'Когда отчет собрали вручную, часть решений уже опоздала и деньги уже ушли.',
    signal: 'late data',
  },
  {
    title: 'Окупаемость рекламы непонятна',
    text: 'Не “кажется, реклама работает”, а точная связка: источник, заявка, пробный урок, оплата.',
    signal: 'blind CAC',
  },
  {
    title: 'Школа зависит от памяти сотрудников',
    text: 'Хаос не масштабируется. Если процесс держится в голове человека, это не процесс.',
    signal: 'human memory',
  },
];

export const systemTabs = [
  {
    title: 'Продажи',
    label: 'Воронка без провалов',
    bullets: ['Заявки из всех каналов', 'Автозадачи администраторам', 'История касаний', 'Конверсия по источникам'],
    stats: ['84% дозвон', '31% в оплату', '12 мин реакция'],
  },
  {
    title: 'Ученики',
    label: 'Каждый ученик в цифрах',
    bullets: ['Карточка ученика', 'Уровень языка', 'Посещаемость', 'Оплаты, задания, прогресс'],
    stats: ['238 активных', '92% посещаемость', '18 рисков ухода'],
  },
  {
    title: 'Преподаватели',
    label: 'Нагрузка и качество',
    bullets: ['Расписание', 'Группы и занятость', 'Отчеты по занятиям', 'Эффективность преподавателей'],
    stats: ['76% загрузка', '44 группы', '8 замен'],
  },
  {
    title: 'Финансы',
    label: 'Деньги без тумана',
    bullets: ['Выручка и долги', 'LTV и CAC', 'Окупаемость рекламы', 'Прогнозы по оплатам'],
    stats: ['5.24M выручка', '426K долги', '3.8x ROMI'],
  },
];

export const featureItems: FeatureItem[] = [
  { title: 'CRM для заявок', icon: LayoutDashboard },
  { title: 'Воронка продаж', icon: Network },
  { title: 'Автоматические задачи', icon: ClipboardCheck },
  { title: 'Расписание занятий', icon: CalendarClock },
  { title: 'Карточки учеников', icon: GraduationCap },
  { title: 'Управление группами', icon: UsersRound },
  { title: 'Учет оплат', icon: CreditCard },
  { title: 'Контроль долгов', icon: ReceiptText },
  { title: 'Посещаемость', icon: BookOpenCheck },
  { title: 'Домашние задания', icon: BellRing },
  { title: 'Учет преподавателей', icon: UserRoundCog },
  { title: 'Финансовая аналитика', icon: Landmark },
  { title: 'Маркетинговая аналитика', icon: Megaphone },
  { title: 'Отчеты по администраторам', icon: BarChart3 },
  { title: 'Уведомления', icon: BellRing },
  { title: 'Интеграции с мессенджерами', icon: MessageCircle },
  { title: 'Экспорт отчетов', icon: FileDown },
  { title: 'Роли и доступы', icon: KeyRound },
];

export const auditFindings = [
  '20-40% заявок не получают нормального дожима',
  'часть оплат фиксируется с задержкой',
  'источники рекламы оцениваются на ощущениях',
  'руководитель не видит эффективность администраторов',
  'ученики уходят без понятной причины',
];

export const ownerTheses = [
  'Никаких “я забыл”',
  'Никаких “скину отчет вечером”',
  'Никаких “кажется, у нас нормально”',
  'Только цифры, процессы и контроль',
];

export const comparisonRows = {
  sheets: ['ручной ввод', 'ошибки', 'нет автоматизации', 'слабый контроль', 'отчеты задним числом'],
  crm: ['единый процесс', 'автоматические задачи', 'аналитика в реальном времени', 'прозрачность по сотрудникам', 'контроль денег'],
};

export const actionLabels: Record<CTAType, string> = {
  audit: 'Бесплатный аудит школы',
  demo: 'Демо CRM',
  consultation: 'Консультация по внедрению',
};

export const featureIcons = { ChartNoAxesCombined, ShieldCheck };
