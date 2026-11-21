# DATABASE_CONSTRAINTS.md — Shamdan

> **Purpose:** DB invariants, unique constraints, cascade rules, and idempotency requirements.  
> Read before any Prisma schema change, migration, or query refactor.  
> Violating these causes crashes, data corruption, or billing errors.
>
> For AI workflow and development rules, see CLAUDE.md.

*Last Updated: 2026-07-12*

---

## Unique Constraints

### `@@unique([schoolId, email])`, `@@unique([schoolId, phone])`, `@@unique([schoolId, username])` on `User`

**Added:** Migration 2026-07-10 (`per_school_login_identifiers`). Replaces the old global `email @unique`.

**Why:** Login identifiers are **per-tenant**, not global. The same person can hold a separate account in each school (`student@mail.com` in School A and School B are two distinct users). `email` is now **nullable** and `username` was added — a user needs at least one of `{email, phone, username}` to log in, enforced in `POST /users` and the AddUserModal, not by the DB.

**NULL behaviour:** Postgres treats NULLs as distinct, so a school may have **many** email-less / phone-less / username-less users without collision. Blank strings are normalized to NULL in the migration and on write so `''` never collides.

**Login resolution:** `POST /auth/login` matches the identifier against `email | username | phone`, scoped by `schoolId` (resolved from the `slug`). SUPERADMIN (no school) resolves globally. Email/username are stored and matched lowercased; phone is matched raw.

**Migration caveat:** `CREATE UNIQUE INDEX ...(schoolId, phone)` will **fail** if any school already has two users sharing a non-null phone. Check/clean duplicates before applying to a populated DB.

### `@@unique([lessonBlockId, date])` on `LessonSession` 🔥 CRITICAL

**Added:** Migration 2026-05-06.

**Why:** Guarantees one block never generates duplicate sessions for the same date. Without this, cron + server restart creates duplicates → double attendance → double credit deductions.

**Critical caveat:** Soft-deleted sessions (`deletedAt != null`) **still hold the unique slot**. You cannot create a new session for (blockId, date) even if the existing one is soft-deleted.

**Required:** `lessonSession.createMany()` MUST use `{ skipDuplicates: true }`.

```ts
// CORRECT
await prisma.lessonSession.createMany({ data: [...], skipDuplicates: true });

// WRONG — P2002 crash on server restart if any date has a soft-deleted session
await prisma.lessonSession.createMany({ data: [...] });
```

---

### `@@unique([schoolId, startTime, endTime])` on `TimeSlot`

Used by `syncTimeSlots()` for upsert when regenerating slots after settings change.

```ts
await prisma.timeSlot.upsert({
  where: { schoolId_startTime_endTime: { schoolId, startTime, endTime } },
  update: { order },
  create: { schoolId, startTime, endTime, order }
});
```

---

### `PlatformSettings` — singleton row, id is always `1`

**Added:** Migration `20260711000000_add_platform_settings`.

**Why:** Platform-wide config authored by SUPERADMIN (starts with `help` topics for the shared `/help` page) — not tenant-scoped, so it doesn't belong on `School`. One row only.

**Required:** Always read/write via `where: { id: 1 }`; `upsert` (never `create` blind — a second `create` throws on the existing PK). Never `findMany`.

```ts
// CORRECT
await prisma.platformSettings.upsert({ where: { id: 1 }, create: { id: 1, help }, update: { help } });

// WRONG — assumes the row always exists; 404s until first write
await prisma.platformSettings.update({ where: { id: 1 }, data: { help } });
```

---

## Soft Delete Rules

### Models WITH soft delete (`deletedAt: DateTime?`)

| Model | Notes |
|-------|-------|
| `School` | Blocking uses `blockedAt`, not `deletedAt` |
| `User` | Excluded from all queries when deleted. Also has `archivedAt DateTime?` — archived students are excluded from active list but NOT from history/attendance/salary queries. Use `archivedAt: null` filter in `GET /students` active view. |
| `StudentProfile` | Filter in enrollment + session snapshot queries |
| `StaffProfile` | Filter in teacher conflict checks |
| `Cabinet` | Filter in conflict checks + schedule display |
| `TimeSlot` | Filter when building schedule grid |
| `LessonBlock` | Has `deletedAt` but DELETE API uses **hard delete** (see ADR-003). **Guard:** deletion is blocked (409) if any child session has a `TeacherPaymentLesson` record — prevents orphaning `TeacherPayment` records. |
| `LessonSession` | True soft delete — never hard-deleted. Historical records preserved. |
| `StudentGroup` | Filter in all group queries |

