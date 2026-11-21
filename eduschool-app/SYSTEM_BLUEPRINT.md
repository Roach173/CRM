# SYSTEM BLUEPRINT — Shamdan ERP

> **Purpose:** Cross-domain architectural reference. Single entry point for understanding how all 4 domains interact, what the invariants are, and where the reliability mechanisms live.
> Does NOT duplicate deeper docs — it links to them. Read this first when touching code that crosses domain boundaries.

*Last Updated: 2026-05-31*

---

## How To Use This Document

Start here when you need the product and system picture. This file explains how modules, state, and reliability boundaries connect. For AI workflow and development rules, see `../CLAUDE.md`; for deep implementation detail, use the references below.

## Product Modules Overview

| Module | What it owns | Details |
|--------|--------------|---------|
| Auth / RBAC | JWT auth, roles, permissions, tenant context | `ARCHITECTURE.md`, `ARCHITECTURAL_DECISIONS.md` |
| Schedule | groups, lesson blocks, sessions, room/teacher/time changes | `AI_SCHEDULE_HANDOFF.md`, `SCHEDULE_UI_CONTRACT.md`, `SCHEDULE_LIFECYCLE_RFC.md` |
| Attendance | submitted attendance, frozen attendance handling, credit deduction trigger | `AI_SCHEDULE_HANDOFF.md`, `DATABASE_CONSTRAINTS.md` |
| Finance / credits | credit ledger, invoices, payments, refunds, receivables | `API_CONTRACTS.md`, `DATABASE_CONSTRAINTS.md` |
| Freeze | `StudentFreeze` policy and attendance billing exemptions | `DATABASE_CONSTRAINTS.md`, `FRONTEND_STATE_RULES.md` |
| Salary | teacher attribution, payments, correction flow | `SCHEDULE_LIFECYCLE_RFC.md`, `ARCHITECTURAL_DECISIONS.md` |
| Operations | deployment, health, metrics, recovery | `DEPLOYMENT.md`, `OPERATIONS.md` |

## Backend / Frontend Overview

- **Backend:** Express + Prisma service layer with route guards, audit logs, transactions, and idempotency around financial and schedule operations.
- **Frontend:** React + Vite application with schedule UI under `client/src/components/schedule`, shared state hooks, and API calls through Axios.
- **Database:** PostgreSQL with Prisma migrations and constraints; tenant data is scoped by `schoolId`.

## Current Critical State

- `AttendanceStatus` includes `PRESENT | ABSENT | LATE | FROZEN`.
- Credits are deducted only through Submit Attendance / attendance endpoints.
- `StudentFreeze` is the freeze source of truth.
- `StudentProfile.isFrozen` and `StudentProfile.frozenAt` are legacy cache fields only.
- Normal cancel flow does not auto-refund credits.
- Sessions with `creditDeducted=true` cannot be normally cancelled.

## Where To Look Next

| Need | Read |
|------|------|
| Workflow and PR rules | `../CLAUDE.md` |
| Architecture decisions | `ARCHITECTURAL_DECISIONS.md`, `ARCHITECTURE.md` |
| Schedule lifecycle and UI contracts | `AI_SCHEDULE_HANDOFF.md`, `SCHEDULE_UI_CONTRACT.md`, `SCHEDULE_LIFECYCLE_RFC.md` |
| API contracts and database invariants | `API_CONTRACTS.md`, `DATABASE_CONSTRAINTS.md` |
| Frontend state ownership | `FRONTEND_STATE_RULES.md` |
| Deployment, operations, testing | `DEPLOYMENT.md`, `OPERATIONS.md`, `TESTING_STRATEGY.md` |

---

## Architectural Philosophy

Six core principles — applied in priority order when decisions conflict:

1. **Historical correctness over mutable convenience** — completed records are immutable facts. Never update them in place.
2. **Financial auditability over aggressive cleanup** — credit logs, salary records, and rate snapshots must survive their parent deletions.
3. **Immutable snapshots over live joins** — `teacherIdSnap`, `cabinetIdSnap`, `priceSnapshot` exist so historical queries never depend on current state.
4. **Explicit state transitions over implicit behavior** — every status change goes through `canTransition()`. No direct `status` field writes.
5. **Temporal versioning over destructive updates** — policy changes and block splits create new versions; old versions are closed, not deleted.
6. **Operational simplicity over premature microservices** — one monolith per tenant, async jobs for non-critical paths only.

**Operational vs. historical entities:** UPCOMING and IN_PROGRESS sessions are *operational* — mutable, cron-managed, correctable. COMPLETED and LOCKED sessions are *historical records* — their snapshots are immutable facts, equivalent to a signed ledger entry.

---

## 1. Domain Map

Four domains, their core entities, and cross-domain data dependencies.

