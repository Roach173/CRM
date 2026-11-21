# FRONTEND_STATE_RULES.md — Shamdan

> **Purpose:** Single source of truth rules, forbidden patterns, and required reload sequences for the React client.  
> Read this before touching `useSchedule.ts`, `WeekGrid`, or any schedule-related component.
>
> For AI workflow and development rules, see CLAUDE.md.

*Last Updated: 2026-08-19*

---

## Single Sources of Truth

### Substitutions (teacher overrides)

**ONLY source:** `weekSessions` state — populated by `loadWeekSessions()` from `GET /api/schedule/sessions/week?weekStart=YYYY-MM-DD`.

```ts
// CORRECT — read substitution from weekSessions
const sub = weekSessions[blockId]?.[dateISO];
const actualTeacher = sub?.teacherId ?? block.teacher;

// WRONG — DO NOT introduce localStorage or separate state
const override = localStorage.getItem(`sub_${blockId}_${dateISO}`);
```

**Removed (2026-05-06):** `setSubstitute()`, `clearSubstitute()`, `getOverride()` — were dead code. Deleted.

---

### Cancelled sessions

**ONLY source:** `cancelledSessions` — a `Record<string, true>` populated inside `loadWeekSessions()` by filtering sessions where `status === 'CANCELLED'`.

```ts
// CORRECT — check cancellation via cancelledSessions
isBlockCancelled(blockId, dateISO) // uses cancelledSessions internally

// WRONG — do not check localStorage or local component state
const isCancelled = localStorage.getItem(`cancel_${blockId}`) === '1';
```

**Important:** Grammar and Club blocks are checked **separately**. A Grammar block can be cancelled while the Club block for the same group on the same day remains active.

---

### Student roster for a session

**Primary source:** `SessionStudent` snapshot — `GET /api/schedule/session/:id/students`  
**Fallback:** `studentGroup.students` (from block data)

The API handles the fallback internally. Client always calls the session students endpoint.

`block.students` (legacy M2M) does **not exist** anymore. In `ServerBlock` interface it is `students?` (optional). Always iterate as `block.students ?? []`.

---

### Level and Chapter of a group

**ONLY source:** `block.studentGroup.level` / `block.studentGroup.chapter`  
`block.level` / `block.chapter` are read-only caches — only used as fallback in `loadFromServer()`.

```ts
// loadFromServer() priority (correct):
level: block.studentGroup?.level ?? block.level
chapter: block.studentGroup?.chapter ?? block.chapter
```

### Help page topics

**ONLY source:** `PlatformSettings.help` singleton row (id=1) — platform-wide, **not** school-scoped (`{ title, body?, url? }[]`), read via the dedicated `GET /api/settings/help` (returns just the topics — students/teachers do **not** receive any settings blob).  
`Help.tsx` falls back to `DEFAULT_HELP_TOPICS` when unset/empty, and renders `url` as a link **only** if it is `http(s)://` (render-time XSS guard — topics are SUPERADMIN-authored but shown to all roles on every school).  
Edited in SuperAdmin → Settings → «Помощь» section; saved via `PATCH /api/superadmin/help` (SUPERADMIN-only); server caps ≤30 topics + length limits + http(s)-only URLs (`lib/helpTopics.ts`). No longer editable from `CrmSettings` (moved off school-level 2026-07-11 — one set of topics for the whole platform, not per-school).

### Month/year filter UI (2026-07-13)

**ONLY component:** `components/ui/MonthYearPicker.tsx` (пилюля + стрелки ±1 месяц + поповер с сеткой месяцев). Формат значения — период `'YYYY-MM'`; `periodLabel()`/`currentPeriod()` экспортируются оттуда же.  
Используется в: Salary, SalaryPayslip, TeacherSalary, FinanceDashboard, Staff/Teachers (вкладка «История»), CreditStatement. Не добавлять новые `<select>` со списками месяцев и не хранить месяц label-строкой («Июль 2026») в state.

---

## Forbidden Patterns

### Product-wide interaction bans

For AI workflow and development rules, see CLAUDE.md.

### ❌ DO NOT introduce parallel localStorage state for schedule

The following localStorage keys are **legacy / empty** — do not write to them:

