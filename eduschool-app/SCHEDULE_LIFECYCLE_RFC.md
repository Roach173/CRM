# Schedule Lifecycle RFC

> Historical RFC/reference. Current workflow rules live in `../CLAUDE.md`.

**Status:** IMPLEMENTED (lifecycle service, makeup, freeze, and notifications described below have all shipped; status line was never updated after the DRAFT phase)  
**Author:** Adil (feature/schedule-lifecycle)  
**Created:** 2026-05-29  
**Target branch:** feature/schedule-lifecycle → dev  

---

## 1. Problem Statement

The current scheduling system was built incrementally. Each feature (cancel, makeup, freeze, teacher replacement) was added as a CRUD operation against the session record. The result is a system where **every lifecycle event is a direct mutation** instead of a named domain transition with predictable side effects.

### 1.1 CRUD edits instead of domain events

`PATCH /session/:id/status` accepts any status string and applies `canTransition()`. There is no record of *why* the transition happened, who initiated it, or what policy triggered it. The same route is used for:

- An admin manually cancelling one session.
- A teacher marking a session complete.
- A system restore after a mistaken cancel.

All three produce identical DB writes. The audit log captures the state change but not the business reason.

`POST /sessions/bulk-cancel` bypasses the state machine entirely:

```
await prisma.lessonSession.updateMany({ ... data: { status: 'CANCELLED' } });
```

No `ScheduleActionLog` entries are written. No notifications to students. No credit reversal. Version counter is incremented but no per-session audit exists. At scale (50 schools × 1 000 students), a bulk cancel on a busy day silently voids hundreds of attendance obligations.

### 1.2 Financial side effects are implicit

Credit deduction happens inside `attendanceService.ts` at the moment attendance is marked. But there is no inverse rule for what happens when a session transitions:

- `UPCOMING → CANCELLED`: no credit action defined. The route sends notifications but does not touch credits. Credits held for the session are never released because there is no reservation model — deductions only happen on attendance, not on booking.
- `CANCELLED → UPCOMING` (restore): the system re-opens the session, but there is no reconciliation step to check if a makeup session was already created for it.
- `LOCKED`: once locked, the session is terminal. There is no correction flow defined if attendance was marked incorrectly before lock.

The current credit floor check (`credits >= 1` before deduction) prevents going below zero, but the RFC requirement states that **credits can be negative** — debt is a first-class concept. This floor must be re-evaluated.

### 1.3 Salary side effects are implicit

`TeacherPaymentLesson` links a payment to a session, but:

- There is no rule blocking salary attribution to a `CANCELLED` session.
- Teacher replacement (`PATCH /session/:id/teacher`) changes `teacherId` on the session but does not affect `TeacherPaymentLesson` if the payment was already generated.
- Makeup sessions (`isMakeup: true`) have no salary policy — it is undefined whether a teacher gets paid for a makeup lesson separately or as a regular lesson.
- `ManualLessonEntry` exists as an escape hatch but there is no audit trail linking it back to a specific session lifecycle event.

### 1.4 Parent/teacher visibility has no central policy

There is no concept of "what a parent sees" in the system. The student portal shows attendance records and credits. But there is no projection layer that translates session states into parent-visible events:

- A cancelled session shows nothing in the student portal — the session simply disappears from the upcoming schedule.
- A makeup session is a regular `LessonSession` with `isMakeup: true`; no UI component exposes this distinction to the student or parent.
- Teacher replacement is visible only in the admin grid (`isSubstitute: boolean` in the week API response); the teacher and student portals have no equivalent.

### 1.5 Audit and reconciliation gaps

The reconciliation invariants that must hold for an enterprise product are:

- Every completed session with enrolled students has attendance records.
- Every `LessonCreditLog` entry maps to a live or archived session.
- No cancelled session has a positive credit deduction against it.
- Every `TeacherPaymentLesson` maps to a non-cancelled, non-invalidated session.
- Every makeup session links to exactly one cancelled original session.

None of these invariants are enforced by the current system. There is no reconciliation report. There are no database-level constraints for most of them (only the `@@unique([lessonBlockId, date])` constraint exists). Drift is silent.

---

## 2. Domain Model

This section defines the canonical meaning of each domain entity. These definitions take precedence over current implementation details.

### LessonBlock — Recurring Template

A `LessonBlock` is a **scheduling intent**: "every Monday and Wednesday at 09:00, group A has Grammar with Teacher B in Cabinet 3." It is a template, not an event. It has no attendance, no credit deduction, no salary record.

A block's lifecycle is coarse: `UPCOMING → COMPLETED | CANCELLED`. Block cancellation means the entire course series is terminated. Individual session cancellations do not change block status.

### LessonSession — Actual Occurrence

A `LessonSession` is a **scheduled event**: a specific date derived from its parent block. It is the unit of attendance, credit deduction, and salary attribution. Everything financial and operational happens at the session level.

A session's lifecycle must be a first-class state machine. Every transition is a domain event. Side effects (credits, salary, notifications, audit) are consequences of the event, not of the CRUD mutation.

### SessionStudent — Roster Snapshot

`SessionStudent` records which students were enrolled in the group **at the moment the session was generated**. It is a point-in-time snapshot, not a live query. Attendance is recorded against this snapshot, not against the current group membership.

Implication: if a student joins a group after a session was generated, they are absent from that session's `SessionStudent` list. This is correct — they were not enrolled when the class was scheduled.

### Attendance — Attendance Fact

An `Attendance` record is a **fact** about a specific student's presence at a specific session. It is created at the time attendance is submitted. It triggers credit deduction (or debt creation). The `creditDeducted` flag is the idempotency guard.

