import { Role, SessionStatus } from '@prisma/client';

interface TransitionRule {
  from: SessionStatus;
  to: SessionStatus;
  allowedRoles: Role[];
}

const TRANSITIONS: TransitionRule[] = [
  { from: 'UPCOMING',    to: 'IN_PROGRESS', allowedRoles: ['OWNER', 'ADMIN', 'TEACHER'] },
  { from: 'UPCOMING',    to: 'CANCELLED',   allowedRoles: ['OWNER', 'ADMIN'] },
  { from: 'UPCOMING',    to: 'INVALIDATED', allowedRoles: ['OWNER', 'ADMIN'] },
  { from: 'IN_PROGRESS', to: 'COMPLETED',   allowedRoles: ['OWNER', 'ADMIN', 'TEACHER'] },
  { from: 'IN_PROGRESS', to: 'CANCELLED',   allowedRoles: ['OWNER', 'ADMIN'] },
  { from: 'IN_PROGRESS', to: 'INVALIDATED', allowedRoles: ['OWNER', 'ADMIN'] },
  { from: 'COMPLETED',    to: 'LOCKED',      allowedRoles: ['OWNER'] },
  { from: 'CANCELLED',    to: 'UPCOMING',    allowedRoles: ['OWNER', 'ADMIN'] },
  { from: 'INVALIDATED',  to: 'UPCOMING',    allowedRoles: ['OWNER'] },
];

export interface TransitionResult {
  allowed: boolean;
  reason?: string;
}

export function canTransition(
  from: SessionStatus,
  to: SessionStatus,
  role: Role
): TransitionResult {
  if (from === to) return { allowed: true };

  if (from === 'LOCKED') {
    return { allowed: false, reason: 'Сессия заблокирована и не может быть изменена' };
  }

  const rule = TRANSITIONS.find(t => t.from === from && t.to === to);
  if (!rule) {
    return { allowed: false, reason: `Переход из статуса ${from} в ${to} не разрешён` };
  }
  if (!rule.allowedRoles.includes(role)) {
    return { allowed: false, reason: `Недостаточно прав для перевода сессии в статус ${to}` };
  }
  return { allowed: true };
}

export function isEditable(status: SessionStatus): boolean {
  return status !== 'LOCKED' && status !== 'CANCELLED';
}

export function isAttendanceAllowed(
  status: SessionStatus,
  opts?: { hasStarted?: boolean },
): boolean {
  if (status === 'IN_PROGRESS' || status === 'COMPLETED') return true;
  // A started UPCOMING lesson is markable directly, without first switching it to
  // «Идёт сейчас». Covers both "today after start time" and "stuck in the past".
  // Credit deduction still happens only on Submit Attendance (which transitions
  // the session to COMPLETED).
  if (status === 'UPCOMING' && opts?.hasStarted) return true;
  return false;
}
