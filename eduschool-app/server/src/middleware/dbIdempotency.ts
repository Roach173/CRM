/**
 * DB-backed idempotency middleware — Phase 4: Financial Consistency.
 *
 * Replaces the response-cache idempotency approach with a DB-level unique
 * constraint on (schoolId, scopeType, actorId, endpoint, key). This means two
 * simultaneous first requests race at the database — only one INSERT wins.
 *
 * Patches implemented:
 *   PATCH 1  — canonical requestHash via json-stable-stringify (key-order invariant)
 *   PATCH 2  — stale IN_PROGRESS recovery after 5-min timeout (crash safety)
 *   PATCH 3  — explicit lifecycle hooks (completeIdempotency / failIdempotency)
 *              called ONLY after transaction commit — no monkey-patch timing bugs
 *   PATCH 7  — audit logging of REUSE_CONFLICT, REPLAY, STALE_RECLAIM events
 *   PATCH 8  — response sanitization: sensitive keys stripped, 64 KB size cap
 *   FINAL P1 — stable canonical JSON (json-stable-stringify, recursive key sort)
 *   FINAL P2 — scopeType architecture (USER/SYSTEM/WEBHOOK); Phase 4 = USER only
 *   FINAL P3 — COMPLETED written only after route calls req.completeIdempotency()
 *              which must be called after await prisma.$transaction() returns
 *
 * TODO(Phase 7+): extend for SYSTEM (cron/webhooks) with scopeType=SYSTEM,
 * actorId=null. Requires per-scope partial unique indexes in PostgreSQL to
 * correctly handle NULL values (NULL != NULL in standard B-tree unique indexes).
 * See ARCHITECTURAL_DECISIONS.md §Idempotency-Scope.
 */

import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import stableStringify from 'json-stable-stringify';
import prisma from '../lib/prisma';
import { createLogger } from '../lib/logger';

const log = createLogger('dbIdempotency');

// ─── Constants ────────────────────────────────────────────────────────────────

const TTL_HOURS = 24;
/** How old an IN_PROGRESS row must be before we consider the original request dead. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
/** Maximum bytes stored in responseBody JSONB. Larger responses get a stub. */
const MAX_RESPONSE_BYTES = 64 * 1024; // 64 KB

/** Fields stripped from replayed responses to avoid storing sensitive data. */
const SENSITIVE_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'secret',
  'totpsecret',
  'cookie',
  'authorization',
  'backupcodes',
  'verificationtoken',
  'tokenversion',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DbIdempotencyOptions {
  /** When true, requests without Idempotency-Key are rejected with 400. */
  required?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      /**
       * Call this AFTER await prisma.$transaction() returns successfully.
       * Marks the idempotency key COMPLETED and stores the sanitized response
       * so future retries receive a replay instead of re-executing the operation.
       *
       * CRITICAL: never call inside a transaction callback — the commit must
       * have already occurred before this is called.
       */
      completeIdempotency?: (status: number, body: unknown) => Promise<void>;
      /**
       * Call in catch blocks when the financial operation failed.
       * Marks the key FAILED so the client can safely retry with the same key.
       */
      failIdempotency?: () => Promise<void>;
    }
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Returns Express middleware that enforces DB-backed idempotency.
 *
 * Usage:
 *   router.post('/payments', authenticate, dbIdempotency({ required: true }), handler);
 *
 * The handler must call req.completeIdempotency(status, body) after its
 * prisma.$transaction() commits, and req.failIdempotency() in catch blocks.
 */
