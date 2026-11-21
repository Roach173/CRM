/**
 * ROSTER SERVICE — SessionStudent amendment policy
 *
 * Architectural decision:
 *   SessionStudent is a session roster SNAPSHOT. For UPCOMING sessions it is a
 *   LIVE roster — membership changes must reconcile it. For historical sessions
 *   (COMPLETED / CANCELLED / LOCKED / INVALIDATED) the roster is immutable.
 *
 * Owner rules:
 *   ADD student  → insert SessionStudent for every UPCOMING session of the
 *                  group's active blocks (safe to re-run; skipDuplicates).
 *   REMOVE student → delete SessionStudent from UPCOMING sessions ONLY IF no
 *                    Attendance record exists for that (session, student) pair.
 *                    If attendance exists the row is kept; the admin must handle
 *                    the credit/attendance correction first.
 *
 * These functions must be called by groups.ts after GroupMembership changes.
 * Never call prisma.sessionStudent directly in route handlers for roster changes.
 */

import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

type DbClient = typeof prisma | Prisma.TransactionClient;

// ─── reconcileRosterOnMemberAdd ───────────────────────────────────────────────
// Called after student is added to a group (GroupMembership created/reactivated).
// Adds SessionStudent rows for all UPCOMING future sessions of the group's blocks.
// Idempotent via skipDuplicates.
export async function reconcileRosterOnMemberAdd(
  groupId: number,
  schoolId: number,
  studentProfileIds: number[],
  client: DbClient = prisma,
): Promise<{ added: number }> {
  if (studentProfileIds.length === 0) return { added: 0 };

  const activeBlocks = await (client as typeof prisma).lessonBlock.findMany({
    where: { studentGroupId: groupId, deletedAt: null },
    select: { id: true },
  });
  if (activeBlocks.length === 0) return { added: 0 };

  const blockIds = activeBlocks.map(b => b.id);
  const now = new Date();

  const upcomingSessions = await (client as typeof prisma).lessonSession.findMany({
    where: {
      lessonBlockId: { in: blockIds },
      status: 'UPCOMING',
      date: { gte: now },
      deletedAt: null,
    },
    select: { id: true },
  });
  if (upcomingSessions.length === 0) return { added: 0 };

  const data = upcomingSessions.flatMap(s =>
    studentProfileIds.map(pid => ({
      schoolId,
      lessonSessionId: s.id,
      studentProfileId: pid,
    }))
  );

  const result = await (client as typeof prisma).sessionStudent.createMany({
    data,
    skipDuplicates: true,
  });

  return { added: result.count };
}

// ─── reconcileRosterOnMemberRemove ────────────────────────────────────────────
// Called after student is removed from a group (GroupMembership withdrawn).
// Removes SessionStudent only from UPCOMING future sessions that have NO
// Attendance record. Sessions with attendance are left intact — the admin must
// correct credits before the student can be fully removed from the roster.
//
// Historical sessions (COMPLETED/CANCELLED/etc.) are never touched.
export async function reconcileRosterOnMemberRemove(
  groupId: number,
  schoolId: number,
  studentProfileId: number,
  client: DbClient = prisma,
): Promise<{ removed: number; protected: number }> {
  const activeBlocks = await (client as typeof prisma).lessonBlock.findMany({
    where: { studentGroupId: groupId, deletedAt: null },
    select: { id: true },
  });
  if (activeBlocks.length === 0) return { removed: 0, protected: 0 };

  const blockIds = activeBlocks.map(b => b.id);
  const now = new Date();

  const upcomingSessions = await (client as typeof prisma).lessonSession.findMany({
    where: {
      lessonBlockId: { in: blockIds },
      status: 'UPCOMING',
      date: { gte: now },
      deletedAt: null,
    },
    select: { id: true },
  });
  if (upcomingSessions.length === 0) return { removed: 0, protected: 0 };

  const sessionIds = upcomingSessions.map(s => s.id);

  // Find sessions where this student already has attendance — must NOT delete those.
  const withAttendance = await (client as typeof prisma).attendance.findMany({
    where: { lessonSessionId: { in: sessionIds }, studentProfileId },
    select: { lessonSessionId: true },
  });
  const protectedSessionIds = new Set(withAttendance.map(a => a.lessonSessionId));

  const safeToRemove = sessionIds.filter(id => !protectedSessionIds.has(id));

  let removed = 0;
  if (safeToRemove.length > 0) {
    const result = await (client as typeof prisma).sessionStudent.deleteMany({
      where: { lessonSessionId: { in: safeToRemove }, studentProfileId },
    });
    removed = result.count;
  }

  return { removed, protected: protectedSessionIds.size };
}