| Key | Status |
|-----|--------|
| `cancelled` | Legacy, not written |
| `permCanc` | Legacy, not written |
| `attSub` | Cache for "submitted attendance" — read-only signal |

**Allowed** localStorage usage:
- `lessonAtt`, `hw`, `waitlist`, `grpNotes`, `slotNotes` — pure UI notes, never used in business logic
- ~~`dayNotes`~~ — **moved to backend (2026-06-27).** Schedule day notes are now school-shared via
  `GET/PUT /calendar-notes` (`CalendarNote` table), loaded once on mount in `useSchedule` and persisted
  optimistically on `setDayNote`. No longer read from / written to `bios_day_notes` localStorage.
- `trialBannerDismissedDays`, `graceBannerDismissedDays` — subscription banner dismissal state (Layout.tsx). Stores the remaining-days value at dismissal so the banner stays hidden until the countdown changes (re-nags once per day). Pure UI state; subscription enforcement is server-side, never gated on these keys.

### ❌ DO NOT use raw `fetch()` for API calls

All API calls go through the configured Axios instance:

```ts
// CORRECT
import api from '@/lib/api';
await api.patch(`/schedule/session/${id}/teacher`, { teacherId });

// WRONG — bypasses Bearer token injection
await fetch(`/api/schedule/session/${id}/teacher`, { method: 'PATCH', ... });
```

### ❌ DO NOT read `block.students` directly

```ts
// CORRECT
const students = block.studentGroup?.students ?? block.students ?? [];

// WRONG — crashes if M2M relation is absent (it was deleted from DB)
const students = block.students.map(...);
```

### ❌ DO NOT create duplicate/mirror state for `weekSessions`

```ts
// WRONG — creates race conditions
const [localSubs, setLocalSubs] = useState<Record<string, Sub>>({});
// ...keep in sync with weekSessions manually
```

### ❌ DO NOT insert `prisma.notification.create()` directly

All notifications through `notify.ts`:
```ts
import { notify, notifyMany, notifySchoolAdmins } from '../lib/notify';
// NOT: await prisma.notification.create(...)
```

---

## Required Reload Sequences

After mutations, always refresh the relevant state:

| Mutation | Required action |
|----------|----------------|
| `PATCH /session/:id/teacher` | `onReload()` + `loadWeekSessions()` |
| `PATCH /session/:id/status` (cancel) | `onReload()` + `loadWeekSessions()` |
| `POST /schedule` (new block) | `onReload()` |
| `PUT /schedule/:id` | `onReload()` |
| `PUT /schedule/group-pair/:studentGroupId` | `onReload()` |
| `DELETE /schedule/:id` | `onReload()` |
| `POST /session/submit-attendance` | `await loadWeekSessions(wk)` → clear `attLoadedKeyRef` → `loadAttendanceForCurrentRow(true)` — NOT full `onReload()`: submit is not structural |
| `POST /session/:id/attendance/reopen` | `await loadWeekSessions(wk)` → clear `attLoadedKeyRef` → `loadAttendanceForCurrentRow(true)` |

**Grid-view memo contract (2026-07-04):** all 5 grid views (`WeekGrid`, `RoomsView`, `MonthView`, `TeacherView`, `GroupView`) are wrapped in `React.memo` with `schedViewPropsEqual` (`scheduleTypes.ts`). `sched` is compared by the specific fields each view renders; every other prop by identity. Consequences: (1) any new prop passed to these views from `Schedule.tsx` must be referentially stable (useCallback/useMemo/state), or the memo silently stops working; (2) if a view starts rendering a new `sched` field, add it to that view's key list; (3) views reading `sched.G` compare `structureTick` instead — per-student `ta`/`book` changes deliberately do not repaint grids.

**Do not** update `weekSessions` or `cancelledSessions` optimistically after mutations. Always re-fetch from server.

**Attendance after full reload (2026-07-03):** `loadFromServer` **preserves** existing `stu.ta`
(and `gta`) when merging the fresh payload into `G` — the server payload knows nothing about
attendance, so wiping it caused a visible flash to «Не отмечен». `GroupRow` remains the
authority: any handler that triggers a full reload while a row is expanded must still await the
reload, clear the guard (`attLoadedKeyRef`), and call `loadAttendanceForCurrentRow(true)`
(`preserveMarks` — no upfront reset; the response overwrites with server truth).
`handleSubmitAttendance` and `handleReopenAttendance` both follow this sequence.
`loadAttendanceForCurrentRow(false)` (upfront reset) is only for actual day/group changes.

