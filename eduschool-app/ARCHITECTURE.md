# Shamdan App Architecture

*Last Updated: 2026-08-18*

> This doc covers multi-tenancy, auth, roles, and data-model relationships at a
> glance. For the full data model and schedule/credit state machine, see
> `SYSTEM_BLUEPRINT.md`. For *why* something was built a certain way, see
> `ARCHITECTURAL_DECISIONS.md`. Keep this doc short — detailed, fast-changing
> content belongs in those two instead, so it doesn't rot here unnoticed.

## 1. Project Overview
A multi-tenant ERP SaaS for language schools (50 schools × ~1,000 students target). Each school is an isolated tenant with its own data, slug, and settings.

## 2. Tech Stack
**Frontend:** React 19, TypeScript, Vite, Tailwind CSS, React Router v7, Axios, PWA (installable manifest + install-only service worker, no offline caching by design).

**Backend:** Node.js, Express, TypeScript, PostgreSQL via Prisma, JWT auth (access + refresh), bcrypt, express-rate-limit (Redis-backed), Redis cache, BullMQ background queue, Socket.IO (real-time schedule/attendance sync), Sentry (error monitoring), pino (structured logging), OpenTelemetry (optional tracing).

## 3. Folder Structure
```text
eduschool-app/
├── client/src/
│   ├── components/        # ui/, layout/, schedule/
│   ├── pages/              # Landing, Login, RegisterSchool, dashboard/{admin,owner,teacher,student,parent,superadmin}
│   ├── hooks/, lib/, context/, types/, router/
│   └── main.tsx
├── server/src/
│   ├── routes/             # Express route handlers, one file per resource
│   ├── services/           # Business logic (paymentService, sessionService, attendanceService, ...)
│   ├── middleware/          # authenticate, requirePermission, rate limiters, validate
│   ├── lib/                 # Prisma client, logger, cache, queue, socket
│   └── index.ts / worker.ts # API entry point / background cron+queue worker
├── prisma/schema.prisma, prisma/migrations/
├── ARCHITECTURE.md, SYSTEM_BLUEPRINT.md, ARCHITECTURAL_DECISIONS.md, ...
└── docker-compose.yml       # local PostgreSQL only
```

> [!NOTE]
> **Integrity Guard**: `Attendance.creditDeducted` ensures credits are never deducted twice for the same lesson, even if attendance is toggled repeatedly.

## 4. Core Data Model
- **School** — the tenant. `activeDays`, `workStart`/`workEnd`, `slotDuration`, `timezone`, `blockedAt` (soft-block).
- **User** — account with `role` (see §7), tied to `schoolId`. Optional 2FA (TOTP + WebAuthn passkeys).
- **StudentProfile / StaffProfile / ParentProfile** — role-specific profile data. `ParentProfile` links to one or more `StudentProfile`s via `ParentChild`.
- **StudentGroup** — the unit of enrollment (cohort). Students enroll in a group, not directly in a `LessonBlock`.
- **LessonBlock** — a recurring class definition (days, time slot, cabinet, teacher, type: GRAMMAR/SPEAKING_CLUB) belonging to a `StudentGroup`.
- **LessonSession** — a materialized instance of a `LessonBlock` for one date. Carries snapshot fields (`teacherIdSnap`, time snapshots) so substitutions/edits don't rewrite history.
- **Attendance** — per-student presence on a `LessonSession` (PRESENT/ABSENT/LATE/FROZEN) plus the `creditDeducted` idempotency flag.
- **LessonCreditLog** — append-only ledger for every credit change (top-up or lesson deduction).
- **Cabinet / TimeSlot** — physical resources; `TimeSlot` lives in its own table (schoolId-scoped) and is regenerated when schedule settings change.
- **Invoice / Payment / TeacherPayment / SalaryAdjustment** — billing and payroll records.
- **Notification** — DB-backed queue, auto-deleted after 90 days.

## 5. Multi-Tenancy
- Every entity ties to a `School` via `schoolId`.
- The `authenticate` middleware decodes the JWT and sets `req.user = { userId, schoolId, role }`, also populating an `AsyncLocalStorage` request context (`src/lib/requestContext.ts`).
- Every route query filters by `schoolId`. Records outside the caller's school 404 (not 403), by design — see `src/lib/tenant.ts` — to avoid leaking cross-tenant existence via status codes.

## 6. Authentication Flow
1. `POST /api/v1/auth/login` accepts email, username, or phone as the identifier.
2. If `twoFactorEnabled`, an intermediate step requires a TOTP code or WebAuthn passkey.
3. On success: a short-lived JWT access token (15m, returned in the response body, held in memory only — never `localStorage`) + a random refresh token (30d, `httpOnly` cookie, rotated on every use with reuse-detection).
4. The Axios interceptor attaches `Authorization: Bearer <token>` and auto-refreshes on 401 via `POST /api/v1/auth/refresh`.
5. `/auth/refresh` and `/auth/logout` authenticate via cookie alone (no Bearer token), so they carry an Origin/Referer check as CSRF defense.

