import { PrismaClient, SessionStatus } from '@prisma/client';
import { Request } from 'express';

import prismaDefault from '../../lib/prisma';
import { emitToSchool } from '../../lib/socket';
import { logScheduleAction } from '../../lib/auditLog';
import { canTransition } from '../../lib/sessionStateMachine';
import {
  dispatchSessionCancelledNotifications,
  dispatchSessionInvalidatedNotifications,
} from '../scheduleLifecycleNotificationService';
import { reconcileRosterOnMemberAdd, reconcileRosterOnMemberRemove } from '../rosterService';
import {
  LifecycleActor,
  deriveEventType,
} from '../scheduleLifecycleTypes';
import { log, emitScheduleSessionChanged, cancelLessonSkipFreezesForSession, studentUserIdsFromMemberships, DbClient, SessionForStatusChange } from './lifecycleShared';
import {
  assertSessionBelongsToSchool, requireLifecycleReason,
  assertNoSalaryLockedSessionMutation, assertNoCreditDeductedAttendance,
} from './lifecycleGuards';
import { SESSION_STATUS_CHANGE_INCLUDE } from './lifecycleAudit';

// ─── Core: changeSessionStatus ────────────────────────────────────────────────

/**
 * Central implementation for all session status transitions.
 * Called by: cancelSession, restoreSession, invalidateSession,
 *            and directly by PATCH /session/:id/status route.
 *
 * Orchestrates:
 *   1. canTransition() validation
 *   2. Restore guard (INVALIDATED → UPCOMING with financial data check)
 *   3. DB update (version-guarded)
 *   4. Audit log (logScheduleAction)
 *   5. Parent notifications (SESSION_CANCELLED only, current behavior)
 *   6. Socket emit
 *
 * Preserves IDENTICAL behavior to the inline route logic — no behavior change.
 */