**getGroupsInCell identity (2026-07-03, perf):** `useSchedule.getGroupsInCell` reads `G` through
a ref, so its identity does **not** change on per-student edits (attendance/book toggles) — the
grid-level `useMemo` caches in WeekGrid/RoomsView/TeacherView/GroupView keyed on it skip
recomputing the whole grid on every click (grid chips never render `ta`/`book`). Structural `G`
changes the grid does show (roster size via `removeStudent`, chapter via `updateGroup`) bump an
internal `structureTick` that refreshes the identity; full reloads invalidate via the new `SC`
ref. If you add a grid view that renders per-student fields, do NOT memoize it on
`getGroupsInCell` alone — depend on `sched.G` too. `GroupRow`'s `memo` comparator likewise
compares its own `group` (`stu`/`gta`/`cc` refs), not the whole `sched.G`.

---

## TeacherId Mapping (Client vs Server)

This is the most common AI confusion point.

| Layer | `teacherId` value | Type |
|-------|------------------|------|
| **DB / server** | `StaffProfile.id` | Internal domain ID |
| **API response** (after `mapTeacher()`) | `User.id` | What the client receives |
| **Client state** (`SchedGroup.tgId`, `tkId`) | `User.id` | Used for display and assignment |

When sending a teacher assignment from client → server:
```ts
// Client sends User.id
await api.patch(`/session/${id}/teacher`, { teacherId: selectedTeacher.id }); // User.id

// Server looks up StaffProfile
const staff = await prisma.staffProfile.findUnique({ where: { userId: teacherId } });
session.teacherId = staff.id; // StaffProfile.id stored in DB
```

---

## Data Types — Common Mismatches

| Field | Type | Notes |
|-------|------|-------|
| `LessonBlock.days` | `number[]` | 0=Mon..6=Sun. NOT a string like "Mon,Wed" |
| `LessonSession.date` | UTC noon (`12:00:00Z`) | Always set via `setUTCHours(12,0,0,0)` |
| `TimeSlot.startTime` / `endTime` | `"HH:MM"` string | e.g. `"08:00"` |
| Client `TimeSlot` | `{ id, s, e }` | Converted in `loadFromServer` from `{ startTime, endTime }` |
| `SchedGroup.grammarDays` | `number[]` | Day indexes for Grammar block |
| `SchedGroup.clubDays` | `number[]` | Day indexes for Club block |

---

## Rolling Display Horizon

`getGroupsInCell()` in `useSchedule.ts` does NOT show blocks beyond `today + ROLLING_DAYS (14)`.  
This is intentional — synced with server session generation window.

Do not increase this limit on the client without also increasing `ROLLING_DAYS` in `sessionService.ts`.

---

## Schedule Grid State Shape

```ts
// SC — Schedule Cells
type SC = Record<"dayIdx-slotId", string[]>; // cell → [groupId, ...]

// GMap — all groups by ID
type GMap = Record<string, SchedGroup>;

// weekSessions — substitutions + cancellations per block per date
type WeekSessions = Record<blockId, Record<dateISO, SessionInfo>>;

// cancelledSessions — derived from weekSessions
type CancelledSessions = Record<`${blockId}_${dateISO}`, true>;
```

These are populated in `loadFromServer()` and `loadWeekSessions()`. Do not flatten or merge these structures.

`SchedGroup.id` is the UI row id, not a reliable lesson-block id. Any session-scoped action must resolve the real block id through `grammarBlockIdOf`, `clubBlockIdOf`, or `lessonBlockIdForDay` from `components/schedule/scheduleTypes.ts`. This keeps Grammar/Club substitutions, cancellations, attendance submission, Rooms view, and split block versions aligned with the backend `LessonBlock.id`.

Editing a Grammar+Club group must be one API call: `PUT /schedule/group-pair/:studentGroupId`. Do not split the save across `/groups/:id`, `/schedule/:grammarBlockId`, `/schedule/:clubBlockId`, or `POST /schedule`; that creates transient invalid state while the backend validates temporal blocks and Grammar/Club day conflicts.

