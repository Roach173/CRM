import { canTransition, isEditable, isAttendanceAllowed } from '../../lib/sessionStateMachine';

describe('sessionStateMachine — canTransition', () => {
  // ─── Same-state is always a no-op ─────────────────────────────────────────
  it('allows same-to-same transition for any role', () => {
    expect(canTransition('UPCOMING',    'UPCOMING',    'ADMIN').allowed).toBe(true);
    expect(canTransition('COMPLETED',   'COMPLETED',   'TEACHER').allowed).toBe(true);
    expect(canTransition('CANCELLED',   'CANCELLED',   'OWNER').allowed).toBe(true);
  });

  // ─── LOCKED is terminal ───────────────────────────────────────────────────
  it('blocks any transition out of LOCKED', () => {
    const result = canTransition('LOCKED', 'UPCOMING', 'OWNER');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/заблок/i);
  });

  it('blocks LOCKED → CANCELLED for OWNER', () => {
    expect(canTransition('LOCKED', 'CANCELLED', 'OWNER').allowed).toBe(false);
  });

  // ─── UPCOMING → IN_PROGRESS ───────────────────────────────────────────────
  it('OWNER can start a session', () => {
    expect(canTransition('UPCOMING', 'IN_PROGRESS', 'OWNER').allowed).toBe(true);
  });
  it('ADMIN can start a session', () => {
    expect(canTransition('UPCOMING', 'IN_PROGRESS', 'ADMIN').allowed).toBe(true);
  });
  it('TEACHER can start a session', () => {
    expect(canTransition('UPCOMING', 'IN_PROGRESS', 'TEACHER').allowed).toBe(true);
  });
  it('STUDENT cannot start a session', () => {
    expect(canTransition('UPCOMING', 'IN_PROGRESS', 'STUDENT').allowed).toBe(false);
  });

  // ─── UPCOMING → CANCELLED ─────────────────────────────────────────────────
  it('OWNER can cancel upcoming session', () => {
    expect(canTransition('UPCOMING', 'CANCELLED', 'OWNER').allowed).toBe(true);
  });
  it('ADMIN can cancel upcoming session', () => {
    expect(canTransition('UPCOMING', 'CANCELLED', 'ADMIN').allowed).toBe(true);
  });
  it('TEACHER cannot cancel upcoming session', () => {
    expect(canTransition('UPCOMING', 'CANCELLED', 'TEACHER').allowed).toBe(false);
  });

  // ─── IN_PROGRESS → COMPLETED ──────────────────────────────────────────────
  it('TEACHER can complete in-progress session', () => {
    expect(canTransition('IN_PROGRESS', 'COMPLETED', 'TEACHER').allowed).toBe(true);
  });
  it('STUDENT cannot complete a session', () => {
    expect(canTransition('IN_PROGRESS', 'COMPLETED', 'STUDENT').allowed).toBe(false);
  });

  // ─── IN_PROGRESS → CANCELLED ──────────────────────────────────────────────
  it('OWNER can cancel in-progress session', () => {
    expect(canTransition('IN_PROGRESS', 'CANCELLED', 'OWNER').allowed).toBe(true);
  });
  it('TEACHER cannot cancel in-progress session', () => {
    expect(canTransition('IN_PROGRESS', 'CANCELLED', 'TEACHER').allowed).toBe(false);
  });

  // ─── COMPLETED → LOCKED ───────────────────────────────────────────────────
  it('OWNER can lock a completed session', () => {
    expect(canTransition('COMPLETED', 'LOCKED', 'OWNER').allowed).toBe(true);
  });
  it('ADMIN cannot lock a completed session', () => {
    expect(canTransition('COMPLETED', 'LOCKED', 'ADMIN').allowed).toBe(false);
  });
  it('TEACHER cannot lock a completed session', () => {
    expect(canTransition('COMPLETED', 'LOCKED', 'TEACHER').allowed).toBe(false);
  });

  // ─── CANCELLED → UPCOMING (reactivation) ─────────────────────────────────
  it('OWNER can reactivate a cancelled session', () => {
    expect(canTransition('CANCELLED', 'UPCOMING', 'OWNER').allowed).toBe(true);
  });
  it('ADMIN can reactivate a cancelled session', () => {
    expect(canTransition('CANCELLED', 'UPCOMING', 'ADMIN').allowed).toBe(true);
  });
  it('TEACHER cannot reactivate a cancelled session', () => {
    expect(canTransition('CANCELLED', 'UPCOMING', 'TEACHER').allowed).toBe(false);
  });

  // ─── Undefined transitions ────────────────────────────────────────────────
  it('returns false with reason for undefined transition (UPCOMING → LOCKED)', () => {
    const result = canTransition('UPCOMING', 'LOCKED', 'OWNER');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('returns false for COMPLETED → UPCOMING (not in the graph)', () => {
    expect(canTransition('COMPLETED', 'UPCOMING', 'OWNER').allowed).toBe(false);
  });
});

describe('sessionStateMachine — isEditable', () => {
  it('UPCOMING is editable', ()    => expect(isEditable('UPCOMING')).toBe(true));
  it('IN_PROGRESS is editable', () => expect(isEditable('IN_PROGRESS')).toBe(true));
  it('COMPLETED is editable', ()   => expect(isEditable('COMPLETED')).toBe(true));
  it('CANCELLED is NOT editable',  () => expect(isEditable('CANCELLED')).toBe(false));
  it('LOCKED is NOT editable',     () => expect(isEditable('LOCKED')).toBe(false));
});

describe('sessionStateMachine — isAttendanceAllowed', () => {
  it('allows attendance on IN_PROGRESS',  () => expect(isAttendanceAllowed('IN_PROGRESS')).toBe(true));
  it('allows attendance on COMPLETED',    () => expect(isAttendanceAllowed('COMPLETED')).toBe(true));
  it('blocks attendance on UPCOMING',     () => expect(isAttendanceAllowed('UPCOMING')).toBe(false));
  it('blocks attendance on CANCELLED',    () => expect(isAttendanceAllowed('CANCELLED')).toBe(false));
  it('blocks attendance on LOCKED',       () => expect(isAttendanceAllowed('LOCKED')).toBe(false));
});
