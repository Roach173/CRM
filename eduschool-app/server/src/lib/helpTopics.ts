// Help topics shown on the shared /help page. Owner-authored, read by every role.
// Stored at School.settings.help. Strict sanitize on write, lenient read on display.

export interface HelpTopic {
  title: string;
  body?: string;
  url?: string;
}

export class HelpTopicsError extends Error {}

const MAX_TOPICS = 30;
const MAX_TITLE = 200;
const MAX_BODY = 2000;
const MAX_URL = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

// Accepts bare domains ("youtube.com/x") by defaulting to https://. Returns ''
// for empty, the normalized URL for http(s), or null for anything that isn't a
// valid http(s) URL — so javascript:/data: can never become a link.
export function normalizeHelpUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return '';
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return withScheme;
  } catch {
    return null;
  }
}

// Strict: validates owner input on PATCH. Throws HelpTopicsError on bad shape.
export function sanitizeHelpTopicsInput(value: unknown): HelpTopic[] {
  if (!Array.isArray(value)) throw new HelpTopicsError('Help topics must be an array');
  if (value.length > MAX_TOPICS) throw new HelpTopicsError(`Слишком много топиков (максимум ${MAX_TOPICS})`);

  const topics: HelpTopic[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) throw new HelpTopicsError('Each topic must be an object');
    const title = cleanString(raw.title, MAX_TITLE);
    if (!title) continue; // drop blank-title rows
    const body = cleanString(raw.body, MAX_BODY);
    const url = normalizeHelpUrl(cleanString(raw.url, MAX_URL));
    if (url === null) {
      throw new HelpTopicsError('Ссылка недействительна или использует небезопасный протокол');
    }
    topics.push({ title, ...(body ? { body } : {}), ...(url ? { url } : {}) });
  }
  return topics;
}

// Lenient: reads stored value for display. Never throws; re-applies the http(s)
// guard so a value written before validation can never render as a bad link.
export function readHelpTopics(settings: unknown): HelpTopic[] {
  if (!isPlainObject(settings) || !Array.isArray(settings.help)) return [];
  const topics: HelpTopic[] = [];
  for (const raw of settings.help.slice(0, MAX_TOPICS)) {
    if (!isPlainObject(raw)) continue;
    const title = cleanString(raw.title, MAX_TITLE);
    if (!title) continue;
    const body = cleanString(raw.body, MAX_BODY);
    const url = cleanString(raw.url, MAX_URL);
    const safeUrl = /^https?:\/\//i.test(url) ? url : '';
    topics.push({ title, ...(body ? { body } : {}), ...(safeUrl ? { url: safeUrl } : {}) });
  }
  return topics;
}
