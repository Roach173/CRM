const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'yclid',
  'ttclid',
] as const;

type AttributionKey = typeof ATTRIBUTION_KEYS[number];

export type AttributionPayload = Partial<Record<AttributionKey, string>> & {
  referrer?: string;
  landingPage?: string;
  rawParams?: Record<string, string>;
};

function safeValue(value: string | null, max = 500): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function captureAttributionPayload(): AttributionPayload {
  if (typeof window === 'undefined') return {};

  const params = new URLSearchParams(window.location.search);
  const payload: AttributionPayload = {
    landingPage: safeValue(`${window.location.pathname}${window.location.search}`),
    referrer: safeValue(document.referrer),
  };
  const rawParams: Record<string, string> = {};

  for (const [key, value] of params.entries()) {
    const safeKey = safeValue(key, 80);
    const safeParam = safeValue(value);
    if (!safeKey || !safeParam) continue;
    rawParams[safeKey] = safeParam;
    if ((ATTRIBUTION_KEYS as readonly string[]).includes(safeKey)) {
      payload[safeKey as AttributionKey] = safeParam;
    }
  }

  if (Object.keys(rawParams).length > 0) payload.rawParams = rawParams;
  return payload;
}
