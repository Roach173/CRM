/**
 * BUSINESS INVARIANTS — Shamdan ERP
 *
 * This file is the authoritative source of truth for billing, attendance, and salary rules.
 * Read this before making ANY change to attendanceService, salary routes, or session logic.
 * These rules override assumptions made by AI assistants or new developers.
 */

// ─── BILLING INVARIANTS (кредиты студентов) ────────────────────────────────────
//
// Model: SLOT RESERVATION ("бронирование места")
//
// A student reserves a slot in a group. Whether they show up or not, the slot
// was held — credits are consumed. This mirrors how real language schools work.
//
// DEDUCTION POLICY:
//   PRESENT → credit deducted (✓)
//   LATE    → credit deducted (✓)
//   ABSENT  → credit deducted (✓) — slot was reserved, no refund
//
// NON-DEDUCTION EXCEPTIONS:
//   1. Student is FROZEN and frozenAt <= (sessionDate - freezeWindowHours)
//      — they gave advance notice within the allowed window
//   2. Session status = CANCELLED — the school cancelled the lesson
//
// IMMUTABILITY RULE:
//   creditDeducted is a ONE-WAY flag. Once true, it NEVER goes back to false.
//   Changing attendance status (PRESENT→ABSENT or vice versa) does NOT reverse billing.
//   Billing correction requires a manual credit adjustment, not attendance status edit.
//
// IDEMPOTENCY:
//   One (studentProfileId, lessonSessionId) pair → exactly ONE credit deduction.
//   The creditDeducted flag is the guard. Any code path that deducts credits
//   MUST check this flag first, inside a transaction.

export const BILLING_POLICY = {
  /** Status values that trigger credit deduction */
  DEDUCTIBLE_STATUSES: ['PRESENT', 'LATE', 'ABSENT'] as const,
  /** Session statuses where attendance can be submitted */
  SUBMITTABLE_SESSION_STATUSES: ['UPCOMING', 'COMPLETED'] as const,
  /** creditDeducted flag is immutable once set to true */
  CREDIT_DEDUCTED_IS_IMMUTABLE: true,
} as const;

// ─── ATTENDANCE INVARIANTS (посещаемость) ──────────────────────────────────────
//
// Attendance is a PEDAGOGICAL entity, not a financial one.
// Changing PRESENT→ABSENT is an editorial correction, not a billing event.
//
// RULES:
//   1. Exactly ONE Attendance record per (studentProfileId, lessonSessionId)
//      — enforced by @@unique in schema
//   2. Attendance can only be submitted for sessions in UPCOMING or COMPLETED status
//      — CANCELLED sessions must not receive attendance
//   3. Attendance.status CAN change after submission (editorial correction)
//   4. Changing status does NOT affect creditDeducted (see billing invariants above)
//   5. Session transitions to COMPLETED when ANY attendance is submitted for it

// ─── SALARY INVARIANTS (зарплата учителя) ─────────────────────────────────────
//
// Teacher attribution uses SNAPSHOTS — who actually conducted the lesson,
// not who is currently assigned to the block.
//
// SOURCE OF TRUTH:
//   LessonSession.teacherIdSnap = staffProfile.id of the teacher at session creation time
//   LessonSession.teacherId     = staffProfile.id of a substitute (override, nullable)
//
// SALARY QUERY PATTERN:
//   A session counts for teacher T if:
//     teacherId = T.staffProfileId          (substitute override)
//     OR teacherIdSnap = T.staffProfileId AND teacherId IS NULL  (regular teacher, no sub)
//
// RATE SNAPSHOT:
//   TeacherPayment.rateSnapshot = staffProfile.salaryRate at time of payment
//   TeacherRateLog tracks rate history — used by getRateForPeriod()
//   Every PATCH /salary/rate MUST create a TeacherRateLog entry
//
// LESSON COUNTS:
//   A session counts toward salary ONLY IF:
//     status != CANCELLED
//     AND attendances.some() — at least one student attended
//
// PAYMENT INVARIANTS:
//   A session can appear in AT MOST ONE TeacherPayment
//   — enforced by @@unique on TeacherPaymentLesson.lessonSessionId
//   Only COMPLETED sessions with attendance can be paid

export const SALARY_POLICY = {
  /** A session is "conducted" when status is not CANCELLED and has ≥1 attendance record */
  CONDUCTED_REQUIRES_ATTENDANCE: true,
  /** Sessions in these statuses cannot be included in payments */
  NON_PAYABLE_STATUSES: ['UPCOMING', 'CANCELLED'] as const,
  /** Rate changes must always create a TeacherRateLog entry */
  RATE_LOG_IS_MANDATORY: true,
} as const;

// ─── SESSION GENERATION INVARIANTS ────────────────────────────────────────────
//
// All session creation paths MUST go through ensureSingleSession() or
// syncSessionsForBlock(). Never create LessonSession inline in routes.
//
// A session can only be created for a date that satisfies ALL of:
//   1. date falls on a day in block.days (day-of-week check)
//   2. date falls on a school active day (school.activeDays)
//   3. date is not a holiday
//   4. date >= block.startDate (if set)
//   5. date <= block.endDate (if set)
//
// IMMUTABILITY:
//   Snapshot fields (*Snap) are set at creation time and NEVER changed.
//   Only UPCOMING sessions get their snaps updated when block settings change.
//   COMPLETED sessions retain original snaps (they're historical records).

