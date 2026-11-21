export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: 'OWNER' | 'ADMIN' | 'TEACHER' | 'STUDENT' | 'SUPERADMIN' | 'PARENT';
  schoolId: number;
  phone?: string;
  twoFactorEnabled?: boolean;
  deletedAt?: string;
  studentProfile?: {
    id: number;
    credits: number;
    level?: string;
  };
}

export type SubscriptionAccessStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'GRACE_PERIOD'
  | 'OVERDUE'
  | 'BLOCKED';

export interface Subscription {
  status: SubscriptionAccessStatus;
  plan: 'TRIAL' | 'STARTER' | 'OPTIMA' | 'NETWORK';
  trialEndsAt: string | null;
  graceEndsAt?: string | null;
  paidUntil: string | null;
}

export interface SubscriptionStatusInfo {
  plan: 'TRIAL' | 'STARTER' | 'OPTIMA' | 'NETWORK';
  status: SubscriptionAccessStatus;
  isTrial: boolean;
  isActive: boolean;
  isGracePeriod: boolean;
  isOverdue: boolean;
  isBlocked: boolean;
  trialDaysLeft: number;
  graceDaysLeft: number;
  paidDaysLeft: number;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  paidUntil: string | null;
  blockedReason: string | null;
}

export interface School {
  id: number;
  name: string;
  slug: string;
  city: string;
  email: string;
  phone?: string;
  timezone?: string;
  blockedAt?: string | null;
  deletedAt?: string;
  subscription?: Subscription | null;
  onboardingCompleted?: boolean;
  onboardingStep?: string | null;
  onboardingCompletedAt?: string | null;
  activeDays?: number[];
  workStart?: string | null;
  workEnd?: string | null;
  slotDuration?: number;
}