export function dbIdempotency(opts: DbIdempotencyOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = (req.headers['idempotency-key'] as string | undefined)?.trim();

    if (!key) {
      if (opts.required) {
        res.status(400).json({
          success: false,
          error: 'Idempotency-Key header is required for this financial operation',
          code: 'IDEMPOTENCY_KEY_REQUIRED',
        });
        return;
      }
      next();
      return;
    }

    const user = (req as any).user as { userId?: number; schoolId?: number } | undefined;
    const schoolId = user?.schoolId ?? null;
    const actorId  = user?.userId  ?? null;

    // req.route?.path gives the pattern (e.g. "/:staffProfileId"), not the
    // resolved value — normalise to route pattern for stable endpoint key.
    const endpoint   = `${req.method} ${req.route?.path ?? req.path}`;
    const requestHash = computeRequestHash(req);
    const expiresAt   = new Date(Date.now() + TTL_HOURS * 3_600_000);

    let keyId: number;

    // ── Step 1: Try to insert a fresh IN_PROGRESS row ─────────────────────────
    try {
      const inserted = await prisma.idempotencyKey.create({
        data: { schoolId, actorId, scopeType: 'USER', endpoint, key, requestHash, expiresAt },
        select: { id: true },
      });
      keyId = inserted.id;
      // First request wins — attach lifecycle hooks and proceed to handler
      attachLifecycleHooks(req, keyId);
      next();
      return;
    } catch (insertErr: any) {
      if (insertErr?.code !== 'P2002') {
        // Unexpected DB error — log and let the request through without idempotency
        log.error({ err: insertErr, endpoint, key }, 'dbIdempotency: unexpected INSERT error');
        next();
        return;
      }
    }

    // ── Step 2: Key already exists — resolve what to do ───────────────────────
    const existing = await prisma.idempotencyKey.findFirst({
      where: { schoolId, actorId, scopeType: 'USER', endpoint, key },
      select: { id: true, status: true, requestHash: true, startedAt: true, responseBody: true, responseStatus: true },
    });

    if (!existing) {
      // Extremely rare: row was deleted between our failed INSERT and this read
      // (e.g. cleanup job). Retry the insert once.
      log.warn({ schoolId, actorId, endpoint, key }, 'dbIdempotency: race on findFirst after P2002 — retrying INSERT');
      try {
        const retried = await prisma.idempotencyKey.create({
          data: { schoolId, actorId, scopeType: 'USER', endpoint, key, requestHash, expiresAt },
          select: { id: true },
        });
        keyId = retried.id;
        attachLifecycleHooks(req, keyId);
        next();
        return;
      } catch {
        // Still failing — skip idempotency protection for this request
        log.error({ schoolId, actorId, endpoint, key }, 'dbIdempotency: double race — proceeding without idempotency');
        next();
        return;
      }
    }

    // ── PATCH 1: requestHash mismatch → same key, different payload ───────────
    if (existing.requestHash !== requestHash) {
      log.warn(
        { schoolId, actorId, endpoint, key, event: 'IDEMPOTENCY_REUSE_CONFLICT' },
        'Idempotency key reused with different payload',
      );
      res.status(409).json({
        success: false,
        error: 'Idempotency-Key was already used with a different request payload. Use a new key.',
        code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
      });
      return;
    }

    // ── COMPLETED → replay the cached response ────────────────────────────────
    if (existing.status === 'COMPLETED') {
      log.info({ schoolId, actorId, endpoint, event: 'PAYMENT_REPLAY' }, 'Idempotency replay');
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(existing.responseStatus ?? 200).json(existing.responseBody);
      return;
    }

    // ── IN_PROGRESS → stale check (PATCH 2) ──────────────────────────────────
    if (existing.status === 'IN_PROGRESS') {
      const ageMs = Date.now() - existing.startedAt.getTime();
      if (ageMs > STALE_THRESHOLD_MS) {
        // Original request appears dead (server crash, timeout).
        // Reclaim: reset startedAt so any further concurrent check also sees fresh.
        log.warn(
          { existingId: existing.id, ageMs, endpoint, event: 'STALE_IN_PROGRESS_RECLAIM' },
          'Reclaiming stale IN_PROGRESS idempotency key',
        );
        await prisma.idempotencyKey.update({
          where: { id: existing.id },
          data: { startedAt: new Date(), requestHash, expiresAt, updatedAt: new Date() },
        });
        keyId = existing.id;
        attachLifecycleHooks(req, keyId);
        next();
        return;
      }

      // Fresh IN_PROGRESS → another request is still running
      res.status(409).json({
        success: false,
        error: 'A request with this Idempotency-Key is already in progress. Retry in a few seconds.',
        code: 'IDEMPOTENCY_IN_PROGRESS',
      });
      return;
    }

    // ── FAILED → allow retry with same key ───────────────────────────────────
    await prisma.idempotencyKey.update({
      where: { id: existing.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date(), requestHash, expiresAt, updatedAt: new Date() },
    });
    keyId = existing.id;
    attachLifecycleHooks(req, keyId);
    next();
  };
}