---

## React StrictMode and Async Saves

Schedule components run under React StrictMode in development. Any `mountedRef` guard must reset itself in the effect body:

```ts
useEffect(() => {
  mountedRef.current = true;
  return () => { mountedRef.current = false; };
}, []);
```

Do not use `useEffect(() => () => { mountedRef.current = false; }, [])`; after StrictMode's dev remount it leaves `mountedRef.current === false`, so async handlers skip `setSaving(false)` and the UI stays on `Сохранение...`.

---

## Role-Based UI — usePermissions Hook

All role-based UI conditions go through `usePermissions()` hook (`hooks/usePermissions.ts`).

```ts
// CORRECT
const { canManageStaff, canViewSalary } = usePermissions();
if (!canManageStaff) return null;

// WRONG — hardcoded role checks cause drift when role hierarchy changes
if (user.role === 'OWNER') return ...;
```

OWNER and ADMIN share many page components. `usePermissions()` is the single source of truth for what each role can see/do within shared components.

---

## API Response Shape Conventions

All API responses follow:
```ts
{ success: true, data: T }   // success
{ success: false, error: string } // error
```

The client checks `response.data.success` — never assume HTTP 200 = success (some errors return 200 with `success: false`). However, most errors return 4xx/5xx + `{ success: false, error }`.

Special case — `CAPACITY_WARNING`:
```ts
// Server returns 400 with special error prefix
{ success: false, error: "CAPACITY_WARNING:Кабинет рассчитан на 10 чел., а в группе уже 12 студ." }

// Client must parse this prefix to show confirmation dialog (not a toast)
if (error.startsWith('CAPACITY_WARNING:')) {
  setCapacityWarning(error.replace('CAPACITY_WARNING:', ''));
} else {
  toast.error(error);
}
```

### Paginated endpoints — формат ответа (2026-05-10)

`GET /api/students`, `GET /api/users`, `GET /api/groups` возвращают:
```ts
{ success: true, data: T[], meta: { total, page, limit, pages } }
// students также: meta.counts: { all, active, overdue, paused }
```

Клиент читает `res.data?.data ?? []` — совместимо со старым форматом (плоский массив).

---

## Real-time Updates via Socket.IO (2026-05-10)

### Подключение

`AuthContext` вызывает `connectSocket(token)` при логине и `disconnectSocket()` при logout.  
`lib/socket.ts` создаёт singleton Socket.IO клиент.

### Использование хука

```ts
import { useRealtimeSchedule } from '@/hooks/useRealtimeSchedule';

useRealtimeSchedule({
  onSessionStatusChanged: () => { reloadWeekSessions(); },
  onAttendanceUpdated: () => { reloadWeekSessions(); },
});
```

### Правила

- **Debounce обязателен** — группируй быстрые события перед перезагрузкой (500ms debounce в `Schedule.tsx`).
- **Не обновляй состояние оптимистично** через socket события — всегда перечитывай с сервера.
- **Не добавляй socket listeners напрямую** в компонентах — используй `useRealtimeSchedule` хук.
- Если сокет не подключён (socket `!connected`) — хук тихо не подписывается. Schedule работает без real-time, только manual refresh.
- **Stable callbacks обязательны** — `handleRealtimeRefresh`/`handleRealtimeStructureRefresh` должны зависеть только от стабильных ссылок (`useCallback([])`). Передавать `sched` объект целиком в deps запрещено — он пересоздаётся на каждом рендере и вызывает переподписку socket listeners. Деструктурируй `{ loadFromServer, applySchedulePolicy, loadWeekSessions }` из `sched` и используй их в deps.

### Mount Lifecycle (Schedule.tsx — правило 2026-06-09)

`Schedule.tsx` имеет два effect:
1. **Mount effect** (deps: `[]`) — загружает структуру (blocks, timeslots, cabinets, teachers), вызывает `loadFromServer`, `loadWeekSessions(weekKey(new Date()))` и устанавливает `didMountRef.current = true`.
2. **Week effect** (deps: `[viewWk]`) — загружает timeslots policy + sessions при навигации по неделям. **Пропускает первый запуск** через `if (!didMountRef.current) return` — mount effect уже обработал начальную неделю.