```
┌─────────────────────────────────────────────────────────────────────┐
│  SCHEDULE  (source of truth for all other domains)                  │
│  LessonBlock → LessonSession                                        │
│  syncSessionsForBlock() · ensureSingleSession() · extendAllBlocks() │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
          ┌────────────┼────────────┬──────────────────┐
          ▼            ▼            ▼                  ▼
   ┌─────────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────────┐
   │  BILLING    │ │ATTENDANCE│ │   SALARY   │ │     POLICY       │
   │             │ │          │ │            │ │                  │
   │ reads:      │ │ reads:   │ │ reads:     │ │ reads:           │
   │ session.date│ │ session  │ │ session.   │ │ school.          │
   │ session.    │ │ .status  │ │ status,    │ │ activeDays       │
   │ status,     │ │          │ │ teacherId  │ │                  │
   │ student.    │ │ writes:  │ │ Snap,      │ │ writes:          │
   │ isFrozen,   │ │ Attendance│ │ attendances│ │ LessonSession.   │
   │ freezeWindow│ │          │ │            │ │ status =         │
   │             │ │ triggers: │ │ writes:    │ │ INVALIDATED      │
   │ writes:     │ │ credit   │ │ TeacherPay-│ │                  │
   │ creditDeduct│ │ deduction│ │ ment,      │ │ SchoolSchedule-  │
   │ credits--   │ │          │ │ TeacherRate│ │ Policy versions  │
   │ CreditLog   │ │          │ │ Log        │ │                  │
   └─────────────┘ └──────────┘ └────────────┘ └──────────────────┘
```

**Cross-domain read rules:**
- BILLING reads `session.status` — if CANCELLED, no credit deduction
- SALARY reads `session.attendances.some()` — session counts only if ≥1 student attended
- POLICY writes `session.status = INVALIDATED` — schedule domain must handle this status everywhere
- BILLING and SALARY both protect sessions from INVALIDATED via `FINANCIAL_SESSIONS_PROTECTED`

---

## 1a. Cross-domain Event Flows

The system is architecturally event-driven. These flows cross domain boundaries and must be preserved end-to-end when touching any related code.

### Flow 1 — Attendance submitted
1. `markAttendance()` sets `Attendance.status`
2. Inside same `$transaction`: checks `creditDeducted` flag
3. If not deducted + session not CANCELLED + student not frozen → deduct credit, create `LessonCreditLog`, set `creditDeducted = true`
4. **Salary side-effect:** session now has `attendances.some() = true` → will count in next salary calculation

### Flow 2 — Policy `activeDays` shrinks
1. `PATCH /settings` saves new policy version (atomic 3-op transaction: close old → create new → audit log)
2. `invalidateSessionsForRemovedDays()` runs after commit (async, per block)
3. Each affected UPCOMING session: if no `Attendance` and no `TeacherPaymentLesson` → `status = INVALIDATED`
4. **Teacher calendars:** INVALIDATED filtered by `status: { not: 'INVALIDATED' }` filter
5. **Salary:** INVALIDATED excluded by `status NOT IN ['CANCELLED', 'INVALIDATED']` guard

### Flow 3 — Student exits group
1. `DELETE /groups/:id/students/:studentProfileId` runs in transaction
2. `GroupMembership.status = WITHDRAWN`, `leftAt = now()`
3. `sessionStudent.deleteMany` for all UPCOMING sessions (date ≥ now) of all group blocks
4. **Past sessions unaffected** — historical `SessionStudent` records are immutable billing facts

### Flow 4 — Block split (teacher or config change from a date)
1. `PUT /schedule/:id` with `applyFrom`
2. Old block: `endDate = applyFrom − 1`, UPCOMING sessions → INVALIDATED
3. New block (child): `parentBlockId = oldId`, sessions generated from `applyFrom` forward
4. **Salary:** COMPLETED sessions on old block retain original `teacherIdSnap`; new sessions use new teacher
5. **Grid display:** old block gets unique `mergeKey` including `closedDate` — prevents merging with new version

### Flow 5 — Credit manual correction
1. `POST /credits/add` with negative amount
2. Creates `LessonCreditLog` with reason `MANUAL_CORRECTION`
3. `creditDeducted` flag is NOT touched — this is additive, not a rollback
4. Attendance record is NOT modified — `PRESENT → ABSENT` edit does NOT auto-refund credits

---

## 2. Core Entity Hierarchy

```
School (tenant)
  ├── SchoolSchedulePolicy[]   (temporal versioning of activeDays/workStart/workEnd/slotDuration)
  ├── SchoolFinanceConfig       (pricePerLesson, freezeWindowHours, billing settings)
  ├── TimeSlot[]               (work-hour slots, auto-regenerated on settings change)
  ├── StudentGroup[]           (cohort — unit of student enrollment)
  │     ├── GroupMembership[]  (M2M bridge: studentProfileId + joinedAt + status)
  │     └── LessonBlock[]      (recurring class template: days, timeSlot, teacher, cabinet)
  │           └── LessonSession[]   (concrete lesson on a specific date)
  │                 ├── SessionStudent[]        (snapshot of group members at session creation)
  │                 │     └── Attendance        (PRESENT/ABSENT/LATE + creditDeducted flag)
  │                 │           └── LessonCreditLog (financial audit: amount + priceSnapshot)
  │                 ├── TeacherPaymentLesson    (link to a salary payment)
  │                 └── ScheduleActionLog[]     (immutable audit: who changed what)
  ├── StaffProfile[]
  │     ├── TeacherRateLog[]   (salary rate history with effectiveFrom timestamps)
  │     ├── TeacherPayment[]   (salary payment records with rateSnapshot; denormalized lessonsCount)
  │     └── SalaryAdjustment[] (fines, advances, bonuses per month)
  └── StudentProfile[]
        ├── credits (Int balance)
        ├── isFrozen / frozenAt
        └── LessonCreditLog[]
```

