# ARCHITECTURAL_DECISIONS.md — Shamdan

> **Purpose:** This file documents **WHY** things were built the way they were.  
> Not *what* — that's in ARCHITECTURE.md and AI_SCHEDULE_HANDOFF.md.  
> This is the anti-regression memory for refactors.
>
> For AI workflow and development rules, see CLAUDE.md.

*Last Updated: 2026-08-18 ("Итого выплачено" includes advances — display-only)*

---

## ADR-001: StaffProfile.id stored in LessonBlock/LessonSession, NOT User.id

**Decision:** `LessonBlock.teacherId` and `LessonSession.teacherId` store `StaffProfile.id`, not `User.id`.

**Why:**  
`StaffProfile` is the domain entity for a teacher. It holds `salaryRate`, `position`, `hireDate`, `taughtBlocks`, and `substitutions` relations. A `User` is an auth/account entity.  
Storing `User.id` would require joins through `User → StaffProfile` every time scheduling logic runs, and would blur the boundary between auth and domain.

**Consequence for AI:**  
When assigning a teacher from a `userId`:
```ts
// CORRECT
const staff = await prisma.staffProfile.findUnique({ where: { userId: teacherUserId } });
block.teacherId = staff.id; // StaffProfile.id

// WRONG — DO NOT DO THIS
block.teacherId = teacherUserId; // User.id — будет тихо ломать запросы
```

**Client-side:** The API response converts via `mapTeacher()` → returns `{ id: user.id, firstName, lastName }`.  
So on the **client**, `teacher.id` = `User.id`. On the **server/DB**, `teacherId` = `StaffProfile.id`. These are different values.

---

## ADR-002: Rolling 14-day session window, not full pre-generation

**Decision:** Sessions are generated only 14 days into the future (`ROLLING_DAYS = 14`). A daily cron job extends the window.

**Why not 90 days (old behavior)?**  
- 90-day pre-generation created hundreds of useless rows for each new block.
- When a block changed (days, time, endDate), hundreds of sessions had to be cleaned up.
- Schedule changes were expensive and error-prone.

**Why not full on-demand generation?**  
- Sessions need to exist for substitution assignment (`PATCH /session/:id/teacher`).
- Sessions need to exist for attendance marking before the class.
- Lazy-creation via `POST /session/ensure` exists for edge cases but is not the primary path.

**Why cron (not event-driven)?**  
The system has no message broker. A daily cron at server startup + scheduled interval is sufficient for 30+ schools. Adding a queue (BullMQ, etc.) would be premature optimization at current scale.

**Do not change `ROLLING_DAYS` without updating:**
- `getGroupsInCell()` in `useSchedule.ts` (client-side display horizon, synced to 14)
- `extendAllBlockSessions()` in `sessionService.ts`
- `syncSessionsForBlock()` window calculation

---

## ADR-003: LessonBlock uses hard delete via API, despite having deletedAt in schema

**Decision:** `DELETE /api/schedule/:id` calls `prisma.lessonBlock.delete()` — physical delete. `LessonBlock` has `deletedAt` in the Prisma schema but it is NOT used in the delete route.

**Why hard delete for blocks?**  
- A `LessonBlock` is a *template* — historical truth is preserved in `LessonSession` snapshots.
- Soft-deleting a block would require filtering `deletedAt: null` on blocks everywhere, while still keeping sessions. It's complexity with no benefit.
- When a block is deleted, the code manually handles: (1) future session soft-delete, (2) credit refunds for future attended sessions.

**Why LessonSession IS soft-deleted?**  
Sessions store attendance, credits, and historical data. They must never be physically deleted. `LessonSession.deletedAt` is set, not a hard delete.

**Warning for AI:**  
Do not add `deletedAt: new Date()` to the block delete route. Do not convert to soft delete without migrating all the cascade logic.

---

## ADR-004: LessonSession stores snapshots of teacher/cabinet/time

**Decision:** `LessonSession` has `teacherIdSnap`, `cabinetIdSnap`, `startTimeSnap`, `endTimeSnap` fields that duplicate the parent `LessonBlock` values at creation time.

**Why:**  
A `LessonBlock` is a mutable recurring template. Its teacher, cabinet, or time can be changed at any point. But historical sessions must preserve **what actually happened**, not what the current block says.

Example: Grammar block was taught by Teacher A Mon/Wed in Room 101. Teacher A left, replaced by Teacher B. Without snapshots, historical sessions would retroactively show Teacher B — wrong for salary calculations and audit.

