# API_CONTRACTS.md — Shamdan

> **Purpose:** Request/response shapes for critical API endpoints.  
> Read before any frontend/backend sync work. These contracts prevent silent interface breakage.  
> All responses wrap data in `{ success: true, data: T }` or `{ success: false, error: string }`.
>
> For AI workflow and development rules, see CLAUDE.md.

*Last Updated: 2026-08-19*

> **2026-08-10 — Real school branding on the public landing page.** `GET /api/schools/:slug` now returns `logoUrl`, `description`, `createdAt`, `studentCount`, `teacherCount`, and a populated `landingConfig.heroImageUrl` — `SchoolLanding.tsx` (route `/:slug`) uses these instead of a hardcoded stock template (fake photos, fake stats, fake identical pricing across all tenants). New `PATCH /schools/current/branding` (OWNER/SUPERADMIN only) persists logo/hero photo/description; `POST /api/upload` (previously built but unwired) is now documented and actually usable — added `express.static` serving for `/uploads` in `server/src/index.ts`, which was missing entirely.

> **2026-07-10 — Per-school login identifiers.** `email` is now optional; `username` added. `POST /users` accepts `{ email?, username?, phone? }` (at least one required) and returns 409 on a per-school duplicate. Login accepts email/phone/username. See DATABASE_CONSTRAINTS.md → per-school unique constraints.

---

## Global Conventions

```ts
// Success
{ success: true, data: T }

// Error
{ success: false, error: string }

// HTTP 200 does NOT always mean success — always check response.data.success
```

**Auth:** All endpoints (except `/api/auth/*`) require `Authorization: Bearer <token>` header. Access tokens expire in **15 minutes** — the client interceptor calls `POST /api/auth/refresh` (HttpOnly refresh cookie) on a 401 to mint a new one transparently; the access token itself is kept in memory client-side, never in localStorage.  
**Tenant isolation:** Server injects `schoolId` from JWT — never send `schoolId` in request body.

---

## 1. Authentication

### `POST /api/auth/login`

**Request:**
```json
{
  "identifier": "admin@school.kz",
  "password": "secret123",
  "slug": "oxford-academy"
}
```

`identifier` may be an **email, phone, or username** — resolved per-school when `slug` is present. Without a `slug`, the identifier is looked up across all schools; if it matches exactly one user (including SUPERADMIN) the login proceeds, but if it matches users in more than one school the request is rejected with `409` (`"Этот логин используется в нескольких школах..."`) rather than guessing — identifiers are only unique per-school, so a global match can be ambiguous. The legacy `email` field is still accepted as the identifier for backward compatibility. Users without an email skip the email-verification gate.

**Response — success (no 2FA):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": 5,
      "email": "admin@school.kz",
      "firstName": "Айгерим",
      "lastName": "Сейткали",
      "role": "ADMIN",
      "schoolId": 3
    },
    "school": {
      "id": 3,
      "name": "Oxford Academy",
      "slug": "oxford-academy",
      "city": "Алматы"
    }
  }
}
```

**Response — 2FA required (no token yet):**
```json
{
  "success": true,
  "data": {
    "requiresTwoFactor": true,
    "userId": 5
  }
}
```
Client must redirect to 2FA challenge page. Token is issued after challenge passes.

**Response — blocked school (403):**
```json
{
  "success": false,
  "error": "Доступ заблокирован. Свяжитесь с администрацией платформы."
}
```

---

## 2. Schedule — Lesson Blocks

### `POST /api/schedule` — Create block

**Roles:** ADMIN, OWNER

**Request:**
```json
{
  "cabinetId": 2,
  "timeSlotId": 4,
  "days": [0, 2],
  "type": "GRAMMAR",
  "teacherId": 12,
  "maxStudents": 12,
  "startDate": "2026-05-08",
  "endDate": null,
  "studentGroupId": 45,
  "overrideCabinetConflict": false,
  "overrideStudentConflict": false,
  "overrideTeacherConflict": false
}
```

> `teacherId` = **User.id** (server looks up StaffProfile internally)  
> `days` = number[] (0=Mon..6=Sun)  
> `studentGroupId` is **required** (added 2026-07-13): blocks without a StudentGroup binding («без привязки») can no longer be created. Missing/invalid id → `400 { "code": "STUDENT_GROUP_REQUIRED" }`; group not found in this school → 404. `level`/`chapter` are always taken from the StudentGroup (body values ignored).

**Response — success:**
```json
{
  "success": true,
  "data": {
    "id": 42,
    "schoolId": 3,
    "cabinetId": 2,
    "teacherId": 8,
    "level": "Intermediate",
    "chapter": 3,
    "days": [0, 2],
    "startTime": "09:00",
    "endTime": "10:20",
    "type": "GRAMMAR",
    "maxStudents": 12,
    "startDate": "2026-05-08T00:00:00.000Z",
    "endDate": null,
    "status": "UPCOMING",
    "studentGroupId": 7
  }
}
```

**Response — validation error (400):**
```json
{ "success": false, "error": "Кабинет уже занят (09:00–10:20, дни: Пн,Ср)" }
```

**Special — capacity warning (400, client must parse prefix):**
```json
{ "success": false, "error": "CAPACITY_WARNING:Кабинет рассчитан на 10 чел., а в группе уже 13 студ." }
```

**Group-pair write ownership (added 2026-07-04):** if `studentGroupId` already has an active block (`deletedAt: null`, `endDate: null`) in this school, the request is rejected before any mutation:
```json
{ "success": false, "code": "GROUP_ALREADY_IN_SCHEDULE", "error": "StudentGroup is already scheduled. Use group-pair endpoint." }
```
Use `POST /api/schedule/group-pair` to add a Grammar/Club pair to an existing group.

Client handling:
```ts
if (error.startsWith('CAPACITY_WARNING:')) {
  // Show confirmation dialog, then retry with overrideCabinetConflict: true
} else {
  toast.error(error);
}
```

---

### `PUT /api/schedule/:id` — Update block

**Roles:** ADMIN, OWNER  

**Request** (all fields optional, partial update):
```json
{
  "cabinetId": 3,
  "days": [0, 2, 4],
  "teacherId": 15,
  "level": "Advanced",
  "chapter": 1
}
```

**Group-pair write ownership (added 2026-07-04):** this endpoint is now for **standalone blocks only** (no `studentGroupId`, or a closed historical version with `endDate` set). If the block has an active Grammar/Club pair (`studentGroupId` set, `endDate: null`, not archived), the request is rejected before any mutation:
```json
{ "success": false, "code": "GROUP_PAIR_OWNED", "error": "Use group-pair endpoint to edit grouped schedule blocks" }
```
Use `PUT /api/schedule/group-pair/:studentGroupId` to edit an active Grammar/Club pair. (The old per-block update-both-siblings behavior described below only ever applied when this guard wasn't in place — it's now unreachable for active grouped blocks.)

**Binding required (added 2026-07-13):** a block can never end up without a StudentGroup binding:
- Explicit unbind (`studentGroupId: null` / `""`) → `400 { "code": "STUDENT_GROUP_REQUIRED" }`.
- Saving a legacy standalone block (`studentGroupId: null` in DB) without providing `studentGroupId` in the body → same 400. To fix a legacy «без привязки» block, either bind it to an unscheduled group via this endpoint or delete it.
- Rebinding to a group that already has an active block elsewhere → `409 { "code": "GROUP_ALREADY_IN_SCHEDULE" }` (mirrors the POST guard; prevents duplicate pairs in the grid).

> If the block has a `studentGroupId` (closed historical version only, since active is now rejected above), the server atomically updates:  
> 1. `StudentGroup.level/chapter/maxStudents`  
> 2. All sibling blocks in the same group via `updateMany`  
> 3. The target block itself  

**Response:**
```json
{ "success": true, "data": { /* updated LessonBlock with teacher, cabinet, studentGroup */ } }
```

---

### `DELETE /api/schedule/:id` — Delete block

**Roles:** ADMIN, OWNER

No request body.

**Group-pair write ownership (added 2026-07-04):** this endpoint is now for **standalone blocks only**. If the block has an active Grammar/Club pair (`studentGroupId` set, `endDate: null`, not archived), the request is rejected before any archiving:
```json
{ "success": false, "code": "GROUP_PAIR_OWNED", "error": "Use group-pair endpoint to delete grouped schedule blocks" }
```
Use `DELETE /api/schedule/group-pair/:studentGroupId` to delete an active Grammar/Club pair.

**Side effects (all in transaction):**
- Future eligible sessions are soft-deleted/invalidated according to lifecycle rules
- No automatic credit refund is performed inside normal cancel/delete flow
- Sessions with `creditDeducted=true` cannot be normally cancelled; use an explicit correction/ledger flow first
- LessonBlock physically deleted

**Response:**
```json
{ "success": true }
```

---

### `DELETE /api/schedule/group-pair/:studentGroupId` — Delete Grammar/Club pair (added 2026-07-04)

**Roles:** OWNER, SUPERADMIN (`schedule:delete`)

No request body (optional `{ "reason": string }`).

Replaces the old client-side loop of `DELETE /api/schedule/:id` per block, which could leave a
pair half-deleted if the second request failed. This endpoint finds the group's active blocks
itself (`schoolId`, `studentGroupId`, `deletedAt: null`, `endDate: null`) and archives all of
them in one transaction — either the whole pair (or single Grammar-only block) is archived, or
nothing is. Self-healing: if the group was already left half-deleted by the old buggy flow, the
next call archives whatever active block remains.

**Side effects (all in one transaction, same as `DELETE /:id` per block):**
- Each active block is soft-archived (`deletedAt` set, `status: CANCELLED`) via `archiveLessonBlockInTx`
- Future eligible sessions per block are invalidated according to lifecycle rules; history (attendance/credit logs/teacher payments) is never touched
- One `DELETE_GROUP_PAIR` audit log entry, plus the existing per-block `ARCHIVE_BLOCK` entries from the archive step
- Cache invalidation + `schedule:structure-changed` (`group-pair-deleted`) socket emit happen once, after commit

**Errors:**
- `404` — no active blocks found for this `studentGroupId` in the caller's school (already deleted, or group belongs to another school)
- `422` — a block's current status doesn't allow archiving for the caller's role (see `canBlockTransition`)

**Response:**
```json
{ "success": true, "data": { "studentGroupId": 42, "archived": [ { "blockId": 101, "archivedAt": "...", "alreadyArchived": false, "invalidatedFutureSessions": 3, "counts": { "...": "..." } } ] } }
```

---

## 3. Sessions

### `GET /api/schedule/sessions/week?weekStart=YYYY-MM-DD`

**Roles:** ADMIN, OWNER  
**Purpose:** Source of truth for substitutions and cancellations in WeekGrid.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 201,
      "lessonBlockId": 42,
      "date": "2026-05-12",
      "status": "UPCOMING",
      "teacher": {
        "id": 12,
        "firstName": "Дана",
        "lastName": "Иванова"
      }
    },
    {
      "id": 202,
      "lessonBlockId": 45,
      "date": "2026-05-13",
      "status": "CANCELLED",
      "teacher": null
    }
  ]
}
```

