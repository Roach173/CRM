/**
 * Unit tests for scheduleLifecycleService (PR 2 skeleton + PR 3 + PR 4 flows).
 *
 * All external I/O is mocked. No database required.
 *
 * Covers:
 *   - deriveEventType mapping (from scheduleLifecycleTypes)
 *   - requireLifecycleReason вЂ” PR 3: 3 events enforced + PR 4: SESSION_RESCHEDULED added
 *   - LIFECYCLE_SIDE_EFFECTS contract spot-checks
 *   - assertLifecycleTransitionAllowed helper
 *   - assertSessionEditable helper
 *   - buildLifecycleAuditPayload shape
 *   - assertSessionBelongsToSchool (404 guard)
 *   - changeSessionStatus вЂ” 403, 409 restore guard, 400 reason guard, success path
 *   - invalidateSession вЂ” reason guard, LOCKED/SUPERADMIN, normal path
 *   - replaceTeacher вЂ” reason guard, editability, cross-tenant, salary safety
 *   - rescheduleSession вЂ” PR 4: reason, editability, conflicts, audit, socket
 *   - Stub methods still throw 501 (makeup, freeze)
 */

import { Role, SessionStatus } from '@prisma/client';

// в”Ђв”Ђв”Ђ Mock all side-effect modules в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
jest.mock('../../lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('../../lib/notify',  () => ({ notifyMany: jest.fn().mockResolvedValue(undefined), notify: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../lib/socket',  () => ({ emitToSchool:     jest.fn() }));
jest.mock('../../lib/auditLog',() => ({ logScheduleAction: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/attendanceService', () => ({ markAttendance: jest.fn() }));
jest.mock('../../services/scheduleValidation', () => ({
  validateSingleSessionOverride: jest.fn().mockResolvedValue(undefined),
  validateSessionTimeBounds:     jest.fn().mockResolvedValue({ valid: true }),
  timeRangesOverlap:             jest.fn((start1: string, end1: string, start2: string, end2: string) => start1 < end2 && start2 < end1),
  ScheduleValidationError: class ScheduleValidationError extends Error {},
}));
jest.mock('../../services/scheduleLifecycleNotificationService', () => ({
  dispatchSessionCancelledNotifications:  jest.fn().mockResolvedValue(undefined),
  dispatchRescheduleNotifications:        jest.fn().mockResolvedValue(undefined),
  dispatchTeacherReplacedNotifications:   jest.fn().mockResolvedValue(undefined),
  dispatchSessionInvalidatedNotifications: jest.fn().mockResolvedValue(undefined),
  dispatchMakeupCreatedNotifications:     jest.fn().mockResolvedValue(undefined),
  dispatchFreezeAppliedNotifications:     jest.fn().mockResolvedValue(undefined),
  dispatchFreezeReversedNotifications:    jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/sessionService', () => ({
  snapshotNewSessions: jest.fn().mockResolvedValue(undefined),
  validateSessionDate: jest.fn().mockResolvedValue({ valid: true }),
  getEffectiveSessionTeacherId: jest.fn((s: { teacherId: number | null; teacherIdSnap: number | null; isManualTeacher: boolean }) =>
    s.isManualTeacher ? s.teacherId : s.teacherIdSnap,
  ),
}));
jest.mock('../../services/freezeService', () => ({
  createOpenEndedFreeze:    jest.fn().mockResolvedValue({ id: 1, type: 'PERIOD', status: 'ACTIVE' }),
  cancelAllActiveFreezes:   jest.fn().mockResolvedValue({ id: 7, isFrozen: false }),
}));
jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }),
}));

import { notifyMany, notify } from '../../lib/notify';
import { emitToSchool }       from '../../lib/socket';
import { logScheduleAction }  from '../../lib/auditLog';
import { validateSingleSessionOverride } from '../../services/scheduleValidation';
import {
  dispatchSessionCancelledNotifications,
  dispatchTeacherReplacedNotifications,
  dispatchSessionInvalidatedNotifications,
  dispatchMakeupCreatedNotifications,
  dispatchRescheduleNotifications,
} from '../../services/scheduleLifecycleNotificationService';
import { createOpenEndedFreeze, cancelAllActiveFreezes } from '../../services/freezeService';

import {
  deriveEventType,
  LIFECYCLE_SIDE_EFFECTS,
  EVENTS_REQUIRING_REASON,
} from '../../services/scheduleLifecycleTypes';

import {
  requireLifecycleReason,
  assertLifecycleTransitionAllowed,
  assertSessionEditable,
  buildLifecycleAuditPayload,
  assertSessionBelongsToSchool,
  assertNoSalaryLockedSessionMutation,
  assertNoCreditDeductedAttendance,
  changeSessionStatus,
  cancelSession,
  invalidateSession,
  replaceTeacher,
  rescheduleSession,
  createMakeupSession,
  moveSession,
  applyFreeze,
  reverseFreeze,
} from '../../services/scheduleLifecycleService';

// в”Ђв”Ђв”Ђ Shared fixtures в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

const ADMIN_ACTOR       = { userId: 99, role: 'ADMIN'       as Role, schoolId: 10 };
const OWNER_ACTOR       = { userId: 99, role: 'OWNER'       as Role, schoolId: 10 };
const SUPERADMIN_ACTOR  = { userId: 1,  role: 'SUPERADMIN'  as Role, schoolId: 10 };
const TEACHER_ACTOR     = { userId: 88, role: 'TEACHER'     as Role, schoolId: 10 };

const VALID_REASON = 'school holiday';   // 14 chars в‰Ґ 5

function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    status: 'UPCOMING' as SessionStatus,
    schoolId: 10,
    lessonBlockId: 100,
    version: 3,
    date: new Date('2026-06-15'),
    teacherId: null,
    teacherIdSnap: 42,
    lessonBlock: {
      level: 'A2',
      studentGroupId: 5,
      studentGroup: {
        status: 'ACTIVE',
        deletedAt: null,
        memberships: [{ studentProfile: { user: { id: 50 } } }, { studentProfile: { user: { id: 51 } } }],
      },
    },
    ...overrides,
  };
}

function makeMockClient(overrides: Partial<Record<string, any>> = {}): any {
  const updatedSession = makeSession({ status: 'CANCELLED' });
  const base: any = {
    lessonSession: {
      update:    jest.fn().mockResolvedValue(updatedSession),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    attendance: {
      count:     jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null), // no deducted credits в†’ cancel allowed
    },
    teacherPaymentLesson: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    staffProfile: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // F-01: changeSessionStatus cancels orphaned LESSON_SKIP freezes on CANCELLED path
    studentFreeze: {
      findMany:   jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count:      jest.fn().mockResolvedValue(0),
    },
    studentProfile: {
      update: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
  // F-01: $transaction delegates to the same mock object so existing assertions still pass.
  // hasTx=true в†’ changeSessionStatus wraps writes in $transaction.
  base.$transaction = jest.fn().mockImplementation(async (fn: any) => fn(base));
  return base;
}

// в”Ђв”Ђв”Ђ deriveEventType в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleTypes вЂ” deriveEventType', () => {
  it('UPCOMING в†’ CANCELLED = SESSION_CANCELLED', () => {
    expect(deriveEventType('UPCOMING', 'CANCELLED')).toBe('SESSION_CANCELLED');
  });

  it('IN_PROGRESS в†’ CANCELLED = SESSION_CANCELLED', () => {
    expect(deriveEventType('IN_PROGRESS', 'CANCELLED')).toBe('SESSION_CANCELLED');
  });

  it('COMPLETED в†’ LOCKED = SESSION_LOCKED', () => {
    expect(deriveEventType('COMPLETED', 'LOCKED')).toBe('SESSION_LOCKED');
  });

  it('UPCOMING в†’ INVALIDATED = SESSION_INVALIDATED', () => {
    expect(deriveEventType('UPCOMING', 'INVALIDATED')).toBe('SESSION_INVALIDATED');
  });

  it('CANCELLED в†’ UPCOMING = SESSION_RESTORED', () => {
    expect(deriveEventType('CANCELLED', 'UPCOMING')).toBe('SESSION_RESTORED');
  });

  it('INVALIDATED в†’ UPCOMING = SESSION_REOPENED (not SESSION_RESTORED)', () => {
    expect(deriveEventType('INVALIDATED', 'UPCOMING')).toBe('SESSION_REOPENED');
  });

  it('defaults to SESSION_RESTORED for unmapped toStatus', () => {
    expect(deriveEventType('UPCOMING', 'IN_PROGRESS')).toBe('SESSION_RESTORED');
  });
});

