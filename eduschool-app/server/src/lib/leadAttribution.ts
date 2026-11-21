import { Prisma } from '@prisma/client';

export interface AttributionInput {
  source?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  referrer?: string | null;
  landingPage?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  yclid?: string | null;
  ttclid?: string | null;
  rawParams?: Prisma.InputJsonValue | null;
}

type SourceMapping = Record<string, string>;

const MAX_STRING = 500;
const MAX_RAW_KEYS = 50;
const MAX_SETTING_STRING = 80;
const MAX_MAP_ENTRIES = 100;
const MAX_CHANNELS = 50;
const MAX_IGNORED_PARAMS = 50;

export interface AttributionSettings {
  fallbackSource: string;
  knownChannels: string[];
  sourceAliases: SourceMapping;
  mediumRules: SourceMapping;
  ignoredParams: string[];
}

export class AttributionSettingsError extends Error {}

export const DEFAULT_ATTRIBUTION_SETTINGS: AttributionSettings = {
  fallbackSource: 'Direct',
  knownChannels: ['Google', 'Meta', 'TikTok', 'Yandex', 'Organic', 'Referral', 'Direct', 'Other'],
  sourceAliases: {
    google: 'Google',
    google_ads: 'Google',
    adwords: 'Google',
    facebook: 'Meta',
    fb: 'Meta',
    meta: 'Meta',
    instagram: 'Meta',
    ig: 'Meta',
    tiktok: 'TikTok',
    tt: 'TikTok',
    yandex: 'Yandex',
    ya: 'Yandex',
  },
  mediumRules: {
    organic: 'Organic',
    seo: 'Organic',
    referral: 'Referral',
    referrer: 'Referral',
    direct: 'Direct',
    none: 'Direct',
  },
  ignoredParams: [],
};

export function cleanString(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function titleSource(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 80);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readMapping(candidate: unknown, strict = false): SourceMapping | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  if (!isPlainObject(candidate)) {
    if (strict) throw new AttributionSettingsError('Mapping fields must be plain objects');
    return undefined;
  }

  const mapping: SourceMapping = {};
  for (const [key, value] of Object.entries(candidate).slice(0, MAX_MAP_ENTRIES)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      if (strict) throw new AttributionSettingsError('Mapping keys and values must be strings');
      continue;
    }
    const safeKey = cleanString(key, MAX_SETTING_STRING);
    const source = cleanString(value, MAX_SETTING_STRING);
    if (safeKey && source) mapping[normalizeKey(safeKey)] = source;
  }
  return mapping;
}

function readStringArray(candidate: unknown, max: number, field: string, strict = false): string[] | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  if (!Array.isArray(candidate)) {
    if (strict) throw new AttributionSettingsError(`${field} must be an array`);
    return undefined;
  }

  const values: string[] = [];
  const seen = new Set<string>();
  for (const item of candidate.slice(0, max)) {
    if (typeof item !== 'string') {
      if (strict) throw new AttributionSettingsError(`${field} values must be strings`);
      continue;
    }
    const safe = cleanString(item, MAX_SETTING_STRING);
    if (!safe || seen.has(safe)) continue;
    values.push(safe);
    seen.add(safe);
  }
  return values;
}

function readLegacySourceMapping(root: Record<string, unknown>, strict = false): SourceMapping {
  const candidate = root.sourceMapping ?? root.attributionSourceMapping;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  return readMapping(candidate, strict) ?? {};
}

export function sanitizeAttributionSettingsInput(value: unknown): AttributionSettings {
  if (!isPlainObject(value)) throw new AttributionSettingsError('Attribution settings must be an object');

  const fallbackSource = cleanString(value.fallbackSource, MAX_SETTING_STRING);
  if (value.fallbackSource !== undefined && typeof value.fallbackSource !== 'string') {
    throw new AttributionSettingsError('fallbackSource must be a string');
  }

  return {
    fallbackSource: fallbackSource ?? DEFAULT_ATTRIBUTION_SETTINGS.fallbackSource,
    knownChannels: readStringArray(value.knownChannels, MAX_CHANNELS, 'knownChannels', true)
      ?? DEFAULT_ATTRIBUTION_SETTINGS.knownChannels,
    sourceAliases: {
      ...DEFAULT_ATTRIBUTION_SETTINGS.sourceAliases,
      ...(readMapping(value.sourceAliases, true) ?? {}),
    },
    mediumRules: {
      ...DEFAULT_ATTRIBUTION_SETTINGS.mediumRules,
      ...(readMapping(value.mediumRules, true) ?? {}),
    },
    ignoredParams: readStringArray(value.ignoredParams, MAX_IGNORED_PARAMS, 'ignoredParams', true)
      ?? DEFAULT_ATTRIBUTION_SETTINGS.ignoredParams,
  };
}