**Password minimum (2026-08-18):** the server-enforced minimum is 12 chars (`server/src/lib/passwordPolicy.ts`); the client now imports the same number from `client/src/lib/passwordPolicy.ts` on every password-setting form (`Login`, `RegisterSchool`, `AcceptInvite`, `ResetPassword`, `Profile`, `AddUserModal`) instead of a hardcoded `6`. Login is the one exception — it never enforces a minimum length, since accounts created before this policy existed may have a shorter password and must still be able to sign in.

## 7. Roles

| Role | Scope |
|------|-------|
| `SUPERADMIN` | Platform operator — all schools, system-wide settings, school blocking. |
| `OWNER` | Full tenant access — everything ADMIN has, plus staff management, school settings, salary payment, destructive data operations. |
| `ADMIN` | Day-to-day operations — students, teachers, schedule, attendance, credits, finance, invoices. No staff management or salary payment. |
| `TEACHER` | Assigned sessions, attendance marking, own salary view. |
| `STUDENT` | Own profile, enrollments, attendance, credit balance. |
| `PARENT` | Read-only view of their linked children's schedule/attendance/credits via `ParentChild`. |

OWNER and ADMIN are separate route trees (`/owner/*`, `/admin/*`) sharing page components; `usePermissions()` on the client and per-route `requirePermission()` on the server are the actual enforcement points, not this table — see `ARCHITECTURAL_DECISIONS.md` for why they're split that way.

**Role change (2026-08-18):** `PATCH /api/v1/users/:id/role` lets an OWNER (or SUPERADMIN) change an
existing staff member's role between ADMIN and OWNER — promotion or demotion, never self-service,
never the last OWNER in a school, never SUPERADMIN. This is asymmetric with account *creation*:
`ROLE_CREATION_WHITELIST` still does not let an OWNER create a brand-new user directly as OWNER
(`POST /users` only allows OWNER to create ADMIN/TEACHER/STUDENT). Promoting an existing ADMIN via
this endpoint is the only supported path to a school having a second OWNER. Full contract:
`API_CONTRACTS.md`.

## 8. Schedule & Credits (short version)
`StudentGroup` → `LessonBlock` (Grammar + Club) → `LessonSession` (rolling 14-day window, extended daily by a cron job) → `Attendance` → credit deduction via `LessonCreditLog`, gated by the `creditDeducted` idempotency flag. Full state machine, edge cases, and known bugs: `AI_SCHEDULE_HANDOFF.md`.

## 9. API Conventions
All routes are mounted under `/api/v1/` (e.g. `/api/v1/auth/login`, `/api/v1/schedule`, `/api/v1/payments`). Full endpoint-by-endpoint reference: `API_CONTRACTS.md`.

## 10. Local Environment Setup
See `server/.env.example` and `client/.env.example` for the full, current list of environment variables — this doc doesn't duplicate it to avoid drifting out of sync. Quick start: `docker-compose up -d` (Postgres), then `npm run dev` from the repo root.

## 11. Soft Deletes
Most core entities (`School`, `User`, `StudentProfile`, `Cabinet`, `TimeSlot`, `LessonBlock`, `LessonSession`) use `deletedAt` instead of hard deletes — all reads must filter `deletedAt: null`. `LessonBlock` is the one exception noted in `CLAUDE.md`: the API hard-deletes it. When a block is soft/hard-deleted, its *future* sessions and attendance are removed; past records and already-deducted credits are preserved for audit.

## 12. Scheduling Conflict Guard
`scheduleValidation.ts` blocks `LessonBlock` creation/edit on: non-working days, cabinet double-booking (same days + overlapping time), teacher double-booking, and capacity overflow (warning, not a hard block). `OWNER` can override a cabinet conflict with `overrideCabinetConflict: true`; teacher conflicts can never be overridden.

## 13. School Blocking
`School.blockedAt` — set by SuperAdmin (`PATCH /api/v1/superadmin/schools/:id/toggle-active`). A 7-day grace period follows before login is rejected (403); OWNER/ADMIN see a countdown banner during the grace period.

## 14. Reliability & Scale
- Composite indexes on high-traffic query paths (`LessonSession(schoolId, date)`, `LessonSession(teacherId, date)`, `Attendance(studentProfileId, createdAt)`, and others) — sized for 50k+ students.
- Redis-backed rate limiting per endpoint class (login 10/15min, register 3/hr, attendance 60/min, credits 30/min, everything else 200/min floor).
- Optimistic locking (`LessonSession.version`) on concurrent schedule edits.
- Server-side pagination on students/users/groups list endpoints.
- Redis cache for analytics (60s TTL) and teacher calendar (120s TTL), with a graceful no-Redis fallback.

## 15. Frontend UI
- Dual navigation: fixed sidebar on desktop, bottom nav + "Ещё" drawer on mobile.
- PWA: installable (`manifest.json`, icons) + a minimal service worker (`public/sw.js`) that exists only to satisfy install-prompt requirements. It deliberately caches nothing and passes every request straight to the network — this is live ERP data, a stale cached schedule/attendance/finance response would be wrong, not just outdated. No offline support, by design.