> `teacher.id` = **User.id** (after mapTeacher conversion)  
> Only returns sessions with `teacherId != null` OR `status = CANCELLED`  
> Client uses this to build `weekSessions` and `cancelledSessions` maps.

---

### `POST /api/schedule/session/ensure`

**Roles:** ADMIN, OWNER  
**Purpose:** Lazy-create a session if it doesn't exist yet (for dates outside rolling window).

**Request:**
```json
{
  "lessonBlockId": 42,
  "date": "2026-06-01"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 305,
    "lessonBlockId": 42,
    "date": "2026-06-01T12:00:00.000Z",
    "status": "UPCOMING",
    "teacher": null
  }
}
```

---

### `PATCH /api/schedule/session/:id/teacher`

**Roles:** ADMIN, OWNER  
**Purpose:** Assign a substitute teacher for a specific session.

**Request:**
```json
{
  "teacherId": 15
}
```

> `teacherId` = **User.id**  
> Send `null` to remove substitution.

**Response — success:**
```json
{
  "success": true,
  "data": {
    "id": 201,
    "teacherId": 9,
    "teacher": {
      "id": 15,
      "firstName": "Нурлан",
      "lastName": "Сеит"
    }
  }
}
```

**Response — conflict (409):**
```json
{
  "success": false,
  "error": "Конфликт: у учителя есть постоянный урок в это время (Elementary, 09:00–10:20)"
}
```

**Side effect:** Notifications sent to all students in the group.  
**Required client action after success:** call `onReload()` + `loadWeekSessions()`.

---

### `PATCH /api/schedule/session/:id/details`

**Roles:** ADMIN, OWNER  
**Purpose:** Exception engine — override cabinet or time for a single session (1 day).

**Request (all fields optional):**
```json
{
  "startTime": "10:00",
  "endTime": "11:20",
  "cabinetId": 5,
  "overrideCabinetConflict": false
}
```

**Response — success:**
```json
{
  "success": true,
  "data": {
    "id": 201,
    "startTimeSnap": "10:00",
    "endTimeSnap": "11:20",
    "cabinetIdSnap": 5
  }
}
```

**Response — conflict (409 or 400 with CAPACITY_WARNING):**
```json
{
  "success": false,
  "error": "Конфликт: Кабинет уже занят другим уроком в это время (10:00–11:20)"
}
```

**Required client action after success:** call `onReload()` + `loadWeekSessions()`.

---

### `PATCH /api/schedule/session/:id/status`

**Roles:** ADMIN, OWNER, TEACHER

**Request:**
```json
{
  "status": "CANCELLED"
}
```

Valid statuses: `"UPCOMING"` | `"IN_PROGRESS"` | `"COMPLETED"` | `"LOCKED"` | `"CANCELLED"`

**Response:**
```json
{ "success": true, "data": { /* updated LessonSession */ } }
```

**Side effect when `CANCELLED`:** Notifications sent to all students in the group.  
**Required client action after success:** call `loadWeekSessions()`.

**409 — Cancel blocked (SESSION_HAS_DEDUCTED_CREDITS):**
```json
{
  "success": false,
  "error": "SESSION_HAS_DEDUCTED_CREDITS",
  "lifecycleError": true,
  "message": "Cannot cancel: session has attendance with deducted credits. Use a correction flow."
}
```
Returned when any `Attendance` record for the session has `creditDeducted=true`.
Correction flow (manual credit adjustment) must be applied first.

---

### `POST /api/schedule/sessions/bulk-cancel`

**Roles:** OWNER, ADMIN (`schedule:write`)  
**Purpose:** Cancel all UPCOMING sessions for a given calendar day. Each session is processed through the lifecycle service (audit log, notifications, socket emit). Sessions with `creditDeducted=true` attendance are blocked and appear in `errors[]`; remaining sessions are cancelled. Partial success is valid.

**Request:**
```json
{
  "date": "2026-05-29",
  "reason": "Праздничный день"
}
```

- `date` — any ISO date string; server resolves to school-timezone day boundaries
- `reason` — required, minimum 5 characters; `400` if missing or too short

**Response — full success:**
```json
{ "success": true, "data": { "cancelled": 3, "errors": [] } }
```

**Response — partial success (some sessions blocked):**
```json
{
  "success": true,
  "data": {
    "cancelled": 2,
    "errors": [
      { "sessionId": 145, "error": "SESSION_HAS_DEDUCTED_CREDITS" }
    ]
  }
}
```

**Response — no UPCOMING sessions on that day:**
```json
{ "success": true, "data": { "cancelled": 0 } }
```

**Required client action after success (`cancelled > 0`):** call `loadWeekSessions()` to refresh the grid.

**Note:** `errors` field may be absent when `cancelled === 0` and no sessions exist. Clients must normalise: `errors ?? []`.

---

### `GET /api/schedule/session/:id/students`