// ─── Lifecycle hooks ─────────────────────────────────────────────────────────

/**
 * Attach req.completeIdempotency() and req.failIdempotency() to the request.
 *
 * These are called by route handlers — never by the middleware itself —
 * which guarantees COMPLETED is only written after the DB transaction commits
 * (FINAL PATCH 3).
 */
function attachLifecycleHooks(req: Request, keyId: number): void {
  req.completeIdempotency = async (status: number, body: unknown): Promise<void> => {
    try {
      const sanitized = sanitizeResponse(body);
      await prisma.idempotencyKey.updateMany({
        where: { id: keyId, status: 'IN_PROGRESS' },
        data: {
          status:         'COMPLETED',
          responseStatus: status,
          responseBody:   sanitized as any,
          updatedAt:      new Date(),
        },
      });
    } catch (err) {
      // Non-fatal: the financial operation succeeded. Stale recovery will
      // handle this key on the next retry (it will stay IN_PROGRESS until
      // the 5-min stale threshold is reached).
      log.error({ err, keyId }, 'dbIdempotency: failed to mark key COMPLETED');
    }
  };

  req.failIdempotency = async (): Promise<void> => {
    try {
      await prisma.idempotencyKey.updateMany({
        where: { id: keyId, status: 'IN_PROGRESS' },
        data: { status: 'FAILED', updatedAt: new Date() },
      });
    } catch (err) {
      log.error({ err, keyId }, 'dbIdempotency: failed to mark key FAILED');
    }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * FINAL PATCH 1: Canonical, key-order-invariant request hash.
 *
 * json-stable-stringify recursively sorts object keys before serializing,
 * so { a:1, b:2 } and { b:2, a:1 } produce the same hash.
 * Includes method, path, route params, and body.
 */
function computeRequestHash(req: Request): string {
  const canonical = stableStringify({
    method: req.method,
    path:   req.path,
    params: req.params,
    body:   req.body,
  });
  return createHash('sha256').update(canonical ?? '').digest('hex');
}

/**
 * PATCH 8: Strip sensitive fields and cap payload size before persisting.
 *
 * Prevents tokens, secrets, and giant payloads from being stored in the
 * idempotency replay cache. If the serialized result exceeds MAX_RESPONSE_BYTES,
 * a minimal stub is stored instead (clients still get the real response on the
 * original request — this only affects replay).
 */
function sanitizeResponse(body: unknown): unknown {
  const stripped = deepOmitKeys(body, SENSITIVE_KEYS);
  try {
    // JSON.stringify + parse: converts Decimal/Date/etc via .toJSON() so the
    // result is a plain JS object that Prisma can store in JSONB without errors.
    const serialized = JSON.stringify(stripped);
    if (serialized.length > MAX_RESPONSE_BYTES) {
      return { success: true, _truncated: true };
    }
    return JSON.parse(serialized);
  } catch {
    return { success: true, _truncated: true };
  }
}

function deepOmitKeys(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map(v => deepOmitKeys(v, keys));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!keys.has(k.toLowerCase())) {
        result[k] = deepOmitKeys(v, keys);
      }
    }
    return result;
  }
  return value;
}

// ─── Cleanup (called from cronJobs.ts) ───────────────────────────────────────

/**
 * PATCH 9: Cleanup policy — only delete COMPLETED/FAILED expired rows.
 *
 * Never deletes IN_PROGRESS rows — those are either legitimate (active request)
 * or stale (handled by per-request recovery). Deleting them would silently
 * break in-flight requests or make stale recovery impossible.
 */
export async function cleanupExpiredIdempotencyKeys(): Promise<void> {
  const now = new Date();

  const { count: deleted } = await prisma.idempotencyKey.deleteMany({
    where: {
      expiresAt: { lt: now },
      status:    { in: ['COMPLETED', 'FAILED'] },
    },
  });

  if (deleted > 0) {
    log.info({ deleted }, 'Expired idempotency keys cleaned up');
  }

  // PATCH 9: Log but never delete stuck IN_PROGRESS rows — anomaly indicator
  const stuck = await prisma.idempotencyKey.count({
    where: { expiresAt: { lt: now }, status: 'IN_PROGRESS' },
  });
  if (stuck > 0) {
    log.warn({ stuck }, 'Expired IN_PROGRESS idempotency keys detected — possible crash residue');
  }
}
