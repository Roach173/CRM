import { useEffect } from 'react';

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

type QueueFunction = ((...args: unknown[]) => void) & {
  queue?: unknown[][];
  loaded?: boolean;
  version?: string;
};

type TikTokQueue = {
  queue?: unknown[][];
  load: (id: string) => void;
  page: () => void;
  track: (event: string, payload?: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    fbq?: QueueFunction;
    ttq?: TikTokQueue;
    ym?: QueueFunction;
  }
}

const SCRIPT_PREFIX = 'bios-pixel';

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function valid(value: string | undefined, pattern: RegExp) {
  return Boolean(value && pattern.test(value));
}

function loadScript(key: string, src: string) {
  if (!isBrowser()) return;
  const scriptId = `${SCRIPT_PREFIX}-${key}`;
  if (document.getElementById(scriptId)) return;

  const script = document.createElement('script');
  script.id = scriptId;
  script.async = true;
  script.src = src;
  script.dataset.pixelProvider = key;
  document.head.appendChild(script);
}

function ensureDataLayer() {
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = (...args: unknown[]) => {
      window.dataLayer?.push(args);
    };
  }
}

function ensureQueue(name: 'fbq' | 'ym'): QueueFunction {
  const existing = window[name];
  if (existing) return existing;

  const queueFn: QueueFunction = (...args: unknown[]) => {
    queueFn.queue = queueFn.queue || [];
    queueFn.queue.push(args);
  };
  queueFn.queue = [];
  window[name] = queueFn;
  return queueFn;
}

function loadMeta(id: string) {
  if (!valid(id, /^\d{5,30}$/)) return;
  const fbq = ensureQueue('fbq');
  fbq.loaded = true;
  fbq.version = '2.0';
  fbq('init', id);
  fbq('track', 'PageView');
  loadScript(`meta-${id}`, 'https://connect.facebook.net/en_US/fbevents.js');
}

function loadGa4(id: string) {
  if (!valid(id, /^G-[A-Z0-9]{4,32}$/)) return;
  ensureDataLayer();
  window.gtag?.('js', new Date());
  window.gtag?.('config', id);
  loadScript(`ga4-${id}`, `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`);
}

function loadGtm(id: string) {
  if (!valid(id, /^GTM-[A-Z0-9]{4,32}$/)) return;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  loadScript(`gtm-${id}`, `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`);
}

function loadGoogleAds(id: string) {
  if (!valid(id, /^AW-\d{5,30}$/)) return;
  ensureDataLayer();
  window.gtag?.('js', new Date());
  window.gtag?.('config', id);
  loadScript(`google-ads-${id}`, `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`);
}

function loadTikTok(id: string) {
  if (!valid(id, /^[A-Za-z0-9_-]{4,80}$/)) return;
  if (!window.ttq) {
    const queue: unknown[][] = [];
    window.ttq = {
      queue,
      load: (pixelId: string) => queue.push(['load', pixelId]),
      page: () => queue.push(['page']),
      track: (event: string, payload?: Record<string, unknown>) => queue.push(['track', event, payload ?? {}]),
    };
  }
  window.ttq.load(id);
  window.ttq.page();
  loadScript(`tiktok-${id}`, `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(id)}&lib=ttq`);
}

function loadYandex(id: string) {
  if (!valid(id, /^\d{3,30}$/)) return;
  const ym = ensureQueue('ym');
  ym(Number(id), 'init', {
    clickmap: true,
    trackLinks: true,
    accurateTrackBounce: true,
    webvisor: false,
  });
  loadScript(`yandex-${id}`, 'https://mc.yandex.ru/metrika/tag.js');
}

export function loadPixels(settings?: PixelSettings | null) {
  if (!settings || !isBrowser()) return;
  if (settings.enabled.meta) loadMeta(settings.metaPixelId);
  if (settings.enabled.ga4) loadGa4(settings.ga4MeasurementId);
  if (settings.enabled.gtm) loadGtm(settings.gtmContainerId);
  if (settings.enabled.googleAds) loadGoogleAds(settings.googleAdsConversionId);
  if (settings.enabled.tiktok) loadTikTok(settings.tikTokPixelId);
  if (settings.enabled.yandex) loadYandex(settings.yandexMetricaId);
}

export function usePixelLoader(settings?: PixelSettings | null) {
  useEffect(() => {
    loadPixels(settings);
  }, [settings]);
}
