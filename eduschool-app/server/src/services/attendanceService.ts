import { Prisma, AttendanceStatus, SessionStatus } from '@prisma/client';
import { withSpan } from '../lib/otel';
import { createLogger } from '../lib/logger';
import { findActiveFreeze } from './freezeService';
import { isAttendanceAllowed } from '../lib/sessionStateMachine';
import { hasSessionStarted } from '../lib/tzUtils';

const log = createLogger('attendance');

// Decrement one credit + write the DEBIT ledger entry. Called from both the
// UPDATE and CREATE paths once a deduction has been atomically claimed.
async function writeDebit(
  tx: Prisma.TransactionClient,
  p: {
    schoolId: number; studentProfileId: number; sessionId: number;
    attendanceId: number; priceSnapshot: number | null;
    submittedById?: number; status: AttendanceStatus;
  },
) {
  await tx.studentProfile.update({
    where: { id: p.studentProfileId },
    data:  { credits: { decrement: 1 } },
  });
  await tx.lessonCreditLog.create({
    data: {
      schoolId:         p.schoolId,
      studentProfileId: p.studentProfileId,
      sessionId:        p.sessionId,
      attendanceId:     p.attendanceId,
      amount:           -1,
      reason:           `Списание за занятие #${p.sessionId}`,
      type:             'DEBIT',
      actorId:          p.submittedById ?? null,
      priceSnapshot:    p.priceSnapshot,
    },
  });
  log.info(
    { event: 'CREDIT_DEDUCTED', schoolId: p.schoolId, studentProfileId: p.studentProfileId,
      sessionId: p.sessionId, amount: -1, priceSnapshot: p.priceSnapshot, attendanceStatus: p.status },
    'Credit deducted',
  );
}

// Write the zero-amount FREEZE_SKIP ledger entry (no credit decrement).
async function writeFreezeSkip(
  tx: Prisma.TransactionClient,
  p: { schoolId: number; studentProfileId: number; sessionId: number; attendanceId: number; submittedById?: number },
) {
  await tx.lessonCreditLog.create({
    data: {
      schoolId:         p.schoolId,
      studentProfileId: p.studentProfileId,
      sessionId:        p.sessionId,
      attendanceId:     p.attendanceId,
      amount:           0,
      reason:           `FREEZE_SKIP: занятие #${p.sessionId}`,
      type:             'FREEZE_SKIP',
      actorId:          p.submittedById ?? null,
    },
  });
}

/**
 * Pre-fetched, per-session-invariant context for batch submission.
 * When provided, markAttendance skips its own reads for these values — the
 * caller (submitAttendanceAndFinalize) fetched them ONCE for the whole group
 * and already holds FOR UPDATE locks on every StudentProfile in the batch.
 * All guard LOGIC still runs identically against the pre-loaded values;
 * every financial write, atomic claim, and idempotency check is unchanged.
 */
export interface MarkAttendancePre {
  session: {
    status: SessionStatus;
    startTimeSnap: string | null;
    lessonBlock: {
      startTime: string | null;
      studentGroup: { status: string; deletedAt: Date | null } | null;
    } | null;
  };
  /** Existing attendance row for this student+session, or null. */
  existing: { id: number; status: AttendanceStatus; creditDeducted: boolean; sessionStudentId: number | null } | null;
  /** SchoolFinanceConfig.pricePerLesson (already fetched once). */
  pricePerLesson: number | null;
  /** Active StudentFreeze covering this session, or null. */
  freeze: { id: number; type: string; reason: string | null } | null;
}