export async function changeSessionStatus(params: {
  session: SessionForStatusChange;
  targetStatus: SessionStatus;
  actor: LifecycleActor;
  reason?: string;
  /** If provided, the DB update uses optimistic version guard (throws P2025 if stale). */
  versionGuard?: number;
  req?: Request;
  client?: DbClient;
}): Promise<any> {
  const { session, targetStatus, actor, reason, versionGuard, req } = params;
  const client = (params.client ?? prismaDefault) as PrismaClient;

  // 1. State machine validation + reason enforcement
  const eventType = deriveEventType(session.status, targetStatus);

  const reasonCheck = requireLifecycleReason(eventType, reason);
  if (!reasonCheck.valid) {
    throw Object.assign(new Error(reasonCheck.reason), { httpStatus: 400 });
  }

  const transition = canTransition(session.status, targetStatus, actor.role);
  if (!transition.allowed) {
    throw Object.assign(new Error(transition.reason), { httpStatus: 403 });
  }

  // 2. Restore guard: INVALIDATED → UPCOMING blocked if session has financial data.
  //    This matches the current route behavior exactly.
  if (session.status === 'INVALIDATED' && targetStatus === 'UPCOMING') {
    const [attendanceCount, paymentLink] = await Promise.all([
      client.attendance.count({ where: { lessonSessionId: session.id } }),
      client.teacherPaymentLesson.findFirst({ where: { lessonSessionId: session.id } }),
    ]);
    if (attendanceCount > 0 || paymentLink) {
      throw Object.assign(new Error('SESSION_HAS_FINANCIAL_DATA'), {
        httpStatus: 409,
        details: {
          message: 'Сессия содержит данные посещаемости или выплат и не может быть восстановлена',
        },
      });
    }
  }

  // 3-5a. Atomic DB writes: cancel guard + status update + audit + freeze cleanup must all commit or all roll back.
  // When client is a full PrismaClient (not already inside a tx), start a new transaction.
  // When client is a transaction client (no $transaction method), use it directly.
  const hasTx = typeof (client as any).$transaction === 'function';

  const runTx = async (txClient: DbClient): Promise<any> => {
    // 2b. Cancel guard (inside tx — avoids TOCTOU between pre-check and update).
    //     Correction flow is a separate task. See ADR-026.
    await assertNoCreditDeductedAttendance(session.id, targetStatus, txClient);

    // 3. DB update (with version guard for optimistic locking)
    const updated = await (txClient as PrismaClient).lessonSession.update({
      where: {
        id: session.id,
        ...(versionGuard !== undefined && { version: versionGuard }),
      },
      data: { status: targetStatus, version: { increment: 1 } },
      include: SESSION_STATUS_CHANGE_INCLUDE,
    });

    // 4. Audit log
    const auditAction =
      targetStatus === 'CANCELLED' ? 'CANCEL'
      : targetStatus === 'UPCOMING' ? 'RESTORE'
      : `SET_${targetStatus}`;

    await logScheduleAction({
      client: txClient,
      schoolId: updated.schoolId,
      userId: actor.userId,
      action: auditAction,
      entityType: 'session',
      sessionId: updated.id,
      before: { status: session.status },
      after: { status: updated.status },
      reason,
      req,
    });

    // 5a. Freeze cleanup (CANCELLED only): cancel orphaned LESSON_SKIP freezes + sync isFrozen cache.
    if (targetStatus === 'CANCELLED') {
      await cancelLessonSkipFreezesForSession(txClient, session.id);
    }

    return updated;
  };

  const updated: any = hasTx
    ? await (client as PrismaClient).$transaction(runTx)
    : await runTx(client);

  // 5b. Notifications (best-effort, outside transaction — must not rollback status update).
  if (targetStatus === 'CANCELLED') {
    const studentUserIds = studentUserIdsFromMemberships((updated as any).lessonBlock?.studentGroup);

    const teacherUserId = (updated as any).teacher?.userId as number | undefined;

    try {
      await dispatchSessionCancelledNotifications({
        sessionId:      updated.id,
        lessonBlockId:  updated.lessonBlockId,
        sessionDate:    updated.date,
        blockLevel:     (updated as any).lessonBlock?.level ?? '',
        reason,
        studentUserIds,
        teacherUserId,
      });
    } catch (err) {
      log.warn({ err, sessionId: updated.id }, 'SESSION_CANCELLED notification dispatch failed');
    }
  }

  // 6. Socket emit (outside transaction)
  emitToSchool(updated.schoolId, 'session:status-changed', {
    sessionId: updated.id,
    lessonBlockId: updated.lessonBlockId,
    status: updated.status,
    date: updated.date,
  });
  emitScheduleSessionChanged(updated.schoolId, {
    sessionId: updated.id,
    lessonBlockId: updated.lessonBlockId,
    status: updated.status,
    date: updated.date,
    action: 'status-changed',
  });

  return updated;
}

// ─── High-level wrappers ───────────────────────────────────────────────────────

/**
 * Cancels a session.
 * PR 3: reason enforcement now active — changeSessionStatus throws 400 if
 *   reason is absent or shorter than 5 chars (SESSION_CANCELLED is in
 *   EVENTS_REQUIRING_REASON). Bulk-cancel route calls this per session.
 */
export async function cancelSession(params: {
  sessionId: number;
  schoolId: number;
  actor: LifecycleActor;
  reason?: string;
  versionGuard?: number;
  req?: Request;
  client?: DbClient;
}): Promise<any> {
  const prismaClient = (params.client ?? prismaDefault) as PrismaClient;
  const session = await assertSessionBelongsToSchool(
    params.sessionId,
    params.schoolId,
    prismaClient,
  );
  const fullSession = await prismaClient.lessonSession.findFirst({
    where: { id: session.id, schoolId: params.schoolId },
    include: SESSION_STATUS_CHANGE_INCLUDE,
  });
  if (!fullSession) throw Object.assign(new Error('SESSION_NOT_FOUND'), { httpStatus: 404 });

  return changeSessionStatus({
    session: fullSession as unknown as SessionForStatusChange,
    targetStatus: 'CANCELLED',
    actor: params.actor,
    reason: params.reason,
    versionGuard: params.versionGuard,
    req: params.req,
    client: prismaClient,
  });
}

/**
 * Restores a cancelled session to UPCOMING.
 * After the status transition, reconciles the SessionStudent roster via rosterService:
 * adds students who joined the group during the cancellation window, removes
 * students who withdrew (if they have no attendance on this session).
 */