Attendance is allowed only after the session has moved to `IN_PROGRESS` or `COMPLETED`. Marking attendance on an `UPCOMING` session is a policy violation (currently the route allows it — see gap #5 in the audit).

### MakeupSession — Special LessonSession

A makeup session is a `LessonSession` with `isMakeup: true` and a non-null `makeupForSessionId`. It represents a rescheduled occurrence of a cancelled session, not a new scheduled class. Its semantics differ:

- It does not generate a new credit obligation by itself (the original session's credit was already released on cancellation or was never charged if attendance was not submitted).
- It inherits the roster snapshot from the original session's group at the time of makeup creation.
- It may be taught by a different teacher than the original.
- Its salary treatment depends on school policy (open question — see §14).

### Freeze — Billing Policy Event

A "freeze" is a **billing policy decision**: a student's credit obligations are suspended for a period. It is not a session state. It is not a direct financial skip. It is a policy that the attendance service must evaluate before creating a deduction.

Currently, freeze is implemented as `StudentProfile.isFrozen: Boolean`. The correct model is a time-bounded `FreezeEvent` with `startDate`, `endDate`, and `reason`, so that historical reporting can show why a credit was not deducted on a given date.

In this RFC, freeze is modeled as a future concern. The immediate lifecycle work does not change the freeze implementation — it only ensures the lifecycle state machine correctly consults the freeze policy before creating credit records.

### Reschedule — Lifecycle Event

A "reschedule" is currently implemented as an edit to `LessonSession.date` via `PATCH /session/:id/details`. This is wrong. A reschedule is a domain event that:

1. Terminates the original session as `RESCHEDULED`.
2. Creates a new session at the new date (which may be modeled as a makeup session or as a new regular session).
3. Generates an audit log entry linking the two sessions.
4. Notifies students of the change.
5. Does not double-charge credits.

Renaming a session's date with a PUT is silent and unauditable.

### TeacherReplacement — Lifecycle Event

A "teacher replacement" is currently a PATCH to `LessonSession.teacherId`. It updates the session record and logs to `ScheduleActionLog`. This is partially correct — it uses the state machine's `isEditable()` check and generates an audit entry.

The gap is that teacher replacement after attendance has been submitted (or after the session is locked) has no correction flow. The salary attribution does not update automatically when a teacher is replaced.

---

## 3. Proposed Lifecycle Vocabulary

These are **conceptual states** for a `LessonSession`. They are not DB enum migrations — the existing `SessionStatus` enum handles most of them. New states (`RESCHEDULED`, `MAKEUP_REQUIRED`, `MAKEUP_SCHEDULED`, `MAKEUP_COMPLETED`) are modeled as metadata fields on existing states until a DB migration is proven necessary (see §12).

| Conceptual State | Current DB State | Notes |
|-----------------|-----------------|-------|
| `SCHEDULED` | `UPCOMING` | Session exists, no action taken yet |
| `IN_PROGRESS` | `IN_PROGRESS` | Session is actively running |
| `COMPLETED` | `COMPLETED` | Session ended normally |
| `CANCELLED_BY_SCHOOL` | `CANCELLED` | School-initiated cancel; credit must be preserved |
| `CANCELLED_BY_POLICY` | `CANCELLED` | System-initiated (holiday, exception); credit must be preserved |
| `RESCHEDULED` | `CANCELLED` + metadata | Original session terminated; linked to new session |
| `MAKEUP_REQUIRED` | `CANCELLED` + `makeupRequired: true` | Cancellation implies school owes makeup |
| `MAKEUP_SCHEDULED` | `CANCELLED` + linked makeup session | Makeup session exists |
| `MAKEUP_COMPLETED` | `CANCELLED` + makeup session `COMPLETED` | Makeup was delivered |
| `LOCKED` | `LOCKED` | Terminal; no further changes |
| `INVALIDATED` | `INVALIDATED` | Data integrity issue; excluded from salary/reports |

**Implementation approach:** Add a `cancellationReason` enum and `makeupRequired: Boolean` to `LessonSession` via migration. This avoids a large enum migration while preserving the ability to query by cancel type.

---

## 4. Domain Events

Every lifecycle change is modeled as a named domain event. Events are not HTTP verbs — they are business operations that happen to be triggered via HTTP.

| Event | Trigger | Description |
|-------|---------|-------------|
| `SESSION_CANCELLED` | Admin/Owner, or system (bulk, policy) | A session will not take place |
| `SESSION_RESTORED` | Owner/Admin | A cancelled session is reinstated |
| `SESSION_RESCHEDULED` | Admin/Owner | Session moved to a new date (terminates original, creates new) |
| `TEACHER_REPLACED` | Admin/Owner | Session teacher changed before or after start |
| `MAKEUP_CREATED` | Admin/Owner | A makeup session is created for a cancelled original |
| `MAKEUP_COMPLETED` | System (on session complete, if `isMakeup`) | A makeup session was delivered |
| `ATTENDANCE_SUBMITTED` | Admin/Owner/Teacher | Attendance recorded for session |
| `SESSION_LOCKED` | Owner, or system (post-salary-run) | Session permanently closed; no further edits |
| `SESSION_INVALIDATED` | Owner | Session marked as data-integrity error |
| `FREEZE_APPLIED` | Admin/Owner | Student billing suspended from date |
| `FREEZE_REVERSED` | Admin/Owner | Student billing resumed |

---

## 5. Transition Matrix

For each domain event, the following matrix defines the full rule set.

### `SESSION_CANCELLED`

| Attribute | Value |
|-----------|-------|
| From states | `SCHEDULED`, `IN_PROGRESS` |
| To state | `CANCELLED_BY_SCHOOL` or `CANCELLED_BY_POLICY` |
| Allowed roles | `OWNER`, `ADMIN` (by school); system (by policy) |
| Required reason? | Yes — stored as `cancellationReason` |
| Audit required? | Yes — `ScheduleActionLog` per session |
| Notification required? | Yes — all students in `SessionStudent` snapshot |
| Financial side effects | Release any pre-reserved credits (none in current model); ensure no future deduction |
| Salary side effects | No salary attributed; if `TeacherPaymentLesson` exists, flag as needs correction |
| Parent visible? | Yes — "class cancelled on [date]" |

### `SESSION_RESTORED`

| Attribute | Value |
|-----------|-------|
| From states | `CANCELLED_BY_SCHOOL`, `CANCELLED_BY_POLICY` |
| To state | `SCHEDULED` |
| Allowed roles | `OWNER`, `ADMIN` |
| Required reason? | Optional |
| Audit required? | Yes |
| Notification required? | Yes — students notified of reinstatement |
| Financial side effects | Re-evaluate credit obligation when attendance is submitted |
| Salary side effects | Teacher reassignment may be needed if substitute had been cleared |
| Parent visible? | Yes — "class reinstated" |
| Guard | Cannot restore if a makeup session is already `IN_PROGRESS` or `COMPLETED` |

### `SESSION_RESCHEDULED`

| Attribute | Value |
|-----------|-------|
| From states | `SCHEDULED` |
| To state | `CANCELLED` (original) + new `SCHEDULED` session created |
| Allowed roles | `OWNER`, `ADMIN` |
| Required reason? | Yes |
| Audit required? | Yes — both sessions linked in audit log |
| Notification required? | Yes — "class moved from [old date] to [new date]" |
| Financial side effects | No double charge; original session marked as `RESCHEDULED` variant of cancel |
| Salary side effects | Salary attribution moves to the new session |
| Parent visible? | Yes — single notification with both dates |

### `TEACHER_REPLACED`

| Attribute | Value |
|-----------|-------|
| From states | `SCHEDULED`, `IN_PROGRESS` (before attendance submitted) |
| To state | Same state (teacher field updated) |
| Allowed roles | `OWNER`, `ADMIN` |
| Required reason? | Optional |
| Audit required? | Yes — `TEACHER_CHANGED` action log |
| Notification required? | Yes — students notified of substitute teacher |
| Financial side effects | None |
| Salary side effects | Salary attributed to new teacher for this session; original teacher loses the lesson count |
| Parent visible? | Yes — "substitute teacher for [date]" |
| Guard after attendance | If attendance already submitted: requires Owner-only correction flow |
| Guard after lock | BLOCKED — cannot replace teacher in locked session |

### `MAKEUP_CREATED`

| Attribute | Value |
|-----------|-------|
| From states | `CANCELLED_BY_SCHOOL`, `CANCELLED_BY_POLICY`, `RESCHEDULED` (original) |
| To state | Original stays `CANCELLED`; new session created with `isMakeup: true` |
| Allowed roles | `OWNER`, `ADMIN` |
| Required reason? | No |
| Audit required? | Yes — links original session ID |
| Notification required? | Yes — "makeup class scheduled for [date]" |
| Financial side effects | Makeup session inherits no credit obligation from original |
| Salary side effects | Makeup session may be payable per policy (open — see §14) |
| Parent visible? | Yes — "makeup class added on [date]" |
| Guard | One makeup per cancelled session (enforced by `makeupForSessionId` uniqueness if `@@unique` is added) |

### `MAKEUP_COMPLETED`

| Attribute | Value |
|-----------|-------|
| From states | `IN_PROGRESS` (on the makeup session) |
| To state | `COMPLETED` (makeup session) |
| Allowed roles | `OWNER`, `ADMIN`, `TEACHER` |
| Required reason? | No |
| Audit required? | Yes |
| Notification required? | No |
| Financial side effects | Credit deduction per attendance (same as regular session) |
| Salary side effects | Per policy — see §8 |
| Parent visible? | Yes — makeup session appears as completed |

### `ATTENDANCE_SUBMITTED`

| Attribute | Value |
|-----------|-------|
| From states | `IN_PROGRESS`, `COMPLETED` |
| To state | Same state (attendance record created) |
| Allowed roles | `OWNER`, `ADMIN`, `TEACHER` |
| Required reason? | No |
| Audit required? | Yes — existing `LessonCreditLog` serves as audit |
| Notification required? | No (per student may be added later) |
| Financial side effects | PRESENT/LATE: deduct 1 credit (debt allowed); ABSENT: return credit if previously deducted |
| Salary side effects | None at submission time; salary is computed at payment time |
| Parent visible? | Yes — attendance fact visible in student portal |
| Guard (CRITICAL) | `UPCOMING` sessions MUST NOT accept attendance. Current route allows it — this is a bug. |

### `SESSION_LOCKED`

| Attribute | Value |
|-----------|-------|
| From states | `COMPLETED` |
| To state | `LOCKED` |
| Allowed roles | `OWNER` only |
| Required reason? | No |
| Audit required? | Yes |
| Notification required? | No |
| Financial side effects | Credits frozen — no further deduction or correction without explicit correction flow |
| Salary side effects | `TeacherPaymentLesson` created or validated |
| Parent visible? | No |

### `SESSION_INVALIDATED`

| Attribute | Value |
|-----------|-------|
| From states | `COMPLETED`, `LOCKED` |
| To state | `INVALIDATED` |
| Allowed roles | `OWNER` only |
| Required reason? | Yes — mandatory explanation |
| Audit required? | Yes |
| Notification required? | Optional |
| Financial side effects | Credit reversals for all `PRESENT`/`LATE` attendance on this session |
| Salary side effects | `TeacherPaymentLesson` must be voided; creates correction flag |
| Parent visible? | No — internal data integrity operation |

### `FREEZE_APPLIED` / `FREEZE_REVERSED`

| Attribute | Value |
|-----------|-------|
| From states | Any (student-level, not session-level) |
| Allowed roles | `OWNER`, `ADMIN` |
| Required reason? | Yes |
| Audit required? | Yes — `ScheduleActionLog` with `entityType: 'student'` |
| Financial side effects | Freeze: skip credit deduction for sessions in freeze period; Reverse: resume normal deduction |
| Salary side effects | None |
| Parent visible? | Optionally — "account frozen from [date] to [date]" |

---

## 6. Side Effects Matrix

For every event, the complete set of side effects that **must** be executed atomically (within the same DB transaction or queued reliably after commit).

| Event | Audit Log | WebSocket | Notification | Cache Invalidation | Credit/Debt | Salary | Invoice | Parent Portal |
|-------|-----------|-----------|-------------|-------------------|-------------|--------|---------|---------------|
| `SESSION_CANCELLED` | ✅ per session | `session:status-changed` | ✅ students in snapshot | `invalidateBlockCaches()` | None (no reservation model) | Block attribution | None | ✅ visible |
| `SESSION_RESTORED` | ✅ | `session:status-changed` | ✅ students | Cache invalidate | Re-open for future deduction | Restore teacher | None | ✅ visible |
| `SESSION_RESCHEDULED` | ✅ both sessions | `session:status-changed` (both) | ✅ students (combined message) | Cache invalidate | None | Salary moves to new session | None | ✅ visible |
| `TEACHER_REPLACED` | ✅ | `session:status-changed` | ✅ students | Session-level cache | None | ✅ Re-attribute salary | None | ✅ sub note |
| `MAKEUP_CREATED` | ✅ | `session:status-changed` | ✅ students | Cache invalidate | None | Per policy | None | ✅ visible |
| `MAKEUP_COMPLETED` | ✅ | `session:status-changed` | No | Cache invalidate | ✅ deduct per attendance | Per policy | None | ✅ visible |
| `ATTENDANCE_SUBMITTED` | ✅ via CreditLog | `attendance:updated` | No | Analytics cache (60s) | ✅ deduct or reverse | None | None | ✅ visible |
| `SESSION_LOCKED` | ✅ | No | No | None | ✅ freeze credits | ✅ create PaymentLesson | ✅ finalize | No |
| `SESSION_INVALIDATED` | ✅ | No | Optional | Cache invalidate | ✅ reverse all deductions | ✅ void PaymentLesson | ✅ credit note | No |
| `FREEZE_APPLIED` | ✅ | No | Optional | Student analytics cache | Skip deduction in period | None | None | Optional |
| `FREEZE_REVERSED` | ✅ | No | No | Student analytics cache | Resume normal | None | None | No |

---

## 7. Credit/Debt Rules

**Critical invariant:** Credits can be negative. `credits < 0` means the student has lesson debt. The current credit floor check (`credits >= 1`) conflicts with this invariant and must be replaced with a configurable debt limit policy (see §14).

### 7.1 Deduction rules

| Condition | Action |
|-----------|--------|
| Attendance status → `PRESENT` or `LATE`, `creditDeducted = false` | Deduct 1 credit. If `credits` would go below school's `debtLimit` (default 0), reject with `DEBT_LIMIT_EXCEEDED` or allow based on policy. |
| Attendance status → `PRESENT` or `LATE`, `creditDeducted = true` | No-op (idempotent) |
| Attendance status → `ABSENT`, `creditDeducted = true` | Reverse deduction: `credits += 1`, `creditDeducted = false`, create `LessonCreditLog` with negative amount |
| Attendance status → `ABSENT`, `creditDeducted = false` | No-op |
| Student has active freeze covering session date | Skip deduction entirely; `creditDeducted` stays `false` |

### 7.2 Session lifecycle and credits

| Session Event | Credit Action |
|--------------|---------------|
| `SESSION_CANCELLED` | No action (deduction only happens at attendance submission, not at session existence) |
| `SESSION_RESTORED` | No action (session re-opens; credits will be charged when attendance is submitted) |
| `SESSION_RESCHEDULED` | No action on original; new session has no credit obligation until attendance |
| `MAKEUP_CREATED` | No action — makeup inherits no credit obligation |
| `MAKEUP_COMPLETED` with attendance `PRESENT/LATE` | Deduct 1 credit per student normally |
| `MAKEUP_COMPLETED` with attendance `PRESENT/LATE` if original had credit deducted | No deduction — credit was already charged for the original session |
| `SESSION_LOCKED` | Credits frozen; no further deductions or reversals except via `SESSION_INVALIDATED` |
| `SESSION_INVALIDATED` | Reverse all `PRESENT`/`LATE` deductions for this session |

### 7.3 Reconciliation invariants for credits

1. `LessonCreditLog.amount` sum per student must equal `StudentProfile.credits` delta since baseline.
2. No `LessonCreditLog` record with a deduction reason links to a session with status `CANCELLED` or `INVALIDATED`.
3. For every `Attendance` with `creditDeducted = true`, a matching `LessonCreditLog` entry exists.
4. For every `Attendance` with `creditDeducted = false` and status `PRESENT` or `LATE`, no deduction log entry exists (unless the session is `INVALIDATED` and was reversed).

---

## 8. Salary Rules

### 8.1 Attribution

- Salary for a session is attributed to the teacher who is set on `LessonSession.teacherId` at the time attendance is submitted (or at session lock for auto-attribution).
- If `teacherId` is null, salary is attributed to `LessonBlock.teacherId` (block default teacher).
- `TeacherPaymentLesson` maps `TeacherPayment → LessonSession`. One session can appear in at most one `TeacherPayment`.

### 8.2 Teacher replacement and salary

| Replacement timing | Salary effect |
|-------------------|---------------|
| Before attendance submitted | Salary attributed to new teacher. If old teacher's payment already exists, requires correction flow (see 8.5). |
| After attendance submitted, before lock | Salary attribution updates to new teacher in current payment period. |
| After lock | BLOCKED. Correction flow required (Owner only). |

### 8.3 Cancellation and salary

| Session state | Salary |
|--------------|--------|
| `CANCELLED_BY_SCHOOL` | Not payable. Excluded from `TeacherPaymentLesson`. |
| `CANCELLED_BY_POLICY` | Not payable by default. School policy may override (open — see §14). |
| `INVALIDATED` | Not payable. Any existing `TeacherPaymentLesson` record must be voided. |
| `LOCKED` | Payable. `TeacherPaymentLesson` record is created. |
| `COMPLETED` (not yet locked) | Tentatively payable; included in salary report but payment not finalized. |

### 8.4 Makeup sessions and salary

| Makeup session | Salary treatment |
|---------------|-----------------|
| Taught by original block teacher | Payable as a regular lesson (default) |
| Taught by substitute | Payable to substitute (default) |
| School policy: makeup is not extra pay | Not payable (school must set policy flag) |

This is an open question — see §14. Default: payable to whoever teaches it.

### 8.5 Correction flow

When a `LOCKED` session's teacher must change (data entry error, dispute), an Owner creates a `ManualLessonEntry`:

- `type: REMOVE` for the incorrectly attributed teacher.
- `type: ADD` for the correct teacher.
- `reason` must reference the original session ID.

This is the defined escape hatch. It does not modify `TeacherPaymentLesson` records retroactively.

### 8.6 Salary reconciliation invariants

1. No `TeacherPaymentLesson` record links to a session with status `CANCELLED` or `INVALIDATED`.
2. No session appears in more than one `TeacherPayment`.
3. The sum of `TeacherPayment.lessonsCount` matches the count of `TeacherPaymentLesson` records for that payment.
4. Every `TeacherPaymentLesson.lessonSessionId` resolves to a session with `schoolId` matching the payment's school.

---

## 9. Parent Visibility Rules

"Parent" in this context means the student or parent user accessing the student portal. The following defines the canonical display rule for each session state.

| Session State | Portal Label | Visible? | Notes |
|--------------|-------------|----------|-------|
| `SCHEDULED` | "Upcoming" | Yes | Normal upcoming class |
| `IN_PROGRESS` | "In progress" | Yes | Class is active right now |
| `COMPLETED` | "Completed" | Yes | Class took place |
| `CANCELLED_BY_SCHOOL` | "Cancelled" | Yes | "Class cancelled by school on [date]" |
| `CANCELLED_BY_POLICY` | "Cancelled" | Yes | "Class cancelled (holiday/exception)" |
| `RESCHEDULED` | "Rescheduled" | Yes | "Class moved to [new date]" — links to new session |
| `MAKEUP_REQUIRED` | "Makeup pending" | Yes | "School owes a makeup class" |
| `MAKEUP_SCHEDULED` | "Makeup scheduled" | Yes | "Makeup on [date]" with link to makeup session |
| `MAKEUP_COMPLETED` | Rolls into `COMPLETED` | Yes | Makeup delivered — shown as a regular completed class |
| Teacher replaced | Attendance card note | Yes | "Substitute teacher: [name]" |
| `LOCKED` | "Completed" | Yes | Lock is internal; student sees as completed |
| `INVALIDATED` | Hidden | No | Internal data integrity state — never shown to students/parents |

**Projection layer:** A `studentPortalProjection(session, attendance, makeup)` function in a new `sessionProjectionService.ts` will transform internal state into portal-safe view objects. The student API routes must use this projection, never expose raw session status.

---

## 10. Reconciliation Requirements

These checks must be implementable as a runnable report (later: automated daily cron).

### 10.1 Attendance completeness

- For every `LessonSession` with status `COMPLETED` or `LOCKED`, and with at least one `SessionStudent` record: there must be at least one `Attendance` record, **or** an explicit no-show policy flag must be set (`attendanceSkipped: boolean`).
- Incomplete sessions (no attendance, no policy) are flagged as `RECONCILIATION_GAP`.

### 10.2 Credit deduction mapping

- For every `Attendance` with `creditDeducted = true`: a `LessonCreditLog` record with `attendanceId` matching must exist.
- For every `LessonCreditLog` with a deduction type (`DEDUCTION`): the linked `Attendance.creditDeducted` must be `true` and the session must not be `CANCELLED` or `INVALIDATED`.

### 10.3 No cancelled session consumes credit

- Query: `SELECT COUNT(*) FROM LessonCreditLog lcl JOIN Attendance a ON a.id = lcl.attendanceId JOIN LessonSession ls ON ls.id = a.lessonSessionId WHERE ls.status IN ('CANCELLED', 'INVALIDATED') AND lcl.amount < 0`.
- Expected result: 0. Any non-zero result is a financial integrity violation.

### 10.4 Salary integrity

- No `TeacherPaymentLesson` where `lessonSession.status IN ('CANCELLED', 'INVALIDATED')`.
- No session appearing in two distinct `TeacherPayment` records.

### 10.5 Makeup link integrity

- Every `LessonSession` with `isMakeup = true` has a non-null `makeupForSessionId`.
- Every `makeupForSessionId` resolves to a session with status `CANCELLED` (not `UPCOMING`, `COMPLETED`, or `LOCKED`).
- No cancelled session has more than one non-invalidated makeup session.

### 10.6 Debt balance integrity

- `StudentProfile.credits` must equal the sum of all `StudentPayment.creditsAdded` minus the absolute sum of all `LessonCreditLog.amount` deductions for that student, since account creation.
- Allow ±1 rounding tolerance for legacy data. Any discrepancy beyond tolerance is a reconciliation violation.

---

## 11. Implementation Strategy

Phases are ordered to minimize risk. Each phase is a separate PR.

### PR 1 — Lifecycle tests around existing behavior

**Goal:** Capture the current behavior in tests before changing anything.

- Integration tests for `sessionStateMachine.ts` covering all current transitions.
- Integration tests for `attendanceService.ts` covering deduction, reversal, idempotency.
- Test that `bulk-cancel` route **does not** write audit logs (document the gap, do not fix yet).
- Test that `PATCH /session/:id/attendance` correctly rejects `UPCOMING` status (or documents that it currently allows it).
- Tests for `canTransition` with all role × state combinations.
- Financial regression tests: mark attendance twice, expect single deduction; mark absent after present, expect reversal.

**No production code changes in this PR.**

### PR 2 — `scheduleLifecycleService` skeleton

**Goal:** Create the service module that will handle all lifecycle transitions.

- New file: `server/src/services/scheduleLifecycleService.ts`
- Exports: `cancelSession()`, `restoreSession()`, `replaceTeacher()`, `createMakeup()`, `lockSession()`, `invalidateSession()`.
- Each function: accepts `(tx: DbClient, params)`, enforces the transition matrix from §5, writes `ScheduleActionLog`, returns a typed result.
- No changes to existing routes yet — the service is created but not wired in.
- Tests for each exported function using the test patterns from PR 1.

### PR 3 — Cancel / Restore flow

**Goal:** Wire `SESSION_CANCELLED` and `SESSION_RESTORED` through `scheduleLifecycleService`.

- `PATCH /session/:id/status` for cancel/restore uses `scheduleLifecycleService.cancelSession()`.
- `POST /sessions/bulk-cancel` uses `scheduleLifecycleService.cancelSession()` per session (in a single transaction batch for performance).
- Add `cancellationReason` enum field to `LessonSession` via migration.
- Verify: audit log written per session for bulk cancel.
- Verify: notifications sent to students on cancel.
- Verify: no credit action on cancel (correct — credits only move at attendance time).

### PR 4 — Reschedule flow

**Goal:** First-class reschedule as a domain event.

- New endpoint: `POST /session/:id/reschedule` — takes `{ newDate, reason }`.
- Creates new `LessonSession` at `newDate` with makeup-like semantics (`makeupForSessionId` or a new `rescheduledToSessionId` field).
- Marks original session with cancellation subtype `RESCHEDULED`.
- Sends combined notification: "class moved from X to Y."
- `PATCH /session/:id/details` no longer accepts `date` field (date is read-only after creation).

### PR 5 — Teacher replacement flow

**Goal:** Salary-aware teacher replacement.

- `PATCH /session/:id/teacher` uses `scheduleLifecycleService.replaceTeacher()`.
- After replacement: salary counter for original teacher decremented (via `ManualLessonEntry REMOVE`), new teacher incremented (via `ManualLessonEntry ADD`), if the session is in the current payment period.
- Guard: replacement blocked on `LOCKED` sessions.
- Guard: replacement after attendance submitted → Owner-only with required reason.

### PR 6 — Makeup and Freeze flow

**Goal:** Makeup link integrity + freeze as billing policy.

- Add `@@unique` constraint on `makeupForSessionId` (one makeup per cancelled session).
- `POST /session/:id/makeup` uses `scheduleLifecycleService.createMakeup()`.
- Freeze: add `StudentFreeze` model with `startDate`, `endDate`, `reason`. `attendanceService` consults freeze before deducting.
- Migration: migrate existing `StudentProfile.isFrozen` flag to `StudentFreeze` records with `startDate = now()` and no `endDate`.

### PR 7 — Parent visibility projection

**Goal:** Student/parent portal shows lifecycle-aware session state.

- New service: `server/src/services/sessionProjectionService.ts` — `projectForStudent(session)`.
- Student schedule API (`GET /schedule/student`) uses projection layer.
- Student attendance API exposes substitute teacher flag.
- `isMakeup: true` sessions are labeled distinctly in the API response.

### PR 8 — Reconciliation report

**Goal:** Automated invariant checking.

- New endpoint: `GET /admin/reconciliation?month=YYYY-MM` — runs the checks from §10, returns a list of violations by category.
- Background cron: daily reconciliation run, logs violations to `ScheduleActionLog` with `entityType: 'reconciliation'`.
- Slack/email webhook for violations above threshold (wired into existing `webhooks.ts`).

---

## 12. Migration Strategy

### Principle: service-layer events before DB enum migration

The current `SessionStatus` enum covers most needs. New conceptual states (`RESCHEDULED`, `MAKEUP_REQUIRED`, etc.) are represented as metadata fields, not new enum values, until the reconciliation data proves they are queried directly.

### Proposed minimal DB changes (PRs 3–6)

| Migration | Change | When |
|-----------|--------|------|
| `cancellationReason` enum | `CancellationReason: BY_SCHOOL | BY_POLICY | RESCHEDULED | BULK_CANCEL` | PR 3 |
| `makeupRequired: Boolean @default(false)` | On `LessonSession` | PR 3 |
| `@@unique([makeupForSessionId])` | Enforce one makeup per cancelled session | PR 6 |
| `StudentFreeze` model | `id, schoolId, studentProfileId, startDate, endDate?, reason, createdAt, createdById` | PR 6 |
| `attendanceSkipped: Boolean @default(false)` | Explicit no-show policy for reconciliation | PR 8 |

### What requires a full enum migration (later, only if proven necessary)

- If queries routinely need `WHERE status = 'RESCHEDULED'` — add to `SessionStatus` enum.
- If `MAKEUP_REQUIRED` and `MAKEUP_SCHEDULED` are filtered in analytics — add to enum.
- If the enum migration is needed, it runs in a single migration alongside all affected TypeScript changes.

**Rule:** Do not run a DB enum migration until at least one PR's tests prove it is necessary for a query. Metadata fields are zero-migration.

---

## 13. Test Strategy

### Unit tests

- `sessionStateMachine.ts`: every `canTransition(from, to, role)` combination — allowed and blocked. All 11 × 11 × 5 combinations.
- `attendanceService.ts`: deduction, reversal, idempotency, freeze skip, debt-allowed mode, debt-blocked mode.
- `scheduleLifecycleService.ts`: each exported function with mock DB client (Prisma test client or in-memory stub).
- `sessionProjectionService.ts`: projection output for all 11 conceptual states.

### Integration tests (hit real DB via test container or test schema)

- Cancel flow: session cancelled → audit log exists → notifications dispatched → no credit deduction.
- Bulk cancel: N sessions cancelled → N audit log entries → N notifications dispatched.
- Restore: restored session has no stale makeup or credit artifacts.
- Reschedule: original in `CANCELLED/RESCHEDULED` → new session created → credit not double-charged → combined notification sent.
- Teacher replacement: replaced before attendance → salary counter updates. Replaced after attendance → requires Owner role + reason.
- Makeup flow: one cancelled session, one makeup created, makeup completed with attendance → credit deducted once.
- Lock flow: locked session → no further attendance accepted → salary record created.
- Invalidated flow: invalidated session → all credit deductions reversed → salary record voided.

### Concurrency tests

- Two simultaneous `PATCH /session/:id/status` requests for the same session — only one wins (optimistic lock via `version` field).
- Simultaneous attendance submission for the same student on the same session — only one credit deduction occurs (`creditDeducted` flag idempotency).
- Simultaneous bulk cancel and single session restore — last write wins with version conflict detection.

### Financial regression tests

- Mark PRESENT → credits decrease by 1. Mark again → no change (idempotent).
- Mark ABSENT after PRESENT → credit returned exactly once.
- Mark PRESENT with freeze active → no deduction.
- Cancel session after attendance submitted → credits remain as-is (deduction already happened).
- Invalidate session after PRESENT attendance → credit returned for every PRESENT student.
- Reschedule session → no double charge when attending new session.

### Parent visibility tests

- Cancelled session → portal label "Cancelled" with date.
- Rescheduled session → portal shows "Moved to [new date]."
- Makeup session → portal shows "Makeup class on [date]."
- Invalidated session → not visible in student portal.
- Substitute teacher → attendance card shows "Substitute: [name]."

### Salary attribution tests

- Session taught by Teacher A → `TeacherPaymentLesson` links to A.
- Teacher replaced pre-attendance → `TeacherPaymentLesson` links to B (new teacher).
- Session cancelled → no `TeacherPaymentLesson` record.
- Session invalidated → existing `TeacherPaymentLesson` voided.
- Makeup session completed → `TeacherPaymentLesson` created for teacher who taught it.

### Reconciliation tests

- Generate a known set of violations (cancelled session with credit deduction, `TeacherPaymentLesson` on cancelled session) → reconciliation report returns exactly those violations.
- Clean dataset → reconciliation report returns empty.

---

## 14. Open Questions

The following require business decisions before implementation. They are documented here so that the implementation PRs can start without blocking on them — defaults are proposed, but school owners must confirm.

### Q1 — Debt limit policy

**Question:** Can a student attend lessons when `credits < 0`? How far into debt is allowed?

**Current behavior:** `attendanceService` blocks if `credits < 1` (`INSUFFICIENT_CREDITS`). This prevents debt.

**Options:**
- A. No debt allowed (current). Simple. Teachers cannot mark PRESENT for students who haven't paid.
- B. Debt up to `-N` credits (configurable per school). Teachers can mark present; balance goes negative. Admin is alerted.
- C. Unlimited debt (soft limit, warning only). Maximum flexibility, maximum financial risk.

**Recommendation:** Option B with school-level `maxDebtCredits: Int @default(0)`. Debt is intentional and needed for recurring clients who pay at month-end.

### Q2 — Makeup consumes credit or not

**Question:** When a makeup session has attendance marked `PRESENT`, does it deduct 1 credit?

**Options:**
- A. Yes — makeup is a lesson delivered; the student owes 1 credit regardless of the cancellation.
- B. No — the credit was already effectively reserved for the cancelled session; makeup is delivery of a pre-paid obligation.
- C. School policy setting — schools can choose.

**Recommendation:** Option B as default. The cancelled session credit was either already charged (attendance was submitted before cancel — edge case) or was never charged. Makeup delivers the session that was cancelled; no new credit obligation arises.

**Edge case:** If attendance was submitted on the cancelled session (possible under current code for `COMPLETED → CANCELLED` or if future `IN_PROGRESS → CANCELLED` allows it), the credit was already deducted. Makeup in this case must be free (Option B still holds).

### Q3 — Cancelled by school vs. cancelled by student

**Question:** Should `CANCELLED_BY_SCHOOL` and `CANCELLED_BY_STUDENT` (student requests absence) be separate states?

**Current model:** There is no student-initiated cancellation. Only admins cancel sessions.

**Recommendation:** Defer. Student-initiated cancellation is a separate feature (late withdrawal policy). For this RFC, all cancellations are school-initiated. Model `cancellationReason: CancellationReason` covers `BY_SCHOOL | BY_POLICY | RESCHEDULED | BULK_CANCEL`.

### Q4 — Teacher salary for cancelled class (emergency cancel)

**Question:** If the school cancels a class at the last minute (< 2 hours before start), does the teacher still get paid?

**Options:**
- A. Never — cancellation means no lesson delivered.
- B. Always — teacher showed up; it's the school's fault.
- C. Policy-based — school configures `paidCancelWithinHours: Int`.

**Recommendation:** Option C. Add `paidCancelWithinHours: Int @default(0)` to `SchoolSchedulePolicy`. If `0`, cancelled sessions are never paid. If `2`, sessions cancelled < 2 hours before start are paid.

### Q5 — Parent notification timing

**Question:** When should the parent/student receive a notification?

- At the moment of cancellation (current — yes, via `notifyMany`).
- At the moment of makeup scheduling (current — yes, if admin creates a makeup).
- At session start + 15 min if no attendance submitted (proactive reminder)?

**Recommendation:** Keep current behavior. Add a "makeup scheduled" notification in PR 6. Defer proactive reminders to a future notification system phase.

### Q6 — Lock period rules

**Question:** What triggers a session lock? Currently, lock is manual (Owner presses lock).

**Options:**
- A. Manual only (current).
- B. Auto-lock N days after session date (cron).
- C. Auto-lock when salary for that period is marked as paid.

**Recommendation:** Option C for production — sessions auto-lock when the salary payment for their period is created. This aligns the financial close with the session close. Until salary payment is created, sessions remain `COMPLETED` and editable.

**Interim (PR 2–5):** Manual lock by Owner, as today. Auto-lock via salary payment is PR 8+ scope.

### Q7 — Attendance on UPCOMING sessions

**Question:** The current route accepts attendance for `UPCOMING` sessions. Is this intentional?

**Current code:** `isAttendanceAllowed(status)` in `sessionStateMachine.ts` returns `true` only for `IN_PROGRESS | COMPLETED`. But `PATCH /session/:id/attendance` route does not call `isAttendanceAllowed()` — it calls `canTransition()` (which is for status transitions, not attendance).

**Answer:** This is a bug. Attendance on `UPCOMING` sessions must be rejected. Fix in PR 3 (add `isAttendanceAllowed()` check to the attendance route).

---

## Appendix A: Existing Transition Table (Current State)

For reference — the current `sessionStateMachine.ts` transition rules:

| From | To | Allowed Roles |
|------|----|--------------|
| `UPCOMING` | `IN_PROGRESS` | OWNER, ADMIN, TEACHER |
| `UPCOMING` | `CANCELLED` | OWNER, ADMIN |
| `IN_PROGRESS` | `COMPLETED` | OWNER, ADMIN, TEACHER |
| `IN_PROGRESS` | `CANCELLED` | OWNER, ADMIN |
| `COMPLETED` | `LOCKED` | OWNER |
| `CANCELLED` | `UPCOMING` | OWNER, ADMIN |
| `INVALIDATED` | `UPCOMING` | OWNER |

**Gaps in current table:**
- No `COMPLETED → CANCELLED` path (intentional? needs confirmation).
- No `COMPLETED → INVALIDATED` path (currently `INVALIDATED → UPCOMING` exists but no way to reach `INVALIDATED`).
- `LOCKED → *` is blocked entirely by early return (correct).
- No `UPCOMING → COMPLETED` shortcut (admin can skip IN_PROGRESS for async recording — is this needed?).

---

## Appendix B: Recommended First PR

**PR 1 is the correct starting point.** No production code changes. Tests only.

The primary value of PR 1:

1. It documents the current behavior precisely — including the bugs (attendance on `UPCOMING`, bulk-cancel bypass of audit log).
2. It creates the regression baseline that PRs 2–8 must not break.
3. It forces clarity on ambiguous existing behaviors before code changes compound them.

**Suggested test file structure:**

```
server/src/__tests__/
  unit/
    sessionStateMachine.test.ts   (PR 1)
    attendanceService.test.ts     (PR 1)
  integration/
    sessionLifecycle.test.ts      (PR 1 — documents current, PR 3+ extends)
    bulkCancel.test.ts            (PR 1 — documents gap, PR 3 fixes)
    makeupFlow.test.ts            (PR 1 setup, PR 6 fills)
    financialRegression.test.ts   (PR 1)
    salaryAttribution.test.ts     (PR 5)
    reconciliation.test.ts        (PR 8)
```

---

## 12. PR 2 Implementation — Service Skeleton (2026-05-29)

### What was built

PR 2 introduces the orchestration layer described in §11. No behaviour changes — identical responses, same DB operations, characterisation tests remain green.

#### New files

**`server/src/services/scheduleLifecycleTypes.ts`** — pure TypeScript types, no project imports:
- `LifecycleEventType` (12 events)
- `LifecycleActor`, `LifecycleContext`, `LifecycleValidationResult`, `LifecycleTransitionResult`, `LifecycleSideEffects`, `LifecycleAuditPayload`
- `LIFECYCLE_SIDE_EFFECTS: Record<LifecycleEventType, LifecycleSideEffects>` — authoritative side-effect contract per event
- `EVENTS_REQUIRING_REASON: ReadonlySet<LifecycleEventType>` — currently empty (enforcement deferred to PR 3)
- `deriveEventType(fromStatus, toStatus): LifecycleEventType` — maps status pair to domain event

**`server/src/services/scheduleLifecycleService.ts`** — orchestration service:

| Export | Status | Notes |
|--------|--------|-------|
| `SESSION_STATUS_CHANGE_INCLUDE` | ✅ | Shared Prisma include constant, imported by route |
| `changeSessionStatus()` | ✅ | Full implementation: state machine → restore guard → DB update → audit → notify → socket |
| `cancelSession()` | ✅ | Thin wrapper → changeSessionStatus |
| `restoreSession()` | ✅ | Thin wrapper → changeSessionStatus |
| `reopenSession()` | ✅ | Thin wrapper → restoreSession |
| `lockSession()` | ✅ | Thin wrapper → changeSessionStatus |
| `submitAttendance()` | ✅ | Pure delegation → markAttendance (no behaviour change) |
| `assertSessionBelongsToSchool()` | ✅ | Tenant guard, throws 404 |
| `assertLifecycleTransitionAllowed()` | ✅ | Calls canTransition, returns LifecycleValidationResult |
| `assertSessionEditable()` | ✅ | Checks LOCKED/CANCELLED for TEACHER_REPLACED, SESSION_RESCHEDULED |
| `requireLifecycleReason()` | ✅ | Returns valid for all events (EVENTS_REQUIRING_REASON is empty) |
| `buildLifecycleAuditPayload()` | ✅ | Canonical audit payload builder |
| `rescheduleSession()` | ⏳ TODO PR 4 | Throws 501 |
| `replaceTeacher()` | ⏳ TODO PR 3 | Throws 501 |
| `createMakeupSession()` | ✅ PR 6 | Full lifecycle: audit + notify + socket |
| `applyFreeze()` | ✅ PR 6 | Full lifecycle: audit + notify |
| `reverseFreeze()` | ✅ PR 6 | Full lifecycle: audit + notify |
| `invalidateSession()` | ⏳ TODO PR 3 | Throws 501 |

**`server/src/__tests__/unit/scheduleLifecycleService.test.ts`** — 59 unit tests, no DB:
- `deriveEventType` mapping (7 cases)
- `requireLifecycleReason` current characterisation — all events pass (3 cases)
- `LIFECYCLE_SIDE_EFFECTS` contract spot-checks (8 cases)
- `assertLifecycleTransitionAllowed` (7 cases)
- `assertSessionEditable` (7 cases)
- `buildLifecycleAuditPayload` shape (2 cases)
- `assertSessionBelongsToSchool` 404 guard (3 cases)
- `changeSessionStatus` transition guard / restore guard / success path (15 cases)
- Stub methods throw 501 (6 cases)

#### Modified files

**`server/src/routes/schedule.ts`** — `PATCH /session/:id/status`:
- Added import: `changeSessionStatus` from lifecycle service
- Replaced inline logic (canTransition + restore guard + prisma.update + logScheduleAction + notifyMany + emitToSchool) with a single `changeSessionStatus()` call
- Catch block extended to handle `httpStatus: 403` and `httpStatus: 409` from service errors
- Response shape **identical** — no API contract change

### Invariants preserved

- All 85 characterisation tests (PR 1) remain green
- Financial behaviour unchanged: credit deduction only at attendance submit
- Notification behaviour unchanged: `notifyMany` only for `SESSION_CANCELLED`
- Socket emit behaviour unchanged: `emitToSchool` on every status change
- Optimistic locking preserved: `versionGuard` → `{ version }` in Prisma where clause
- Restore guard preserved: `INVALIDATED → UPCOMING` blocked if attendance or payment records exist

### Test count after PR 2

| Suite | Count |
|-------|-------|
| Unit (3 files) | 118 |
| Integration (38 files) | 518 |
| **Total** | **636** |

---

## 13. PR 3 Implementation — Cancel/Invalidate + Teacher Replacement (2026-05-30)

### What was built

PR 3 completes the cancel/invalidate flows and teacher replacement wiring. All characterisation tests remain green.

#### Modified files

**`server/src/services/scheduleLifecycleTypes.ts`**:
- `EVENTS_REQUIRING_REASON` — populated with 3 events: `SESSION_CANCELLED`, `SESSION_INVALIDATED`, `TEACHER_REPLACED`. Hard 400 enforcement; reason must be ≥ 5 chars.

**`server/src/services/scheduleLifecycleService.ts`**:
- `requireLifecycleReason()` — now checks `EVENTS_REQUIRING_REASON`; returns invalid if reason absent or < 5 chars.
- `assertSessionEditable()` — **fixed**: now uses an allow-list (`UPCOMING | IN_PROGRESS`) instead of a block-list. COMPLETED sessions are correctly rejected (422) for `TEACHER_REPLACED` and `SESSION_RESCHEDULED`.
- `replaceTeacher()` — **fully implemented**:
  - Reason guard (≥ 5 chars)
  - Tenant isolation: `assertSessionBelongsToSchool()`
  - Editability guard: `assertSessionEditable()` — 422 for LOCKED / CANCELLED / COMPLETED
  - Cross-tenant guard: substitute teacher must belong to same school
  - Salary safety: 409 if `TeacherPaymentLesson` already exists for the session
  - DB update: `teacherId`, `isManualTeacher: true`, `version++`
  - Audit: `logScheduleAction('CHANGE_TEACHER')` with `before: { teacherId }` / `after: { teacherId, teacherName }`
  - Student notifications: `notifyMany(type: 'SUBSTITUTE_TEACHER')`
  - Socket: `session:teacher-changed`
- `invalidateSession()` — **fully implemented**:
  - Reason guard (≥ 5 chars)
  - LOCKED path: only SUPERADMIN can override (bypass state machine → direct DB update + audit + socket)
  - Normal path: UPCOMING/IN_PROGRESS → `changeSessionStatus(targetStatus: 'INVALIDATED')`
- `cancelSession()` — reason now enforced via `changeSessionStatus()` (reason in `EVENTS_REQUIRING_REASON`)

**`server/src/routes/schedule.ts`**:
- `PATCH /session/:id/teacher` (assign path): now routes through `replaceTeacher()` lifecycle service after conflict/workload checks. Clear-teacher path (teacherId absent) preserves existing direct path.
- `POST /sessions/bulk-cancel`: now routes through `cancelSession()` per session (sequential loop). Reason required (≥ 5 chars, 400 if absent). Returns `{ cancelled, errors }` instead of bare count.

**`server/src/__tests__/unit/scheduleLifecycleService.test.ts`**:
- Extended with 48 new unit tests covering PR 3 flows:
  - `EVENTS_REQUIRING_REASON` — 3-event enforcement, whitespace-only reason, boundary checks
  - `changeSessionStatus` reason guard — 400 for SESSION_CANCELLED without reason
  - `invalidateSession` — reason guard, LOCKED/SUPERADMIN path, normal path, ADMIN cannot do LOCKED
  - `replaceTeacher` — reason guard, 404, 422 editability, 404 cross-tenant, 409 salary safety, success path (DB + audit + notify + socket), versionGuard passthrough

**`server/src/__tests__/unit/scheduleChr_attendancePolicy.test.ts`**: new (22 tests)
- Documents 3-source attendance policy contradiction

**`server/src/__tests__/integration/scheduleChr_bulkCancelBypass.test.ts`**: new (8 tests)
- Updated to reflect PR 3 fix. Direct-updateMany tests preserved as historical regression docs.

**`server/src/__tests__/integration/scheduleChr_teacherReplacementBypass.test.ts`**: new (11 tests)
- Updated to reflect PR 3 fix. DB-level tests preserved; salary gap (section 3) still TODO PR 5.

**`server/src/__tests__/integration/scheduleChr_*.test.ts`** (6 other files): new
- `scheduleChr_deleteFinancialImpact` — archive + financial data edge cases
- `scheduleChr_freezeBillingOnly` — freeze as billing-only (gaps for PR 6)
- `scheduleChr_makeupCRUD` — makeup as CRUD (gaps for PR 6)
- `scheduleChr_parentVisibility` — parent/student projection gaps (PR 7)
- `scheduleChr_reconciliationGaps` — R1–R6 invariant checks (PR 8)
- `scheduleChr_rescheduleCRUD` — reschedule as CRUD (PR 4)

#### Invariants preserved

- All characterisation tests (from PR 1) remain green
- Financial behaviour unchanged: credit deduction only at attendance submit
- Teacher replacement on clear-teacher path (teacherId absent) uses direct path — no breaking change
- Bulk-cancel now requires `reason` (≥ 5 chars) — **breaking change to API contract** (see §12 migration)
- Salary gap (teacher replacement after payment) deferred to PR 5 as documented

#### Bug fixed

`assertSessionEditable` previously used block-list logic (`!LOCKED && !CANCELLED`), allowing COMPLETED sessions to have their teacher replaced. Fixed to use allow-list (`UPCOMING || IN_PROGRESS`) — matches business intent and all test expectations.

### Test count after PR 3

| Suite | Count |
|-------|-------|
| Unit (4 files) | 107 |
| Integration (characterisation, 8 files) | ~130 |
| **Total** | **~237** |

---

## 14. PR 4 Implementation — Atomic Reschedule Flow (2026-05-30)

### What was built

PR 4 makes `SESSION_RESCHEDULED` a first-class lifecycle event for time/room changes on the same calendar date. All characterisation tests remain green.

**Note:** Moving a session to a **different date** still requires cancel + createMakeupSession. Atomic date-change is deferred to PR 6.

#### Modified files

**`server/src/services/scheduleLifecycleTypes.ts`**:
- `EVENTS_REQUIRING_REASON` — `SESSION_RESCHEDULED` added (4 events total).

**`server/src/services/scheduleLifecycleService.ts`**:
- `rescheduleSession()` — **fully implemented** (replaced 501 stub):
  - Reason guard: ≥ 5 chars (400 if absent/short)
  - Tenant isolation: session must belong to school
  - Editability guard: `assertSessionEditable()` — 422 for COMPLETED/LOCKED/CANCELLED/INVALIDATED
  - Conflict validation: `validateSingleSessionOverride()` — teacher + cabinet + group
  - Capacity warning: 400 if not overridden (`overrideCabinetConflict`)
  - **Atomic $transaction**: `lessonSession.update` + `logScheduleAction('RESCHEDULE')` in one TX
  - Audit before/after: `{ startTime, endTime, cabinetId, teacherId }` snapshot
  - Socket: `session:status-changed` (triggers schedule refresh) — outside TX

**`server/src/routes/schedule.ts`**:
- Added `PATCH /session/:id/reschedule` — new endpoint accepting `{ startTime, endTime, cabinetId, reason, version, overrideTeacherConflict, overrideCabinetConflict }`
- `PATCH /session/:id/details` preserved for backward compatibility (cabinet-only path)

**`server/src/__tests__/unit/scheduleLifecycleService.test.ts`**:
- `EVENTS_REQUIRING_REASON` test updated: size 3 → 4 (SESSION_RESCHEDULED added)
- Added 16 new tests for `rescheduleSession()` covering: reason guard, 404, editability (4 statuses), teacher conflict 409, cabinet warning 400/override, success path (TX + audit + socket), IN_PROGRESS editable, versionGuard, no notifyMany
- `rescheduleSession throws 501` stub test removed

**`server/src/__tests__/integration/scheduleChr_rescheduleCRUD.test.ts`**:
- Header and TODO comments updated to reflect PR 4 partial fix
- Time/room change gap: FIXED via new route
- Date change gap: still TODO PR 6

#### Invariants preserved

- `PATCH /session/:id/details` (cabinet/time route) unchanged — no API contract break
- No financial side effects: `notifyMany` not called, no credit/salary changes
- Atomic: either DB update + audit both commit or neither (Prisma $transaction)
- Version guard passthrough: P2025 → 409 STALE_DATA

### Test count after PR 4

| Suite | Count |
|-------|-------|
| Unit — scheduleLifecycleService.test.ts | 102 |
| Unit — scheduleChr_attendancePolicy.test.ts | 22 |
| Integration (characterisation) | ~130 |
| **Total unit** | **124** |

---

## 15. Frontend Compat Fix (2026-05-30)

PR 3 added reason enforcement for `SESSION_CANCELLED` and `TEACHER_REPLACED`. Frontend components were not passing `reason`. Fixed in commit `3f736bec`:

**`CancelDialog.tsx`** (schedule + schedule2):
- Two-step modal flow: choose cancel type → enter reason (≥ 5 chars) → confirm
- `onOneTime: (reason: string) => void` (breaking prop change, both callers updated)

**`GroupRow.tsx`** + **`schedule/EditSessionPanel.tsx`**:
- `handleCancelOneTime(reason: string)` passes reason to `PATCH /session/:id/status`

**`schedule2/EditSessionPanel.tsx`**:
- `cancelReason` state: textarea shown when status is CANCELLED; validated before save
- `teacherReason` state: textarea shown when substitute teacher differs from initial
- Pre-save validation blocks network call if reason < 5 chars

---

## 16. PR 5 Implementation — Lifecycle Notifications + Salary Safety (2026-05-30)

### What was built

PR 5 adds a centralized notification pipeline and salary safety guards. No DB migrations, no makeup/freeze, no parent projection.

#### New file: `scheduleLifecycleNotificationService.ts`

Typed best-effort dispatch functions (callers wrap in try-catch):

| Function | Recipients |
|----------|------------|
| `dispatchSessionCancelledNotifications()` | Students: LESSON_CANCELLED + Teacher: LESSON_CANCELLED_FOR_TEACHER |
| `dispatchRescheduleNotifications()` | Students + Teacher: SESSION_RESCHEDULED / SESSION_RESCHEDULED_FOR_TEACHER (old+new slot in data) |
| `dispatchTeacherReplacedNotifications()` | New teacher: SUBSTITUTE_TEACHER_ASSIGNED (was TODO placeholder in PR 3) |
| `dispatchSessionInvalidatedNotifications()` | School admins: SESSION_INVALIDATED_ALERT (internal only) |

#### New export in `scheduleLifecycleService.ts`: `assertNoSalaryLockedSessionMutation()`

Throws 409 `SALARY_LOCKED_SESSION` if `TeacherPaymentLesson` exists for the session. Wired into: `replaceTeacher()`, `rescheduleSession()`, `invalidateSession()`. Correction flow (reverting salary attribution) is TODO PR 6.

#### Side effects / notifications wired in PR 5

- `changeSessionStatus()` CANCELLED path: refactored to `dispatchSessionCancelledNotifications()` (teacher now notified). Notification failure isolated with try-catch.
- `replaceTeacher()`: inline salary check → `assertNoSalaryLockedSessionMutation()`; teacher notification wired (was TODO).
- `rescheduleSession()`: salary guard added + `dispatchRescheduleNotifications()` added post-transaction.
- `invalidateSession()`: salary guard added + `dispatchSessionInvalidatedNotifications()` added (both LOCKED+SUPERADMIN and normal path).

#### `LIFECYCLE_SIDE_EFFECTS` updated

`SESSION_CANCELLED.notifyTeacher`: `false → true`

#### Error message: `TEACHER_PAYMENT_EXISTS` → `SALARY_LOCKED_SESSION`

Unified across all salary-sensitive events. Route catches by `httpStatus: 409`.

### Test count after PR 5

| Suite | Count |
|-------|-------|
| scheduleLifecycleService.test.ts | 133 |
| scheduleLifecycleNotification.test.ts | 26 (new) |
| scheduleChr_attendancePolicy.test.ts | 20 |

### Remaining deferred (PR 5)

~~Makeup/freeze lifecycle, salary correction flow (PR 6)~~ → implemented in PR 6.  
Parent visibility projection (PR 7), reconciliation report (PR 8), date-change atomic reschedule (still deferred).

---

## 17. PR 6 Implementation — Makeup Lifecycle + Freeze Policy Events (2026-05-30)

### What was built

PR 6 promotes makeup session creation and freeze operations from bare CRUD into first-class lifecycle events with audit, notifications, and observable lifecycle tracking. No DB migrations, no enum changes.

#### Makeup Lifecycle

**`createMakeupSession()` — fully implemented** (was 501 stub):

Guards:
- `reason` required (≥ 5 chars) — `MAKEUP_CREATED` added to `EVENTS_REQUIRING_REASON`
- `SESSION_NOT_FOUND` (404) if session absent or cross-tenant
- `MAKEUP_LOCKED_SESSION` (409) if original is LOCKED
- `MAKEUP_INVALIDATED_SESSION` (409) if original is INVALIDATED
- `MAKEUP_REQUIRES_CANCELLED_SESSION` (400) for any other non-CANCELLED status
- `MAKEUP_ALREADY_EXISTS` (409) if an active (non-CANCELLED) makeup already exists — checked inside `$transaction` (concurrency-safe)

Side effects:
- `$transaction`: create `LessonSession` (isMakeup=true, makeupForSessionId=originalId) + `snapshotNewSessions` + `logScheduleAction('MAKEUP_CREATED')`
- Notifications (best-effort): `dispatchMakeupCreatedNotifications()` → students: `MAKEUP_SCHEDULED`
- Socket: `session:status-changed`

**Route update** — `POST /session/:id/makeup` now delegates to `createMakeupSession()`. Paused group check stays in route (business pre-condition). `reason` field accepted from request body.

#### Freeze Policy Events

**`applyFreeze()` — fully implemented** (was 501 stub):

- Tenant guard: `studentProfile.user.schoolId` must match
- `$transaction`: `StudentProfile.isFrozen = true, frozenAt = frozenAt ?? now()` + `logScheduleAction('FREEZE_APPLIED', entityType='student')`
- Notification (best-effort): `dispatchFreezeAppliedNotifications()` → student: `ACCOUNT_FROZEN`
- Financial logic **unchanged**: `attendanceService` still applies `FREEZE_SKIP` via `isFrozen`/`frozenAt` — no credit changes in `applyFreeze`

**`reverseFreeze()` — fully implemented** (was 501 stub):

- `$transaction`: `isFrozen = false, frozenAt = null` + `logScheduleAction('FREEZE_REVERSED', entityType='student')`
- Notification (best-effort): `dispatchFreezeReversedNotifications()` → student: `ACCOUNT_UNFROZEN`

**Routes wired**:
- `students.ts PATCH /:id` — `isFrozen` field now calls `applyFreeze()`/`reverseFreeze()` before remaining profileData transaction
- `users.ts PATCH /:id/freeze` — fully delegates to lifecycle service (also fixes missing `frozenAt` update that the old route had)

#### New notification dispatchers (`scheduleLifecycleNotificationService.ts`)

| Function | Recipient | Type |
|----------|-----------|------|
| `dispatchMakeupCreatedNotifications()` | Students | `MAKEUP_SCHEDULED` |
| `dispatchFreezeAppliedNotifications()` | Student | `ACCOUNT_FROZEN` |
| `dispatchFreezeReversedNotifications()` | Student | `ACCOUNT_UNFROZEN` |

#### `lib/auditLog.ts` — EntityType extended

`EntityType` now includes `'student'` (was `'session' | 'block' | 'group'`). Required for `FREEZE_APPLIED`/`FREEZE_REVERSED` audit entries.

#### `EVENTS_REQUIRING_REASON` updated

`MAKEUP_CREATED` added — size 4 → 5.

### Test count after PR 6

| Suite | Count |
|-------|-------|
| scheduleLifecycleService.test.ts | 127 (+20 new tests) |
| scheduleLifecycleNotification.test.ts | 26 (unchanged) |
| scheduleChr_attendancePolicy.test.ts | 20 (unchanged) |
| characterization suites | unchanged |

### Remaining deferred

- Reconciliation engine (PR 8)
- Salary correction flow (deferred from PR 5/6)
- Date-change atomic reschedule (cancel + createMakeupSession is the correct flow; PR 6 completes the lifecycle but date-change UX improvements are TODO)
- `StudentFreeze` history model (PR 6 adds lifecycle events but not a full history table; single frozenAt limitation remains)

---

## 18. PR 7 Implementation — Parent Visibility Projection (2026-05-30)

### What was built

PR 7 introduces a dedicated projection layer that transforms internal lifecycle states into a safe, parent/student-facing representation. No DB migrations, no enum changes, no reconciliation logic.

### Problem solved

Before PR 7, the parent portal endpoints returned raw `LessonSession` data including `INVALIDATED` sessions (which must never be shown to students), no `sessionType` distinction (REGULAR vs MAKEUP), and no computed `isSubstitute` or `effectiveTeacher` fields. Students/parents had to interpret raw DB fields themselves, which is fragile and leaks internal system state.

### Parent visibility rules (RFC §9)

| Session State | Portal Label | Visible? | Notes |
|--------------|-------------|----------|-------|
| `UPCOMING` | "Upcoming" | Yes | Normal upcoming class |
| `IN_PROGRESS` | "In progress" | Yes | Class is active right now |
| `COMPLETED` | "Completed" | Yes | Class took place |
| `LOCKED` | "Completed" | Yes | Lock is internal; student sees "Completed" |
| `CANCELLED` | "Cancelled" | Yes | "Class cancelled by school" |
| `INVALIDATED` | Hidden | **No** | Internal data integrity state — filtered out |
| `isMakeup=true`, upcoming | "Makeup class" | Yes | Makeup session explicitly labeled |
| `isMakeup=true`, completed | "Completed" | Yes | Makeup delivered — shown as regular completed |
| Teacher replaced | Attendance note | Yes | `isSubstitute=true`, `effectiveTeacher` = substitute name |

**Hidden states:** Only `INVALIDATED` is hidden. All other statuses are parent-visible. The lock state is translated to "Completed" because locking is an internal financial/salary accounting operation with no student-facing meaning.

### New file: `server/src/services/sessionProjectionService.ts`

Pure TypeScript — no DB calls. Accepts pre-fetched session data and returns a sanitized DTO.

**Exported types:**
- `RawSessionForProjection` — input shape (fields the query must include)
- `ParentSessionProjection` — parent-safe output DTO
- `SessionType` — `'REGULAR' | 'MAKEUP'`

**Exported functions:**

| Function | Description |
|---------|-------------|
| `isVisibleToParent(status)` | Returns `false` only for `INVALIDATED` |
| `projectSessionForParent(session)` | Maps one session to `ParentSessionProjection`. Callers must check `isVisible` or use the batch function. |
| `projectSessionsForParent(sessions)` | Maps and filters — removes `INVALIDATED` automatically. Use in route handlers. |

**`ParentSessionProjection` DTO fields:**

```typescript
{
  sessionId: number
  status: SessionStatus            // raw DB status (LOCKED for internal use)
  isVisible: boolean               // false only for INVALIDATED
  sessionType: 'REGULAR' | 'MAKEUP'
  title: string                    // "GRAMMAR · Beginners A1"
  portalLabel: string              // "Upcoming" | "In progress" | "Completed" | "Cancelled" | "Makeup class"
  date: Date
  startTime: string | null
  endTime: string | null
  isCancelled: boolean
  isMakeup: boolean
  originalSessionId: number | null // for makeup sessions — links to cancelled original
  effectiveTeacher: { firstName, lastName } | null
  isSubstitute: boolean            // true when teacher was replaced via lifecycle service
  parentVisibleReason: string | null
}
```

**Teacher resolution logic:**
- If `isManualTeacher=true` (substitute assigned): `effectiveTeacher` = substitute's name, `isSubstitute=true`
- Otherwise: `effectiveTeacher` = block's primary teacher name, `isSubstitute=false`

### Route integration: `parent.ts`

`GET /parent/me/children/:studentProfileId/schedule`:

- **Query extended:** Added `isMakeup`, `makeupForSessionId`, `teacherId`, `teacherIdSnap`, `isManualTeacher`, `lessonBlock.teacher` (for original block teacher name) to the Prisma select.
- **DB-level filter:** Added `status: { not: 'INVALIDATED' }` to the `findMany` where clause — INVALIDATED sessions are excluded at query time, not post-fetch.
- **Response:** `projectSessionsForParent(sessions)` — returns `ParentSessionProjection[]` instead of raw session rows.

**No breaking changes** to existing admin/teacher API routes — only the parent schedule endpoint uses the projection.

### Test compatibility fixes (PR 6 compat)

Two integration tests written before PR 6 needed updating:

1. **`groupCompletionSemantics.test.ts`** — Makeup creation calls now include `reason` (PR 6 added `MAKEUP_CREATED` to `EVENTS_REQUIRING_REASON`). Additionally, the test for "makeup cannot be created for INVALIDATED session" now expects 409 `MAKEUP_INVALIDATED_SESSION` (the lifecycle service correctly distinguishes LOCKED/INVALIDATED as 409 vs other non-CANCELLED states as 400).

2. **`scheduleChr_freezeBillingOnly.test.ts`** — The "after deadline" test had a timing bug where `setUTCHours(12, 0, 0, 0)` on a relative date could add hours and push the session > 24h after `frozenAt`, causing the freeze to apply (credit skip). Fixed by removing `setUTCHours` so the actual diff is predictable. Test renamed and comment updated to document the correct characterization.

### New unit tests: `src/__tests__/unit/sessionProjectionService.test.ts`

40 tests covering all 8 visibility rules and the DTO contract:

| Test group | Tests |
|-----------|-------|
| `isVisibleToParent` | 6 (one per status) |
| `SESSION_CANCELLED` visible | 4 |
| `SESSION_INVALIDATED` hidden | 2 |
| `SESSION_LOCKED` → "Completed" | 3 |
| `SESSION_COMPLETED` visible | 2 |
| `TEACHER_REPLACED` visible | 4 |
| `MAKEUP_CREATED` visible | 5 |
| `MAKEUP_COMPLETED` visible | 1 |
| `effectiveTeacher` resolution | 3 |
| DTO shape | 6 |
| `projectSessionsForParent` batch | 4 |

### Test count after PR 7

| Suite | Count |
|-------|-------|
| sessionProjectionService.test.ts | 40 (new) |
| groupCompletionSemantics compat fix | 13 (updated) |
| scheduleChr_freezeBillingOnly compat fix | 6 (updated) |

### Remaining deferred

- Salary correction flow
- Date-change atomic reschedule UX
- `StudentFreeze` history model
- Reconciliation cron (daily automated run, PR 9+)

---

## 19. PR 8 Implementation — Reconciliation Engine (2026-05-30)

### What was built

PR 8 introduces a lifecycle reconciliation service that runs seven invariant checks across attendance, credits, salary, and makeup sessions, and exposes the results via a new read-only admin endpoint. No automatic repair — the service detects and reports only.

### New file: `server/src/services/reconciliationService.ts`

**Types:**

```typescript
type ReconciliationSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
type ReconciliationEntityType = 'session' | 'attendance' | 'credit_log' | 'teacher_payment' | 'makeup';

interface ReconciliationIssue {
  issueType: string;           // machine-readable invariant identifier
  severity: ReconciliationSeverity;
  schoolId: number;
  entityType: ReconciliationEntityType;
  entityId: number;            // PK of the violating record
  description: string;
  detectedAt: Date;
  metadata?: Record<string, unknown>;
}

interface ReconciliationReport {
  schoolId: number;
  checkedAt: Date;
  summary: string;
  issues: ReconciliationIssue[];
  countsBySeverity: Record<ReconciliationSeverity, number>;
  countsByType: Record<string, number>;
}
```

**Exported check functions (one per RFC §10 invariant):**

| Function | Issue Type | Severity | Invariant |
|---------|-----------|---------|-----------|
| `findCompletedWithoutAttendance()` | `R1_COMPLETED_WITHOUT_ATTENDANCE` | WARNING | COMPLETED/LOCKED session with enrolled students but no attendance records |
| `findCancelledWithCreditDeduction()` | `R2_CANCELLED_SESSION_CREDIT_DEDUCTION` | CRITICAL | LessonCreditLog deduction (amount < 0) linked to CANCELLED or INVALIDATED session |
| `findInvalidatedWithTeacherPayment()` | `R3_INVALIDATED_SESSION_TEACHER_PAYMENT` | CRITICAL | TeacherPaymentLesson linked to INVALIDATED session |
| `findMakeupWithoutOriginal()` | `R4_MAKEUP_WITHOUT_ORIGINAL_LINK` | ERROR | isMakeup=true with null makeupForSessionId |
| `findDuplicateMakeupLinks()` | `R5_DUPLICATE_MAKEUP_LINK` | ERROR | More than one active (non-CANCELLED) makeup for the same original session |
| `findSalaryWithoutSession()` | `R6_SALARY_ON_NON_PAYABLE_SESSION` | CRITICAL | TeacherPaymentLesson linked to CANCELLED or INVALIDATED session |
| `findAttendanceWithoutCreditLog()` | `R7_ATTENDANCE_WITHOUT_CREDIT_LOG` | CRITICAL | Attendance.creditDeducted=true with no matching LessonCreditLog.attendanceId |
| `runFullReconciliation()` | — | — | Runs all 7 checks in parallel, returns ReconciliationReport |

**Severity guide:**
- `CRITICAL` — financial or salary data is corrupted; requires immediate correction
- `ERROR` — lifecycle invariant violated; data inconsistent but not yet financial
- `WARNING` — potential gap; may be intentional (no-show policy, etc.)
- `INFO` — informational (not yet used)

### Route integration: `admin.ts`

New endpoint `GET /api/v1/admin/reconciliation`:
- Auth: OWNER-only (`requirePermission('users:manage')`)
- Read-only — no mutations
- Returns `{ success: true, data: ReconciliationReport }`
- Logs: total issues, criticalCount, errorCount, warningCount
- Coexists with existing `GET /admin/consistency-check` (which uses `consistencyCheckService.ts` with 15 infrastructure checks)

### Relation to existing `consistencyCheckService.ts`

`consistencyCheckService.ts` (15 checks) covers broader infrastructure invariants:
teacher double-booking, zombie blocks, invoice math, balance reconciliation, etc.
It uses the simpler `Violation { check, count, ids, severity }` shape.

`reconciliationService.ts` (7 checks) focuses on **lifecycle-specific** invariants
from RFC §10 with richer per-entity `ReconciliationIssue` format. The two services
coexist and serve different purposes. There is intentional overlap on checks R2 (credit
on cancelled), R6 (salary on cancelled), and R7 (creditDeducted without log) — this
redundancy is acceptable as the new service provides actionable entity IDs and metadata.

### Tests

**`src/__tests__/integration/reconciliation.test.ts`** — 23 tests:

| Test group | Tests |
|-----------|-------|
| R1: COMPLETED without attendance | 4 |
| R2: Cancelled with credit deduction | 3 |
| R3: Invalidated with teacher payment | 2 |
| R4: Makeup without original link | 2 |
| R5: Duplicate makeup links | 3 |
| R6: Salary on non-payable session | 2 |
| R7: Attendance without credit log | 3 |
| runFullReconciliation report | 4 |

### Remaining deferred

- Salary correction flow (PR 9)
- Date-change atomic reschedule UX
- `StudentFreeze` history model
- Daily reconciliation cron (auto-run + alerting via webhooks.ts)

---

---

## 20. PR 9 Implementation — Salary Correction Flow (2026-05-30)

### Context

PR 5 introduced `assertNoSalaryLockedSessionMutation()` which blocks lifecycle mutations
(TEACHER_REPLACED, SESSION_INVALIDATED, SESSION_RESCHEDULED) when a TeacherPaymentLesson
already exists for the session. This safety guard is correct. PR 9 adds the controlled
correction flow for OWNER/SUPERADMIN when an error is discovered after salary has been paid.

### Core principle: financial history is immutable

TeacherPayment and TeacherPaymentLesson records are NEVER deleted by the correction service.
The paid amounts remain in the TeacherPayment record. Corrections are additive: they create
ManualLessonEntry records that adjust the lesson count used in future salary calculations.
This preserves a complete, auditable financial trail.

### Correction mechanism: ManualLessonEntry with parseable labels

Corrections use existing models — no migrations. When a correction is applied, the service
creates ManualLessonEntry (ADD or REMOVE) records with machine-parseable labels:

```
SALARY_CORRECTION:session:{sessionId}:{suffix}
```

- `REMOVE` for old teacher (reduces their lesson count for the period)
- `ADD` for new teacher (increases their lesson count for the period)

The `calculateNet()` function in salary.ts automatically picks up these entries in its
`manualDelta` calculation. Reconciliation checks use `hasCorrectionForSession()` to detect
whether a correction has been applied.

### Correction scenarios

**A. Wrong teacher (TEACHER_REPLACEMENT):**
1. Session was paid to Teacher A
2. OWNER identifies the error
3. Calls `POST /salary/corrections` with `correctionType: TEACHER_REPLACEMENT`
4. Service creates: ManualLessonEntry REMOVE for Teacher A + ADD for Teacher B
5. TeacherPayment/TeacherPaymentLesson unchanged (financial history preserved)
6. Next salary calculation reflects the correction

**B. Invalidated paid session (INVALIDATED_SESSION):**
1. Session was paid, then later marked INVALIDATED (data integrity issue)
2. OWNER calls `POST /salary/corrections` with `correctionType: INVALIDATED_SESSION, paymentLessonId`
3. Service creates: ManualLessonEntry REMOVE for the teacher in the payment period
4. TeacherPayment/TeacherPaymentLesson unchanged (immutable)
5. Reconciliation R3/R6 severity downgraded to WARNING (correction recorded)

### Permission model

| Role | Can correct? |
|------|-------------|
| SUPERADMIN | Yes |
| OWNER | Yes (`salary:pay` permission) |
| ADMIN | No (403) |
| TEACHER | No (403) |
| STUDENT | No (403) |

Reason ≥ 5 characters is required for all corrections.

### New files

**`server/src/services/salaryCorrectionService.ts`**

| Export | Description |
|--------|-------------|
| `validateCorrectionAllowed(actor, reason)` | Guards: OWNER/SUPERADMIN + reason ≥ 5 chars. Throws 403/400. |
| `createTeacherCorrection(params)` | Scenario A: REMOVE for old teacher + ADD for new teacher in one transaction. |
| `reverseTeacherPaymentLesson(params)` | Scenario B: REMOVE for the paid teacher. Session must be INVALIDATED. |
| `createManualSalaryAdjustment(params)` | Thin wrapper for SalaryAdjustment (FINE/ADVANCE/BONUS) with role validation. |
| `buildCorrectionAuditPayload(params)` | Builds structured audit payload for logScheduleAction(). |
| `hasCorrectionForSession(sessionId, staffProfileId, period, client)` | Returns true if a correction ManualLessonEntry exists. Used by reconciliationService. |
| `isCorrectionLabelForSession(label, sessionId)` | Label parser: returns true if label is a correction for the given session. |
| `CORRECTION_LABEL_PREFIX` | `'SALARY_CORRECTION:session:'` — canonical prefix for correction labels. |

### New route

**`POST /api/v1/salary/corrections`** (added to salary.ts)

- Auth: OWNER-only (`salary:pay` permission)
- Idempotency-Key: required
- Request body:

```json
{
  "correctionType": "TEACHER_REPLACEMENT | INVALIDATED_SESSION",
  "reason": "string (≥5 chars)",
  // for TEACHER_REPLACEMENT:
  "sessionId": number,
  "oldStaffProfileId": number,
  "newStaffProfileId": number,
  // for INVALIDATED_SESSION:
  "paymentLessonId": number
}
```

- Response: `{ success: true, data: CorrectionResult }` with `correctionType`, `sessionId`, `period`, `entries[]`

### Reconciliation integration

`reconciliationService.ts` updated to downgrade severity for R3 and R6 when a correction exists:

| State | R3/R6 Severity |
|-------|---------------|
| INVALIDATED session, no correction | CRITICAL |
| INVALIDATED session, correction applied | WARNING (`corrected: true` in metadata) |
| CANCELLED session with salary | always CRITICAL (no correction scenario defined) |

`findInvalidatedWithTeacherPayment()` and `findSalaryWithoutSession()` both call
`hasCorrectionForSession()` for INVALIDATED sessions. The `runFullReconciliation()` report
reflects the downgraded severity automatically.

### Idempotency

`POST /salary/corrections` requires `Idempotency-Key` (returns 400 if absent).
Same key + same payload → replay (idempotent, one correction created).
Same key + different payload → 409 (conflict).

### Tests

**`src/__tests__/integration/salaryCorrectionFlow.test.ts`** — 13 tests:

| # | Description |
|---|-------------|
| 1 | ADMIN cannot create salary correction (403) |
| 2 | OWNER can create correction with valid reason (200) |
| 3 | Missing Idempotency-Key returns 400 |
| 4 | Same key replay creates only one correction entry |
| 5 | Same key + different payload returns 409 |
| 6 | TEACHER_REPLACEMENT creates REMOVE + ADD entries |
| 7 | INVALIDATED_SESSION creates REMOVE ManualLessonEntry |
| 8 | Audit log entry written after correction |
| 9 | Reconciliation R3 downgraded to WARNING after correction |
| 10 | Reconciliation R3 remains CRITICAL without correction |
| 11 | TeacherPaymentLesson preserved after correction |
| 12 | Cross-tenant correction rejected (404) |
| 13 | Full report includes corrected session as WARNING |

### Remaining limitations

- Corrections do not retroactively adjust TeacherPayment.amount (the paid amount stays).
  Only the lesson count for future reporting is corrected. Actual money movement requires
  a new payment or manual SalaryAdjustment.
- CANCELLED sessions with salary (R6 CANCELLED) have no correction scenario — those require
  investigation and manual intervention.
- No self-service correction UI — only via API endpoint.
- Date-change atomic reschedule UX still deferred.

---

*Last Updated: 2026-07-05 (status header DRAFT → IMPLEMENTED; PR 1–9 content below is unchanged historical record)*  
*Branch: feature/schedule-lifecycle*  
*Next step: feature branch complete — ready for PR to dev.*