**Key identity rule:** `LessonBlock.teacherId` and `LessonSession.teacherId` store `StaffProfile.id`, NOT `User.id`. See [ARCHITECTURAL_DECISIONS.md ADR-001](ARCHITECTURAL_DECISIONS.md).

**LessonBlock temporal versioning:** `LessonBlock.parentBlockId` (self-FK, nullable) — forms a version chain when a block is split at `applyFrom`. See Section 3a.

---

## 2a. Membership Snapshot Rules

`SessionStudent` records are a point-in-time snapshot of who was enrolled in a group when a session was created.

### Creation
- Created by `snapshotNewSessions()` in `server/src/services/sessionService.ts`
- Triggered immediately after any session is created (`ensureSingleSession()` and `syncSessionsForBlock()`)
- Source: all `GroupMembership` records with `status: ACTIVE` and non-deleted `StudentProfile`
- Idempotent: `createMany({ skipDuplicates: true })`

### When student JOINS a group
- Endpoint: `POST /groups/:id/students` (and equivalent paths in `schedule.ts`, `waitlistService.ts`)
- Creates `SessionStudent` for **all UPCOMING sessions** (date ≥ now) across all blocks in the group
- Past/completed sessions: **no backfill** — student was not part of those lessons

### When student LEAVES a group
- Endpoint: `DELETE /groups/:id/students/:studentProfileId`
- Hard-deletes `SessionStudent` from **all UPCOMING sessions** (status: UPCOMING, date ≥ now) of all group blocks
- `GroupMembership.status = WITHDRAWN` set in the same transaction
- **Past sessions are untouched** — historical `SessionStudent` records are permanent billing records

### Invariant
A `SessionStudent` record for a COMPLETED or LOCKED session is a **permanent historical fact**. Must never be deleted, even if the student later leaves the group or is deactivated.

### Cascade behavior
| Event | Effect on SessionStudent |
|-------|--------------------------|
| `LessonSession` hard-deleted | Cascade-deleted (session gone, snapshot irrelevant) |
| `StudentProfile` soft-deleted (`deletedAt`) | Survives — hard FK, no cascade |
| `GroupMembership` → WITHDRAWN | Only UPCOMING records deleted (see above) |

---

## 3. Session State Machine

### Full graph (including INVALIDATED — added 2026-05-17)

```
                        ┌──────────────────────┐
                        │       UPCOMING        │◀──────────────────┐
                        └──────┬───────┬────────┘                   │
                               │       │                            │ [OWNER, ADMIN]
              [OWNER,ADMIN,    │       │ [OWNER, ADMIN]             │ restore from CANCELLED
               TEACHER]        │       ▼                            │
                               │   CANCELLED ───────────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │ IN_PROGRESS  │
                        └──┬───────┬───┘
         [OWNER,ADMIN,     │       │ [OWNER, ADMIN]
          TEACHER]         │       ▼
                           │   CANCELLED
                           │
                           ▼
                      ┌──────────┐    [OWNER]    ┌────────┐
                      │ COMPLETED │──────────────▶│ LOCKED │ (terminal — no exits)
                      └──────────┘               └────────┘

INVALIDATED ──────────────────────────────────────▶ UPCOMING
  [system-triggered by policy change]        [OWNER only; guard: no Attendance
                                              + no TeacherPaymentLesson]
```

### Transition table

| From | To | Roles | Extra conditions |
|------|----|-------|-----------------|
| UPCOMING | IN_PROGRESS | OWNER, ADMIN, TEACHER | — |
| UPCOMING | CANCELLED | OWNER, ADMIN | — |
| IN_PROGRESS | COMPLETED | OWNER, ADMIN, TEACHER | — |
| IN_PROGRESS | CANCELLED | OWNER, ADMIN | — |
| COMPLETED | LOCKED | OWNER | — |
| CANCELLED | UPCOMING | OWNER, ADMIN | — |
| INVALIDATED | UPCOMING | OWNER | No `Attendance` records + no `TeacherPaymentLesson` |
| ANY → INVALIDATED | — | System only | `invalidateSessionsForRemovedDays()` — NOT via state machine |

**Source:** [`server/src/lib/sessionStateMachine.ts`](server/src/lib/sessionStateMachine.ts)
**Guard code:** [`server/src/routes/schedule.ts`](server/src/routes/schedule.ts) — `PATCH /session/:id/status`