### Models WITHOUT soft delete

`LessonCreditLog`, `Attendance`, `TeacherPayment`, `SalaryAdjustment`, `Notification`, `GroupMembership`, `SessionStudent` — no `deletedAt` filter needed.

### MANDATORY filter on every read

```ts
// CORRECT
await prisma.lessonBlock.findMany({ where: { schoolId, deletedAt: null } });

// WRONG — returns deleted records, causing ghost data in UI
await prisma.lessonBlock.findMany({ where: { schoolId } });
```

---

## Cascade Rules (Manual Code — NOT DB-level)

> [!WARNING]
> No `onDelete: Cascade` in Prisma schema for critical relations. All cascades are manual code. Breaking this = orphaned data or missing credit refunds.

### LessonBlock DELETE cascade

`DELETE /api/schedule/:id` handler does in order:

1. Finds affected future sessions (date >= now)
2. Blocks normal cancellation/deletion for sessions with `Attendance.creditDeducted = true`
3. Soft-deletes eligible future sessions (`deletedAt = now()`)
4. Physically deletes the `LessonBlock`

Past sessions (COMPLETED, CANCELLED, date < now) are **preserved**.

No automatic credit refund happens inside normal cancel flow. Credit corrections require an explicit ledger/correction flow with audit context.

```ts
// DO NOT add DB-level cascade DELETE for sessions — destroys historical audit trail
```

### StudentGroup identity (no `name` column)

`StudentGroup.name` was dropped (migration `20260707000000_drop_student_group_name`). Groups are identified by `level` + `chapter`. Do not reintroduce a name column or select `name` in group queries.

### StudentGroup comment

`StudentGroup.comment` (nullable `TEXT`, migration `20260708000000_add_group_comment`) — free-text note, editable inside the group detail page for any status. Edited via `PUT /groups/:id` (empty string → `NULL`, server caps at 2000 chars). Display-only elsewhere.

### StaffProfile notes

`StaffProfile.notes` (nullable `TEXT`, migration `20260712000000_add_staff_notes`) — free-text admin note per staff member (teacher/admin), mirror of `StudentProfile.notes`. Edited via `PATCH /users/:id/staff-profile` from the staff profile modal («Информация» tab); returned automatically by `GET /users` / `GET /users/:id` inside `staffProfile`.

### StudentGroup soft-delete

Blocks remain when a group is soft-deleted. Conflict checks exclude deleted groups:

```ts
// scheduleValidation.ts — correct pattern
OR: [
  { studentGroupId: null },
  { studentGroup: { deletedAt: null } }
]
```

### LessonSession Manual Overrides

**Fields:** `isManualTeacher`, `isManualCabinet`, `isManualTime`.

**Rule:** When set to `true`, the `syncSessionsForBlock` service MUST skip updating the corresponding fields (`teacherId`, `cabinetIdSnap`, `startTimeSnap`, `endTimeSnap`) to preserve human intervention. Any explicit change via `PATCH /session/:id` routes must set these flags.

---

## Idempotency Invariants

### Attendance.creditDeducted 🔥 CRITICAL

**Rule:** Only `attendanceService.ts → markAttendance()` may mutate `creditDeducted`. Never set it directly in a route handler.

**State machine:**
```
→ PRESENT/LATE/ABSENT        creditDeducted = true  + deduct 1 credit + log
→ FROZEN                     creditDeducted = false + no deduction
→ same charged state again   creditDeducted = true  + no-op
```

Calling the same state twice is a no-op:
- `PRESENT/LATE/ABSENT` with flag already `true` → no duplicate deduction
- `FROZEN` with flag already `false` → no deduction

Sessions with `creditDeducted=true` cannot be normally cancelled; cancellation does not auto-refund credits.

### Manual credit top-up

`POST /api/credits/add` → `prisma.$transaction()` → creates `LessonCreditLog` AND updates `StudentProfile.credits` atomically.

**Do not** update `StudentProfile.credits` without a corresponding `LessonCreditLog` entry.

---

## Transaction Requirements

| Operation | Reason |
|-----------|--------|
| Mark attendance | `creditDeducted` + `StudentProfile.credits` + `LessonCreditLog` must be atomic |
| Manual credit add | Same as above |
| Block delete | Guard checks + session soft-delete + audit context must be atomic |
| Bulk student enrollment | `GroupMembership` creates + session snapshot updates |

