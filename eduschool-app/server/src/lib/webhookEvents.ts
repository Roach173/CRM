export const WEBHOOK_EVENTS = [
  'webhook.test',
  'lead.created',
  'lead.updated',
  'lead.converted',
  'payment.created',
  'student.created',
  'student.activated',
  'attendance.created',
  'group.created',
  'trial.booked',
] as const;

export type WebhookEvent = typeof WEBHOOK_EVENTS[number];

const WEBHOOK_EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

export class WebhookEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookEventError';
  }
}

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === 'string' && WEBHOOK_EVENT_SET.has(value);
}

export function sanitizeWebhookEvents(input: unknown): WebhookEvent[] {
  if (!Array.isArray(input)) {
    throw new WebhookEventError('Webhook events must be an array');
  }

  const events: WebhookEvent[] = [];
  const seen = new Set<WebhookEvent>();

  for (const item of input) {
    if (!isWebhookEvent(item)) {
      throw new WebhookEventError(`Unsupported webhook event: ${String(item)}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      events.push(item);
    }
  }

  if (events.length === 0) {
    throw new WebhookEventError('At least one webhook event is required');
  }

  return events;
}

export function getDefaultWebhookEvents(): WebhookEvent[] {
  return ['webhook.test'];
}
