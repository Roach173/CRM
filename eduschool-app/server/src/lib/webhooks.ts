import { Prisma } from '@prisma/client';
import prisma from './prisma';
import { isWebhookEvent, WebhookEventError } from './webhookEvents';
import {
  buildWebhookHeaders,
  createWebhookEnvelope,
  createWebhookSignature,
  validateWebhookUrl,
  resolveAndBlockPrivate,
} from './webhookSecurity';

const WEBHOOK_TIMEOUT_MS = 5000;
const RESPONSE_SNIPPET_LIMIT = 2000;

export const WEBHOOK_DELIVERY_STATUS = {
  pending: 'pending',
  sending: 'sending',
  delivered: 'delivered',
  failed: 'failed',
  retrying: 'retrying',
  disabled: 'disabled',
} as const;

export type WebhookDeliveryStatus = typeof WEBHOOK_DELIVERY_STATUS[keyof typeof WEBHOOK_DELIVERY_STATUS];

export async function dispatchWebhook(
  schoolId: number,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!isWebhookEvent(event)) {
    throw new WebhookEventError(`Unsupported webhook event: ${event}`);
  }

  const webhooks = await prisma.webhook.findMany({
    where: { schoolId, isActive: true, events: { has: event } },
  });

  await Promise.allSettled(
    webhooks.map(webhook =>
      deliverWebhookWithLog({
        schoolId,
        webhook,
        event,
        payload,
      })
    )
  );
}

export async function deliverWebhookForTest(input: {
  schoolId: number;
  webhookId: number;
  payload: Record<string, unknown>;
}) {
  const webhook = await prisma.webhook.findFirst({
    where: { id: input.webhookId, schoolId: input.schoolId },
  });
  if (!webhook) return null;

  return deliverWebhookWithLog({
    schoolId: input.schoolId,
    webhook,
    event: 'webhook.test',
    payload: input.payload,
  });
}

async function deliverWebhookWithLog(input: {
  schoolId: number;
  webhook: { id: number; url: string; secret: string };
  event: string;
  payload: Record<string, unknown>;
}) {
  if (!isWebhookEvent(input.event)) {
    throw new WebhookEventError(`Unsupported webhook event: ${input.event}`);
  }

  const delivery = await createWebhookDelivery({
    schoolId: input.schoolId,
    webhookId: input.webhook.id,
    event: input.event,
    payload: toJsonValue(input.payload),
  });

  await markWebhookDeliverySending(delivery.id);

  try {
    const result = await deliverWebhook({
      deliveryId: String(delivery.id),
      schoolId: input.schoolId,
      url: input.webhook.url,
      secret: input.webhook.secret,
      event: input.event,
      payload: input.payload,
    });
    const updated = await markWebhookDeliveryDelivered(delivery.id, result.responseCode, result.responseBodySnippet);
    await prisma.webhook.update({
      where: { id: input.webhook.id },
      data: {
        lastDeliveryAt: new Date(),
        lastStatus: WEBHOOK_DELIVERY_STATUS.delivered,
        failureCount: 0,
      },
    });
    return updated;
  } catch (error) {
    const deliveryError = error instanceof WebhookDeliveryError ? error : null;
    const updated = await markWebhookDeliveryFailed(
      delivery.id,
      error,
      deliveryError?.responseCode,
      deliveryError?.responseBodySnippet
    );
    await prisma.webhook.update({
      where: { id: input.webhook.id },
      data: {
        lastDeliveryAt: new Date(),
        lastStatus: WEBHOOK_DELIVERY_STATUS.failed,
        failureCount: { increment: 1 },
      },
    });
    return updated;
  }
}

export async function createWebhookDelivery(input: {
  schoolId: number;
  webhookId: number;
  event: string;
  payload: Prisma.InputJsonValue;
}) {
  return prisma.webhookDelivery.create({
    data: {
      schoolId: input.schoolId,
      webhookId: input.webhookId,
      event: input.event,
      status: WEBHOOK_DELIVERY_STATUS.pending,
      payload: input.payload,
    },
  });
}

export async function markWebhookDeliverySending(deliveryId: number) {
  return prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: WEBHOOK_DELIVERY_STATUS.sending,
      attempts: { increment: 1 },
      errorMessage: null,
      responseBodySnippet: null,
      responseCode: null,
    },
  });
}

export async function markWebhookDeliveryDelivered(
  deliveryId: number,
  responseCode?: number,
  responseBodySnippet?: string
) {
  return prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: WEBHOOK_DELIVERY_STATUS.delivered,
      responseCode,
      responseBodySnippet: truncateSnippet(responseBodySnippet),
      deliveredAt: new Date(),
      nextRetryAt: null,
      errorMessage: null,
    },
  });
}

export async function markWebhookDeliveryFailed(
  deliveryId: number,
  error: unknown,
  responseCode?: number,
  responseBodySnippet?: string,
  nextRetryAt?: Date
) {
  return prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: nextRetryAt ? WEBHOOK_DELIVERY_STATUS.retrying : WEBHOOK_DELIVERY_STATUS.failed,
      responseCode,
      responseBodySnippet: truncateSnippet(responseBodySnippet),
      errorMessage: sanitizeErrorMessage(error),
      nextRetryAt,
    },
  });
}

async function deliverWebhook(input: {
  deliveryId: string;
  schoolId: number;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
}): Promise<{ responseCode: number; responseBodySnippet?: string }> {
  const url = validateWebhookUrl(input.url);
  // DNS rebinding guard: resolve hostname and reject if it maps to a private/blocked IP at delivery time
  const { hostname } = new URL(url);
  await resolveAndBlockPrivate(hostname);

  const envelope = createWebhookEnvelope({
    deliveryId: input.deliveryId,
    event: input.event,
    schoolId: input.schoolId,
    data: input.payload,
  });
  const body = JSON.stringify(envelope);
  const timestamp = envelope.occurredAt;
  const signature = createWebhookSignature(body, input.secret);

  const res = await fetch(url, {
    method: 'POST',
    headers: buildWebhookHeaders({
      event: input.event,
      deliveryId: input.deliveryId,
      timestamp,
      signature,
    }),
    body,
    redirect: 'error', // prevent redirect following — SSRF via 3xx redirect
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });

  const responseBodySnippet = truncateSnippet(await safeResponseText(res));
  if (!res.ok) {
    throw new WebhookDeliveryError(`Webhook delivery failed: ${res.status}`, res.status, responseBodySnippet);
  }
  return { responseCode: res.status, responseBodySnippet };
}

async function safeResponseText(res: Response): Promise<string | undefined> {
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

function truncateSnippet(value?: string | null): string | undefined {
  if (!value) return undefined;
  return value.slice(0, RESPONSE_SNIPPET_LIMIT);
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

class WebhookDeliveryError extends Error {
  constructor(
    message: string,
    public readonly responseCode?: number,
    public readonly responseBodySnippet?: string
  ) {
    super(message);
    this.name = 'WebhookDeliveryError';
  }
}