**Roles:** All authenticated

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 8,
      "credits": 12,
      "user": {
        "id": 22,
        "firstName": "Айдана",
        "lastName": "Муратова",
        "email": "aidana@example.com"
      }
    }
  ]
}
```

> Primary: from `SessionStudent` snapshot  
> Fallback: from `studentGroup.students` (for sessions created before snapshot feature)

---

### `PATCH /api/schedule/session/:id/attendance` 🔥 CRITICAL

**Roles:** ADMIN, OWNER, TEACHER  
**Purpose:** Mark/update attendance for one student. Triggers credit engine.

**Request:**
```json
{
  "studentProfileId": 8,
  "status": "PRESENT"
}
```

AttendanceStatus values: `"PRESENT"` | `"ABSENT"` | `"LATE"` | `"FROZEN"`

Normal attendance submit uses `"PRESENT"`, `"ABSENT"`, or `"LATE"`. `"FROZEN"` is assigned by freeze logic when `StudentFreeze` applies.

**Response — success:**
```json
{
  "success": true,
  "data": {
    "id": 501,
    "lessonSessionId": 201,
    "studentProfileId": 8,
    "status": "PRESENT",
    "creditDeducted": true,
    "createdAt": "2026-05-12T09:45:00.000Z"
  }
}
```

**Credit logic (server-side, automatic):**

| Old status | New status | creditDeducted | Effect |
|-----------|-----------|----------------|--------|
| none | PRESENT/LATE/ABSENT | false → true | -1 credit + log |
| none | FROZEN | false → false | no credit deduction |
| PRESENT/LATE/ABSENT | PRESENT/LATE/ABSENT | true → true | no duplicate deduction |
| any | FROZEN | false | no credit deduction |

> Client does NOT need to manage credits manually. Just send the new status.  
> The server guarantees idempotency via `creditDeducted` flag.
> Cancellation does not automatically refund credits. Sessions with `creditDeducted=true` are blocked from normal cancellation.

---

## 4. Credits

### `POST /api/credits/add` — Manual credit top-up

**Roles:** ADMIN, OWNER

**Request:**
```json
{
  "studentProfileId": 8,
  "amount": 10,
  "reason": "Оплата за май 2026",
  "paymentAmount": 25000,
  "paymentMethod": "CASH"
}
```

> `amount` can be negative (manual deduction)  
> `paymentAmount` + `paymentMethod` are optional — only for credit purchases (amount > 0)  
> If provided, creates a `StudentPayment` record for finance reporting

**Response:**
```json
{
  "success": true,
  "data": {
    "log": { "id": 90, "amount": 10, "reason": "Оплата за май 2026" },
    "updatedProfile": { "id": 8, "credits": 22 },
    "payment": { "id": 15, "amount": 25000, "method": "CASH" }
  }
}
```

### `GET /api/credits/statement/:studentProfileId?month=YYYY-MM` — Monthly roll-forward statement

**Roles:** ADMIN, OWNER (`finance:read`)

Roll-forward over the credit ledger: `opening + added + deducted = closing`.
`foots` compares `StudentProfile.credits` with `sum(LessonCreditLog.amount)` (all-time) — a
discrepancy is surfaced, never plugged. `month` defaults to the current month **in the
school's timezone**; month boundaries are midnight-to-midnight in `School.timezone`.

**Student self-service variant:** `GET /api/credits/my-statement?month=YYYY-MM` — same
response shape; the profile is resolved from the JWT (`userId`), so no `finance:read`
permission and no foreign profile id is accepted. Any authenticated user with a
student profile.

**Response:**
```json
{
  "success": true,
  "data": {
    "month": "2026-07",
    "opening": -2,
    "added": 0,
    "deducted": -2,
    "closing": -4,
    "ledgerBalance": -4,
    "profileBalance": -4,
    "foots": true,
    "lines": [
      {
        "id": 539,
        "date": "2026-07-07T01:40:52.860Z",
        "amount": -1,
        "reason": "Списание за занятие #8820",
        "type": "DEBIT",
        "sessionId": 8820,
        "sessionDate": "2026-07-06T12:00:00.000Z",
        "actorName": "Admin Owner"
      }
    ]
  }
}
```

---

## 5. Settings

### `PATCH /api/settings` — Update school settings

**Roles:** ADMIN, OWNER

**Request:**
```json
{
  "activeDays": [0, 1, 2, 3, 4],
  "workStart": "08:00",
  "workEnd": "20:00",
  "slotDuration": 80,
  "holidays": ["2026-06-15", "2026-06-16"]
}
```

> All fields optional. Sends only what changed.  
> `activeDays` = number[] (0=Mon..6=Sun)  
> `slotDuration` in minutes (30–240)  
> `holidays` = string[] YYYY-MM-DD — stored in `School.settings.holidays`  
> `help` topics are **not** set here — use the dedicated `GET/PATCH /api/settings/help` (below).

**Response — success (includes policy effectiveFrom info):**
```json
{
  "success": true,
  "policyEffectiveFrom": "2026-06-22T00:00:00.000Z",
  "firstWorkingDate": "2026-06-23",
  "policyImpact": {
    "sessionsOutsideDays": 2,
    "sessionsOutsideHours": 0,
    "blocksOutsideDays": 1,
    "blocksOutsideHours": 0,
    "affectedBlockIds": [42]
  }
}
```

> **No-mutation guarantee:** PATCH /settings NEVER invalidates, cancels, or moves sessions.  
> `policyEffectiveFrom` — ISO timestamp of next Monday in school timezone (new policy takes effect then).  
> `firstWorkingDate` — YYYY-MM-DD of first day that is active under the new `activeDays`.  
> Example: saved Mon 2026-06-15 → `policyEffectiveFrom=2026-06-22`, if Mon excluded → `firstWorkingDate=2026-06-23` (Tue).  
> `policyImpact` is informational only — shown in CrmSettings pre-save modal.

**Response — conflict warning (200, NOT an error):**
```json
{
  "success": false,
  "conflictWarning": true,
  "message": "В Сб есть 3 урок(ов). После сохранения они не будут отображаться в сетке, но данные останутся в базе. Продолжить?",
  "conflictCount": 3
}
```

> `success: false` + `conflictWarning: true` = special case. HTTP 200.  
> Client must show confirmation dialog, then retry with `force: true` in request body.

```ts
// Client handling pattern:
if (!response.success && response.conflictWarning) {
  const confirmed = await showConfirmDialog(response.message);
  if (confirmed) {
    await api.patch('/settings', { ...body, force: true });
  }
}
```

---

### `GET /api/settings/general` — School profile (name, address, phone, email, receipt label)

**Roles:** any authenticated school member (read).

`name`/`address`/`phone`/`email` are the real `School` columns (same ones set at
registration, editable via `PUT /schools/current/me`) — **not** a `School.settings.generalInfo`
JSON blob. `docLabel`/`currency` have no dedicated column and stay in that JSON blob.
`logoUrl`/`description` (2026-08-10) are also real `School` columns; `heroImageUrl` lives in
`School.settings.landingConfig` (same JSON sub-key pattern as `generalInfo`). All three are
**read-only** through this endpoint — writes go through `PATCH /schools/current/branding` below.

```json
{ "success": true, "data": {
  "name": "Adil Language School", "address": "ул. Примерная, 1",
  "phone": "+996700000000", "email": "school@adiltest.edu",
  "docLabel": "Квитанция", "currency": "KGS",
  "logoUrl": "/uploads/8/logo.webp", "description": "Языковая школа в центре города",
  "heroImageUrl": "/uploads/8/hero.webp"
} }
```

### `PATCH /api/settings/general` — Update school profile (`settings:write`)

**Request:** all fields optional, sends only what changed.
```json
{ "name": "...", "address": "...", "phone": "...", "email": "info@school.kg", "docLabel": "...", "currency": "KGS" }
```

> `email` here is the school's own public contact address (shown on receipts/notifications) —
> unrelated to `User.email` (login credential). Validated with a simple format regex; a
> duplicate against another school's `School.email` (unique) returns 400.
> `name` cannot be blanked — empty/whitespace-only returns 400.
> Does **not** accept `logoUrl`/`description`/`heroImageUrl` — see branding endpoint below.

### `PATCH /api/schools/current/branding` — Update school branding (logo/hero photo/description) *(added 2026-08-10)*

**Roles:** `settings:write` **plus an inline OWNER/SUPERADMIN check** — narrower than every
other `settings:write` route, since branding feeds the public landing page. ADMIN gets 403
even though it holds `settings:write` elsewhere (mirrors `upload.ts`'s own OWNER-only policy
and the documented role table, which does not give ADMIN school-settings mutation).

**Request:** all fields optional; empty string clears the field. `logoUrl`/`heroImageUrl` must
either be empty or start with `/uploads/` (the shape `POST /api/upload` returns) — anything
else returns 400.
```json
{ "logoUrl": "/uploads/8/abc.webp", "heroImageUrl": "/uploads/8/def.webp", "description": "..." }
```

**Response:**
```json
{ "success": true, "data": {
  "logoUrl": "/uploads/8/abc.webp", "description": "...", "heroImageUrl": "/uploads/8/def.webp"
} }
```

### `POST /api/upload` — Upload an image *(previously unwired, documented 2026-08-10)*

**Roles:** OWNER/SUPERADMIN only. **Request:** `multipart/form-data`, single field `image`
(JPEG/PNG/GIF/WebP/BMP/TIFF, 5MB cap, SVG rejected, magic-byte validated). Re-encoded to WebP
via `sharp` and stored at `public/uploads/{schoolId}/{uuid}.webp`, served statically at
`/uploads/{schoolId}/{uuid}.webp` off the **API origin** (not `/api/v1`).

```json
{ "success": true, "data": { "url": "/uploads/8/1b6e...-webp-uuid.webp" } }
```

> This endpoint does **not** persist the URL anywhere — the caller must separately save it
> (e.g. via `PATCH /schools/current/branding`). The returned `url` is API-relative: since the
> client and API are on different origins in production, prefix it with `VITE_API_URL` client-side
> (see `resolveUploadUrl()` in `client/src/lib/api.ts`) before rendering it in an `<img>`.

### `GET /api/schools/:slug` — Public school lookup (no auth, used by Login/landing pages)

**Roles:** none — public. Added `phone`/`email` (2026-07-12) so the login page can show the
school's real contact info instead of generic "Shamdan" branding. Added `logoUrl`,
`description`, `createdAt`, `studentCount`, `teacherCount` (2026-08-10) so the public
`/:slug` landing page (`SchoolLanding.tsx`) can show real per-school branding and stats
instead of the same hardcoded template (fake photos, fake "12k+ students", fake pricing) on
every tenant's page. `studentCount`/`teacherCount` are live counts (`User` rows by role,
`deletedAt: null`), not cached.

```json
{ "success": true, "data": {
  "id": 8, "name": "Adil Language School", "slug": "adiltest", "city": "Бишкек",
  "phone": "+996700000000", "email": "school@adiltest.edu",
  "logoUrl": "/uploads/8/logo.webp", "description": "Языковая школа в центре города",
  "createdAt": "2026-01-15T00:00:00.000Z", "studentCount": 42, "teacherCount": 6,
  "landingConfig": { "heroImageUrl": "/uploads/8/hero.webp" }
} }
```

---

### `GET /api/settings/help` — Help topics for the shared `/help` page

**Roles:** any authenticated user (read). Platform-wide (not school-scoped) — reads the `PlatformSettings` singleton (id=1), not `School.settings`. Returns **only** the topics.

```json
{ "success": true, "data": [
  { "title": "Как добавить студента?", "body": "...", "url": "https://docs.example.com/students" },
  { "title": "Как настроить расписание?" }
] }
```

### `GET/PATCH /api/superadmin/help` — Read/replace help topics

**Roles:** SUPERADMIN only. Full replace on PATCH; send the whole array. Authored once for the whole platform — every school's `/help` page reads the same list via `GET /api/settings/help` above. (Moved off `CrmSettings` — school OWNER/ADMIN no longer edit this; see `AI_SCHEDULE_HANDOFF.md` changelog 2026-07-11.)

**Request:** `{ "help": [ { "title": "...", "body": "...", "url": "youtube.com/x" } ] }`

> Server-enforced (`lib/helpTopics.ts`): ≤30 topics; title ≤200, body ≤2000, url ≤500 chars; blank-title rows dropped; bare domains get `https://`; non-http(s) (`javascript:`, `data:`) → `400 { error }`. `Help.tsx` re-applies the http(s) guard at render.

### `GET /api/settings/policy-impact` — Preview policy change impact

**Roles:** ADMIN, OWNER

**Query params:**
```
activeDays=0,1,2,3,4   (comma-separated ints, 0=Mon…6=Sun)
workStart=09:00         (optional)
workEnd=18:00           (optional)
```

**Response:**
```json
{
  "success": true,
  "data": {
    "policyEffectiveFrom": "2026-06-22T00:00:00.000Z",
    "firstWorkingDate": "2026-06-23",
    "removedDays": [0],
    "sessionsOutsideDays": 2,
    "sessionsOutsideHours": 0,
    "blocksOutsideDays": 1,
    "blocksOutsideHours": 0,
    "affectedBlockIds": [42, 43],
    "affectedGroups": [
      {
        "blockId": 42,
        "studentGroupId": 7,
        "groupName": "A1-Morning",
        "level": "A1",
        "type": "GRAMMAR",
        "reason": "NON_WORKING_DAY",
        "days": [0, 1, 2, 3, 4],
        "startTime": "09:00",
        "endTime": "10:00"
      }
    ]
  }
}
```

> Used by CrmSettings to show live preview before saving. Pure read — no mutations.
> `affectedGroups` — itemized per active block (`deletedAt: null AND endDate: null` only); powers the "Открыть" deep-link in `PolicyImpactModal` (`?focusBlockId=&focusDate=&focusStart=&focusEnd=&focusGroupId=` → `Schedule.tsx`).

---

### `GET /api/settings/timeslots`

**Response:**
```json
{
  "success": true,
  "data": {
    "slots": [
      { "id": 1, "startTime": "08:00", "endTime": "09:20", "order": 0 },
      { "id": 2, "startTime": "09:20", "endTime": "10:40", "order": 1 }
    ],
    "activeDays": [0, 1, 2, 3, 4]
  }
}
```

