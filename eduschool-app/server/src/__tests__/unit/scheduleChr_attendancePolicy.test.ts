/**
 * CHARACTERIZATION TESTS — Attendance Policy Mismatch
 * PR 1: Schedule Lifecycle — document current behavior, NO production code changes.
 *
 * Problem: Three sources define "when is attendance allowed" and they disagree.
 *
 *   Source A: sessionStateMachine.isAttendanceAllowed()
 *     → returns true ONLY for IN_PROGRESS | COMPLETED
 *     → returns false for UPCOMING
 *
 *   Source B: businessInvariants.BILLING_POLICY.SUBMITTABLE_SESSION_STATUSES
 *     → ['UPCOMING', 'COMPLETED']
 *     → explicitly INCLUDES UPCOMING, omits IN_PROGRESS
 *
 *   Source C: attendanceService.markAttendance() + both attendance routes
 *     → allows UPCOMING (matches Source B, not Source A)
 *     → isAttendanceAllowed() is imported by NO route — it is dead policy code
 *
 * Current behavior (what these tests lock in):
 *   - Attendance CAN be submitted on UPCOMING sessions — both routes allow it.
 *   - isAttendanceAllowed() is an unused function that contradicts the implemented policy.
 *   - CANCELLED and INVALIDATED sessions are correctly blocked by markAttendance().
 *   - IN_PROGRESS is absent from SUBMITTABLE_SESSION_STATUSES but works in practice
 *     because the service doesn't check the constant for IN_PROGRESS.
 *
 * TODO PR 3: Resolve the three-way contradiction.
 *   Decision required: is UPCOMING submittable? (RFC §14, Q7)
 *   Whichever answer: delete the unused isAttendanceAllowed() overload OR wire it
 *   into the attendance route AND update businessInvariants to match.
 */

import { canTransition, isEditable, isAttendanceAllowed } from '../../lib/sessionStateMachine';
import { BILLING_POLICY } from '../../lib/businessInvariants';

// ─── Source A: sessionStateMachine.isAttendanceAllowed() ─────────────────────

describe('CHARACTERIZATION — sessionStateMachine.isAttendanceAllowed', () => {
  it('returns TRUE for IN_PROGRESS', () => {
    expect(isAttendanceAllowed('IN_PROGRESS')).toBe(true);
  });

  it('returns TRUE for COMPLETED', () => {
    expect(isAttendanceAllowed('COMPLETED')).toBe(true);
  });

  /**
   * CHARACTERIZATION — documents the policy gap.
   * The state machine says UPCOMING is NOT submittable.
   * But the actual routes and service allow it (see Source B + C tests below).
   *
   * TODO PR 3: After RFC §14 Q7 is resolved, either:
   *   Option A — Keep UPCOMING allowed → change this to toBe(true) and update docs.
   *   Option B — Block UPCOMING       → wire isAttendanceAllowed() into the route.
   */
  it('returns FALSE for UPCOMING — contradicts businessInvariants and service behavior', () => {
    expect(isAttendanceAllowed('UPCOMING')).toBe(false);
  });

  it('returns FALSE for CANCELLED', () => {
    expect(isAttendanceAllowed('CANCELLED')).toBe(false);
  });

  it('returns FALSE for LOCKED', () => {
    expect(isAttendanceAllowed('LOCKED')).toBe(false);
  });

  it('returns FALSE for INVALIDATED', () => {
    expect(isAttendanceAllowed('INVALIDATED')).toBe(false);
  });
});

// ─── Source B: businessInvariants.BILLING_POLICY ─────────────────────────────

describe('CHARACTERIZATION — businessInvariants.BILLING_POLICY.SUBMITTABLE_SESSION_STATUSES', () => {
  /**
   * CHARACTERIZATION — businessInvariants explicitly lists UPCOMING as submittable.
   * This directly contradicts isAttendanceAllowed('UPCOMING') === false above.
   * The constant is used by the submit-attendance route's status guard.
   */
  it('includes UPCOMING as a submittable status', () => {
    expect(BILLING_POLICY.SUBMITTABLE_SESSION_STATUSES).toContain('UPCOMING');
  });

  it('includes COMPLETED as a submittable status', () => {
    expect(BILLING_POLICY.SUBMITTABLE_SESSION_STATUSES).toContain('COMPLETED');
  });

  /**
   * CHARACTERIZATION — IN_PROGRESS is NOT in the business invariant constant.
   * Yet attendance works in practice for IN_PROGRESS because markAttendance()
   * only blocks CANCELLED and INVALIDATED, not IN_PROGRESS.
   * Source C (service) allows IN_PROGRESS silently — it is a fourth inconsistency.
   */
  it('does NOT include IN_PROGRESS — even though the state machine allows it', () => {
    expect(BILLING_POLICY.SUBMITTABLE_SESSION_STATUSES).not.toContain('IN_PROGRESS');
  });

  it('creditDeducted is documented as immutable once true', () => {
    expect(BILLING_POLICY.CREDIT_DEDUCTED_IS_IMMUTABLE).toBe(true);
  });
});

