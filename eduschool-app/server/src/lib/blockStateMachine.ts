/**
 * BLOCK STATE MACHINE
 *
 * Formal lifecycle rules for LessonBlock.status.
 *
 * States:
 *   UPCOMING   — block is active and generates sessions (default)
 *   COMPLETED  — block finished; no new sessions generated; history preserved
 *   CANCELLED  — block aborted; no new sessions generated; history preserved
 *
 * Allowed transitions:
 *   UPCOMING   → COMPLETED  (group completes, or manual close)
 *   UPCOMING   → CANCELLED  (block removed without history)
 *   COMPLETED  → CANCELLED  (archive a completed block, OWNER only)
 *   COMPLETED  → UPCOMING   (restore, OWNER only — rare correction)
 *   CANCELLED  → UPCOMING   (restore, OWNER only — rare correction)
 *
 * Generation rule (enforced by syncSessionsForBlock and extendAllBlockSessions):
 *   Only UPCOMING blocks may generate sessions.
 *
 * Role rules:
 *   OWNER/ADMIN may transition UPCOMING → COMPLETED | CANCELLED
 *   OWNER only may restore COMPLETED/CANCELLED → UPCOMING
 */

import { Role } from '@prisma/client';

export type BlockStatus = 'UPCOMING' | 'COMPLETED' | 'CANCELLED';

export interface BlockTransitionResult {
  allowed: boolean;
  reason?: string;
}

interface BlockTransitionRule {
  from: BlockStatus;
  to: BlockStatus;
  allowedRoles: Role[];
}

const BLOCK_TRANSITIONS: BlockTransitionRule[] = [
  { from: 'UPCOMING',   to: 'COMPLETED', allowedRoles: ['OWNER', 'ADMIN'] },
  { from: 'UPCOMING',   to: 'CANCELLED', allowedRoles: ['OWNER', 'ADMIN'] },
  { from: 'COMPLETED',  to: 'CANCELLED', allowedRoles: ['OWNER'] },
  { from: 'COMPLETED',  to: 'UPCOMING',  allowedRoles: ['OWNER'] },
  { from: 'CANCELLED',  to: 'UPCOMING',  allowedRoles: ['OWNER'] },
];

export function canBlockTransition(
  from: BlockStatus,
  to: BlockStatus,
  role: Role,
): BlockTransitionResult {
  if (from === to) return { allowed: true };

  const rule = BLOCK_TRANSITIONS.find(t => t.from === from && t.to === to);
  if (!rule) {
    return {
      allowed: false,
      reason: `Cannot transition block from ${from} to ${to}`,
    };
  }
  if (!rule.allowedRoles.includes(role)) {
    return {
      allowed: false,
      reason: `Role ${role} cannot transition block from ${from} to ${to}`,
    };
  }
  return { allowed: true };
}

/**
 * Returns true only if this block status may generate new sessions.
 * The single authoritative answer to "should this block produce sessions?"
 */
export function blockAllowsSessionGeneration(status: BlockStatus): boolean {
  return status === 'UPCOMING';
}

/**
 * Returns a human-readable blocker message if status forbids generation,
 * or null if generation is allowed. Consumed by getBlockSessionCreationBlocker.
 */
export function blockGenerationBlocker(status: BlockStatus): string | null {
  if (status === 'COMPLETED') return 'Cannot create sessions for completed block';
  if (status === 'CANCELLED') return 'Cannot create sessions for cancelled block';
  return null;
}
