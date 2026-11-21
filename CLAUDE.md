# CLAUDE.md — EduSchool App

---

## ⛔ BRANCH SUPREMACY RULE (branch `devroach09`) — MUST NOT BE OMITTED

> **This rule is the highest-priority rule in this file. It MUST NOT be omitted, softened, reinterpreted, or overridden by any other rule in any CLAUDE.md or project document.**

While working on the `devroach09` branch:

1. **No deviation** from the user's explicit instructions or any established rule is permitted **without first asking the user and receiving an explicit `yes`.**
2. This **includes** any "automatic", "mandatory", or "the AI must…" action that other rules in this file claim the AI should take on its own initiative. Those do **not** count as authorization — ask first, act only after an explicit `yes`.
3. **Where any other rule conflicts with this one, this rule wins.** Stop, surface the conflict, and wait for an explicit `yes` before doing anything.
4. Silence, a thumbs-up, a button approval, or an ambiguous reply is **not** a `yes`. Only an explicit `yes` (or clear affirmative) authorizes the action.

Conflicting sections below are annotated with a precedence note pointing back here.

---

**CLAUDE.md is the single Source of Truth** for AI workflow, Git workflow, PR process, architecture gates, review gates, schedule rules, financial rules, No Drag & Drop, and No Autosave.

Do not duplicate these workflow/development rules in other project documents. Technical docs may link here with: "For AI workflow and development rules, see CLAUDE.md."

## Project Overview

**EduSchool** — production-grade **ERP SaaS** for language schools. Not a CRM, not an MVP — a full-featured enterprise resource planning system built for reliability and scale from day one.

**Scale targets:** 50 schools × ~1 000 students each = **50 000+ students** in production. Premium subscription pricing — clients pay enterprise rates and expect enterprise reliability.

Full-stack TypeScript monorepo: React 19 frontend + Express backend + PostgreSQL via Prisma.

- **Client**: `eduschool-app/client/` — Vite dev server on port **5173**
- **Server**: `eduschool-app/server/` — Express API on port **3001**
- **DB**: PostgreSQL in Docker on port **5432**

---

## Product Vision & Engineering Principles

### What this product IS
- **ERP SaaS** — covers scheduling, attendance, salary, finance, student management, analytics in one platform
- **Multi-tenant** — each school is an isolated tenant (schoolId-scoped data, separate slug, separate settings)
- **Premium product** — not a free tool; schools pay enterprise-tier subscriptions; they expect zero data loss and 99.9%+ uptime

### Scale context (design everything with this in mind)

| Dimension | Target |
|-----------|--------|
| Schools (tenants) | 50 |
| Students per school | ~1 000 avg, up to 3 000 peak |
| Total student records | 50 000+ |
| Daily active users | ~500–2 000 (admins + teachers + students) |
| Sessions generated per day | ~5 000–15 000 across all schools |

### Engineering priority order

Every design decision must be evaluated in this order:

1. **Reliability first** — data must never be lost or corrupted. Idempotency, transactions, version checks are non-negotiable.
2. **Data integrity** — credit balances, salary records, attendance — these are financial data. Treat them like bank transactions.
3. **Scalability** — the system must handle 50k students without degradation. Use indexes, pagination, Redis cache, and async queues.
4. **Flexibility** — schools have different schedules, timezones, rules. Avoid hardcoded assumptions.
5. **Developer experience** — comes last. Clean code matters, but never at the cost of correctness.

### Rules for AI assistants working on this codebase

- **Never simplify reliability mechanisms** — idempotency keys, optimistic locking, `creditDeducted` flags exist for a reason. Do not remove them to "simplify" code.
- **Never bypass multi-tenancy** — every DB query must filter by `schoolId`. No exceptions.
- **Financial data = transactions** — credit deductions, salary adjustments, payments must always be wrapped in a Prisma transaction.
- **Think at 50k students** — if a query would table-scan at 50k rows, it needs an index or pagination. Do not write queries that would degrade under real load.
- **This is not an MVP** — do not suggest "we can add that later" for reliability, security, or data integrity features. They are required now.
- **Proceed without asking** — once the user has given an instruction, implement it directly. Do not ask «Начинаю реализацию?» or otherwise wait for a separate confirmation before writing code. (Changed per user instruction 2026-06-19.)

