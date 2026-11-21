/**
 * UNIT TESTS — groupLifecyclePolicy
 *
 * Tests the policy matrix as a pure function (no DB, no HTTP).
 * Covers every (status × action) combination that has a non-trivial rule.
 */

import {
  canPerformGroupAction,
  assertGroupAction,
  GroupShape,
  GroupAction,
} from '../../lib/groupLifecyclePolicy';
import { GroupLifecycleError } from '../../services/groupLifecycleService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function group(status: GroupShape['status'], deletedAt: Date | null = null): GroupShape {
  return { status, deletedAt };
}

const ACTIVE    = group('ACTIVE');
const PAUSED    = group('PAUSED');
const COMPLETED = group('COMPLETED');
const ARCHIVED  = group('COMPLETED', new Date()); // deletedAt set = archived

// ─── ACTIVE group — all mutations allowed ──────────────────────────────────────

describe('ACTIVE group', () => {
  const mutationActions: GroupAction[] = [
    'edit:metadata',
    'edit:maxStudents',
    'edit:level-chapter',
    'edit:schedule',
    'add:students',
    'remove:students',
    'submit:attendance',
    'create:makeup',
    'change:teacher',
    'reschedule',
    'lifecycle:pause',
    'lifecycle:complete',
    'promote',
  ];

  test.each(mutationActions)('allows %s', (action) => {
    expect(canPerformGroupAction(ACTIVE, action).allowed).toBe(true);
  });

  it('denies lifecycle:resume (not paused)', () => {
    expect(canPerformGroupAction(ACTIVE, 'lifecycle:resume').allowed).toBe(false);
  });

  it('denies lifecycle:archive (not completed)', () => {
    expect(canPerformGroupAction(ACTIVE, 'lifecycle:archive').allowed).toBe(false);
  });

  it('denies lifecycle:restore (not archived)', () => {
    expect(canPerformGroupAction(ACTIVE, 'lifecycle:restore').allowed).toBe(false);
  });
});

// ─── PAUSED group — schedule/student/session mutations blocked ─────────────────

describe('PAUSED group', () => {
  const allowedActions: GroupAction[] = [
    'edit:metadata',
    'lifecycle:resume',
  ];

  const blockedActions: GroupAction[] = [
    'edit:maxStudents',
    'edit:level-chapter',
    'edit:schedule',
    'add:students',
    'remove:students',
    'submit:attendance',
    'create:makeup',
    'change:teacher',
    'reschedule',
    'lifecycle:pause',
    'lifecycle:complete',
    'lifecycle:archive',
    'lifecycle:restore',
    'promote',
  ];

  test.each(allowedActions)('allows %s', (action) => {
    expect(canPerformGroupAction(PAUSED, action).allowed).toBe(true);
  });

  test.each(blockedActions)('blocks %s', (action) => {
    const result = canPerformGroupAction(PAUSED, action);
    expect(result.allowed).toBe(false);
    expect(result.code).toBeTruthy();
    expect(result.message).toBeTruthy();
  });

  it('blocked actions return PAUSED code', () => {
    const result = canPerformGroupAction(PAUSED, 'add:students');
    expect(result.code).toBe('GROUP_PAUSED');
  });
});

// ─── COMPLETED group — only safe metadata allowed ─────────────────────────────

describe('COMPLETED group', () => {
  const allowedActions: GroupAction[] = [
    'edit:metadata',    // name rename is safe
    'lifecycle:archive',
  ];

  const blockedActions: GroupAction[] = [
    'edit:maxStudents', // explicitly blocked per product spec
    'edit:level-chapter',
    'edit:schedule',
    'add:students',
    'remove:students',
    'submit:attendance',
    'create:makeup',
    'change:teacher',
    'reschedule',
    'lifecycle:pause',
    'lifecycle:resume',
    'lifecycle:complete',
    'lifecycle:restore',
    'promote',
  ];

  test.each(allowedActions)('allows %s', (action) => {
    expect(canPerformGroupAction(COMPLETED, action).allowed).toBe(true);
  });

  test.each(blockedActions)('blocks %s', (action) => {
    expect(canPerformGroupAction(COMPLETED, action).allowed).toBe(false);
  });

  it('edit:maxStudents is explicitly blocked (not safe metadata)', () => {
    const result = canPerformGroupAction(COMPLETED, 'edit:maxStudents');
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('GROUP_COMPLETED');
  });
});

// ─── ARCHIVED group — read-only ───────────────────────────────────────────────

describe('ARCHIVED group (deletedAt set)', () => {
  const blockedActions: GroupAction[] = [
    'edit:metadata',
    'edit:maxStudents',
    'edit:level-chapter',
    'edit:schedule',
    'add:students',
    'remove:students',
    'submit:attendance',
    'create:makeup',
    'change:teacher',
    'reschedule',
    'lifecycle:pause',
    'lifecycle:resume',
    'lifecycle:complete',
    'lifecycle:archive',
    'promote',
  ];

  test.each(blockedActions)('blocks %s', (action) => {
    const result = canPerformGroupAction(ARCHIVED, action);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('GROUP_ARCHIVED');
  });

  it('allows lifecycle:restore', () => {
    expect(canPerformGroupAction(ARCHIVED, 'lifecycle:restore').allowed).toBe(true);
  });
});

// ─── assertGroupAction — throwing helper ──────────────────────────────────────

describe('assertGroupAction', () => {
  it('does not throw when action is allowed', () => {
    expect(() => assertGroupAction(ACTIVE, 'add:students')).not.toThrow();
  });

  it('throws GroupLifecycleError when action is denied', () => {
    expect(() => assertGroupAction(PAUSED, 'add:students'))
      .toThrow(GroupLifecycleError);
  });

  it('throws with correct code for PAUSED', () => {
    try {
      assertGroupAction(PAUSED, 'edit:schedule');
      fail('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(GroupLifecycleError);
      expect(e.code).toBe('GROUP_PAUSED');
      expect(e.statusCode).toBe(422);
    }
  });

  it('throws with correct code for COMPLETED maxStudents', () => {
    try {
      assertGroupAction(COMPLETED, 'edit:maxStudents');
      fail('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(GroupLifecycleError);
      expect(e.code).toBe('GROUP_COMPLETED');
    }
  });

  it('throws with correct code for ARCHIVED', () => {
    try {
      assertGroupAction(ARCHIVED, 'edit:metadata');
      fail('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(GroupLifecycleError);
      expect(e.code).toBe('GROUP_ARCHIVED');
    }
  });
});

// ─── Exhaustiveness — every action has a result for every non-archived status ──

describe('policy exhaustiveness', () => {
  const statuses: GroupShape['status'][] = ['ACTIVE', 'PAUSED', 'COMPLETED'];
  const actions: GroupAction[] = [
    'edit:metadata', 'edit:maxStudents', 'edit:level-chapter', 'edit:schedule',
    'add:students', 'remove:students', 'submit:attendance', 'create:makeup',
    'change:teacher', 'reschedule',
    'lifecycle:pause', 'lifecycle:resume', 'lifecycle:complete',
    'lifecycle:archive', 'lifecycle:restore', 'promote',
  ];

  test.each(statuses)('status %s: all actions return a result', (status) => {
    for (const action of actions) {
      const result = canPerformGroupAction(group(status), action);
      expect(typeof result.allowed).toBe('boolean');
      if (!result.allowed) {
        expect(result.code).toBeTruthy();
        expect(result.message).toBeTruthy();
      }
    }
  });
});