---

## 3a. LessonBlock Temporal Versioning (split)

When teacher or config changes **from a specific date**, the block is split rather than edited in-place. This preserves the history of COMPLETED sessions with their original teacher.

### Split flow — `PUT /schedule/:id` with `applyFrom`

```
[old block (endDate = applyFrom-1)]           [new block (parentBlockId = oldId, startDate = applyFrom)]
  COMPLETED sessions → unchanged              UPCOMING sessions → generated by syncSessionsForBlock()
  teacherIdSnap stays original                teacherIdSnap = new teacher
  UPCOMING sessions → INVALIDATED             (no historical sessions yet)
```

**Steps in `schedule.ts` PUT handler:**
1. Guard: `applyFrom > block.startDate` — prevents zombie block with `endDate < startDate`
2. `tx.lessonBlock.update(endDate = applyFrom - 1)` — close old block
3. `cleanupInvalidSessions(oldBlock)` — UPCOMING sessions of old block → INVALIDATED
4. `tx.lessonBlock.create(parentBlockId, startDate = applyFrom)` — new block
5. `syncSessionsForBlock(newBlock)` — generate sessions from applyFrom forward
6. If club block missing for same group: client `POST /schedule` with `startDate: applyFrom`

**Guard: no split at startDate.** If `applyFrom <= block.startDate`, do in-place update instead. Without this guard, `oldEndDate = startDate - 1 < startDate` — zombie blocks break salary and session queries.

### `cleanupInvalidSessions` behavior

- Targets ONLY `status: 'UPCOMING'` sessions
- COMPLETED sessions are **never** INVALIDATED — their `teacherIdSnap` is immutable history
- Financial protection: sessions with `Attendance` OR `TeacherPaymentLesson` are **skipped** (not invalidated)
- Non-financial UPCOMING sessions → `status = 'INVALIDATED'`

### Frontend mergeKey

`useSchedule.loadFromServer` groups server blocks into `SchedGroup` objects by `mergeKey`. Closed blocks (`endDate != null`) get a unique key that includes `closedDate` — prevents old and new version from merging into one cell.

### `parentBlockId` FK

```
LessonBlock
  parentBlockId Int?  → self-reference  onDelete: SET NULL
  index: LessonBlock_parentBlockId_idx
```

Migration: `20260519000000_add_parent_block_id`.

### Version chain example

```
Block A  startDate: Jan 1  │ endDate: May 31   │ teacher: Asel
         COMPLETED sessions Jan–May → immutable historical record
         │
         │ PUT /schedule/:id { applyFrom: "2026-06-01" }
         │ (old block closed: endDate = May 31, UPCOMING sessions → INVALIDATED)
         ▼
Block B  startDate: Jun 1  │ endDate: Aug 31   │ teacher: Marat  │ parentBlockId: A.id
         COMPLETED sessions Jun–Aug → immutable historical record
         │
         │ PUT /schedule/:id { applyFrom: "2026-09-10" }
         ▼
Block C  startDate: Sep 10 │ endDate: null     │ teacher: Asel   │ parentBlockId: B.id
         UPCOMING sessions → active, extended daily by cron
```

Salary attribution: each block's COMPLETED sessions are credited to the teacher whose `teacherIdSnap` was set at creation. The chain is navigable via `parentBlockId` for audit purposes.

---

### Session behaviors by status

| Status | Visible in grid | In teacher calendar | Accepts attendance | Counts toward salary | Eligible for rolling-window sync |
|--------|-----------------|--------------------|--------------------|----------------------|----------------------------------|
| UPCOMING | ✓ | ✓ | ✓ (submittable) | — (not yet completed) | ✓ |
| IN_PROGRESS | ✓ | ✓ | ✓ | — | ✓ |
| COMPLETED | ✓ | ✓ | ✓ (editorial edit) | ✓ | ✓ |
| CANCELLED | shown as cancelled | ✓ | ✗ | ✗ | ✗ |
| LOCKED | ✓ | ✓ | ✗ | ✓ | ✓ |
| INVALIDATED | ✗ | ✗ | ✗ | ✗ | ✗ |

> **"In teacher calendar"** = `GET /schedule/teacher-lesson-calendar-admin` endpoint. Filters: `status: { not: 'INVALIDATED' }`. CANCELLED sessions remain visible (grayed-out) as historic record.

---

## 4. Policy Versioning State Machine

School schedule policy = `{ activeDays, workStart, workEnd, slotDuration }`.