**Запрещено:** убирать `if (!didMountRef.current) return` guard из week effect — это восстановит гонку mount/week, при которой `applySchedulePolicy` применяет политику на пустые слоты (`DEFAULT_SLOTS`/`[]`) до того, как mount effect загрузит DB-слоты.

### События

| Event | Payload | Источник |
|-------|---------|---------|
| `session:status-changed` | `{ sessionId, lessonBlockId, status, date }` | `PATCH /session/:id/status` |
| `attendance:updated` | `{ sessionId, studentProfileId, status }` | `PATCH /session/:id/attendance` |

### ❌ Запрещено

- Не храни socket state (connected/disconnected) в React state — сокет сам управляет реконнектом.
- Не создавай второй Socket.IO клиент — только через `getSocket()` singleton из `lib/socket.ts`.
- Не listen на события вне компонентов без cleanup (`return () => s.off(event, handler)`).

---

## Finance — RefundModal (Phase 7.6)

### Поток данных

1. `FinanceDashboard` хранит `refundPaymentId: number | null`.
2. Клик по кнопке "Возврат" → `setRefundPaymentId(p.id)`.
3. `RefundModal` открывается с `isOpen={refundPaymentId !== null}`.
4. `RefundModal` сам загружает `GET /payments/:id` для получения allocations.
5. После успеха: `onSuccess()` → `fetchPayments()` в `FinanceDashboard` обновляет список.
6. Закрытие: `setRefundPaymentId(null)`.

### Двухшаговый submit (create + confirm)

```
POST /payments/:id/refunds  →  { refund.id }
POST /payments/refunds/:id/confirm  →  CONFIRMED
```

Если confirm упал → `pendingRefundId` состояние в RefundModal показывает retry-кнопку.
Не вызывать `onSuccess()` пока refund не CONFIRMED.

### Правила

- Кнопка "Возврат" показывается только для `payment.status === 'CONFIRMED'` и `canWrite` (OWNER/SUPERADMIN).
- Кнопка "Аннулировать" тоже только для `status === 'CONFIRMED'`.
- VOIDED и REFUNDED платежи отображаются с `opacity-60`, без кнопок действий.
- `Payment.refundEvents` приходит из list endpoint — используй для отображения истории возвратов.
- Никогда не делай финансовую арифметику на фронте: `refundApi.create` вернёт ошибку `REFUND_EXCEEDS_REFUNDABLE_BALANCE` если превышен лимит — покажи `financeErrorMessage()`.

---

## Freeze System (PR 5 — Backend Foundation)

### AttendanceStatus.FROZEN — новое значение

`AttendanceStatus` теперь включает `FROZEN`. Фронт должен учитывать это при отображении посещаемости.

- `FROZEN` означает: студент заморожен на этот урок, кредит **не** списан.
- Не показывать `FROZEN` как `ABSENT` — это отдельный статус.
- Иконка: 🧊 (согласно BR-08)
- `creditDeducted` всегда `false` для `FROZEN`

### StudentProfile.isFrozen / frozenAt — legacy cache only

- **Не использовать** `isFrozen`/`frozenAt` в новых компонентах.
- Единственный источник правды — модель `StudentFreeze` на бэкенде.
- `isFrozen` синхронизируется бэком как кеш; может использоваться только как quick-indicator.

### Freeze endpoints (PR 5 — Backend Foundation)

| Endpoint | Метод | Доступ |
|---|---|---|
| `POST /api/v1/freeze` | Создать заморозку | freeze:write (OWNER/ADMIN) |
| `DELETE /api/v1/freeze/:id` | Отменить заморозку | Creator/Admin/Owner |
| `GET /api/v1/freeze?studentProfileId=X` | Список заморозок студента | students:read |

UI behavior must use `StudentFreeze` as the source of truth. `StudentProfile.isFrozen/frozenAt` remains a legacy cache only.

---

## Attendance Submission State (2026-06-09 — Attendance Core Stabilization)

### "Посещаемость сдана" badge — DB-backed ONLY

**ONLY source:** `sessionStatuses[blockId_dateISO] === 'COMPLETED'` — populated from `GET /schedule/week-sessions` via `useSchedule.ts`.