```ts
await prisma.$transaction(async (tx) => {
  // All related mutations use `tx`, not `prisma`
  await tx.studentProfile.update(...);
  await tx.lessonCreditLog.create(...);
  await tx.attendance.update(...);
});
```

---

## Multi-Tenancy Constraint

**Every** Prisma query in a route handler MUST include `schoolId: req.user.schoolId`.

```ts
// CORRECT
prisma.lessonBlock.findMany({ where: { schoolId: req.user.schoolId, deletedAt: null } });

// WRONG — cross-tenant data leak
prisma.lessonBlock.findMany({ where: { deletedAt: null } });
```

`schoolId` comes from JWT via `authenticate` middleware → `req.user.schoolId`. Never trust client-provided `schoolId`.

---

## findFirst vs findUnique Rule

Use `findFirst` when adding extra filters beyond the unique key.

```ts
// CORRECT — findFirst allows extra where conditions
const block = await prisma.lessonBlock.findFirst({
  where: { id: blockId, schoolId, deletedAt: null }
});

// WRONG — TypeScript error: can't add schoolId to findUnique where
const block = await prisma.lessonBlock.findUnique({
  where: { id: blockId, schoolId }
});
```

---

## Notification Retention

`Notification` records older than **90 days** are auto-deleted on server startup (`cleanupOldNotifications()` in `index.ts`). Do not store permanent data in `Notification`.

---

## Required Indexes (already applied — do not remove)

### Single-column indexes (Prisma auto via `@unique` / `@@index`)

| Table | Columns |
|-------|---------|
| `User` | `email`, `schoolId`, `role`, `deletedAt` |
| `School` | `slug`, `isActive` |
| `LessonBlock` | `schoolId`, `deletedAt`, `startDate`, `endDate` |
| `LessonSession` | `lessonBlockId`, `date`, `schoolId` |
| `Attendance` | `lessonSessionId`, `studentId`, `creditDeducted` |
| `LessonCreditLog` | `studentId`, `schoolId`, `createdAt` |
| `Notification` | `userId`, `schoolId`, `isRead`, `createdAt` |

### Composite indexes (Migration `20260510100000_composite_indexes`)

Added for 30k-student production performance. **Do not drop.**

| Table | Index name | Columns | Justification |
|-------|-----------|---------|---------------|
| `LessonSession` | `LessonSession_schoolId_date_idx` | `(schoolId, date)` | Dashboard range queries |
| `LessonSession` | `LessonSession_teacherId_date_idx` | `(teacherId, date)` | Teacher calendar queries |
| `LessonSession` | `LessonSession_status_date_idx` | `(status, date)` | Salary / cancelled-sessions queries |
| `LessonSession` | `LessonSession_schoolId_status_idx` | `(schoolId, status)` | Admin overview counts |
| `Attendance` | `Attendance_studentProfileId_createdAt_idx` | `(studentProfileId, createdAt)` | Credit history pagination |
| `EnrollmentRequest` | `EnrollmentRequest_studentGroupId_status_idx` | `(studentGroupId, status)` | Waitlist queries |
| `EnrollmentRequest` | `EnrollmentRequest_studentProfileId_status_idx` | `(studentProfileId, status)` | Student enrollment view |
| `LessonBlock` | `LessonBlock_schoolId_teacherId_idx` | `(schoolId, teacherId)` | Teacher workload queries |
| `LessonBlock` | `LessonBlock_schoolId_timeSlotId_idx` | `(schoolId, timeSlotId)` | TimeSlot sync updates |

> **Note:** Migrations use `CREATE INDEX IF NOT EXISTS` without `CONCURRENTLY` — Prisma wraps migrations in PostgreSQL transactions, and `CONCURRENTLY` is forbidden inside transactions.

---

## Optimistic Locking — LessonSession.version

**Added:** Migration `20260510110000_session_version`.

`LessonSession.version Int @default(0)` — incremented on every update via `version: { increment: 1 }`.

**Purpose:** Detect concurrent edits (e.g. two admins change the same session simultaneously). Client passes `version` on update requests; server rejects with **409 STALE_DATA** if version does not match.

**Implementation (2026-05-19):** `version` is passed in the UPDATE `WHERE` clause — not checked in a pre-read:
```typescript
await prisma.lessonSession.update({
  where: { id: sessionId, ...(version !== undefined && { version }) },
  data: { version: { increment: 1 }, ... },
})
// Prisma P2025 (record not found) = version mismatch → re-throw as httpStatus: 409
```
This closes the TOCTOU window between version check and update. Applied to PATCH `/session/:id/teacher`, `/session/:id/details`, `/session/:id/status`.

