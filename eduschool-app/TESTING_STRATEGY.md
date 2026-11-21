# TESTING_STRATEGY.md — Shamdan

> **Purpose:** Testing philosophy, manual test cases for critical flows, regression checklists, and AI-assisted testing guidance.  
> This document contains historical testing strategy notes. Current test coverage and execution status should be verified from recent test reports and CI results.

> Some status lines may be outdated. Use current test reports and `../CLAUDE.md` workflow gates for merge readiness.

*Last Updated: 2026-08-02*

---

## Current Automated Test Notes

Backend integration tests run sequentially against PostgreSQL:

```bash
cd eduschool-app/server
npm run test:integration -- --runInBand
```

The full integration suite can take slightly more than 10 minutes on a local
runner. Use an outer timeout above 10 minutes; GitHub Actions currently gives
the integration step a 20-minute budget. Do not use `--forceExit` as the normal
solution, because a clean run should exit after Jest prints its summary.

On Windows, if an integration run is interrupted by an outer timeout, check for
orphaned Jest/Node processes before retrying. A targeted inspection command is:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'node|npm|npx' -and $_.CommandLine -match 'test:integration|jest' } |
  Select-Object ProcessId, Name, CommandLine
```

Stop only the matching test processes you own before rerunning the suite.
Orphaned test processes can keep database locks open and cause flaky deadlocks
in later runs.

---

## Historical State Snapshot

This snapshot is retained for historical context only. Do not use it as the current source of truth for test coverage.

Earlier planning prioritized manual regression first while the domain logic was evolving. Current test status must be checked from the latest local run, CI result, or PR report.

---

## Testing Priority Order (When Adding Tests)

### Priority 1 — Credit Engine (attendanceService.ts)

The most financially critical code. Unit test all state transitions:

```ts
// Test cases for markAttendance():
test('ABSENT → PRESENT: deducts 1 credit, sets creditDeducted=true')
test('PRESENT → ABSENT: refunds 1 credit, sets creditDeducted=false')
test('PRESENT → PRESENT: no-op (idempotent)')
test('ABSENT → ABSENT: no-op (idempotent)')
test('LATE → ABSENT: refunds 1 credit')
test('ABSENT → LATE: deducts 1 credit')
test('marks attendance twice PRESENT: only 1 credit deducted total')
```

### Priority 2 — Session Generation (sessionService.ts)

```ts
// Test cases for getSessionDates():
test('generates correct dates for Mon/Wed block')
test('respects startDate and endDate bounds')
test('skips holidays')
test('correctly maps UTC day index (0=Mon, not 0=Sun)')
test('UTC noon rule: all dates are set to T12:00:00Z')