export function markAttendance(
  tx: Prisma.TransactionClient,
  params: {
    sessionId: number;
    studentProfileId: number;
    status: AttendanceStatus;
    schoolId: number;
    sessionStudentId: number;
    sessionDate: Date;
    submittedById?: number;
    tz?: string;
    pre?: MarkAttendancePre;
  }
) {
  const { sessionId, studentProfileId, status, schoolId, sessionStudentId, sessionDate, submittedById, tz, pre } = params;

  return withSpan('attendance.markAttendance', async (span) => {
    span.setAttributes({ sessionId, studentProfileId, status, schoolId });

    // Load session with status — needed for both PAUSED-group guard and session-status guard
    const session = pre?.session ?? await tx.lessonSession.findFirst({
      where: { id: sessionId, schoolId, deletedAt: null },
      select: {
        status: true,
        startTimeSnap: true,
        lessonBlock: {
          select: {
            startTime: true,
            studentGroup: { select: { status: true, deletedAt: true } },
          },
        },
      },
    });

    if (!session) throw new Error('SESSION_NOT_FOUND');

    // A started UPCOMING lesson (today past its start time, or stuck from an
    // earlier date) is markable directly.
    const effectiveStartTime = session.startTimeSnap ?? session.lessonBlock?.startTime;
    const hasStarted = tz != null && effectiveStartTime != null
      && hasSessionStarted(sessionDate, effectiveStartTime, tz);
    if (!isAttendanceAllowed(session.status, { hasStarted })) {
      throw new Error('SESSION_NOT_SUBMITTABLE');
    }

    const group = session.lessonBlock?.studentGroup;
    if (group?.status === 'PAUSED' && !group.deletedAt) {
      throw new Error('Cannot submit attendance for paused group');
    }
    if (group?.deletedAt || group?.status === 'COMPLETED') {
      throw new Error('Cannot submit attendance for inactive group');
    }

    const existing = pre !== undefined ? pre.existing : await tx.attendance.findFirst({
      where: { lessonSessionId: sessionId, studentProfileId },
    });

    // Determine if we should attempt deduction.
    // wantDeduct is set here but the ACTUAL financial ops only run when deductionClaimed === true
    // (atomic claim via updateMany or exclusive CREATE wins the unique constraint race).
    let wantDeduct = !existing?.creditDeducted;
    let isFreezeSkip = false;
    let priceSnapshot: number | null = null;

    if (wantDeduct) {
      let activeFreeze: { id: number; type: string; reason: string | null } | null;

      if (pre !== undefined) {
        // Batch path: profile existence, FOR UPDATE lock, finance config and the
        // freeze lookup were all done ONCE for the whole group by the caller.
        activeFreeze = pre.freeze;
      } else {
        const profile = await tx.studentProfile.findUnique({
          where: { id: studentProfileId },
          select: { credits: true },
        });

        if (!profile) throw new Error('STUDENT_NOT_FOUND');

        // Serialize with createFreeze/createOpenEndedFreeze: both acquire FOR UPDATE on StudentProfile.
        // Guarantees ACTIVE FREEZE ⇒ NO CREDIT DEDUCTION even under concurrent freeze creation.
        // The route-level lock is defence-in-depth; this lock makes markAttendance self-contained.
        await tx.$executeRaw`SELECT id FROM "StudentProfile" WHERE id = ${studentProfileId} FOR UPDATE`;

        // StudentFreeze is the source of truth for freeze state.
        // Legacy StudentProfile.isFrozen is not read here.
        activeFreeze = await findActiveFreeze(
          { studentProfileId, sessionId, sessionDate, schoolId },
          tx,
        );
      }

      if (activeFreeze) {
        wantDeduct = false;
        isFreezeSkip = true;
        log.info(
          { event: 'CREDIT_SKIP_FROZEN', schoolId, studentProfileId, sessionId,
            freezeId: activeFreeze.id, freezeType: activeFreeze.type, sessionDate },
          'Credit skip: active StudentFreeze found',
        );
      }

      if (wantDeduct) {
        priceSnapshot = pre !== undefined
          ? pre.pricePerLesson
          : (await tx.schoolFinanceConfig.findUnique({
              where: { schoolId },
              select: { pricePerLesson: true },
            }))?.pricePerLesson ?? null;
      }
    }

    // ── UPDATE path ───────────────────────────────────────────────────────────
    if (existing) {
      // Atomic claim: only the transaction that flips creditDeducted false→true wins.
      // updateMany returns count=1 for the winner, count=0 for all concurrent losers.
      // This replaces the non-atomic `...(shouldDeduct && { creditDeducted: true })` pattern.
      let deductionClaimed = false;

      if (wantDeduct) {
        const claim = await tx.attendance.updateMany({
          where: { id: existing.id, creditDeducted: false },
          data:  { creditDeducted: true },
        });
        deductionClaimed = claim.count === 1;
      }

      // A freeze skips the credit (creditDeducted stays false + FREEZE_SKIP ledger),
      // but the DISPLAYED status is whatever the admin picked — a paused student can be
      // marked PRESENT/ABSENT and it sticks. The «на паузе» badge is driven by the
      // student's freeze state on the client, not by this attendance status field.
      const effectiveStatus: AttendanceStatus = status;

      // Update status and non-financial fields in a separate write
      const attendance = await tx.attendance.update({
        where: { id: existing.id },
        data: {
          status: effectiveStatus,
          ...(existing.sessionStudentId == null && { sessionStudentId }),
          ...(submittedById != null && { submittedById }),
        },
      });

      if (deductionClaimed) {
        await writeDebit(tx, { schoolId, studentProfileId, sessionId, attendanceId: attendance.id, priceSnapshot, submittedById, status });
      } else if (existing.creditDeducted) {
        // creditDeducted flag is write-once — idempotent skip, no new ledger entry needed
        log.info(
          { event: 'CREDIT_SKIP_IDEMPOTENT', schoolId, studentProfileId, sessionId },
          'Credit skip: already deducted (idempotent)',
        );
      } else if (isFreezeSkip) {
        await writeFreezeSkip(tx, { schoolId, studentProfileId, sessionId, attendanceId: attendance.id, submittedById });
      }

      span.setAttribute('creditDeducted', deductionClaimed);
      return attendance;
    }

    // ── CREATE path ───────────────────────────────────────────────────────────
    // ON CONFLICT DO NOTHING (skipDuplicates) never raises a PostgreSQL error and
    // never aborts the transaction — safe to query after, unlike CREATE which sets
    // the transaction to aborted state on P2002 and blocks further queries.
    // count === 1: this transaction won the race — financial ops are our responsibility.
    // count === 0: concurrent transaction inserted first — skip financial ops.
    // Freeze skips the credit but never overrides the admin's displayed status (see UPDATE path).
    const effectiveStatus: AttendanceStatus = status;

    const { count } = await tx.attendance.createMany({
      data: [{
        schoolId,
        lessonSessionId:  sessionId,
        studentProfileId,
        sessionStudentId,
        status:         effectiveStatus,
        creditDeducted: wantDeduct,
        ...(submittedById != null && { submittedById }),
      }],
      skipDuplicates: true,
    });

    const weWon = count === 1;

    const attendance = await tx.attendance.findFirst({
      where: { lessonSessionId: sessionId, studentProfileId },
    });
    if (!attendance) throw new Error('ATTENDANCE_NOT_FOUND');

    if (weWon) {
      if (wantDeduct) {
        await writeDebit(tx, { schoolId, studentProfileId, sessionId, attendanceId: attendance.id, priceSnapshot, submittedById, status });
      } else if (isFreezeSkip) {
        await writeFreezeSkip(tx, { schoolId, studentProfileId, sessionId, attendanceId: attendance.id, submittedById });
      }
    } else {
      log.info(
        { event: 'ATTENDANCE_CONCURRENT_CREATE', schoolId, studentProfileId, sessionId },
        'Concurrent attendance create race — returning winner record without financial ops',
      );
    }

    span.setAttribute('creditDeducted', weWon && wantDeduct);
    return attendance;
  });
}