```ts
// CORRECT — read submitted status from DB-backed sessionStatuses
const sessionStatus = sched.getSessionStatus(blockId, dateISO);
const isCompleted = sessionStatus === 'COMPLETED';

// WRONG — DO NOT use localStorage as the authority for "submitted"
const submitted = localStorage.getItem(`bios_att_submitted_${key}`) === '1';
```

**`attSub` localStorage** (`bios_att_submitted_*`) is demoted to a UI cache only — it may help optimistically show the badge during the same browser session, but `isCompleted` from `sessionStatuses` is authoritative on page load/reload and across devices.

### submittedBy — loaded per session from API, not from localStorage

`GroupRow` fetches `GET /schedule/session/for-date` on expand, reads the first attendance with `submittedBy != null`, and stores `{ name, at }` in `submittedInfo` state. This displays "Сдал: Name · DD.MM HH:MM" next to the badge.

```ts
// CORRECT
const withSubmitter = attendances.find(a => a.submittedBy);
setSubmittedInfo({ name: `${f} ${l}`, at: new Date(createdAt).toLocaleString(...) });

// WRONG — do not fabricate submittedBy from localStorage or current user
setSubmittedInfo({ name: currentUser.name, at: new Date().toISOString() });
```

### Individual correction (PATCH) — active only after COMPLETED

`onCorrect` prop is passed to `StudentRow` only when `dbSubmitted && currentSessionId !== null`. This prevents correction attempts on sessions that haven't been submitted.

```ts
// CORRECT — guard on dbSubmitted AND currentSessionId
const correctionActive = dbSubmitted && currentSessionId !== null;
<StudentRow onCorrect={correctionActive ? handleCorrect : undefined} />

// WRONG — always enabling correction
<StudentRow onCorrect={handleCorrect} />
```

### Partial errors — must be shown inline

When `POST /submit-attendance` returns `data.errors.length > 0`, the errors must be shown **inline** below the student list, not only in a toast. Each error references a specific `studentProfileId`.

```ts
// CORRECT — inline display
setPartialErrors(attErrors);
toast.error(`Сохранено ${saved} из ${total}, ошибок: ${attErrors.length}`);

// WRONG — suppress inline display
toast.error('Некоторые студенты не сохранены');
```

### Idempotency-Key on attendance mutations

Both `POST /submit-attendance` and `PATCH /session/:id/attendance` must send `Idempotency-Key: crypto.randomUUID()` header per request. This prevents double-submission on network retry.

```ts
// CORRECT
await api.post('/schedule/session/submit-attendance', body, {
  headers: { 'Idempotency-Key': crypto.randomUUID() },
});

// WRONG — no idempotency key
await api.post('/schedule/session/submit-attendance', body);
```

---

## Students page: status badge must update in place after a quick payment (2026-06-19)

Student status («Активен / Просрочка / На паузе») is derived from `credits` (the balance —
single source of truth), not from `paidUntil`. After a quick payment on the Студенты page, the
UI must reflect the new balance **without a page reload**.

- `PATCH /students/:id` (quick payment) returns the **fresh** `StudentProfile` (recomputed
  `credits` + derived `paidUntil`).
- `PaymentTab` calls `onPaid({ credits, paidUntil })` with that response; `StudentProfileModal`
  updates `localStudent` (modal header badge + «Оплачено до») and calls `onUpdate` so the parent
  list row badge re-renders too.
- **Forbidden:** relying on a manual refresh, or updating only the local payment history while
  leaving `credits` stale. The modal does **not** reset to the Info tab on an in-place field
  update — the tab reset keys on `student.id`, not object identity.

---

## «Выбрать группу» — experimental pick flow (Schedule ⇄ Groups) (2026-07-08)

The create-block form (`CreateGroupForm`) has an experimental «Выбрать группу» button that
jumps to the Groups page to pick a group visually, then returns to the same slot with the
form draft restored and the picked group + its block teachers applied.