## Pessimistic Locking — StudentProfile credit deductions

To prevent double credit deduction when `submit-attendance` and `PATCH /session/:id/attendance` run concurrently for the same student, each per-student transaction acquires a row-level exclusive lock:
```sql
SELECT id FROM "StudentProfile" WHERE id = $studentProfileId FOR UPDATE
```
The second transaction waits until the first commits, then sees `creditDeducted=true` and skips deduction. Applied in `routes/schedule.ts` in both submit-attendance and PATCH attendance handlers.

*Last Updated: 2026-05-19 (Optimistic lock fully implemented; SELECT FOR UPDATE for credit deductions)*


---

## Migration 20260512000001 — Attendance.submittedById

`Attendance.submittedById INTEGER NULL` — FK to `User.id ON DELETE SET NULL`. Хранит userId того, кто сдал посещаемость (для расчёта зарплаты). Индекс: `Attendance_submittedById_idx`.

---

## Migration 20260524010000 — Phase 7.1 Invoice Infrastructure

### New Models

#### Invoice
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| schoolId | INT FK→School | tenant isolation |
| studentProfileId | INT FK→StudentProfile RESTRICT | |
| status | InvoiceStatus | DRAFT→ISSUED→PARTIALLY_PAID/PAID/VOID/OVERDUE |
| totalAmount | DECIMAL(12,2) | recomputed from lines on every addLine |
| paidAmount | DECIMAL(12,2) | recomputed from confirmed allocations only — never manually set |
| currencyCode | TEXT default 'KGS' | |
| dueDate | TIMESTAMP? | |
| issuedAt | TIMESTAMP? | set on issue |
| voidedAt | TIMESTAMP? | set on void |
| createdById | INT FK→User RESTRICT | |

**Indexes:** `(schoolId, studentProfileId)`, `(schoolId, status)`, `(schoolId, dueDate)`

**Invariants:**
- `balanceDue = totalAmount − paidAmount` — not stored, always computed
- Lines can only be added/modified in DRAFT status
- Once ISSUED, invoice is immutable (no line edits, no total changes)
- Cannot be voided if `PaymentAllocation` with `payment.status=CONFIRMED` exists

#### InvoiceLine
| Column | Type | Notes |
|--------|------|-------|
| invoiceId | INT FK→Invoice RESTRICT | |
| type | InvoiceLineType | TUITION/MATERIAL/REGISTRATION/DISCOUNT/CUSTOM |
| quantity | DECIMAL(10,2) | |
| unitPrice | DECIMAL(12,2) | |
| amount | DECIMAL(12,2) | = quantity × unitPrice, computed on backend |
| creditsToIssue | INT? | used by Phase 7.2 credit issuance |

**Constraint:** `onDelete: RESTRICT` on `invoiceId` — lines cannot exist without invoice.

#### Payment (new — separate from legacy StudentPayment)
| Column | Type | Notes |
|--------|------|-------|
| schoolId | INT FK→School | |
| studentProfileId | INT FK→StudentProfile RESTRICT | |
| amount | DECIMAL(12,2) | |
| method | PaymentMethod | CASH/CARD/TRANSFER (reuses existing enum) |
| status | PaymentStatus | CONFIRMED/VOIDED/REFUNDED |
| receivedById | INT FK→User "PaymentReceiver" | |
| voidedById | INT? FK→User "PaymentVoider" | set on void |
| refundPaymentId | INT? FK→Payment self | legacy nullable self-link; refund flow uses `PaymentRefund` / `PaymentRefundAllocation` |

**Void semantics:** `status=VOIDED` — allocations are NOT deleted (audit trail); `invoice.paidAmount` is recalculated excluding voided payments.

#### PaymentAllocation
| Column | Type | Notes |
|--------|------|-------|
| paymentId | INT FK→Payment RESTRICT | |
| invoiceId | INT FK→Invoice RESTRICT | |
| amount | DECIMAL(12,2) | |

**Unique:** `(paymentId, invoiceId)` — one payment can only be allocated once to the same invoice.
**Constraint:** Both FKs are `RESTRICT` — allocations are immutable history. Cannot delete a payment or invoice that has allocations.
**Overpayment guard:** `SUM(confirmed allocs) + new_amount ≤ invoice.totalAmount` is enforced in `paymentService.createAllocation()`.