---

## Documentation Map

Technical docs are references. Workflow, development, review, and merge rules stay in this file only.

| Need | Read |
|------|------|
| Start / product overview | `eduschool-app/README.md`, `eduschool-app/SYSTEM_BLUEPRINT.md` |
| Workflow rules | `CLAUDE.md` |
| Architecture | `eduschool-app/SYSTEM_BLUEPRINT.md`, `eduschool-app/ARCHITECTURAL_DECISIONS.md`, `eduschool-app/ARCHITECTURE.md` |
| Schedule | `eduschool-app/AI_SCHEDULE_HANDOFF.md`, `eduschool-app/SCHEDULE_UI_CONTRACT.md`, `eduschool-app/SCHEDULE_LIFECYCLE_RFC.md` |
| API / data | `eduschool-app/API_CONTRACTS.md`, `eduschool-app/DATABASE_CONSTRAINTS.md` |
| Frontend | `eduschool-app/FRONTEND_STATE_RULES.md` |
| Ops / testing | `eduschool-app/DEPLOYMENT.md`, `eduschool-app/OPERATIONS.md`, `eduschool-app/TESTING_STRATEGY.md`, `eduschool-app/BACKUP_RESTORE.md`, `eduschool-app/INCIDENT_RESPONSE.md` |
| Production readiness roadmap | `eduschool-app/PRODUCTION_READINESS.md` |

---

## Quick Start

```bash
# From repo root
docker-compose up -d                        # Start PostgreSQL
cd eduschool-app/server && npx prisma migrate deploy  # Apply migrations
npm run dev                                  # Start both client + server concurrently
```

Root `npm run dev` uses `concurrently` to run `dev:server` and `dev:client` in parallel.

### Individual scripts

| Location | Command | Effect |
|----------|---------|--------|
| root | `npm run dev` | Both servers |
| client | `npm run dev` | Vite HMR (port 5173) |
| client | `npm run build` | Type-check + Vite bundle |
| server | `npm run dev` | `tsx watch` TypeScript |
| server | `npm run build` | Compile to `dist/` |
| server | `npm run draw-db` | Regenerate Prisma client |

---

## Tech Stack

### Frontend
- **React 19** + TypeScript 5.6 + Vite 6
- **Tailwind CSS 3** — custom green theme (`primary: #2D6A4F`)
- **React Router v7** — `/:slug` multi-tenant routing
- **Axios** — Bearer token auto-injected via interceptor (`client/src/lib/api.ts`)
- **Recharts** — analytics charts
- **SimpleWebAuthn** — passkey/WebAuthn support
- **XLSX** — Excel import/export
- **React Hot Toast** — notifications
- **@react-oauth/google** — Google OAuth
- **PWA** — installable on desktop/mobile

### Backend
- **Express 4** + TypeScript 5.7 + tsx watch
- **Prisma 6** ORM — PostgreSQL
- **JWT** — access token (7d, localStorage) + refresh token (30d, HttpOnly cookie `rt`). Client interceptor auto-refreshes on 401. `POST /api/v1/auth/refresh` + `POST /api/v1/auth/logout` endpoints.
- **bcrypt** — password hashing
- **express-rate-limit** — login: 10/15min, register: 5/hr
- **SimpleWebAuthn** — passkey verification
- **OTPAuth** + **QRCode** — TOTP/2FA setup
- **notify.ts** utilities — `notify()`, `notifyMany()`, `notifySchoolAdmins()`

