export const INTEGRATION_STATUS = {
  disconnected: 'disconnected',
  connected: 'connected',
  error: 'error',
  disabled: 'disabled',
  syncing: 'syncing',
  needsAttention: 'needs_attention',
} as const;

export type IntegrationStatus = typeof INTEGRATION_STATUS[keyof typeof INTEGRATION_STATUS];
export type IntegrationLogStatus = 'success' | 'warning' | 'error' | 'skipped';

export type IntegrationCategory =
  | 'ads_analytics'
  | 'messaging'
  | 'automation_data'
  | 'telephony';

export type IntegrationCredentialType =
  | 'oauth'
  | 'api_token'
  | 'bot_token'
  | 'smtp_credentials'
  | 'tracking_id'
  | 'webhook'
  | 'sip_credentials';

export interface IntegrationProvider {
  key: string;
  displayName: string;
  category: IntegrationCategory;
  credentialType: IntegrationCredentialType;
  supportsStatus: boolean;
  phase: string;
  description: string;
  isImplemented: boolean;
  isRecommendedFirstProvider: boolean;
}

export interface SanitizedIntegrationConnection {
  id: number;
  provider: string;
  category: string;
  status: string;
  enabled: boolean;
  displayName: string | null;
  credentialStatus: string | null;
  scopes: string[];
  lastSyncAt: Date | null;
  lastError: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export const INTEGRATION_PROVIDERS = [
  {
    key: 'meta_ads',
    displayName: 'Meta Ads',
    category: 'ads_analytics',
    credentialType: 'oauth',
    supportsStatus: true,
    phase: 'later',
    description: 'Future campaign and ad spend import for Meta ads.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'google_ads',
    displayName: 'Google Ads',
    category: 'ads_analytics',
    credentialType: 'oauth',
    supportsStatus: true,
    phase: 'later',
    description: 'Future campaign and ad spend import for Google Ads.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'ga4',
    displayName: 'Google Analytics 4',
    category: 'ads_analytics',
    credentialType: 'oauth',
    supportsStatus: true,
    phase: 'later',
    description: 'Future analytics property connection for traffic quality signals.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'gtm',
    displayName: 'Google Tag Manager',
    category: 'ads_analytics',
    credentialType: 'tracking_id',
    supportsStatus: true,
    phase: 'pixels',
    description: 'Related to existing safe ID-based pixel settings.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'tiktok_ads',
    displayName: 'TikTok Ads',
    category: 'ads_analytics',
    credentialType: 'oauth',
    supportsStatus: true,
    phase: 'later',
    description: 'Future campaign and ad spend import for TikTok Ads.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'yandex_direct',
    displayName: 'Yandex Direct',
    category: 'ads_analytics',
    credentialType: 'oauth',
    supportsStatus: true,
    phase: 'later',
    description: 'Future campaign and ad spend import for Yandex Direct.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'yandex_metrica',
    displayName: 'Yandex Metrica',
    category: 'ads_analytics',
    credentialType: 'oauth',
    supportsStatus: true,
    phase: 'later',
    description: 'Future analytics counter connection for traffic quality signals.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'whatsapp',
    displayName: 'WhatsApp',
    category: 'messaging',
    credentialType: 'api_token',
    supportsStatus: true,
    phase: 'later',
    description: 'Future lead and student messaging integration.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'telegram',
    displayName: 'Telegram',
    category: 'messaging',
    credentialType: 'bot_token',
    supportsStatus: true,
    phase: 'later',
    description: 'Future bot notifications for CRM events.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'instagram_direct',
    displayName: 'Instagram Direct',
    category: 'messaging',
    credentialType: 'oauth',
    supportsStatus: true,
    phase: 'later',
    description: 'Future direct message lead capture and communication.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'email_smtp',
    displayName: 'Email SMTP',
    category: 'messaging',
    credentialType: 'smtp_credentials',
    supportsStatus: true,
    phase: 'later',
    description: 'Future transactional email provider connection.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'google_sheets',
    displayName: 'Google Sheets',
    category: 'automation_data',
    credentialType: 'oauth',
    supportsStatus: true,
    phase: 'recommended_first',
    description: 'Recommended first real provider for low-risk data import and export workflows.',
    isImplemented: false,
    isRecommendedFirstProvider: true,
  },
  {
    key: 'webhooks',
    displayName: 'Webhooks',
    category: 'automation_data',
    credentialType: 'webhook',
    supportsStatus: true,
    phase: 'existing',
    description: 'Existing outbound event notifications with delivery logs and signed payloads.',
    isImplemented: true,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'zapier',
    displayName: 'Zapier',
    category: 'automation_data',
    credentialType: 'webhook',
    supportsStatus: true,
    phase: 'later',
    description: 'Future automation connector using webhook or app integration patterns.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'make',
    displayName: 'Make',
    category: 'automation_data',
    credentialType: 'webhook',
    supportsStatus: true,
    phase: 'later',
    description: 'Future automation connector using webhook or app integration patterns.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'sip_provider',
    displayName: 'SIP Provider',
    category: 'telephony',
    credentialType: 'sip_credentials',
    supportsStatus: true,
    phase: 'later',
    description: 'Future call routing and telephony provider connection.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
  {
    key: 'call_tracking',
    displayName: 'Call Tracking Provider',
    category: 'telephony',
    credentialType: 'api_token',
    supportsStatus: true,
    phase: 'later',
    description: 'Future call attribution and source tracking integration.',
    isImplemented: false,
    isRecommendedFirstProvider: false,
  },
] as const satisfies readonly IntegrationProvider[];

const PROVIDERS_BY_KEY = new Map<string, IntegrationProvider>(
  INTEGRATION_PROVIDERS.map(provider => [provider.key, provider])
);

export function listIntegrationProviders(): IntegrationProvider[] {
  return [...INTEGRATION_PROVIDERS];
}

export function getIntegrationProvider(key: string): IntegrationProvider | undefined {
  return PROVIDERS_BY_KEY.get(key);
}

export function isIntegrationProvider(key: string): boolean {
  return PROVIDERS_BY_KEY.has(key);
}

export function getDefaultIntegrationStatus(): IntegrationStatus {
  return INTEGRATION_STATUS.disconnected;
}

export function isIntegrationStatus(value: unknown): value is IntegrationStatus {
  return typeof value === 'string' && Object.values(INTEGRATION_STATUS).includes(value as IntegrationStatus);
}

export function getManualConnectionStatus(provider: IntegrationProvider): IntegrationStatus {
  return provider.isImplemented || provider.phase === 'existing' || provider.phase === 'pixels'
    ? INTEGRATION_STATUS.connected
    : INTEGRATION_STATUS.needsAttention;
}

export function getDefaultCredentialStatus(provider: IntegrationProvider): string {
  return provider.credentialType === 'webhook' || provider.credentialType === 'tracking_id'
    ? 'not_required'
    : 'not_configured';
}

export function sanitizeIntegrationMessage(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, 500) || fallback;
}

export function sanitizeIntegrationDisplayName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, 120);
  return trimmed || undefined;
}

export function hasCredentialFields(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const forbidden = new Set([
    'credential',
    'credentials',
    'credentialRef',
    'secret',
    'token',
    'accessToken',
    'refreshToken',
    'apiKey',
    'apiSecret',
    'password',
    'clientSecret',
  ]);
  return Object.keys(value).some(key => forbidden.has(key));
}

export function sanitizeIntegrationConnection<T extends {
  id: number;
  provider: string;
  category: string;
  status: string;
  enabled: boolean;
  displayName: string | null;
  credentialStatus: string | null;
  scopes: string[];
  lastSyncAt: Date | null;
  lastError: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}>(connection: T): SanitizedIntegrationConnection {
  return {
    id: connection.id,
    provider: connection.provider,
    category: connection.category,
    status: connection.status,
    enabled: connection.enabled,
    displayName: connection.displayName,
    credentialStatus: connection.credentialStatus,
    scopes: connection.scopes,
    lastSyncAt: connection.lastSyncAt,
    lastError: connection.lastError,
    connectedAt: connection.connectedAt,
    disconnectedAt: connection.disconnectedAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}
