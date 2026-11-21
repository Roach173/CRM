import prisma from './prisma';
import { cacheGet, cacheInvalidate, cacheSet } from './cache';
import { CacheKeys } from './cacheKeys';

export type EffectiveSubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'GRACE_PERIOD'
  | 'OVERDUE'
  | 'BLOCKED';

type StoredSubscriptionStatus = EffectiveSubscriptionStatus | 'TRIAL';

type SubscriptionCachePayload = {
  school: {
    id: number;
    isActive: boolean;
    blockedAt: string | null;
    createdAt: string;
  } | null;
  subscription: {
    status: StoredSubscriptionStatus;
    trialEndsAt: string | null;
    graceEndsAt: string | null;
    paidUntil: string | null;
  } | null;
};

export type SubscriptionState = {
  status: EffectiveSubscriptionStatus;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  paidUntil: Date | null;
  daysRemaining: number | null;
  canRead: boolean;
  canWrite: boolean;
  blockedReason: string | null;
  warning: string | null;
};

const CACHE_TTL_SECONDS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function daysUntil(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / DAY_MS));
}

function serializeStateInput(input: {
  school: {
    id: number;
    isActive: boolean;
    blockedAt: Date | null;
    createdAt: Date;
  } | null;
  subscription: {
    status: StoredSubscriptionStatus;
    trialEndsAt: Date | null;
    graceEndsAt: Date | null;
    paidUntil: Date | null;
  } | null;
}): SubscriptionCachePayload {
  return {
    school: input.school
      ? {
          id: input.school.id,
          isActive: input.school.isActive,
          blockedAt: input.school.blockedAt?.toISOString() ?? null,
          createdAt: input.school.createdAt.toISOString(),
        }
      : null,
    subscription: input.subscription
      ? {
          status: input.subscription.status,
          trialEndsAt: input.subscription.trialEndsAt?.toISOString() ?? null,
          graceEndsAt: input.subscription.graceEndsAt?.toISOString() ?? null,
          paidUntil: input.subscription.paidUntil?.toISOString() ?? null,
        }
      : null,
  };
}

function hydratePayload(payload: SubscriptionCachePayload) {
  return {
    school: payload.school
      ? {
          id: payload.school.id,
          isActive: payload.school.isActive,
          blockedAt: toDate(payload.school.blockedAt),
          createdAt: toDate(payload.school.createdAt)!,
        }
      : null,
    subscription: payload.subscription
      ? {
          status: payload.subscription.status,
          trialEndsAt: toDate(payload.subscription.trialEndsAt),
          graceEndsAt: toDate(payload.subscription.graceEndsAt),
          paidUntil: toDate(payload.subscription.paidUntil),
        }
      : null,
  };
}

function normalizeStatus(status: StoredSubscriptionStatus | null | undefined): EffectiveSubscriptionStatus {
  if (status === 'TRIAL') return 'TRIALING';
  if (status === 'TRIALING') return 'TRIALING';
  if (status === 'GRACE_PERIOD') return 'GRACE_PERIOD';
  if (status === 'ACTIVE') return 'ACTIVE';
  if (status === 'OVERDUE') return 'OVERDUE';
  if (status === 'BLOCKED') return 'BLOCKED';
  return 'OVERDUE';
}

function evaluate(
  _input: ReturnType<typeof hydratePayload>,
  _now = new Date(),
): SubscriptionState {
  // ponytail: subscription gating disabled — there is no real payment flow
  // (renewal is a manual Telegram/Kaspi process), so the read-only banner and
  // paywall just locked schools out for nothing. Everything downstream (the
  // Layout banners, App.tsx PaywallScreen/AccessRestrictedScreen, the backend
  // subscriptionGuard 402/403, and socket gating) reads this state, so forcing
  // full-access ACTIVE here neutralizes all of it from one place.
  // Upgrade path: restore trial/grace/overdue logic here if real billing lands.
  return {
    status: 'ACTIVE',
    trialEndsAt: null,
    graceEndsAt: null,
    paidUntil: null,
    daysRemaining: null,
    canRead: true,
    canWrite: true,
    blockedReason: null,
    warning: null,
  };
}

async function createMissingSubscription(school: { id: number; createdAt: Date }) {
  const trialEndsAt = addDays(school.createdAt, 7);
  const graceEndsAt = addDays(trialEndsAt, 3);

  try {
    return await prisma.subscription.create({
      data: {
        schoolId: school.id,
        plan: 'TRIAL',
        status: 'TRIALING',
        trialEndsAt,
        graceEndsAt,
      },
      select: {
        status: true,
        trialEndsAt: true,
        graceEndsAt: true,
        paidUntil: true,
      },
    });
  } catch {
    return prisma.subscription.findUnique({
      where: { schoolId: school.id },
      select: {
        status: true,
        trialEndsAt: true,
        graceEndsAt: true,
        paidUntil: true,
      },
    });
  }
}

async function loadPayload(schoolId: number): Promise<SubscriptionCachePayload> {
  const school = await prisma.school.findFirst({
    where: { id: schoolId, deletedAt: null },
    select: {
      id: true,
      isActive: true,
      blockedAt: true,
      createdAt: true,
      subscription: {
        select: {
          status: true,
          trialEndsAt: true,
          graceEndsAt: true,
          paidUntil: true,
        },
      },
    },
  });

  if (!school) return { school: null, subscription: null };

  const subscription = school.subscription ?? await createMissingSubscription(school);

  return serializeStateInput({
    school,
    subscription: subscription
      ? {
          status: subscription.status as StoredSubscriptionStatus,
          trialEndsAt: subscription.trialEndsAt,
          graceEndsAt: subscription.graceEndsAt,
          paidUntil: subscription.paidUntil,
        }
      : null,
  });
}

export async function getSubscriptionState(schoolId: number, opts: { bypassCache?: boolean } = {}) {
  const key = CacheKeys.subscription(schoolId);
  let payload: SubscriptionCachePayload | null = null;

  if (!opts.bypassCache) {
    payload = await cacheGet<SubscriptionCachePayload>(key);
  }

  if (!payload) {
    payload = await loadPayload(schoolId);
    await cacheSet(key, payload, CACHE_TTL_SECONDS);
  }

  return evaluate(hydratePayload(payload));
}

export async function invalidateSubscriptionCache(schoolId: number) {
  await cacheInvalidate(CacheKeys.subscription(schoolId));
}

export function isWriteMethod(method: string) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}