### Path aliases
- Client: `@/*` → `src/*`
- Server: no aliases, relative imports
- Vite proxy: `/api/v1/*` → `http://localhost:3001` during dev (avoids CORS)
- **API prefix:** all routes are mounted at `/api/v1/` (server: `app.use('/api/v1', routes)`, client baseURL: `/api/v1`)

---

## Architecture

### Multi-Tenancy
Every DB entity ties to a `School` via `schoolId`. The `authenticate` middleware decodes the JWT and injects `req.user = { userId, schoolId, role }`. All route queries must filter by `schoolId`.

### Authentication Flow
1. Login → server issues JWT
2. Client stores in `localStorage`, `AuthContext` holds state
3. Axios interceptor attaches `Authorization: Bearer <token>`
4. Server middleware validates on every protected route
5. Optional 2FA: TOTP codes or WebAuthn passkeys

### Role Hierarchy

| Role | Real-world | Route prefix | Scope |
|------|-----------|-------------|-------|
| SUPERADMIN | Platform operator | `/superadmin/` | All schools, system-wide settings, school blocking |
| OWNER | Executive director (исполнительный директор) | `/owner/` | Full access: all operational pages + analytics, staff management, school settings, salary payment, clear data |
| ADMIN | Junior admin (девочка на стойке) | `/admin/` | Operational: students, teachers, schedule, attendance, credits, salary (view only), finance, invoices, crm-settings, import-export. No staff management, no school settings mutation, no salary payment, no clear data |
| TEACHER | Teacher | `/teacher/` | Assigned sessions, attendance marking |
| STUDENT | Student | `/student/` | Own profile, enrollments, attendance, credits |

**Routing rule:** OWNER and ADMIN have separate route trees (`/owner/*` vs `/admin/*`). Same page components are reused — `usePermissions()` hook (`hooks/usePermissions.ts`) is the single source of truth for UI-level restrictions within shared pages.

**Backend rule:** OWNER-only endpoints return 403 for ADMIN. Destructive/financial operations = OWNER only. Operational CRUD = OWNER + ADMIN.

### Scheduling Core ("Antigravity")
`StudentGroup` (cohort) → `LessonBlock[]` (Grammar + Club blocks) → `LessonSession` (individual lesson, rolling 14-day window) → `Attendance` (per student) → credit deduction via `LessonCreditLog`. The `creditDeducted` flag on `Attendance` ensures idempotent deductions. Sessions are generated via `syncSessionsForBlock()` (diff-based) and extended daily by `extendAllBlockSessions()` cron. See `AI_SCHEDULE_HANDOFF.md` for full scheduling docs.

---

## Key Files & Directories