export async function restoreSession(params: {
  sessionId: number;
  schoolId: number;
  actor: LifecycleActor;
  reason?: string;
  versionGuard?: number;
  req?: Request;
  client?: DbClient;
}): Promise<any> {
  const prismaClient = (params.client ?? prismaDefault) as PrismaClient;

  // Load session outside the transaction (read-only preflight).
  const session = await prismaClient.lessonSession.findFirst({
    where: { id: params.sessionId, schoolId: params.schoolId, deletedAt: null },
    include: SESSION_STATUS_CHANGE_INCLUDE,
  });
  if (!session) throw Object.assign(new Error('SESSION_NOT_FOUND'), { httpStatus: 404 });

  // F-02 FIX: Block restore when an active (non-CANCELLED) makeup already exists.
  // Restoring the original + keeping the makeup would produce two UPCOMING sessions
  // for the same slot, causing double credit deduction when both are attended.
  const activeMakeup = await prismaClient.lessonSession.findFirst({
    where: {
      makeupForSessionId: params.sessionId,
      status:             { not: 'CANCELLED' },
      deletedAt:          null,
    },
    select: { id: true, date: true, status: true },
  });
  if (activeMakeup) {
    throw Object.assign(new Error('ACTIVE_MAKEUP_EXISTS'), {
      httpStatus: 409,
      details: {
        lifecycleError:  true,
        activeMakeupId:  activeMakeup.id,
        activeMakeupDate: activeMakeup.date,
        message: 'Cannot restore: an active makeup session exists for this cancelled session. Cancel the makeup first.',
      },
    });
  }

  // F-06 FIX: Wrap status transition + roster reconciliation in a single transaction.
  // Previously these were separate sequential commits: if reconciliation failed after
  // the status update committed, the session was UPCOMING with a stale roster and no
  // recovery path (canTransition blocks UPCOMING→UPCOMING retries).
  return prismaClient.$transaction(async (tx) => {
    const dbClient = tx as unknown as PrismaClient;

    // Status transition. changeSessionStatus accepts a DbClient and uses it for all
    // its DB writes (update + audit log). Socket emits and notifications inside
    // changeSessionStatus use prismaDefault directly, so they remain outside this tx.
    const restored = await changeSessionStatus({
      session: session as unknown as SessionForStatusChange,
      targetStatus: 'UPCOMING',
      actor:        params.actor,
      reason:       params.reason,
      versionGuard: params.versionGuard,
      req:          params.req,
      client:       dbClient,
    });

    // Roster reconciliation — same tx client keeps add + remove atomic with the
    // status transition. If reconciliation fails here the whole tx rolls back,
    // leaving the session CANCELLED (recoverable state — admin can retry).
    const groupId = (restored as any).lessonBlock?.studentGroupId as number | undefined;
    if (groupId) {
      const memberships = await dbClient.groupMembership.findMany({
        where:  { studentGroupId: groupId, schoolId: params.schoolId },
        select: { studentProfileId: true, status: true },
      });

      const activeIds = memberships
        .filter((m: { studentProfileId: number; status: string }) => m.status === 'ACTIVE')
        .map((m: { studentProfileId: number; status: string }) => m.studentProfileId);

      const withdrawnIds = memberships
        .filter((m: { studentProfileId: number; status: string }) => m.status === 'WITHDRAWN')
        .map((m: { studentProfileId: number; status: string }) => m.studentProfileId);

      if (activeIds.length > 0) {
        await reconcileRosterOnMemberAdd(groupId, params.schoolId, activeIds, dbClient);
      }
      for (const studentId of withdrawnIds) {
        await reconcileRosterOnMemberRemove(groupId, params.schoolId, studentId, dbClient);
      }
    }

    return restored;
  });
}

/**
 * Invalidates a session (marks as INVALIDATED without deleting financial data).
 * PR 3: core implementation.
 * PR 5: salary safety guard + admin notification.
 *
 * Guards:
 *   - reason required (≥ 5 chars)
 *   - session belongs to school (tenant isolation)
 *   - salary safety: 409 if TeacherPaymentLesson exists (correction flow required — TODO PR 6)
 *   - LOCKED: only SUPERADMIN can override (special path bypassing state machine)
 *   - financial data is never deleted — INVALIDATED is a soft marker
 *
 * Side effects:
 *   - DB: status → INVALIDATED, version++
 *   - Audit via logScheduleAction (action = SET_INVALIDATED)
 *   - Socket emit: session:status-changed
 *   - Admin notification: SESSION_INVALIDATED_ALERT (notifyParents = false — admin/internal only)
 */