```
[current active version: effectiveTo = NULL]
             │
             │  PATCH /settings triggers change
             │  inside prisma.$transaction (atomic — 3 ops):
             ▼
   ① tx.schoolSchedulePolicy.updateMany(effectiveTo = now)   ← close old
   ② tx.schoolSchedulePolicy.create(effectiveFrom = now, effectiveTo = null) ← open new
   ③ tx.schoolPolicyLog.create(...)                           ← immutable audit
             │
             │  after transaction commits:
             ├── if activeDays SHRINKS:
             │     invalidateSessionsForRemovedDays(schoolId, removedDays)
             │       → for each UPCOMING session on removed days:
             │           if has Attendance OR TeacherPaymentLesson → SKIP (protected)
             │           else → status = INVALIDATED
             │
             └── if activeDays GROWS:
                   syncSessionsForBlock() for each block (fire-and-forget)
```

**Point-in-time query:**
```typescript
prisma.schoolSchedulePolicy.findFirst({
  where: {
    schoolId,
    effectiveFrom: { lte: date },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: date } }],
  },
  orderBy: { effectiveFrom: 'desc' },
})
```
**Fallback:** If no policy version found, reads current `school.activeDays/workStart/workEnd/slotDuration` columns.

**Source:** [`server/src/services/policyService.ts`](server/src/services/policyService.ts)

---

## 5. Data Classification

### Immutable fields (never change after creation)

| Field | Model | Set when |
|-------|-------|----------|
| `creditDeducted` | Attendance | At first credit deduction — one-way flag, never `false` again |
| `teacherIdSnap` | LessonSession | At session creation — snapshot of assigned teacher |
| `cabinetIdSnap` | LessonSession | At session creation |
| `startTimeSnap` / `endTimeSnap` | LessonSession | At session creation |
| `priceSnapshot` | LessonCreditLog | At credit deduction — `SchoolFinanceConfig.pricePerLesson` at that moment |
| `rateSnapshot` | TeacherPayment | At payment time — `TeacherRateLog` rate effective for that period |
| `amount` | TeacherPayment | At payment time |
| `effectiveFrom` | SchoolSchedulePolicy | At version creation |
| `changedAt` / all fields | SchoolPolicyLog | At policy change — immutable audit record |

### Snapshot-updated fields (UPCOMING only)

Snapshot fields on `LessonSession` are updated **only** when a session is in UPCOMING status and the parent block changes. COMPLETED/LOCKED sessions retain original snapshots as historical records.

| Field | Updated when |
|-------|-------------|
| `teacherIdSnap` | Block teacher changes, session is UPCOMING |
| `cabinetIdSnap` | Block cabinet changes, session is UPCOMING |
| `startTimeSnap` / `endTimeSnap` | TimeSlot changes, session is UPCOMING |

### Soft-delete models (`deletedAt: DateTime?`)

Always filter with `deletedAt: null` in queries:
- `User`, `StaffProfile`, `StudentProfile`, `StudentGroup`, `LessonBlock` (has field, but API uses hard delete), `LessonSession`

### Hard-delete

- `LessonBlock` — API route uses `prisma.lessonBlock.delete()` despite having `deletedAt` field. Guard added 2026-05-19: rejects deletion if any session has `TeacherPaymentLesson` links (409).
- `TeacherPaymentLesson` — deleted via `DELETE /pay/:paymentId` route (payment cancellation, CASCADE from TeacherPayment)

> **Long-term note (LessonBlock):** `LessonBlock` carries a `deletedAt` field but the API currently uses hard delete. This is sufficient while the system lacks cross-block analytics and teacher workload history. When audit trail, ML scheduling, or historical workload reporting are required, migrate to soft-delete with `deletedAt`-filtered queries. The payment guard (`teacherPaymentLesson.count > 0 → 409`) already prevents accidental deletion of financially linked blocks.

### LessonBlock version chain

`LessonBlock.parentBlockId Int?` — self-referential FK. Set on child block at split time. Allows tracing the history of block mutations: `child.parentBlockId → parent.id`. `onDelete: SET NULL` — parent deletion clears the reference but child survives. Index: `LessonBlock_parentBlockId_idx`.

### FK-nullable fields

| Field | Model | Behavior on referenced row deletion |
|-------|-------|-------------------------------------|
| `sessionId` | LessonCreditLog | `onDelete: SetNull` — log retained, sessionId becomes NULL |
| `teacherId` | LessonSession | nullable — NULL = no substitute (regular teacher via teacherIdSnap) |
| `cabinetId` | LessonSession | nullable — no cabinet assigned |
| `makeupForSessionId` | LessonSession | nullable — NULL = not a makeup lesson |

---

## 5a. Global Invariants

Invariants that must hold in the database at all times. Code that could violate these requires explicit review.

### Scheduling
- Every `LessonSession` must reference a non-deleted `LessonBlock`
- `LessonBlock.days` must be a subset of `School.activeDays` at session generation time (not enforced retroactively on historical sessions)
- Session dates are stored as `UTC noon` (`T12:00:00.000Z`) — always a calendar day identifier, never an exact start time

### Billing
- `creditDeducted` is write-once: once `true`, never set back to `false`
- One credit deduction per `(studentProfileId, lessonSessionId)` — enforced by `creditDeducted` flag inside `$transaction`
- No credit deduction for sessions with `status IN ['CANCELLED', 'INVALIDATED']`
- Credits are never auto-refunded on attendance status edits — only via manual `POST /credits/add`