### Additive columns on existing tables

| Table | Column | Type | Notes |
|-------|--------|------|-------|
| StudentProfile | moneyBalance | DECIMAL(12,2) default 0 | **running total** of money paid toward lessons since the last price change (accumulator, never decremented). Lessons owed = `floor(moneyBalance * billingDays / fee)` via exact Decimal math. Sub-lesson remainder stays banked; nothing dropped. (2026-07-02 — was a decrementing wallet at rounded `pricePerLesson`.) |
| StudentProfile | billingLessonsGranted | Int default 0 | lessons already granted from the current `moneyBalance` accumulator. Reset to 0 on a price change (leftover som carried forward at the new price). New 2026-07-02. |
| StudentProfile | monthlyFee | DECIMAL(10,2)? (nullable) | per-student monthly tuition; NULL → falls back to `SchoolFinanceConfig.basePrice`. **Drives credit/balance math** (per-lesson price = `fee / billingDays`) as of 2026-07-02, plus "% paid this month". |
| StudentPayment | cancelledAt / cancelledById | timestamp? / Int? (nullable) | set when a payment is cancelled/refunded via `POST /students/:id/payments/:paymentId/cancel`. Original row kept for audit; excluded from `paidThisMonth`. Full reversal writes a `LessonCreditLog` (type `REFUND`). New 2026-07-02. |
| LessonCreditLog | paymentId | INT? FK→Payment SetNull | links credit log to payment for credit issuance/reversal flows |

### Financial invariants enforced

1. **No over-allocation** — `createAllocation` checks remaining balance before insert; throws `ALLOCATION_EXCEEDS_INVOICE_BALANCE`.
2. **Immutable issued invoices** — `addLine` and amount edits throw `INVOICE_NOT_EDITABLE` for non-DRAFT status.
3. **Audit-safe payment voiding** — voiding sets `status=VOIDED`, allocations remain; paidAmount recomputed from CONFIRMED-only allocations.
4. **Allocation-based paidAmount** — `invoice.paidAmount` is always derived from `SUM(PaymentAllocation.amount WHERE payment.status=CONFIRMED)`, never set directly from route handlers.
5. **Decimal-safe calculations** — all money arithmetic uses `Prisma.Decimal`; no `Number()` casting or JS float operations.
6. **Check 14 (CRITICAL)** — `consistencyCheckService.check14()` verifies `invoice.paidAmount == SUM(confirmed PaymentAllocation.amount)`. Runs in `runChecks()` on demand. Samples up to 200 invoices per call.
7. **Finance audit trail** — all state transitions write to `ScheduleActionLog` via `logFinanceAction()` in `auditLog.ts`. Events: `INVOICE_CREATED/ISSUED/VOIDED`, `PAYMENT_CREATED/VOIDED/ALLOCATED`. The `entityType` field holds `'invoice'|'payment'|'allocation'` (String column, not a DB enum).

*Last Updated: 2026-05-24 (Phase 7.1 Stabilization — check14, audit events, 32 tests, CLOSED)*

---

## Migration 20260524020000 — Phase 7.2 Credit Issuance

### New Model `CreditIssuance`

Bridges the Invoice/Payment accounting layer to academic lesson credits. Created when a `TUITION` `InvoiceLine` with `creditsToIssue != null` is paid.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| schoolId | INT FK→School RESTRICT | tenant isolation |
| paymentAllocationId | INT FK→PaymentAllocation RESTRICT | source allocation |
| invoiceLineId | INT FK→InvoiceLine RESTRICT | TUITION line |
| studentProfileId | INT FK→StudentProfile RESTRICT | recipient |
| creditsIssued | INT | actual credits issued (≥1, zero-noise: never 0) |
| lessonCreditLogId | INT? FK→LessonCreditLog SetNull | `@unique` — PAYMENT log |
| issuedById | INT FK→User RESTRICT | actor |
| reversedAt | TIMESTAMP? | null until voided |
| reversedById | INT? FK→User SetNull | null until voided |
| reversalLogId | INT? FK→LessonCreditLog SetNull | `@unique` — CORRECTION log |
| issuedAt | TIMESTAMP | default now() |
| createdAt | TIMESTAMP | default now() |

**Idempotency key:** `@@unique([paymentAllocationId, invoiceLineId])` — DB rejects duplicate issuance per allocation+line.