export async function invalidateSession(params: {
  sessionId: number;
  schoolId: number;
  actor: LifecycleActor;
  reason: string;
  client?: DbClient;
}): Promise<any> {
  const prismaClient = (params.client ?? prismaDefault) as PrismaClient;

  // Reason validation
  const reasonCheck = requireLifecycleReason('SESSION_INVALIDATED', params.reason);
  if (!reasonCheck.valid) {
    throw Object.assign(new Error(reasonCheck.reason!), { httpStatus: 400 });
  }

  const session = await prismaClient.lessonSession.findFirst({
    where: { id: params.sessionId, schoolId: params.schoolId, deletedAt: null },
    include: SESSION_STATUS_CHANGE_INCLUDE,
  });
  if (!session) {
    throw Object.assign(new Error('SESSION_NOT_FOUND'), { httpStatus: 404 });
  }

  // Salary safety guard (PR 5): block invalidation if salary payment already attributed
  await assertNoSalaryLockedSessionMutation(params.sessionId, 'SESSION_INVALIDATED', prismaClient);

  // LOCKED sessions: only SUPERADMIN can invalidate (bypass state machine)
  if (session.status === 'LOCKED') {
    if (params.actor.role !== 'SUPERADMIN') {
      throw Object.assign(
        new Error('Cannot invalidate a LOCKED session without SUPERADMIN permission'),
        { httpStatus: 403 },
      );
    }
    // SUPERADMIN override: direct DB update (canTransition hard-blocks LOCKED).
    // D-05: wrap update + audit in one transaction.
    const updated = await prismaClient.$transaction(async (tx) => {
      const dbClient = tx as unknown as PrismaClient;
      const upd = await dbClient.lessonSession.update({
        where: { id: params.sessionId },
        data: { status: 'INVALIDATED', version: { increment: 1 } },
        include: SESSION_STATUS_CHANGE_INCLUDE,
      });
      await logScheduleAction({
        client: dbClient,
        schoolId: params.schoolId,
        userId: params.actor.userId,
        action: 'SET_INVALIDATED',
        entityType: 'session',
        sessionId: params.sessionId,
        before: { status: 'LOCKED' },
        after: { status: 'INVALIDATED' },
        reason: params.reason,
      });
      return upd;
    });
    emitToSchool(params.schoolId, 'session:status-changed', {
      sessionId: params.sessionId,
      lessonBlockId: session.lessonBlockId,
      status: 'INVALIDATED',
      date: session.date,
    });
    emitScheduleSessionChanged(params.schoolId, {
      sessionId: params.sessionId,
      lessonBlockId: session.lessonBlockId,
      status: 'INVALIDATED',
      date: session.date,
      action: 'invalidated',
    });
    // Admin notification (PR 5): best-effort
    try {
      await dispatchSessionInvalidatedNotifications(prismaClient, {
        sessionId:   params.sessionId,
        schoolId:    params.schoolId,
        sessionDate: session.date,
        actorUserId: params.actor.userId,
        reason:      params.reason,
      });
    } catch (err) {
      log.warn({ err, sessionId: params.sessionId }, 'SESSION_INVALIDATED admin notification failed');
    }
    return updated;
  }

  // Normal path: state machine enforces UPCOMING/IN_PROGRESS → INVALIDATED for OWNER/ADMIN
  // Reason is already validated above; changeSessionStatus will re-check (no-op, fine).
  const result = await changeSessionStatus({
    session: session as unknown as SessionForStatusChange,
    targetStatus: 'INVALIDATED',
    actor: params.actor,
    reason: params.reason,
    client: prismaClient,
  });

  // Admin notification (PR 5): best-effort
  try {
    await dispatchSessionInvalidatedNotifications(prismaClient, {
      sessionId:   params.sessionId,
      schoolId:    params.schoolId,
      sessionDate: session.date,
      actorUserId: params.actor.userId,
      reason:      params.reason,
    });
  } catch (err) {
    log.warn({ err, sessionId: params.sessionId }, 'SESSION_INVALIDATED admin notification failed');
  }

  return result;
}