### Salary
- `teacherIdSnap` and `rateSnapshot` are immutable after creation
- A session counts toward salary only if `status NOT IN ['CANCELLED', 'INVALIDATED']` AND `attendances.some()`
- `TeacherPayment.lessonsCount` is a denormalized cache — source of truth is `TeacherPaymentLesson` join table

### Historical records
- COMPLETED and LOCKED sessions are immutable historical records — snapshot fields (`teacherIdSnap`, `cabinetIdSnap`, `startTimeSnap`, `endTimeSnap`) must never be updated
- `SessionStudent` records for COMPLETED/LOCKED sessions must never be deleted
- `LessonCreditLog` records survive session hard-delete (`onDelete: SetNull` on `sessionId`)
- `TeacherPayment` records survive teacher soft-delete (`deletedAt` on `StaffProfile`)

### Multi-tenancy
- Every DB query must filter by `schoolId` — no cross-tenant data access
- Every `SessionStudent`, `Attendance`, `LessonCreditLog`, `TeacherPayment` record carries `schoolId`

### State machine
- Session status changes only via `canTransition()` in `sessionStateMachine.ts` — no direct field writes
- `status = INVALIDATED` is set only by system (policy change / block split) — never via user-facing API

---

## 5b. Forbidden States

These database states indicate data corruption. If found during migration or audit — treat as a bug.

| Forbidden state | Consequence | Prevention |
|----------------|-------------|------------|
| `Attendance` on an INVALIDATED session | Ghost billing / phantom credit deduction | INVALIDATED sessions reject attendance in route guard |
| `TeacherPaymentLesson` linked to CANCELLED or INVALIDATED session | Phantom salary | Salary query excludes CANCELLED + INVALIDATED |
| Multiple `TeacherPaymentLesson` for same `lessonSessionId` | Double salary payment | `@@unique([lessonSessionId])` → P2002 |
| `creditDeducted = true` without corresponding `LessonCreditLog` | Balance mismatch | Both written in same `$transaction` |
| `LessonCreditLog` deduction (`amount < 0`) for CANCELLED session | Invalid charge | `markAttendance()` guards against this |
| UPCOMING `SessionStudent` where student has `GroupMembership.status = WITHDRAWN` | Ghost attendee in session | Deleted in same tx as WITHDRAWN |
| `LessonBlock` with `endDate < startDate` | Zombie block — breaks session queries | `applyFrom > block.startDate` guard in PUT handler |
| `SchoolSchedulePolicy` with no version having `effectiveTo = null` | Policy gap — no active version | Atomic 3-op tx in settings route |
| `LessonSession` without parent `LessonBlock` (non-orphan) | Unattributable session | Hard FK; orphans only via bug — use repair script |
| `TeacherPayment` with `lessonsCount ≠ TeacherPaymentLesson.count` | Denorm inconsistency | `lessonsCount` set at payment creation from actual count |

---

## 6. Billing Rules

**Model: Slot Reservation.** Student reserves a slot. Whether they attend or not — the slot was held.

| Attendance status | Credit deducted? |
|-------------------|-----------------|
| PRESENT | ✓ |
| LATE | ✓ |
| ABSENT | ✓ — slot was reserved |
| Any + session CANCELLED | ✗ — school cancelled |
| Any + student FROZEN before deadline | ✗ — frozenAt ≤ (sessionDate − freezeWindowHours) |

**One-time deduction per (studentProfileId, lessonSessionId):**
- `creditDeducted` flag checked before any deduction
- All deduction logic runs inside `prisma.$transaction` in `markAttendance()`
- Editing attendance status (PRESENT→ABSENT) does NOT refund credits
- Corrections require manual `POST /credits/add` with negative amount

**Source:** [`server/src/services/attendanceService.ts`](server/src/services/attendanceService.ts) + [`server/src/lib/businessInvariants.ts`](server/src/lib/businessInvariants.ts)

---

## 7. Salary Attribution

**Source of truth: snapshots, not current assignments.**

```
Session counts for teacher T if:
  teacherId = T.staffProfileId          ← substitute (explicit override)
  OR
  teacherIdSnap = T.staffProfileId AND teacherId IS NULL   ← regular teacher (no sub)
```

**Session counts toward salary ONLY IF:**
- `status NOT IN ['CANCELLED', 'INVALIDATED']` — both must be excluded. INVALIDATED sessions are ghost sessions from split-and-replaced blocks; including them would show old teacher's sessions after they were reassigned.
- `attendances.some()` — at least one student has an attendance record

**Rate for period** (`getRateForPeriod`):
- Looks up `TeacherRateLog` where `effectiveFrom ≤ period start`, ordered `[effectiveFrom desc, createdAt desc]`
- Fallback: `staffProfile.salaryRate` (for teachers created before rate logging)

**Source:** [`server/src/routes/salary.ts`](server/src/routes/salary.ts)