```
eduschool-app/
├── client/src/
│   ├── App.tsx                    # Root: AuthProvider + Router + Toaster
│   ├── context/AuthContext.tsx    # Global auth state, checks /api/auth/me on init
│   ├── lib/api.ts                 # Axios instance with auto Bearer token
│   ├── router/index.tsx           # All routes + ProtectedRoute + role guards
│   ├── pages/
│   │   ├── auth/                  # Login, TwoFactorChallenge
│   │   ├── dashboard/admin/       # Schedule, Students, Teachers, Attendance,
│   │   │                          #   Finance, Salary, ImportExport, CrmSettings
│   │   ├── dashboard/student/     # Overview, Schedule, Credits
│   │   ├── dashboard/teacher/     # (teacher views)
│   │   ├── dashboard/owner/       # (owner views)
│   │   ├── dashboard/superadmin/  # (superadmin views)
│   │   ├── Landing.tsx
│   │   ├── Login.tsx
│   │   ├── RegisterSchool.tsx
│   │   └── SchoolLanding.tsx
│   ├── components/
│   │   ├── layout/                # Navbar, Sidebar (desktop), SuperAdminLayout
│   │   ├── schedule/              # WeekGrid, MonthView, RoomsView, LessonPopup,
│   │   │                          #   SlotPanel, ManagementOverlay
│   │   └── ui/                    # Button, Input, Card, Badge, StatCard, Spinner,
│   │                              #   AddUserModal, ConfirmModal, EmptyState, etc.
│   ├── hooks/
│   │   ├── useAuth.ts             # Access AuthContext
│   │   ├── useSchedule.ts         # Schedule API calls
│   │   └── useSalary.ts           # Salary calculations
│   └── types/                     # TypeScript interfaces for API responses
│
└── server/src/
    ├── index.ts                   # Express init, CORS, routes mount, daily cleanup
    ├── middleware/authenticate.ts # JWT verify → req.user
    ├── lib/
    │   ├── prisma.ts              # Singleton PrismaClient
    │   └── notify.ts              # Notification utilities
    └── routes/
        ├── auth.ts                # Register, login, logout, /me, 2FA challenge
        ├── users.ts               # User CRUD, role management
        ├── students.ts            # Student profiles, enrollment requests
        ├── schedule.ts            # LessonBlocks, sessions, cabinets, timeslots
        ├── credits.ts             # Add credits, view logs
        ├── analytics.ts           # Stats dashboards
        ├── schools.ts             # School data, timezone
        ├── settings.ts            # User & school settings
        ├── admin.ts               # Admin operations
        ├── superadmin.ts          # School management, blocking
        ├── notifications.ts       # Fetch/mark notifications
        ├── 2fa.ts                 # TOTP setup, passkey registration/auth
        └── importexport.ts        # Bulk CSV/Excel operations
```

---

## Database Models (Prisma)

Key models in `server/prisma/schema.prisma`:

| Model | Purpose |
|-------|---------|
| `School` | Tenant — slug, timezone, `activeDays Int[]`, `workStart`, `workEnd`, `slotDuration`, isActive, blockedAt |
| `User` | Account — role (SUPERADMIN\|OWNER\|ADMIN\|TEACHER\|STUDENT), twoFactorEnabled, totpSecret, passkeys |
| `StudentProfile` | credits (balance), isFrozen, isVerified. Enrolled via `StudentGroup`, legacy `enrolledBlocks` kept |
| `StaffProfile` | Teacher/staff — salaryRate, position, hireDate. `taughtBlocks` and `substitutions` relations |
| `StudentGroup` | **Cohort** — единица записи. level, chapter, maxStudents, status (ACTIVE\|COMPLETED\|PAUSED). Студенты записаны в группу, а не в блок |
| `LessonBlock` | Recurring class — `timeSlotId` FK, `startTime`/`endTime` (cache), `days Int[]` (0=Пн..6=Вс), `studentGroupId` FK, type (GRAMMAR\|SPEAKING_CLUB) |
| `LessonSession` | Individual lesson — date (UTC noon), `teacherId` (StaffProfile.id for substitute), status |
| `Attendance` | PRESENT\|ABSENT\|LATE\|FROZEN, `creditDeducted` idempotency flag |
| `LessonCreditLog` | Audit ledger — amount (±), reason |
| `TeacherPayment` | Salary payment record — period, lessonsCount, rateSnapshot, amount |
| `SalaryAdjustment` | Fine/advance/bonus — type (FINE\|ADVANCE\|BONUS), month, amount |
| `EnrollmentRequest` | Waitlist — `studentGroupId` FK (new) + `lessonBlockId` FK (legacy), PENDING\|APPROVED\|REJECTED |
| `Cabinet` | Physical classroom — name, capacity |
| `TimeSlot` | Time range in DB — schoolId, startTime, endTime, order. Auto-regenerated when schedule settings change |
| `Notification` | Message queue — auto-deleted after 90 days |
| `UserPasskey` | WebAuthn credential — credentialID, publicKey, counter |