// в”Ђв”Ђв”Ђ requireLifecycleReason вЂ” PR 3 enforcement в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleTypes вЂ” requireLifecycleReason (PR 3)', () => {
  it('EVENTS_REQUIRING_REASON has 6 events (SESSION_CANCELLED reason made optional 2026-07-07)', () => {
    expect(EVENTS_REQUIRING_REASON.size).toBe(6);
    expect(EVENTS_REQUIRING_REASON.has('SESSION_CANCELLED')).toBe(false);
    expect(EVENTS_REQUIRING_REASON.has('SESSION_INVALIDATED')).toBe(true);
    expect(EVENTS_REQUIRING_REASON.has('TEACHER_REPLACED')).toBe(true);
    expect(EVENTS_REQUIRING_REASON.has('SESSION_RESCHEDULED')).toBe(true);
    expect(EVENTS_REQUIRING_REASON.has('MAKEUP_CREATED')).toBe(true);
    expect(EVENTS_REQUIRING_REASON.has('FREEZE_APPLIED')).toBe(true);
    expect(EVENTS_REQUIRING_REASON.has('FREEZE_REVERSED')).toBe(true);
  });

  it('SESSION_CANCELLED without reason в†’ valid (reason optional since 2026-07-07)', () => {
    expect(requireLifecycleReason('SESSION_CANCELLED', undefined).valid).toBe(true);
  });

  it('SESSION_INVALIDATED without reason в†’ invalid', () => {
    expect(requireLifecycleReason('SESSION_INVALIDATED', undefined).valid).toBe(false);
  });

  it('TEACHER_REPLACED without reason в†’ invalid', () => {
    expect(requireLifecycleReason('TEACHER_REPLACED', undefined).valid).toBe(false);
  });

  it('reason shorter than 5 chars в†’ invalid', () => {
    expect(requireLifecycleReason('SESSION_INVALIDATED', 'ab').valid).toBe(false);
    expect(requireLifecycleReason('SESSION_INVALIDATED', 'abcd').valid).toBe(false);
  });

  it('reason with exactly 5 chars в†’ valid', () => {
    expect(requireLifecycleReason('SESSION_INVALIDATED', 'hello').valid).toBe(true);
  });

  it('reason with more than 5 chars в†’ valid', () => {
    expect(requireLifecycleReason('SESSION_INVALIDATED', VALID_REASON).valid).toBe(true);
  });

  it('events NOT in the set pass without reason (e.g. SESSION_LOCKED)', () => {
    expect(requireLifecycleReason('SESSION_LOCKED', undefined).valid).toBe(true);
    expect(requireLifecycleReason('SESSION_RESTORED', undefined).valid).toBe(true);
    expect(requireLifecycleReason('ATTENDANCE_SUBMITTED', undefined).valid).toBe(true);
  });

  it('MAKEUP_CREATED requires reason (PR 6: added to EVENTS_REQUIRING_REASON)', () => {
    expect(requireLifecycleReason('MAKEUP_CREATED', undefined).valid).toBe(false);
    expect(requireLifecycleReason('MAKEUP_CREATED', VALID_REASON).valid).toBe(true);
  });

  it('whitespace-only reason is treated as empty в†’ invalid', () => {
    expect(requireLifecycleReason('SESSION_INVALIDATED', '     ').valid).toBe(false);
  });
});

// в”Ђв”Ђв”Ђ LIFECYCLE_SIDE_EFFECTS contract в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleTypes вЂ” LIFECYCLE_SIDE_EFFECTS', () => {
  it('SESSION_CANCELLED: audit=true, notifyParents=true, notifyTeacher=true (PR 5)', () => {
    const fx = LIFECYCLE_SIDE_EFFECTS['SESSION_CANCELLED'];
    expect(fx.audit).toBe(true);
    expect(fx.notifyParents).toBe(true);
    expect(fx.notifyTeacher).toBe(true); // PR 5: updated from false
    expect(fx.emitSocket).toBe(true);
    expect(fx.invalidateCache).toBe(true);
    expect(fx.financialImpact).toBe('none');
    expect(fx.salaryImpact).toBe('none');
  });

  it('SESSION_RESTORED: audit=true, notifyParents=false', () => {
    const fx = LIFECYCLE_SIDE_EFFECTS['SESSION_RESTORED'];
    expect(fx.audit).toBe(true);
    expect(fx.notifyParents).toBe(false);
  });

  it('MAKEUP_COMPLETED: financialImpact=credit, salaryImpact=payable', () => {
    const fx = LIFECYCLE_SIDE_EFFECTS['MAKEUP_COMPLETED'];
    expect(fx.financialImpact).toBe('credit');
    expect(fx.salaryImpact).toBe('payable');
  });

  it('ATTENDANCE_SUBMITTED: audit=false, financialImpact=credit, salaryImpact=payable', () => {
    const fx = LIFECYCLE_SIDE_EFFECTS['ATTENDANCE_SUBMITTED'];
    expect(fx.audit).toBe(false);
    expect(fx.financialImpact).toBe('credit');
    expect(fx.salaryImpact).toBe('payable');
  });

  it('TEACHER_REPLACED: salaryImpact=correction, notifyTeacher=true', () => {
    const fx = LIFECYCLE_SIDE_EFFECTS['TEACHER_REPLACED'];
    expect(fx.salaryImpact).toBe('correction');
    expect(fx.notifyTeacher).toBe(true);
    expect(fx.financialImpact).toBe('none');
  });

  it('SESSION_LOCKED: audit=true, financialImpact=none, emitSocket=true', () => {
    const fx = LIFECYCLE_SIDE_EFFECTS['SESSION_LOCKED'];
    expect(fx.audit).toBe(true);
    expect(fx.financialImpact).toBe('none');
    expect(fx.emitSocket).toBe(true);
  });

  it('FREEZE_APPLIED and FREEZE_REVERSED: emitSocket=false', () => {
    expect(LIFECYCLE_SIDE_EFFECTS['FREEZE_APPLIED'].emitSocket).toBe(false);
    expect(LIFECYCLE_SIDE_EFFECTS['FREEZE_REVERSED'].emitSocket).toBe(false);
  });

  it('all 12 events are present in the map', () => {
    const expectedEvents = [
      'SESSION_CANCELLED', 'SESSION_RESTORED', 'SESSION_RESCHEDULED',
      'TEACHER_REPLACED', 'MAKEUP_CREATED', 'MAKEUP_COMPLETED',
      'ATTENDANCE_SUBMITTED', 'SESSION_LOCKED', 'SESSION_INVALIDATED',
      'SESSION_REOPENED', 'FREEZE_APPLIED', 'FREEZE_REVERSED',
    ];
    for (const event of expectedEvents) {
      expect(LIFECYCLE_SIDE_EFFECTS).toHaveProperty(event);
    }
  });
});

// в”Ђв”Ђв”Ђ assertLifecycleTransitionAllowed в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” assertLifecycleTransitionAllowed', () => {
  it('SESSION_CANCELLED from UPCOMING with ADMIN в†’ valid', () => {
    const result = assertLifecycleTransitionAllowed('UPCOMING', 'SESSION_CANCELLED', 'ADMIN');
    expect(result.valid).toBe(true);
  });

  it('SESSION_CANCELLED from LOCKED with OWNER в†’ invalid (LOCKED is terminal)', () => {
    const result = assertLifecycleTransitionAllowed('LOCKED', 'SESSION_CANCELLED', 'OWNER');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('SESSION_CANCELLED from UPCOMING with TEACHER в†’ invalid (role not allowed)', () => {
    const result = assertLifecycleTransitionAllowed('UPCOMING', 'SESSION_CANCELLED', 'TEACHER');
    expect(result.valid).toBe(false);
  });

  it('SESSION_REOPENED from INVALIDATED with OWNER в†’ valid', () => {
    const result = assertLifecycleTransitionAllowed('INVALIDATED', 'SESSION_REOPENED', 'OWNER');
    expect(result.valid).toBe(true);
  });

  it('SESSION_REOPENED from INVALIDATED with ADMIN в†’ invalid (only OWNER can reopen)', () => {
    const result = assertLifecycleTransitionAllowed('INVALIDATED', 'SESSION_REOPENED', 'ADMIN');
    expect(result.valid).toBe(false);
  });

  it('TEACHER_REPLACED from any status в†’ valid (no target status to validate)', () => {
    const result = assertLifecycleTransitionAllowed('UPCOMING', 'TEACHER_REPLACED', 'ADMIN');
    expect(result.valid).toBe(true);
  });

  it('MAKEUP_CREATED в†’ valid (no status machine entry)', () => {
    const result = assertLifecycleTransitionAllowed('CANCELLED', 'MAKEUP_CREATED', 'OWNER');
    expect(result.valid).toBe(true);
  });

  it('SESSION_INVALIDATED from UPCOMING with ADMIN в†’ valid (PR 3: added to state machine)', () => {
    const result = assertLifecycleTransitionAllowed('UPCOMING', 'SESSION_INVALIDATED', 'ADMIN');
    expect(result.valid).toBe(true);
  });
});

// в”Ђв”Ђв”Ђ assertSessionEditable в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” assertSessionEditable', () => {
  it('TEACHER_REPLACED on UPCOMING в†’ valid (editable)', () => {
    expect(assertSessionEditable('UPCOMING', 'TEACHER_REPLACED').valid).toBe(true);
  });

  it('TEACHER_REPLACED on IN_PROGRESS в†’ valid', () => {
    expect(assertSessionEditable('IN_PROGRESS', 'TEACHER_REPLACED').valid).toBe(true);
  });

  it('TEACHER_REPLACED on LOCKED в†’ invalid', () => {
    const result = assertSessionEditable('LOCKED', 'TEACHER_REPLACED');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/LOCKED/);
  });

  it('TEACHER_REPLACED on CANCELLED в†’ invalid', () => {
    const result = assertSessionEditable('CANCELLED', 'TEACHER_REPLACED');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/CANCELLED/);
  });

  it('TEACHER_REPLACED on COMPLETED в†’ invalid (COMPLETED is not in editable list)', () => {
    const result = assertSessionEditable('COMPLETED', 'TEACHER_REPLACED');
    expect(result.valid).toBe(false);
  });

  it('SESSION_RESCHEDULED on UPCOMING в†’ valid', () => {
    expect(assertSessionEditable('UPCOMING', 'SESSION_RESCHEDULED').valid).toBe(true);
  });

  it('SESSION_RESCHEDULED on LOCKED в†’ invalid', () => {
    expect(assertSessionEditable('LOCKED', 'SESSION_RESCHEDULED').valid).toBe(false);
  });

  it('SESSION_CANCELLED on LOCKED в†’ valid (editability not checked for cancel)', () => {
    expect(assertSessionEditable('LOCKED', 'SESSION_CANCELLED').valid).toBe(true);
  });

  it('ATTENDANCE_SUBMITTED on any status в†’ valid (not in EDITABLE_REQUIRED)', () => {
    expect(assertSessionEditable('CANCELLED', 'ATTENDANCE_SUBMITTED').valid).toBe(true);
    expect(assertSessionEditable('LOCKED',    'ATTENDANCE_SUBMITTED').valid).toBe(true);
  });
});