---

## 8. Concurrency Guard Index

All race-condition protections in one place.

| Scenario | Guard mechanism | Location |
|----------|----------------|----------|
| Duplicate sessions (same block+date) | `@@unique([lessonBlockId, date])` — P2002 caught in `ensureSingleSession` with retry `findFirst` | schema.prisma + sessionService.ts |
| Double salary payment for same session | `@@unique(TeacherPaymentLesson.lessonSessionId)` — P2002 caught → **409** | schema.prisma + routes/salary.ts |
| Double credit deduction | `creditDeducted` boolean checked inside `$transaction` before deducting | attendanceService.ts |
| Concurrent credit deduction (submit-attendance vs PATCH attendance race) | `SELECT id FROM "StudentProfile" WHERE id = $id FOR UPDATE` at start of per-student TX — serializes concurrent credit ops at DB row level | routes/schedule.ts (submit-attendance + PATCH attendance) |
| Stale session edit (PATCH concurrent update) | `version` field in UPDATE `WHERE` clause — Prisma P2025 (record not found) → **409 STALE_DATA** | routes/schedule.ts PATCH teacher/details/status |
| Concurrent policy change (stale activeDays) | `freshSchool` re-read **inside** `$transaction` at policy write time | routes/settings.ts |
| Policy version gap (no active version) | Atomic `$transaction`: close old → create new → audit log (3 ops, one tx) | routes/settings.ts |
| Salary adjustment retry / double-click | `idempotency` middleware (`Idempotency-Key` header) + 30-second dedup window | routes/salary.ts |
| Sub-second rate change tiebreaker | `orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }]` | routes/salary.ts → getRateForPeriod |
| Restore INVALIDATED with financial data | Guard before update: `attendance.count + teacherPaymentLesson.findFirst` → 409 | routes/schedule.ts |
| Delete block with paid sessions | `teacherPaymentLesson.count` check **inside** `$transaction` as first op → 409 `BLOCK_HAS_PAYMENT_HISTORY` (moved inside TX 2026-05-19 to close race with concurrent salary payment creation) | routes/schedule.ts DELETE /:id |
| Duplicate makeup session (concurrent POST /makeup) | `findFirst({ makeupForSessionId, status: { not: 'CANCELLED' } })` inside `$transaction` → **409 MAKEUP_ALREADY_EXISTS** | routes/schedule.ts POST /session/:id/makeup |
| Cross-tenant read/write on sensitive endpoints | `findFirst({ id, schoolId })` ownership check → 404 if not found (attendance, credit history, salary adjustments, manual entries) | routes/schedule.ts + credits.ts + salary.ts |
| bulk-cancel unauthorized state-machine bypass | Explicit `role !== 'OWNER' && role !== 'ADMIN'` check → **403** (UPCOMING→CANCELLED requires OWNER or ADMIN per state machine) | routes/schedule.ts POST /sessions/bulk-cancel |
| Self-healing snapshot partial failure | `prisma.$transaction([updateMany, ...])` array form — all-or-nothing; prevents teacherIdSnap/cabinetIdSnap/timeSnap inconsistency on server crash mid-batch | services/sessionService.ts syncSessionsForBlock |
| Credit add/deduct retry | `idempotency` middleware | routes/credits.ts |

---

## 9. Known Trade-offs

Accepted decisions — do not "fix" without explicit business review.

| ID | Scenario | Decision | Why |
|----|----------|----------|-----|
| Y3 | Optimistic lock on salary payment | Not implemented | COMPLETED status + `@@unique` on TeacherPaymentLesson is sufficient; stale read window is negligible |
| P3 | Timezone change with existing historical data | Not code-prevented | Sessions in UTC — TZ shift doesn't corrupt data, but day-boundary display may shift. Rule: don't change TZ without manual session audit |
| credit-flip-frozen | Credit deducted late when frozen student is unfrozen | Accepted by design | Slot-reservation model: slot was held regardless; late billing is correct per invariant |
| deleted-teacher | No UI route for historical payments of deleted teacher | Accepted | Data intact in `TeacherPayment` + `rateSnapshot`; low business priority to surface in UI |
| B4-orphan | `LessonCreditLog.sessionId` uses `onDelete: SetNull` not cascade | Accepted | Credit records must survive session hard-delete for financial audit |
| T2-orphan-payment | `TeacherPayment` may exist with no `TeacherPaymentLesson` links (orphan) | Accepted with guard | Caused by block deletion before 2026-05-19 guard was added. Guard now blocks deletion if any session has payment links. Orphan payments can be cancelled via UI (Отменить). Repair script: `server/src/scripts/repair-orphan-payments.ts` |
| T3-split-display | Closed blocks (`endDate != null`) must always get unique `mergeKey` | Fixed 2026-05-19 | Without unique key, old+new block versions merged into one grid cell; schedule appeared empty for future dates |

---

## 10. Document Map