**Critical:** `LessonBlock.teacherId` and `LessonSession.teacherId` store `StaffProfile.id`, NOT `User.id`. The `mapTeacher()` helper converts to `{ id: user.id, firstName, lastName }` for the client. Soft deletes via `deletedAt` on most models; `LessonBlock` uses hard delete in the API.

ERD: `server/ERD.svg` (auto-generated by Prisma).

---

## Environment Variables

**Server** (`server/.env`):
```
DATABASE_URL="postgresql://postgres:<password>@localhost:5432/eduschool"
JWT_SECRET="<secret>"
PORT=3001
CLIENT_URL=http://localhost:5173   # optional
```

`.env.example` added to repo. See `server/.env.example` for reference.

---

## Documentation Update Rule (MANDATORY)

> **Precedence (devroach09):** The ⛔ BRANCH SUPREMACY RULE at the top of this file takes precedence over this section where they conflict. On this branch, do not perform these "mandatory" doc updates as an automatic action — ask first and act only after an explicit `yes`.

**After every code change — update the relevant reference files before marking the task done.**

| Changed area | Files to update |
|--------------|-----------------|
| Scheduling logic, sessions, credits, attendance | `AI_SCHEDULE_HANDOFF.md` — add entry to the Changelog section (bottom of file) |
| API endpoints (new routes, changed request/response shape) | `API_CONTRACTS.md` — add or update the affected endpoint example |
| Architectural decisions (WHY something was built this way) | `ARCHITECTURAL_DECISIONS.md` |
| DB schema (new model, new column, new index, new constraint) | `DATABASE_CONSTRAINTS.md` + `AI_SCHEDULE_HANDOFF.md` changelog |
| Frontend state / data flow / reload sequences | `FRONTEND_STATE_RULES.md` |
| Deployment, environment variables, infrastructure | `DEPLOYMENT.md` |
| Auth, roles, permissions | `ARCHITECTURE.md` + `AI_SCHEDULE_HANDOFF.md` if it touches scheduling |

**Format for changelog entries** (in `AI_SCHEDULE_HANDOFF.md` and other docs):
```
#### YYYY-MM-DD (Part N — Short title)
- ✅ **Feature name** — what was done, which files were changed, why it matters.
```

**Rule:** Never say "done" to the user without having updated the relevant docs. If a change is too small to warrant a doc entry, at minimum bump the `Last Updated` line in the affected file.

---

## Coding Conventions

- TypeScript strict mode throughout — no `any` unless unavoidable
- All server routes must filter queries by `req.user.schoolId`
- Credit deductions: always check and set `creditDeducted` flag (idempotency)
- Notifications: use `notify.ts` utilities, never raw Prisma inserts
- Client API calls: always use `api.ts` Axios instance, never raw `fetch`
- Tailwind only for styling — no inline styles, no CSS modules
- Role guards on every protected page via `ProtectedRoute` in router
- Financial data (credits, salary, payments): always wrap in Prisma transaction — never bare Prisma calls
- Reliability over simplicity: if a mechanism exists for correctness (idempotency, version check, `creditDeducted` flag), never remove it

---

## Notable Features