### `GET /api/settings/cabinets` — Cabinet list (any authenticated role)

**Response:** `usageCount` = число активных (`deletedAt: null`) `LessonBlock`, привязанных к кабинету. (Added 2026-07-08.)
```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "101", "capacity": 15, "schoolId": 3, "deletedAt": null, "usageCount": 2 }
  ]
}
```

### `POST /api/settings/cabinets` — Create cabinet (`settings:write`)

**Request:** `{ "name": "101", "capacity": 15 }` — duplicate active name → 400 `Кабинет уже существует`.

### `PATCH /api/settings/cabinets/:id` — Rename / change capacity (`settings:write`, added 2026-07-08)

**Request:** `{ "name": "201", "capacity": 20 }` — оба поля опциональны; пропущенное/невалидное значение сохраняет текущее. Пустое имя → 400; дубликат имени → 400; чужая школа → 404.

**Response:** `{ "success": true, "data": { /* updated Cabinet */ } }`

### `DELETE /api/settings/cabinets/:id` — Soft-delete cabinet (`settings:write`)

Кабинет, используемый в активных блоках, удалить нельзя → 400 `Нельзя удалить кабинет — он используется в N занятиях`.

---

## 6. Error Patterns Reference

| Scenario | HTTP | Response |
|----------|------|---------|
| Auth missing/invalid | 401 | `{ success: false, error: "Unauthorized" }` |
| Role not allowed | 403 | `{ success: false, error: "Forbidden" }` |
| Resource not found | 404 | `{ success: false, error: "..." }` |
| Validation error | 400 | `{ success: false, error: "human-readable message" }` |
| Capacity warning | 400 | `{ success: false, error: "CAPACITY_WARNING:..." }` — parse prefix |
| Settings conflict | 200 | `{ success: false, conflictWarning: true, message: "...", conflictCount: N }` |
| Teacher time conflict | 409 | `{ success: false, error: "Конфликт: ..." }` |
| Server error | 500 | `{ success: false, error: "Failed to ..." }` |

---

## 7. TeacherId Mapping Reminder

| Layer | Value | Note |
|-------|-------|------|
| Request body (client → server) | `User.id` | What client sends |
| DB storage | `StaffProfile.id` | Server converts internally |
| Response body (server → client) | `User.id` | After `mapTeacher()` |

---

## 8. Paginated Endpoints (added 2026-05-10)

### `GET /api/students`

**Roles:** TEACHER, ADMIN, OWNER (`students:read`). A STUDENT/PARENT gets 403 — the roster
exposes classmates' email/phone/credits/paidUntil. Students read their own data via `/students/me/*`.

**Query params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | 1 | Page number (1-based) |
| `limit` | number | 50 | Items per page (max 200) |
| `search` | string | — | Full-text search (name, email, phone) |
| `filter` | string | — | `active` \| `overdue` \| `paused` |
| `level` | string | — | Exact level match (e.g. `Intermediate`) |
| `cabinet` | number | — | Filter by cabinet ID (enrolled block) |
| `archived` | boolean | `false` | `true` = return **archived AND soft-deleted** students (`archivedAt ≠ null` OR `deletedAt ≠ null`); no filter/level/cabinet params, ordered by `deletedAt DESC, archivedAt DESC`. Each row includes both `archivedAt` and `deletedAt` so the client can label "Архивирован" vs "Удалён". Ensures accounts removed by user-delete or `clear-all-data` never silently disappear. |

### `PATCH /api/students/:id` — Update profile / quick payment / gift

Updates student profile fields and optionally records a payment or a gift lesson.

**Roles:** `students:write`

**Request (quick payment):**
```json
{
  "paymentAmount": 5000,
  "paymentMethod": "CASH",
  "paymentNote": "Апрель 2026",
  "paymentDate": "2026-07-05"
}
```

> `paymentMethod` is **uppercase** — `"CASH"`, `"CARD"` or `"TRANSFER"`. Any other value defaults to `CASH`.
> `paymentDate` (optional, 2026-07-11) — backdates the payment record: stored as `StudentPayment.createdAt`, which is the payment date everywhere it is displayed. 400 if not a parseable date. Omitted → `now()`.
>
> **Single money→credits flow (2026-07-11):** the finance dashboard's «Добавить платёж» modal calls this endpoint (not `POST /payments`), so every student payment lands in the wallet and converts to lesson credits identically. `POST /payments` (bare `Payment` rows) remains for invoice-based accounting only.
> Other optional fields: `isFrozen` (bool), `notes` (string), `giftLesson` (bool — +1 credit, no payment), `monthlyFee` (number ≥ 0 or `null` — per-student monthly tuition target; `null` clears the override → falls back to `SchoolFinanceConfig.basePrice`). 400 if `monthlyFee` is a negative or non-numeric non-null value.
>
> **Roles (2026-07-02):** all payment handling — recording (`paymentAmount`) and cancelling/refunding a payment — is allowed for any `students:write` role (ADMIN/OWNER/SUPERADMIN); it's a front-desk task. Only `giftLesson` remains **OWNER/SUPERADMIN only** (403 `FINANCE_WRITE_REQUIRED` otherwise).

**Proportional billing (2026-07-02):** the full `paymentAmount` is added to `StudentProfile.moneyBalance` (a running total, never decremented), then credits owed are derived with exact Decimal math: `owed = floor(moneyBalance * billingDays / fee)`, where `fee = monthlyFee ?? SchoolFinanceConfig.basePrice`. `credits += owed - billingLessonsGranted`. So paying the full monthly fee grants **exactly `billingDays` lessons** (4000 = 26, not 25), any amount is allowed, and the sub-lesson remainder stays banked — no som is dropped. Changing `monthlyFee` "draws a line": the sub-lesson leftover is carried forward at the new price and the accumulator resets, so only future money bills at the new rate; already-granted lessons are untouched. `LessonCreditLog` (type `PAYMENT`) is written only when credits > 0. The response profile includes `moneyBanked` = som banked toward the next lesson, and (2026-08-19) `paymentId` = the created `StudentPayment.id` when a payment was recorded — the client uses this as the row's id for an immediate cancel, instead of a client-generated placeholder that could collide with a real id or overflow the `paymentId` route param's `int4` column.

`GET /api/students/:id/payment-history` returns `monthly: { monthlyFee, monthlyFeeEffective, paidThisMonth, moneyBalance, pricePerLesson }` (stringified decimals) alongside `data` (the payment array; each row includes `cancelledAt`). `moneyBalance` here is the som banked toward the **next** lesson (not the raw accumulator); `pricePerLesson = fee / billingDays`. `paidThisMonth` = sum of non-cancelled `StudentPayment.amount` since the start of the current UTC calendar month.

**`PATCH /api/students/:id/payments/:paymentId/note`** (any `students:write` role, 2026-07-11) — set/replace the payment's comment. **Request:** `{ "note": "string | null" }` — trimmed, capped at 500 chars, empty → `null`. Display-only metadata: allowed on cancelled rows too. 404 if the payment doesn't belong to that student/school.

**`POST /api/students/:id/payments/:paymentId/cancel`** (any `students:write` role — ADMIN/OWNER/SUPERADMIN) — cancels/refunds a recorded payment. Full reversal: removes every lesson the payment granted (`credits -= creditsAdded`, **may go negative** if some were already used), reverses the accumulator (clamped ≥ 0), marks the row `cancelledAt`/`cancelledById` (kept for audit), writes a `LessonCreditLog` (type `REFUND`, `amount = -creditsAdded`), and notifies OWNER+ADMIN (`PAYMENT_CANCELLED`). Response: `{ credits, paidUntil, cancelledPaymentId }`. 400 (`Invalid payment id`) if `paymentId` isn't a positive integer within `int4` range (2026-08-19 — guards against a client-side placeholder id); 404 if student/payment not found; 409 if already cancelled.

