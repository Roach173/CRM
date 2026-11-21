import crypto from 'crypto';
import net from 'net';
import dns from 'dns/promises';

import { WebhookEvent } from './webhookEvents';

const DEFAULT_MAX_WEBHOOK_URL_LENGTH = 2048;

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

export interface ValidateWebhookUrlOptions {
  allowLocalhost?: boolean;
  maxLength?: number;
  nodeEnv?: string;
}

export interface CreateWebhookEnvelopeInput {
  deliveryId: string;
  event: WebhookEvent | string;
  schoolId: number;
  data: Record<string, unknown>;
}

export interface BuildWebhookHeadersInput {
  event: WebhookEvent | string;
  deliveryId: string;
  timestamp: string | number | Date;
  signature: string;
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function maskWebhookSecret(secret?: string | null): string {
  if (!secret) return '********';
  return `${secret.slice(0, 4)}********${secret.slice(-4)}`;
}

export function createWebhookSignature(payloadBody: string, secret: string): string {
  const digest = crypto.createHmac('sha256', secret).update(payloadBody).digest('hex');
  return `sha256=${digest}`;
}

export function buildWebhookHeaders(input: BuildWebhookHeadersInput): Record<string, string> {
  const timestamp = input.timestamp instanceof Date ? input.timestamp.toISOString() : String(input.timestamp);
  return {
    'Content-Type': 'application/json',
    'X-BIOS-Event': input.event,
    'X-BIOS-Delivery': input.deliveryId,
    'X-BIOS-Timestamp': timestamp,
    'X-BIOS-Signature': input.signature,
  };
}

export function createWebhookEnvelope(input: CreateWebhookEnvelopeInput) {
  return {
    id: input.deliveryId,
    event: input.event,
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    schoolId: input.schoolId,
    data: input.data,
  };
}

export function validateWebhookUrl(rawUrl: unknown, options: ValidateWebhookUrlOptions = {}): string {
  if (typeof rawUrl !== 'string') {
    throw new WebhookUrlError('Webhook URL must be a string');
  }

  const trimmed = rawUrl.trim();
  const maxLength = options.maxLength ?? DEFAULT_MAX_WEBHOOK_URL_LENGTH;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const isDevelopment = nodeEnv !== 'production';
  const allowLocalhost = options.allowLocalhost ?? isDevelopment;

  if (!trimmed) {
    throw new WebhookUrlError('Webhook URL is required');
  }
  if (trimmed.length > maxLength) {
    throw new WebhookUrlError(`Webhook URL must be ${maxLength} characters or fewer`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebhookUrlError('Webhook URL is invalid');
  }

  const hostname = normalizeHostname(parsed.hostname);
  const isLocalhost = isLocalhostHost(hostname);
  const isHttpLocalhost = parsed.protocol === 'http:' && allowLocalhost && isLocalhost;

  if (parsed.protocol !== 'https:' && !isHttpLocalhost) {
    throw new WebhookUrlError('Webhook URL must use https');
  }

  if (!hostname) {
    throw new WebhookUrlError('Webhook URL must include a hostname');
  }
  if (parsed.username || parsed.password) {
    throw new WebhookUrlError('Webhook URL must not include credentials');
  }

  if (isBlockedHost(hostname) && !isHttpLocalhost) {
    throw new WebhookUrlError('Webhook URL cannot target localhost or private network hosts');
  }

  parsed.hash = '';
  return parsed.toString();
}

/**
 * DNS-resolution SSRF guard — call immediately before webhook delivery.
 * Resolves the hostname and rejects if any resolved IP is in a blocked range.
 * Guards against DNS rebinding attacks where a public hostname maps to a private IP at request time.
 *
 * Direct IP addresses (already validated by validateWebhookUrl at registration) are skipped.
 */
export async function resolveAndBlockPrivate(hostname: string): Promise<void> {
  // Direct IPs are already validated at registration time; skip re-resolution
  if (net.isIPv4(hostname) || net.isIPv6(hostname)) return;

  const [v4Result, v6Result] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const addresses: string[] = [];
  if (v4Result.status === 'fulfilled') addresses.push(...v4Result.value);
  if (v6Result.status === 'fulfilled') addresses.push(...v6Result.value);

  if (addresses.length === 0) {
    throw new WebhookUrlError(`Webhook hostname '${hostname}' could not be resolved`);
  }

  for (const addr of addresses) {
    if (isBlockedHost(addr)) {
      throw new WebhookUrlError(`Webhook URL resolved to blocked address: ${addr}`);
    }
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function isLocalhostHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || isLoopbackIpv4(hostname);
}

function isBlockedHost(hostname: string): boolean {
  if (isLocalhostHost(hostname)) return true;
  if (hostname === 'metadata.google.internal') return true;

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) return isBlockedIpv4(hostname);
  if (ipVersion === 6) return isBlockedIpv6(hostname);

  return false;
}

function isLoopbackIpv4(hostname: string): boolean {
  const parts = parseIpv4(hostname);
  return parts !== null && parts[0] === 127;
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = parseIpv4(hostname);
  if (!parts) return false;

  const [a, b, c, d] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return a === 169 && b === 254 && c === 169 && d === 254;
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  );
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map(part => {
    if (!/^\d{1,3}$/.test(part)) return NaN;
    return Number(part);
  });

  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets as [number, number, number, number];
}