// Test cases for syncSessionsForBlock():
test('creates sessions up to ROLLING_DAYS horizon')
test('does not recreate CANCELLED sessions')
test('deletes UPCOMING sessions no longer in desired set')
test('uses skipDuplicates — no P2002 on duplicate call')
```

### Priority 3 — Schedule Validation (scheduleValidation.ts)

```ts
test('rejects blocks on non-working days')
test('rejects GRAMMAR block without teacher')
test('allows SPEAKING_CLUB without teacher')
test('detects cabinet time conflict (same days + overlapping times)')
test('allows Grammar + Club of SAME group in same cabinet — not a conflict')
test('detects teacher conflict across different groups')
test('allows one teacher to teach Grammar + Club of SAME group — not a conflict')
test('CAPACITY_WARNING prefix when students > cabinet capacity')
test('overrideCabinetConflict bypasses cabinet conflict (not teacher conflict)')
```

### Priority 4 — Multi-tenancy

```ts
test('school A cannot read school B blocks')
test('schoolId from JWT always overrides body schoolId')
test('deleted school cannot login after grace period')
```

---

## Manual Regression Checklist

Run before every production deploy. Each section is a critical flow.

### ✅ Auth Flow

- [ ] Login with valid credentials → gets JWT token
- [ ] Login with invalid password → error message shown
- [ ] Login with blocked school (past grace period) → 403 error
- [ ] Login with school in grace period (< 7 days) → login succeeds + warning banner visible
- [ ] Page refresh → session restored from localStorage via `/api/auth/me`
- [ ] Logout → token cleared, redirected to login

### ✅ Schedule Grid (WeekGrid)

- [ ] Grid shows correct blocks for current week
- [ ] Blocks display on correct days (Monday = column 0)
- [ ] Sessions outside 14-day window not shown
- [ ] Cancelled session shows as cancelled (strikethrough/grey)
- [ ] Substituted teacher shows substitute name (not original)
- [ ] Creating a new block → appears in grid immediately (after reload)
- [ ] Deleting a block → disappears from grid

### ✅ Session Generation

- [ ] Create a new block → sessions generated for next 14 days
- [ ] Manually check DB: sessions have `date = T12:00:00.000Z` (UTC noon)
- [ ] Holiday dates skipped in session generation
- [ ] Server restart → `extendAllBlockSessions()` runs without crash
- [ ] No duplicate sessions created on server restart (`skipDuplicates` working)

### ✅ Attendance & Credit Engine 🔥 CRITICAL

- [ ] Mark student PRESENT → credit balance decrements by 1
- [ ] Check `Attendance.creditDeducted = true` in DB
- [ ] Check `LessonCreditLog` entry created with `amount = -1`
- [ ] Change PRESENT → ABSENT → credit balance increments by 1
- [ ] Check `Attendance.creditDeducted = false` in DB
- [ ] Check `LessonCreditLog` refund entry created with `amount = 1`
- [ ] Mark PRESENT twice (rapid clicks) → only 1 credit deducted (idempotent)
- [ ] Mark LATE → credit deducted (same as PRESENT)
- [ ] Student with 0 credits → can still be marked (no credit validation on server)

### ✅ Teacher Substitution

- [ ] Assign substitute teacher to session → `weekSessions` updated after reload
- [ ] WeekGrid shows substitute name for that specific date
- [ ] Original block still shows original teacher for other dates
- [ ] Student notification sent when substitute assigned
- [ ] Conflict: teacher has another class at same time → 409 error shown

### ✅ Block Create/Edit Validation

- [ ] Cabinet conflict → error message shown
- [ ] Cabinet capacity exceeded → CAPACITY_WARNING dialog (not toast)
- [ ] OWNER with `overrideCabinetConflict: true` can bypass cabinet conflict
- [ ] Teacher conflict → error (cannot be bypassed)
- [ ] Block on non-working day → error
- [ ] GRAMMAR block without teacher → error
- [ ] SPEAKING_CLUB without teacher → allowed

### ✅ Credits (Manual Top-up)

- [ ] ADMIN/OWNER can add credits to student → balance updated
- [ ] `LessonCreditLog` entry created
- [ ] Credit history visible in student profile
- [ ] Negative amount (deduction) works correctly

### ✅ Block Delete

- [ ] Delete block → future sessions removed
- [ ] Credits refunded for future attended (creditDeducted=true) sessions
- [ ] Past sessions (COMPLETED/attendance records) preserved
- [ ] Block disappears from grid

### ✅ Settings — Active Days & Time Slots

- [ ] Remove a working day that has blocks → `conflictWarning: true` returned
- [ ] Confirmation dialog shown (not toast)
- [ ] Confirm → day removed with `force: true`, blocks preserved in DB
- [ ] Change `workStart`/`workEnd`/`slotDuration` → `TimeSlot` table regenerated
- [ ] Old unused slots deleted; slots referenced by blocks preserved

### ✅ Multi-Tenancy Isolation

- [ ] Login as School A admin → cannot see School B students
- [ ] Create block in School A → not visible in School B grid
- [ ] Try accessing `/api/schedule` with School B token → only School B data returned

### ✅ Notifications

- [ ] Cancel session → students receive notification
- [ ] Assign substitute → students receive notification
- [ ] Student applies to group → admins receive notification
- [ ] Notifications older than 90 days auto-deleted on server startup

### ✅ Import/Export

- [ ] Export schedule as Excel → file downloads without error
- [ ] Import students from Excel → students created, credits assigned
- [ ] Import with duplicate emails → handled gracefully (no crash)

### ✅ PWA

- [ ] App installable via browser (Install button visible)
- [ ] After install, app opens in standalone mode (no browser chrome)
- [ ] `manifest.json` loads without 404

---

## Critical Flows Not to Break

These are the most regression-prone areas based on past incidents:

### 1. `block.students` removal (2026-05-06)
`ServerBlock.students` is optional — always iterate as `block.students ?? []`. Breaking this causes WeekGrid to silently not render after block creation.

**Test:** Create a block, verify WeekGrid updates without page refresh.

### 2. `skipDuplicates: true` in createMany (2026-05-07)
Without this, server crash on restart due to P2002.

**Test:** Restart server → check logs for `[sessions]` messages, no unhandled rejections.

### 3. Teacher ID mapping
`LessonBlock.teacherId` in DB = `StaffProfile.id`. API returns `User.id`. These are different numbers.

**Test:** Create block with teacher → verify correct teacher displayed → check DB `teacherId` column = `StaffProfile.id`.

### 4. `weekSessions` as sole source for substitutions
No localStorage override exists. After substitution, must call `loadWeekSessions()`.

**Test:** Assign substitute → refresh page → substitute still shown (came from server, not localStorage).

### 5. CANCELLED sessions not regenerated
`syncSessionsForBlock()` never recreates `CANCELLED` sessions.

**Test:** Cancel session → run `extendAllBlockSessions()` → session remains cancelled, not re-created as UPCOMING.

---

## Current Automated Test Setup

The priority-order and manual-checklist sections above predate the actual test suite and described a greenfield plan. That plan was followed, not abandoned — here's what actually exists now:

**Backend** (`server/`) — Jest + ts-jest, ~100 files under `src/__tests__/{unit,integration}/`, split into two `jest.config.js` projects:
- `unit/` — pure logic, mocked I/O, fast (`npm run test:unit`).
- `integration/` — hit a real Postgres DB via Supertest, `maxWorkers: 1` (`npm run test:integration -- --runInBand`). Fixture helpers: `src/__tests__/helpers/testDb.ts` (`createSchool`, `createUser`, `createSession`, ...) and `cleanDb()` (truncates all tables — not safe across parallel workers, hence `maxWorkers: 1`).

**Frontend** (`client/`) — Vitest, `src/**/*.test.ts(x)`. Default environment is `node` (fast, for pure-logic tests); component tests opt into `jsdom` per-file via a `// @vitest-environment jsdom` comment at the top, with `@testing-library/react` + `@testing-library/jest-dom` (setup file: `src/vitest.setup.ts`).

**CI** — `.github/workflows/pr-checks.yml` runs both suites (plus lint/build) on every PR to `dev`/`master`. Integration tests get a 20-minute budget.

No E2E browser testing (Playwright or otherwise) exists — it was on the original tooling wishlist below but was never set up, and nothing currently depends on it.

---

## Performance Benchmarks (Baseline)

These are acceptable response times at current scale (verified manually):

| Endpoint | Expected | Alert if |
|----------|---------|---------|
| `GET /api/schedule` | < 200ms | > 500ms |
| `GET /api/schedule/sessions/week` | < 100ms | > 300ms |
| `PATCH /session/:id/attendance` | < 150ms | > 400ms |
| `GET /api/analytics` | < 500ms | > 1s |
| `POST /api/importexport/import` | < 5s (bulk) | > 15s |

Slow queries are usually missing `deletedAt: null` filter (full table scan) or missing `schoolId` index usage.