**Indexes:** `(schoolId)`, `(studentProfileId)`, `(invoiceLineId)`, `(paymentAllocationId)`

### Credit issuance invariants

1. **Only TUITION lines with `creditsToIssue != null`** trigger issuance.
2. **Write chain** (must be atomic, one TX): `CreditIssuance → LessonCreditLog(PAYMENT) → StudentProfile.credits increment`
3. **Zero-noise rule**: if `floor(creditsToIssue × allocAmt / invoiceTotal) == 0` → no record created.
4. **Proportional formula** (partial payment): `floor(creditsToIssue × allocAmt / invoiceTotal)`
5. **Reconcile on PAID**: when `newInvoiceStatus === 'PAID'` → issue `creditsToIssue − SUM(non-reversed issuances)` as remainder.
6. **Over-issuance protection**: re-read `alreadyIssued` inside same TX + clamp + DB unique constraint.
7. **Reversal** (on payment void): creates `LessonCreditLog(CORRECTION, amount=-creditsIssued)`, decrements `StudentProfile.credits`, sets `reversedAt/reversalLogId`. Double-void is no-op (guard: `reversedAt IS NULL`).
8. **Audit events**: `CREDITS_ISSUED_FROM_PAYMENT` and `CREDIT_ISSUANCE_REVERSED` in `ScheduleActionLog`.

### New service: `creditIssuanceService.ts`

- `issueCreditsForAllocation(tx, params)` — called from `paymentService.createAllocation` after invoice status update
- `reverseIssuancesForPayment(tx, params)` — called from `paymentService.voidPayment` after invoice recomputes

*Last Updated: 2026-05-24 (Phase 7.2 — CreditIssuance, 13 tests, CLOSED)*

---

## Migration 20260524030000 — Phase 7.3 Refunds & Adjustments

### New refund models

- `PaymentRefund`: immutable refund event with lifecycle `PENDING -> CONFIRMED -> VOIDED`.
- `PaymentRefundAllocation`: source of truth for refund math. Every refund amount is tied to one `PaymentAllocation`.
- `CreditIssuanceReversal`: immutable credit reversal row. If a refund is voided, the reversal row is not deleted; it is marked `voidedAt` and a positive counter `LessonCreditLog` is written.
- `FinancialAdjustment`: controlled business object for manager/accounting/migration corrections and explicit debt markers.

### Phase 7.3 invariants

1. **Allocation-aware refunds only** — refund math never uses only `Payment.amount`; it uses `PaymentRefundAllocation`.
2. **Net-paid source of truth** — `Invoice.paidAmount` is a cached value derived from:
   `SUM(CONFIRMED PaymentAllocation.amount) - SUM(CONFIRMED PaymentRefundAllocation.amount)`.
3. **No destructive edits** — refunds do not delete or rewrite `Payment`, `PaymentAllocation`, `CreditIssuance`, or ledger rows.
4. **Credit reversal is unused-only** — refund reversal decrements `StudentProfile.credits` only up to available credits.
5. **Consumed-credit debt marker** — if refund wants to reverse more credits than are available, remaining credits become `FinancialAdjustment(type=BALANCE_DEBT)`. `StudentProfile.credits` must not go negative silently.
6. **Idempotency** — confirmed refund cannot be confirmed again; `CreditIssuanceReversal @@unique([creditIssuanceId, paymentRefundAllocationId])` prevents duplicate reversal rows for the same refund allocation.
7. **Check 14 updated** — `consistencyCheckService.check14()` now validates cached `invoice.paidAmount` against net paid, not gross allocations.
8. **Audit events** — `PAYMENT_REFUND_CREATED`, `PAYMENT_REFUND_CONFIRMED`, `PAYMENT_REFUND_VOIDED`, `CREDIT_REVERSAL_CREATED`, `FINANCIAL_ADJUSTMENT_CREATED`.

*Last Updated: 2026-05-24 (Phase 7.3 — Refunds, reversals, adjustments, allocation-aware net-paid)*

---

## Phase 7.4 v1 — Computed Overdue & Accounts Receivable

No schema migration in v1. Receivables are service-level computed values, not persisted columns.

### Overdue is computed, not stored

`InvoiceStatus.OVERDUE` exists in the enum for compatibility, but Phase 7.4 v1 does not use it as canonical truth.

Canonical overdue formula:

```text
isOverdue =
  status IN (ISSUED, PARTIALLY_PAID)
  AND dueDate IS NOT NULL
  AND dueDate < asOf
  AND outstanding > 0
```

