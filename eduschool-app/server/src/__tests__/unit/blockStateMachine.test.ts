/**
 * Unit tests: Block State Machine
 *
 * Verifies:
 * - Allowed transitions per role
 * - Blocked transitions
 * - blockAllowsSessionGeneration flag
 * - blockGenerationBlocker messages
 */
import { canBlockTransition, blockAllowsSessionGeneration, blockGenerationBlocker } from '../../lib/blockStateMachine';

describe('canBlockTransition', () => {
  it('allows UPCOMING → COMPLETED for OWNER', () => {
    expect(canBlockTransition('UPCOMING', 'COMPLETED', 'OWNER').allowed).toBe(true);
  });

  it('allows UPCOMING → COMPLETED for ADMIN', () => {
    expect(canBlockTransition('UPCOMING', 'COMPLETED', 'ADMIN').allowed).toBe(true);
  });

  it('allows UPCOMING → CANCELLED for OWNER', () => {
    expect(canBlockTransition('UPCOMING', 'CANCELLED', 'OWNER').allowed).toBe(true);
  });

  it('allows UPCOMING → CANCELLED for ADMIN', () => {
    expect(canBlockTransition('UPCOMING', 'CANCELLED', 'ADMIN').allowed).toBe(true);
  });

  it('blocks UPCOMING → COMPLETED for TEACHER', () => {
    const r = canBlockTransition('UPCOMING', 'COMPLETED', 'TEACHER');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('allows COMPLETED → UPCOMING for OWNER (restore)', () => {
    expect(canBlockTransition('COMPLETED', 'UPCOMING', 'OWNER').allowed).toBe(true);
  });

  it('blocks COMPLETED → UPCOMING for ADMIN (restore requires OWNER)', () => {
    const r = canBlockTransition('COMPLETED', 'UPCOMING', 'ADMIN');
    expect(r.allowed).toBe(false);
  });

  it('allows CANCELLED → UPCOMING for OWNER (restore)', () => {
    expect(canBlockTransition('CANCELLED', 'UPCOMING', 'OWNER').allowed).toBe(true);
  });

  it('allows COMPLETED → CANCELLED for OWNER (archive completed block)', () => {
    expect(canBlockTransition('COMPLETED', 'CANCELLED', 'OWNER').allowed).toBe(true);
  });

  it('blocks COMPLETED → CANCELLED for ADMIN (OWNER only)', () => {
    const r = canBlockTransition('COMPLETED', 'CANCELLED', 'ADMIN');
    expect(r.allowed).toBe(false);
  });

  it('same-status transition always allowed', () => {
    expect(canBlockTransition('UPCOMING', 'UPCOMING', 'ADMIN').allowed).toBe(true);
    expect(canBlockTransition('COMPLETED', 'COMPLETED', 'OWNER').allowed).toBe(true);
  });
});

describe('blockAllowsSessionGeneration', () => {
  it('UPCOMING allows generation', () => {
    expect(blockAllowsSessionGeneration('UPCOMING')).toBe(true);
  });

  it('COMPLETED does not allow generation', () => {
    expect(blockAllowsSessionGeneration('COMPLETED')).toBe(false);
  });

  it('CANCELLED does not allow generation', () => {
    expect(blockAllowsSessionGeneration('CANCELLED')).toBe(false);
  });
});

describe('blockGenerationBlocker', () => {
  it('returns null for UPCOMING', () => {
    expect(blockGenerationBlocker('UPCOMING')).toBeNull();
  });

  it('returns a string for COMPLETED', () => {
    expect(blockGenerationBlocker('COMPLETED')).toBeTruthy();
    expect(typeof blockGenerationBlocker('COMPLETED')).toBe('string');
  });

  it('returns a string for CANCELLED', () => {
    expect(blockGenerationBlocker('CANCELLED')).toBeTruthy();
  });
});