- **PWA** — installable, service worker, icons
- **Mobile-responsive** — bottom nav on mobile, sidebar on desktop
- **2FA** — TOTP + WebAuthn passkeys (optional per user)
- **School blocking** — 7-day soft block with warning banner (SuperAdmin)
- **Import/Export** — bulk CSV/Excel via XLSX
- **Salary management** — `TeacherPayment` + `SalaryAdjustment` in DB (no localStorage)
- **Schedule UI** — Week/Month/Rooms views (`components/schedule/`). SlotPanel is a desktop modal
- **Cohort groups** — `StudentGroup` model: студент записан в группу, группа включает Grammar + Club блоки
- **Rolling sessions** — сессии генерируются на 14 дней вперёд, cron расширяет ежедневно
- **Schedule validation** — `scheduleValidation.ts`: проверка рабочих дней, вместимости, коллизий кабинета/учителя
- **TimeSlot from DB** — временные слоты хранятся в `TimeSlot` таблице, авто-regeneration при изменении настроек
- **Notifications** — DB-backed queue (BullMQ + Redis), sync fallback, 90-day auto-cleanup
- **Rate limiting** — per-endpoint limiters: attendance (60/min), session ensure (30/min), notifications (20/min), credits (30/min), general (200/min)
- **WebSockets** — Socket.IO real-time sync: `session:status-changed`, `attendance:updated`. JWT auth, per-school room isolation
- **Redis cache** — Analytics overview (60 sек TTL), teacher calendar (120 сек TTL). Graceful fallback без Redis
- **Server-side pagination** — students/users/groups: `{ data, meta: { total, page, limit, pages } }`. Debounced search 350ms
- **Composite DB indexes** — LessonSession(schoolId,date), LessonSession(teacherId,date), Attendance(studentProfileId,createdAt) и др. — рассчитаны на 50k+ студентов
- **Optimistic locking** — `LessonSession.version Int` инкрементируется при каждом update
- **Sentry monitoring** — `@sentry/node` + `@sentry/react`, включаются при наличии `SENTRY_DSN` / `VITE_SENTRY_DSN`

---

## Scheduling Deep Dive

See `eduschool-app/AI_SCHEDULE_HANDOFF.md` for full scheduling system documentation:
- Data model, rolling window, API endpoints, credit logic, client-side state, known bugs.

---

## Development Branch Workflow

Current development workflow:

```
feature/* -> dev
dev -> master only by owner
```

`dev` is the main development integration branch. `master` is release-only and must not be changed by AI assistants unless the owner explicitly instructs it.

Последние значимые изменения:
- StudentGroup (когортная модель): студенты записываются в группу, не в блок
- TimeSlot перенесён в БД (отдельная таблица с schoolId)
- LessonBlock.days теперь `Int[]` (не строка)
- School.activeDays/workStart/workEnd/slotDuration — отдельные колонки (не JSON)
- SalaryAdjustment модель добавлена
- Rolling 14-day window вместо 90-дневной генерации
- SlotPanel → десктопный модал
- **Production scalability (2026-05-10):** Socket.IO real-time, Redis cache, BullMQ queue, server-side pagination, composite indexes, rate limiters, Sentry, optimistic locking

---

# EDUSCHOOL AI OPERATING SYSTEM v2.0

## Mission

Цель системы:

Разрабатывать EduSchool ERP без потери функционала, без хаотичных изменений, без перезаписи чужого кода и без архитектурного долга.

---

## Golden Rule

Одна задача = одна feature-ветка = один PR = один чат ИИ.

Никогда не смешивать несколько крупных задач в одном PR.

---

## Development Lifecycle

Любая задача проходит строго через этапы:

```
AUDIT → PLAN → ARCHITECTURE REVIEW → APPROVED → IMPLEMENTATION → REVIEW → APPROVED → PR → MERGE → POST-MERGE VERIFICATION
```

Запрещено пропускать этапы.

---

## Git Workflow

### Начало работы

Всегда начинать от актуального dev. Обязательный порядок:

1. `git checkout dev`
2. `git pull origin dev`
3. `git status`
4. создать новую feature ветку

Примеры: `feature/reschedule-ui`, `feature/freeze-system-backend`, `feature/freeze-admin-ui`

### Запрещено

- Не работать в dev или master напрямую
- Не пушить напрямую в dev или master
- Не мержить самостоятельно

---

## Feature Branch Rule

После merge feature-ветка считается закрытой. Правильный порядок:

```
merge → checkout dev → pull dev → new feature branch
```

---

## One Chat Rule

Один чат ИИ = один PR. После merge чат считается закрытым. Новая задача → новый чат.

---

## Scope Freeze Rule

После утверждения плана запрещено расширять scope. Если появилась новая идея — создать новый PR, не добавлять в текущий.