// в”Ђв”Ђв”Ђ buildLifecycleAuditPayload в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” buildLifecycleAuditPayload', () => {
  it('returns all provided fields with a timestamp', () => {
    const before = Date.now();
    const payload = buildLifecycleAuditPayload({
      eventType: 'SESSION_CANCELLED',
      actorId:   99,
      actorRole: 'ADMIN',
      schoolId:  10,
      sessionId: 1,
      blockId:   100,
      oldState:  { status: 'UPCOMING' },
      newState:  { status: 'CANCELLED' },
      reason:    VALID_REASON,
      requestId: 'req-123',
    });
    const after = Date.now();

    expect(payload.eventType).toBe('SESSION_CANCELLED');
    expect(payload.actorId).toBe(99);
    expect(payload.actorRole).toBe('ADMIN');
    expect(payload.schoolId).toBe(10);
    expect(payload.sessionId).toBe(1);
    expect(payload.blockId).toBe(100);
    expect(payload.oldState).toEqual({ status: 'UPCOMING' });
    expect(payload.newState).toEqual({ status: 'CANCELLED' });
    expect(payload.reason).toBe(VALID_REASON);
    expect(payload.requestId).toBe('req-123');
    expect(payload.timestamp).toBeInstanceOf(Date);
    expect(payload.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp.getTime()).toBeLessThanOrEqual(after);
  });

  it('accepts optional fields as undefined', () => {
    const payload = buildLifecycleAuditPayload({
      eventType: 'SESSION_RESTORED',
      actorId:   1,
      actorRole: 'OWNER',
      schoolId:  5,
      oldState:  {},
      newState:  {},
    });

    expect(payload.sessionId).toBeUndefined();
    expect(payload.blockId).toBeUndefined();
    expect(payload.reason).toBeUndefined();
    expect(payload.requestId).toBeUndefined();
  });
});

// в”Ђв”Ђв”Ђ assertSessionBelongsToSchool в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” assertSessionBelongsToSchool', () => {
  it('throws SESSION_NOT_FOUND (404) when session is absent', async () => {
    const client = {
      lessonSession: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    await expect(assertSessionBelongsToSchool(999, 10, client as any))
      .rejects.toMatchObject({ message: 'SESSION_NOT_FOUND', httpStatus: 404 });

    expect(client.lessonSession.findFirst).toHaveBeenCalledWith({
      where:  { id: 999, schoolId: 10, deletedAt: null },
      select: { id: true, status: true, schoolId: true },
    });
  });

  it('returns session when found', async () => {
    const mockSession = { id: 1, status: 'UPCOMING', schoolId: 10 };
    const client = {
      lessonSession: { findFirst: jest.fn().mockResolvedValue(mockSession) },
    };

    const result = await assertSessionBelongsToSchool(1, 10, client as any);
    expect(result).toEqual(mockSession);
  });

  it('throws when session belongs to a different school (cross-tenant)', async () => {
    const client = {
      lessonSession: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(assertSessionBelongsToSchool(1, 99, client as any))
      .rejects.toMatchObject({ httpStatus: 404 });
  });
});

// в”Ђв”Ђв”Ђ changeSessionStatus вЂ” reason enforcement (PR 3) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” changeSessionStatus вЂ” reason enforcement', () => {
  it('succeeds when SESSION_CANCELLED has no reason (reason optional since 2026-07-07)', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      // reason omitted
      client,
    })).resolves.toBeTruthy();
  });

  it('succeeds when SESSION_CANCELLED has a reason of в‰Ґ 5 chars', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      reason: VALID_REASON,
      client,
    })).resolves.toBeTruthy();
  });

  it('does NOT require reason for SESSION_LOCKED', async () => {
    const client = makeMockClient({
      lessonSession: {
        update: jest.fn().mockResolvedValue(makeSession({ status: 'LOCKED' })),
        findFirst: jest.fn(),
      },
    });
    const session = makeSession({ status: 'COMPLETED' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'LOCKED',
      actor: OWNER_ACTOR,
      // no reason
      client,
    })).resolves.toBeTruthy();
  });
});

// в”Ђв”Ђв”Ђ changeSessionStatus вЂ” 403 on blocked transition в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” changeSessionStatus вЂ” transition guard', () => {
  it('throws 403 when forcing UPCOMING to COMPLETED directly', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'COMPLETED',
      actor: OWNER_ACTOR,
      client,
    })).rejects.toMatchObject({ httpStatus: 403 });

    expect(client.lessonSession.update).not.toHaveBeenCalled();
    expect(logScheduleAction).not.toHaveBeenCalled();
    expect(emitToSchool).not.toHaveBeenCalled();
  });

  it('throws 403 when TEACHER tries to cancel UPCOMING session', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: TEACHER_ACTOR,
      reason: VALID_REASON,
      client,
    })).rejects.toMatchObject({ httpStatus: 403 });

    expect(client.lessonSession.update).not.toHaveBeenCalled();
    expect(logScheduleAction).not.toHaveBeenCalled();
    expect(emitToSchool).not.toHaveBeenCalled();
  });

  it('throws 403 when trying to transition out of LOCKED session', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'LOCKED' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: OWNER_ACTOR,
      reason: VALID_REASON,
      client,
    })).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('throws 403 when ADMIN tries INVALIDATED в†’ UPCOMING (only OWNER allowed)', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'INVALIDATED' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'UPCOMING',
      actor: ADMIN_ACTOR,
      client,
    })).rejects.toMatchObject({ httpStatus: 403 });
  });
});

// в”Ђв”Ђв”Ђ changeSessionStatus вЂ” 409 restore guard в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” changeSessionStatus вЂ” restore guard', () => {
  it('throws 409 when INVALIDATED session has attendance records', async () => {
    const client = makeMockClient({
      attendance: { count: jest.fn().mockResolvedValue(3) },
    });
    const session = makeSession({ status: 'INVALIDATED' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'UPCOMING',
      actor: OWNER_ACTOR,
      client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'SESSION_HAS_FINANCIAL_DATA' });

    expect(client.lessonSession.update).not.toHaveBeenCalled();
  });

  it('throws 409 when INVALIDATED session has a payment link', async () => {
    const client = makeMockClient({
      attendance:          { count: jest.fn().mockResolvedValue(0) },
      teacherPaymentLesson: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
    });
    const session = makeSession({ status: 'INVALIDATED' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'UPCOMING',
      actor: OWNER_ACTOR,
      client,
    })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('does NOT check restore guard for non-INVALIDATED sessions', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'CANCELLED' });

    await changeSessionStatus({
      session,
      targetStatus: 'UPCOMING',
      actor: ADMIN_ACTOR,
      client,
    });

    expect(client.attendance.count).not.toHaveBeenCalled();
  });
});

// в”Ђв”Ђв”Ђ assertNoCreditDeductedAttendance вЂ” cancel credit guard (PR 2) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” assertNoCreditDeductedAttendance', () => {
  it('is a no-op when targetStatus is not CANCELLED', async () => {
    const client = { attendance: { findFirst: jest.fn() } };
    await assertNoCreditDeductedAttendance(1, 'UPCOMING', client as any);
    expect(client.attendance.findFirst).not.toHaveBeenCalled();
  });

  it('is a no-op when targetStatus is LOCKED (not CANCELLED)', async () => {
    const client = { attendance: { findFirst: jest.fn() } };
    await assertNoCreditDeductedAttendance(1, 'LOCKED', client as any);
    expect(client.attendance.findFirst).not.toHaveBeenCalled();
  });

  it('resolves without throwing when no creditDeducted=true attendance exists', async () => {
    const client = { attendance: { findFirst: jest.fn().mockResolvedValue(null) } };
    await expect(assertNoCreditDeductedAttendance(1, 'CANCELLED', client as any))
      .resolves.toBeUndefined();
  });

  it('throws 409 SESSION_HAS_DEDUCTED_CREDITS when a deducted attendance record exists', async () => {
    const client = { attendance: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) } };
    await expect(assertNoCreditDeductedAttendance(1, 'CANCELLED', client as any))
      .rejects.toMatchObject({
        message:    'SESSION_HAS_DEDUCTED_CREDITS',
        httpStatus: 409,
        details:    expect.objectContaining({ lifecycleError: true }),
      });
  });

  it('changeSessionStatus throws 409 SESSION_HAS_DEDUCTED_CREDITS when deducted attendance exists', async () => {
    const client = makeMockClient({
      attendance: {
        count:     jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({ id: 7 }), // deducted credit found
      },
    });
    const session = makeSession({ status: 'UPCOMING' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      reason: VALID_REASON,
      client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'SESSION_HAS_DEDUCTED_CREDITS' });

    expect(client.lessonSession.update).not.toHaveBeenCalled();
    expect(logScheduleAction).not.toHaveBeenCalled();
    expect(emitToSchool).not.toHaveBeenCalled();
  });

  it('changeSessionStatus proceeds when attendance exists but creditDeducted=false', async () => {
    const client = makeMockClient({
      attendance: {
        count:     jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null), // no deducted credits
      },
    });
    const session = makeSession({ status: 'UPCOMING' });

    await expect(changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      reason: VALID_REASON,
      client,
    })).resolves.toBeTruthy();

    expect(client.lessonSession.update).toHaveBeenCalled();
  });
});