No cron, no nightly status sync, no persisted `outstandingAmount`.

### Receivable formulas

Money source of truth:

```text
netPaid =
  SUM(PaymentAllocation.amount WHERE payment.status = CONFIRMED)
  -
  SUM(PaymentRefundAllocation.amount WHERE refund.status = CONFIRMED)

outstanding = max(Invoice.totalAmount - netPaid, 0)
```

`FinancialAdjustment(type=BALANCE_DEBT)` is not invoice money debt. It is an explicit credit-debt marker from consumed-credit refund shortfall.

### New service

`server/src/services/receivableService.ts`

- `computeInvoiceReceivable(invoiceId, asOf)`
- `getStudentReceivableSummary(schoolId, studentProfileId, asOf)`
- `listOverdueInvoices(schoolId, asOf)`
- `getSchoolReceivableSummary(schoolId, asOf)`
- pure helpers: `calculateNetPaid`, `calculateOutstanding`, `isInvoiceOverdue`

### New invariant

**Check 15 (CRITICAL)** in `consistencyCheckService` verifies invoice receivable/status math:

- recomputes net paid from confirmed allocations minus confirmed refund allocations
- derives outstanding from `totalAmount - netPaid`
- flags net paid greater than total amount as negative-outstanding risk
- flags `PAID`, `PARTIALLY_PAID`, and `ISSUED` status drift against net-paid math
- excludes `DRAFT` and `VOID`

*Last Updated: 2026-05-24 (Phase 7.4 v1 — computed overdue, receivables summary, check15)*

---

## StudentFreeze Constraints (PR 5 — 2026-05-31)

### Application-level type invariants

`StudentFreeze.type` enforces field requirements at application level (no DB check constraints):

| type | lessonSessionId | startDate | endDate |
|------|----------------|-----------|---------|
| `LESSON_SKIP` | required (non-null) | null | null |
| `PERIOD` | null | required (non-null) | nullable (null = open-ended) |

### No overlapping ACTIVE PERIOD freezes per student

Application-level check (inside `$transaction` with `FOR UPDATE` row-lock):
- Two PERIOD freezes for the same `studentProfileId` must not have date ranges that overlap.
- Bidirectional condition: `A.startDate <= B.endDate (or B.endDate is null) AND B.startDate <= A.endDate (or A.endDate is null)`.
- Violation → 409 `FREEZE_PERIOD_OVERLAP`.
- `createOpenEndedFreeze` (legacy admin-toggle path) bypasses this check intentionally.

### No duplicate ACTIVE LESSON_SKIP per session per student

Application-level check inside `$transaction`:
- One active `LESSON_SKIP` per `(studentProfileId, lessonSessionId)`.
- Violation → 409 `FREEZE_LESSON_SKIP_EXISTS`.

### StudentProfile.isFrozen / frozenAt are legacy cache only

`StudentFreeze` is the source of truth. `StudentProfile.isFrozen/frozenAt` are kept in sync by `freezeService` as a side effect of every create/cancel operation. Do NOT read `isFrozen` in attendance or credit logic — use `findActiveFreeze()` instead.

### Cascade on LessonSession delete

`StudentFreeze.lessonSessionId FK → LessonSession.id ON DELETE SET NULL`. If a session is soft-deleted or hard-deleted, the `StudentFreeze.lessonSessionId` becomes null. The freeze record is preserved for audit history.

---

## GroupMembership invariants

### ACTIVE membership ⇒ group not soft-deleted 🔥

**Added:** Migration `20260614000000_close_orphaned_memberships` (2026-06-14).

**Invariant:** a `GroupMembership` with `status = 'ACTIVE'` must never point to a
`StudentGroup` whose `deletedAt IS NOT NULL`. `GroupMembership` is the source of truth for
"student → group" enrollment; an ACTIVE link to a deleted group is a dead record.

**Why:** without this, deleting a group left enrollment links ACTIVE forever. They
(1) inflate active-student/active-group analytics, (2) bloat membership joins at 50k scale,
and (3) are a latent failure — once a student's last live group is deleted, schedule
derivation over stale links could collapse to zero while garbage remains in the DB.

**How it is enforced:**
- Both soft-delete paths close memberships in the same operation:
  `GroupLifecycleService.archiveGroup()` (single group) and the `clear-all-data` wipe
  (`routes/settings.ts`) set `status = 'WITHDRAWN'`, `leftAt`, and a `leftReason`
  (`GROUP_ARCHIVED` / `SCHOOL_DATA_CLEARED`).
