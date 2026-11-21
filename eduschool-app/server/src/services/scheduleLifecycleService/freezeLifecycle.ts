
import { createOpenEndedFreeze, cancelAllActiveFreezes } from '../freezeService';
import {
  LifecycleActor,
} from '../scheduleLifecycleTypes';
import { DbClient } from './lifecycleShared';
import {
  requireLifecycleReason,
} from './lifecycleGuards';

/**
 * Applies a billing freeze to a student.
 * PR 5: delegates to freezeService.createOpenEndedFreeze (StudentFreeze is source of truth).
 *
 * API contract preserved — callers (PATCH /users/:id/freeze) unchanged.
 * Creates an open-ended PERIOD freeze; skips deadline enforcement (legacy admin-toggle).
 * isFrozen/frozenAt on StudentProfile are synced as side effect inside freezeService.
 */
export async function applyFreeze(params: {
  studentProfileId: number;
  schoolId: number;
  actor: LifecycleActor;
  frozenAt?: Date;
  reason?: string;
  client?: DbClient;
}): Promise<any> {
  const reasonCheck = requireLifecycleReason('FREEZE_APPLIED', params.reason);
  if (!reasonCheck.valid) {
    throw Object.assign(new Error(reasonCheck.reason), { httpStatus: 400 });
  }
  return createOpenEndedFreeze({
    studentProfileId: params.studentProfileId,
    schoolId:         params.schoolId,
    actor:            params.actor,
    frozenAt:         params.frozenAt,
    reason:           params.reason,
    client:           params.client,
  });
}

/**
 * Reverses a billing freeze for a student.
 * PR 5: delegates to freezeService.cancelAllActiveFreezes (StudentFreeze is source of truth).
 *
 * API contract preserved — callers (PATCH /users/:id/freeze) unchanged.
 * Cancels all ACTIVE StudentFreeze records; skips deadline enforcement (legacy admin-toggle).
 * isFrozen/frozenAt on StudentProfile are synced as side effect inside freezeService.
 */
export async function reverseFreeze(params: {
  studentProfileId: number;
  schoolId: number;
  actor: LifecycleActor;
  reason?: string;
  client?: DbClient;
}): Promise<any> {
  const reasonCheck = requireLifecycleReason('FREEZE_REVERSED', params.reason);
  if (!reasonCheck.valid) {
    throw Object.assign(new Error(reasonCheck.reason), { httpStatus: 400 });
  }
  return cancelAllActiveFreezes({
    studentProfileId: params.studentProfileId,
    schoolId:         params.schoolId,
    actor:            params.actor,
    reason:           params.reason,
    client:           params.client,
  });
}