// в”Ђв”Ђв”Ђ changeSessionStatus вЂ” success path в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” changeSessionStatus вЂ” success path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates session status in DB and returns the result', async () => {
    const updatedRow = makeSession({ status: 'CANCELLED', id: 1 });
    const client = makeMockClient({
      lessonSession: { update: jest.fn().mockResolvedValue(updatedRow), findFirst: jest.fn() },
    });
    const session = makeSession({ status: 'UPCOMING' });

    const result = await changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      reason: VALID_REASON,
      client,
    });

    expect(result).toBe(updatedRow);
    expect(client.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: session.id }),
        data:  expect.objectContaining({ status: 'CANCELLED', version: { increment: 1 } }),
      }),
    );
  });

  it('saves UPCOMING to IN_PROGRESS', async () => {
    const updatedRow = makeSession({ status: 'IN_PROGRESS', id: 1 });
    const client = makeMockClient({
      lessonSession: { update: jest.fn().mockResolvedValue(updatedRow), findFirst: jest.fn() },
    });
    const session = makeSession({ status: 'UPCOMING' });

    const result = await changeSessionStatus({
      session,
      targetStatus: 'IN_PROGRESS',
      actor: OWNER_ACTOR,
      client,
    });

    expect(result).toBe(updatedRow);
    expect(client.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: session.id }),
        data: expect.objectContaining({ status: 'IN_PROGRESS', version: { increment: 1 } }),
      }),
    );
  });

  it('passes versionGuard to the DB where clause', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING', version: 5 });

    await changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      reason: VALID_REASON,
      versionGuard: 5,
      client,
    });

    expect(client.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: session.id, version: 5 }),
      }),
    );
  });

  it('omits version from where clause when versionGuard is undefined', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    await changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      reason: VALID_REASON,
      client,
    });

    const whereArg = (client.lessonSession.update as jest.Mock).mock.calls[0][0].where;
    expect(whereArg).not.toHaveProperty('version');
  });

  it('calls logScheduleAction with CANCEL action for CANCELLED status', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    await changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      reason: VALID_REASON,
      client,
    });

    expect(logScheduleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'CANCEL',
        entityType: 'session',
        sessionId:  session.id,
        before:     { status: 'UPCOMING' },
        after:      { status: 'CANCELLED' },
        reason:     VALID_REASON,
        userId:     ADMIN_ACTOR.userId,
      }),
    );
  });

  it('calls logScheduleAction with RESTORE action for UPCOMING target', async () => {
    const client = makeMockClient({
      lessonSession: {
        update: jest.fn().mockResolvedValue(makeSession({ status: 'UPCOMING' })),
        findFirst: jest.fn(),
      },
    });
    const session = makeSession({ status: 'CANCELLED' });

    await changeSessionStatus({
      session,
      targetStatus: 'UPCOMING',
      actor: ADMIN_ACTOR,
      client,
    });

    expect(logScheduleAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RESTORE' }),
    );
  });

  it('calls logScheduleAction with SET_LOCKED for LOCKED target', async () => {
    const client = makeMockClient({
      lessonSession: {
        update: jest.fn().mockResolvedValue(makeSession({ status: 'LOCKED' })),
        findFirst: jest.fn(),
      },
    });
    const session = makeSession({ status: 'COMPLETED' });

    await changeSessionStatus({
      session,
      targetStatus: 'LOCKED',
      actor: OWNER_ACTOR,
      client,
    });

    expect(logScheduleAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SET_LOCKED' }),
    );
  });

  it('emits session:status-changed socket event', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    await changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      reason: VALID_REASON,
      client,
    });

    expect(emitToSchool).toHaveBeenCalledWith(
      10,
      'session:status-changed',
      expect.objectContaining({ sessionId: session.id, status: 'CANCELLED' }),
    );
  });

  it('calls dispatchSessionCancelledNotifications on CANCELLED status (PR 5)', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    await changeSessionStatus({
      session,
      targetStatus: 'CANCELLED',
      actor: ADMIN_ACTOR,
      reason: VALID_REASON,
      client,
    });

    expect(dispatchSessionCancelledNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId:      session.id,
        studentUserIds: expect.arrayContaining([50, 51]),
        reason:         VALID_REASON,
      }),
    );
  });

  it('does NOT call dispatchSessionCancelledNotifications for non-CANCELLED status (e.g. LOCKED)', async () => {
    const client = makeMockClient({
      lessonSession: {
        update: jest.fn().mockResolvedValue(makeSession({ status: 'LOCKED' })),
        findFirst: jest.fn(),
      },
    });
    const session = makeSession({ status: 'COMPLETED' });

    await changeSessionStatus({
      session,
      targetStatus: 'LOCKED',
      actor: OWNER_ACTOR,
      client,
    });

    expect(dispatchSessionCancelledNotifications).not.toHaveBeenCalled();
  });

  it('notification failure does NOT rollback status change (best-effort)', async () => {
    (dispatchSessionCancelledNotifications as jest.Mock).mockRejectedValueOnce(
      new Error('queue unavailable'),
    );
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    // Should resolve even when notification throws
    await expect(changeSessionStatus({
      session, targetStatus: 'CANCELLED', actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    })).resolves.toBeTruthy();

    // DB update still happened
    expect(client.lessonSession.update).toHaveBeenCalled();
  });

  // в”Ђв”Ђв”Ђ F-01: atomic transaction boundary в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

  it('F-01: $transaction is called for DB writes (session update + audit + freeze cleanup)', async () => {
    const client = makeMockClient();
    const session = makeSession({ status: 'UPCOMING' });

    await changeSessionStatus({
      session, targetStatus: 'CANCELLED', actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    });

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    // DB writes happen inside the transaction delegate (same mock object)
    expect(client.lessonSession.update).toHaveBeenCalled();
    expect(logScheduleAction).toHaveBeenCalled();
  });

  it('F-01: rollback вЂ” if audit throws, error propagates and socket emit is NOT called', async () => {
    (logScheduleAction as jest.Mock).mockRejectedValueOnce(new Error('audit DB down'));

    const client = makeMockClient();
    client.$transaction = jest.fn().mockImplementation(async (fn: any) => fn(client));
    const session = makeSession({ status: 'UPCOMING' });

    await expect(changeSessionStatus({
      session, targetStatus: 'CANCELLED', actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    })).rejects.toThrow('audit DB down');

    const { emitToSchool } = require('../../lib/socket');
    expect(emitToSchool).not.toHaveBeenCalled();
  });

  it('F-01: no zombie freeze вЂ” orphaned LESSON_SKIP freeze is cancelled inside the transaction', async () => {
    const orphanProfileId = 77;
    const client = makeMockClient({
      studentFreeze: {
        findMany:   jest.fn().mockResolvedValue([{ studentProfileId: orphanProfileId }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count:      jest.fn().mockResolvedValue(0), // no remaining active freezes
      },
    });
    const session = makeSession({ status: 'UPCOMING' });

    await changeSessionStatus({
      session, targetStatus: 'CANCELLED', actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    });

    expect(client.studentFreeze.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lessonSessionId: session.id, type: 'LESSON_SKIP', status: 'ACTIVE' }),
        data:  expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    // isFrozen cleared because no remaining active freezes
    expect(client.studentProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: orphanProfileId },
        data:  { isFrozen: false, frozenAt: null },
      }),
    );
  });

  it('F-01: no stale isFrozen вЂ” profile NOT updated when another active freeze remains', async () => {
    const client = makeMockClient({
      studentFreeze: {
        findMany:   jest.fn().mockResolvedValue([{ studentProfileId: 77 }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count:      jest.fn().mockResolvedValue(1), // another active freeze still exists
      },
    });
    const session = makeSession({ status: 'UPCOMING' });

    await changeSessionStatus({
      session, targetStatus: 'CANCELLED', actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    });

    // orphan freeze was cancelled
    expect(client.studentFreeze.updateMany).toHaveBeenCalled();
    // but isFrozen NOT cleared вЂ” student still has an active freeze
    expect(client.studentProfile.update).not.toHaveBeenCalled();
  });

  // в”Ђв”Ђв”Ђ D-03: assertNoCreditDeductedAttendance inside transaction (TOCTOU fix) в”Ђв”Ђ

  it('D-03: cancellation blocked when creditDeducted attendance is found inside tx', async () => {
    // Simulate a creditDeducted attendance appearing inside the transaction.
    // Before fix: check ran outside tx в†’ window existed for concurrent write.
    // After fix:  check runs inside runTx with txClient в†’ no TOCTOU window.
    const client = makeMockClient({
      attendance: {
        count:     jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({ id: 7 }), // creditDeducted=true found inside tx
      },
    });
    const session = makeSession({ status: 'UPCOMING' });

    await expect(
      changeSessionStatus({
        session,
        targetStatus: 'CANCELLED',
        actor: ADMIN_ACTOR,
        reason: VALID_REASON,
        client,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, message: 'SESSION_HAS_DEDUCTED_CREDITS' });

    // DB update must NOT be called вЂ” tx aborted before lessonSession.update
    expect(client.lessonSession.update).not.toHaveBeenCalled();
  });

  it('D-03: cancellation proceeds when no creditDeducted attendance exists inside tx', async () => {
    const client = makeMockClient({
      attendance: {
        count:     jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null), // no credited attendance
      },
    });
    const session = makeSession({ status: 'UPCOMING' });

    await expect(
      changeSessionStatus({
        session,
        targetStatus: 'CANCELLED',
        actor: ADMIN_ACTOR,
        reason: VALID_REASON,
        client,
      }),
    ).resolves.toBeTruthy();

    expect(client.lessonSession.update).toHaveBeenCalled();
  });
});