| Question | Go to |
|----------|-------|
| How does the scheduling engine work in detail? | [`AI_SCHEDULE_HANDOFF.md`](AI_SCHEDULE_HANDOFF.md) |
| WHY was X built this way? (ADRs) | [`ARCHITECTURAL_DECISIONS.md`](ARCHITECTURAL_DECISIONS.md) |
| What DB constraints and cascade rules exist? | [`DATABASE_CONSTRAINTS.md`](DATABASE_CONSTRAINTS.md) |
| What are the business rules / invariants in code? | [`server/src/lib/businessInvariants.ts`](server/src/lib/businessInvariants.ts) |
| What are the API request/response shapes? | [`API_CONTRACTS.md`](API_CONTRACTS.md) |
| How does auth, roles, and multi-tenancy work? | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| What frontend state is managed where? | [`FRONTEND_STATE_RULES.md`](FRONTEND_STATE_RULES.md) |
| Full session status graph + canTransition logic? | [`server/src/lib/sessionStateMachine.ts`](server/src/lib/sessionStateMachine.ts) |
| Deployment, env vars, Nginx, PM2? | [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| How to test — manual regression checklist? | [`TESTING_STRATEGY.md`](TESTING_STRATEGY.md) |

---

## 11. Timezone Handling

### School timezone in `LessonSession.date`

**Core invariant:** `LessonSession.date` represents the **logical school-local calendar date** of the lesson — NOT the exact lesson start timestamp. Treat it as a calendar day identifier. Never use it for time-of-day comparisons; never compute lesson duration from it; never display it raw in UTC without timezone conversion.

All session dates are stored as `UTC noon` (`2026-05-19T12:00:00.000Z`). This ensures the "date" survives UTC+0 through UTC+12 without crossing a day boundary.

### Displaying dates on the client

**Wrong (breaks in UTC+5/+6):**
```typescript
weekDates(wk)[ci].toISOString().slice(0, 10)  // gives UTC date = local-1 in UTC+5
```

**Correct:**
```typescript
weekDatesInTz(wk, tz)[ci]  // applies school.timezone (e.g. 'Asia/Almaty')
```

All attendance submission and schedule display code must use `weekDatesInTz(wk, tz)` from `useSchedule`. Source: [`client/src/components/schedule/SlotPanel.tsx`](client/src/components/schedule/SlotPanel.tsx) — `GroupRow` component.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-05-17 | Initial creation. Captured post-stress-test state: INVALIDATED status, policy temporal model, priceSnapshot, all concurrency guards. |
| 2026-05-18 | Added: Architectural Philosophy, Section 1a (Cross-domain Event Flows), Section 2a (Membership Snapshot Rules), Section 5a (Global Invariants), Section 5b (Forbidden States). Renamed "Cron recreates" → "Eligible for rolling-window sync". Added split-version chain diagram to Section 3a. Added long-term soft-delete note for LessonBlock in Section 5. Added timezone core invariant to Section 11. |
| 2026-05-19 | Added Section 3a (LessonBlock temporal versioning/split). Added Section 11 (timezone handling). Updated session behaviors table with teacher-calendar column. Updated salary attribution: INVALIDATED explicitly excluded. Added concurrency guard: DELETE block payment guard. Added trade-offs: T2-orphan-payment, T3-split-display. |
| 2026-05-19 | **Reliability maturity — 3-phase implementation.** Phase 1 (Lock Correctness): integration test suite added (`server/src/__tests__/integration/`) covering creditDeduction, policyInvalidation, salaryAttribution, blockSplit, membershipSnapshot; unit tests for attendanceService corrected to match slot-reservation model. Phase 2 (Production Visibility): pino logger (`server/src/lib/logger.ts`) added with domain child loggers; causality events `CREDIT_DEDUCTED`, `CREDIT_SKIP_FROZEN`, `CREDIT_SKIP_IDEMPOTENT` (attendanceService), `SESSIONS_INVALIDATED` (policyService), `POLICY_CHANGED` (settings route), `BLOCK_SPLIT` (schedule route), `SALARY_COMPUTED` (salary route). Phase 3 (Operational Maturity): `server/src/scripts/consistency-check.ts` — validates all 10 forbidden states from Section 5b; run via `npm run db:check`. |
| 2026-05-19 | **Import invariants + repair rule + consistency-check service.** (1) `consistencyCheckService.ts` — extracted 10 check functions as exportable service; no module-level state, safe for concurrent route calls. (2) `repairBase.ts` — base utility for all repair scripts: `createRepairContext` + `runRepair` with pre/post consistency checks, structured pino logs, dry-run mode. (3) `repair-orphan-payments.ts` migrated to `repairBase`. (4) `consistency-check.ts` refactored to thin CLI wrapper over the service. (5) `importexport.ts` — `POST /import/apply` now: creates `LessonCreditLog` (opening balance) for each new student imported with credits > 0; warns on credits without level/cabinet; supports `?dryRun=true` returning preview without DB writes; runs post-import `runChecks(schoolId)` and returns `consistencyCheck: { clean, violations }` in response. |