- **Stash:** the form draft lives in `sessionStorage` under `GROUP_PICK_KEY`
  (`client/src/lib/groupPick.ts`): `{ mode: 'create'|'edit', ci, sid, …, form, picked? }`.
  Same-tab only. Available from both `CreateGroupForm` and `EditGroupPanel` (via
  `pickContext={ ci, wk }` passed down from `GroupRow`). In `EditGroupPanel` the pick flow
  is the only way to change the binding: the old «Привязать к существующей группе» inline
  dropdown was removed; the bound group is shown read-only at the top of the form with the
  «Выбрать группу» button next to it.
- **Groups page pick mode:** entered via `?pick=1` *and* a present stash — a stray `pick`
  param (e.g. from a stale URL) is stripped. Only ACTIVE groups are selectable.
  The confirm bar is fixed to the bottom of the viewport. «Подтвердить» writes
  `stash.picked` — group id/level **plus its blocks' teachers, days and cabinet** (pulled from the
  group's existing schedule blocks; a never-scheduled group has nothing to pull) — and
  navigates to `…/schedule?resumeGroupPick=1`; «Отмена» aborts the whole flow (clears the
  stash, stays on Groups in normal mode).
- **Schedule resume:** the `?resumeGroupPick=1` deep-link effect reopens the SlotPanel for
  the stashed cell/week — create mode, or the group's edit panel (`initialEditGroupId`) for
  `mode: 'edit'`. The form consumes the stash on mount only if `picked` is set and the
  cell (`ci`/`sid`) or group (`gid`) matches.
- No autosave is involved: the block is still saved only via the explicit «Добавить блок».

---

## Modal back-button close (Android/browser back) (2026-08-18)

**ONLY source of the back-closes-modal behavior:** the shared `<Modal>`/`<AlertModal>` wrapper in
`components/ui/Modal.tsx`, which calls `useBackButtonClose(open, () => onOpenChange?.(false))`
(`hooks/useBackButtonClose.ts`) internally. Every modal built on those two primitives gets this for
free — no per-call-site wiring needed.

- Pressing the browser/Android back button (or gesture) while a modal is open closes the top-most
  open modal instead of navigating the SPA route out from under it.
- Implemented as a single shared LIFO stack (`ModalBackStack`) + **one** `window.addEventListener('popstate', ...)`
  for the whole app — every mounted `Modal`/`AlertModal` instance coordinates through it rather than
  racing each other with individual listeners. `open()` pushes one throwaway history entry per open
  modal; a real back-press pops and closes only the top entry (so a modal opened from inside another
  modal closes first, in order).
- If a modal closes by any means **other** than back (X button, Escape, backdrop click, auto-close
  after save), the hook's cleanup consumes its now-stale history entry via `history.back()` itself —
  the user is never left needing to press back twice to actually leave the page.

**Hand-rolled overlays (2026-08-19 — gap closed).** The page-level modals that predate `<Modal>` are
still raw `fixed inset-0` overlay `<div>`s, but each now calls `useBackButtonClose` directly, right
next to its existing `useBodyScrollLock` call: `components/CTAForm.tsx`,
`components/layout/Sidebar.tsx` (mobile drawer + «Ещё» bottom sheet), `components/ui/RefundModal.tsx`,
`components/schedule/{SlotPanel,DayAnnotationPopup,ConflictWarningModal,StudentProfileModalLoader}.tsx`,
`components/schedule/EditGroupPanel.tsx` (split dialog),
`pages/dashboard/admin/{CrmSettings,FinanceDashboard,GroupDetail,SalaryPayslip,Students,Teachers}.tsx`,
`pages/dashboard/owner/Staff.tsx`, `pages/dashboard/student/Schedule.tsx`,
`pages/dashboard/superadmin/Schools.tsx`. They were not migrated onto `<Modal>` — one hook line per
overlay is the whole fix. **Rule: an overlay that needs `useBodyScrollLock` needs
`useBackButtonClose` too.** Dropdowns/popovers (`GroupActionsMenu`, the sidebar profile menu, the
group colour picker) are deliberately excluded — they close on outside-click and should not eat a
back press.

```ts
// CORRECT — build new modals on the shared primitives, back-close is automatic
import { Modal, ModalContent } from '@/components/ui/Modal';

// WRONG — a new hand-rolled `fixed inset-0` div opts out of back-button-close
// and adds to the known-gap list above
```

---

## Modal scroll containment (2026-08-19)

Two rules for every overlay, so the page behind a popup never scrolls in its place:

1. **Background lock** — `useBodyScrollLock(active)` (`hooks/useBodyScrollLock.ts`). Ref-counted
   module-level counter, so a confirm dialog opened on top of a profile modal doesn't unlock the
   page when it closes. Call it before any early `if (!isOpen) return null`.
2. **The panel scrolls, not the page** — the modal panel carries `max-h-[90dvh] overflow-y-auto`
   (or `max-h-… flex flex-col` with an `overflow-y-auto` body region, as in the profile/teacher
   modals). Without a height cap a tall form overflows the viewport with no way to reach its
   bottom.

Modals built on `<Modal>`/`<AlertModal>` (`components/ui/Modal.tsx`) get both for free — Radix
locks the body itself (`react-remove-scroll`) and `ModalContent`/`AlertModalContent` cap at
`max-h-[90dvh] overflow-y-auto`. **Do not pass `overflow-hidden` in a `ModalContent` className** —
`cn()` is `twMerge`, so it strips the base `overflow-y-auto` and the modal stops scrolling. Cap the
height and give the body region its own `overflow-y-auto` instead (see `GroupEditorModal`).

Coverage as of this change — everything with a backdrop locks the page: the hand-rolled overlays
listed in the known-gap section above, `SlotPanel`, `StudentProfileModalLoader`,
`ConflictWarningModal`, `DayAnnotationPopup`, `CTAForm`, the `Sidebar` mobile drawer + «Ещё» bottom
sheet, and the superadmin `Schools` detail drawer. Anchored dropdowns/context menus
(`GroupActionsMenu` desktop, `DayActionsMenu`, profile dropdown, colour picker) deliberately do not
lock — they are menus, not modals; the mobile variant of `GroupActionsMenu` is a bottom sheet and
caps at `80dvh`.

---

## StudentProfileModal — archive contract: `onArchived`, not `onArchive` (2026-08-18)

`StudentProfileModal` (`pages/dashboard/admin/Students.tsx`) now owns the entire archive action
itself — the `PATCH /students/:id/archive` call, success/error toasts, and the confirm button's
in-flight/disabled state all run unconditionally when the user confirms in `ConfirmArchiveModal`.

The prop is `onArchived?: (student) => void` — fired **once, after** the archive has already
succeeded server-side, purely so the caller can refresh its own view (list refetch, roster sync).
It replaces the old `onArchive: (student) => void`, which the caller was expected to implement
*performing* the archive; two of the three call sites (`StudentProfileModalLoader.tsx`,
`GroupDetail.tsx`) never actually called the API and just closed the modal, so archiving silently
did nothing from the schedule popup or the group roster.

```ts
// CORRECT — caller only reacts to a completed archive
<StudentProfileModal onArchived={() => fetchGroup()} ... />

// WRONG — do not re-add an onArchive callback that is expected to perform the
// archive itself; the modal always does it now, and a stub here can no longer
// suppress that, but a resurrected onArchive prop invites exactly that mistake
// at the next new call site
```

---

## Mobile schedule header — one component: `MobileDayBar` (2026-08-19)

Every day-based schedule view (`WeekGrid`, `RoomsView`, `TeacherView`, `GroupView`) renders the
**same** mobile header: `components/schedule/MobileDayBar.tsx` — scrollable day tabs with the
sliding pill, gear / operational-control icons on the right, and the view's entity picker
(cabinet / teacher / group) **below** the day tabs via the `selector` prop.

Rules:
- Do not re-add a per-view mobile top bar, day-tab strip, or `‹ Среда 19 авг ›` prev/next header.
  The day tabs are the only day navigation on mobile.
- `MobileDayBar` speaks weekday indexes (`0 = Пн`). `useMobileDayNav` stores date-keys, so those
  three views convert in a one-line `selectDay(ci)` adapter.
- On mobile the admin `Schedule.tsx` toolbar is hidden for these four views (the day bar carries
  gear / control; week navigation lives in the gear panel). `month` and `teacher-availability`
  have no day bar and keep the toolbar.
- Collapse-on-scroll (`collapsed`) is driven only by `WeekGrid`, which owns a scroll container
  (`useScrollDirection` + `MobileChromeContext`). The other views scroll the page and pass nothing.