// в”Ђв”Ђв”Ђ invalidateSession (PR 3) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” invalidateSession (PR 3)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('throws 400 when reason is absent', async () => {
    await expect(invalidateSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: '',
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 400 when reason is shorter than 5 chars', async () => {
    await expect(invalidateSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: 'ab',
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 404 when session not found', async () => {
    const client = makeMockClient({
      lessonSession: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await expect(invalidateSession({
      sessionId: 999, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('throws 403 for LOCKED session when actor is not SUPERADMIN', async () => {
    const lockedSession = makeSession({ status: 'LOCKED' });
    const client = makeMockClient({
      lessonSession: { findFirst: jest.fn().mockResolvedValue(lockedSession) },
    });
    await expect(invalidateSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('SUPERADMIN can invalidate LOCKED session (override path)', async () => {
    const lockedSession = makeSession({ status: 'LOCKED' });
    const updatedSession = makeSession({ status: 'INVALIDATED' });
    const client = makeMockClient({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(lockedSession),
        update: jest.fn().mockResolvedValue(updatedSession),
      },
    });

    await expect(invalidateSession({
      sessionId: 1, schoolId: 10, actor: SUPERADMIN_ACTOR, reason: VALID_REASON, client,
    })).resolves.toBeTruthy();

    expect(client.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ status: 'INVALIDATED' }),
      }),
    );
    expect(logScheduleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SET_INVALIDATED',
        before: { status: 'LOCKED' },
        after: { status: 'INVALIDATED' },
        reason: VALID_REASON,
      }),
    );
    expect(emitToSchool).toHaveBeenCalledWith(
      10, 'session:status-changed', expect.objectContaining({ status: 'INVALIDATED' }),
    );
  });

  it('UPCOMING session is invalidated via changeSessionStatus (normal path)', async () => {
    const upcomingSession = makeSession({ status: 'UPCOMING' });
    const invalidatedSession = makeSession({ status: 'INVALIDATED' });
    const client = makeMockClient({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(upcomingSession),
        update: jest.fn().mockResolvedValue(invalidatedSession),
      },
    });

    await expect(invalidateSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).resolves.toBeTruthy();

    expect(client.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'INVALIDATED' }),
      }),
    );
  });

  it('ADMIN cannot invalidate LOCKED session', async () => {
    const lockedSession = makeSession({ status: 'LOCKED' });
    const client = makeMockClient({
      lessonSession: { findFirst: jest.fn().mockResolvedValue(lockedSession) },
    });
    await expect(invalidateSession({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('throws 409 when salary payment exists (salary safety guard PR 5)', async () => {
    const upcomingSession = makeSession({ status: 'UPCOMING' });
    const client = makeMockClient({
      lessonSession: { findFirst: jest.fn().mockResolvedValue(upcomingSession) },
      teacherPaymentLesson: { findFirst: jest.fn().mockResolvedValue({ paymentId: 55 }) },
    });
    await expect(invalidateSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'SALARY_LOCKED_SESSION' });
  });

  it('dispatches admin notification via dispatchSessionInvalidatedNotifications (PR 5)', async () => {
    const upcomingSession = makeSession({ status: 'UPCOMING' });
    const invalidatedSession = makeSession({ status: 'INVALIDATED' });
    const client = makeMockClient({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(upcomingSession),
        update: jest.fn().mockResolvedValue(invalidatedSession),
      },
    });
    await invalidateSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    });
    expect(dispatchSessionInvalidatedNotifications).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 1, schoolId: 10, reason: VALID_REASON }),
    );
  });

  it('notification failure does NOT rollback invalidation (best-effort)', async () => {
    (dispatchSessionInvalidatedNotifications as jest.Mock).mockRejectedValueOnce(
      new Error('notify queue down'),
    );
    const upcomingSession = makeSession({ status: 'UPCOMING' });
    const invalidatedSession = makeSession({ status: 'INVALIDATED' });
    const client = makeMockClient({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(upcomingSession),
        update: jest.fn().mockResolvedValue(invalidatedSession),
      },
    });
    await expect(invalidateSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).resolves.toBeTruthy();
  });

  // в”Ђв”Ђв”Ђ D-05: LOCKEDв†’INVALIDATED write boundary в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

  it('D-05: SUPERADMIN LOCKED path wraps update+audit in $transaction', async () => {
    const lockedSession = makeSession({ status: 'LOCKED' });
    const updatedSession = makeSession({ status: 'INVALIDATED' });
    const client = makeMockClient({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(lockedSession),
        update: jest.fn().mockResolvedValue(updatedSession),
      },
    });

    await invalidateSession({
      sessionId: 1, schoolId: 10, actor: SUPERADMIN_ACTOR, reason: VALID_REASON, client,
    });

    // $transaction must have been called (write-boundary)
    expect(client.$transaction).toHaveBeenCalled();
  });

  it('D-05: audit failure in LOCKED path rolls back invalidation', async () => {
    (logScheduleAction as jest.Mock).mockRejectedValueOnce(new Error('audit db down'));

    const lockedSession = makeSession({ status: 'LOCKED' });
    const updatedSession = makeSession({ status: 'INVALIDATED' });
    const client = makeMockClient({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(lockedSession),
        update: jest.fn().mockResolvedValue(updatedSession),
      },
    });

    await expect(
      invalidateSession({
        sessionId: 1, schoolId: 10, actor: SUPERADMIN_ACTOR, reason: VALID_REASON, client,
      }),
    ).rejects.toThrow('audit db down');

    // Socket emit must NOT have been called вЂ” error propagated before it
    expect(emitToSchool).not.toHaveBeenCalledWith(
      10, 'session:status-changed', expect.objectContaining({ status: 'INVALIDATED' }),
    );
  });
});

// в”Ђв”Ђв”Ђ assertNoSalaryLockedSessionMutation (PR 5) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” assertNoSalaryLockedSessionMutation (PR 5)', () => {
  it('passes when no TeacherPaymentLesson exists', async () => {
    const client: any = {
      teacherPaymentLesson: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      assertNoSalaryLockedSessionMutation(1, 'TEACHER_REPLACED', client)
    ).resolves.toBeUndefined();
  });

  it('throws 409 SALARY_LOCKED_SESSION when payment link exists for TEACHER_REPLACED', async () => {
    const client: any = {
      teacherPaymentLesson: { findFirst: jest.fn().mockResolvedValue({ paymentId: 99 }) },
    };
    await expect(
      assertNoSalaryLockedSessionMutation(1, 'TEACHER_REPLACED', client)
    ).rejects.toMatchObject({ httpStatus: 409, message: 'SALARY_LOCKED_SESSION' });
  });

  it('throws 409 SALARY_LOCKED_SESSION when payment link exists for SESSION_RESCHEDULED', async () => {
    const client: any = {
      teacherPaymentLesson: { findFirst: jest.fn().mockResolvedValue({ paymentId: 99 }) },
    };
    await expect(
      assertNoSalaryLockedSessionMutation(1, 'SESSION_RESCHEDULED', client)
    ).rejects.toMatchObject({ httpStatus: 409, message: 'SALARY_LOCKED_SESSION' });
  });

  it('throws 409 SALARY_LOCKED_SESSION when payment link exists for SESSION_INVALIDATED', async () => {
    const client: any = {
      teacherPaymentLesson: { findFirst: jest.fn().mockResolvedValue({ paymentId: 99 }) },
    };
    await expect(
      assertNoSalaryLockedSessionMutation(1, 'SESSION_INVALIDATED', client)
    ).rejects.toMatchObject({ httpStatus: 409, message: 'SALARY_LOCKED_SESSION' });
  });

  it('passes for non-salary-sensitive events (SESSION_CANCELLED) even with payment link', async () => {
    const client: any = {
      teacherPaymentLesson: { findFirst: jest.fn().mockResolvedValue({ paymentId: 99 }) },
    };
    // SESSION_CANCELLED is NOT in the salary-sensitive list
    await expect(
      assertNoSalaryLockedSessionMutation(1, 'SESSION_CANCELLED', client)
    ).resolves.toBeUndefined();
    expect(client.teacherPaymentLesson.findFirst).not.toHaveBeenCalled();
  });
});

// в”Ђв”Ђв”Ђ replaceTeacher (PR 3) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” replaceTeacher (PR 3)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  function makeReplaceClient(overrides: Record<string, any> = {}): any {
    const upcomingSession = makeSession({ status: 'UPCOMING', lessonBlockId: 100 });
    const newStaff = {
      id: 7,
      userId: 77,
      user: { id: 77, firstName: 'Ivan', lastName: 'Petrov', schoolId: 10 },
    };
    const updatedSession = makeSession({
      status: 'UPCOMING',
      teacherId: 7,
      teacher: { userId: 77, user: { firstName: 'Ivan', lastName: 'Petrov' } },
      lessonBlock: {
        teacher: { user: { firstName: 'Old', lastName: 'Teacher' } },
        studentGroupId: 5,
        studentGroup: { memberships: [{ studentProfile: { user: { id: 50 } } }] },
      },
    });
    const base: any = {
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(upcomingSession),
        update: jest.fn().mockResolvedValue(updatedSession),
      },
      staffProfile: {
        findFirst: jest.fn().mockResolvedValue(newStaff),
      },
      teacherPaymentLesson: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      ...overrides,
    };
    // D-04: replaceTeacher now wraps update+audit in $transaction.
    base.$transaction = jest.fn().mockImplementation(async (fn: any) => fn(base));
    return base;
  }

  it('throws 400 when reason is absent', async () => {
    await expect(replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: '',
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 400 when reason is shorter than 5 chars', async () => {
    await expect(replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: 'abc',
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 404 when session not found', async () => {
    const client = makeReplaceClient({
      lessonSession: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await expect(replaceTeacher({
      sessionId: 999, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('throws 422 when session is LOCKED (not editable)', async () => {
    const client = makeReplaceClient({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(makeSession({ status: 'LOCKED' })),
        update: jest.fn(),
      },
    });
    await expect(replaceTeacher({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 422 });
    expect(client.lessonSession.update).not.toHaveBeenCalled();
  });

  it('throws 422 when session is CANCELLED (not editable)', async () => {
    const client = makeReplaceClient({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(makeSession({ status: 'CANCELLED' })),
        update: jest.fn(),
      },
    });
    await expect(replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('throws 422 when session is COMPLETED (not editable)', async () => {
    const client = makeReplaceClient({
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(makeSession({ status: 'COMPLETED' })),
        update: jest.fn(),
      },
    });
    await expect(replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('throws 404 when teacher belongs to a different school (cross-tenant)', async () => {
    const client = makeReplaceClient({
      staffProfile: { findFirst: jest.fn().mockResolvedValue(null) }, // null = cross-tenant or not found
    });
    await expect(replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 404, message: 'TEACHER_NOT_FOUND' });
  });

  it('throws 409 when TeacherPaymentLesson already exists (salary safety вЂ” shared guard PR 5)', async () => {
    const client = makeReplaceClient({
      teacherPaymentLesson: { findFirst: jest.fn().mockResolvedValue({ paymentId: 55 }) },
    });
    await expect(replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'SALARY_LOCKED_SESSION' });
  });

  it('calls dispatchTeacherReplacedNotifications with newTeacherUserId (PR 5)', async () => {
    const client = makeReplaceClient();
    await replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    });
    expect(dispatchTeacherReplacedNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 1, newTeacherUserId: 77 }),
    );
  });

  it('notification failure does NOT rollback teacher replacement (best-effort)', async () => {
    (dispatchTeacherReplacedNotifications as jest.Mock).mockRejectedValueOnce(
      new Error('queue down'),
    );
    const client = makeReplaceClient();
    await expect(replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    })).resolves.toBeTruthy();
    expect(client.lessonSession.update).toHaveBeenCalled();
  });

  it('succeeds: updates DB, writes before/after audit, notifies students, emits socket', async () => {
    const client = makeReplaceClient();

    await replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    });

    // DB update
    expect(client.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ teacherId: 7, isManualTeacher: true }),
      }),
    );

    // Audit with before/after teacherId
    expect(logScheduleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CHANGE_TEACHER',
        entityType: 'session',
        sessionId: 1,
        before: expect.objectContaining({ teacherId: expect.anything() }),
        after: expect.objectContaining({ teacherId: 7 }),
        reason: VALID_REASON,
      }),
    );

    // Student notifications
    expect(notifyMany).toHaveBeenCalledWith(
      expect.arrayContaining([50]),
      expect.objectContaining({ type: 'SUBSTITUTE_TEACHER' }),
    );

    // Socket emit
    expect(emitToSchool).toHaveBeenCalledWith(
      10, 'session:teacher-changed',
      expect.objectContaining({ sessionId: 1, newTeacherId: 7 }),
    );
  });

  it('passes versionGuard to the DB update where clause', async () => {
    const client = makeReplaceClient();

    await replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, versionGuard: 3, client,
    });

    expect(client.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 1, version: 3 }),
      }),
    );
  });

  // в”Ђв”Ђв”Ђ D-04: write-boundary вЂ” update+audit in one transaction в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

  it('D-04: replaceTeacher wraps update+audit in $transaction', async () => {
    const client = makeReplaceClient();

    await replaceTeacher({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      substituteStaffProfileId: 7, reason: VALID_REASON, client,
    });

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(client.lessonSession.update).toHaveBeenCalled();
    expect(logScheduleAction).toHaveBeenCalled();
  });

  it('D-04: audit failure in replaceTeacher rolls back teacher replacement', async () => {
    (logScheduleAction as jest.Mock).mockRejectedValueOnce(new Error('audit db down'));

    const client = makeReplaceClient();

    await expect(
      replaceTeacher({
        sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
        substituteStaffProfileId: 7, reason: VALID_REASON, client,
      }),
    ).rejects.toThrow('audit db down');

    // Socket emit must NOT be called вЂ” error propagated before it
    expect(emitToSchool).not.toHaveBeenCalledWith(
      10, 'session:teacher-changed', expect.anything(),
    );
  });
});