- The backfill migration closed all pre-existing orphans (`leftReason = 'BACKFILL_ARCHIVED_GROUP'`).
- Defense-in-depth: cross-group reads of ACTIVE memberships also filter
  `studentGroup: { deletedAt: null }`.

**Note:** group *promotion* and *completion* intentionally keep source memberships ACTIVE
(the group is COMPLETED, not deleted). The invariant keys on `deletedAt`, not `status`.
Restoring an archived group (`restoreGroup`) does NOT reactivate memberships — they stay
WITHDRAWN; re-enrolling students is an explicit separate action.

### `GroupMembership.bookIssued` (2026-07-03)

**New column** `bookIssued BOOLEAN NOT NULL DEFAULT false`
(migration `20260703000000_group_membership_book_issued`). Per-membership flag «книга
выдана» — источник правды для кнопки «Книга» в расписании. Not financial data; written
only by `PATCH /groups/:id/students/book` (`schedule:write`), always scoped by `schoolId`
and `status = 'ACTIVE'`.

---

## `SchoolFinanceConfig.billingMode` + derived `StudentProfile.paidUntil` (2026-06-19)

**New enum** `BillingMode { PER_LESSON, CALENDAR_MONTH }` and **new column**
`SchoolFinanceConfig.billingMode BillingMode NOT NULL DEFAULT 'PER_LESSON'`
(migration `20260619000000_add_billing_mode`). Default preserves prior behaviour.

**Invariant:** `StudentProfile.credits` (balance) is the **single source of truth** for
payment status. `StudentProfile.paidUntil` is now a **derived, display-only cache** — never read
it to decide status. Overdue is `!isFrozen && credits <= 0` in **both** billing modes (server
`students.ts` filter and client `Students.tsx`/`GroupDetail.tsx` stay aligned).

**Who writes `paidUntil`:** only `recomputeAndPersistPaidUntil()` (`lib/paidUntilDerivation.ts`),
called inside the same transaction as every balance change (credit issuance, top-up, void/refund),
on `billingMode` toggle, and by `scripts/backfill-paid-until.ts`. Recompute is a pure read+write
on `StudentProfile` — it never touches idempotency keys, `creditDeducted`, or `CreditIssuance`.
CSV import may still set an initial `paidUntil`; the next balance change re-derives it.

## CalendarNote — shared admin day notes (2026-06-27)

Backend store for schedule day notes (was localStorage `bios_day_notes`). School-scoped and shared:
`@@unique([schoolId, date])` ⇒ exactly one note per day per school; any OWNER/ADMIN edits the same row.
`schoolId` FK `onDelete: Cascade`. `authorId Int?` records the last editor for audit (nullable, no FK
so deleting the user keeps the note). `date` is `@db.Date` (no time component). Index on `schoolId`.

## StudentCalendarNote — personal per-user day notes (2026-06-28)

Per-user notes on the student calendar (restored/adapted from the roach07 per-user feature). Distinct
from the school-shared `CalendarNote`. `@@unique([userId, date])` ⇒ one note per day per user; `userId`
FK `onDelete: Cascade`. `schoolId` kept for tenant scoping. `date` is `@db.Date`.

## TeacherPayment — void status instead of delete (2026-07-11)

`TeacherPayment` gains `status PaymentStatus @default(CONFIRMED)`, `voidedAt DateTime?`,
`voidedById Int?` (FK → `User`, `TeacherPaymentVoider` relation), `voidReason String?`
(migration `20260711000000_teacher_payment_void_status`). Cancelling a payout no longer deletes the
row: `DELETE /salary/pay/:id` sets `VOIDED` + who/when/why and removes the payout's
`TeacherPaymentLesson` links, so the unique `TeacherPaymentLesson.lessonSessionId` guard keeps
protecting against double-pay among **active** payouts while the voided record survives as an audit
trail. Invariants:

- All salary money math (paid totals, remaining, applied adjustment net, `PERIOD_ALREADY_PAID`
  guards) reads only `status != 'VOIDED'` rows.
- A `VOIDED` payout with zero lesson links is **valid** — consistency check10
  (`lessonsCount` vs links) and the `repair-orphan-payments` script both skip `VOIDED` rows;
  `lessonsCount`/`amount` on the voided row are historical snapshots.
- Voiding is idempotent-guarded: voiding an already-`VOIDED` payout → 409.