**Idempotency:** When `paymentAmount > 0`, the `Idempotency-Key` header (UUID) is **REQUIRED**. Missing it returns `400 { code: "IDEMPOTENCY_KEY_REQUIRED" }`. Same key replays the cached `StudentPayment` instead of creating a duplicate — including when two requests race (the loser's unique-constraint violation is converted to a replay response, never a 500). The client holds one key per submission attempt: stable across retries of the same amount (timeout → retry replays safely), regenerated when the amount changes.

**Errors:** 400 if quick payment without `Idempotency-Key`; 400 if `paymentAmount` is non-finite or > 10 000 000; 404 if student not found.

### `PATCH /api/students/:id/archive`

Move student to archive (soft). Sets `User.archivedAt = now()`. Student disappears from active list. All history preserved. Reversible.

**Roles:** `students:write`

**Response:** `{ "success": true }`

**Errors:** 404 if not found / already archived.

### `PATCH /api/students/:id/unarchive`

Restore a student from **archive OR soft-delete**. In a transaction clears `User.archivedAt`, `User.deletedAt`, and `StudentProfile.deletedAt`, returning the account to the active list. Matches any student with `archivedAt ≠ null` OR `deletedAt ≠ null`.

Soft-deleted groups are **not** resurrected — withdrawn memberships stay withdrawn; the student must be re-enrolled explicitly. No credit/salary side effects.

**Roles:** `students:write`

**Response:** `{ "success": true }`

**Errors:** 404 if not found, or neither archived nor soft-deleted.

**Response:**
```json
{
  "success": true,
  "data": [ /* StudentProfile[] with user + enrolledGroups */ ],
  "meta": {
    "total": 1523,
    "page": 1,
    "limit": 50,
    "pages": 31,
    "counts": {
      "all": 1523,
      "active": 1200,
      "overdue": 87,
      "paused": 236
    }
  }
}
```

### `GET /api/users?role=TEACHER`

**Query params:** `page`, `limit`, `search`, `role`

**Response:**
```json
{
  "success": true,
  "data": [ /* User[] */ ],
  "meta": { "total": 45, "page": 1, "limit": 50, "pages": 1 }
}
```

### `PATCH /api/users/:id/staff-profile`

Requires `schedule:write`. Обновляет настройки сотрудника (учителя/админа). Все поля опциональны.

**Request:**
```json
{
  "workingDays": [0, 1, 2, 3, 4],
  "maxLessonsPerDay": 6,
  "salaryRate": 500,
  "notes": "Заметка о сотруднике"
}
```

`notes` (added 2026-07-12) — свободный текст, `null` очищает. Хранится в `StaffProfile.notes`
(зеркало `StudentProfile.notes`), возвращается в `staffProfile` из `GET /users`.
Редактируется во вкладке «Информация» профиля сотрудника на странице Сотрудники.

**Response:** `{ "success": true, "data": { /* StaffProfile */ } }`

### `PATCH /api/users/:id/role` (added 2026-08-18)

Changes a staff member's role. Requires `users:manage` (OWNER + SUPERADMIN hold it; ADMIN does not).
The only two transitions this endpoint permits are `ADMIN → OWNER` (promotion) and `OWNER → ADMIN`
(demotion) — SUPERADMIN can never be assigned or targeted.

**Request:**
```json
{ "role": "OWNER" }
```
`role` must be exactly the string `"OWNER"` or `"ADMIN"` — anything else (including any other role
name) is a `400`, checked by strict equality before it is used for anything.

**Response:**
```json
{
  "success": true,
  "data": { "id": 12, "firstName": "...", "lastName": "...", "email": "...", "phone": "...", "role": "OWNER", "schoolId": 3 }
}
```

**Errors:**
- `400` — `role` is not exactly `"OWNER"`/`"ADMIN"`
- `400` — target user is the requester (no self-service role change)
- `400` — would demote the last remaining OWNER in the school (`"В школе должен остаться хотя бы один владелец"`)
- `404` — target not found, in a different school, soft-deleted, or not currently ADMIN/OWNER

**Guards:** same-school only (`schoolId` from JWT); the whole read-check-write sequence runs inside
one Prisma transaction; the last-OWNER check row-locks every current OWNER (`SELECT ... FOR UPDATE`)
before counting, so two concurrent demotions of two different owners can't both read "≥2 owners left"
under READ COMMITTED and leave the school with zero.

**Side effects:** emits a `STAFF_ROLE_CHANGED` notification to the affected user and a `ROLE_CHANGED`
security audit event (`logSecurityEvent`). Both happen after the transaction commits and are best-effort
(a notification failure does not roll back the already-committed role change).

**Asymmetry with account creation:** `ROLE_CREATION_WHITELIST` (same file, `routes/users.ts`) still
does **not** let OWNER *create* a new user directly as OWNER — `POST /users` only allows OWNER to create
ADMIN/TEACHER/STUDENT accounts. Promoting an existing ADMIN via this endpoint is the only supported path
to a school having a second OWNER.

### `GET /api/groups`

**Query params:** `page`, `limit`, `search`, `status`, `level`

**Response:**
```json
{
  "success": true,
  "data": [ /* StudentGroup[] with blocks + students */ ],
  "meta": { "total": 120, "page": 1, "limit": 50, "pages": 3 }
}
```

**Backward compatibility:** Client reads `res.data?.data ?? []` — safe if server returns flat array.

---

### `PATCH /api/v1/groups/:id/students/book` (added 2026-07-03)

Отметка «Книга выдана» для участников группы (кнопка «Книга» в расписании).
Requires `schedule:write`.

**Request:**
```json
{
  "studentProfileIds": [12, 15],
  "bookIssued": true
}
```
`studentProfileIds` optional — без него применяется ко всем ACTIVE участникам группы.

**Response:**
```json
{ "success": true, "data": { "updated": 2 } }
```

Хранится в `GroupMembership.bookIssued`. `GET /api/v1/schedule` включает `bookIssued`
в каждый элемент `studentGroup.memberships`.

**Payload note (2026-07-03):** `studentGroup.memberships[].studentProfile` в `GET /api/v1/schedule`
теперь slim: `{ id, user: { firstName, lastName } }` — полные поля профиля (credits,
moneyBalance и т.д.) из этого ответа убраны ради размера payload. Клиенту нужны только id и имя.

---

### `PATCH /api/v1/groups/:id/chapter` (added 2026-07-03, per-student 2026-07-04)

Смена текущей главы (кнопки «−/+» в расписании: в bulk-строке и в строке студента).
Requires `schedule:write`. Группа должна быть ACTIVE.

**Request:** `{ "chapter": 5, "studentProfileIds": [12] }` (chapter 1–999; ids опциональны)

- **Без `studentProfileIds`** (bulk): `StudentGroup.chapter` + `chapter` живых `LessonBlock`
  + `StudentProfile.chapter` всех ACTIVE участников — одна транзакция.
- **С `studentProfileIds`**: только `StudentProfile.chapter` указанных участников
  (валидируются через ACTIVE membership в этой группе); глава группы не трогается.

**Response:** `{ "success": true, "data": { "chapter": 5, "studentsUpdated": 15 } }`

`GET /api/v1/schedule` включает `chapter` в `studentGroup.memberships[].studentProfile`.
**Намеренно** не применяет identity-lock `groupHasLifecycleHistory`
(`GROUP_LEVEL_CHAPTER_LOCKED`): смена главы — рутинный прогресс, не смена идентичности
когорты. Смена level по-прежнему идёт через `PUT /schedule/group-pair` с полным lock.

---

## 9. WebSocket Events (added 2026-05-10)

Socket.IO endpoint: same port as REST API (`http://localhost:3001`).

**Auth:** Pass JWT in handshake (access token is held in memory client-side — see `client/src/lib/api.ts`'s `getAccessToken()`, not localStorage):
```ts
const socket = io('http://localhost:3001', {
  auth: { token: getAccessToken() }
});
```

**Events emitted by server:**

| Event | Payload | Trigger |
|-------|---------|---------|
| `session:status-changed` | `{ sessionId, lessonBlockId, status, date }` | `PATCH /session/:id/status` |
| `attendance:updated` | `{ sessionId, studentProfileId, status }` | `PATCH /session/:id/attendance` |

**Error codes:**
- `Unauthorized` — missing or invalid token in handshake → socket disconnects immediately.

**Never** send `StaffProfile.id` from the client. Always send `User.id`.

---

## 10. Schedule Integrity Check (added 2026-05-19)

```
GET /api/v1/schedule/integrity
Authorization: Bearer <token>
Roles: OWNER, ADMIN, SUPERADMIN (requires analytics:read permission)
```

**Response:**
```json
{
  "violations": [
    {
      "check": "Teacher double-booking: same teacher assigned to overlapping blocks simultaneously",
      "count": 2,
      "ids": [101, 107],
      "severity": "CRITICAL"
    },
    {
      "check": "Student double-booking: Grammar and Club of same group overlap in time/days",
      "count": 2,
      "ids": [203, 208],
      "severity": "WARNING"
    }
  ]
}
```

`ids` — до 20 ID затронутых `LessonBlock` (Check 11, 12) или других сущностей.  
`severity`: `"CRITICAL"` | `"WARNING"`.  
Пустой массив `violations: []` означает отсутствие нарушений.

**Checks included (12 total):**
- 1–10: финансовые integrity-проверки (attendance/salary/credits)
- **11**: teacher double-booking — один `teacherId` в двух overlapping активных блоках (CRITICAL)
- **12**: student double-booking — Grammar+Club одной группы пересекаются по времени/дням (WARNING)

---

## 10.1 Operational Debt — removed (2026-07-04)

`GET /schedule/operational-debt` and its `OperationalDebtPanel` client surface, along with `GET /schedule/audit/feed` and `DirectorChangeFeed`, were removed as part of a product scope correction: "Операционный контроль" on the Schedule page is scoped to schedule policy/conflict control only, not generic operational debt (overdue attendance, cancelled-without-compensation, teacher/group risk counters) or a recent-changes feed. See `AI_SCHEDULE_HANDOFF.md` changelog for the removal history — both endpoints and their backing read-model services (`operationalDebtReadModelService.ts`, `scheduleAuditReadModelService.ts`) were deleted, not just unmounted.

> **RBAC hardened (2026-07-04, still in effect):** `GET /schedule/policy-conflicts` and `GET /schedule/attendance-dashboard` require `analytics:read` (OWNER/ADMIN/SUPERADMIN only), matching `GET /schedule/integrity`'s existing convention. `GET /settings/policy-impact` was already correctly gated by `settings:write`.

---

## Phase 7.1 — Invoice & Payment Endpoints

All endpoints require `authenticate` + `requirePermission('finance:write'|'finance:read')`.

### POST /api/v1/invoices
Create a draft invoice, optionally with inline lines.

**Request:**
```json
{
  "studentProfileId": 42,
  "dueDate": "2026-06-30T00:00:00.000Z",
  "note": "June tuition",
  "currencyCode": "KGS",
  "lines": [
    { "type": "TUITION", "description": "June lessons", "quantity": "8", "unitPrice": "500", "creditsToIssue": 8 },
    { "type": "MATERIAL", "description": "Workbook", "quantity": "1", "unitPrice": "300" }
  ]
}
```
**Response 201:**
```json
{ "success": true, "data": { "id": 1, "status": "DRAFT", "totalAmount": "4300.00", "paidAmount": "0.00", "lines": [...] } }
```

### POST /api/v1/invoices/:id/lines
Add a line to a DRAFT invoice. Throws 409 if invoice is not DRAFT.

### POST /api/v1/invoices/:id/issue
Transition DRAFT → ISSUED. Throws 422 if invoice has no lines.

### POST /api/v1/invoices/:id/void
Void an invoice. Throws 409 if invoice has confirmed payment allocations.

**Rule:** VOID ≠ refund. Voiding an invoice with allocations requires voiding the payment first.

### GET /api/v1/invoices?studentProfileId=&status=&page=&limit=
Paginated list. Response: `{ data, meta: { total, page, limit, pages } }`.

### GET /api/v1/invoices/:id
Full invoice with lines + allocations (including payment method/status).

---

### POST /api/v1/payments
Create a payment and optionally allocate to invoices in one transaction.

**Request:**
```json
{
  "studentProfileId": 42,
  "amount": "4300.00",
  "method": "CASH",
  "note": "June payment",
  "allocations": [
    { "invoiceId": 1, "amount": "4300.00" }
  ]
}
```
**Response 201:**
```json
{ "success": true, "data": { "payment": { "id": 7, "status": "CONFIRMED", ... }, "allocations": [...] } }
```

**Overpayment guard:** `SUM(allocations) > invoice.totalAmount` → 422.

### PATCH /api/v1/payments/:id/note
Set/replace the payment's comment (2026-07-11). **Request:** `{ "note": "string | null" }` — trimmed, capped at 500 chars, empty → `null`. Display-only metadata: allowed on any status (`finance:write`). 404 if payment not in school.

### POST /api/v1/payments/:id/void
Void a CONFIRMED payment. Allocations remain (audit trail). Invoice `paidAmount` recalculated.

### POST /api/v1/payments/:id/allocate
Allocate an existing CONFIRMED payment to an invoice after creation.

**Request:** `{ "invoiceId": 2, "amount": "2000.00" }`

### GET /api/v1/payments?studentProfileId=&status=&page=&limit=&includeCredits=
List payments for the school. Each row carries `source: 'PAYMENT'`.

- `includeCredits=true` — also merges credit top-ups (`StudentPayment`, written by the quick-payment flow) into the list as income, mapped to the Payment shape: `status: 'CONFIRMED'` (or `'VOIDED'` when `cancelledAt` is set — cancelled top-ups drop out of income totals, 2026-07-11), `paidAt = StudentPayment.createdAt`, `voidedAt` ← `cancelledAt`, `receivedBy` ← `createdBy`, `studentProfile.user` includes `id` (needed for the cancel route), and `source: 'CREDIT_TOPUP'` (no `allocations`/`refundEvents`; undo goes through `POST /students/:id/payments/:paymentId/cancel`, which reverses the granted credits). Ignored when `status` is also supplied (credit top-ups have no status to filter on). With this flag `meta.total` is the combined count and therefore approximate for paging. Used by the finance dashboard so money entered via quick payments appears as income.

### GET /api/v1/payments/:id
Full payment with allocations and invoice summaries.

---

## Phase 7.4 v1 — Receivables Endpoints

All endpoints are read-only and require `authenticate` + `requirePermission('finance:read')`.

Phase 7.4 uses computed overdue. `InvoiceStatus.OVERDUE` is not canonical in v1.

```text
isOverdue =
  status IN (ISSUED, PARTIALLY_PAID)
  AND dueDate IS NOT NULL
  AND dueDate < asOf
  AND outstanding > 0
```

Money debt is invoice receivable debt only. Credit debt is active `FinancialAdjustment(type=BALANCE_DEBT, amountCredits)` and is exposed separately.

### GET /api/v1/receivables/student/:studentProfileId

Query params:
- `asOf` optional ISO datetime. Defaults to server `now`.

Response:
```json
{
  "success": true,
  "data": {
    "studentProfileId": 42,
    "totalIssued": "1500",
    "totalPaid": "200",
    "totalRefunded": "0",
    "totalOutstanding": "1300",
    "overdueOutstanding": "1000",
    "activeInvoiceCount": 2,
    "overdueInvoiceCount": 1,
    "creditDebtAmount": 7,
    "moneyDebtAmount": "1300",
    "invoices": [
      {
        "invoiceId": 1,
        "status": "ISSUED",
        "totalAmount": "1000",
        "netPaid": "0",
        "outstanding": "1000",
        "isOverdue": true
      }
    ]
  }
}
```

### GET /api/v1/receivables/overdue

Query params:
- `asOf` optional ISO datetime.

Returns active invoices that are dynamically overdue at `asOf`.

### GET /api/v1/receivables/summary

Query params:
- `asOf` optional ISO datetime.

Returns school-level receivable totals:
- `totalIssued`
- `totalPaid`
- `totalRefunded`
- `totalOutstanding`
- `overdueOutstanding`
- `activeInvoiceCount`
- `overdueInvoiceCount`
- `studentCountWithOutstanding`
- `moneyDebtAmount`
- `creditDebtAmount`

---

## Finance — Refund endpoints (Phase 7.6)

### POST /api/v1/payments/:id/refunds

Creates a PENDING refund draft for a confirmed payment. Requires `paymentAllocationId` — the ID of the `PaymentAllocation` record (from `GET /payments/:id` → `allocations[].id`).

```json
// Request
{
  "reason": "Отказ от обучения",
  "allocations": [
    { "paymentAllocationId": 42, "amount": 5000 }
  ]
}
// Response 201
{
  "success": true,
  "data": { "id": 7, "status": "PENDING", "amount": "5000", "reason": "...", "createdAt": "..." }
}
```

Errors: `PAYMENT_NOT_FOUND`, `PAYMENT_NOT_CONFIRMED`, `REFUND_EXCEEDS_REFUNDABLE_BALANCE`

### POST /api/v1/payments/refunds/:refundId/confirm

Confirms a PENDING refund. Reverses credits proportionally, recomputes invoice `paidAmount`/`status`.

```json
// Response 200
{ "success": true, "data": { "id": 7, "status": "CONFIRMED", "confirmedAt": "..." } }
```

Errors: `REFUND_NOT_FOUND`, `REFUND_ALREADY_CONFIRMED`, `REFUND_ALREADY_VOIDED`

### POST /api/v1/payments/refunds/:refundId/void

Voids a PENDING refund (cannot void CONFIRMED). Re-issues credits if the refund was CONFIRMED.

```json
// Response 200
{ "success": true, "data": { "id": 7, "status": "VOIDED", "voidedAt": "..." } }
```

Errors: `REFUND_NOT_FOUND`, `REFUND_ALREADY_VOIDED`

### Client-side usage (financeApi.ts)

```typescript
// refundApi.create(paymentId, { reason, allocations }) → PaymentRefund
// refundApi.confirm(refundId) → PaymentRefund
// refundApi.void(refundId) → PaymentRefund
//
// RefundModal auto-confirms after create. If confirm fails, exposes retry UI with refundId.
```

Note: `GET /payments/` list response includes `refundEvents: { id, amount, status, createdAt, confirmedAt }[]`.
`GET /payments/:id` detail includes full `refundEvents` with nested `allocations[].paymentAllocation`.
`Payment.status` = `REFUNDED` once at least one CONFIRMED refund exists (set by refundService).

---

## Phase 8 — Analytics Endpoints

### GET /analytics/receivables-aging

Snapshot of overdue invoices bucketed by days past due. Not period-dependent — always reflects current state.

```
GET /api/v1/analytics/receivables-aging
Authorization: Bearer <token>
Permission: analytics:read
```

```json
// Response 200
{
  "success": true,
  "data": {
    "asOf": "2026-05-24T12:00:00.000Z",
    "buckets": [
      { "label": "0–30 дн.", "minDays": 0, "maxDays": 30, "count": 3, "amount": 45000 },
      { "label": "31–60 дн.", "minDays": 31, "maxDays": 60, "count": 1, "amount": 12000 },
      { "label": "61–90 дн.", "minDays": 61, "maxDays": 90, "count": 0, "amount": 0 },
      { "label": "90+ дн.", "minDays": 91, "maxDays": null, "count": 2, "amount": 28000 }
    ],
    "total": { "count": 6, "amount": 85000 }
  }
}
```

Source of truth: `receivableService.listOverdueInvoices()` — same formula as `/receivables/overdue`.

### GET /analytics/finance (updated Phase 8)

Added invoice-based KPIs to existing response:

```json
// metrics now includes:
"collectedAmount":     { "value": 240000, "change": 12 },
"refundedAmount":      { "value": 5000,   "change": -3 },
"refundRate":          { "value": 2,       "change": 0 },
"collectionRate":      { "value": 85,      "change": 0 },
"avgInvoiceValue":     { "value": 18000,   "change": 0 },
"paidInvoiceCount":    { "value": 14,      "change": 0 },
"overdueInvoiceCount": { "value": 3,       "change": 0 },
"totalOverdueOutstanding": { "value": 42000, "change": 0 }

// tables now includes:
"agingBuckets": [
  { "label": "0–30 дн.", "minDays": 0, "maxDays": 30, "count": 2, "amount": 20000 },
  ...
]
```

Existing keys (income, expenses, profit, debt, financeData, incomeByCategory, debtors) unchanged.

### GET /analytics/operations (updated Phase 8)

Added academic KPIs to existing response:

```json
// metrics (new):
{
  "studentActive": 47,
  "studentPaused": 3,
  "studentFrozen": 2,
  "studentTotal": 52,
  "groupActive": 8,
  "groupPaused": 1,
  "groupCompleted": 3,
  "avgCredits": 14,
  "attendanceRate": 87,
  "sessionCancelled": 2,
  "sessionInvalidated": 0
}
```

Existing charts (groupFillData, attendanceData, cefrProgress, teacherHeatData) unchanged.


---

## Phase 9 — Production Hardening Endpoints

### GET /health/ready

Readiness probe (outside `/api/v1`). Returns 200 when DB is reachable, 503 otherwise.

```
GET /health/ready
```

200 Response:
```json
{ "status": "ready", "ts": "2026-05-24T12:00:00.000Z" }
```

503 Response (DB unreachable):
```json
{ "status": "not_ready", "error": "database unreachable", "ts": "..." }
```

### GET /api/v1/admin/consistency-check

Read-only data integrity audit for the caller's school. OWNER only (requires `users:manage`).

```
GET /api/v1/admin/consistency-check
Authorization: Bearer <token>
```

200 Response:
```json
{
  "success": true,
  "data": {
    "schoolId": 1,
    "checkedAt": "2026-05-24T12:00:00.000Z",
    "totalViolations": 2,
    "criticalCount": 1,
    "warningCount": 1,
    "violations": [
      {
        "check": "Attendance on INVALIDATED session (ghost billing risk)",
        "count": 3,
        "ids": [45, 46, 47],
        "severity": "CRITICAL",
        "details": [
          {
            "id": 45,
            "label": "Aida Karimova",
            "sublabel": "Урок 2026-06-02 (INVALIDATED) · группа B1",
            "scheduleTarget": { "blockId": 12, "groupId": 7, "startTime": "10:00", "endTime": "11:30" }
          }
        ]
      },
      {
        "check": "TeacherPayment lessonsCount ≠ TeacherPaymentLesson.count (denorm inconsistency)",
        "count": 1,
        "ids": [12],
        "severity": "WARNING",
        "details": [
          { "id": 12, "label": "Nurlan Bekov", "sublabel": "Период 2026-05 · записано уроков: 18" }
        ]
      }
    ]
  }
}
```

Notes:
- Returns 403 for ADMIN role
- Never modifies data (read-only)
- ids array capped at 20 per violation
- `details[]` (added, resolved from the same capped `ids`) gives a human-readable label/sublabel per entity, plus `scheduleTarget` when the entity traces to a `LessonBlock` — the client builds `?openBlockId=&openGroupId=&openStart=&openEnd=` from it to deep-link into `/owner/schedule` (see `server/src/services/violationDetailService.ts`). Checks without a mapped entity kind omit `details`; the client falls back to the raw `ids` list. `GET /api/v1/admin/reconciliation` issues carry the same shape as a singular `detail` field instead of an array.

### GET /api/v1/students/me/credit-logs (updated Phase 9)

Now paginated. Accepts `?page=&limit=` (limit ≤ 200, default 100).

```
GET /api/v1/students/me/credit-logs?page=1&limit=50
```

200 Response (updated):
```json
{
  "success": true,
  "data": [...],
  "meta": { "total": 247, "page": 1, "limit": 50, "pages": 5 }
}
```

---

## Phase 10 — Permissions / Audit Log Endpoints

### GET /api/v1/admin/audit-log

Paginated audit trail of all `ScheduleActionLog` entries for the caller's school. Supports filtering by entity type, action keyword, actor, and date range. OWNER + SUPERADMIN only (requires `users:manage` permission).

```
GET /api/v1/admin/audit-log?page=1&limit=50&entityType=payment&action=SALARY&actorId=12&dateFrom=2026-05-01&dateTo=2026-05-31
Authorization: Bearer <token>
```

**Query parameters (all optional):**

| Param | Type | Description |
|-------|------|-------------|
| `page` | int | Page number (default: 1) |
| `limit` | int | Items per page, max 100 (default: 50) |
| `entityType` | string | Filter by entity type: `payment`, `session`, `import`, `invoice`, etc. |
| `action` | string | Case-insensitive substring match on action name |
| `actorId` | int | Filter by `User.id` of the actor |
| `dateFrom` | ISO date | `createdAt >= dateFrom` |
| `dateTo` | ISO date | `createdAt <= dateTo` |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": 42,
      "action": "SALARY_PAY",
      "entityType": "payment",
      "sessionId": null,
      "blockId": null,
      "groupId": null,
      "before": null,
      "after": { "staffProfileId": 7, "period": "2026-05", "lessonsCount": 14, "amount": 84000, "rateSnapshot": 6000 },
      "reason": null,
      "ipAddress": null,
      "createdAt": "2026-05-24T10:30:00.000Z",
      "actor": { "id": 5, "name": "Марина Ахметова", "role": "OWNER" }
    },
    {
      "id": 41,
      "action": "BULK_IMPORT_STUDENTS",
      "entityType": "import",
      "before": null,
      "after": { "created": 18, "updated": 2, "skipped": 1, "total": 21 },
      "actor": { "id": 5, "name": "Марина Ахметова", "role": "OWNER" },
      "createdAt": "2026-05-23T14:12:00.000Z"
    }
  ],
  "meta": { "total": 87, "page": 1, "limit": 50, "pages": 2 }
}
```

**Audit action names written by Phase 10:**

| Action | entityType | Trigger |
|--------|-----------|---------|
| `SALARY_PAY` | `payment` | `POST /salary/pay/:staffProfileId` |
| `SALARY_PAYMENT_VOIDED` | `payment` | `DELETE /salary/pay/:paymentId` (was `SALARY_PAYMENT_DELETED` before 2026-07-11 — payouts are voided, not deleted) |
| `BULK_IMPORT_STUDENTS` | `import` | `POST /importexport/import/apply` (non-dryRun) |
| `BULK_IMPORT_TEACHERS` | `import` | `POST /importexport/import/apply-teachers` (non-dryRun) |

Errors: 403 if role is ADMIN.

---

## Freeze Endpoints (PR 5 — 2026-05-31)

### POST /api/v1/freeze — Create a freeze

**Requires:** `freeze:write` (OWNER / ADMIN / SUPERADMIN)

**Body:**
```json
{
  "studentProfileId": 42,
  "type": "LESSON_SKIP",       // or "PERIOD"
  "lessonSessionId": 77,       // required for LESSON_SKIP
  "startDate": null,           // required for PERIOD (ISO string UTC noon)
  "endDate": null,             // optional for PERIOD; null = open-ended
  "reason": "Sick"
}
```

**Rules:**
- `LESSON_SKIP`: session must be `UPCOMING`. After deadline → 422 `FREEZE_DEADLINE_PASSED`.
- `PERIOD`: no overlap with existing ACTIVE PERIOD → 409 `FREEZE_PERIOD_OVERLAP`.
- Deadline = `freezeDeadlineHours ?? freezeWindowHours ?? 24` hours before lesson start.

**Response 201:**
```json
{ "success": true, "data": { "id": 1, "type": "LESSON_SKIP", "status": "ACTIVE", ... } }
```

**Errors:**
- 422 `FREEZE_SESSION_NOT_UPCOMING` — session is not UPCOMING
- 422 `FREEZE_DEADLINE_PASSED` — creation deadline passed
- 409 `FREEZE_PERIOD_OVERLAP` — overlapping ACTIVE PERIOD exists
- 409 `FREEZE_LESSON_SKIP_EXISTS` — duplicate LESSON_SKIP for same session
- 404 `SESSION_NOT_FOUND` / `STUDENT_NOT_FOUND`

---

### DELETE /api/v1/freeze/:id — Cancel a freeze

**Requires:** Authenticated. Creator / ADMIN / OWNER / SUPERADMIN. TEACHER → 403.

**Body:** `{ "reason": "optional" }`

**Rules:**
- After cancel deadline → 422 `FREEZE_CANCEL_DEADLINE_PASSED`
- Already cancelled → 409 `FREEZE_ALREADY_CANCELLED`
- Syncs `StudentProfile.isFrozen=false` if no other ACTIVE freezes remain.

**Response 200:**
```json
{ "success": true, "data": { "id": 1, "status": "CANCELLED", "cancelledAt": "..." } }
```

---

### GET /api/v1/freeze?studentProfileId=42 — List freezes

**Requires:** `students:read`

**Query:** `studentProfileId` (required), `status` (optional: `ACTIVE` | `CANCELLED`)

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1, "type": "PERIOD", "status": "ACTIVE",
      "startDate": "2026-06-15T12:00:00.000Z", "endDate": null,
      "reason": "Vacation",
      "createdBy": { "id": 99, "firstName": "Admin", "lastName": "User" },
      "cancelledBy": null,
      "lessonSession": null
    }
  ]
}
```

