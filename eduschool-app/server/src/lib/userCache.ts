import { cacheGet, cacheSet, cacheInvalidate } from './cache';
import prisma from './prisma';

export interface CachedUser {
  id: number;
  tokenVersion: number;
  deletedAt: string | null; // ISO string — JSON serializable
  role: string;
  schoolId: number | null;
  schoolBlockedAt: string | null; // ISO string
}

const USER_TTL = 60; // seconds

function key(userId: number): string {
  return `user:${userId}`;
}

export async function getCachedUser(userId: number): Promise<CachedUser | null> {
  const cached = await cacheGet<CachedUser>(key(userId));
  if (cached) return cached;

  return getFreshUser(userId);
}

export async function getFreshUser(userId: number): Promise<CachedUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      tokenVersion: true,
      deletedAt: true,
      role: true,
      schoolId: true,
      school: { select: { blockedAt: true } },
    },
  });

  if (!user) return null;

  const entry: CachedUser = {
    id: user.id,
    tokenVersion: user.tokenVersion,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    role: user.role,
    schoolId: user.schoolId,
    schoolBlockedAt: user.school?.blockedAt?.toISOString() ?? null,
  };

  await cacheSet(key(userId), entry, USER_TTL);
  return entry;
}

export async function invalidateUserCache(userId: number): Promise<void> {
  await cacheInvalidate(key(userId));
}