export function readAttributionSettings(settings: unknown): AttributionSettings {
  if (!isPlainObject(settings)) return DEFAULT_ATTRIBUTION_SETTINGS;

  const attribution = isPlainObject(settings.attribution) ? settings.attribution : {};
  const fallbackSource = cleanString(attribution.fallbackSource, MAX_SETTING_STRING);
  const legacyAliases = readLegacySourceMapping(settings);
  const sourceAliases = readMapping(attribution.sourceAliases) ?? {};
  const mediumRules = readMapping(attribution.mediumRules) ?? {};

  return {
    fallbackSource: fallbackSource ?? DEFAULT_ATTRIBUTION_SETTINGS.fallbackSource,
    knownChannels: readStringArray(attribution.knownChannels, MAX_CHANNELS, 'knownChannels')
      ?? DEFAULT_ATTRIBUTION_SETTINGS.knownChannels,
    sourceAliases: {
      ...DEFAULT_ATTRIBUTION_SETTINGS.sourceAliases,
      ...legacyAliases,
      ...sourceAliases,
    },
    mediumRules: {
      ...DEFAULT_ATTRIBUTION_SETTINGS.mediumRules,
      ...mediumRules,
    },
    ignoredParams: readStringArray(attribution.ignoredParams, MAX_IGNORED_PARAMS, 'ignoredParams')
      ?? DEFAULT_ATTRIBUTION_SETTINGS.ignoredParams,
  };
}

export function readSourceMapping(settings: unknown): SourceMapping {
  return readAttributionSettings(settings).sourceAliases;
}

export function sanitizeRawParams(value: unknown): Prisma.InputJsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, Prisma.InputJsonValue> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, MAX_RAW_KEYS)) {
    const safeKey = cleanString(key, 80);
    if (!safeKey) continue;
    if (typeof raw === 'string') result[safeKey] = cleanString(raw, MAX_STRING) ?? '';
    else if (typeof raw === 'number' && Number.isFinite(raw)) result[safeKey] = raw;
    else if (typeof raw === 'boolean') result[safeKey] = raw;
  }
  return Object.keys(result).length ? result : undefined;
}

function isAttributionSettings(value: SourceMapping | AttributionSettings): value is AttributionSettings {
  return 'sourceAliases' in value && 'mediumRules' in value && 'fallbackSource' in value;
}

export function normalizeLeadSource(
  input: AttributionInput,
  settingsOrMapping: SourceMapping | AttributionSettings = DEFAULT_ATTRIBUTION_SETTINGS,
): string {
  const settings = isAttributionSettings(settingsOrMapping)
    ? settingsOrMapping
    : { ...DEFAULT_ATTRIBUTION_SETTINGS, sourceAliases: settingsOrMapping };
  const sourceCandidates = [
    input.source,
    input.utmSource,
  ].map(value => cleanString(value, 80)).filter(Boolean) as string[];
  const medium = cleanString(input.utmMedium, 80);

  for (const candidate of sourceCandidates) {
    const mapped = settings.sourceAliases[normalizeKey(candidate)];
    if (mapped) return mapped;
  }

  if (cleanString(input.gclid)) return 'Google';
  if (cleanString(input.fbclid)) return 'Meta';
  if (cleanString(input.ttclid)) return 'TikTok';
  if (cleanString(input.yclid)) return 'Yandex';

  if (medium) {
    const mediumKey = normalizeKey(medium);
    const mapped = settings.mediumRules[mediumKey] ?? settings.sourceAliases[mediumKey];
    if (mapped) return mapped;
  }

  const candidates = [...sourceCandidates, medium].filter(Boolean) as string[];
  const haystack = candidates.map(normalizeKey).join(' ');
  if (/\b(google|google_ads|adwords|ga)\b/.test(haystack)) return 'Google';
  if (/\b(meta|facebook|fb|instagram|ig)\b/.test(haystack)) return 'Meta';
  if (/\b(tiktok|tt)\b/.test(haystack)) return 'TikTok';
  if (/\b(yandex|ya|direct_yandex)\b/.test(haystack)) return 'Yandex';
  if (/\b(organic|seo)\b/.test(haystack)) return 'Organic';
  if (/\b(referral|refer|referrer)\b/.test(haystack)) return 'Referral';
  if (/\b(direct|none)\b/.test(haystack)) return 'Direct';

  if (candidates[0]) return titleSource(candidates[0]);
  if (cleanString(input.referrer)) return 'Referral';
  return settings.fallbackSource || 'Direct';
}