---

## 9. Attendance (2026-06-09 — Attendance Core Stabilization)

### `GET /api/schedule/session/for-date` — Load attendance for a session

**Query:** `lessonBlockId`, `date` (ISO string)

**Response (updated 2026-06-09 — added submittedBy/submittedById):**
```json
{
  "success": true,
  "data": {
    "session": { "id": 301, "status": "COMPLETED" },
    "attendances": [
      {
        "studentProfileId": 44,
        "status": "PRESENT",
        "creditDeducted": true,
        "submittedById": 5,
        "createdAt": "2026-06-09T08:30:00.000Z",
        "submittedBy": {
          "firstName": "Айгерим",
          "lastName": "Сейткали"
        }
      }
    ]
  }
}
```

> `submittedBy` — user who submitted. The first `attendance` with `submittedBy != null` is used to display "Сдал: Name · DD.MM HH:MM" in `GroupRow`.

---

### `POST /api/schedule/session/submit-attendance` — Submit batch attendance

**Roles:** `attendance:write` (ADMIN, OWNER)  
**Idempotency:** Accepts optional `Idempotency-Key` header (UUID). Same key within 24h replays cached response (Redis → in-memory fallback).  
**Perf (2026-07-04):** per-session-invariant reads (session guard, finance config, existing attendances, session-students, freezes, profile FOR UPDATE locks) are batched once per request, not per student; duplicate `studentProfileId` entries collapse to the last occurrence. Financial writes, the `creditDeducted` atomic claim and audit rows are unchanged and per-student.

