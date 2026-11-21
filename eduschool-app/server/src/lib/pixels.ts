export type PixelProvider = 'meta' | 'ga4' | 'gtm' | 'googleAds' | 'tiktok' | 'yandex';

export interface PixelSettings {
  enabled: Record<PixelProvider, boolean>;
  metaPixelId: string;
  ga4MeasurementId: string;
  gtmContainerId: string;
  googleAdsConversionId: string;
  googleAdsConversionLabel: string;
  tikTokPixelId: string;
  yandexMetricaId: string;
}

export class PixelSettingsError extends Error {}

const PROVIDERS: PixelProvider[] = ['meta', 'ga4', 'gtm', 'googleAds', 'tiktok', 'yandex'];
const DANGEROUS_KEYS = new Set([
  'script',
  'scripts',
  'customScript',
  'customScripts',
  'customJs',
  'javascript',
  'html',
  'code',
]);

export const DEFAULT_PIXEL_SETTINGS: PixelSettings = {
  enabled: {
    meta: false,
    ga4: false,
    gtm: false,
    googleAds: false,
    tiktok: false,
    yandex: false,
  },
  metaPixelId: '',
  ga4MeasurementId: '',
  gtmContainerId: '',
  googleAdsConversionId: '',
  googleAdsConversionLabel: '',
  tikTokPixelId: '',
  yandexMetricaId: '',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown, max = 80, strict = false, field = 'value'): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    if (strict) throw new PixelSettingsError(`${field} must be a string`);
    return '';
  }
  return String(value).trim().slice(0, max);
}

function normalizeGoogleAdsConversionId(value: unknown, strict = false): string {
  const cleaned = cleanString(value, 40, strict, 'googleAdsConversionId').toUpperCase();
  if (!cleaned) return '';
  const normalized = cleaned.startsWith('AW-') ? cleaned : `AW-${cleaned}`;
  if (!/^AW-\d{5,30}$/.test(normalized)) {
    if (strict) throw new PixelSettingsError('googleAdsConversionId must be AW- followed by digits');
    return '';
  }
  return normalized;
}

function validateByPattern(value: unknown, pattern: RegExp, field: string, strict = false, max = 80, transform?: (value: string) => string): string {
  const cleaned = cleanString(value, max, strict, field);
  if (!cleaned) return '';
  const candidate = transform ? transform(cleaned) : cleaned;
  if (!pattern.test(candidate)) {
    if (strict) throw new PixelSettingsError(`${field} has an invalid format`);
    return '';
  }
  return candidate;
}

function sanitizeEnabled(value: unknown, strict = false): Record<PixelProvider, boolean> {
  if (value === undefined || value === null) return { ...DEFAULT_PIXEL_SETTINGS.enabled };
  if (!isPlainObject(value)) {
    if (strict) throw new PixelSettingsError('enabled must be an object');
    return { ...DEFAULT_PIXEL_SETTINGS.enabled };
  }

  const enabled = { ...DEFAULT_PIXEL_SETTINGS.enabled };
  for (const provider of PROVIDERS) {
    const flag = value[provider];
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean') {
      if (strict) throw new PixelSettingsError(`enabled.${provider} must be a boolean`);
      continue;
    }
    enabled[provider] = flag;
  }
  return enabled;
}

function assertNoDangerousKeys(value: Record<string, unknown>) {
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new PixelSettingsError('Custom scripts are not supported');
    }
  }
}