**Do not "clean up" snapshot fields** — they are not redundant. They are the historical record.  
For substitutions: `LessonSession.teacherId` overrides the snapshot (it's the *actual* teacher for that specific session).

---

## ADR-005: skipDuplicates: true is MANDATORY in createMany for sessions

**Decision:** `lessonSession.createMany()` always uses `{ skipDuplicates: true }`.

**Why:**  
`LessonSession` has `@@unique([lessonBlockId, date])`. A session may exist with `deletedAt != null` (soft-deleted). The unique constraint still applies to soft-deleted rows. When the server restarts, `extendAllBlockSessions()` runs and tries to create sessions — including dates that have soft-deleted sessions → **P2002 unique constraint error → unhandled rejection → process crash**.

`skipDuplicates: true` silently skips already-existing rows (including soft-deleted ones).

**Do not remove `skipDuplicates: true`** from any `lessonSession.createMany()` call.

---

## ADR-006: creditDeducted flag as idempotency guard

**Decision:** `Attendance.creditDeducted: Boolean` is the single source of truth for whether a credit was charged for a session attendance.

**Why not check LessonCreditLog instead?**  
`LessonCreditLog` is an append-only ledger — it can have both debit and credit entries for the same session (if teacher marks/unmarks multiple times). Querying it to determine "was credit charged net?" would require aggregation. The flag is O(1).

**Invariant:**  
- `creditDeducted = true` → a credit was deducted by Submit Attendance for this session/student and must not be deducted again.
- `creditDeducted = false` → no credit was deducted for this attendance row (for example `FROZEN`).
- **The flag must only be mutated inside `attendanceService.ts → markAttendance()`**.
- Attendance statuses are `PRESENT | ABSENT | LATE | FROZEN`. `PRESENT`, `ABSENT`, and `LATE` are chargeable attendance outcomes; `FROZEN` is not charged.

**No implicit refund:** Attendance status changes and cancellation do not silently refund credits. Sessions with `creditDeducted=true` are blocked from normal cancellation by ADR-026. Credit corrections must be explicit ledger/correction flows with audit context.

**Do not** write credit deduction logic outside `attendanceService.ts`.  
**Do not** manually set `creditDeducted` in a route handler.

---

## ADR-007: StudentGroup as the single source of truth for level/chapter

**Decision:** `StudentGroup.level` and `StudentGroup.chapter` are the canonical values. `LessonBlock` also has `level`/`chapter` fields, but these are **read-only caches** for search/filtering only.

**Why LessonBlock duplicates the fields?**  
Legacy: blocks previously stored level independently. The fields are kept for backward compatibility and so that `GET /api/schedule/available` can filter blocks by level for students without joining StudentGroup every time.

**Update rule:**  
When a group's level/chapter changes → update `StudentGroup` + all associated `LessonBlock` records in the same transaction.

**Client source of truth:**  
In `loadFromServer()`, `level`/`chapter` is taken from `block.studentGroup` first, then falls back to `block.level`. Never edit just the block-level field directly.

---

## ADR-008: notify.ts utilities — never raw Prisma for notifications

**Decision:** All notification creation goes through `notify.ts` (`notify()`, `notifyMany()`, `notifySchoolAdmins()`). Direct `prisma.notification.create()` is banned.

**Why:**  
- `notify.ts` enforces consistent data structure.
- It centralizes future changes (e.g., adding push notifications, email triggers).
- Raw inserts bypass any pre/post hooks or logging we might add.

**Current notify functions:**
```ts
notify(userId, schoolId, message, type?)         // single user
notifyMany(userIds[], schoolId, message, type?)   // bulk
notifySchoolAdmins(schoolId, message, type?)      // all ADMIN + OWNER of school
```

---

## ADR-009: findFirst instead of findUnique when adding extra filters

**Decision:** Use `prisma.model.findFirst()` when you need both a unique field AND additional `where` conditions (like `schoolId`, `deletedAt`).

**Why:**  
Prisma's `findUnique()` only accepts `where` with the exact unique constraint fields. Adding `schoolId: x` alongside `id: y` causes a TypeScript error. `findFirst()` accepts arbitrary where conditions and returns the first match.

**Pattern:**
```ts
// CORRECT
const block = await prisma.lessonBlock.findFirst({
  where: { id: blockId, schoolId: req.user.schoolId, deletedAt: null }
});

// WRONG — TypeScript error, can't add schoolId to findUnique
const block = await prisma.lessonBlock.findUnique({
  where: { id: blockId, schoolId: req.user.schoolId }
});
```

---

## ADR-010: JWT stored in localStorage (not httpOnly cookie) — SUPERSEDED, see ADR-022

**Original decision (superseded):** Auth token was stored in `localStorage`, not in an `httpOnly` cookie, so the PWA's Axios interceptor could read it without a cookie-based flow.

**Current state:** the access token now lives in memory only (`lib/api.ts`); the refresh token is an `httpOnly` cookie. See ADR-022 for the current design and why the localStorage risk this ADR originally accepted no longer applies. Left here for history — do not treat this ADR as describing current behavior.

---

## ADR-011: No microservices — monolithic Express + service layer

**Decision:** The backend is a single Express process with a service layer (`services/`), not microservices.

**Why:**  
- Current scale: 30+ schools, hundreds of users. No need for independent scaling of notification service vs scheduling service.
- Microservices would require a message broker, service discovery, distributed tracing — massive complexity for no measurable gain.
- The service layer (`sessionService.ts`, `attendanceService.ts`, `scheduleValidation.ts`) provides the same logical isolation without network overhead.

**When to revisit:** If a single school exceeds 10,000 concurrent users, or if the notification volume requires a dedicated worker.

---

## ADR-012: School.activeDays, workStart, workEnd, slotDuration as DB columns, not JSON

**Decision:** These scheduling configuration fields are separate DB columns on `School`, not stored inside `School.settings (Json)`.

**Why:**  
- These fields are queried in `scheduleValidation.ts` on every block create/update. Parsing JSON + extracting fields every validation is slower and less type-safe than column access.
- Prisma can generate proper TypeScript types for columns but not for JSON sub-keys.
- `syncTimeSlots()` re-generates `TimeSlot` records when these change — having them as indexable columns simplifies the trigger logic.

**`School.settings (Json)`** is for less-structured, rarely-queried config: `holidays`, `groupSize`, `customFields`.

---

## ADR-013: weekSessions as single source of truth for substitutions and cancellations

**Decision:** The client-side `weekSessions` state (loaded from `GET /sessions/week`) is the ONLY source for:
- Which teacher is substituting on which date
- Which sessions are cancelled

**Removed alternatives:**
- `localStorage setSubstitute / clearSubstitute` — removed 2026-05-06 (was dead code, never used)
- `permCanc` / `cancelled` localStorage override — legacy, kept empty, not written to

**Why:**  
localStorage overrides created a parallel state that could diverge from the server. After a page refresh, the server truth would win anyway — making the localStorage state useless and confusing.

**Consequence:** After any substitution or cancellation mutation, call `onReload()` + `loadWeekSessions()` to refresh from server. Never update `weekSessions` optimistically.

---

## ADR-014: "Soft Warning" pattern for conflict resolution

**Decision:** Scheduling conflicts (cabinet capacity, student double-booking, teacher workload) are returned from the backend as specific error strings starting with `WARNING_TYPE:`. The frontend catches these and prompts the user for an override via `window.confirm`.

**Why:**  
Administrative users often have "edge case" reasons to ignore a rule (e.g. "Teacher works today only as an exception" or "Student is doing a makeup class in parallel"). A hard block would frustrate them. 

**Pattern:**
1. Backend: `throw new ScheduleValidationError("TYPE_WARNING:Message")`.
2. Frontend: `if (msg.startsWith("TYPE_WARNING:")) { if(confirm(...)) trySave(override=true); }`.

**Consequence for AI:**
Always check for `override...` flags in scheduling route handlers. If the flag is true, bypass the corresponding validation check.

---

## ADR-015: "Self-Healing" synchronization via Manual Override Flags

**Decision:** `LessonSession` has `isManualTeacher`, `isManualCabinet`, and `isManualTime` flags.

**Why:**  
The `syncSessionsForBlock` service runs frequently (on every schedule update and via daily cron). If an admin manually changed a specific lesson's time or assigned a substitute, a naive sync would "reset" these back to the group's default. The flags ensure that manual human interventions are never overwritten by the automation.

**Rule:**
- Any manual edit via `PATCH /session/:id` must set the corresponding flag to `true`.
- The `syncSessionsForBlock` service must skip updating fields where the flag is `true`.

---

## ADR-016: Socket.IO JWT auth — same JWT as REST API

**Decision:** Socket.IO handshake uses the same JWT token as REST endpoints. Token is passed in `socket.handshake.auth.token`. Server validates it in `io.use()` middleware via `jwt.verify()`.

**Why not separate WebSocket auth?**  
Maintaining a separate token would require a separate auth flow and refresh logic. The JWT already encodes `userId`, `schoolId`, and `role` — everything needed for socket room assignment.

**Room isolation:** Each authenticated socket immediately `join`s `school:{schoolId}`. All `emitToSchool()` calls target a specific room — schools never see each other's events.

**Do not** call `emitToSchool()` before sending the HTTP response in the same route — otherwise the client receives the socket event before the `fetch()` promise resolves, causing a race condition in optimistic state updates.

---

## ADR-017: Redis cache — TTL-only, no active invalidation

**Decision:** Cache invalidation is TTL-based only. No write-through or explicit `cacheInvalidate()` calls on mutations.

**Why:**  
Analytics (`/overview`) is inherently "approximate" — a 60-second stale read is acceptable. Teacher calendar is per-month historical data — 120 seconds is fine. Active invalidation would require tracking every mutation that affects cached data, which adds coupling and failure modes.

**Exception:** If a cache key becomes stale enough to cause real user confusion (e.g. teacher sees their salary is wrong for 2 minutes after marking a lesson), switch to active invalidation for that specific key using `cacheInvalidate('prefix:*')`.

**Never cache:**
- Authentication responses (`/auth/me`)
- Credit balance (`StudentProfile.credits`) — stale balance = user sees wrong numbers
- Attendance per-session — teachers need real-time data when marking

---

## ADR-018: notify.ts wraps BullMQ queue with sync fallback

**Decision:** `notify()` / `notifyMany()` in `notify.ts` route through `enqueueNotification()` in `lib/queue.ts`. If Redis is unavailable, the queue is null and the function falls back to direct DB insert.

**Why:**  
At launch, Redis may not be configured (development, early production). The fallback ensures notifications work correctly without Redis — just synchronously on the request path. When Redis is added, the behavior upgrades transparently.

**Consequence for AI:**  
Do not call `prisma.notification.create()` directly. Do not add Redis-specific code to route handlers. Always go through `notify.ts`.

---

## ADR-019: Centralized permission model — no inline role checks in routes

**Decision:** All route-level authorization uses `requirePermission('permission:name')` middleware from `middleware/requirePermission.ts`. Inline `if (role !== 'OWNER')` checks are banned.

**Why:**  
Before Phase 10, five route files duplicated an `isAdminOrOwner()` helper — each with subtly different semantics. When a new permission requirement appeared (e.g. "ADMIN can adjust salary but cannot *pay* salary"), there was no single place to update.

**Permission matrix for new permissions (Phase 10):**

| Permission | OWNER | ADMIN | TEACHER | STUDENT |
|-----------|-------|-------|---------|---------|
| `salary:read` | ✅ | ✅ | ❌ | ❌ |
| `salary:write` | ✅ | ✅ | ❌ | ❌ |
| `salary:pay` | ✅ | ❌ | ❌ | ❌ |
| `groups:archive` | ✅ | ❌ | ❌ | ❌ |
| `data:import` | ✅ | ❌ | ❌ | ❌ |
| `finance:void` | ✅ | ❌ | ❌ | ❌ |
| `finance:refund` | ✅ | ❌ | ❌ | ❌ |

**Rationale for ADMIN exclusions:**  
- `salary:pay` — irreversible financial transfer; ADMIN handles day-to-day ops, not payroll disbursement.
- `groups:archive` — archiving/completing a cohort is a management decision with downstream effects on enrollments and billing.
- `data:import` — bulk import overwrites student/teacher data at scale; a mistake is hard to reverse.
- `finance:void` / `finance:refund` — these adjust revenue records; ADMIN can read finance but not alter finalized transactions.

**Frontend:** `usePermissions()` hook mirrors the same rules. `canPaySalary`, `canImport`, `canArchiveGroup` are derived from role. Components guard actions behind these flags — they do not call the server to check permissions.

**Do not:**
- Add inline `if (req.user!.role !== 'OWNER')` checks to route handlers.
- Duplicate `isAdminOrOwner()` helpers in new route files.
- Grant new OWNER-only permissions to ADMIN without updating this ADR.

*Last Updated: 2026-05-28 (ADR-021 Credit/Debt Model)*

---

## ADR-020: Tenant Isolation Hardening — assertion helpers in tenant.ts

**Decision:** Created `server/src/lib/tenant.ts` with `TenantNotFoundError` and seven `assertX()` helpers. All routes that touch a cross-tenant resource boundary (student, staff, block, payment, webhook, integration) call the relevant assertion helper before any mutation.

**Why 404, not 403:**  
Returning 403 leaks the existence of a foreign record. 404 gives an attacker zero information — the resource appears not to exist for them. This matches the principle of indistinguishable denial.

**Why assertion helpers, not Prisma `$extends`:**  
`$extends` would require rewriting or wrapping every Prisma query site and is a large blast-radius refactor. Point-fix assertion helpers are surgical: they touch only the routes with confirmed IDOR gaps, leave the rest of the codebase unchanged, and are trivially testable via real-DB integration tests.

**Helpers and ownership rules:**  
- `assertStudentBelongsToSchool(id, schoolId, tx?)` — via `StudentProfile.user.schoolId` relation (no direct schoolId column)  
- `assertStudentsBelongToSchool(ids[], schoolId, tx?)` — batch; throws if any student is foreign; resolves for empty array  
- `assertStaffBelongsToSchool(id, schoolId, tx?)` — via `StaffProfile.schoolId` direct column  
- `assertLessonBlockBelongsToSchool(id, schoolId, tx?)` — via `LessonBlock.schoolId`  
- `assertTeacherPaymentBelongsToSchool(id, schoolId, tx?)` — via `TeacherPayment.schoolId`  
- `assertWebhookBelongsToSchool(id, schoolId, tx?)` — via `Webhook.schoolId`  
- `assertIntegrationBelongsToSchool(id, schoolId, tx?)` — via `IntegrationConnection.schoolId`

**Transaction safety:**  
All helpers accept an optional `tx?: PrismaTx` parameter. When called inside `prisma.$transaction()`, the ownership check and the mutation share the same transaction — a cross-tenant assertion failure rolls back any writes that preceded it in the same tx.

**Routes fixed:**  
`salary.ts` (history, PATCH rate, DELETE pay, calculateNet scoping), `credits.ts` (POST /add studentProfile filter), `settings.ts` (webhook update/rotate, integration patch/disconnect), `schedule.ts` (PATCH status/approve/reject/add, POST students), `groups.ts` (POST /:id/students).

**Test coverage:**  
`server/src/__tests__/integration/tenantIsolation.test.ts` — 20 real-DB tests, all green. Covers: same-school resolves, cross-tenant throws, data integrity (no mutation on failed cross-tenant access), transaction rollback.

---

## ADR-021: Credit/Debt Model — credits < 0 is valid

**Decision:** `StudentProfile.credits` has no lower-bound DB constraint. Negative credits are valid and represent lesson debt.

**Credit balance semantics:**

| Value | Meaning |
|-------|---------|
| `credits > 0` | Prepaid lessons — student has unused credit |
| `credits = 0` | Neutral balance |
| `credits < 0` | Lesson debt — student attended more lessons than paid for |

**Why debt is allowed:**  
Language schools commonly operate on a deferred-payment model: a student attends classes, accumulates debt, then pays at the end of the month (or next billing cycle). Blocking negative credits at the DB level would prevent legitimate school operations and force workarounds.

**Phase 5 correction:**  
Phase 5 initially added `CHECK (credits >= 0)` — this was removed before merge (migration `20260528000000_phase5_correction_drop_credits_floor`). The precheck script now reports debt students as `WARNING` (finance review), not `BLOCKER`.

**Application-level guard (non-OWNER path):**  
The conditional SQL guard in `credits.ts` still prevents *accidental* overdraft for regular deductions:
```sql
UPDATE "StudentProfile"
SET credits = credits + <amount>
WHERE id = <id> AND (credits + <amount>) >= 0
```
If `rowsUpdated = 0` → throws `INSUFFICIENT_CREDITS` → HTTP 422.

**OWNER override (intentional debt):**  
`OWNER` or `SUPERADMIN` can bypass the application guard by providing `overrideReason` in the request body. This path calls `prisma.studentProfile.update({ data: { credits: { increment: amount } } })` directly, allowing negative balances. The reason is logged as `[OWNER_OVERRIDE: …]` in `LessonCreditLog` for audit.

**Future config (not yet implemented):**  
- `School.allowDebt: Boolean` — per-school toggle (default: true)
- `School.debtLimit: Int` — maximum allowed debt in credits (e.g. -10 means no more than 10 lessons in arrears)

When implemented, the application guard should check these fields before allowing debt accumulation.

**Do NOT:**
- Re-add `CHECK (credits >= 0)` to the DB schema.
- Auto-correct negative credits to 0 in any script or migration — this destroys real debt records.
- Treat `credits < 0` as a data error in precheck scripts.

---

## ADR-022: Access Token Storage — in-memory, 15m TTL (migration completed)

**Current decision:** The JWT access token lives in an in-memory variable in `lib/api.ts` (`let accessToken`) — never `localStorage`/`sessionStorage`. TTL is 15 minutes (`ACCESS_TOKEN_TTL` in `jwtSecret.ts`). The refresh token is a separate `httpOnly` cookie (`rt`, 30-day sliding expiry, rotated on every use). On page load, `AuthContext` calls `refreshAccessToken()` to reconstruct the access token from the refresh cookie — see `AuthContext.tsx` `initializeAuth()`.

**History:** this ADR originally (through Phase 6) documented localStorage storage as a known, accepted risk and explicitly deferred the memory-only migration described below as future work. That migration has since shipped — the "Migration path" steps that used to appear here are done, not pending. ADR-010 is superseded by this entry.

**Why this is safer than localStorage:** XSS on the same origin can no longer read a long-lived credential — the in-memory token is short-lived (15m) and gone on tab close; the refresh token is unreadable to JS (`httpOnly`) and CSRF-guarded (`requireTrustedOrigin` checks Origin/Referer on `/refresh` and `/logout`, since those two endpoints authenticate via cookie alone).

**Trade-off accepted:** every page load/reload does one extra round trip (`POST /auth/refresh`) before the app is usable, and the multi-tenant slug redirect on refresh failure reads `schoolSlug` from `localStorage` (non-sensitive, just used for routing).

**Do NOT:**
- Reintroduce storing the access token in `localStorage`/`sessionStorage`.
- Add an httpOnly cookie for the *access* token without removing the Axios `Authorization: Bearer` interceptor — a dual-path flow would create confusion and security gaps.
- Change `REFRESH_COOKIE_OPTS` (`sameSite`/`secure`) without keeping `/refresh` and `/logout`'s `set`/`clearCookie` calls using identical attributes, or the browser won't clear the cookie on logout.

---

## ADR-023: Observability Stack — Prometheus + Sentry + Structured Logging

**Decision:** Observability uses three complementary layers: prom-client for Prometheus metrics, Sentry for error capture with PII sanitization, and pino for structured JSON logs with AsyncLocalStorage-based context injection.

**Why pino mixin (not middleware):**  
Injecting `requestId`, `schoolId`, `userId` into every log line via a pino `mixin()` that reads from `AsyncLocalStorage` means all log lines from any code path (services, cron utilities, nested function calls) automatically include correlation context without explicitly passing it through every function signature.

**Request correlation flow:**
```
HTTP request → correlation middleware generates/echoes X-Request-ID
  → authenticate stores requestId in AsyncLocalStorage
  → Sentry.setTag('request_id', requestId)
  → pino mixin auto-includes requestId in every log line for this request
  → audit logSecurityEvent includes requestId in structured log + DB after field
  → X-Request-ID response header returned to client
```

**Cron observability:**  
`withCronLock()` wraps all cron jobs with `runWithObservability()` tracking `lastRunAt`, `lastDurationMs`, `lastStatus`, `consecutiveFailures`, `totalRuns` per job in memory. Exposed via `/health/deep`. Alert at 3 consecutive failures.

**Do NOT:**
- Remove `mixin()` from pino — it provides automatic context on every log line.
- Expose `/metrics` to the public internet — it reveals server internals. Must be behind VPC/internal network.
- Change Sentry `beforeSend` to not strip `REDACTED_HEADERS` — those headers contain auth tokens.

---

## ADR-024: Recovery Tools — SuperAdmin-Only with Mandatory Reason + Audit Trail

**Decision:** All incident-response recovery operations (invalidate-sessions, force-disable webhook, cleanup stuck idempotency keys, subscription override) are SuperAdmin-only endpoints requiring a `reason` field (min 5 chars) and always log to both structured logs and `ScheduleActionLog`.

**Why mandatory reason:**  
Recovery tools are out-of-band operations. Without a reason, the audit log entry is meaningless for post-incident review.

**Why tokenVersion bump (not session table):**  
There is no session table — JWT is stateless. Bumping `tokenVersion` invalidates all outstanding JWTs. Refresh tokens are also revoked so the client cannot silently re-authenticate.

**Do NOT:**
- Add recovery tools accessible to OWNER or ADMIN — these are break-glass operations for the platform operator only.
- Remove the `reason` validation — it prevents accidental invocation.

---

## ADR-025: Deployment Safety — Scripts over Manual Checklists

**Decision:** All deployment gates are automated scripts (`validate-env.ts`, `migrate-check.ts`, `smoke-test.ts`, `verify-backup.ts`) integrated into `package.json` as `npm run predeploy` / `npm run postdeploy`. Manual checklists supplement but do not replace them.

**Why scripts, not just markdown checklists:**
Manual checklists get skipped under pressure. Scripts are fast (< 30 seconds per check), give a clear exit code, and can be run by CI/CD without human judgment. A failed exit code blocks the deploy pipeline before any damage occurs.

**validate-env.ts — why production-mode checks:**
The server already validates `DATABASE_URL` and `JWT_SECRET` at startup in `index.ts`. The pre-deploy script validates BEFORE the deploy happens, catching misconfigurations earlier (e.g., in CI before the binary is even built).

**migrate-check.ts — why query DB directly, not `prisma migrate status`:**
`prisma migrate status` prints human-readable text that is hard to machine-parse. Querying `_prisma_migrations` directly gives structured data (finished_at, rolled_back_at, logs) that the script can reason about. Exit code 1 on any anomaly (pending, stuck, rolled-back) blocks the deploy gate.

**smoke-test.ts — why not use integration tests for this:**
Integration tests run against a test DB and are not a live-server check. Smoke tests hit the actual production URL post-deploy and verify the real server, real DB connection, and real process is up. They are the last gate — if smoke fails after deploy, rollback immediately.

**verify-backup.ts — added pg_dump + writable target checks:**
Backup scripts that never actually test the pg_dump binary or write to the backup directory fail silently at 3am. The two new checks (pg_dump available, BACKUP_DIR writable) catch configuration drift before the daily backup window.

**Rollback strategy in DEPLOYMENT.md — why explicit migration rollback table:**
The most dangerous deploy mistake is rolling back code without considering whether the schema change was backward-compatible. The decision matrix in DEPLOYMENT.md forces the operator to choose the correct rollback path based on the type of schema change, preventing silent data corruption.

**Do NOT:**
- Remove the `predeploy` / `postdeploy` npm hooks — they are the automation layer.
- Add `--skip-env-check` or similar bypass flags to validate-env.ts — the whole point is an unconditional gate.
- Treat smoke test advisory failures (Redis, metrics) as critical — only `critical: true` tests block the deploy.

---

## ADR-026: Cancel Guard — BLOCK, Not Auto-Refund

**Decision:** When a session has any `Attendance.creditDeducted=true` record, cancellation is blocked with `409 SESSION_HAS_DEDUCTED_CREDITS`. Credits are NOT automatically refunded as a side effect of cancellation.

**Why BLOCK, not auto-refund:**

1. **`creditDeducted` is write-once by design.** `businessInvariants.ts` explicitly documents that the flag is a "ONE-WAY flag. Once true, it NEVER goes back to false." Auto-refund would require either violating this invariant or implementing a parallel reversal mechanism — both add hidden complexity inside a status transition.

2. **Audit trail integrity.** A credit deduction generates a `LessonCreditLog` entry. Reversing it must also produce an audit entry with an actor, a reason, and a timestamp. A silent side effect inside `changeSessionStatus()` cannot produce this without a reason string from the operator.

3. **Financial atomicity.** Credit correction and session cancellation are two separate financial events. Bundling them hides the refund from the credit ledger view. Operators need to see explicitly that credits were returned and why.

4. **Prevents accidental mass refunds.** Bulk-cancel is a high-impact operation. If auto-refund were in place, a single bulk-cancel call could silently drain school revenue by refunding credits for dozens of sessions. BLOCK forces deliberate action.

**Correct operator flow:**
1. Open the correction flow (separate task) — issue manual credit adjustment per affected student.
2. Then cancel the session (guard will pass once no `creditDeducted=true` records exist, or the correction is logged separately).

**Guard location:** `assertNoCreditDeductedAttendance()` in `scheduleLifecycleService.ts`, called from `changeSessionStatus()` before the DB write. Covers both `PATCH /session/:id/status` and `POST /sessions/bulk-cancel` (both route through `changeSessionStatus`).

**Do NOT:**
- Add auto-refund logic inside `cancelSession()` or `changeSessionStatus()`.
- Remove or bypass `assertNoCreditDeductedAttendance()` to "simplify" cancellation.
- Treat `creditDeducted=true` → CANCELLED as a non-issue — reconciliation R2 flags this as CRITICAL.

---

## ADR-027: Finance dashboard income = Payment ∪ StudentPayment (credit top-ups read-only)

**Decision:** The owner/admin finance dashboard counts income from **both** payment systems: real `Payment` records **and** legacy `StudentPayment` credit top-ups (written by `POST /credits/add` when adding credits with a payment amount). Credit top-ups are surfaced via `GET /payments?includeCredits=true`, mapped to the Payment shape with `source: 'CREDIT_TOPUP'`, and are **read-only** (no void/refund buttons).

**Why:**
1. **Two write paths, one ledger view.** Money enters via two flows — the invoice/`Payment` flow (`receivedById`) and the credit top-up flow (`StudentPayment.createdById`). The dashboard previously read only `Payment`, so top-ups (the common path for schools) showed as zero income. Surfacing both is what "all money received" means to the operator.
2. **Read-only, not unified at write time.** We did **not** make credit top-ups also create a `Payment` row. That would touch the financial write path (double-entry, idempotency) and risk double-counting historic rows. Merging at read time is reversible and zero-risk to stored data.
3. **No void/refund on top-ups.** `StudentPayment` has no status/void concept; corrections happen through the credit ledger (`LessonCreditLog`). The dashboard gates action buttons on `source !== 'CREDIT_TOPUP'` so a void can never hit the wrong table (ids overlap across the two tables — React keys are `${source}-${id}`).

**Known limitation:** a top-up later refunded through the credit ledger (negative `LessonCreditLog`) does not void its `StudentPayment`, so it still counts as gross income. Acceptable until net income is required.

**Do NOT:** read `StudentPayment` as income without the `source` discriminator, or render void/refund controls for `CREDIT_TOPUP` rows.

---

## P0 Architecture Closure (2026-06-10)

### Decision: getEffectiveSessionTeacherId as the single SOT for session teacher

**Problem:** Two paths existed to determine who teaches a session — `teacherId` (current/substitute) and `teacherIdSnap` (snapshot at creation). Code across the codebase inconsistently read one or the other.

**Decision:** `getEffectiveSessionTeacherId(session)` in `sessionService.ts` is the one canonical resolver. Rule: if `isManualTeacher=true`, use `teacherId` (operator-assigned substitute); otherwise use `teacherIdSnap` (immutable snapshot from block teacher at session creation time). `teacherIdSnap` is self-healed in `syncSessionsForBlock` when the block teacher changes.

**Do NOT:** Read `session.teacherId` directly to determine who teaches. Always use `getEffectiveSessionTeacherId`.

---

### Decision: validateSessionDate as the single SOT for working date validation

**Problem:** `ensureSingleSession` (on-demand path) bypassed `ScheduleException` checks — only the cron path (`syncSessionsForBlock`) checked exceptions. Legacy holidays in `settings.holidays` JSON were only checked in one path.

**Decision:** `validateSessionDate` in `sessionService.ts` is the single owner for all date validity checks. It checks: block day-of-week, block date range, legacy `settings.holidays`, AND `ScheduleException` (DB-backed). `ensureSingleSession` passes `blockContext` so scope-filtered exceptions (teacher/cabinet/group) are respected.

**Do NOT:** Add exception or holiday checks outside `validateSessionDate`. Do not create a second validation path.

---

### Decision: rosterService.ts owns all SessionStudent amendments

**Problem:** `POST /:id/students` and `DELETE /:id/students/:id` in `groups.ts` contained inline SessionStudent add/remove logic with no attendance guard on remove. Ghost students could accumulate in completed sessions.

**Decision:** `rosterService.ts` is the single write boundary for SessionStudent amendments. `reconcileRosterOnMemberAdd`: adds to UPCOMING sessions only. `reconcileRosterOnMemberRemove`: removes from UPCOMING sessions only, with attendance guard — sessions where `Attendance` already exists are protected (not removed). Route handlers delegate entirely to rosterService.

**Do NOT:** Write to `SessionStudent` directly from route handlers. Do not bypass rosterService for group membership changes.

---

### Decision: blockStateMachine.ts as the formal state machine for LessonBlock status

**Problem:** Block status transitions were implicit. COMPLETED/CANCELLED blocks could still generate sessions via cron or direct call to `syncSessionsForBlock`.

**Decision:** `blockStateMachine.ts` defines formal transitions with role gates. `blockAllowsSessionGeneration(status)` is the guard: UPCOMING=true, COMPLETED/CANCELLED=false. `syncSessionsForBlock` calls `getBlockSessionCreationBlocker` and returns `{ skipped: true }` for terminal statuses. `extendAllBlockSessions` (cron) queries only `status='UPCOMING'` blocks.

**Do NOT:** Generate sessions for COMPLETED or CANCELLED blocks. Do not bypass `blockAllowsSessionGeneration`. Restoring a block from COMPLETED/CANCELLED to UPCOMING requires OWNER role.

---

### Decision: ScheduleActionLog uses onDelete: SetNull (not Cascade) for block/session FKs

**Problem:** `ScheduleActionLog.blockId` and `.sessionId` had `onDelete: Cascade` — deleting a block or session silently deleted all associated audit logs, destroying the compliance trail.

**Decision:** Both FKs changed to `onDelete: SetNull`. When a block is hard-deleted, `blockId` is set to NULL but the log row survives. The action, reason, userId, and createdAt are preserved. This is a compliance requirement — audit trail must survive entity deletion.

**Migration:** `20260610120000_audit_log_set_null_on_delete` — applied to both dev and test databases.

**Do NOT:** Change ScheduleActionLog FK referential actions back to Cascade. Do not rely on blockId/sessionId being non-null in audit queries — always handle NULL as "entity was deleted".

---

### ADR-027: Freeze Cancellation — Prospective Only

**Problem:** When an admin cancels an active freeze via `cancelAllActiveFreezes()`, there was no documented design contract for how historical FROZEN attendance records should be treated. A plausible (but wrong) reading was that cancelling a freeze should retroactively "unfreeze" past sessions and trigger credit deductions for them.

**Decision:** Freeze cancellation is **prospective only**. Cancelling a freeze:
- Sets `StudentFreeze.status = 'CANCELLED'` and `StudentProfile.isFrozen = false`
- Does NOT touch any `Attendance` records (FROZEN or otherwise)
- Does NOT deduct credits for sessions that were marked FROZEN during the freeze window
- Does NOT regenerate SessionStudent rows for past sessions

Historical FROZEN attendance records remain immutable — their `creditDeducted = false` flag is a permanent write-once record that reflects the state at the time the attendance was marked.

**Why prospective-only:**

1. **`creditDeducted` is write-once.** `businessInvariants.ts` documents: "ONE-WAY flag. Once true, it NEVER goes back to false." FROZEN attendance has `creditDeducted = false`. Retroactively deducting credits for past FROZEN sessions would require either violating this invariant or creating a back-dated correction — both require an explicit operator action with an audit trail.

2. **Time semantics.** A freeze covers a defined period. An admin cancelling the freeze today does not change the historical fact that a student was frozen last week. The system's job is to accurately record what happened, not to revise history.

3. **Financial audit integrity.** Retroactive credit deductions are a financial event and must be recorded in `LessonCreditLog` with a reason and actor. Silent retroactive deductions inside `cancelAllActiveFreezes()` would produce unattributed ledger entries.

4. **Billing period boundaries.** Salary and credit accounting may have already closed for past periods. Retroactive changes would corrupt closed billing periods without a correction flow.

**Correct operator flow for retroactive correction:**
1. Cancel the freeze (prospective — stops future sessions from being FROZEN).
2. For historical FROZEN sessions where credit should be collected: use the explicit OWNER credit correction flow (manual credit adjustment + `LessonCreditLog` entry with reason).

**Implementation:** `cancelAllActiveFreezes()` in `freezeService.ts` (lines ~563–622) implements this correctly — it updates `StudentFreeze.status` and `StudentProfile.isFrozen`, and does nothing else.

**Do NOT:**
- Add retroactive attendance correction logic to `cancelAllActiveFreezes()`.
- Add retroactive credit deduction to the freeze cancellation path.
- Interpret a FROZEN attendance record as "credit not yet owed" — it means "credit was intentionally not collected because the student was frozen at that time".

---

### ADR-028: `isAttendanceAllowed()` is the canonical gate for attendance submission

**Problem:** `sessionStateMachine.ts` exported `isAttendanceAllowed(status)` (returns true only for `IN_PROGRESS` and `COMPLETED`), but `attendanceService.ts::markAttendance()` had its own inline check that only blocked `CANCELLED` and `INVALIDATED`. The two diverged: `UPCOMING` and `LOCKED` sessions could have attendance submitted and credits deducted.

**Decision:** `isAttendanceAllowed()` from `sessionStateMachine.ts` is the **single source of truth** for whether a session can accept attendance. `markAttendance()` calls it as its first status guard.

**Consequences:**
- `UPCOMING` sessions: attendance blocked until the session transitions to `IN_PROGRESS`.
- `LOCKED` sessions: attendance permanently blocked (LOCKED = salary paid, session closed).
- `COMPLETED` sessions: attendance accepted (teachers may finalize after class ends).
- `IN_PROGRESS` sessions: attendance accepted (live marking).

**Why this matters for credits:** `markAttendance()` deducts credits atomically. Accepting attendance on `UPCOMING` would deduct credits before the lesson happens. If the session is later cancelled (blocked by `assertNoCreditDeductedAttendance` when `creditDeducted = true`), the school cannot cancel and must issue a manual correction. At scale, this creates an unrecoverable correction backlog.

---

### ADR-029: `restoreSession()` is blocked when an active makeup exists

**Problem:** Before this fix, restoring a CANCELLED session that had an active (non-CANCELLED) makeup session produced two simultaneously UPCOMING sessions for the same educational slot. Both sessions would show on student schedules, both could have attendance marked, and both would deduct credits — a double-billing invariant violation.

**Decision:** `restoreSession()` performs a pre-flight query for non-CANCELLED makeup sessions (`makeupForSessionId = sessionId, status != CANCELLED`). If any exists, it throws `ACTIVE_MAKEUP_EXISTS` (409). The admin must cancel the makeup first, then restore the original.

**Invariant:** At any point in time, for a given original session ID, there is at most ONE non-CANCELLED session reachable from it (either the original UPCOMING, or a makeup UPCOMING — never both).

**Why pre-flight (not inside transaction):** The existing optimistic lock (`version` guard) on the session row already serializes concurrent restores at the DB level (P2025 if two requests race). The F-02 check is a semantic guard, not a concurrency guard. Pre-flight is sufficient and avoids nested transaction complexity.

---

### ADR-030: LESSON_SKIP freeze is cancelled when its target session is cancelled

**Problem:** `createFreeze(type=LESSON_SKIP)` requires the target session to be `UPCOMING`. If admin subsequently cancels the session, the LESSON_SKIP freeze has no effect (attendance on `CANCELLED` sessions is blocked) but remains `ACTIVE` indefinitely. `StudentProfile.isFrozen` stays `true`, creating a permanently stale legacy cache.

**Decision:** `changeSessionStatus()` (in the `targetStatus === CANCELLED` branch) cancels all `ACTIVE` LESSON_SKIP freezes targeting the cancelled session via `studentFreeze.updateMany`. It then re-evaluates `StudentProfile.isFrozen` for each affected student and clears it if no other `ACTIVE` freezes remain.

**Scope:** Only `LESSON_SKIP` freezes are affected. `PERIOD` freezes covering the session's date remain active (they cover a date range, not a specific session, and may cover future sessions in that range).

**Financial impact:** None. LESSON_SKIP freezes target sessions that are now `CANCELLED`. No credits were ever deducted for cancelled sessions (blocked by `assertNoCreditDeductedAttendance`). The cleanup is purely a data hygiene and UI correctness operation.

**Implementation:** `scheduleLifecycleService.ts::changeSessionStatus()` — runs using the same `client` passed to the function (participates in the caller's transaction context if one exists).

---

### ADR-031: `changeSessionStatus()` wraps all side-effects in a single `$transaction()`

**Problem:** `changeSessionStatus()` performed three sequential DB writes (session update → audit log → LESSON_SKIP freeze cleanup + isFrozen sync). A crash between any two left the DB in a partially-written state: e.g., session marked `CANCELLED` but LESSON_SKIP freezes still `ACTIVE` (zombie freezes), or session cancelled but isFrozen not cleared.

**Decision:** All four writes are wrapped in a single `$transaction()`. The function detects whether the caller already provided a transaction client via `typeof (client as any).$transaction === 'function'`. If yes — new transaction. If no (already inside a transaction) — the writes run in the existing one.

**Why detect rather than always wrap:** Prisma does not support nested `$transaction()` calls. Callers like `restoreSession()` already wrap in their own transaction and pass a `DbClient`. Calling `$transaction()` again on a transaction client would throw at runtime.

**Financial impact:** None directly. The correctness gain is prevention of zombie freezes and stale `isFrozen` legacy cache.

**Implementation:** `scheduleLifecycleService.ts::changeSessionStatus()`. Notifications and Socket.IO emits remain outside the transaction (best-effort side-effects).

---

### ADR-032: `validateSessionTimeBounds()` is the canonical SOT for working-hours validation

**Problem:** `moveSession` and `rescheduleSession` both checked whether a new session time fell within `School.workStart`/`workEnd`, but each implemented its own inline comparison — two diverging copies of the same rule.

**Decision:** `scheduleValidation.ts::validateSessionTimeBounds(prisma, schoolId, startTime, endTime)` is the single source of truth. It fetches `workStart`/`workEnd` from DB, compares HH:mm strings lexicographically (ISO format makes this safe), and returns `{ valid: true }` or `{ valid: false, reason }`. Both `rescheduleSession` and `moveSession` call it; violation throws 422 `TIME_OUTSIDE_WORKING_HOURS`.

**Why lexicographic comparison:** HH:mm strings in ISO format (`"08:00"`, `"20:00"`) compare correctly as plain strings. No date parsing or timezone handling needed. The values are already stored as HH:mm in the DB schema (`School.workStart String @default("08:00")`).

**Implementation:** `scheduleValidation.ts` (added function), `scheduleLifecycleService.ts` (both callers updated).

---

### ADR-033: `markAttendance()` acquires FOR UPDATE lock on StudentProfile before freeze check

**Problem:** A TOCTOU race existed between `markAttendance` and `createFreeze`/`createOpenEndedFreeze`. Under `READ COMMITTED` isolation (PostgreSQL default), a freeze created by a concurrent transaction would not be visible to the attendance transaction's `findActiveFreeze` query if the freeze committed after the attendance transaction's snapshot. Result: credit deducted despite an active freeze.

**Decision:** `markAttendance` (inside the `wantDeduct` block, before `findActiveFreeze`) executes `SELECT id FROM "StudentProfile" WHERE id = $id FOR UPDATE`. Both `createFreeze` and `createOpenEndedFreeze` already hold the same lock on the same row inside their transactions. This creates a total order: either the freeze transaction completes before attendance acquires the lock (freeze visible → skip deduction), or attendance acquires the lock first (deduction proceeds, freeze blocked until attendance commits).

**Why service layer, not route layer:** The route handlers also had a `FOR UPDATE` as defence-in-depth, but that made the invariant fragile — dependent on the caller. Moving the lock into `markAttendance` makes the invariant self-contained regardless of how the service is called.

**Invariant enforced:** `ACTIVE FREEZE ⇒ NO CREDIT DEDUCTION`.

**Implementation:** `attendanceService.ts` line 80. Lock is only acquired when `wantDeduct = true` (no active `creditDeducted` flag), so idempotent re-submissions (already deducted) skip the lock entirely.

---

## Balance is the single source of truth; `paidUntil` is derived (2026-06-19)

**Problem:** A student stayed «просрочено» on the Students page even after paying. Two
conflicting overdue definitions existed — the client compared `paidUntil < today`, the server
compared `credits <= 0` — and **no payment path ever advanced `paidUntil`** (only CSV import did),
so the displayed status was permanently stale.

**Decision:** `StudentProfile.credits` (lesson balance) is the **only** source of truth for
payment status. `StudentProfile.paidUntil` becomes a **derived, display-only** calendar date,
recomputed from the balance on every balance-changing event. Overdue is defined identically in
both billing modes — `!isFrozen && credits <= 0` — so client and server can never disagree.

**Why `billingMode` only changes the projection, not the status:** the product owner wants the
displayed "paid until" date to reflect the balance, with two interchangeable presentations.
`SchoolFinanceConfig.billingMode` selects the **formula** that turns the balance into a calendar
date; it does **not** change what "overdue" means.
- `PER_LESSON` — walk the student's real upcoming `LessonSession` schedule, consuming one session
  per credit (1 credit = 1 lesson). The credits-th upcoming session is the last paid lesson.
  When credits exceed the known horizon, extrapolate by weekly cadence (sum of active
  `LessonBlock.days` lengths). No schedule at all → `paidUntil = null`, status still from credits.
- `CALENDAR_MONTH` — `paidUntil = today + (credits × pricePerLesson ÷ basePrice)` months. Integer
  months via calendar arithmetic; the fractional remainder is rounded to whole days of the target
  month (documented rounding rule, avoids ±1-day drift complaints).

**Why derive purely from current credits (not "advance from max(paidUntil, today)"):** deriving
from the balance alone makes the operation **idempotent** — backfill, a live payment, and a
mode-toggle recompute all produce the same date for the same balance. There is no path-dependence
to drift out of sync. This is why the single helper `recomputeAndPersistPaidUntil()` serves all
call sites.

**Why money math uses `Prisma.Decimal`:** credit balances and prices are financial data; floats
are forbidden (mirrors `paymentService.recomputePaidAmount`). Conversion to whole days/months
happens only at the final step. Dates are anchored at UTC noon, matching the `LessonSession` date
sentinel (`tzUtils.ts`); "today" is computed in the school's timezone.

**Frozen students:** `isFrozen` suppresses overdue and is honoured by the derivation. (`StudentFreeze`
remains the real source of truth for freeze state per CLAUDE.md; `isFrozen` is the legacy cache.)

**Implementation:** `lib/paidUntilDerivation.ts` (`deriveStatus` pure fn + `recomputeAndPersistPaidUntil`
+ `recomputePaidUntilForSchool`). Wired into `creditIssuanceService.ts` (issue + reverse),
`routes/credits.ts` (`POST /add`), `routes/settings.ts` (`PATCH /finance` toggle). One-time
backfill: `scripts/backfill-paid-until.ts`.


---

## Secrets are default-denied at the Prisma client (2026-06-27)

`lib/prisma.ts` sets a global `omit` for `User.password`, `User.totpSecret`, and
`User.backupCodes` — these scalar fields **never load** from any query unless that query
explicitly opts back in with `omit: { <field>: false }`. The only opt-in sites are the
legitimate readers: login (`auth.ts`), password change (`users.ts`), and 2FA verify/setup
(`2fa.ts`).

**Why:** there is no central user serializer — every endpoint hand-picks fields after fetching
whole `User` rows. That is one careless `res.json(user)` / `...user` spread away from leaking a
password hash or TOTP secret. A default-deny at the client makes the safe behaviour automatic for
all current and future code.

**Why the export is cast to the base `PrismaClient` type** (`export default prisma as unknown as
PrismaClient`): a global `omit` changes the client's generic type, which would otherwise ripple
through every `DbClient`/`PrismaReader` helper that annotates a param as the vanilla client. The
omit is a **runtime** guarantee (results are stripped regardless of the static type), so exporting
the base type avoids touching ~10 financial/schedule service signatures for pure type plumbing.
Trade-off: the compiler no longer flags a *new* secret reader that forgets to opt in — at runtime
such a read returns `undefined` (fails closed, no leak) and surfaces in testing.

## Read endpoints that returned data to the wrong audience (2026-06-27)

- `GET /api/settings` (full school config blob — pixels, attribution, holidays) was `authenticate`
  only; now `requirePermission('settings:read')`. Students/teachers read narrow endpoints
  (`/settings/timeslots`, `/settings/help`) instead.
- `GET /api/students` (paginated roster incl. classmates' email/phone/credits/paidUntil) was
  `authenticate` only; now `requirePermission('students:read')` so a STUDENT cannot enumerate the
  roster. The self endpoints `/students/me/*` remain `authenticate`-only by design.

## "Итого выплачено" now includes ADVANCE adjustments — display-only (2026-08-18)

**Decision:** `FinanceDashboard.tsx`, `SalaryHistory.tsx`, and `SalaryPayslip.tsx` now compute
"Итого выплачено" (total paid) as `totalPaidAmount + advances` instead of `totalPaidAmount` alone.
`remainingAmount` is **deliberately left untouched**.

**Why:** `server/src/routes/salary.ts` already treats an ADVANCE `SalaryAdjustment` as money the
staff member has actually received — `monthNet = bonuses - fines - advances` is subtracted before
`remainingAmount` is computed (`remainingAmount = unpaidLessonsCount * rate + (monthNet -
appliedAdjustmentNet(confirmedPayments))`). Advances were therefore always correctly reducing what
still needs to be paid, but they were invisible in the "paid" total shown to the owner — a staff
member who had taken a full month's pay as an advance and zero `TeacherPayment` rows looked, on
screen, like they'd been paid nothing at all. Adding `advances` to the *displayed* paid total closes
that gap without touching the underlying computation: `remainingAmount` already has advances backed
out of it server-side, so changing it too would subtract the same advance twice.

**Not changed:** the `SalaryAdjustment` ledger itself, and the server's `remainingAmount`/`monthNet`
calculation — this is a client-side presentation fix only.

**Do NOT:** subtract `advances` from `remainingAmount` on the client, or otherwise adjust it to
"match" the new paid total — it is already advance-aware server-side, and doing so would double-count.

## Multi-device login — dropped the single-active-session revoke (2026-08-19)

**Decision:** `issueRefreshCookie()` in `auth.ts` and `invites.ts` no longer revokes a user's other
active `RefreshToken` rows when issuing a new one. Logging in from a second tab/browser/device now
leaves existing sessions alone instead of killing them.

**Why:** every login revoked all other refresh tokens for that user. The next time an already-open
tab's 15-minute access token expired (routine, not an attack), its silent `/auth/refresh` call
presented the now-revoked cookie. Outside the 5s same-tab race window, `/refresh`'s reuse-detection
treated that as token theft and revoked the entire session tree, forcing an unrelated hard logout.
Users expect persistent, multi-tab/multi-device login (this is what they compare against social
apps/YouTube) — a fresh login elsewhere silently nuking a legitimate open tab is the opposite of that.

**What still protects against token theft:** refresh-token rotation on every use, plus
reuse-detection (a revoked token presented again outside the grace window still revokes the full
session tree for that user — see `/auth/refresh` in `auth.ts`) — unchanged. `tokenVersion` bump on
password change / role change / user deletion (`users.ts`, `auth.ts` reset-password) still forces
re-auth everywhere immediately, independent of this policy.

**Consequence:** `RefreshToken` rows are no longer pruned as a side effect of login. Added a daily
`cleanupExpiredRefreshTokens` cron job (`cronJobs.ts`) that deletes expired rows and revoked rows
older than 30 days, so the table doesn't grow unbounded at 50k+ users.

**Do NOT** reintroduce a login-time "revoke all other sessions for this user" call without an
explicit product decision to bring back single-session enforcement — it directly conflicts with the
persistent multi-device login behavior this change exists to provide.