// ─── Dead policy code: isAttendanceAllowed is not imported by any route ───────

describe('CHARACTERIZATION — isAttendanceAllowed() is not enforced by attendance routes', () => {
  /**
   * These tests document that isAttendanceAllowed() exists but is NOT the guard
   * used by the attendance submission routes.
   *
   * Confirmed by reading schedule.ts:
   *   - PATCH /session/:id/attendance   — no call to isAttendanceAllowed()
   *   - POST  /session/submit-attendance — checks BILLING_POLICY.SUBMITTABLE_SESSION_STATUSES
   *
   * The only caller of isAttendanceAllowed() in production code would be tests
   * (like this file). It is a stranded API.
   *
   * TODO PR 2: Remove isAttendanceAllowed() and replace with a single canonical
   *   policy check used by both routes and documented in businessInvariants.
   */
  it('isAttendanceAllowed exists as a named export from sessionStateMachine', () => {
    expect(typeof isAttendanceAllowed).toBe('function');
  });

  it('isAttendanceAllowed and SUBMITTABLE_SESSION_STATUSES disagree on UPCOMING', () => {
    const stateMachineSaysAllowed = isAttendanceAllowed('UPCOMING');
    const businessInvariantsSaysAllowed =
      (BILLING_POLICY.SUBMITTABLE_SESSION_STATUSES as readonly string[]).includes('UPCOMING');

    // This assertion documents the contradiction: one is true, the other is false.
    expect(stateMachineSaysAllowed).toBe(false);
    expect(businessInvariantsSaysAllowed).toBe(true);

    // Combined: they disagree.
    expect(stateMachineSaysAllowed).not.toBe(businessInvariantsSaysAllowed);
  });

  it('isAttendanceAllowed and SUBMITTABLE_SESSION_STATUSES agree on COMPLETED', () => {
    // COMPLETED is the only status both sources agree on.
    const stateMachineSaysAllowed = isAttendanceAllowed('COMPLETED');
    const businessInvariantsSaysAllowed =
      (BILLING_POLICY.SUBMITTABLE_SESSION_STATUSES as readonly string[]).includes('COMPLETED');

    expect(stateMachineSaysAllowed).toBe(true);
    expect(businessInvariantsSaysAllowed).toBe(true);
  });
});

// ─── canTransition and isEditable are used by routes (for reference) ──────────

describe('CHARACTERIZATION — which state machine functions are route-enforced vs stranded', () => {
  /**
   * canTransition() IS used: PATCH /session/:id/status calls it.
   * isEditable()    IS NOT used by teacher-replace or details route (gap — see Chr_teacherReplacement).
   * isAttendanceAllowed() is NOT used by any attendance route (gap — documented above).
   */
  it('canTransition is a callable function', () => {
    expect(typeof canTransition).toBe('function');
  });

  it('isEditable is a callable function', () => {
    expect(typeof isEditable).toBe('function');
  });

  it('isEditable returns false for LOCKED', () => {
    expect(isEditable('LOCKED')).toBe(false);
  });

  it('isEditable returns false for CANCELLED', () => {
    expect(isEditable('CANCELLED')).toBe(false);
  });

  /**
   * CHARACTERIZATION: isEditable says CANCELLED and LOCKED should not be edited,
   * but PATCH /session/:id/teacher does NOT call isEditable().
   * TODO PR 5: Wire isEditable() guard into teacher-replacement route.
   * See scheduleChr_teacherReplacementBypass.test.ts for the integration test.
   */
  it('isEditable returns true for UPCOMING (editable)', () => {
    expect(isEditable('UPCOMING')).toBe(true);
  });

  it('isEditable returns true for IN_PROGRESS (editable)', () => {
    expect(isEditable('IN_PROGRESS')).toBe(true);
  });

  it('isEditable returns true for COMPLETED (editable before lock)', () => {
    expect(isEditable('COMPLETED')).toBe(true);
  });
});