**Request:**
```json
{
  "lessonBlockId": 42,
  "date": "2026-06-09",
  "attendances": [
    { "studentProfileId": 44, "status": "PRESENT" },
    { "studentProfileId": 45, "status": "ABSENT" },
    { "studentProfileId": 46, "status": "LATE" }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": 301,
    "saved": 3,
    "errors": [],
    "balances": [
      { "studentProfileId": 44, "credits": 9 },
      { "studentProfileId": 45, "credits": -1 }
    ]
  }
}
```

> `balances` — post-deduction credit count per submitted student (may be negative). Client applies these to `SchedStudent.cr` so the row reflects the new balance without a schedule reload.

**Partial error response (still HTTP 200, `saved < total`):**
```json
{
  "success": true,
  "data": {
    "sessionId": 301,
    "saved": 2,
    "errors": [
      { "studentProfileId": 46, "error": "STUDENT_FROZEN" }
    ]
  }
}
```

> Client must display `errors` inline per student — do not suppress to toast only.  
> Client generates `Idempotency-Key: crypto.randomUUID()` per submit attempt.

---

### `PATCH /api/schedule/session/:id/attendance` — Correct individual student attendance

**Roles:** `attendance:write` (ADMIN, OWNER)  
**Idempotency:** Accepts optional `Idempotency-Key` header.

**Request:**
```json
{
  "studentProfileId": 44,
  "status": "ABSENT"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 789,
    "studentProfileId": 44,
    "status": "ABSENT",
    "creditDeducted": true,
    "credits": 8
  }
}
```