---

## Architecture Gate

> **Precedence (devroach09):** The ⛔ BRANCH SUPREMACY RULE at the top of this file takes precedence over this section where they conflict.

До начала кодирования ИИ обязан показать:

- **A.** Audit
- **B.** План реализации
- **C.** Затронутые файлы
- **D.** Source of Truth
- **E.** Риски

Код запрещён до APPROVED.

---

## Source Of Truth Rule

Каждый новый модуль обязан иметь один источник правды явно объявленный. Если Source of Truth не определён — архитектура не утверждается.

---

## Blast Radius Check

Перед кодом обязательно показать:

- Affected Files / Services / DB Tables / APIs
- Financial Impact
- Auth Impact
- Schedule Impact

Без этого реализация запрещена.

---

## Backward Compatibility Gate

Перед реализацией ИИ обязан показать статус совместимости для старых страниц, API, тестов и интеграций: `SAFE` или `NOT SAFE`.

---

## Schedule Rules

**Canonical schedule:** `schedule/` → `Schedule.tsx`, `useSchedule.ts` — единственный источник правды.

**Legacy schedule:** `schedule2/` — новые функции и новый код туда запрещены.

**Cancel guard:** sessions with `Attendance.creditDeducted = true` cannot be normally cancelled. Cancellation must not perform automatic credit refunds; credit corrections require an explicit correction/ledger flow with audit.

---

## No Drag & Drop Policy

Полностью запрещено перетаскивание уроков, преподавателей, кабинетов. Только: Modal → Edit → Confirm → Save.

---

## No Autosave Policy

Полностью запрещено. Только явный Save.

---

## Financial Rules

Кредит списывается **только** через Submit Attendance. Запрещено списывать через создание/перенос/отмену урока, makeup, смену кабинета или преподавателя.

`StudentFreeze` is the source of truth for freeze state. `StudentProfile.isFrozen` / `StudentProfile.frozenAt` are legacy cache fields only.

---

## Business Logic Rule

Перед утверждением архитектуры ИИ обязан ответить на сценарии: урок отменён, кредит уже списан, зарплата начислена, дедлайн прошёл, данные устарели, конфликт существует, legacy поведение. Без ответов архитектура не утверждается.

---

## Review Rules

`IMPLEMENTED ≠ APPROVED`. Порядок: Implementation → Review → Fixes → Approved → PR.

---

## Merge Readiness Gate

Перед PR обязательно: TypeScript PASS, Tests PASS, Build PASS, Review PASS. Если хотя бы один не выполнен — `PR Ready = NO`.

---

## Mandatory Report Format

После реализации всегда:

```
Commit hash:
Commit message:
Files changed:
TypeScript:
Tests:
Build:
Known risks:
Can continue:
```

---

## Post-Merge Verification

> **Precedence (devroach09):** The ⛔ BRANCH SUPREMACY RULE at the top of this file takes precedence over this section where they conflict. On this branch, do not run these git steps automatically — ask first and act only after an explicit `yes`.

После merge обязательно: `git checkout dev` + `git pull origin dev`. Подтвердить: PR Status MERGED, Merge Commit, Included In Dev YES, Commit Present YES, Ready For Next PR YES. Без этого новый PR запрещён.

---

## Product Owner Principle

> **Precedence (devroach09):** The ⛔ BRANCH SUPREMACY RULE at the top of this file takes precedence over this section where they conflict. The AI may still surface risks, but on this branch it must not act on its own (including stopping or changing course) without an explicit `yes` — it raises the concern and waits for the user's decision.

ИИ обязан защищать продукт. Если решение ломает финансы, историю, аудит, совместимость или Source of Truth — ИИ обязан остановить реализацию и сообщить о риске, даже если пользователь попросил писать код.

---

## Core Philosophy

Сначала понять. Потом спроектировать. Потом проверить. Потом писать код. Никогда наоборот.