export function sanitizePixelSettingsInput(value: unknown): PixelSettings {
  if (!isPlainObject(value)) throw new PixelSettingsError('Pixel settings must be an object');
  assertNoDangerousKeys(value);

  const settings = {
    enabled: sanitizeEnabled(value.enabled, true),
    metaPixelId: validateByPattern(value.metaPixelId, /^\d{5,30}$/, 'metaPixelId', true, 30),
    ga4MeasurementId: validateByPattern(value.ga4MeasurementId, /^G-[A-Z0-9]{4,32}$/, 'ga4MeasurementId', true, 40, v => v.toUpperCase()),
    gtmContainerId: validateByPattern(value.gtmContainerId, /^GTM-[A-Z0-9]{4,32}$/, 'gtmContainerId', true, 40, v => v.toUpperCase()),
    googleAdsConversionId: normalizeGoogleAdsConversionId(value.googleAdsConversionId, true),
    googleAdsConversionLabel: validateByPattern(value.googleAdsConversionLabel, /^[A-Za-z0-9_-]{0,80}$/, 'googleAdsConversionLabel', true, 80),
    tikTokPixelId: validateByPattern(value.tikTokPixelId, /^[A-Za-z0-9_-]{4,80}$/, 'tikTokPixelId', true, 80),
    yandexMetricaId: validateByPattern(value.yandexMetricaId, /^\d{3,30}$/, 'yandexMetricaId', true, 30),
  };

  if (settings.enabled.meta && !settings.metaPixelId) throw new PixelSettingsError('metaPixelId is required when Meta Pixel is enabled');
  if (settings.enabled.ga4 && !settings.ga4MeasurementId) throw new PixelSettingsError('ga4MeasurementId is required when GA4 is enabled');
  if (settings.enabled.gtm && !settings.gtmContainerId) throw new PixelSettingsError('gtmContainerId is required when GTM is enabled');
  if (settings.enabled.googleAds && !settings.googleAdsConversionId) throw new PixelSettingsError('googleAdsConversionId is required when Google Ads is enabled');
  if (settings.enabled.tiktok && !settings.tikTokPixelId) throw new PixelSettingsError('tikTokPixelId is required when TikTok Pixel is enabled');
  if (settings.enabled.yandex && !settings.yandexMetricaId) throw new PixelSettingsError('yandexMetricaId is required when Yandex Metrica is enabled');

  return settings;
}

export function readPixelSettings(settings: unknown): PixelSettings {
  if (!isPlainObject(settings)) return DEFAULT_PIXEL_SETTINGS;
  const pixels = isPlainObject(settings.pixels) ? settings.pixels : {};

  return {
    enabled: sanitizeEnabled(pixels.enabled),
    metaPixelId: validateByPattern(pixels.metaPixelId, /^\d{5,30}$/, 'metaPixelId', false, 30),
    ga4MeasurementId: validateByPattern(pixels.ga4MeasurementId, /^G-[A-Z0-9]{4,32}$/, 'ga4MeasurementId', false, 40, v => v.toUpperCase()),
    gtmContainerId: validateByPattern(pixels.gtmContainerId, /^GTM-[A-Z0-9]{4,32}$/, 'gtmContainerId', false, 40, v => v.toUpperCase()),
    googleAdsConversionId: normalizeGoogleAdsConversionId(pixels.googleAdsConversionId),
    googleAdsConversionLabel: validateByPattern(pixels.googleAdsConversionLabel, /^[A-Za-z0-9_-]{0,80}$/, 'googleAdsConversionLabel', false, 80),
    tikTokPixelId: validateByPattern(pixels.tikTokPixelId, /^[A-Za-z0-9_-]{4,80}$/, 'tikTokPixelId', false, 80),
    yandexMetricaId: validateByPattern(pixels.yandexMetricaId, /^\d{3,30}$/, 'yandexMetricaId', false, 30),
  };
}

export function publicPixelSettings(settings: unknown): PixelSettings {
  const pixels = readPixelSettings(settings);
  return {
    ...pixels,
    enabled: {
      meta: pixels.enabled.meta && Boolean(pixels.metaPixelId),
      ga4: pixels.enabled.ga4 && Boolean(pixels.ga4MeasurementId),
      gtm: pixels.enabled.gtm && Boolean(pixels.gtmContainerId),
      googleAds: pixels.enabled.googleAds && Boolean(pixels.googleAdsConversionId),
      tiktok: pixels.enabled.tiktok && Boolean(pixels.tikTokPixelId),
      yandex: pixels.enabled.yandex && Boolean(pixels.yandexMetricaId),
    },
    metaPixelId: pixels.enabled.meta ? pixels.metaPixelId : '',
    ga4MeasurementId: pixels.enabled.ga4 ? pixels.ga4MeasurementId : '',
    gtmContainerId: pixels.enabled.gtm ? pixels.gtmContainerId : '',
    googleAdsConversionId: pixels.enabled.googleAds ? pixels.googleAdsConversionId : '',
    googleAdsConversionLabel: pixels.enabled.googleAds ? pixels.googleAdsConversionLabel : '',
    tikTokPixelId: pixels.enabled.tiktok ? pixels.tikTokPixelId : '',
    yandexMetricaId: pixels.enabled.yandex ? pixels.yandexMetricaId : '',
  };
}