> `credits` — student's balance after the correction, so `GroupRow` updates `SchedStudent.cr` live.  
> Correction is available for already-COMPLETED sessions.  
> `creditDeducted` is write-once — correcting status does not refund/re-deduct credits. Credit correction requires explicit ledger flow.

---

### `GET /api/schedule/attendance-dashboard` — Attendance control panel

**Roles:** `analytics:read` (SUPERADMIN, OWNER, ADMIN) — hardened 2026-07-04, was `attendance:write`  
**Query:** `days` (1–30, default 14)

**Response:**
```json
{
  "success": true,
  "data": {
    "pending": [
      {
        "sessionId": 302,
        "date": "2026-06-08T12:00:00.000Z",
        "lessonBlockId": 43,
        "groupName": "Intermediate A",
        "level": "B1",
        "lessonType": "GRAMMAR",
        "studentCount": 10,
        "daysSince": 1
      }
    ],
    "submitted": [
      {
        "sessionId": 301,
        "date": "2026-06-07T12:00:00.000Z",
        "groupName": "Beginner B",
        "level": "A2",
        "lessonType": "SPEAKING_CLUB",
        "attendanceCount": 8,
        "submittedByName": "Айгерим Сейткали",
        "submittedAt": "2026-06-07T10:15:00.000Z"
      }
    ]
  }
}
```

> `pending` — past sessions (within `days` window) where `status IN (UPCOMING, IN_PROGRESS)`.  
> `submitted` — recently completed sessions with first submitter name+time.  
> Used exclusively by `pages/dashboard/admin/Attendance.tsx`.  
> `daysSince ≥ 3` → shown with danger styling in UI.

---

## GET / PATCH `/api/v1/settings/finance` — `billingMode` (2026-06-19)

`GET /settings/finance` now returns `billingMode` in the config object:

```jsonc
{ "success": true, "data": {
  "basePrice": 5000, "billingDays": 26,
  "billingMode": "PER_LESSON",            // "PER_LESSON" | "CALENDAR_MONTH"
  "pricePerLesson": 193, "currency": "KGS", /* …rest unchanged… */ } }
```

`PATCH /settings/finance` accepts an optional `billingMode` (validated against the enum; invalid →
`400 { error: "Invalid billingMode" }`). When `billingMode` **changes**, the server re-derives
`paidUntil` for **all** students in the school (the projection formula differs per mode) before
responding. Requires `settings:write`.

`pricePerLesson` is re-derived (`ceil(basePrice / billingDays)`) whenever **either** `basePrice` or
`billingDays` is sent — the missing input is read from the stored config, so the stored price can
never go stale relative to its inputs (2026-07-02).

**Payments now re-derive `paidUntil`.** `POST /payments` (via credit issuance), `POST /credits/add`,
`PATCH /students/:id` (quick payment / gift lesson), and payment void/refund routes recompute the
student's derived, display-only `paidUntil` inside the existing transaction. `paidUntil` is no longer
authoritative for status — overdue is `credits <= 0`.

`PATCH /students/:id` now returns the **fresh** `StudentProfile` (post-increment `credits` +
recomputed `paidUntil`) in `data`, so the client can update the status badge in place without a
reload. (Previously it returned the pre-increment profile.)


## Calendar notes — shared admin day notes (2026-06-27)

School-scoped day notes for the schedule month/week calendar. One note per `(school, date)`,
shared across all admins/owners (replaces the old per-browser localStorage `bios_day_notes`).

`GET /api/v1/calendar-notes` → `{ success, data: [{ date: "YYYY-MM-DD", content }] }` — all notes for
the caller's school. **OWNER/ADMIN only** (403 otherwise) — these are admin-internal shared notes.

`PUT /api/v1/calendar-notes/:date` — body `{ content }`. **OWNER/ADMIN only** (403 otherwise).
Upserts the note; empty/blank `content` deletes it (`{ success, deleted: true }`). `:date` must be
`YYYY-MM-DD` (else 400); `content` max 2000 chars (else 400). Scoped by `schoolId` from the JWT.

## Personal calendar notes — student's own day notes (2026-06-28)

Per-user day notes for the student calendar (each user sees/edits only their own; separate from the
school-shared admin notes above). Same `calendarNotes` router, `/me` sub-paths.

`GET /api/v1/calendar-notes/me` → `{ success, data: [{ date: "YYYY-MM-DD", content }] }` — caller's own notes.
`PUT /api/v1/calendar-notes/me/:date` — body `{ content }`. Upserts the caller's note; empty/blank deletes
it. Any authenticated user (manages only their own `userId`). `:date` must be `YYYY-MM-DD`; max 2000 chars.

## Salary payouts — void & comments (2026-07-11)

Salary payouts (`TeacherPayment`) follow the same lifecycle as income `Payment`: **voided, never
deleted**. A voided payout stays in every list as a visible trail (`status: "VOIDED"` + who/when/why)
and is excluded from all money math (paid totals, remaining amount, applied adjustments,
`PERIOD_ALREADY_PAID` guards, consistency check10).

`DELETE /api/v1/salary/pay/:paymentId` — **voids** the payout (`salary:pay`, OWNER only). Body
`{ reason }` (required, else 400). Sets `status=VOIDED`, `voidedAt`, `voidedById`, `voidReason` and
removes the payout's `TeacherPaymentLesson` links so the sessions become payable again. 409 if the
payout is already voided. Audit action: `SALARY_PAYMENT_VOIDED`.

`PATCH /api/v1/salary/pay/:paymentId/note` — body `{ note }` (`salary:write`). Display-only comment:
trim, cap 500 chars, empty/null clears it; allowed on voided payouts. → `{ success, data: { id, note } }`.

`GET /api/v1/salary` and `GET /api/v1/salary/history/:staffProfileId` now include per payout:
`status` (`"CONFIRMED" | "VOIDED"`), `note`, `voidReason`, `voidedAt`. Raw-row endpoints
(`/salary/:id/history`, `/salary/user/:id/full-history`) return the new columns automatically.

## Import/Export — multi-format student import (2026-08-15)

The client-side XLSX/CSV parser (`ImportExport.tsx`) is alias-based and format-tolerant by
design — it scores candidate header rows against alias groups per field rather than expecting
one fixed column layout, so it isn't limited to a single school's spreadsheet shape:

- **Repeated/stacked header rows**: sheets built as several mini-tables (one class group per
  block, each with its own header row) are supported — any row whose cells match known header
  aliases is treated as a section boundary, not a student, so it's silently skipped instead of
  being parsed as garbage data.
- **`Фамилия Имя Отчество`** (single combined full-name column, surname-first) is accepted as an
  alternative to separate `Имя`/`Фамилия` columns.
- **Bare cabinet numbers** written inline as `№7` / `#7` / `No.7` (no dedicated `Кабинет` column)
  are recognized by value pattern.
- **`Препод`** is now an alias for the grammar-teacher column, alongside the existing
  `Преподаватель грамматики`.

`POST /importexport/import/preview` and `POST /importexport/import/apply` — the `students[]`
payload item gains an optional `notes?: string` field. When a sheet carries a money amount +
due date per student (`Оплата` / `Число` — a subscription-style billing model, not EduSchool's
lesson-credit balance), the client concatenates them into this field and it is written verbatim
to `StudentProfile.notes` on create/update. **It never touches `credits`, `moneyBalance`, or
`paidUntil`** — those stay derived exclusively from `recomputeAndPersistPaidUntil` per the
existing single-writer rule. This is a display-only informational passthrough, not a billing
import.

## Notifications — deletion removed, append-only (2026-08-18)

`DELETE /api/v1/notifications/:id` has been **removed**. No route allows a notification to be
deleted or archived by any user, through any path — the client's "Архивировать" menu item in
`NotificationsInbox.tsx`, which called this endpoint, was removed with it. This is a product
decision: notifications are now a permanent, append-only record for the user.

The domain command backing the old route (`deleteNotificationForUserCommand`,
`server/src/domain/notifications/notificationDomain.ts`) still exists and is still unit-tested —
it is simply no longer wired to any HTTP route.

**Not affected — do not "fix" this:** the 90-day automatic cleanup cron (`cleanupOldNotifications`
in `server/src/lib/cronJobs.ts`) still hard-deletes notification rows older than 90 days. That is a
system retention policy, not a user action, and was deliberately left in place alongside the
append-only rule above — the two are not in conflict.

## `GET /schedule/teacher-lesson-calendar-admin` — synthesized planned lessons (2026-08-18)

Response entries gained an `isSynthesized: boolean` field. `LessonSession` rows only exist up to
the rolling generation horizon (`ROLLING_DAYS = 14` in `sessionService.ts` — **deliberately not
increased** by this change, to avoid growing session-row count at 50 schools × thousands of
sessions/day). Beyond that horizon this endpoint now synthesizes entries directly from the
`LessonBlock`'s own recurrence (`days` + `startDate`/`endDate`) instead of returning nothing for
the tail of the requested month.

Synthesized entries: negative sentinel `id` (never collides with a real auto-increment session id),
`status: "UPCOMING"`, `paymentId: null`, `isSubstitution: false`, `isSynthesized: true`. Real
(persisted) entries now also carry `isSynthesized: false` explicitly, so the client never has to
treat a missing field as meaningful.

**Synthesized entries must never be treated as taught or payable.** This is a payroll screen, so
that property is enforced structurally, not just by convention:
- the client's payable-lessons filter only accepts `status === 'COMPLETED' | 'IN_PROGRESS'`, which
  synthesized rows never have;
- even if a synthesized (negative) id reached `POST /salary/:staffProfileId/pay-with-sessions`,
  that route re-fetches sessions by id/schoolId/teacher and `400`s on a count mismatch — a negative
  id is never found;
- a synthesized `(block, date)` pair is skipped whenever a real `LessonSession` row already exists
  for it (checked against every session for the block, regardless of which teacher it's attributed
  to — so a substitute's real row is never double-booked with a phantom for the regular teacher),
  whenever the date is in the past, whenever the block's status no longer allows session generation
  (`blockAllowsSessionGeneration`), or whenever its `StudentGroup` is paused/completed/archived.