export interface StudentFreeze {
  id: number;
  schoolId: number;
  studentProfileId: number;
  type: 'LESSON_SKIP' | 'PERIOD';
  status: 'ACTIVE' | 'CANCELLED';
  lessonSessionId?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  reason?: string | null;
  createdById: number;
  cancelledById?: number | null;
  cancelledAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthResponse {
  success: boolean;
  data?: {
    token?: string;
    user: User;
    school: School;
  };
  error?: string;
}

export interface StudentProfile {
  id?: number;
  credits: number;
  level: string;
  chapter: number;
  isFrozen?: boolean;
  frozenAt?: string | null;
  isVerified?: boolean;
  paidUntil?: string | null;
  notes?: string | null;
  deletedAt?: string;
}

export interface LessonBlock {
  id: number;
  level: string;
  chapter: number;
  startTime: string;
  endTime: string;
  days: number[];
  type: 'GRAMMAR' | 'SPEAKING_CLUB';
  maxStudents: number;
  status: string;
  teacher: { firstName: string; lastName: string } | null;
  cabinet: { id: number; name: string } | null;
  _count?: { students: number };
  deletedAt?: string;
}

export interface Attendance {
  id: number;
  status: 'PRESENT' | 'ABSENT' | 'LATE' | 'FROZEN';
  creditDeducted: boolean;
  createdAt: string;
  lessonSession: { id: number; date: string; lessonBlock: Pick<LessonBlock, 'id' | 'level' | 'type'> };
}

export interface StudentGroup {
  id: number;
  level: string;
  chapter: number;
  maxStudents: number;
  status: 'ACTIVE' | 'COMPLETED' | 'PAUSED';
  startDate?: string;
  endDate?: string;
  _count?: { students: number };
}

export type NotificationCategory =
  | 'SYSTEM'
  | 'FINANCE'
  | 'SCHEDULE'
  | 'STUDENTS'
  | 'STAFF'
  | 'SUBSCRIPTION'
  | 'ANNOUNCEMENT'
  | 'ACADEMICS'
  | string;

export type NotificationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' | string;

export interface Notification {
  id: number;
  userId: number;
  schoolId?: number | null;
  type: string;
  category?: NotificationCategory | null;
  priority?: NotificationPriority | null;
  title: string;
  body: string;
  actionUrl?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  isRead: boolean;
  readAt?: string | null;
  data?: Record<string, unknown> | null;
  createdAt: string;
}

export interface NotificationPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface NotificationListResponse {
  items: Notification[];
  pagination: NotificationPagination;
  unreadCount: number;
}

export interface NotificationPreferenceCategory {
  category: NotificationCategory;
  label: string;
  description: string;
  enabled: boolean;
  locked: boolean;
}

export interface NotificationPreferencesResponse {
  categories: NotificationPreferenceCategory[];
}

export interface NotificationFilters {
  page?: number;
  limit?: number;
  status?: 'all' | 'unread' | 'read';
  category?: string;
  priority?: string;
  search?: string;
  sort?: 'createdAt_desc';
}

export type CommunicationChannel = 'IN_APP';
export type CommunicationCampaignStatus = 'DRAFT' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'SCHEDULED';
export type CommunicationRecipientStatus = 'PENDING' | 'SENT' | 'SKIPPED' | 'FAILED';
export type CommunicationRecipientDeliveryStatusFilter = 'ALL' | CommunicationRecipientStatus;
export type CommunicationTargetType = 'ROLES' | 'USERS' | 'GROUPS';
export type CommunicationTargetRole = 'OWNER' | 'ADMIN' | 'TEACHER' | 'STUDENT' | 'PARENT';
export type CommunicationGroupAudience = 'STUDENTS' | 'PARENTS' | 'STUDENTS_AND_PARENTS';

export interface CommunicationTargetConfig {
  roles?: CommunicationTargetRole[];
  userIds?: number[];
  groupIds?: number[];
  audience?: CommunicationGroupAudience;
}

export interface CommunicationGroup {
  id: number;
  level: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
}

export interface CommunicationRecipientPreview {
  recipientsCount: number;
  sample: Array<Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'role'>>;
}

export interface CommunicationRecipient {
  id: number;
  campaignId: number;
  userId: number;
  status: CommunicationRecipientStatus;
  skippedReason?: string | null;
  error?: string | null;
  notificationId?: number | null;
  createdAt: string;
  updatedAt: string;
  user?: Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'role'>;
}

export interface CommunicationCampaignRecipientDeliveryItem {
  id: number;
  campaignId: number;
  userId: number;
  status: CommunicationRecipientStatus;
  skippedReason?: string | null;
  error?: string | null;
  notificationId?: number | null;
  createdAt: string;
  updatedAt: string;
  user: Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'role'>;
}

export interface CommunicationCampaignRecipientsStats {
  recipientsCount: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface CommunicationCampaignRecipientsResponse {
  items: CommunicationCampaignRecipientDeliveryItem[];
  pagination: NotificationPagination;
  stats: CommunicationCampaignRecipientsStats;
}

export interface CommunicationCampaign {
  id: number;
  schoolId: number;
  createdById: number;
  title: string;
  body: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  channel: CommunicationChannel;
  status: CommunicationCampaignStatus;
  targetType: CommunicationTargetType;
  targetConfig: CommunicationTargetConfig;
  recipientsCount: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  sentAt?: string | null;
  scheduledAt?: string | null;
  createdAt: string;
  updatedAt: string;
  recipients?: CommunicationRecipient[];
}

export interface CreateCommunicationCampaignRequest {
  title: string;
  body: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  channel: CommunicationChannel;
  targetType: CommunicationTargetType;
  targetConfig: CommunicationTargetConfig;
}

export interface CreateCommunicationCampaignDraftRequest {
  title: string;
  body: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channel?: CommunicationChannel;
  targetType: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
}

export interface UpdateCommunicationCampaignDraftRequest {
  title?: string;
  body?: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channel?: CommunicationChannel;
  targetType?: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
}

export interface ScheduleCommunicationCampaignRequest {
  title: string;
  body: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  channel: CommunicationChannel;
  targetType: CommunicationTargetType;
  targetConfig: CommunicationTargetConfig;
  scheduledAt: string;
}

export interface UpdateScheduledCommunicationCampaignRequest {
  title?: string;
  body?: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channel?: CommunicationChannel;
  targetType?: CommunicationTargetType;
  targetConfig?: CommunicationTargetConfig;
  scheduledAt?: string;
}

export interface CommunicationCampaignListResponse {
  data: CommunicationCampaign[];
  meta: NotificationPagination;
}

export interface CommunicationCampaignDetailResponse {
  data: CommunicationCampaign;
}

export interface CommunicationTemplate {
  id: number;
  schoolId: number;
  createdById: number;
  name: string;
  title: string;
  body: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  channel: CommunicationChannel;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCommunicationTemplateRequest {
  name: string;
  title: string;
  body: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  channel?: CommunicationChannel;
}

export interface UpdateCommunicationTemplateRequest {
  name?: string;
  title?: string;
  body?: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channel?: CommunicationChannel;
}

// ─── Finance types ────────────────────────────────────────────────────────────

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID' | 'OVERDUE';
export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';
export type PaymentStatus = 'CONFIRMED' | 'VOIDED' | 'REFUNDED';
export type RefundStatus = 'PENDING' | 'CONFIRMED' | 'VOIDED';

export interface InvoiceLine {
  id: number;
  invoiceId: number;
  type: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  creditsToIssue?: number | null;
}

export interface Invoice {
  id: number;
  schoolId: number;
  studentProfileId: number;
  status: InvoiceStatus;
  totalAmount: string;
  paidAmount: string;
  currencyCode: string;
  dueDate?: string | null;
  issuedAt?: string | null;
  voidedAt?: string | null;
  note?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  createdAt: string;
  updatedAt: string;
  studentProfile?: {
    user: { firstName: string; lastName: string; email?: string };
  };
  lines?: InvoiceLine[];
  _count?: { allocations: number };
}

export interface PaymentAllocation {
  id: number;
  paymentId: number;
  invoiceId: number;
  amount: string;
  invoice?: {
    id: number;
    totalAmount: string;
    paidAmount: string;
    status: InvoiceStatus;
    dueDate?: string | null;
  };
}

export interface Payment {
  id: number;
  schoolId: number;
  studentProfileId: number;
  amount: string;
  method: PaymentMethod;
  status: PaymentStatus;
  paidAt: string;
  note?: string | null;
  voidedAt?: string | null;
  createdAt: string;
  studentProfile?: {
    // user.id present on CREDIT_TOPUP rows — needed for the cancel route (keyed by user id)
    user: { id?: number; firstName: string; lastName: string };
  };
  receivedBy?: { firstName: string; lastName: string };
  voidedBy?: { firstName: string; lastName: string } | null;
  allocations?: PaymentAllocation[];
  refundEvents?: PaymentRefundEvent[];
  _count?: { allocations: number };
  /**
   * Origin of the row. 'PAYMENT' = real Payment record (void/refund via payments API).
   * 'CREDIT_TOPUP' = StudentPayment quick payment (cancel via students API — reverses credits).
   */
  source?: 'PAYMENT' | 'CREDIT_TOPUP';
}

export interface ReceivableSummary {
  totalOutstanding: string;
  overdueOutstanding: string;
  activeInvoiceCount: number;
  overdueInvoiceCount: number;
}

export interface OverdueInvoice {
  id: number;
  studentProfileId: number;
  totalAmount: string;
  paidAmount: string;
  dueDate?: string | null;
  issuedAt?: string | null;
  currencyCode: string;
  studentProfile?: {
    user: { firstName: string; lastName: string };
  };
}

export interface StudentReceivableSummary {
  totalOutstanding: string;
  overdueOutstanding: string;
  activeInvoiceCount: number;
  overdueInvoiceCount: number;
  invoices?: OverdueInvoice[];
}

export interface PaymentRefundEvent {
  id: number;
  amount: string;
  status: RefundStatus;
  reason?: string;
  createdAt: string;
  confirmedAt?: string | null;
}

export interface PaymentRefund extends PaymentRefundEvent {
  paymentId: number;
  voidedAt?: string | null;
  allocations?: {
    id: number;
    paymentAllocation: { id: number; invoiceId: number; amount: string };
  }[];
}