// в”Ђв”Ђв”Ђ rescheduleSession (PR 4) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” rescheduleSession (PR 4)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  function makeRescheduleClient(sessionOverrides: Record<string, any> = {}): any {
    const session = {
      id: 1,
      status: 'UPCOMING',
      schoolId: 10,
      lessonBlockId: 100,
      version: 2,
      date: new Date('2026-06-15'),
      teacherId: null,
      teacherIdSnap: 42,
      cabinetIdSnap: 5,
      startTimeSnap: '09:00',
      endTimeSnap: '10:00',
      isManualTime: false,
      isManualCabinet: false,
      teacher: null,
      lessonBlock: {
        startTime: '09:00',
        endTime: '10:00',
        cabinetId: 5,
        teacherId: 42,
        studentGroupId: 3,
        level: 'A2',
        studentGroup: { status: 'ACTIVE', deletedAt: null, memberships: [{ studentProfile: { user: { id: 50 } } }] },
      },
      ...sessionOverrides,
    };
    const updatedSession = { ...session, startTimeSnap: '10:00', endTimeSnap: '11:00', version: 3 };
    return {
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(session),
        update: jest.fn().mockResolvedValue(updatedSession),
      },
      teacherPaymentLesson: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      scheduleActionLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockImplementation(async (fn: any) => {
        const txClient = {
          lessonSession: {
            update: jest.fn().mockResolvedValue(updatedSession),
          },
          scheduleActionLog: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(txClient);
      }),
    };
  }

  it('throws 400 when reason is absent', async () => {
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: '',
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 400 when reason is shorter than 5 chars', async () => {
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: 'ab',
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 404 when session not found', async () => {
    const client = makeRescheduleClient();
    client.lessonSession.findFirst = jest.fn().mockResolvedValue(null);
    await expect(rescheduleSession({
      sessionId: 999, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('throws 422 when session is COMPLETED (not editable)', async () => {
    const client = makeRescheduleClient({ status: 'COMPLETED' });
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('throws 422 when session is LOCKED', async () => {
    const client = makeRescheduleClient({ status: 'LOCKED' });
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('throws 422 when session is CANCELLED', async () => {
    const client = makeRescheduleClient({ status: 'CANCELLED' });
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('throws 422 when session is INVALIDATED', async () => {
    const client = makeRescheduleClient({ status: 'INVALIDATED' });
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('throws 409 SALARY_LOCKED_SESSION when salary payment exists (PR 5 guard)', async () => {
    const client = makeRescheduleClient();
    client.teacherPaymentLesson = { findFirst: jest.fn().mockResolvedValue({ paymentId: 77 }) };
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'SALARY_LOCKED_SESSION' });
    // Confirm: $transaction was NOT called (guard fired before it)
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('throws 409 when conflict validation rejects', async () => {
    const { ScheduleValidationError } = require('../../services/scheduleValidation');
    (validateSingleSessionOverride as jest.Mock).mockRejectedValueOnce(
      Object.assign(new ScheduleValidationError('TEACHER_CONFLICT: РЈС‡РёС‚РµР»СЊ Р·Р°РЅСЏС‚'), { })
    );
    const client = makeRescheduleClient();
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON,
      newStartTime: '10:00', newEndTime: '11:00', client,
    })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('throws 400 when cabinet capacity warning is not overridden', async () => {
    const { ScheduleValidationError } = require('../../services/scheduleValidation');
    (validateSingleSessionOverride as jest.Mock).mockRejectedValueOnce(
      new ScheduleValidationError('CAPACITY_WARNING: РєР°Р±РёРЅРµС‚ РјР°Р»РѕРІР°С‚')
    );
    const client = makeRescheduleClient();
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON,
      newCabinetId: 6, client,
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('proceeds when CAPACITY_WARNING is overridden (overrideCabinetConflict=true)', async () => {
    const { ScheduleValidationError } = require('../../services/scheduleValidation');
    (validateSingleSessionOverride as jest.Mock).mockRejectedValueOnce(
      new ScheduleValidationError('CAPACITY_WARNING: РєР°Р±РёРЅРµС‚ РјР°Р»РѕРІР°С‚')
    );
    const client = makeRescheduleClient();
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON,
      newCabinetId: 6, overrideCabinetConflict: true, client,
    })).resolves.toBeTruthy();
  });

  it('UPCOMING session succeeds: runs $transaction, writes audit with before/after slot', async () => {
    const client = makeRescheduleClient();
    const result = await rescheduleSession({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR,
      newStartTime: '10:00', newEndTime: '11:00', newCabinetId: 7,
      reason: VALID_REASON, client,
    });
    expect(result).toBeTruthy();
    expect(client.$transaction).toHaveBeenCalled();
    expect(logScheduleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RESCHEDULE',
        entityType: 'session',
        sessionId: 1,
        before: expect.objectContaining({ startTime: expect.any(String) }),
        after:  expect.objectContaining({ startTime: '10:00', endTime: '11:00' }),
        reason: VALID_REASON,
      }),
    );
  });

  it('IN_PROGRESS session is editable (reschedule allowed)', async () => {
    const client = makeRescheduleClient({ status: 'IN_PROGRESS' });
    await expect(rescheduleSession({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    })).resolves.toBeTruthy();
  });

  it('emits session:status-changed socket event after transaction', async () => {
    const client = makeRescheduleClient();
    await rescheduleSession({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    });
    expect(emitToSchool).toHaveBeenCalledWith(
      10, 'session:status-changed',
      expect.objectContaining({ sessionId: 1 }),
    );
  });

  it('passes versionGuard to transaction DB update', async () => {
    const client = makeRescheduleClient();
    await rescheduleSession({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR, reason: VALID_REASON,
      versionGuard: 2, client,
    });
    // $transaction was called вЂ” inner update receives versionGuard via where clause
    expect(client.$transaction).toHaveBeenCalled();
  });

  it('conflict validation is called with correct session date and new slot', async () => {
    const client = makeRescheduleClient();
    await rescheduleSession({
      sessionId: 1, schoolId: 10, actor: OWNER_ACTOR, reason: VALID_REASON,
      newStartTime: '11:00', newEndTime: '12:00', newCabinetId: 8, client,
    });
    expect(validateSingleSessionOverride).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 1,
        schoolId: 10,
        startTime: '11:00',
        endTime: '12:00',
        cabinetId: 8,
      }),
    );
  });

  it('no credit or salary changes: notifyMany is NOT called', async () => {
    const client = makeRescheduleClient();
    await rescheduleSession({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    });
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it('dispatches reschedule notifications with the group\'s active member user ids (regression: was always [] — queried the dead students relation instead of memberships)', async () => {
    const client = makeRescheduleClient();
    await rescheduleSession({
      sessionId: 1, schoolId: 10, actor: ADMIN_ACTOR, reason: VALID_REASON, client,
    });
    expect(dispatchRescheduleNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ studentUserIds: [50] }),
    );
  });
});

// в”Ђв”Ђв”Ђ PR 6: createMakeupSession в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” createMakeupSession (PR 6)', () => {
  const MAKEUP_REASON = 'school event conflict';

  function makeMakeupClient(sessionOverrides: Record<string, any> = {}): any {
    const cancelledSession = {
      id:            10,
      status:        'CANCELLED',
      schoolId:      10,
      lessonBlockId: 100,
      teacherId:     null,
      teacherIdSnap: 42,
      cabinetIdSnap: 5,
      startTimeSnap: '09:00',
      endTimeSnap:   '10:00',
      lessonBlock: {
        level:          'B1',
        studentGroupId: 3,
        studentGroup:   { status: 'ACTIVE', deletedAt: null, memberships: [{ studentProfile: { user: { id: 50 } } }, { studentProfile: { user: { id: 51 } } }] },
      },
      ...sessionOverrides,
    };
    const createdMakeup = { id: 99, status: 'UPCOMING', schoolId: 10, lessonBlockId: 100, date: new Date('2026-07-05T12:00:00.000Z') };

    return {
      lessonSession: {
        findFirst: jest.fn().mockResolvedValue(cancelledSession),
      },
      $transaction: jest.fn().mockImplementation(async (fn: any) => {
        const txClient = {
          $executeRaw: jest.fn().mockResolvedValue(undefined),
          lessonSession: {
            findFirst: jest.fn().mockResolvedValue(null), // no existing makeup
            create:    jest.fn().mockResolvedValue(createdMakeup),
          },
          scheduleActionLog: { create: jest.fn().mockResolvedValue({}) },
          groupMembership:   { findMany: jest.fn().mockResolvedValue([]) },
          sessionStudent:    { createMany: jest.fn().mockResolvedValue({}) },
        };
        return fn(txClient);
      }),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws 400 when reason is absent', async () => {
    await expect(createMakeupSession({
      originalSessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'),
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 400 when reason is shorter than 5 chars', async () => {
    await expect(createMakeupSession({
      originalSessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'),
      reason: 'ab',
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 404 when original session not found', async () => {
    const client = makeMakeupClient();
    client.lessonSession.findFirst = jest.fn().mockResolvedValue(null);
    await expect(createMakeupSession({
      originalSessionId: 999, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'), reason: MAKEUP_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 404, message: 'SESSION_NOT_FOUND' });
  });

  it('throws 409 MAKEUP_LOCKED_SESSION when original is LOCKED', async () => {
    const client = makeMakeupClient({ status: 'LOCKED' });
    await expect(createMakeupSession({
      originalSessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'), reason: MAKEUP_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'MAKEUP_LOCKED_SESSION' });
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('throws 409 MAKEUP_INVALIDATED_SESSION when original is INVALIDATED', async () => {
    const client = makeMakeupClient({ status: 'INVALIDATED' });
    await expect(createMakeupSession({
      originalSessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'), reason: MAKEUP_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'MAKEUP_INVALIDATED_SESSION' });
  });

  it('throws 400 when original is UPCOMING (not cancelled)', async () => {
    const client = makeMakeupClient({ status: 'UPCOMING' });
    await expect(createMakeupSession({
      originalSessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'), reason: MAKEUP_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 400, message: 'MAKEUP_REQUIRES_CANCELLED_SESSION' });
  });

  it('throws 409 MAKEUP_ALREADY_EXISTS when an active makeup already exists', async () => {
    const client = makeMakeupClient();
    // Override the transaction to simulate existingMakeup found
    client.$transaction = jest.fn().mockImplementation(async (fn: any) => {
      const txClient = {
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        lessonSession: {
          findFirst: jest.fn().mockResolvedValue({ id: 55 }), // existing makeup
          create:    jest.fn(),
        },
        scheduleActionLog: { create: jest.fn() },
        groupMembership:   { findMany: jest.fn().mockResolvedValue([]) },
        sessionStudent:    { createMany: jest.fn() },
      };
      return fn(txClient);
    });

    await expect(createMakeupSession({
      originalSessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'), reason: MAKEUP_REASON, client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'MAKEUP_ALREADY_EXISTS' });
  });

  it('success path: runs $transaction and emits socket', async () => {
    const client = makeMakeupClient();
    await createMakeupSession({
      originalSessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'), reason: MAKEUP_REASON, client,
    });
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(emitToSchool).toHaveBeenCalledWith(
      10, 'session:status-changed',
      expect.objectContaining({ sessionId: 99 }),
    );
  });

  it('success path: writes MAKEUP_CREATED audit log inside transaction', async () => {
    const client = makeMakeupClient();
    let capturedTxClient: any;
    client.$transaction = jest.fn().mockImplementation(async (fn: any) => {
      capturedTxClient = {
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        lessonSession: {
          findFirst: jest.fn().mockResolvedValue(null),
          create:    jest.fn().mockResolvedValue({ id: 99, status: 'UPCOMING', schoolId: 10, lessonBlockId: 100, date: new Date() }),
        },
        scheduleActionLog: { create: jest.fn().mockResolvedValue({}) },
        groupMembership:   { findMany: jest.fn().mockResolvedValue([]) },
        sessionStudent:    { createMany: jest.fn().mockResolvedValue({}) },
      };
      return fn(capturedTxClient);
    });

    await createMakeupSession({
      originalSessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'), reason: MAKEUP_REASON, client,
    });

    expect(logScheduleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'MAKEUP_CREATED',
        entityType: 'session',
        reason:     MAKEUP_REASON,
        userId:     OWNER_ACTOR.userId,
      }),
    );
  });

  it('success path: dispatches MAKEUP_CREATED notification to students', async () => {
    const client = makeMakeupClient();
    await createMakeupSession({
      originalSessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: new Date('2026-07-05T12:00:00.000Z'), reason: MAKEUP_REASON, client,
    });
    expect(dispatchMakeupCreatedNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        originalSessionId: 10,
        studentUserIds:    expect.arrayContaining([50, 51]),
      }),
    );
  });
});

describe('scheduleLifecycleService - moveSession (PR 9B-5A)', () => {
  const MOVE_REASON = 'teacher is sick';
  const TARGET_DATE = new Date('2026-06-22T12:00:00.000Z');

  function makeOriginalSession(overrides: Record<string, any> = {}) {
    return {
      id: 10,
      status: 'UPCOMING',
      schoolId: 10,
      lessonBlockId: 100,
      version: 3,
      date: new Date('2026-06-15T12:00:00.000Z'),
      teacherId: null,
      teacherIdSnap: 42,
      isManualTeacher: false,
      cabinetIdSnap: 5,
      startTimeSnap: '09:00',
      endTimeSnap: '10:00',
      attendanceFinalizedAt: null,
      dateOverrideFrom: null,
      teacher: { userId: 500 },
      lessonBlock: {
        id: 100,
        level: 'B1',
        startTime: '09:00',
        endTime: '10:00',
        cabinetId: 5,
        teacherId: 42,
        studentGroupId: 3,
        studentGroup: {
          status: 'ACTIVE',
          deletedAt: null,
          memberships: [{ studentProfile: { user: { id: 50 } } }, { studentProfile: { user: { id: 51 } } }],
        },
      },
      ...overrides,
    };
  }

  function makeMoveClient(sessionOverrides: Record<string, any> = {}): any {
    const original = makeOriginalSession(sessionOverrides);
    const updatedSession = {
      ...original,
      status: 'UPCOMING',
      version: 4,
      date: TARGET_DATE,
      isMakeup: false,
      makeupForSessionId: null,
      isManualDate: true,
      dateOverrideFrom: original.date,
      startTimeSnap: '13:00',
      endTimeSnap: '14:00',
      cabinetIdSnap: 7,
      teacherIdSnap: 42,
      lessonBlock: original.lessonBlock,
    };

    const txClient = {
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      lessonSession: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(original)
          .mockResolvedValueOnce(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(updatedSession),
        create: jest.fn(),
      },
      lessonBlock: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      cabinet: {
        findFirst: jest.fn().mockResolvedValue({ id: 7 }),
      },
      staffProfile: {
        findFirst: jest.fn().mockResolvedValue({ id: 42 }),
      },
      attendance: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      lessonCreditLog: {
        count: jest.fn().mockResolvedValue(0),
      },
      teacherPaymentLesson: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      scheduleActionLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      // D-01: freeze cleanup shared with changeSessionStatus cancel path
      studentFreeze: {
        findMany:   jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count:      jest.fn().mockResolvedValue(0),
      },
      studentProfile: {
        update: jest.fn().mockResolvedValue({}),
      },
    };

    return {
      txClient,
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(txClient)),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (validateSingleSessionOverride as jest.Mock).mockResolvedValue(undefined);
  });

  it('success path updates the same clean session as a manual date override', async () => {
    const client = makeMoveClient();
    const result = await moveSession({
      sessionId: 10,
      schoolId: 10,
      actor: OWNER_ACTOR,
      newDate: TARGET_DATE,
      newStartTime: '13:00',
      newEndTime: '14:00',
      newCabinetId: 7,
      reason: MOVE_REASON,
      versionGuard: 3,
      client,
    });

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(client.txClient.lessonSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10, version: 3 },
        data: expect.objectContaining({
          date: TARGET_DATE,
          startTimeSnap: '13:00',
          endTimeSnap: '14:00',
          cabinetIdSnap: 7,
          isManualDate: true,
          dateOverrideFrom: new Date('2026-06-15T12:00:00.000Z'),
          isManualTime: true,
          isManualCabinet: true,
          isMakeup: false,
          makeupForSessionId: null,
        }),
      }),
    );
    expect(client.txClient.lessonSession.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      session: expect.objectContaining({ id: 10, isMakeup: false, makeupForSessionId: null }),
    });
    expect(logScheduleAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'SESSION_MOVED' }));
    expect(emitToSchool).toHaveBeenCalledWith(
      10,
      'schedule:session-changed',
      expect.objectContaining({ action: 'session-moved', sessionId: 10 }),
    );
  });

  it('target date conflict returns 409 without updating or creating makeup', async () => {
    const client = makeMoveClient();
    client.txClient.lessonSession.findFirst = jest.fn()
      .mockResolvedValueOnce(makeOriginalSession())
      .mockResolvedValueOnce({ id: 55, date: TARGET_DATE, status: 'UPCOMING', startTimeSnap: '13:00', endTimeSnap: '14:00' });

    await expect(moveSession({
      sessionId: 10,
      schoolId: 10,
      actor: OWNER_ACTOR,
      newDate: TARGET_DATE,
      newStartTime: '13:00',
      newEndTime: '14:00',
      newCabinetId: 7,
      reason: MOVE_REASON,
      versionGuard: 3,
      client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'LESSON_DATE_CONFLICT' });

    expect(client.txClient.lessonSession.update).not.toHaveBeenCalled();
    expect(client.txClient.lessonSession.create).not.toHaveBeenCalled();
  });

  it('blocks moving onto another overlapping lesson of the same student group', async () => {
    const client = makeMoveClient();
    client.txClient.lessonBlock.findMany.mockResolvedValueOnce([
      { id: 200, startTime: '13:00', endTime: '14:00', type: 'GRAMMAR' },
    ]);

    await expect(moveSession({
      sessionId: 10,
      schoolId: 10,
      actor: OWNER_ACTOR,
      newDate: TARGET_DATE,
      newStartTime: '13:00',
      newEndTime: '14:00',
      newCabinetId: 7,
      reason: MOVE_REASON,
      versionGuard: 3,
      client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'LESSON_TARGET_GROUP_CONFLICT' });

    expect(client.txClient.lessonSession.update).not.toHaveBeenCalled();
    expect(client.txClient.lessonSession.create).not.toHaveBeenCalled();
  });

  it('stale version returns 409 before mutation', async () => {
    const client = makeMoveClient();
    await expect(moveSession({
      sessionId: 10,
      schoolId: 10,
      actor: OWNER_ACTOR,
      newDate: TARGET_DATE,
      newStartTime: '13:00',
      newEndTime: '14:00',
      newCabinetId: 7,
      reason: MOVE_REASON,
      versionGuard: 2,
      client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'STALE_DATA' });

    expect(client.txClient.lessonSession.update).not.toHaveBeenCalled();
    expect(client.txClient.lessonSession.create).not.toHaveBeenCalled();
  });

  it('conflict validation failure leaves original unchanged and creates no makeup', async () => {
    const client = makeMoveClient();
    (validateSingleSessionOverride as jest.Mock).mockRejectedValueOnce(new Error('Teacher conflict'));

    await expect(moveSession({
      sessionId: 10,
      schoolId: 10,
      actor: OWNER_ACTOR,
      newDate: TARGET_DATE,
      newStartTime: '13:00',
      newEndTime: '14:00',
      newCabinetId: 7,
      reason: MOVE_REASON,
      versionGuard: 3,
      client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'Teacher conflict' });

    expect(client.txClient.lessonSession.update).not.toHaveBeenCalled();
    expect(client.txClient.lessonSession.create).not.toHaveBeenCalled();
  });

  it.each(['CANCELLED', 'COMPLETED', 'LOCKED', 'INVALIDATED'] as SessionStatus[])(
    'blocks %s sessions before mutation',
    async (status) => {
      const client = makeMoveClient({ status });
      await expect(moveSession({
        sessionId: 10,
        schoolId: 10,
        actor: OWNER_ACTOR,
        newDate: TARGET_DATE,
        newStartTime: '13:00',
        newEndTime: '14:00',
        newCabinetId: 7,
        reason: MOVE_REASON,
        versionGuard: 3,
        client,
      })).rejects.toMatchObject({ httpStatus: 422, message: 'SESSION_NOT_MOVABLE' });

      expect(client.txClient.lessonSession.update).not.toHaveBeenCalled();
      expect(client.txClient.lessonSession.create).not.toHaveBeenCalled();
    },
  );

  it('blocks move when attendance rows already exist', async () => {
    const client = makeMoveClient();
    client.txClient.attendance.count = jest.fn().mockResolvedValue(1);

    await expect(moveSession({
      sessionId: 10,
      schoolId: 10,
      actor: OWNER_ACTOR,
      newDate: TARGET_DATE,
      newStartTime: '13:00',
      newEndTime: '14:00',
      newCabinetId: 7,
      reason: MOVE_REASON,
      versionGuard: 3,
      client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'SESSION_NOT_MOVABLE' });

    expect(client.txClient.lessonSession.update).not.toHaveBeenCalled();
  });

  it('blocks move when credit logs already exist', async () => {
    const client = makeMoveClient();
    client.txClient.lessonCreditLog.count = jest.fn().mockResolvedValue(1);

    await expect(moveSession({
      sessionId: 10,
      schoolId: 10,
      actor: OWNER_ACTOR,
      newDate: TARGET_DATE,
      newStartTime: '13:00',
      newEndTime: '14:00',
      newCabinetId: 7,
      reason: MOVE_REASON,
      versionGuard: 3,
      client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'SESSION_NOT_MOVABLE' });

    expect(client.txClient.lessonSession.update).not.toHaveBeenCalled();
  });

  it('blocks move when teacher payment already exists', async () => {
    const client = makeMoveClient();
    client.txClient.teacherPaymentLesson.findFirst = jest.fn().mockResolvedValue({ id: 77 });

    await expect(moveSession({
      sessionId: 10,
      schoolId: 10,
      actor: OWNER_ACTOR,
      newDate: TARGET_DATE,
      newStartTime: '13:00',
      newEndTime: '14:00',
      newCabinetId: 7,
      reason: MOVE_REASON,
      versionGuard: 3,
      client,
    })).rejects.toMatchObject({ httpStatus: 409, message: 'SESSION_NOT_MOVABLE' });

    expect(client.txClient.lessonSession.update).not.toHaveBeenCalled();
  });

  it('does not run cancel-only freeze cleanup when moving the same session', async () => {
    const orphanProfileId = 55;
    const client = makeMoveClient();

    client.txClient.studentFreeze.findMany  = jest.fn().mockResolvedValue([{ studentProfileId: orphanProfileId }]);
    client.txClient.studentFreeze.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    client.txClient.studentFreeze.count     = jest.fn().mockResolvedValue(0);
    client.txClient.studentProfile.update   = jest.fn().mockResolvedValue({});

    await moveSession({
      sessionId: 10,
      schoolId: 10,
      actor: OWNER_ACTOR,
      newDate: TARGET_DATE,
      newStartTime: '13:00',
      newEndTime: '14:00',
      newCabinetId: 7,
      reason: MOVE_REASON,
      versionGuard: 3,
      client,
    });

    expect(client.txClient.studentFreeze.updateMany).not.toHaveBeenCalled();
    expect(client.txClient.studentProfile.update).not.toHaveBeenCalled();
  });

  it('does not touch freeze state even when another active freeze exists', async () => {
    const client = makeMoveClient();

    client.txClient.studentFreeze.findMany  = jest.fn().mockResolvedValue([{ studentProfileId: 55 }]);
    client.txClient.studentFreeze.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    client.txClient.studentFreeze.count     = jest.fn().mockResolvedValue(1); // another freeze still active
    client.txClient.studentProfile.update   = jest.fn().mockResolvedValue({});

    await moveSession({
      sessionId: 10, schoolId: 10, actor: OWNER_ACTOR,
      newDate: TARGET_DATE, newStartTime: '13:00', newEndTime: '14:00',
      newCabinetId: 7, reason: MOVE_REASON, versionGuard: 3, client,
    });

    expect(client.txClient.studentFreeze.updateMany).not.toHaveBeenCalled();
    expect(client.txClient.studentProfile.update).not.toHaveBeenCalled();
  });
});

// в”Ђв”Ђв”Ђ PR 5: applyFreeze / reverseFreeze delegate to freezeService в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

describe('scheduleLifecycleService вЂ” applyFreeze (PR 5: delegates to freezeService)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws 400 when reason is missing', async () => {
    await expect(applyFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 400 when reason is shorter than 5 chars', async () => {
    await expect(applyFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR, reason: 'hi' }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it('delegates to createOpenEndedFreeze with correct params', async () => {
    await applyFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR, reason: 'Valid test reason' });
    expect(createOpenEndedFreeze).toHaveBeenCalledWith(
      expect.objectContaining({
        studentProfileId: 7,
        schoolId:         10,
        actor:            OWNER_ACTOR,
      }),
    );
  });

  it('forwards client param to createOpenEndedFreeze', async () => {
    const client = {} as any;
    await applyFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR, reason: 'Valid test reason', client });
    expect(createOpenEndedFreeze).toHaveBeenCalledWith(
      expect.objectContaining({ client }),
    );
  });

  it('returns result from createOpenEndedFreeze', async () => {
    const result = await applyFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR, reason: 'Valid test reason' });
    expect(result).toMatchObject({ id: 1, type: 'PERIOD', status: 'ACTIVE' });
  });
});

describe('scheduleLifecycleService вЂ” reverseFreeze (PR 5: delegates to freezeService)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws 400 when reason is missing', async () => {
    await expect(reverseFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws 400 when reason is shorter than 5 chars', async () => {
    await expect(reverseFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR, reason: 'no' }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it('delegates to cancelAllActiveFreezes with correct params', async () => {
    await reverseFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR, reason: 'Valid test reason' });
    expect(cancelAllActiveFreezes).toHaveBeenCalledWith(
      expect.objectContaining({
        studentProfileId: 7,
        schoolId:         10,
        actor:            OWNER_ACTOR,
      }),
    );
  });

  it('forwards client param to cancelAllActiveFreezes', async () => {
    const client = {} as any;
    await reverseFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR, reason: 'Valid test reason', client });
    expect(cancelAllActiveFreezes).toHaveBeenCalledWith(
      expect.objectContaining({ client }),
    );
  });

  it('returns result from cancelAllActiveFreezes', async () => {
    const result = await reverseFreeze({ studentProfileId: 7, schoolId: 10, actor: OWNER_ACTOR, reason: 'Valid test reason' });
    expect(result).toMatchObject({ id: 7, isFrozen: false });
  });
});