// ─── SCHOOL POLICY INVARIANTS (версионированная политика) ─────────────────────
//
// School policy = { activeDays, workStart, workEnd, slotDuration }.
// Changes are tracked in SchoolSchedulePolicy with closed-interval versioning:
//   effectiveFrom <= queryDate AND (effectiveTo IS NULL OR effectiveTo > queryDate)
// At any moment exactly ONE policy version has effectiveTo = NULL (the current one).
//
// WHEN POLICY CHANGES:
//   1. Previous active version gets effectiveTo = now()
//   2. New version created with effectiveFrom = now(), effectiveTo = null
//   3. SchoolPolicyLog entry created (immutable audit)
//
// SESSION INVALIDATION (not hard-delete):
//   When activeDays shrinks, future UPCOMING sessions on removed days → INVALIDATED.
//   EXCEPTIONS — sessions with financial data are NEVER invalidated:
//     - sessions with Attendance records
//     - sessions with TeacherPaymentLesson records
//   These protected sessions remain UPCOMING and admin is notified via impact analysis.
//
// INVALIDATED sessions:
//   - Hidden from the schedule grid
//   - Do not count toward payroll
//   - Do not accept new attendance submissions
//   - Are NOT recreated by cron/sync
//   - Remain in DB for audit history

export const POLICY_INVARIANTS = {
  /** Current policy version always has effectiveTo = null; exactly one per school */
  SINGLE_ACTIVE_VERSION: true,
  /** Sessions with attendance OR payroll links are never invalidated */
  FINANCIAL_SESSIONS_PROTECTED: true,
  /** Historical rendering: GET /settings/timeslots?date= returns policy active on that date */
  TIMESLOTS_SUPPORT_HISTORICAL_DATE: true,
  /**
   * Policy versioning write is ATOMIC — all three ops (policyLog.create,
   * schedulePolicy.updateMany effectiveTo, schedulePolicy.create) run in
   * a single prisma.$transaction. No window can exist without an active version.
   */
  VERSIONING_IS_ATOMIC: true,
} as const;

// ─── RESTORE INVARIANTS (восстановление INVALIDATED) ──────────────────────────
//
// An INVALIDATED session can be restored to UPCOMING only if:
//   1. It has NO Attendance records
//   2. It has NO TeacherPaymentLesson link
//
// Restore is OWNER-only. The transition INVALIDATED → UPCOMING is guarded by
// a financial-data check in PATCH /session/:id/status before the DB write.
//
// KNOWN ACCEPTABLE TRADE-OFFS (stress-test matrix, 2026-05-17):
//   P3 (timezone change): sessions are stored as UTC datetimes — changing school
//     timezone doesn't move data, but UI day-boundaries shift. Do not change
//     timezone when historical sessions exist without manual audit.
//   Y3 (optimistic lock on salary payment): COMPLETED status + unique constraint
//     on TeacherPaymentLesson.lessonSessionId is sufficient protection.
//
// CREDIT LOG INVARIANTS:
//   LessonCreditLog.priceSnapshot = SchoolFinanceConfig.pricePerLesson at the
//     time of credit deduction. Set at creation; immutable. Allows financial
//     reconstruction even after pricePerLesson changes.
//   LessonCreditLog.sessionId has a FK to LessonSession with onDelete: SetNull.
//     On soft status change (INVALIDATED) — sessionId preserved.
//     On hard delete (rare) — sessionId becomes NULL, log record is retained.
//
// RATE LOG TIEBREAKER:
//   getRateForPeriod uses orderBy [effectiveFrom desc, createdAt desc].
//   Two rate changes in the same second are disambiguated by createdAt.

export const RESTORE_INVARIANTS = {
  /** Only OWNER can restore INVALIDATED sessions */
  RESTORE_IS_OWNER_ONLY: true,
  /** Restore is blocked if any attendance or salary payment link exists */
  RESTORE_REQUIRES_NO_FINANCIAL_DATA: true,
} as const;

// ─── CANCEL GUARD INVARIANT ────────────────────────────────────────────────────
//
// A session CANNOT be cancelled if it has ANY Attendance record with
// creditDeducted = true.
//
// REASON:
//   Cancellation of a session with deducted credits creates a financial
//   inconsistency: credits are already withdrawn from the student's balance
//   but the session is recorded as cancelled (implying it never happened).
//
// ENFORCEMENT:
//   assertNoCreditDeductedAttendance() is called in changeSessionStatus()
//   before the DB write. Returns 409 SESSION_HAS_DEDUCTED_CREDITS.
//
// CORRECTION PATH:
//   Issue a manual credit adjustment first, then cancel.
//   Automated correction flow is NOT implemented here — separate task.
//
// DO NOT:
//   Add auto-refund logic inside changeSessionStatus() or cancelSession().
//   The creditDeducted flag is write-once; reverting it requires an explicit
//   audit-logged correction, not a side effect of cancellation.

export const CANCEL_GUARD_INVARIANTS = {
  /** Cancel is blocked if any attendance record has creditDeducted=true */
  CANCEL_REQUIRES_NO_DEDUCTED_CREDITS: true,
  /** Error code returned: 409 SESSION_HAS_DEDUCTED_CREDITS */
  CANCEL_BLOCK_ERROR_CODE: 'SESSION_HAS_DEDUCTED_CREDITS',
} as const;
