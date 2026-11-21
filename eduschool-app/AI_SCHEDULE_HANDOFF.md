# AI Instruction: Scheduling System Logic (Shamdan)

For AI workflow and development rules, see CLAUDE.md.

## 2026-07-04 Update: Group-Pair Write Ownership Guard

- Once a `LessonBlock` has an active `studentGroupId` (`deletedAt: null`, `endDate: null`), it can **only** be mutated through the group-pair endpoints (`POST/PUT/DELETE /schedule/group-pair/...`). The single-block endpoints (`PUT/DELETE /schedule/:id`, `POST /schedule`) now reject that case — they no longer silently desync a Grammar/Club pair.
- `PUT /schedule/:id` and `DELETE /schedule/:id` return `409 { code: 'GROUP_PAIR_OWNED' }` when the target block is an active grouped block. `POST /schedule` returns `409 { code: 'GROUP_ALREADY_IN_SCHEDULE' }` when `studentGroupId` already has an active block (mirrors the existing `POST /group-pair` guard).
- Closed/historical blocks (`endDate` set) and blocks without a `studentGroupId` (standalone/legacy) are unaffected — the single-block endpoints remain their only path.
- Shared helper: `isActiveGroupOwnedBlock()` in `routes/schedule/scheduleRouteUtils.ts` (the old monolithic `routes/schedule.ts` was split into `routes/schedule/*.routes.ts` — see the 2026-07-05 cleanup entry below).
- Known bug this closes: before this guard, a stray `PUT`/`DELETE /schedule/:id` call against a grouped block (e.g. a manual API call, a script, or a future frontend regression) could edit or archive just the Grammar or just the Club side of a pair, leaving the other orphaned. `EditGroupPanel` and `SlotPanel` already only call the group-pair endpoints — this is a backend-enforced belt-and-suspenders, not a frontend behavior change.
- ~~Follow-up (separate PR, not yet done): `checkStudentScheduleConflicts`... and `GET /schedule/available`'s exclusion filter still read the legacy relation instead of `GroupMembership`~~ — **superseded, see 2026-07-05 cleanup entry below**: both `scheduleValidation.ts`'s conflict-check functions and the availability exclusion filter were already `GroupMembership`-based by the time of that audit. The actual remaining bugs were narrower and different (capacity counts, not conflict detection) and were fixed then.

## 2026-07-04 Update: Atomic Grammar/Club Pair Delete

- `DELETE /api/v1/schedule/group-pair/:studentGroupId` is the canonical endpoint for removing a Grammar + Speaking Club group pair from the schedule.
- `SlotPanel.handleRemoveGroup` must call that endpoint once (when `group.studentGroupId` is set). Do not restore the old loop of `api.delete('/schedule/{id}')` per block — a failure on the second call left the pair half-deleted.
- The route finds the group's active blocks itself (`schoolId, studentGroupId, deletedAt: null, endDate: null` — same "active block" definition as the `POST /group-pair` guard) and archives them all inside one transaction via `archiveLessonBlockInTx`. Self-healing: a group already stuck half-deleted (from the old bug) gets fully archived on the next call.
- `archiveLessonBlockInTx(tx, params)` in `blockArchiveService.ts` is the transaction-scoped primitive — use it (not `archiveLessonBlock`) whenever multiple blocks must be archived atomically in one caller-owned transaction.

## 2026-05-23 Update: Atomic Grammar/Club Pair Save

- `PUT /api/v1/schedule/group-pair/:studentGroupId` is the canonical endpoint for editing an existing Grammar + Speaking Club group pair.
- `EditGroupPanel` must call that endpoint once. Do not restore the old split flow of `PUT /groups/:id`, `PUT /schedule/:grammarBlockId`, `PUT /schedule/:clubBlockId`, and optional `POST /schedule`.
- `validateScheduleBlock()` accepts `excludeBlockIds`, so pair validation can ignore both current pair blocks while validating the final state.
- Attendance submit in `GroupRow` resolves the real block id via `lessonBlockIdForDay(group, ci)` and has a 30s timeout.
- React StrictMode dev remounts require `mountedRef.current = true` inside the effect body. The old compact cleanup-only pattern leaves schedule save buttons stuck on `Сохранение...`.

This document is the **single source of truth** for another AI agent working on `routes/schedule/*.routes.ts`, `scheduleValidation.ts`, `useSchedule.ts`, or any related scheduling code. Read it fully before touching scheduling logic.

### Related documents (read these too)

| Doc | What it covers |
|-----|----------------|
| `ARCHITECTURAL_DECISIONS.md` | WHY decisions were made (StaffProfile.id, rolling window, hard delete, snapshots, etc.) |
| `DATABASE_CONSTRAINTS.md` | Unique constraints, cascade rules, idempotency invariants, transaction requirements |
| `FRONTEND_STATE_RULES.md` | Single source of truth rules, forbidden patterns, required reload sequences |
| `ARCHITECTURE.md` | High-level system architecture, roles, auth flow, multi-tenancy |
| `DEPLOYMENT.md` | Production deployment guide, Nginx, PM2, cron jobs |
| `TESTING_STRATEGY.md` | Manual regression checklist and testing priorities |

---

## 1. Core Data Model

### Полная карта таблиц

```
StudentGroup  (когорта — единица записи студента)
  ├── GroupMembership[]  (M2M: кто в группе, с датами входа/выхода и статусом)
  │     └── StudentProfile
  └── LessonBlock[]  (шаблон урока: Grammar или Club, кабинет, слот, дни)
        └── LessonSession[]  (конкретный урок — конкретная дата)
              ├── SessionStudent[]  (снапшот состава на момент создания сессии)
              │     └── Attendance  (PRESENT/ABSENT/LATE/FROZEN + creditDeducted flag)
              │           └── LessonCreditLog  (финансовый аудит кредитного списания)
              └── ScheduleActionLog[]  (аудит: кто/что/когда изменил)

ScheduleException  (исключения из расписания: праздники, замены, отмены по диапазону)

StudentPayment  (оплата кредитов студентом: сумма, метод, кто принял)
ManualLessonEntry  (ручная корректировка кол-ва уроков учителя для зарплаты)

LessonSessionArchive  (архив старых сессий после очистки)
AttendanceArchive  (архив старых записей посещаемости)

Webhook  (подписки на события для интеграций)
```

### Что где хранится — быстрая справка

| Вопрос | Ответ — таблица |
|--------|-----------------|
| Кто сейчас в группе? | `GroupMembership` (status=ACTIVE) |
| Кто был в группе на урок X? | `SessionStudent` (снапшот) |
| Пришёл ли студент на урок? | `Attendance` |
| Были ли списаны кредиты? | `Attendance.creditDeducted` + `LessonCreditLog` |
| Студент заплатил деньги? | `StudentPayment` |
| Учителю добавить/убрать уроки вручную? | `ManualLessonEntry` |
| Кто перенёс/отменил урок? | `ScheduleActionLog` |
| Праздник или выходной день? | `ScheduleException` |

### StudentGroup (когортная модель)
- Студент записывается **в группу** (`StudentGroup`), а не в отдельный блок.
- Одна группа может иметь несколько `LessonBlock`: Grammar-блок и Speaking Club-блок.
- `StudentGroup` является **источником правды** для `level` и `chapter`. Блоки дублируют эти поля только для совместимости при поиске.
- `StudentGroup.students` ↔ `StudentProfile[]` — M2M **через `GroupMembership`**.

### GroupMembership (запись студента в группу)
- Через-таблица для M2M `StudentGroup` ↔ `StudentProfile`.
- `@@unique([studentProfileId, studentGroupId])` — студент не может быть в одной группе дважды.
- `status: MemberStatus` — enum `ACTIVE | PAUSED | WITHDRAWN` — история членства сохраняется, не удаляется.
- `joinedAt` / `leftAt` — даты входа и выхода из группы.
- При добавлении студента → `GroupMembership.create`. При удалении → `leftAt = now(), status = WITHDRAWN` (soft).
- **Не путать с `EnrollmentRequest`** — это заявка на запись (ожидает одобрения). `GroupMembership` — уже одобренная запись.

### LessonBlock (шаблон урока)
- `studentGroupId` — FK на StudentGroup.
- `timeSlotId` — FK на `TimeSlot` (обязателен для новых блоков).
- `startTime` / `endTime` — **денормализованный кэш** из `TimeSlot`. Всегда соответствуют связанному слоту.
- `days: Int[]` — массив индексов дней (0=Пн, 1=Вт, 2=Ср, 3=Чт, 4=Пт, 5=Сб, 6=Вс). **НЕ строка.**
- `type: GRAMMAR | SPEAKING_CLUB` — Grammar-блок учителя обязателен; у Club учитель опционален.
- Legacy M2M `block.students` **удалён** (`_StudentEnrollments` таблица удалена миграцией). Студенты берутся исключительно через `studentGroup.students` + `GroupMembership`.
- Удаление — **жёсткое** (`prisma.lessonBlock.delete`), не мягкое. `deletedAt` в схеме есть, но delete-роут использует физическое удаление.

### LessonSession (конкретный урок)
- `date` — всегда хранится с `setUTCHours(12, 0, 0, 0)` (полдень UTC).
- `teacherId` — `StaffProfile.id` (не `User.id`!). При замене учителя заполняется здесь, не в блоке.
- `status: UPCOMING | IN_PROGRESS | COMPLETED | CANCELLED | LOCKED` — CANCELLED не воссоздаётся при синхронизации. LOCKED — терминальный (из него нет переходов). Переходы строго контролируются через `sessionStateMachine.ts` — см. раздел 13.
- `@@unique([lessonBlockId, date])` — гарантирует ровно одну сессию на (блок, дата). Добавлен миграцией 2026-05-06.
- Снапшоты учителя/кабинета/времени: `teacherIdSnap`, `cabinetIdSnap`, `startTimeSnap`, `endTimeSnap` — записываются при создании сессии.
- Soft delete через `deletedAt`.
- **Makeup поля** (добавлены 2026-05-10):
  - `isMakeup: Boolean @default(false)` — пометка make-up урока.
  - `makeupForSessionId: Int?` — FK на оригинальный CANCELLED урок.
  - Самореферентная связь `makeupForSession`/`makeupSessions` (`"MakeupSessions"`).
  - Make-up сессии **не списывают кредиты** — кредит возвращён при отмене оригинала.

### SessionStudent (снапшот состава)
- `SessionStudent` — join-таблица между `LessonSession` и `StudentProfile`.
- Создаётся через `snapshotNewSessions()` в `sessionService.ts` при генерации новых сессий.
- Фиксирует, какие студенты были в группе **на момент создания сессии**.
- `GET /api/schedule/session/:id/students` — возвращает список из `SessionStudent` (primary), fallback — `studentGroup.students` если снапшот пуст.
- `schoolId` обязателен при создании `SessionStudent` (нужен для multi-tenant фильтрации).
- `createMany({ skipDuplicates: true })` — обязателен, как и для `LessonSession`.

### TimeSlot (временной слот)
- Хранится в БД (`TimeSlot` таблица), не в JSON-настройках.
- `schoolId` — каждая школа имеет свои слоты.
- `startTime / endTime` — строки `"HH:MM"`.
- `order` — порядок отображения в сетке.
- Regeneration: при изменении `workStart`/`workEnd`/`slotDuration` в настройках школы → `syncTimeSlots()` пересоздаёт слоты (upsert + удаление неиспользуемых).

### ScheduleException (исключения из расписания)
- Позволяет отметить праздник, замену или отмену для диапазона дат без изменения блоков.
- `type: ExceptionType` — вид исключения: `TEACHER_UNAVAILABLE | CABINET_UNAVAILABLE | GROUP_RESCHEDULED | EXAM_PERIOD | HOLIDAY_CUSTOM`.
- `scope: ExceptionScope` — масштаб: `SCHOOL | TEACHER | CABINET | GROUP`.
- `recurring: Boolean` — повторяется ли ежегодно (например, государственный праздник).
- `days: Int[]` — дни недели, к которым применяется исключение.
- `startDate / endDate` — диапазон дат.
- `teacherId / cabinetId / groupId` — опциональные FK для точечных исключений.
- Генератор сессий (`getSessionDates`) **должен проверять `ScheduleException`** при создании дат.

### StudentPayment (оплата студента)
- Фиксирует реальный денежный платёж студента администратору.
- `creditsAdded: Int` — сколько кредитов добавлено этим платежом.
- `amount: Decimal` — денежная сумма (в валюте школы).
- `pricePerCredit: Decimal` — цена одного кредита на момент оплаты (снапшот).
- `method: PaymentMethod` — CASH, CARD, TRANSFER, ...
- `createdById` — кто принял оплату (FK на User).
- **Не путать с `LessonCreditLog`** — там списание за урок, здесь пополнение за деньги.

### ManualLessonEntry (ручная корректировка уроков учителя)
- Позволяет добавить или убрать уроки из зарплатного расчёта вручную.
- `type: ADD | REMOVE` — добавление или вычет.
- `count: Int` — количество уроков (всегда положительное, знак из type).
- `month: String` — к какому месяцу относится ("2026-05").
- `label: String` — причина ("Замена 3 мая", "Прогул без уважительной причины").
- Учитывается в `GET /salary` при расчёте `effectiveLessons = lessonsCount + manualDelta`.

### ScheduleActionLog (аудит действий)
- Записывает каждое изменение сессии или блока: кто, что, когда, с каким результатом.
- `before / after: Json` — снапшот состояния до и после изменения.
- `action: String` — название действия (TEACHER_CHANGED, STATUS_UPDATED, ATTENDANCE_MARKED, ...).
- `ipAddress` — IP адрес инициатора.
- Используется для разбора конфликтов и аудита (кто отменил урок, кто поменял учителя).

### LessonSessionArchive / AttendanceArchive (архив)
- Холодное хранилище для старых записей после очистки основных таблиц.
- `id` — сохраняет оригинальный ID (не autoincrement).
- `archivedAt: DateTime` — когда была архивирована.
- Используются cron-очисткой для переноса сессий/посещаемости старше N дней.
- **Не запрашивать в обычных API эндпоинтах** — только для отчётности/восстановления.

### Webhook (подписки на события)
- Позволяет внешним системам подписаться на события Shamdan.
- `events: String[]` — список событий (["session.completed", "attendance.marked", ...]).
- `secret: String` — для HMAC-подписи payload.
- `isActive: Boolean` — можно отключить не удаляя.
- Пока не реализован в routes — подготовлена только схема.

### TeacherID — важная деталь
`LessonBlock.teacherId` и `LessonSession.teacherId` хранят `StaffProfile.id`, **не** `User.id`.  
`mapTeacher()` конвертирует это в `{ id: user.id, firstName, lastName }` для клиента.  
При назначении учителя: `staffProfile = await prisma.staffProfile.findUnique({ where: { userId: teacherUserId } })` → `staffProfile.id`.

---

## 2. Rolling Window — генерация сессий

**Горизонт: 14 дней** (`ROLLING_DAYS = 14`).

Все функции вынесены в **`services/sessionService.ts`** (не в `schedule.ts`). `schedule.ts` импортирует и реэкспортирует `extendAllBlockSessions` для обратной совместимости. `index.ts` импортирует напрямую из `sessionService`.

### snapshotNewSessions(client, blockId, schoolId, studentGroupId, dates)
- Первый параметр — `client: DbClient` (`typeof prisma | Prisma.TransactionClient`).
- Создаёт `SessionStudent` записи для переданных дат.
- **Обязательно вызывать внутри той же транзакции, что и `createMany` сессий.**

### syncSessionsForBlock(block)
Diff-подход:
1. Вычисляет желаемые даты `[today, today+14]` через `getSessionDates()`.
2. Удаляет UPCOMING-сессии в окне, которых нет в желаемом наборе.
3. Создаёт только даты, для которых **нет вообще никакой сессии** (даже CANCELLED не воссоздаётся).
4. `createMany` сессий + `snapshotNewSessions` выполняются **в одной `prisma.$transaction()`** — атомарно. Если снапшот упадёт — сессии тоже откатятся (2026-05-10).

**Вызывается при:** POST (создание блока), PUT (обновление блока).

### extendAllBlockSessions()
- Экспортируется из `services/sessionService.ts`.
- Вызывается cron-ом (ежедневно) из `server/src/index.ts`.
- Досоздаёт сессии для всех активных блоков до горизонта.
- Каждый блок обрабатывается в `try/catch` — ошибка одного блока не прерывает обработку остальных (2026-05-10).

### cleanupInvalidSessions(block)
- Вызывается после PUT (обновление блока).
- Удаляет UPCOMING-сессии, которые больше не соответствуют параметрам блока (день убран, дата вышла за endDate, дата раньше нового startDate).
- Не трогает CANCELLED и COMPLETED.
- Если школа не найдена — **бросает `Error('School not found')`**, не делает silent fallback на `'Asia/Bishkek'` (2026-05-10).

### getSessionDates(days, startDate, endDate, holidays, from, to)
- `holidays` берётся из `School.settings.holidays` (массив `YYYY-MM-DD`).
- Дни недели: `(utcDate.getUTCDay() + 6) % 7` → 0=Пн, ..., 6=Вс.

### skipDuplicates — обязательно
`lessonSession.createMany()` должен использовать `{ skipDuplicates: true }`. Без него крашится при soft-deleted сессиях: `deletedAt` не null, но уникальный constraint `(lessonBlockId, date)` всё равно держится → P2002 при рестарте сервера.

---

## 3. Валидация блока (scheduleValidation.ts)

`validateScheduleBlock(prisma, data)` бросает `ScheduleValidationError` при нарушении.

### Порядок проверок:
1. **Рабочие дни** — `data.days` должны быть в `School.activeDays`. Ошибка: «Дни [Сб, Вс] не являются рабочими».
2. **Обязательность кабинета** — `cabinetId` всегда обязателен. Ошибка: «Кабинет не указан».
3. **Обязательность учителя** — обязателен для GRAMMAR-блока. SPEAKING_CLUB может быть без учителя.
4. **Вместимость кабинета** — если студентов в группе больше capacity → предупреждение `CAPACITY_WARNING:...`. OWNER может обойти через `overrideCabinetConflict: true`.
5. **Коллизия кабинета** — другой блок в том же кабинете в пересекающееся время. Исключение: Grammar + Club **одной группы** (`studentGroupId` совпадает) — не конфликт. OWNER+ADMIN может обойти через `overrideCabinetConflict: true`.
6. **Коллизия учителя** — учитель не может вести два блока одновременно. Исключение: один учитель ведёт Grammar + Club **одной группы** — не конфликт. **Нельзя обойти никакими флагами.**
7. **Нагрузка учителя** — если блок ставится в нерабочий день учителя (`StaffProfile.workingDays`) или превышает `StaffProfile.maxLessonsPerDay` → предупреждение `TEACHER_CONFLICT_WARNING:...`. Обходится флагом `overrideTeacherConflict: true` (OWNER/ADMIN).
8. **Конфликт студента** — при добавлении студента в группу (`PATCH /:id/add/:profileId`) вызывается `checkStudentScheduleConflicts()`. Если у студента уже есть блок в то же время → предупреждение `STUDENT_CONFLICT_WARNING:...`. Обходится флагом `overrideStudentConflict: true` (OWNER/ADMIN).

### Форматы предупреждений-префиксов
Клиент парсит эти префиксы для показа диалога подтверждения (не обычного toast):
- `CAPACITY_WARNING:Кабинет рассчитан на X чел., а в группе уже Y студ.`
- `TEACHER_CONFLICT_WARNING:<детали коллизии>`
- `STUDENT_CONFLICT_WARNING:<детали наложения>`

---

## 4. API endpoints (server)

### Блоки
| Method | Path | Роль | Описание |
|--------|------|------|----------|
| `GET` | `/api/schedule` | ADMIN, OWNER | Все блоки школы. Поддерживает `?start=&end=` для фильтрации сессий |
| `POST` | `/api/schedule` | ADMIN, OWNER | Создать блок. Поддерживает `newGroupName` для auto-создания StudentGroup. `409 GROUP_ALREADY_IN_SCHEDULE`, если `studentGroupId` уже имеет активный блок — используйте `POST /group-pair` |
| `PUT` | `/api/schedule/:id` | ADMIN, OWNER | Обновить standalone-блок (без активной пары). `409 GROUP_PAIR_OWNED`, если у блока есть активная Grammar/Club пара — используйте `PUT /group-pair/:studentGroupId` |
| `DELETE` | `/api/schedule/:id` | ADMIN, OWNER | Архивация (soft-delete) standalone-блока. `409 GROUP_PAIR_OWNED`, если у блока есть активная Grammar/Club пара — используйте `DELETE /group-pair/:studentGroupId` |
| `PATCH` | `/api/schedule/:id/status` | ADMIN, OWNER | Сменить статус блока |

### Студенты в блоке
| Method | Path | Роль | Описание |
|--------|------|------|----------|
| `GET` | `/api/schedule/available` | STUDENT | Доступные группы для записи |
| `POST` | `/api/schedule/:id/apply` | STUDENT | Подать заявку на запись |
| `PATCH` | `/api/schedule/:id/approve/:studentProfileId` | ADMIN, OWNER | Одобрить заявку |
| `PATCH` | `/api/schedule/:id/reject/:studentProfileId` | ADMIN, OWNER | Отклонить заявку |
| `PATCH` | `/api/schedule/:id/add/:studentProfileId` | ADMIN, OWNER | Добавить студента напрямую (с проверкой конфликта расписания) |
| `POST` | `/api/schedule/:id/students` | ADMIN, OWNER | Массовое добавление |

### Сессии
| Method | Path | Роль | Описание |
|--------|------|------|----------|
| `GET` | `/api/schedule/sessions/week?weekStart=YYYY-MM-DD` | ADMIN, OWNER | Все сессии школы за неделю (для WeekGrid). Ответ содержит поле `isSubstitute: boolean` (true если учитель сессии ≠ учитель блока) |
| `GET` | `/api/schedule/session/for-date?lessonBlockId=&date=` | Все аутентифицированные | Найти сессию + посещаемость без создания |
| `POST` | `/api/schedule/session/ensure` | ADMIN, OWNER | Lazy-create сессии (если ещё нет) |
| `GET` | `/api/schedule/session/:id/students` | Все аутентифицированные | Состав студентов: первичный источник — `SessionStudent` снапшот, fallback — `studentGroup.students` |
| `PATCH` | `/api/schedule/session/:id/status` | ADMIN, OWNER, TEACHER | Отменить/завершить сессию. CANCELLED → уведомления студентам |
| `PATCH` | `/api/schedule/session/:id/teacher` | ADMIN, OWNER | Назначить замену (с проверкой 2 коллизий: постоянное расписание + другие замены в этот день). Body: `{ teacherUserId, version }` |
| `PATCH` | `/api/schedule/session/:id/details` | ADMIN, OWNER | Изменить кабинет/время конкретной сессии. Body: `{ cabinetId?, startTime?, endTime?, overrideCabinetConflict?, overrideTeacherConflict?, version }`. Устанавливает флаги `isManualCabinet`/`isManualTime` — при обновлении блока эти поля не сбрасываются. |
| `GET` | `/api/schedule/session/:id/attendance` | Все аутентифицированные | Посещаемость сессии |
| `PATCH` | `/api/schedule/session/:id/attendance` | ADMIN, OWNER, TEACHER | Отметить посещаемость (+ кредитная логика). Поддерживает `Idempotency-Key` заголовок. |

### Makeup
| Method | Path | Роль | Описание |
|--------|------|------|----------|
| `POST` | `/api/schedule/session/:id/makeup` | ADMIN, OWNER | Создать make-up урок для CANCELLED сессии. Body: `{ date: "YYYY-MM-DD", cabinetId?, teacherUserId? }`. Создаёт новый `LessonSession` с `isMakeup: true` и `makeupForSessionId: original.id`. Снапшотит студентов из той же группы. Кредиты не списываются. |

### Специальные
| Method | Path | Роль | Описание |
|--------|------|------|----------|
| `GET` | `/api/schedule/teacher` | TEACHER | Расписание конкретного учителя (блоки + замены) |
| `GET` | `/api/schedule/student` | STUDENT | Расписание студента (блоки + посещаемость последних 30 сессий) |
| `GET` | `/api/schedule/teacher-lesson-counts?year=&month=` | ADMIN, OWNER | Количество уроков по учителям за месяц (для зарплаты) |
| `GET` | `/api/schedule/teacher-lesson-calendar?year=&month=` | TEACHER | Календарь уроков учителя за месяц |
| `GET` | `/api/schedule/teacher-lesson-calendar-admin?teacherId=&year=&month=` | ADMIN, OWNER | То же, но для любого учителя |

### Cursor Pagination для блоков
`GET /api/schedule?cursor=xxx&take=50` — cursor-based пагинация. Ответ:
```json
{ "success": true, "data": [...], "nextCursor": "base64string", "hasMore": true }
```
Используй `pagination.ts` (`encodeCursor`, `decodeCursor`, `buildCursorPage`) для всех новых paginated endpoints.

### Исключения (ScheduleException)
| Method | Path | Роль | Описание |
|--------|------|------|----------|
| `GET` | `/api/exceptions?from=&to=` | ADMIN, OWNER | Список активных исключений в диапазоне дат |
| `POST` | `/api/exceptions` | ADMIN, OWNER | Создать исключение. Body: `{ type, scope, date?, dateFrom?, dateTo?, dayOfWeek?, schoolId, teacherId?, cabinetId?, studentGroupId? }` |
| `DELETE` | `/api/exceptions/:id` | ADMIN, OWNER | Удалить исключение |

### Bulk операции с сессиями
| Method | Path | Роль | Описание |
|--------|------|------|----------|
| `POST` | `/api/schedule/sessions/bulk-cancel` | ADMIN, OWNER | Массовая отмена сессий. Body: `{ sessionIds: number[] }` |

### Webhooks
| Method | Path | Роль | Описание |
|--------|------|------|----------|
| `GET` | `/api/settings/webhooks` | OWNER | Список webhooks школы |
| `POST` | `/api/settings/webhooks` | OWNER | Создать webhook. Body: `{ url, events: string[] }` — автоматически генерируется `secret` |
| `DELETE` | `/api/settings/webhooks/:id` | OWNER | Удалить webhook |

---

## 5. Кредитная логика (Antigravity)

Логика вынесена в **`services/attendanceService.ts`** → `markAttendance(tx, params)`. Вызывается только из Submit Attendance / attendance endpoints внутри `prisma.$transaction()`.

```
if (статус → PRESENT/LATE/ABSENT) && (кредит ещё не списан) && (нет активной StudentFreeze) → списать 1 кредит
if (есть активная StudentFreeze) → AttendanceStatus.FROZEN, creditDeducted=false, кредит не списывается
```

- `Attendance.creditDeducted` — флаг идемпотентности. Никогда не списывать дважды.
- `LessonCreditLog` — аудит. Создаётся при каждом списании/возврате.
- Кредит списывается только через Submit Attendance. Создание, перенос, отмена, makeup, смена кабинета или преподавателя кредиты не списывают.
- Обычная отмена сессии с `creditDeducted=true` блокируется guard-ом `SESSION_HAS_DEDUCTED_CREDITS`.
- Cancel flow не делает автоматический refund. Коррекция кредитов — отдельный явный ledger/correction flow с audit reason.
- `StudentFreeze` — source of truth для заморозки. `StudentProfile.isFrozen/frozenAt` — legacy cache.

---

## 6. Уведомления

Используй только `notify.ts` утилиты, **никогда** не вставляй `Notification` напрямую через Prisma.

| Событие | Функция | Получатели |
|---------|---------|------------|
| Студент подал заявку | `notifySchoolAdmins()` | ADMIN + OWNER школы |
| Сессия отменена | `notifyMany()` | `studentGroup.students` |
| Назначена замена | `notifyMany()` | `studentGroup.students` |
| Место освободилось в группе (withdraw) | `notify()` | Первый PENDING `EnrollmentRequest` в очереди |

Тип уведомления `WAITLIST_SPOT_AVAILABLE` (добавлен 2026-05-10): при удалении студента из группы (`DELETE /groups/:id/students/:profileId`) система ищет первую `EnrollmentRequest` со статусом `PENDING` для этой группы (сортировка `createdAt asc`) и отправляет уведомление пользователю через `notify()` с `data: { studentGroupId }`.

---

## 7. Клиентская часть (useSchedule.ts + scheduleTypes.ts)

### Структуры данных клиента

**`TimeSlot`** (клиент):
```ts
{ id: number; s: string; e: string } // "08:00", "09:20"
```
Серверный формат: `{ id, startTime, endTime }` → конвертируется в `loadFromServer`.

**`SchedGroup`** (клиент) — одна запись в UI-гриде. Представляет **одну пару** Grammar+Club блоков одной StudentGroup в одном TimeSlot:
- `grammarDays: number[]` — дни Grammar-блоков
- `clubDays: number[]` — дни Club-блоков
- `tg/tgId` — Grammar-учитель (имя / userId)
- `tk/tkId` — Club-учитель (имя / userId)
- `studentGroupId` — FK на StudentGroup (для новых блоков)
- `groupName` — `StudentGroup.name`
- `linkedIds` — IDs парных блоков (Club ↔ Grammar)

**`SC` (Schedule Cells)**: `Record<"dayIdx-slotId", gid[]>` — маппинг ячеек сетки на группы.

**`GMap`**: `Record<string, SchedGroup>` — все группы по ID.

### loadFromServer(blocks, dbSlots?, activeDays?)

Алгоритм мержа:
1. Блоки группируются по `mergeKey`:
   - Если блок привязан к StudentGroup: `grp:{studentGroupId}:ts:{timeSlotId}`
   - Без StudentGroup: `time:{startTime}|{endTime}|{level}`
2. Grammar+Club одной группы в одном слоте → одна `SchedGroup`.
3. `level`/`chapter` берётся из `studentGroup` (источник правды), затем из блока.
4. Студенты — только из `block.studentGroup?.students`. **`block.students` не приходит с бэкенда** (legacy M2M удалён). В `ServerBlock` интерфейсе это поле `optional` (`students?`), в коде итерация через `block.students ?? []`. Итерировать напрямую нельзя — `undefined` → TypeError → `setG`/`setSC` не вызываются → грид не обновляется.
5. Слоты: приоритет DB (`dbSlots`) → fallback `DEFAULT_SLOTS` → inline-создание для неизвестных времён.

### Горизонт отображения
`getGroupsInCell()` показывает **все блоки без ограничения** по горизонту (ограничение `ROLLING_DAYS` удалено 2026-05-10). Блоки существуют постоянно — сессии генерируются на 14 дней, но администратор может видеть расписание на любую неделю вперёд. Ячейки без сгенерированных сессий отображаются без данных о замене (пустой `weekSessions`).

### Локальные состояния (localStorage)
- `cancelled` / `permCanc` — legacy localStorage-отмены (обычно пусты; реальная отмена — через `PATCH /session/:id/status` → `cancelledSessions`)
- `attSub` — факт отправки посещаемости (localStorage-кеш)
- `lessonAtt`, `hw`, `waitlist`, `grpNotes`, `slotNotes`, `dayNotes` — заметки (только UI, не в БД)

### Единственный источник правды для замен и отмен
- **Замены**: `weekSessions` (заполняется `loadWeekSessions()` из `/sessions/week`). Никакого дублирующего localStorage нет.
- **Отмены**: `cancelledSessions` (заполняется `loadWeekSessions()` из тех же данных, фильтр `status === 'CANCELLED'`). `WeekGrid` вызывает `isBlockCancelled(blockId, dateISO)` — раздельно для Grammar и Club блоков.

### In-memory обновление без перезагрузки (2026-05-10)
- `updateWeekSession(blockId, dateISO, data)` — патчит конкретную запись в `weekSessions` напрямую (без `loadWeekSessions()`). Вызывается из `EditSessionPanel` после успешного `PATCH /session/:id/teacher`.
- `markSessionCancelled(blockId, dateISO, cancelled)` — обновляет `cancelledSessions` в памяти. Вызывается из `EditSessionPanel` после смены статуса сессии.
- **`onReload()` теперь вызывается только для структурных изменений** (создание/удаление блока). Редактирование замены, кабинета, времени — обновляет состояние in-memory, без мигания экрана.

### Формирование дат для API (критично!)
- **`dateKey(date: Date): string`** — утилита из `useSchedule.ts`. Использует `date.getFullYear()`, `getMonth()`, `getDate()` (локальное время браузера), форматирует в `"YYYY-MM-DD"`.
- **НЕ используй `date.toISOString().split('T')[0]`** для формирования дат, передаваемых в API. В UTC+ timezone `toISOString()` возвращает предыдущий день → сессии и посещаемость берутся за неверную дату.
- `SlotPanel` использует `dateKey(weekDates(wk)[ci])` во всех местах (2026-05-10 fix).

---

## 8. Настройки расписания (settings.ts)

### Хранение
- `School.activeDays: Int[]` — рабочие дни (не в JSON `settings`).
- `School.workStart`, `School.workEnd`, `School.slotDuration` — в отдельных колонках.
- `School.settings: Json` — остальные настройки (`holidays`, `groupSize`, и пр.).

### Синхронизация TimeSlot при изменении настроек
`PATCH /api/settings` → `syncTimeSlots()`:
1. Upsert новых слотов (по `schoolId + startTime + endTime` unique constraint).
2. После каждого upsert — `lessonBlock.updateMany({ where: { schoolId, timeSlotId } })` обновляет денормализованный кэш `startTime`/`endTime` в `LessonBlock` (2026-05-10 fix: ранее кэш оставался stale).
3. Удаляет старые слоты, у которых `_count.blocks === 0` (не используются в блоках).

### Валидация настроек
- `PATCH /api/settings` валидирует `workStart < workEnd` перед применением. При нарушении: `400 { error: 'Время начала работы должно быть раньше времени окончания' }` (2026-05-10).
- `generateSlotDefs()` возвращает `null` при некорректных параметрах — это нормально, но HTTP 400 нужен клиенту до вызова генератора.

### Управление праздниками (2026-05-10)
- `School.settings.holidays: string[]` — массив дат в формате `"YYYY-MM-DD"`.
- `PATCH /api/settings` принимает `{ holidays: string[] }` и сохраняет в `School.settings`.
- UI: вкладка "Расписание" в `CrmSettings.tsx` содержит date-picker для добавления праздничного дня и список с кнопками удаления. Каждое действие немедленно патчит настройки через API.

### Конфликт удаления рабочих дней
При попытке убрать день из `activeDays` — проверяет, есть ли блоки в этот день. Если есть → возвращает `conflictWarning: true` (не ошибку). Клиент должен показать диалог подтверждения и повторить запрос с `force: true`.

---

## 9. Зоны риска и известные проблемы

| # | Проблема | Статус | Деталь |
|---|---------|--------|--------|
| 1 | **Timezone** — все даты в UTC, локализация на стороне клиента | ✅ Исправлено полностью (2026-05-10 Part 4) | `school.timezone` — единственный источник правды. Сервер: `server/src/lib/tzUtils.ts` — `getWeekBoundaries(weekStartStr, tz)`, `getDayBoundaries(dateStr, tz)` через `date-fns-tz`. Клиент: `client/src/lib/tzUtils.ts` — `dateInTz`, `getMondayInTz`, `weekDatesInTz`, `weekKeyInTz` через нативный `Intl.DateTimeFormat` (без доп. зависимостей). `weekKey(d, tz?)`, `weekDates(wk, tz?)`, `dateKey(d, tz?)` в `useSchedule.ts` принимают опциональный `tz` — backward compatible. `SlotPanel` (EditSessionPanel + GroupRow) и `Schedule.tsx` используют `useAuth()` → `school.timezone` для всех API-дат. `GET /sessions/week` и `GET /session/for-date` интерпретируют параметры в timezone школы. |

### Уже исправлено

#### 2026-07-02 (Пропорциональный биллинг + отмена оплаты)
- ✅ **Пропорциональный расчёт уроков** — `PATCH /students/:id` (оплата) больше не делит на округлённую цену урока. Уроки выводятся из накопленного итога точной Decimal-математикой: `owed = floor(moneyBalance * billingDays / fee)`, `fee = monthlyFee ?? basePrice`. Полная оплата тарифа = ровно `billingDays` уроков (4000 = 26, а не 25), любая сумма разрешена, ни один сом не теряется. `StudentProfile.moneyBalance` теперь = накопленная сумма с момента последней смены цены (не декрементится), новая колонка `billingLessonsGranted` = уже начисленные уроки. Файлы: `server/src/routes/students.ts`, `server/prisma/schema.prisma`. Self-check: `server/src/billing/proportionalBilling.selfcheck.mjs`.
- ✅ **Смена гибкого тарифа = «черта»** — при изменении `monthlyFee` суб-урочный остаток переносится вперёд по новой цене, аккумулятор сбрасывается; уже начисленные уроки не пересчитываются (только будущие деньги считаются по новой цене).
- ✅ **Отмена/возврат оплаты** — `POST /students/:id/payments/:paymentId/cancel` (OWNER/SUPERADMIN). Полный реверс: списывает все начисленные оплатой уроки (баланс может уйти в минус, если часть использована). Оригинал сохраняется и помечается `cancelledAt`/`cancelledById`, пишется `LessonCreditLog` (type `REFUND`), уведомление OWNER+ADMIN. Отменённые оплаты исключаются из суммы за месяц.

#### 2026-05-07
- ✅ **`createMany skipDuplicates`** — `syncSessionsForBlock` теперь использует `{ skipDuplicates: true }`. Без этого сервер падал при старте: cron `extendAllBlockSessions()` пытался создать сессию для (blockId, date), которая уже есть с `deletedAt != null`, → P2002 unique constraint → unhandled rejection → процесс умирает.
- ✅ **Startup resilience** — `extendAllBlockSessions()` и `cleanupOldNotifications()` в `index.ts` теперь вызываются с `.catch(e => console.error(...))`. Ошибки в cron больше не убивают процесс.
- ✅ **`block.students` в `loadFromServer`** — `ServerBlock.students` помечено как `optional` (`students?`), итерация заменена на `block.students ?? []`. Без этого: `undefined` → TypeError → `catch { silent }` → `setG`/`setSC` не вызываются → после создания блока WeekGrid не обновлялся.
- ✅ **`attendanceService.ts` тип** — параметр `status: string` заменён на `status: AttendanceStatus` (импорт из `@prisma/client`). TypeScript-ошибка не позволяла собрать сервер.
- ✅ **`importexport.ts` экспорт расписания** — `students` удалён из Prisma select (поле больше не существует). Заменено на `studentGroup: { memberships: { where: { status: 'ACTIVE' } } }`. Строка CSV теперь показывает `memberships.length` вместо `students.length`.
- ✅ **`schedule.ts` POST — `timeSlotId` required** — `timeSlotId: null` вызывал TS-ошибку (поле `Int` без default). Добавлен fallback: если `timeSlotId` не передан — ищем `TimeSlot` по `(schoolId, startTime, endTime)`. Если не найден → 400.

#### 2026-05-05
- ✅ **`getDay()` смещение** — `teacher-lesson-counts`, `teacher-lesson-calendar`, `teacher-lesson-calendar-admin` использовали JS `date.getDay()` (0=Вс) вместо `(date.getDay()+6)%7` (0=Пн). Все уроки Пн-Сб считались неверно.
- ✅ **Уведомления при отмене** — `PATCH /session/:id/status` теперь включает студентов из `StudentGroup`, а не только из legacy M2M.

#### 2026-05-06
- ✅ **CANCELLED сессии невидимы в сетке** — сервер `/sessions/week` теперь возвращает и CANCELLED сессии (было только `teacherId != null`). Клиент `loadWeekSessions` заполняет `cancelledSessions: Record<string, true>`. `WeekGrid` проверяет `isBlockCancelled(blockId, dateISO)` для grammar и club раздельно.
- ✅ **`overrides` localStorage удалён** — `setSubstitute`, `clearSubstitute`, `getOverride` были мёртвым кодом (нигде не вызывались). Единственный источник правды — `weekSessions` (сервер). Замены всегда сохраняются через `PATCH /session/:id/teacher` → `onReload()` → `loadWeekSessions()`.
- ✅ **Legacy `block.students` удалён** — `_StudentEnrollments` join table удалена миграцией. Вся enrollment-логика (approve, add, bulk-add, import) теперь через `StudentGroup.students` + `GroupMembership`. `enrolledBlocks` убран из всех queries: `groups.ts`, `notifications.ts`, `students.ts`, `users.ts`, `importexport.ts`, клиент `StudentPicker.tsx`, `Students.tsx`.
- ✅ **`@@unique([lessonBlockId, date])`** — уникальный constraint на `LessonSession`. Дублирующие сессии удалены из БД перед применением.
- ✅ **Сервисный слой** — `services/sessionService.ts` (всё управление сессиями), `services/attendanceService.ts` (посещаемость + кредиты). `routes/schedule.ts` стал тонким слоем роутов.

---

## 10. Паттерны безопасности

- **Всегда** фильтруй по `schoolId` в каждом Prisma-запросе.
- **Всегда** добавляй `deletedAt: null` к `findMany`/`findFirst` для soft-deleted моделей (`LessonBlock`, `LessonSession`, `StudentProfile`, `Cabinet`, `User`, `StudentGroup`).
- **Используй `findFirst` вместо `findUnique`**, если нужно добавить дополнительные фильтры (Prisma `findUnique` не поддерживает дополнительные `where` вне составного индекса).
- Транзакции: используй `prisma.$transaction()` для операций, затрагивающих несколько таблиц (кредиты, удаление блоков).
- For AI workflow and development rules, see CLAUDE.md.

---

## 11. Архитектура сервисов

```
server/src/
  routes/
    schedule.ts          — HTTP роуты (тонкий слой, не содержит бизнес-логики)
    groups.ts            — CRUD групп + enrollment через GroupMembership
    exceptions.ts        — CRUD ScheduleException (исключения расписания)
  services/
    sessionService.ts    — генерация сессий: syncSessionsForBlock, extendAllBlockSessions,
                           cleanupInvalidSessions, snapshotNewSessions, getSessionDates
    attendanceService.ts — markAttendance(tx, params): посещаемость + кредиты
    scheduleValidation.ts — validateScheduleBlock: рабочие дни, вместимость, коллизии (Promise.all параллельно)
    exceptionService.ts  — getActiveExceptions(schoolId, from, to), isDateExcepted(date, exceptions)
    archivalService.ts   — archiveOldSessions(schoolId?): перемещает сессии >24 мес в LessonSessionArchive батчами 500
  lib/
    sessionStateMachine.ts — canTransition(from, to, role): { allowed, reason }
    permissions.ts         — Permission type, ROLE_PERMISSIONS map, can(), canAny(), canAll()
    auditLog.ts            — logScheduleAction({ ...params }): пишет в ScheduleActionLog с before/after JSON
    cronJobs.ts            — startCronJobs(): ежедневно extendAllBlockSessions, еженедельно archiveOldSessions
    worker.ts              — standalone entry point для production worker (npm run start:worker)
    pagination.ts          — encodeCursor, decodeCursor, buildCursorPage — cursor-based pagination
    cacheKeys.ts           — типизированные ключи кэша + invalidateBlockCaches()
    webhooks.ts            — dispatchWebhook(schoolId, event, payload): HMAC-SHA256 подписанные POST-запросы
    tzUtils.ts             — getWeekBoundaries, getDayBoundaries, dateInTz (date-fns-tz)
  middleware/
    requirePermission.ts   — requirePermission(...permissions): Express middleware
```

#### 2026-05-08
- ✅ **`SessionStudent` снапшот** — `snapshotNewSessions()` создаёт `SessionStudent` записи при генерации новых сессий. Фиксирует состав группы на момент создания. `GET /session/:id/students` использует как primary source.
- ✅ **Документация расширена** — добавлены `ARCHITECTURAL_DECISIONS.md`, `DATABASE_CONSTRAINTS.md`, `FRONTEND_STATE_RULES.md`.

#### 2026-05-10
- ✅ **1.1 LessonBlock cache staleness** — `syncTimeSlots()` в `settings.ts` теперь после каждого upsert TimeSlot обновляет `LessonBlock.startTime`/`endTime` через `updateMany`. Ранее изменение настроек оставляло stale кэш в блоках и наследуемые stale снапшоты в сессиях.
- ✅ **1.2 syncSessionsForBlock — атомарность** — `createMany(sessions)` + `snapshotNewSessions()` теперь обёрнуты в `prisma.$transaction(async (tx) => {...})`. `snapshotNewSessions` принимает `client: DbClient` первым аргументом. Если снапшот упадёт — сессии откатятся.
- ✅ **1.3 extendAllBlockSessions — изоляция ошибок** — каждый блок обрабатывается в отдельном `try/catch`. Ошибка одного блока логируется и пропускается; остальные блоки продолжают синхронизацию.
- ✅ **1.4 cleanupInvalidSessions — запрет silent fallback timezone** — если школа не найдена → `throw new Error('School not found')` вместо `'Asia/Bishkek'`. Скрытые ошибки lookup больше не вызывают неверную чистку сессий.
- ✅ **2.1 Клиентский timezone fix (dateKey)** — `SlotPanel.tsx` заменил `toISOString().split('T')[0]` на `dateKey(weekDates(wk)[ci])` для всех мест формирования `lessonDate`. В UTC+ timezone `toISOString()` возвращал предыдущий день — теперь используется локальное время браузера.
- ✅ **2.2 Grammar+Club атомарный rollback** — при создании Grammar+Club блоков в `createGroup()`: если создание Club упало, выполняется компенсирующий `DELETE /schedule/{grammarBlockId}`. Orphaned Grammar-блок не остаётся в БД.
- ✅ **2.3 Settings validation** — `PATCH /api/settings` валидирует `workStart < workEnd` перед обновлением. Ответ `400` с читаемым сообщением. Ранее `generateSlotDefs()` возвращал `null` молча.
- ✅ **2.4 Credit floor** — `attendanceService.ts` проверяет `credits >= 1` перед списанием. При нехватке — `INSUFFICIENT_CREDITS` ошибка пробрасывается через HTTP 400. Студент не уходит в минус.
- ✅ **3.1 Горизонт отображения** — `getGroupsInCell()` убрал ограничение `today + 14`. Блоки отображаются на любой неделе вперёд — администратор может планировать расписание заблаговременно.
- ✅ **3.2 In-memory sync weekSessions** — `updateWeekSession(blockId, dateISO, data)` и `markSessionCancelled(blockId, dateISO, cancelled)` добавлены в `useSchedule`. `EditSessionPanel` обновляет состояние в памяти после PATCH — нет мигания от `onReload()` при редактировании сессии.
- ✅ **3.3 Waitlist auto-notification** — при удалении студента из группы (`DELETE /groups/:id/students/:profileId`) ищется первый PENDING `EnrollmentRequest`; найденному пользователю отправляется `WAITLIST_SPOT_AVAILABLE` уведомление через `notify()`.
- ✅ **3.4 Makeup session** — Схема: `LessonSession.isMakeup` + `LessonSession.makeupForSessionId` (self-referential FK). Миграция применена через `prisma db push`. Новый endpoint `POST /session/:id/makeup` создаёт make-up урок в транзакции + снапшот студентов. Кредиты не списываются.
- ✅ **4.1 Holiday management UI** — Вкладка "Расписание" в `CrmSettings.tsx`: date-picker + список праздников с кнопками удаления. Каждое действие немедленно патчит `School.settings.holidays` через `PATCH /api/settings`.
- ✅ **4.3 Attendance overwrite protection** — `GroupRow` при разворачивании не перезаписывает локальные отметки посещаемости: если для студента уже есть запись в `lessonAtt[localAttKey]` — данные из БД пропускаются.

#### 2026-05-09
- ✅ **Conflict Engine Phase 1: Студенты** — Реализована проверка коллизий для студентов (`checkStudentScheduleConflicts`). Теперь при добавлении в группу или изменении времени урока система предупреждает, если у студента есть наложение. Поддерживается "soft-override" (админ может игнорировать предупреждение).
- ✅ **Conflict Engine Phase 2: Учителя и Нагрузка** — Добавлены `workingDays` и `maxLessonsPerDay` для учителей. Система блокирует или выдает предупреждение при попытке поставить урок в нерабочий день учителя или при превышении дневного лимита.
- ✅ **Regeneration Safety (Self-healing)** — Внедрен механизм защиты ручных правок. Сессии теперь содержат флаги `isManualTeacher`, `isManualCabinet`, `isManualTime`. При обновлении расписания всей группы система не затирает те поля, которые админ изменил вручную для конкретного урока.
- ✅ **Phase 3: Audit Logs («Три точки»)** — Реализована система аудита изменений. Все действия (замена учителя, отмена урока, смена кабинета/времени) логируются в `ScheduleActionLog`. В интерфейсе `EditSessionPanel` добавлена кнопка истории (📅), позволяющая увидеть, кто и когда внес изменения.
- ✅ **Phase 4: Teacher Work History** — Переработана система отчетов для учителей. Теперь история строится на основе реальных сессий, что позволяет точно учитывать замены. В профиле учителя добавлена вкладка «История» с фильтрацией по месяцам.

---

#### 2026-05-10 (Part 2)
- ✅ **Makeup Session UI** — В `EditSessionPanel` добавлена секция "Замещающий урок": появляется когда `status === 'CANCELLED'`, позволяет выбрать дату и вызывает `POST /session/:id/makeup`. После создания — `onReload()` обновляет грид.
- ✅ **Student conflict visualization** — В `StudentPicker` добавлены цветные день-бейджи (Пн–Вс) для каждого студента в дропдауне. Красный = конфликт с добавляемой группой, оранжевый = занят в другой группе, серый = свободен. Данные берутся из `sched.G` (gmap), не требуют доп. API-запросов.

#### 2026-05-10 (Part 3 — Production Scalability)
- ✅ **Composite DB indexes** — Миграция `20260510100000_composite_indexes`: добавлены составные индексы для масштабирования до 30k студентов: `LessonSession(schoolId,date)`, `LessonSession(teacherId,date)`, `LessonSession(status,date)`, `LessonSession(schoolId,status)`, `Attendance(studentProfileId,createdAt)`, `EnrollmentRequest(studentGroupId,status)`, `EnrollmentRequest(studentProfileId,status)`, `LessonBlock(schoolId,teacherId)`, `LessonBlock(schoolId,timeSlotId)`. Все через `CREATE INDEX IF NOT EXISTS` (без `CONCURRENTLY` — Prisma запускает миграции в транзакции).
- ✅ **Optimistic locking** — Миграция `20260510110000_session_version`: добавлено поле `LessonSession.version Int @default(0)`. При обновлении сессии выполняется `version: { increment: 1 }`. Предотвращает silent race conditions при параллельных запросах.
- ✅ **Server-side pagination** — `GET /api/students` принимает `page`, `limit`, `search`, `filter`, `level`, `cabinet`. Возвращает `{ data, meta: { total, page, limit, pages, counts } }`. Аналогично `GET /api/users` и `GET /api/groups`. Клиент `Students.tsx` полностью переписан на server-side filtering + debounced search (350ms).
- ✅ **N+1 fix в sessionService** — `extendAllBlockSessions` / `syncSessionsForBlock`: снапшот-обновление полей `teacherId/cabinetId/startTime/endTime` заменено с N индивидуальных `update` на 3 параллельных `updateMany` с `{ id: { in: [...] } }`.
- ✅ **Rate limiters** — `middleware/rateLimiters.ts`: `attendanceLimiter` (60/мин), `sessionEnsureLimiter` (30/мин), `notificationsLimiter` (20/мин), `creditsLimiter` (30/мин), `generalLimiter` (200/мин). Подключены к соответствующим роутам.
- ✅ **Connection pooling** — `DATABASE_URL` расширен `?connection_limit=10&pool_timeout=20`. `DB_POOL_SIZE` env var для переопределения.
- ✅ **Sentry monitoring** — `server/src/instrument.ts`: `initSentry()` инициализирует `@sentry/node` + profiling если `SENTRY_DSN` задан. `client/src/main.tsx`: `@sentry/react` инициализируется если `VITE_SENTRY_DSN` задан. `Sentry.captureException(err)` в глобальном error handler Express.
- ✅ **BullMQ queue для уведомлений** — `server/src/lib/queue.ts`: если `REDIS_URL` задан — `notificationQueue` (BullMQ) + `Worker` с `concurrency: 10`. Без Redis — синхронный fallback через прямую вставку в БД. `notify.ts` переписан на `enqueueNotification()` / `enqueueNotifications()`.
- ✅ **WebSockets (Socket.io)** — `server/src/lib/socket.ts`: JWT-аутентификация при handshake, изоляция по школе через rooms `school:{schoolId}`. `emitToSchool(schoolId, event, data)` — публичный интерфейс. Events: `session:status-changed` (при PATCH `/session/:id/status`), `attendance:updated` (при PATCH `/session/:id/attendance`). Клиент: `client/src/lib/socket.ts` + `hooks/useRealtimeSchedule.ts`. `AuthContext` вызывает `connectSocket(token)` при логине и `disconnectSocket()` при logout. `Schedule.tsx` использует `useRealtimeSchedule` с debounced reload 500ms.
- ✅ **Redis cache** — `server/src/lib/cache.ts`: обёртка над ioredis (`cacheGet/cacheSet/cacheInvalidate`). Graceful fallback: без Redis кеш просто не работает (null на get, skip на set). Кеш включён на: `/api/analytics/overview` (TTL 60 сек, ключ `analytics:overview:{schoolId}`), `/api/schedule/teacher-lesson-calendar-admin` (TTL 120 сек, ключ `teacher-cal:{schoolId}:{teacherId}:{year}:{month}`).
- ✅ **HTTP server refactor** — `index.ts`: `app.listen()` заменён на `createServer(app)` + `httpServer.listen()`. Socket.io и HTTP server используют один порт.
- ✅ **SIGTERM graceful shutdown** — `process.on('SIGTERM')` в `index.ts`: `server.close()` → `closeQueue()` → `prisma.$disconnect()`.

---

## 12. Инфраструктура (production-readiness)

### Socket.IO — события реального времени

| Событие | Триггер (сервер) | Данные | Потребитель (клиент) |
|---------|-----------------|--------|---------------------|
| `session:status-changed` | `PATCH /session/:id/status` | `{ sessionId, lessonBlockId, status, date }` | `Schedule.tsx` → `debouncedReload()` |
| `attendance:updated` | `PATCH /session/:id/attendance` | `{ sessionId, studentProfileId, status }` | `Schedule.tsx` → `debouncedReload()` |

Изоляция: каждый socket при подключении `join`-ится в room `school:{schoolId}`. Emit всегда идёт только в нужную room — разные школы не видят события друг друга.

**Правило:** при добавлении нового события — добавить emit в server route, тип в `useRealtimeSchedule.ts`, и подписку в нужном компоненте. Не emit-ить в `emitToSchool` до отправки HTTP-ответа — иначе клиент получит событие раньше, чем запрос вернётся.

### Redis cache — правила инвалидации

| Ключ | TTL | Инвалидировать при |
|------|-----|--------------------|
| `analytics:overview:{schoolId}` | 60 сек | Автоматически по TTL |
| `teacher-cal:{schoolId}:{uid}:{year}:{month}` | 120 сек | Автоматически по TTL |

Текущая стратегия — TTL-based. Если добавляешь кешируемый endpoint: используй `cacheGet(key)` → обработка → `cacheSet(key, data, ttl)`. Для write-invalidation используй `cacheInvalidate('prefix:*')`.

### Pagination API — формат ответа

Все paginated endpoints возвращают:
```json
{
  "success": true,
  "data": [...],
  "meta": {
    "total": 1500,
    "page": 1,
    "limit": 50,
    "pages": 30
  }
}
```
`GET /api/students` дополнительно возвращает `meta.counts: { all, active, overdue, paused }`.

Клиент всегда читает `res.data?.data ?? []` — backwards-compatible если сервер вернул плоский массив.

---

## 13. Session State Machine

Файл: `server/src/lib/sessionStateMachine.ts`

**Граф переходов:**
```
UPCOMING ──────→ IN_PROGRESS ──→ COMPLETED ──→ LOCKED (терминальный)
    │                │
    └──→ CANCELLED ←─┘
          │
          └──→ UPCOMING  (только OWNER/ADMIN — реактивация)
```

| From | To | Роли |
|------|----|------|
| UPCOMING | IN_PROGRESS | OWNER, ADMIN, TEACHER |
| UPCOMING | CANCELLED | OWNER, ADMIN |
| IN_PROGRESS | COMPLETED | OWNER, ADMIN, TEACHER |
| IN_PROGRESS | CANCELLED | OWNER, ADMIN |
| COMPLETED | LOCKED | OWNER |
| CANCELLED | UPCOMING | OWNER, ADMIN |

```ts
canTransition(from: SessionStatus, to: SessionStatus, role: Role): { allowed: boolean; reason?: string }
isEditable(status: SessionStatus): boolean       // не LOCKED
isAttendanceAllowed(status: SessionStatus): boolean  // IN_PROGRESS или COMPLETED
```

**PATCH /session/:id/status** использует `canTransition` — возвращает 403 с `reason` при недопустимом переходе. Любое изменение статуса логируется через `logScheduleAction` с before/after снапшотом.

---

## 14. Permission RBAC

Файл: `server/src/lib/permissions.ts`

**Именованные разрешения:**
```
schedule:read | schedule:write | students:read | students:write |
attendance:write | credits:read | finance:read | finance:write |
analytics:read | users:manage | settings:read | settings:write |
session:lock | conflicts:override | notifications:read
```

**Матрица ролей:**
| Разрешение | SUPERADMIN | OWNER | ADMIN | TEACHER | STUDENT |
|-----------|-----------|-------|-------|---------|---------|
| session:lock | ✅ | ✅ | ❌ | ❌ | ❌ |
| finance:write | ✅ | ✅ | ❌ | ❌ | ❌ |
| settings:write | ✅ | ✅ | ❌ | ❌ | ❌ |
| users:manage | ✅ | ✅ | ❌ | ❌ | ❌ |
| conflicts:override | ✅ | ✅ | ❌ | ❌ | ❌ |
| schedule:write | ✅ | ✅ | ✅ | ❌ | ❌ |
| attendance:write | ✅ | ✅ | ✅ | ✅ | ❌ |
| schedule:read | ✅ | ✅ | ✅ | ✅ | ✅ |

**Middleware:** `requirePermission('schedule:write')` — ставится в router chain **вместо** inline `if (req.user.role !== 'ADMIN')`. Все 8 route-файлов обновлены. Не дублируй inline-проверки.

---

## 15. ScheduleException Engine

Файл: `server/src/services/exceptionService.ts`, модели: `ScheduleException`

**Типы исключений (ExceptionType) — точные значения enum:**
- `HOLIDAY_CUSTOM` — праздничный/выходной день (все уроки отменяются)
- `TEACHER_UNAVAILABLE` — учитель недоступен (болезнь, командировка)
- `CABINET_UNAVAILABLE` — кабинет недоступен (ремонт, закрыт)
- `GROUP_RESCHEDULED` — группа перенесена (урок в другое время/дату)
- `EXAM_PERIOD` — экзаменационный период (уроки не проводятся)

**Области (ExceptionScope) — точные значения enum:**
- `SCHOOL` — для всей школы
- `TEACHER` — конкретный учитель
- `CABINET` — конкретный кабинет
- `GROUP` — конкретная группа

**Интеграция:** `syncSessionsForBlock()` вызывает `getActiveExceptions()` → `isDateExcepted()` для фильтрации дат при генерации. Если дата исключена — сессия не создаётся (и не пересоздаётся).

**Важно:** `isDateExcepted` проверяет иерархию: сначала SCHOOL, потом более узкие скоупы. Scope `EXTRA_DAY` перекрывает HOLIDAY для той же даты.

---

## 16. Archive Strategy

Файл: `server/src/services/archivalService.ts`

Сессии старше **24 месяцев** архивируются в `LessonSessionArchive` (+ `AttendanceArchive`). Cron: **раз в неделю** (воскресенье, 03:00) через `cronJobs.ts`.

```ts
archiveOldSessions(schoolId?: number): Promise<{ archived: number }>
```

- Batch size: **500** сессий за итерацию
- Атомарно: копирует → удаляет в `prisma.$transaction()`
- Если `schoolId` не передан — архивирует все школы
- Архивные таблицы `LessonSessionArchive` / `AttendanceArchive` — только для чтения (нет update/delete API)

---

## 17. Worker / API разделение

**Проблема:** cron и BullMQ в одном API-процессе мешают горизонтальному масштабированию (несколько API-инстансов → дублирующиеся cron jobs).

**Решение:**
- `DISABLE_CRON=true` на API-инстансах → cron и BullMQ не запускаются
- `npm run start:worker` / `npm run dev:worker` → `server/src/worker.ts` запускается как отдельный процесс
- `worker.ts` инициализирует: Redis cache, BullMQ queue, `startCronJobs()`
- SIGTERM/SIGINT handlers для graceful shutdown

**В production:** PM2 запускает 1 экземпляр `worker.ts` и N экземпляров `index.ts` с `DISABLE_CRON=true`.

---

## 18. Webhooks

Файл: `server/src/lib/webhooks.ts`, модель: `Webhook`

```ts
dispatchWebhook(schoolId: number, event: string, payload: object): Promise<void>
```

- Находит все активные webhooks школы для данного события
- Подписывает тело HMAC-SHA256 с `webhook.secret`
- Заголовок: `X-Shamdan-Signature: sha256=<hex>`
- POST-запрос с `Content-Type: application/json`
- Ошибки: логируются, не пробрасываются (не ломают основной flow)

**Webhook.events** — JSON-массив строк: `["session.cancelled", "attendance.updated"]` и т.п.

**Важно:** вызывай `dispatchWebhook` **после** успешного ответа клиенту, используй `Promise.race` с таймаутом 5 сек если нужно.

---

#### 2026-05-10 (Part 4 — World-class Architecture)
- ✅ **Session State Machine** — `sessionStateMachine.ts`: строгий граф переходов UPCOMING→IN_PROGRESS→COMPLETED→LOCKED с проверкой роли. PATCH /session/:id/status возвращает 403 при недопустимом переходе.
- ✅ **Permission RBAC** — `permissions.ts` + `requirePermission.ts`. 15 именованных разрешений. Все 8 route-файлов рефакторированы — inline role checks заменены на `requirePermission()`.
- ✅ **Enhanced Audit Log** — `ScheduleActionLog` расширен: `entityType`, `before Json?`, `after Json?`, `reason`, `ipAddress`. `logScheduleAction()` хелпер извлекает IP из `x-forwarded-for`.
- ✅ **ScheduleException Engine** — модели `ScheduleException` (ExceptionType/ExceptionScope enums), `exceptionService.ts`, интеграция в `syncSessionsForBlock`. CRUD роуты `/api/exceptions`.
- ✅ **Cursor Pagination** — `pagination.ts`: `encodeCursor/decodeCursor/buildCursorPage`. GET /api/schedule поддерживает `?cursor=&take=`.
- ✅ **Archive Strategy** — `LessonSessionArchive` + `AttendanceArchive` модели. `archivalService.ts`: batch архивация сессий >24 мес. Еженедельный cron в `cronJobs.ts`.
- ✅ **Parallel batch generation** — `extendAllBlockSessions` обрабатывает блоки параллельно батчами по 50 через `Promise.all`.
- ✅ **Parallel validation** — `validateScheduleBlock` делает запросы к school/cabinet/studentGroup параллельно через `Promise.all`.
- ✅ **Cache invalidation** — `cacheKeys.ts` + `invalidateBlockCaches()` вызывается при create/update/delete блоков.
- ✅ **Optimistic locking (client)** — `SlotPanel.tsx` сохраняет `version` при `session/ensure`, передаёт при save, обрабатывает 409 `STALE_DATA` с toast.
- ✅ **Bulk cancel** — `POST /api/schedule/sessions/bulk-cancel`: принимает `{ sessionIds: number[] }`, отменяет массово, логирует через `logScheduleAction`.
- ✅ **Webhooks** — `Webhook` модель в схеме, `webhooks.ts` с HMAC-SHA256 подписью, CRUD роуты в `settings.ts`.
- ✅ **Worker/API разделение** — `cronJobs.ts` + `worker.ts` + `DISABLE_CRON` env var. В production: один worker, N API-инстансов.

#### 2026-05-10 (Part 5 — Tenant Isolation + Queue Hardening)
- ✅ **Tenant isolation via AsyncLocalStorage** — `server/src/lib/requestContext.ts`: `runWithContext(ctx, fn)` + `getSchoolId()`. `authenticate.ts` вызывает `runWithContext({ schoolId, userId, role }, next)` после JWT verify. Prisma `$use` middleware автоматически инжектирует `schoolId` в `findMany`/`findFirst` для 15 tenant-моделей. Cron-jobs и SUPERADMIN запросы работают без контекста → инжекция не происходит (корректно).
- ✅ **Queue idempotency keys** — `makeJobId(payload): string` генерирует детерминированный ключ `notify:<userId>:<type>[:s<sessionId>][:g<groupId>]`. BullMQ дропает дубликат если job с тем же ID уже в очереди. Предотвращает дублирующиеся уведомления при rapid triggers и worker retries.
- ✅ **Queue retry strategy** — `attempts: 3`, `backoff: { type: 'exponential', delay: 1000ms }`. Worker логирует предупреждение при промежуточных failures и ошибку при exhausted retries. `removeOnFail: 200` (увеличено с 50 для отладки).

#### 2026-05-10 (Part 6 — Production Readiness)
- ✅ **Socket.IO Redis adapter** — `@socket.io/redis-adapter` подключён в `socket.ts`. Если `REDIS_URL` задан — создаются pub/sub клиенты и `io.adapter(createAdapter(...))`. Без Redis — fallback на in-memory (single-instance). Это обязательно для горизонтального масштабирования: без адаптера emits от API-инстанса A не доходят до клиентов на инстансе B.
- ✅ **Migration baseline** — 13 исторических миграций squash-нуты в один файл `prisma/migrations/20260510200000_baseline/migration.sql` (859 строк, полная схема). `prisma migrate status` показывает "up to date". В production: `npx prisma migrate deploy` создаёт все таблицы чисто с нуля. Дальнейшие изменения схемы — только через `npx prisma migrate dev --name <name>` локально.
- ✅ **Credit reconciliation script** — `server/scripts/rebuild-credits.ts`. Пересчитывает `StudentProfile.credits` из суммы `LessonCreditLog.amount`. Поддерживает `--dry` (preview) и фильтр по schoolId. Запуск: `npx tsx scripts/rebuild-credits.ts [schoolId] [--dry]`. Использовать при подозрении на corruption credits.
- ✅ **DEPLOYMENT.md** — полностью переписан: Worker/API разделение (`DISABLE_CRON=true`), Socket.IO Nginx proxy блок, disaster recovery (Railway backup + pg_dump + credit rebuild), production checklist, scaling для 50k студентов.

#### 2026-05-10 (Part 7 — 100/100 Production Polish)
- ✅ **Deep health check** — `GET /health` (без версионного префикса) теперь делает `prisma.$queryRaw SELECT 1` и Redis `PING`. Возвращает `{ status: "healthy"|"degraded", db: "ok"|"error", redis: "ok"|"error"|"disabled", ts }`. HTTP 200 если DB OK, HTTP 503 если DB недоступна. PM2 и балансировщики используют для liveness probe. `cache.ts` экспортирует `pingRedis(): Promise<boolean>`.
- ✅ **API versioning `/api/v1/`** — сервер монтирует routes на `/api/v1` (`app.use('/api/v1', routes)`). Клиент: `api.ts` baseURL = `/api/v1`. Vite proxy: ключ `/api/v1`. Nginx: `location /api/v1/` + отдельный `location /health`. Breaking changes в будущем — `/api/v2/` без ломки существующих клиентов.
- ✅ **Refresh tokens** — новая Prisma модель `RefreshToken { id, token (unique), userId, expiresAt, revokedAt, createdAt }`. Миграция `20260510103233_add_refresh_tokens`. `auth.ts`: helper `issueRefreshCookie(userId, res)` генерирует `crypto.randomBytes(64).toString('hex')`, сохраняет в БД, ставит HttpOnly cookie `rt` (30 дней, `sameSite: lax`, `secure` в prod). Все auth endpoints (login, register-school, register-student, google) вызывают helper. `POST /auth/refresh` — валидирует cookie, ревокирует старый токен, создаёт новый (rotation), возвращает новый access token. `POST /auth/logout` — ревокирует refresh token в БД + очищает cookie. Single active session: при выдаче нового refresh все предыдущие активные отзываются.
- ✅ **Client refresh interceptor** — `api.ts` response interceptor: при 401 на authenticated запросе (имеющем `Authorization` header) → тихий вызов `POST /api/v1/auth/refresh` → обновление `localStorage.token` → retry оригинального запроса. Concurrent 401s ставятся в очередь `pendingQueue` и replayed после одного рефреша (не N параллельных refresh-вызовов). Если refresh сам падает → `localStorage.removeItem('token')` + redirect `/login`. `AuthContext.logout()` вызывает `POST /auth/logout` fire-and-forget перед очисткой state.
- ✅ **PgBouncer docs** — `DEPLOYMENT.md` дополнен: полный конфиг `pgbouncer.ini` в `transaction mode`, `userlist.txt`, обновлённый `DATABASE_URL` с пониженным `connection_limit`. Когда включать: 4+ API-инстансов. Nginx: добавлен отдельный `location /health` блок.

#### 2026-05-20 (Stage 6 Final — Style extraction, RoomBlock split, keyboard UX, useSchedule fixes)
- ✅ **Style extraction** — созданы 4 новых файла: `weekGridStyles.ts`, `roomBlockStyles.ts`, `groupRowStyles.ts`, `teacherAvailabilityStyles.ts`. Статические стили → module-level `const` (нулевые аллокации на render). Динамические → factory-функции на уровне модуля. Устраняет сотни лишних object references при каждом рендере `WeekGrid` и `GroupRow`.
- ✅ **RoomBlock.tsx** — вынесен из `WeekGrid.tsx` в отдельный файл. Мемо с явным `areEqual` comparator, проверяющим стабильные callback refs (`isAttSubmitted`, `isBlockCancelled`, `getSessionSubstitute`) вместо сравнения всего объекта `sched`. `WeekGrid.tsx` сокращён с 410 до ~120 строк — все inline-стили заменены на `weekGridStyles`.
- ✅ **TeacherAvailabilitySelect — keyboard UX** — добавлены `focusedIndex` state, `options[]` useMemo (unified flat list для навигации), `handleKeyDown` (Escape закрывает, ArrowUp/Down перемещают фокус, Enter выбирает, Tab закрывает). `onMouseEnter` синхронизирует focusedIndex с мышью. ARIA атрибуты: `role="listbox"` на dropdown, `role="option"` на items, `aria-haspopup`/`aria-expanded` на trigger.
- ✅ **useSchedule.ts fixes** — `historyWeeks` обёрнут в `useMemo([history])` (устраняет `Object.keys().sort().reverse()` при каждом рендере). Дублирующаяся функция `timeRangesOverlap` удалена — теперь импортируется из `scheduleConflicts.ts` (функция там теперь `export`). Добавлен `useMemo` в импорт React.

### Правила для будущих изменений схемы

**ВСЕГДА** при изменении `prisma/schema.prisma`:
```bash
# Локально:
npx prisma migrate dev --name "describe_change"   # создаёт migration file + применяет
npx prisma generate                                # обновляет Prisma Client

# В production (CI/CD):
npx prisma migrate deploy                          # применяет pending migration files
npx prisma generate
```

**НИКОГДА не использовать** `npx prisma db push` в shared/production окружениях — это создаёт drift и ломает историю миграций.

#### 2026-05-10 (Part 8 — Three Real Blockers Closed)
- ✅ **Redis-backed distributed rate limiting** — `RedisRateLimitStore` в `rateLimiters.ts`: атомарный Lua INCR+EXPIRE, in-memory fallback при недоступном Redis. `cache.ts` экспортирует `getRawRedis()`. Каждый лимитер имеет уникальный prefix (`rl:att:`, `rl:ens:`, `rl:ntf:`, `rl:enr:`, `rl:crd:`, `rl:gen:`). При multi-instance деплое лимиты теперь реально работают (не per-process).
- ✅ **Distributed cron lock** — `withCronLock(name, ttlSec, fn)` в `cronJobs.ts`: Redis SET NX + Lua-release (atomic). TTL 5 мин для daily jobs, 10 мин для weekly archive. Если Redis недоступен — job выполняется напрямую (single-instance fallback). Ключи: `cron:lock:cleanupNotifications`, `cron:lock:extendSessions`, `cron:lock:archiveSessions`. Startup-запуски без лока (один процесс — одна инициализация).
- ✅ **Optimistic locking 100% coverage** — version check добавлен в `PATCH /session/:id/status` и `PATCH /session/:id/details` (ранее только `/teacher` и `/attendance` проверяли `version`). Клиент `SlotPanel.tsx` передаёт `version: sessionVersion` во все три мутирующих вызова (teacher/status/details). 409 `STALE_DATA` → toast «Данные устарели».

#### 2026-05-10 (Part 9 — ERP-grade Foundation: Idempotency + Tracing + Tests)
- ✅ **HTTP Idempotency middleware** — `middleware/idempotency.ts`: клиент передаёт `Idempotency-Key: <uuid>` header, сервер кэширует ответ в Redis (24h TTL, key `idem:{schoolId}:{key}`) или in-process Map при отсутствии Redis. Применён к `PATCH /session/:id/attendance`, `POST /credits/add`, `POST /session/:id/makeup`. Клиент `AddCreditsModal` генерирует `crypto.randomUUID()` per modal open и отправляет в заголовке. Предотвращает двойное списание кредитов при network retry.
- ✅ **OpenTelemetry distributed tracing** — `lib/otel.ts`: `initOtel()` инициализирует SDK если задан `OTLP_ENDPOINT` env var (Grafana Cloud, Jaeger, любой OTLP-совместимый backend). Без `OTLP_ENDPOINT` — все spans no-op, zero overhead в dev. `withSpan(name, fn, attrs)` — хелпер для ручных спанов. Добавлен в: `extendAllBlockSessions` (атрибуты `blockCount`, `sessionsAdded`), `markAttendance` (атрибуты `sessionId`, `studentProfileId`, `creditDeducted`, `creditRefunded`). `initOtel()` вызывается первой строкой в `index.ts` и `worker.ts`. Env vars: `OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`.
- ✅ **Unit test suite (44 тестов)** — `jest.config.js` + `tsconfig.test.json`. Тесты: `sessionStateMachine.test.ts` (34 теста — полное покрытие canTransition, isEditable, isAttendanceAllowed включая LOCKED, все роли, undefined transitions), `attendanceService.test.ts` (10 тестов — кредитная логика, PRESENT/LATE/ABSENT, INSUFFICIENT_CREDITS, идемпотентность через creditDeducted флаг). `npm test` запускает `jest --passWithNoTests`. `npm run test:coverage` — с покрытием. `__tests__` исключены из основного `tsconfig.json` (чтобы не мешать `tsc --noEmit`).

#### 2026-05-10 (Part 10 — Bug fixes + Docs audit)
- ✅ **sessions/week filter bug** — удалён `OR: [{ teacherId: { not: null } }, { status: 'CANCELLED' }]` фильтр, который скрывал обычные сессии. Теперь endpoint возвращает **все** сессии недели. Добавлено поле `isSubstitute: boolean` (true когда `session.teacher.userId ≠ block.teacher.userId`). Fallback-учитель берётся из `lessonBlock.teacher` если `session.teacherId` не задан.
- ✅ **block status validation** — `PATCH /schedule/:id/status` возвращает 400 при недопустимом статусе. Допустимые: `UPCOMING | COMPLETED | CANCELLED` (enum `BlockStatus` не содержит `ACTIVE`).
- ✅ **level+chapter update** — `PATCH /users/:id/level` теперь корректно принимает и `level`, и `chapter` (оба optional, `chapter` приводится через `Number()`).
- ✅ **DELETE /users/:id** — добавлен эндпоинт мягкого удаления пользователя (`deletedAt = now()`). Защита: нельзя удалить собственный аккаунт; schoolId-фильтр.
- ✅ **Docs audit** — исправлены enum-значения: `GroupMembership.status` = `ACTIVE | PAUSED | WITHDRAWN` (было LEFT/SUSPENDED), `ExceptionType` = `TEACHER_UNAVAILABLE | CABINET_UNAVAILABLE | GROUP_RESCHEDULED | EXAM_PERIOD | HOLIDAY_CUSTOM`, `ExceptionScope` = `SCHOOL | TEACHER | CABINET | GROUP`. Добавлены: `PATCH /session/:id/details` в API-таблицу, `STUDENT_CONFLICT_WARNING` + `TEACHER_CONFLICT_WARNING` в секцию валидации.

#### 2026-05-18 (Part 13 — LessonBlock DELETE guard: salary history integrity)
- ✅ **Guard in DELETE /schedule/:id** — добавлена проверка `teacherPaymentLesson.count` перед транзакцией. Если у любой сессии блока есть запись выплаты → 409 `BLOCK_HAS_PAYMENT_HISTORY`. Файл: `server/src/routes/schedule.ts`.
- ✅ **Frontend toast** — `SlotPanel.tsx` теперь показывает `toast.error` с русским сообщением при 409 вместо raw `alert`. Файл: `client/src/components/schedule/SlotPanel.tsx`.
- ✅ **Data repair script** — создан `server/src/scripts/repair-orphan-payments.ts` для удаления осиротевших `TeacherPayment` (без `TeacherPaymentLesson` ссылок). Запускается вручную с `DRY_RUN=false SCHOOL_ID=N npx tsx`.
- **Причина:** удаление LessonBlock вручную зачищало `TeacherPaymentLesson` строки, оставляя `TeacherPayment` с суммой но без ссылок. После пересоздания блока новые сессии считались неоплаченными — UI показывал некорректное сальдо.

#### 2026-05-19 (Part 14 — Temporal block versioning: split on teacher/config change)
- ✅ **Schema: `parentBlockId`** — добавлено поле `Int?` в `LessonBlock` с self-referential FK (`BlockVersionChain`). Позволяет отслеживать цепочку версий блока. Миграция: `20260519000000_add_parent_block_id`.
- ✅ **Backend: `PUT /schedule/:id` split** — добавлен параметр `applyFrom: string` (ISO дата). Если передан: закрывает старый блок (`endDate = day before applyFrom`), чистит будущие UPCOMING сессии через `cleanupInvalidSessions`, создаёт дочерний блок (`parentBlockId = oldId, startDate = applyFrom`), генерирует новые сессии. Возвращает `{ split: true, newBlockId }`. Без `applyFrom` — прежнее поведение in-place. Файл: `server/src/routes/schedule.ts`.
- ✅ **Backend: `GET /sessions/week` historical teacher** — для COMPLETED/LOCKED сессий без explicit substitute теперь возвращается `teacherIdSnap` как `teacher` (batch lookup через `staffProfile`). Новый флаг `isHistoricalTeacher: boolean`. Исправляет: после смены учителя блока COMPLETED сессии показывали нового учителя вместо исторического.
- ✅ **Frontend: `useSchedule` — `isHistoricalTeacher`** — `loadWeekSessions` обрабатывает `isHistoricalTeacher` флаг и сохраняет историческое имя учителя в `weekSessions`. Файл: `client/src/hooks/useSchedule.ts`.
- ✅ **Frontend: `EditGroupPanel` split dialog** — при клике "Сохранить" из контекста конкретного урока (передаётся `currentDate`) показывается диалог: "С [date] (рекомендуется)" → split, "Ко всем урокам блока" → in-place. `GroupRow` передаёт `currentDate = weekDatesInTz(wk, tz)[ci]` в панель. Файл: `client/src/components/schedule/SlotPanel.tsx`.
- **Архитектурный смысл:** `LessonBlock` стал темпоральным объектом — как `SchoolSchedulePolicy`. Редактирование с определённой даты не разрушает историю. COMPLETED сессии всегда отображают фактического учителя (через `teacherIdSnap`), а не текущего учителя блока.

#### 2026-05-19 (Part 15 — Fix: salary sync after block split)
- ✅ **`salary.ts` `countLessonsForStaff`** — изменён фильтр `status: { not: 'CANCELLED' }` → `status: { notIn: ['CANCELLED', 'INVALIDATED'] }`. До исправления INVALIDATED сессии (созданные при split старого блока) попадали в счётчик уроков учителя, из-за чего расчётный лист показывал будущие уроки за учителем, которого уже сменили. Файл: `server/src/routes/salary.ts`.
- ✅ **`schedule.ts` `teacher-lesson-calendar-admin`** — добавлен фильтр `status: { not: 'INVALIDATED' }` в запрос сессий. INVALIDATED сессии больше не отображаются в календаре учителя как "план", не попадают в `payableLessons` и не могут быть выплачены. Файл: `server/src/routes/schedule.ts`.
- **Причина:** при split блока (смена учителя с определённой даты) старые UPCOMING сессии переходят в статус INVALIDATED, но salary.ts их не исключал — старый учитель продолжал числиться с уроками которых у него уже нет.

#### 2026-05-19 (Part 17 — Warning system hardening: integrity scanner + ConflictWarningModal + WeekGrid badge)
- ✅ **Override flags fix (POST/PUT /schedule)** — `overrideTeacherConflict` и `overrideStudentConflict` не передавались из тела запроса в `validateScheduleBlock()`. Оба обработчика (POST и PUT) деструктурировали только `overrideCabinetConflict`. Исправлено: добавлены в destructuring и в вызов валидации. Файл: `server/src/routes/schedule.ts`.
- ✅ **Conflict detection: same-teacher Grammar+Club overlap** — `scheduleValidation.ts` check 5 (teacher conflict) пропускал блоки одного `studentGroupId` безусловно через `continue`. Теперь `continue` только если дни НЕ пересекаются — если учитель ведёт Grammar и Club в одни и те же дни, конфликт выбрасывается.
- ✅ **Conflict detection: student double-booking (Check 6)** — добавлена новая проверка в `validateScheduleBlock`: при наличии `studentGroupId` ищет sibling-блоки той же группы и выбрасывает `STUDENT_CONFLICT_WARNING` при пересечении по времени, дням и датам.
- ✅ **Integrity scanner Check 11 (teacher double-booking)** — `consistencyCheckService.ts`: постфактум-проверка всех активных `LessonBlock` на одного учителя в двух overlapping блоках одновременно. Severity: CRITICAL. Использует `timeRangesOverlap + daysOverlap + dateRangesOverlap` из `scheduleValidation.ts`.
- ✅ **Integrity scanner Check 12 (student double-booking)** — `consistencyCheckService.ts`: постфактум-проверка Grammar+Club одной группы (`studentGroupId`) на пересечение по времени/дням/датам. Severity: WARNING.
- ✅ **GET /api/v1/schedule/integrity** — новый endpoint для OWNER/ADMIN/SUPERADMIN (`analytics:read`). Вызывает `runChecks(schoolId)` и возвращает `{ violations: Violation[] }`. Файл: `server/src/routes/schedule.ts`.
- ✅ **ConflictWarningModal** — новый компонент `client/src/components/schedule/ConflictWarningModal.tsx`. Заменяет все 7 конфликтных `window.confirm()` в SlotPanel (CAPACITY_WARNING, STUDENT_CONFLICT_WARNING, TEACHER_CONFLICT_WARNING) на styled modal с ⚠ иконкой и настраиваемой кнопкой подтверждения.
- ✅ **WeekGrid conflict badge** — функция `detectCellConflict(groups, ci)` в `WeekGrid.tsx`: определяет конфликт учителя (один `tgId`/`tkId` в 2+ группах) или студента (один `studentGroupId` в 2+ группах). Рендерит ⚠ badge в правом верхнем углу ячейки с tooltip.

#### 2026-05-19 (Part 16 — P0 Reliability: race conditions + tenant isolation)
- ✅ **Оптимистичная блокировка (PATCH teacher/details/status)** — в трёх `PATCH /session/:id/...` эндпоинтах `version` теперь передаётся в `WHERE` условие `prisma.lessonSession.update`. Prisma P2025 (запись не найдена) перехватывается и возвращается **409 STALE_DATA**. Ранее `version` проверялся до `update` в отдельном запросе — TOCTOU-окно позволяло двум клиентам одновременно перезаписать данные сессии. Файл: `server/src/routes/schedule.ts`.
- ✅ **SELECT FOR UPDATE в submit-attendance и PATCH attendance** — в начале каждой per-student транзакции добавлена `SELECT id FROM "StudentProfile" WHERE id = $id FOR UPDATE`. Сериализует конкурентные кредитные операции на уровне строки БД: второй запрос ждёт завершения первого, затем видит `creditDeducted=true` и пропускает списание. Предотвращает двойное списание кредитов при одновременной отправке посещаемости. Файл: `server/src/routes/schedule.ts`.
- ✅ **Защита удаления блока перенесена внутрь транзакции** — проверка `teacherPaymentLesson.count > 0` перемещена как первая операция внутрь `$transaction`. Ранее проверка выполнялась до начала транзакции — конкурентный `POST /salary/pay` мог создать платёжную ссылку в этом окне, транзакция затем её удаляла, создавая осиротевший `TeacherPayment`. Файл: `server/src/routes/schedule.ts` DELETE `/:id`.
- ✅ **LessonCreditLog при удалении блока — по одной записи на сессию** — рефанд-логи при удалении блока теперь создают отдельную запись `LessonCreditLog` (с `sessionId`) для каждой посещаемости, а не одну агрегированную запись на студента. Кредиты по-прежнему батчем инкрементируются на студента (эффективность), но аудиторский след теперь отслеживаем по сессии. Файл: `server/src/routes/schedule.ts`.
- ✅ **Tenant isolation: GET /session/:id/attendance** — добавлена проверка владения сессией (`schoolId`) перед возвратом данных посещаемости. Ранее любой авторизованный пользователь мог прочитать посещаемость чужой школы по ID сессии. Файл: `server/src/routes/schedule.ts`.
- ✅ **Tenant isolation: PATCH /session/:id/attendance** — добавлен `schoolId` в `findFirst` при поиске сессии. Закрывает перекрёстную запись между тенантами. Файл: `server/src/routes/schedule.ts`.
- ✅ **Tenant isolation: GET /credits/history/:studentProfileId** — добавлена проверка принадлежности профиля школе через `user.schoolId`. Ранее студент из другой школы мог запросить историю кредитов по прямому ID. Файл: `server/src/routes/credits.ts`.
- ✅ **Tenant isolation: DELETE /salary/adjustment/:id и DELETE /manual-entry/:id** — перед удалением добавлен `findFirst({ id, schoolId })`. Ранее любой OWNER мог удалить чужую запись по прямому ID. Файл: `server/src/routes/salary.ts`.
- ✅ **Self-healing batch атомарен** — три `prisma.lessonSession.updateMany` для `teacherIdSnap`, `cabinetIdSnap`, `startTimeSnap/endTimeSnap` объединены в `prisma.$transaction([...])` array-форму. При падении сервера в середине батча snapshots не будут частично обновлены. Файл: `server/src/services/sessionService.ts` `syncSessionsForBlock`.
- ✅ **Дедупликация makeup-сессий** — `POST /session/:id/makeup` теперь внутри транзакции проверяет наличие активной (не CANCELLED) makeup-сессии для того же оригинала. Конкурентные двойные клики возвращают **409 MAKEUP_ALREADY_EXISTS**. Новая makeup допускается только после отмены предыдущей. Файл: `server/src/routes/schedule.ts`.
- ✅ **bulk-cancel явная проверка роли** — `POST /sessions/bulk-cancel` теперь явно проверяет `role !== 'OWNER' && role !== 'ADMIN'` → 403. Заменяет `requirePermission('schedule:write')`, который не отражал ограничение state machine (UPCOMING→CANCELLED только OWNER/ADMIN). Файл: `server/src/routes/schedule.ts`.

#### 2026-05-19 (Part 18 — Availability-Driven UI: TeacherAvailabilitySelect)
- ✅ **TeacherAvailabilitySelect** — новый компонент `client/src/components/schedule/TeacherAvailabilitySelect.tsx`. Кастомный dropdown заменяющий нативный `<select>` для выбора учителя. Показывает для каждого учителя: 🟢 свободен (нет блоков в это время+дни), 🟡 занят в другое время, 🔴 конфликт (есть блок на тех же днях+времени). Статусы вычисляются на клиенте из `sched.G` без API-запросов. Реактивно пересчитывается при изменении выбранных дней.
- ✅ **EditGroupPanel + createGroup** — заменены 4 нативных `<select>` учителей (Grammar+Club в edit форме, Grammar+Club в create форме) на `TeacherAvailabilitySelect`. `EditGroupPanel` получил новый проп `schedGroups: Record<string, SchedGroup>`, который передаётся из `GroupRow` через `sched.G`. Файл: `client/src/components/schedule/SlotPanel.tsx`.
- **Паттерн**: availability-driven вместо validation-driven — конфликт виден ДО сохранения, не после.

#### 2026-05-19 (Part 19 — Smart Schedule UX: Centralized Conflict Engine + Live Prevention)
- ✅ **`scheduleConflicts.ts`** — новый централизованный движок конфликтов `client/src/utils/scheduleConflicts.ts`. Единственный источник правды для всей conflict logic: `findCabinetConflicts`, `findTeacherConflicts`, `findStudentGroupConflicts`, `checkCapacity`, `getConflictSeverity`. Все компоненты (SlotPanel, TeacherAvailabilitySelect, WeekGrid) импортируют только отсюда. Никакой дублирующей логики в компонентах.
- ✅ **Live cabinet conflict** — SlotPanel: при изменении `cabinetId` или дней мгновенно отображается inline-блок с деталями конфликта (`⛔ Кабинет занят: Группа · Пн Ср · 08:00–09:15`). Кнопка Save заблокирована при `hasCriticalConflict`.
- ✅ **Live teacher conflict** — SlotPanel: при выборе занятого учителя Grammar/Club под select показывается inline-блок конфликта. `TeacherAvailabilitySelect` показывает `conflict` учителей как `disabled` (нельзя выбрать), `busy-elsewhere` как предупреждение.
- ✅ **Live student group conflict** — SlotPanel: при выборе группы с пересечением по дням+времени показывается цветной конфликт (critical = красный, warning = оранжевый).
- ✅ **Free cabinet chips** — при конфликте кабинета под сообщением появляются кнопки-чипы свободных кабинетов того же слота. Один клик переключает выбор.
- ✅ **Cross-slot suggestions (Этап 3.1)** — при наличии критического конфликта SlotPanel автоматически перебирает все слоты школы и показывает топ-3 альтернативных слота где кабинет + учители + группа все свободны.
- ✅ **WeekGrid capacity** — `checkCapacity` подключён к `RoomBlock`: ⚠ badge + цветная надпись `студ/кап` при перегрузе (красный) и близости к лимиту (оранжевый). Hover tooltip с деталями группы.
- ✅ **53 unit-теста** — `client/src/utils/scheduleConflicts.test.ts`: покрытие time overlap algorithm, days intersection, edit mode excludeIds, capacity thresholds, teacher conflicts (critical vs warning), student group conflicts, getConflictSeverity aggregator, edge cases, zero-padding safety, suggestion engine safety.
- **Архитектурный принцип**: сдвиг валидации ДО нажатия Save. Система не сообщает об ошибке — она не даёт ошибке возникнуть. Все проверки клиентские из `sched.G` (уже загружены), без дополнительных API-запросов.

#### 2026-05-23 (Part 20 — SlotPanel split wiring: real block ids)
- ✅ **Frontend block-id helpers** — `scheduleTypes.ts` теперь экспортирует `grammarBlockIdOf`, `clubBlockIdOf`, `relatedBlockIdsOf`, `lessonBlockIdForDay`. `GroupRow`, `EditSessionPanel`, `EditGroupPanel`, `RoomBlock`, `RoomsView` и `useSchedule.getGroupsInCell()` используют реальные `grammarBlockId`/`clubBlockId` для замен, отмен, `weekSessions`, посещаемости и проверки конфликтов. Это убирает регрессию после разделения `SlotPanel`, когда код местами продолжал считать `group.id` id конкретного `LessonBlock`.
- ✅ **Docs contract** — `SCHEDULE_UI_CONTRACT.md` и `FRONTEND_STATE_RULES.md` зафиксировали правило: `SchedGroup.id` является id UI-строки, а session-scoped операции должны резолвить настоящий `LessonBlock.id` через helpers.

#### 2026-05-24 (Phase 10 — Permissions / Security / Enterprise Readiness)
- ✅ **Centralized permission model** — `lib/permissions.ts`: добавлены `finance:void`, `finance:refund`, `salary:pay`, `salary:read`, `salary:write`, `groups:archive`, `data:import`. OWNER+SUPERADMIN получают все. ADMIN — только `salary:read` + `salary:write`. Файл: `server/src/lib/permissions.ts`.
- ✅ **`salary.ts` рефакторинг** — удалён `isAdminOrOwner()`. Выплаты (`POST /pay/:staffProfileId`, `DELETE /pay/:paymentId`, `PATCH /rate/:staffProfileId`) → `requirePermission('salary:pay')`. Просмотр/корректировки → `salary:read`/`salary:write`. Аудит-событие `SALARY_PAY` → `logFinanceAction()`. Файл: `server/src/routes/salary.ts`.
- ✅ **`groups.ts` рефакторинг** — lifecycle pause/resume → `requirePermission('schedule:write')` (ADMIN+OWNER). Lifecycle complete/archive/restore, DELETE группы, `promote` → `requirePermission('groups:archive')` (OWNER only). Файл: `server/src/routes/groups.ts`.
- ✅ **`importexport.ts` рефакторинг** — `/import/preview` и `/import/apply` → `requirePermission('data:import')`. Удалён `requireAdminOrOwner` helper. Аудит-события `BULK_IMPORT_STUDENTS` / `BULK_IMPORT_TEACHERS`. Файл: `server/src/routes/importexport.ts`.
- ✅ **Inline-проверки ролей заменены** — `schedule.ts` (`bulk-cancel`, `fix-block-days`), `schools.ts` (`PUT /current/me`), `parent.ts` (3 эндпоинта) — все переведены на `requirePermission()`. Файлы: соответствующие route-файлы.
- ✅ **`GET /admin/audit-log`** — новый endpoint с пагинацией (limit ≤ 100), фильтрами `entityType`, `action`, `actorId`, `dateFrom`, `dateTo`. SchoolId изоляция. Права: `users:manage`. Файл: `server/src/routes/admin.ts`.
- ✅ **`usePermissions.ts`** — исправлен `canPaySalary` (было ADMIN+OWNER, стало OWNER+SUPERADMIN). Добавлены `canImport` и `canArchiveGroup`. Файл: `client/src/hooks/usePermissions.ts`.
- ✅ **Frontend guards** — `ImportExport.tsx`: блок «Нет доступа к импорту» для ADMIN. `GroupDetail.tsx` + `GroupActionModal.tsx`: кнопки Завершить/Архивировать/Удалить скрыты от ADMIN через проп `canArchiveGroup`.
- ✅ **276/276 тестов** — `phase10Permissions.test.ts`: 20 тестов permission-модели, пагинации аудит-лога, фильтра по entityType, tenant isolation. Файл: `server/src/__tests__/integration/phase10Permissions.test.ts`.

#### 2026-05-30 (PR 1 — Reschedule UI: Change Time / Cabinet)

- ✅ **`RescheduleModal.tsx`** — новый компонент `client/src/components/schedule/RescheduleModal.tsx`. Модалка для изменения времени начала/окончания и кабинета текущего урока (тот же календарный день). Поля: `startTime`, `endTime`, `cabinetId` (select), `reason` (≥5 символов, обязательно). Обрабатывает конфликты: `TEACHER_CONFLICT_WARNING` и `CAPACITY_WARNING` через `ConflictWarningModal` с возможностью override. Обрабатывает `STALE_DATA` (409) через toast + закрытие. Вызывает `PATCH /api/v1/schedule/session/:id/reschedule`.
- ✅ **`EditSessionPanel.tsx`** — добавлены props `slotStart?`/`slotEnd?` (fallback при `startTimeSnap === null`); state `sessionStartTime`/`sessionEndTime` (заполняются из `/session/ensure` ответа); кнопка «Изменить время / кабинет» (видна только при `status !== 'CANCELLED' && status !== 'LOCKED'`); интеграция `RescheduleModal` с `onSuccess` callback — обновляет `sessionVersion`, `sessionStartTime/EndTime`, `cabinetId`, вызывает `onSessionUpdated` и `onReload`.
- ✅ **`GroupRow.tsx`** — `slotStart`/`slotEnd` теперь проксируются в `EditSessionPanel`.
- ✅ **Архитектурное ограничение задокументировано** — кнопка «Изменить время / кабинет» намеренно НЕ называется «Перенести урок», т.к. изменение даты не поддерживается текущим `rescheduleSession()`. Смена даты — Cancel + Makeup (PR 6 / будущий RFC §PR4b).
- ✅ **TypeScript clean** — `tsc --noEmit` = 0 ошибок (client + server). Vite build green.
- **Canonical scope:** только `schedule/` (v1). `schedule2/` не тронут.

#### 2026-06-10 (Schedule Final Hardening — Group Lifecycle Policy P2)
- ✅ **groupLifecyclePolicy.ts** — новый `server/src/lib/groupLifecyclePolicy.ts` — единственный источник правды для разрешений на действия с группой. Pure function, никаких вызовов БД. Тип `GroupAction` покрывает 16 операций: edit:metadata, edit:maxStudents, edit:level-chapter, edit:schedule, add/remove:students, submit:attendance, create:makeup, change:teacher, reschedule, lifecycle:pause/resume/complete/archive/restore, promote. `assertGroupAction()` бросает `GroupLifecycleError` с кодом и `statusCode=422`.
- ✅ **Policy matrix** — ACTIVE: все мутации разрешены. PAUSED: только `edit:metadata` + `lifecycle:resume`. COMPLETED: только `edit:metadata` (name) + `lifecycle:archive`. maxStudents явно заблокирован для COMPLETED. ARCHIVED (deletedAt≠null): только `lifecycle:restore`.
- ✅ **Backend guards** — `groups.ts` `PUT /:id`: per-field проверки через `assertGroupAction`. `groups.ts` `DELETE /:id/students/:id`: использует `assertGroupAction(group, 'remove:students')`. `groupLifecycleService.ts`: `assertCanChangeLevelChapter` и `assertGroupOperationallyActive` делегируют в policy. `schedule.ts`: `isInactiveGroup` делегирует в policy; два attendance-check переписаны на `canPerformGroupAction(..., 'submit:attendance')`. `scheduleLifecycleService.ts`: guards добавлены в `replaceTeacher`, `rescheduleSession`, `createMakeupSession`.
- ✅ **UI alignment** — `GroupDetail.tsx`: status select удалён из edit-формы. Level select удалён (level меняется только через promote flow). maxStudents скрыт для PAUSED/COMPLETED. Кнопки «Повысить уровень», chapter ±1, «Добавить студента», ×-студента — disabled/hidden по статусу группы. Banner-предупреждение в edit-форме для COMPLETED/PAUSED.
- ✅ **Тесты** — Unit: `groupLifecyclePolicy.test.ts` — 74 теста (матрица ACTIVE/PAUSED/COMPLETED/ARCHIVED × все actions + exhaustiveness). Integration: `groupLifecyclePolicyGuards.test.ts` — 12 тестов (HTTP guards на PUT /groups, POST/DELETE students, createMakeupSession, replaceTeacher, rescheduleSession). Фикс моков `makeRescheduleClient` и `makeMakeupClient` — добавлены `status: 'ACTIVE', deletedAt: null`.
- **Файлы:** `server/src/lib/groupLifecyclePolicy.ts` (новый), `server/src/services/groupLifecycleService.ts`, `server/src/services/scheduleLifecycleService.ts`, `server/src/routes/groups.ts`, `server/src/routes/schedule.ts`, `client/src/pages/dashboard/admin/GroupDetail.tsx`, тесты.

*Last Updated: 2026-06-26 (Salary: payable-session guard requires attendance; default rate 500)*

#### 2026-06-26 (Salary — payable session requires attendance + default rate 500)
- ✅ **«Оплачиваемый урок» = COMPLETED/terminal + attendance** — определение разъехалось в 3 местах: `countLessonsForStaff` брал `status:'COMPLETED'` БЕЗ attendance (вопреки собственному комментарию и тесту), гард выплаты отклонял только `CANCELLED/INVALIDATED`, `allPayableCount` — `status notIn [...]` без attendance. Сведено к единой константе `PAYABLE_SESSION = { status: { notIn: ['CANCELLED','INVALIDATED'] }, attendances: { some: {} } }`, переиспользована во всех трёх. Теперь backend не может посчитать/оплатить урок без отмеченной посещаемости; `LOCKED` с attendance корректно засчитывается. Файл: `server/src/routes/salary.ts`.
- ✅ **UI списка зарплат — остаток вместо валовой net** — карточка показывала `staff.net`/`lessonsCount`, из-за чего после частичной выплаты «Ожидает» оставалось равно полной сумме. Переключено на уже отдаваемые backend поля `remainingAmount`/`unpaidLessonsCount`. Файл: `client/src/pages/dashboard/admin/Salary.tsx`.
- ✅ **Default ставка 500** — учитель без настроенной ставки (`salaryRate = null`, нет rate-log) резолвится в `DEFAULT_SALARY_RATE = 500`, а не 0. Покрывает и существующих учителей без ставки (без миграции). Явный `0` остаётся 0 («настроен бесплатным»). Глобальная константа — при необходимости разных дефолтов по школам выносится в School settings.
- ✅ **Тест дёргает production-функцию** — `salaryAttribution.test.ts` больше не дублирует логику счёта, а импортирует боевой `countLessonsForStaff`, поэтому будущий дрейф определения «оплачиваемого урока» падает в тесте. 3 suite / 34 теста зелёные (salaryAttribution, salaryConsistency, salaryCorrectionFlow).

#### 2026-06-16 (Student Archive — show soft-deleted)
- ✅ **Архив показывает и soft-deleted студентов** — `?archived=true` теперь возвращает записи с `archivedAt != null` ИЛИ `deletedAt != null`, чтобы аккаунт не исчезал после clear-data / удаления. Сортировка `deletedAt desc, archivedAt desc`. `unarchive` восстанавливает обе метки (`User.archivedAt`, `User.deletedAt`, `StudentProfile.deletedAt`) в транзакции; soft-deleted группы не воскрешаются. UI различает «Удалён» / «Архивирован». Тест `studentArchiveView.test.ts`. Файлы: `routes/students.ts`, `pages/dashboard/admin/Students.tsx`.

#### 2026-06-15 (Import — group lookup scoped by cabinet)
- ✅ **Импорт студентов: фикс схлопывания групп** — при зачислении по кабинету+времени поиск существующей `StudentGroup` шёл по `blocks.some({ timeSlotId })` без `cabinetId`. `TimeSlot` общешкольный (один слот делят все кабинеты), поэтому все кабинеты с одинаковым временем сливались в одну группу → все импортируемые студенты попадали в один кабинет/одну группу. Теперь поиск идёт по `timeSlotId + cabinetId (+ level)`, и Step-2 (миграция по старому имени) исключает имя без времени. Проверено изолированным тестом: 4 разные комбинации кабинет×время×уровень → 4 разные группы. Коммит `2a9f45fe`. Файл: `server/src/routes/importexport.ts`. **Замечание:** фикс предотвращает схлопывание только на чистых данных — уже схлопнутые группы «липкие» (повторный импорт реюзает существующую группу по её блокам), поэтому перед переимпортом битые данные надо чистить.

#### 2026-06-15 (Student Archive)
- ✅ **Student Archive** — добавлено поле `User.archivedAt DateTime?` + индекс `(schoolId, role, archivedAt)`. `GET /students` по умолчанию возвращает только `archivedAt: null`; `?archived=true` возвращает архив. Новые эндпоинты: `PATCH /students/:id/archive` и `PATCH /students/:id/unarchive`. На фронте: кнопка "Архив" в хедере страницы студентов, кнопка архива в модале профиля, просмотр архива с поиском и кнопкой "Восстановить". Данные студента (посещения, кредиты, зарплата) не затрагиваются. Файлы: `schema.prisma`, `routes/students.ts`, `pages/dashboard/admin/Students.tsx`, `components/schedule/StudentProfileModalLoader.tsx`, `pages/dashboard/admin/GroupDetail.tsx`.

#### 2026-06-15 (Part — Finalize Settings Policy: effectiveFrom + conflict control)

#### 2026-06-15 (Part — Finalize Settings Policy: effectiveFrom + conflict control)
- ✅ **getNextMondayDateInTz** (`server/src/lib/tzUtils.ts`) — вычисляет следующий понедельник в таймзоне школы (UTC Date + dateStr YYYY-MM-DD). Если сегодня понедельник — перешагивает на следующий (+7). Timezone-aware через `date-fns-tz`.
- ✅ **getFirstWorkingDateStr** (`server/src/services/policyService.ts`) — находит первый рабочий день нового расписания начиная с `nextMondayStr` по новым `activeDays`. Схема: 0=Пн…6=Вс. Пример: если Пн (0) исключён из activeDays, возвращает вторник.
- ✅ **computePolicyImpact** (policyService.ts, переписан) — чисто читающая функция. Принимает `policyEffectiveFrom?: Date` (default=now) и `workStart/workEnd`. Возвращает: `{ removedDays, sessionsOutsideDays, sessionsOutsideHours, blocksOutsideDays, blocksOutsideHours, affectedBlockIds, policyEffectiveFrom, firstWorkingDate }`. Никаких мутаций — только информация.
- ✅ **PATCH /settings** (routes/settings.ts) — больше не вызывает `invalidateSessionsForRemovedDays`. Создаёт `SchoolSchedulePolicy` с `effectiveFrom = nextMonday`. Возвращает `{ policyEffectiveFrom, firstWorkingDate, policyImpact }` клиенту.
- ✅ **GET /settings/policy-impact** — возвращает полный impact включая `policyEffectiveFrom`, `firstWorkingDate`, `affectedBlockIds`. Считает от nextMonday вперёд.
- ✅ **CrmSettings.tsx** — пре-сейв модал всегда показывается при сохранении настроек расписания. Отображает: дату вступления в силу (DD.MM.YYYY), первый рабочий день, счётчики конфликтов, синий блок «Система не перенесёт и не отменит занятия автоматически».
- ✅ **PolicyConflictsPanel.tsx** (полная перезапись) — экспортирует `PolicyConflictAction` discriminated union. Кнопки: «Открыть занятие», «Перенести», «Отменить» (danger) для сессий; «Редактировать группу» для блоков. «Скрыть на сейчас» = локальный dismiss (state), сбрасывается при следующем обновлении. `onAction?: (a: PolicyConflictAction) => void` проп.
- ✅ **Schedule.tsx** — `handlePolicyConflictAction` обрабатывает все action types: для session-actions навигирует на неделю с уроком через `setViewWk`; для block-action показывает toast. Проброшен `onAction` в `PolicyConflictsPanel`.
- ✅ **EditGroupPanel.tsx** — добавлен `timeSlots?: TimeSlotOption[]` проп. Dropdown выбора тайм-слота (показывается только если >1 слота). При смене слота обновляет `selectedSlotId/Start/End` в стейте. Все `useMemo` конфликт-проверок и `TeacherAvailabilitySelect` используют `selectedSlotStart/End` вместо пропов. Предупреждение при изменении слота.
- ✅ **GroupRow.tsx** + **SlotPanel.tsx** — пробрасывают `timeSlots={sched.slots}` в `EditGroupPanel`.
- ✅ **Тесты** (`server/src/__tests__/integration/policyEffectiveDate.test.ts`) — 21 тест: `getNextMondayDateInTz` (5), `getFirstWorkingDateStr` (6), no-mutate guarantee (5), response shape (5). Все 34 теста в `policyInvalidation.test.ts` и `policyEffectiveDate.test.ts` PASS.
- **Инвариант:** PATCH /settings НИКОГДА не мутирует сессии. `invalidateSessionsForRemovedDays` сохранена для admin-repair только.

#### 2026-06-14 (fix: historical slot poisoning in reloadSchedule)
- ✅ **"архив" на активных слотах — root cause fix** — `Schedule.tsx: reloadSchedule`. Причина: `reloadSchedule` передавал `date: viewWkRef.current` в `GET /settings/timeslots`. При исторической неделе ответ содержал исторические слоты (старая политика 08:00/60-min, sequential IDs 1-N). `loadFromServer(blocks, historicalSlots)` не находил `timeSlotId=171` среди historicalSlots, создавал синтетический id=12/13 для блоков 22/23, перезаписывал `dbSlotIdMapRef`. Следующий `applySchedulePolicy` при переходе на неделю 15-21 июня маппил `"01:20|02:40"→12` из испорченного ref → `legacySlotIds.includes(12)=true` → "архив". Fix: два параллельных вызова — `GET /settings/timeslots` (без даты, текущая политика) → только в `loadFromServer`; `GET /settings/timeslots?date=viewWkRef.current` → только в `applySchedulePolicy` + `setPolicyIsHistorical`. `dbSlotIdMapRef` теперь никогда не содержит синтетических IDs из исторических политик.

#### 2026-06-10 (P0 Architecture Closure — Phases 1–5)
- ✅ **Phase 1 — Effective Teacher SOT** — `getEffectiveSessionTeacherId(session)` в `sessionService.ts`: единственный канонический путь для разрешения фактического преподавателя сессии. `isManualTeacher=true` → `teacherId` (ручная замена), иначе → `teacherIdSnap` (снимок на момент создания). Самоисцеление teacherIdSnap при `syncSessionsForBlock` уже существовало (строки 438–464).
- ✅ **Phase 2 — Working Date SOT** — `validateSessionDate` теперь проверяет `ScheduleException` (DB-backed) через `getActiveExceptions` + `isDateExcepted`, **в дополнение** к legacy `settings.holidays`. `ensureSingleSession` передаёт `blockContext` (teacherId, cabinetId, groupId) в validation — единый путь для cron и on-demand. Файлы: `sessionService.ts`.
- ✅ **Phase 3 — SessionStudent Roster Amendment Policy** — новый `rosterService.ts` с двумя каноническими функциями: `reconcileRosterOnMemberAdd` добавляет студента только в UPCOMING сессии, `reconcileRosterOnMemberRemove` удаляет из UPCOMING без attendance, защищает сессии с существующей Attendance. `groups.ts` делегирует в rosterService — нет inline-логики в route handlers.
- ✅ **Phase 4 — Block State Machine** — новый `blockStateMachine.ts`: `canBlockTransition` (role-gated transitions), `blockAllowsSessionGeneration`, `blockGenerationBlocker`. `syncSessionsForBlock` жёстко блокирует COMPLETED/CANCELLED блоки. `extendAllBlockSessions` запрашивает только `status='UPCOMING'`.
- ✅ **Phase 5 — Immutable Audit Trail** — `ScheduleActionLog.blockId` и `.sessionId` FK изменены с `onDelete: Cascade` на `onDelete: SetNull` (schema.prisma + migration `20260610120000_audit_log_set_null_on_delete`). Audit log строки переживают hard-delete блока/сессии — `blockId`/`sessionId` становятся NULL, запись сохраняется. Применено к dev и test БД.
- **Файлы:** `server/src/services/sessionService.ts`, `server/src/services/rosterService.ts` (новый), `server/src/lib/blockStateMachine.ts` (новый), `server/src/routes/groups.ts`, `server/prisma/schema.prisma`, `server/prisma/migrations/20260610120000_audit_log_set_null_on_delete/`.
- **Тесты:** 38 тестов (6 файлов): `effectiveTeacherSOT.test.ts` (5), `blockStateMachine.test.ts` (16), `rosterService.test.ts` (7), `workingDateSOT.test.ts` (4), `blockGenerationGuard.test.ts` (4), `auditTrailPreservation.test.ts` (3). Все PASS.


#### 2026-05-16 (Part 12 — Churn alerts, Waitlist auto-promotion, Archive cron, Parent role)
- ✅ **Churn prediction** — `churnService.ts`: ежедневный cron проходит по активным студентам каждой школы, если последние 3 посещаемости = ABSENT → `notifySchoolAdmins()` + `StudentProfile.atRiskSince = now()`. Дедупликация: не чаще 7 дней. Сброс флага при возвращении студента. Порог: `CHURN_THRESHOLD = 3`.
- ✅ **Waitlist auto-promotion** — `waitlistService.ts`: при удалении студента из группы (`DELETE /groups/:id/students/:studentProfileId`) вызывается `tryPromoteWaitlist()` — находит старейшую PENDING заявку с учётом `expiresAt`, авто-одобряет, создаёт `GroupMembership`, добавляет в снапшоты сессий, уведомляет студента. `EnrollmentRequest` получил поля `priority Int` и `expiresAt DateTime?`. Cron ежедневно чистит просроченные заявки.
- ✅ **Удаление студента теперь обновляет GroupMembership** — `DELETE /groups/:id/students/:studentProfileId` ранее делал только `disconnect`. Теперь в транзакции: `disconnect` + `GroupMembership.status = WITHDRAWN, leftAt = now()`.
- ✅ **Archive cron** — `archiveService.ts`: ежемесячный cron агрегирует `Attendance` старше 90 дней → `AttendanceMonthlySummary` (year/month/student: attended/absent/late/creditsDeducted) → перемещает в `AttendanceArchive` → удаляет из горячей таблицы. Ratio сжатия ~120:1. Upsert-safe (повторный запуск идемпотентен).
- ✅ **Parent role** — новый enum `Role.PARENT`. Модели: `ParentProfile (userId, schoolId)`, `ParentChild (parentProfileId, studentProfileId)`. Маршруты `/api/v1/parent/`: `POST /create` (admin создаёт родителя), `POST /:id/link` (привязка доп. ребёнка), `GET /` (список родителей), `GET /me/children`, `GET /me/children/:id/attendance`, `GET /me/children/:id/schedule`. Фронт: `ParentDashboard.tsx` — портал родителя с карточками детей, расписанием и посещаемостью. Маршрут `/:slug/parent/dashboard`.
- ✅ **isAtRisk в Students** — API `/students` теперь возвращает `atRiskSince`. Фронт: иконка AlertCircle у имени + новый фильтр «Риск ухода» в стат-полосе на странице Students.
- **Schema migration:** `20260516000000_churn_waitlist_archive_parent` — добавлены поля `StudentProfile.atRiskSince`, `EnrollmentRequest.priority/expiresAt`, таблицы `AttendanceMonthlySummary`, `ParentProfile`, `ParentChild`, enum `PARENT`.

#### 2026-05-24 (Part 23 — Phase 7.2: Credit Issuance from Paid Tuition Invoices)
- ✅ **`CreditIssuance` model** — `server/prisma/schema.prisma`: новая модель с идемпотентным ключом `@@unique([paymentAllocationId, invoiceLineId])`. Back-relations добавлены в `School`, `StudentProfile`, `LessonCreditLog`, `InvoiceLine`, `PaymentAllocation`, `User`. Migration `20260524020000_phase7_2_credit_issuance`.
- ✅ **`creditIssuanceService.ts`** — `issueCreditsForAllocation` (пропорциональный floor + reconcile при PAID + zero-noise + re-read alreadyIssued + clamp) и `reverseIssuancesForPayment` (reversal chain с LessonCreditLog CORRECTION). Write chain: `CreditIssuance → LessonCreditLog → StudentProfile.credits` в одной TX.
- ✅ **`paymentService.ts` интеграция** — `createAllocation` вызывает `issueCreditsForAllocation` после обновления инвойса; `voidPayment` вызывает `reverseIssuancesForPayment` после пересчёта paidAmount. `invoice.select` расширен `studentProfileId`.
- ✅ **Audit events** — `CREDITS_ISSUED_FROM_PAYMENT`, `CREDIT_ISSUANCE_REVERSED` в `ScheduleActionLog`.
- ✅ **Tests ×13** — `creditIssuance.test.ts`: все 13 сценариев green. Покрывает: proportional floor, non-TUITION, 50%/100%/3×1/3, idempotency, void reversal, LessonCreditLog types, Decimal-safe rounding, audit events.
- ✅ **Build clean** — `tsc --noEmit` = 0, `npm run build` = 0, 199/200 тестов green (1 pre-existing fail в `membershipSnapshot.test.ts` — FK guard, не связан с Phase 7.2).
- **⛔ PHASE 7.2 CLOSED.**

#### 2026-05-24 (Part 26 — Phase 8: Analytics / Reporting / Dashboards)
- ✅ **`financeAnalyticsService.ts`** — новый сервис `server/src/services/financeAnalyticsService.ts`. Функции: `getFinanceKPIs(schoolId, range, prev?)` — Invoice-based KPIs (collectedAmount, refundedAmount, refundRate, collectionRate, avgInvoiceValue, paidInvoiceCount, overdueInvoiceCount, totalOverdueOutstanding) через `Payment`, `PaymentRefund`, `Invoice` Phase 7 модели. `getReceivablesAging(schoolId, asOf)` — aging buckets 0–30/31–60/61–90/90+ дней через `listOverdueInvoices` из receivableService (source of truth, без дублирования формул).
- ✅ **`academicAnalyticsService.ts`** — новый сервис `server/src/services/academicAnalyticsService.ts`. Функции: `getStudentStatusCounts` (active/paused/frozen/total), `getGroupStatusCounts` (ACTIVE/PAUSED/COMPLETED/total), `getAcademicKPIs(schoolId, range)` — attendance rate + CANCELLED vs INVALIDATED sessions, avgCredits.
- ✅ **`GET /analytics/receivables-aging`** — новый endpoint (также `/stats/receivables-aging`). Возвращает `{ buckets: AgingBucket[], total: { count, amount }, asOf }`. Multi-tenant: scoped by `req.user.schoolId`.
- ✅ **`finance()` в analytics.ts обновлён** — добавлены invoice-based метрики через `getFinanceKPIs` и aging buckets через `getReceivablesAging` в response. Существующий P&L (income/expenses/profit) через `StudentPayment` и `Expense` оставлен (обратная совместимость).
- ✅ **`operations()` в analytics.ts обновлён** — добавлены academic KPIs из `getAcademicKPIs`: studentActive/Paused/Frozen/Total, groupActive/Paused/Completed, avgCredits, attendanceRate, sessionCancelled/Invalidated. Teacher heatmap переписан с N+1 → single batch query.
- ✅ **`teachers()` N+1 fix** — sessions, attendance и revenue теперь запрашиваются в 3 batch запроса (вместо 2N+N=3N запросов). `studentPayment.groupBy(studentProfileId)` покрывает revenue всех учителей одним запросом.
- ✅ **`FinanceTab.tsx` обновлён** — добавлены: 4 invoice KPI-карточки (собрано, возвращено, refund rate, collection rate), mini-stats блок (paid/overdue count, avg invoice value), секция aging с BarChart + 4 цветных bucket-карточки. Debtors table и income pie сохранены без изменений.
- ✅ **`OperationsTab.tsx` обновлён** — добавлены: academic KPI-карточки (студенты active/paused/frozen, avgCredits), group status (active/paused/completed), CANCELLED vs INVALIDATED session счётчики, прогресс-бар посещаемости. Все существующие charts сохранены.
- ✅ **Тесты ×23** — `analyticsServices.test.ts`: 8 тестов aging (all-zero, каждый bucket, multi-invoice, fully-paid excluded, cross-school isolation), 5 тестов finance KPIs (zero baseline, collectedAmount, refundedAmount+refundRate, collectionRate, cross-school), 5 тестов academic counts (student active/paused/frozen, cross-school), 2 group status, 3 attendance analytics (rate computation, CANCELLED vs INVALIDATED, zero baseline).
- ✅ **Build clean** — server `tsc` = 0, client `tsc -b && vite build` = 0, 247/247 тестов green.
- **⛔ PHASE 8 CLOSED.**

#### 2026-05-24 (Part 27 — Phase 9: Production Hardening)
- ✅ **CRITICAL: auth rate limits fixed** — `server/src/routes/auth.ts`: loginLimiter `max: 10000 → 10`, registerLimiter `max: 10000 → 100`. Было de-facto отключено (10k попыток за 15 мин = нет защиты).
- ✅ **Credit log pagination** — `GET /api/v1/students/me/credit-logs` теперь принимает `?page=&limit=` (limit ≤ 200, default 100). Response добавлен `meta: { total, page, limit, pages }`. Устраняет OOM риск при большом числе записей.
- ✅ **Env validation at startup** — `server/src/index.ts`: если `DATABASE_URL` не задан — сервер немедленно завершается с `process.exit(1)` и понятным сообщением (раньше давал криптичную Prisma ошибку позже).
- ✅ **`uncaughtException` / `unhandledRejection` handlers** — оба обработчика логируют через `bootLog.error` и завершают процесс (`process.exit(1)`), чтобы PM2/Docker реестарт сработал корректно.
- ✅ **`helmet` middleware** — установлен `helmet@^8` в `server/package.json`. Добавлен в `server/src/index.ts` перед CORS с `contentSecurityPolicy: false` (CSP — задача фронтенда). Закрывает X-Content-Type-Options, X-Frame-Options, HSTS и др. headers.
- ✅ **Correlation ID middleware** — `server/src/index.ts`: каждый запрос получает `x-request-id` UUID (из заголовка или генерируется). Пробрасывается в `res.setHeader` и в `bootLog.error` для глобального error handler. Позволяет трассировать запросы в production logs.
- ✅ **`GET /health/ready` readiness probe** — отдельный endpoint (вне `/api/v1`). Выполняет `prisma.$queryRaw SELECT 1`. 200 `{ status: "ready" }` если БД достижима, 503 `{ status: "not_ready" }` иначе. Используется k8s/Railway readiness check (в отличие от `/health` — liveness probe).
- ✅ **Analytics unbounded queries — take limits** — `server/src/routes/analytics.ts`: `scheduleHeatmap` sessions → `take: 5000`, `attendance` rows в `operations()` → `take: 10000`, `weekdayLeads` в `traffic()` → `take: 2000`. Предотвращает OOM при больших выборках.
- ✅ **`GET /api/v1/admin/consistency-check`** — новый route `server/src/routes/admin.ts`. Вызывает `runChecks(schoolId)` из `consistencyCheckService.ts` (read-only, никакого auto-fix). Требует `users:manage` permission (OWNER only). Response: `{ schoolId, checkedAt, totalViolations, criticalCount, warningCount, violations: Violation[] }`. Зарегистрирован в `routes/index.ts`.
- ✅ **Structured logger migration** — `cronJobs.ts`, `routes/auth.ts`, `routes/students.ts`, `routes/analytics.ts`, `routes/invoices.ts`, `routes/payments.ts`, `routes/salary.ts`: все `console.log`/`console.error` заменены на `createLogger(domain)`. Логи теперь JSON-structured в production, human-readable в dev через pino-pretty.
- ✅ **Frontend: `alert()` → `toast`** — 6 локаций в 5 файлах: `Analytics.tsx` (экспорт), `Step1Branding.tsx` (2 места), `schedule2/GroupRow.tsx`, `schedule/GroupRow.tsx`, `schedule2/SlotPanel.tsx` (2 места). Импорт `react-hot-toast` добавлен туда, где его не было.
- ✅ **Phase 9 тесты ×6** — `phase9Hardening.test.ts`: clean baseline (нет CRITICAL нарушений для чистой школы), ghost billing detection (check1 — attendance на INVALIDATED session), cross-school isolation (нарушения другой школы не видны), credit log pagination (page 1 returns 10/15, page 2 returns 5/15), analytics take limit safety (2 сессии с take:5000).
- ✅ **Build clean** — server `tsc` = 0, client `vite build` = 0, **253/253** тестов green (247 Phase 1-8 + 6 Phase 9).
- **⛔ PHASE 9 CLOSED.**

#### 2026-05-24 (Part 24 — Phase 7.3: Refunds, Reversals & Financial Adjustments)
- ✅ **Allocation-aware refund model** — added `PaymentRefund`, `PaymentRefundAllocation`, `CreditIssuanceReversal`, `FinancialAdjustment` plus enums `RefundStatus`, `FinancialAdjustmentType`, `FinancialAdjustmentStatus`. Migration: `20260524030000_phase7_3_refunds_adjustments`.
- ✅ **Net-paid invariant** — `paymentService.recomputePaidAmount` now caches `Invoice.paidAmount = confirmed allocations - confirmed refund allocations`. `createAllocation` overpayment guard uses the same net-paid source of truth.
- ✅ **Refund service** — `refundService.ts`: `createPaymentRefund`, `confirmPaymentRefund`, `voidPaymentRefund`. Refunds never delete payments, allocations, issuances, or ledger rows.
- ✅ **Credit reversal semantics** — refund reverses only available/unused credits. If requested reversal exceeds `StudentProfile.credits`, remaining consumed credits become explicit `FinancialAdjustment(type=BALANCE_DEBT)`. No hidden negative `StudentProfile.credits`.
- ✅ **Idempotency** — double confirm is blocked; `CreditIssuanceReversal` unique key prevents duplicate reversal for the same `(creditIssuanceId, paymentRefundAllocationId)`. Refund void marks reversal rows voided and writes counter-ledger restore entries.
- ✅ **Audit events** — `PAYMENT_REFUND_CREATED`, `PAYMENT_REFUND_CONFIRMED`, `PAYMENT_REFUND_VOIDED`, `CREDIT_REVERSAL_CREATED`, `FINANCIAL_ADJUSTMENT_CREATED`.
- ✅ **Routes** — payments API gained `POST /payments/:id/refunds`, `POST /payments/refunds/:refundId/confirm`, `POST /payments/refunds/:refundId/void`.
- ✅ **Tests ×11** — `refundsAdjustments.test.ts`: full/partial refund, refund cap, one allocation from many, partial-payment refund, consumed-credit debt marker, double-confirm idempotency, refund void, controlled adjustment ledger, check14 net-paid, audit/no destructive deletes.

#### 2026-05-27 (Phase 1 — Tenant Isolation Hardening + Regression Patch)
- ✅ **Regression audit findings fixed** — 6 BLOCKER IDOR + 3 non-blocking bugs закрыты после regression audit Phase 1.
- ✅ **`schedule.ts PUT /:id`** — `lessonBlock.findUnique({ where: { id } })` → `findFirst({ where: { id, schoolId } })`. School A больше не может обновить блок school B.
- ✅ **`schedule.ts POST /session/submit-attendance`** — `lessonBlock.findFirst` теперь фильтрует по `schoolId`. Закрыт вектор cross-tenant credit deduction (наиболее критичный).
- ✅ **`schedule.ts PATCH /session/:id/teacher`** — `lessonSession.findFirst` добавлен `schoolId`.
- ✅ **`schedule.ts PATCH /session/:id/details`** — аналогично.
- ✅ **`schedule.ts PATCH /session/:id/status`** — аналогично.
- ✅ **`schedule.ts GET /session/:id/students`** — `sessionStudent.findMany` и fallback `lessonSession.findFirst` добавлены `schoolId` — закрыт cross-tenant read студентов.
- ✅ **`salary.ts POST /adjustment`** — `assertStaffBelongsToSchool` добавлен перед созданием записи; catch `isTenantNotFound → 404`.
- ✅ **`salary.ts POST /manual-entry`** — аналогично.
- ✅ **`settings.ts POST /integrations/:id/sync`** — `update({ where: { id, schoolId } })` — TOCTOU закрыт.
- ✅ **20/20 тестов зелёные** после всех патчей.

#### 2026-05-27 (Phase 1 — Tenant Isolation Hardening)
- ✅ **`server/src/lib/tenant.ts` создан** — `TenantNotFoundError`, `isTenantNotFound`, `isPrismaNotFound`, `PrismaTx` тип, 7 assertion helpers (`assertStudentBelongsToSchool`, `assertStudentsBelongToSchool`, `assertStaffBelongsToSchool`, `assertLessonBlockBelongsToSchool`, `assertTeacherPaymentBelongsToSchool`, `assertWebhookBelongsToSchool`, `assertIntegrationBelongsToSchool`). Все хелперы принимают опциональный `tx?: PrismaTx` для работы внутри транзакции.
- ✅ **`salary.ts` исправлен** — `calculateNet()` теперь принимает `schoolId` и скопирует `manualLessonEntry` / `salaryAdjustment` по нему; `GET /:staffProfileId/history` добавлен `assertStaffBelongsToSchool`; `PATCH /rate/:staffProfileId` вызывает assertion внутри tx; `DELETE /pay/:paymentId` использует `findFirst({ where: { id, schoolId } })`.
- ✅ **`credits.ts` исправлен** — `POST /add`: `studentProfile.findFirst` фильтрует по `user: { schoolId }` (ранее фильтра не было — IDOR).
- ✅ **`settings.ts` исправлен** — `PATCH /webhooks/:id`, `POST /webhooks/:id/rotate-secret`, `PATCH /integrations/:id`, `POST /integrations/:id/disconnect` — все операции теперь используют `{ where: { id, schoolId } }` или явные assertion helpers; P2025 → 404.
- ✅ **`schedule.ts` исправлен** — `PATCH /:id/status`, `PATCH /:id/approve/:studentProfileId`, `PATCH /:id/reject/:studentProfileId`, `PATCH /:id/add/:studentProfileId`, `POST /:id/students` — добавлены schoolId в WHERE и вызовы assertion helpers.
- ✅ **`groups.ts` исправлен** — `POST /:id/students` вызывает `assertStudentsBelongToSchool` перед транзакцией; добавлен `isTenantNotFound` catch → 404.
- ✅ **Интеграционные тесты** — `server/src/__tests__/integration/tenantIsolation.test.ts`: 20 тестов, все green. Сценарии: same-school resolves, cross-tenant throws, data integrity, tx rollback.

#### 2026-05-31 (PR 4 — Schedule Status UI Compatibility)
- ✅ **`useSchedule.ts`** — добавлен отдельный стейт `sessionStatuses: Record<string, string>` (ключ `${blockId}_${dateISO}`). В `loadWeekSessions()` добавлен `statusMap` — наполняется параллельно с `subMap`/`cancMap` для всех non-INVALIDATED сессий. Новый хелпер `getSessionStatus(blockId, dateISO): string` — возвращает статус или `'UPCOMING'` по умолчанию. `weekSessions` не изменён. Экспортированы `sessionStatuses`, `getSessionStatus`.
- ✅ **`RoomBlock.tsx`** — визуальная логика переработана на основе `sessionStatus`. `IN_PROGRESS`: зелёный border + `●` dot. `LOCKED`: серый accent (#BDBDBD) + 🔒 badge, opacity 0.82. `CANCELLED`: без изменений (☒, opacity 0.45). `COMPLETED`/past: без изменений (✓/! attendance badge). `pastBadge` подавлен для LOCKED/IN_PROGRESS. `areEqual` дополнен `sched.sessionStatuses`.
- ✅ **`roomBlockStyles.ts`** — добавлены `inProgressDot` и `lockedBadge`. `roomBlockContainer` принимает опциональный `isLocked?` для opacity.
- ✅ **`GroupRow.tsx`** — derive `sessionStatus`/`isLocked`/`isInProgress`. Бейдж "● Идёт сейчас" в `groupInfoTop` при `IN_PROGRESS`. Кнопки "Редактировать урок" и "Отменить занятие" — `disabled={isLocked}` с 🔒 префиксом в тексте (не скрыты). Defense в `openCancelDialog()`. `areEqual` дополнен `sched.sessionStatuses`.
- ✅ **INVALIDATED** — политика неизменна: сессии пропускаются в `loadWeekSessions()`, в UI не попадают.
- ✅ **Attendance logic** — не затронута.

#### 2026-05-31 (PR 3 — Bulk Cancel UI)
- ✅ **`BulkCancelModal.tsx`** — новый компонент в `components/schedule/`. 3-шаговый модал: выбор дня → причина → результат. Показывает рабочие дни текущей/будущей недели; прошедшие дни текущей недели заблокированы (🔒, `disabled`). Reason ≥ 5 символов required. После POST показывает итог: отменено N / заблокировано M (SESSION_HAS_DEDUCTED_CREDITS). При `cancelled > 0` вызывает `onSuccess()` → `loadWeekSessions()`.
- ✅ **`Schedule.tsx` toolbar** — кнопка «Отменить день» добавлена в правую часть toolbar. Видна только при `!isHistoryView && view === 'week' && (OWNER | ADMIN)`. Деструктурирован `user` из `useAuth()`.
- ✅ **`API_CONTRACTS.md`** — задокументирован `POST /schedule/sessions/bulk-cancel` (ранее отсутствовал в docs): request, 3 варианта response, partial success semantics, примечание об отсутствующем `errors` поле.

#### 2026-05-31 (PR 2 — Schedule Financial Integrity: Cancel Credit Guard)
- ✅ **`assertNoCreditDeductedAttendance()`** — новая функция в `scheduleLifecycleService.ts`. Блокирует переход сессии в CANCELLED если существует хотя бы одна `Attendance` запись с `creditDeducted=true`. Возвращает `409 SESSION_HAS_DEDUCTED_CREDITS`. Покрывает оба пути: `PATCH /session/:id/status` и `POST /sessions/bulk-cancel` (оба вызывают `changeSessionStatus()`).
- ✅ **Guard вызывается в `changeSessionStatus()`** — блок 2b, между restore guard и DB update. Единственная точка входа — нет дублирования.
- ✅ **Bulk-cancel** — без изменений в route. Заблокированные сессии попадают в `errors[]` с кодом `SESSION_HAS_DEDUCTED_CREDITS`, успешные отменяются. Частичный успех корректен.
- ✅ **`businessInvariants.ts`** — добавлен раздел `CANCEL_GUARD_INVARIANTS` с документацией правила и `CANCEL_BLOCK_ERROR_CODE`.
- ✅ **Unit тесты ×7** — в `scheduleLifecycleService.test.ts`: no-op для не-CANCELLED статусов, resolve когда нет записей, throw 409 когда запись найдена, интеграция через `changeSessionStatus()` (success + blocked).
- ✅ **Integration тесты ×7** — новый файл `cancelCreditGuard.test.ts`: no-attendance allowed, creditDeducted=false allowed, creditDeducted=true blocked (UPCOMING), IN_PROGRESS blocked, mixed-attendance blocked, bulk partial, bulk all-blocked.
- ✅ **ADR-026** — `ARCHITECTURAL_DECISIONS.md`: зафиксировано решение BLOCK vs AUTO-REFUND с 4 причинами.
- ✅ **`API_CONTRACTS.md`** — добавлен 409 `SESSION_HAS_DEDUCTED_CREDITS` для `PATCH /session/:id/status`.
- **Correction flow** — не реализован. Отдельная задача.

#### 2026-05-24 (Part 25 — Phase 7.4 v1: Overdue, Debt & Accounts Receivable)
- ✅ **Computed overdue only** — no schema migration, no cron, no persisted `outstandingAmount`, and no canonical use of `InvoiceStatus.OVERDUE`. Overdue is calculated as `status in (ISSUED, PARTIALLY_PAID) && dueDate < asOf && outstanding > 0`.
- ✅ **Receivable service** — `server/src/services/receivableService.ts`: `computeInvoiceReceivable`, `getStudentReceivableSummary`, `listOverdueInvoices`, `getSchoolReceivableSummary`, plus pure helpers `calculateNetPaid`, `calculateOutstanding`, `isInvoiceOverdue`.
- ✅ **Outstanding formula** — `netPaid = confirmed allocations - confirmed refund allocations`; `outstanding = max(totalAmount - netPaid, 0)`. All money arithmetic uses `Prisma.Decimal`.
- ✅ **Debt separation** — invoice receivables are money debt; active `FinancialAdjustment(type=BALANCE_DEBT, amountCredits)` is credit debt and is not added to invoice outstanding.
- ✅ **Read-only routes** — `GET /api/v1/receivables/student/:studentProfileId`, `GET /api/v1/receivables/overdue`, `GET /api/v1/receivables/summary`; optional `asOf` ISO query param.
- ✅ **Check15** — `consistencyCheckService` now validates receivable/status math as CRITICAL: overpaid negative-outstanding risk and stale `ISSUED/PARTIALLY_PAID/PAID` statuses against net-paid source of truth.
- ✅ **Tests ×13** — `receivables.test.ts`: dynamic overdue, partial paid overdue, paid/void not overdue, refund after paid creates outstanding/overdue, summaries, credit debt separation, check15, non-negative outstanding clamp, netPaid+outstanding consistency.

#### 2026-05-24 (Part 22 — Фаза 7.1 Stabilization: Audit, Check14, Tests ×32)
- ✅ **`logFinanceAction`** — новая функция в `server/src/lib/auditLog.ts`. Пишет в `ScheduleActionLog` (существующая таблица, `entityType: String`). События: `INVOICE_CREATED`, `INVOICE_ISSUED`, `INVOICE_VOIDED`, `PAYMENT_CREATED`, `PAYMENT_VOIDED`, `PAYMENT_ALLOCATED`. FK-поля sessionId/blockId/groupId оставлены null; `entityId` передаётся в JSON `after`.
- ✅ **Аудит в сервисах** — `invoiceService.ts`: аудит в `createDraft`, `issueInvoice`, `voidInvoice`. `paymentService.ts`: аудит в `createPayment`, `createAllocation` (добавлен обязательный `actorId: number`), `voidPayment`. Routes (`payments.ts`, `invoices.ts`) передают `actorId: req.user!.userId`.
- ✅ **Check 14 (CRITICAL)** — `consistencyCheckService.ts`: `invoice.paidAmount ≠ SUM(confirmed allocations)`. Семплирует до 200 инвойсов за запуск. Добавлена в `runChecks()`.
- ✅ **Tests ×32** — `invoiceLifecycle.test.ts` расширен до 32 тестов. Новые: cross-school allocation rejected, allocation to PAID invoice blocked, Decimal serialization stable (JSON round-trip), audit logs written, check14 catches mismatch, check14 no false positives.
- ✅ **Build clean** — `tsc --noEmit` = 0 ошибок. 186/187 тестов green (1 pre-existing fail в `membershipSnapshot.test.ts` — FK guard, не связан с Phase 7.1).
- **⛔ PHASE 7.1 CLOSED.** Phase 7.2 (credit issuance from invoice line) — отдельная задача.

#### 2026-05-24 (Part 21 — Фаза 7.1: Invoice Infrastructure Foundation)
- ✅ **Invoice model** — `server/prisma/schema.prisma`: новые модели `Invoice`, `InvoiceLine`, `Payment`, `PaymentAllocation`; новые enums `InvoiceStatus`, `InvoiceLineType`, `PaymentStatus`. Добавлены поля `StudentProfile.moneyBalance Decimal(12,2)` и `LessonCreditLog.paymentId Int?` (nullable FK на `Payment`, для будущей Phase 7.2).
- ✅ **invoiceService.ts** — `createDraft` (статус DRAFT, нулевые суммы, tenant isolation), `addLine` (amount = qty × unitPrice, Decimal арифметика, totalAmount пересчитывается по всем строкам), `issueInvoice` (DRAFT → ISSUED, требует ≥1 строки), `voidInvoice` (блокирован если есть подтверждённые allocations, блокирован если PAID).
- ✅ **paymentService.ts** — `createPayment` (Decimal safety, tenant isolation), `createAllocation` (overpayment guard: remaining = totalAmount − SUM(confirmed allocations); paidAmount пересчитывается через `recomputePaidAmount`), `voidPayment` (статус VOIDED, allocations остаются как audit trail, paidAmount всех затронутых инвойсов пересчитывается).
- ✅ **Инварианты**: `balanceDue` не хранится (всегда computed); `paidAmount` обновляется только через `recomputePaidAmount` (SUM confirmed allocations); кредиты НЕ выдаются автоматически (Phase 7.2); invoice immutable после ISSUED; voided payment allocations остаются в истории.
- ✅ **Endpoints**: `POST/GET /api/v1/invoices`, `GET /api/v1/invoices/:id`, `POST /api/v1/invoices/:id/lines|issue|void`; `POST/GET /api/v1/payments`, `GET /api/v1/payments/:id`, `POST /api/v1/payments/:id/void|allocate`.
- ✅ **Tests** — `__tests__/integration/invoiceLifecycle.test.ts`: 20 сценариев (draft creation, tenant isolation, Decimal precision, addLine immutability, issue lifecycle, partial/full payment, 1→N and N→1 allocations, void invoice guards, void payment audit trail, overpayment guard, paidAmount consistency invariant).
- **Schema migration:** `20260524010000_phase7_invoice_infrastructure` — только additive. Нет destructive changes. `StudentPayment` legacy table нетронута.

#### 2026-05-12 (Part 11 — Credit deduction for all statuses + submittedById)
- ✅ **Credit deduction for ABSENT** — `attendanceService.ts` переписан: кредит списывается при любом статусе (PRESENT / LATE / ABSENT), если студент не заморожен заблаговременно. Логика: `shouldDeduct = !existing?.creditDeducted` — идемпотентно, не списывается дважды. Заморозка засчитывается только если `profile.frozenAt <= sessionDate - freezeWindowHours`. Убран `shouldRefund` (статус посещаемости больше не возвращает кредит).
- ✅ **submittedById на Attendance** — новый nullable FK `Attendance.submittedById → User.id (ON DELETE SET NULL)`. Оба эндпоинта (`POST /session/submit-attendance` и `PATCH /session/:id/attendance`) передают `submittedById: req.user!.userId`. Используется для расчёта зарплаты преподавателя. Миграция: `20260512000001_attendance_submitted_by_and_deduct_absent`.
- ✅ **STUDENT_FROZEN больше не бросается** — ранее замороженный студент приводил к откату транзакции и attendance не сохранялся. Теперь attendance сохраняется с `creditDeducted: false`, ошибок нет — поведение предсказуемое.


#### 2026-06-09 (Part 2 — Attendance Core Stabilization: P1/P2 Root Fixes)
- ✅ **Admin Attendance.tsx rewritten** — страница `pages/dashboard/admin/Attendance.tsx` переписана с нуля: использует новый endpoint `GET /schedule/attendance-dashboard?days=14`, показывает pending (прошедшие уроки без посещаемости) и submitted (недавно сданные). Убраны все статичные mock-данные.
- ✅ **"Submitted" badge → DB-backed** — источник правды для бейджа «Посещаемость сдана» заменён с `localStorage (attSub)` на `sessionStatus === 'COMPLETED'` из `sessionStatuses` (`useSchedule.ts`). localStorage-переменная `submitted` удалена из `GroupRow`. Перекрёстный обмен устройствами и браузерами теперь корректен.
- ✅ **submittedBy/submittedAt в UI** — `GET /session/for-date` расширен: возвращает `submittedById`, `submittedBy { firstName, lastName }`, `createdAt` для каждого attendance. `GroupRow` извлекает первого submitter и показывает «Сдал: Name · DD.MM HH:MM» в заголовке группы.
- ✅ **Idempotency-Key на POST /submit-attendance** — сервер подключил `idempotency` middleware к `POST /session/submit-attendance`. Клиент генерирует `crypto.randomUUID()` и отправляет как `Idempotency-Key` header. Дублированные submit-запросы при retry воспроизводят кешированный ответ.
- ✅ **Individual correction UI** — `GroupRow` подключил `PATCH /session/:id/attendance` через `handleCorrectStudent`. После submit кнопки статуса у каждого студента переходят в режим коррекции: циклируют PRESENT→ABSENT→LATE→PRESENT. Correcting state (`savingStudentId`) и per-student ошибки (`studentCorrErrors`) отображаются inline.
- ✅ **Partial errors inline** — `POST /submit-attendance` возвращает `data.errors[]`. `GroupRow` сохраняет в `partialErrors` state и отображает под списком студентов список непрошедших с причиной (STUDENT_FROZEN → «студент заморожен»).
- ✅ **Новый endpoint GET /schedule/attendance-dashboard** — возвращает `{ pending[], submitted[] }` за последние N дней. `pending` — прошедшие сессии без COMPLETED статуса. `submitted` — COMPLETED сессии с первым submitter. Только для `attendance:write`.
- **Файлы:** `server/src/routes/schedule.ts`, `client/src/components/schedule/GroupRow.tsx`, `client/src/pages/dashboard/admin/Attendance.tsx`.

#### 2026-06-09 (PR — Schedule Stabilization: Single Source of Truth)
- ✅ **TimeSlots SoT** — `client/hooks/useSchedule.ts`: убран `DEFAULT_SLOTS` из `useState` инициализации `slots`. На свежей сессии без кеша слоты начинаются как `[]` и устанавливаются только из DB через `loadFromServer`/`applySchedulePolicy`. `DEFAULT_SLOTS` остаётся только как fallback внутри `generateSlotsFromSettings`.
- ✅ **Исправлена гонка mount/week** — `Schedule.tsx`: добавлен `didMountRef = useRef(false)`. Mount effect теперь вызывает `loadWeekSessions(weekKey(new Date()))` после `loadFromServer` и устанавливает `didMountRef.current = true` в `.finally()`. Week effect (deps: `[viewWk]`) пропускает первый запуск через `if (!didMountRef.current) return` — нет двойного `applySchedulePolicy`/`loadWeekSessions` на маунте.
- ✅ **Стабилизированы realtime callbacks** — `Schedule.tsx`: деструктурированы `{ loadFromServer, applySchedulePolicy, loadWeekSessions, applyActiveDays }` из `sched` (все `useCallback([])` = стабильные ссылки). `reloadSchedule` deps: `[sched]` → `[loadFromServer, applySchedulePolicy]`. Socket listeners больше не переподписываются на каждый ререндер.
- ✅ **ScheduleData interface** — `client/components/schedule/scheduleTypes.ts`: добавлен `export interface ScheduleData` — документирует каноническую форму (slots, G, SC, aDays, weekSessions, cancelledSessions, sessionStatuses). Все views обязаны использовать этот объект, не реконструировать данные самостоятельно.

#### 2026-05-31 (PR 5 — Freeze System Phase 1: Backend Foundation)
- ✅ **StudentFreeze model** — новая модель `StudentFreeze` с полями: `type (LESSON_SKIP|PERIOD)`, `lessonSessionId? (LESSON_SKIP only)`, `startDate?`, `endDate? (null = open-ended)`, `status (ACTIVE|CANCELLED)`, `createdById`, `cancelledById?`, `cancelledAt?`. Новые enums `FreezeType`, `FreezeStatus`.
- ✅ **AttendanceStatus.FROZEN** — новое значение enum. Посещаемость студента с активной заморозкой записывается со статусом `FROZEN` (не `ABSENT`/`PRESENT`).
- ✅ **SchoolFinanceConfig** — добавлены `freezeDeadlineHours Int?` и `allowStudentSelfFreeze Boolean @default(true)`. Эффективный deadline: `freezeDeadlineHours ?? freezeWindowHours ?? 24`.
- ✅ **freezeService.ts** — `createFreeze`, `cancelFreeze`, `createOpenEndedFreeze`, `cancelAllActiveFreezes`, `findActiveFreeze`, `listFreezes`. Все финансовые операции внутри `$transaction` с row-lock `FOR UPDATE`.
- ✅ **StudentFreeze = source of truth** — `attendanceService.ts` переключён с `profile.isFrozen` на `findActiveFreeze(studentProfileId, sessionId, sessionDate, schoolId)`. `StudentProfile.isFrozen/frozenAt` остаются legacy-кешем, синхронизируются внутри `freezeService`.
- ✅ **PERIOD overlap guard (Decision 1)** — при создании PERIOD freeze проверяется пересечение диапазонов через bidirectional overlap query. 409 `FREEZE_PERIOD_OVERLAP` если пересечение найдено.
- ✅ **LESSON_SKIP UPCOMING-only guard (Decision 2)** — `LESSON_SKIP` разрешён только для `session.status = UPCOMING`. Иначе 422 `FREEZE_SESSION_NOT_UPCOMING`.
- ✅ **buildSessionStart** — новая утилита в `lib/tzUtils.ts`. Комбинирует UTC-noon `sessionDate` + `"HH:mm"` startTime + school.timezone → точный UTC момент начала урока. Исправляет смещение дедлайна для утренних/вечерних уроков в часовых поясах ≠ UTC.
- ✅ **Deadline validation** — при создании и отмене freeze: `now > sessionStart - deadlineHours → 422 FREEZE_DEADLINE_PASSED/FREEZE_CANCEL_DEADLINE_PASSED`.
- ✅ **Legacy compatibility** — `applyFreeze()`/`reverseFreeze()` в `scheduleLifecycleService.ts` стали тонкими обёртками над `createOpenEndedFreeze()`/`cancelAllActiveFreezes()`. Роут `PATCH /users/:id/freeze` не менялся. Legacy-функции пропускают deadline enforcement (admin account-toggle).
- ✅ **freeze:write permission** — добавлена в `SUPERADMIN`, `OWNER`, `ADMIN`. Student self-service — Phase 2.
- ✅ **Новые маршруты** — `POST /api/v1/freeze`, `DELETE /api/v1/freeze/:id`, `GET /api/v1/freeze?studentProfileId=X`.
- ✅ **Settings** — `GET/PATCH /api/v1/settings/finance` теперь включает `freezeDeadlineHours`, `allowStudentSelfFreeze`.
- ✅ **Тесты** — unit: `tzUtils.test.ts` (6), `freezeService.test.ts` (16+), `attendanceService.test.ts` (+3 updated). Integration: `freezeSystem.test.ts` (13). Всего +43 новых тестов.

#### 2026-06-12 (Schedule Freeze Blockers — P0/P1 Architecture Closure)

- ✅ **Phase 1 — Makeup/Move date validation** — `scheduleLifecycleService.ts`: `createMakeupSession()` теперь вызывает `validateSessionDate()` перед транзакцией (проверяет `activeDays`, legacy holidays, `ScheduleException`). `moveSession()` вызывает `validateSessionDate()` внутри транзакции после разрешения `targetTeacherId` (дополнительно проверяет паттерн дней блока и date range). Ошибки: `MAKEUP_DATE_INVALID` (422) и `MOVE_DATE_INVALID` (422). 6 интеграционных тестов (`scheduleFreeze_makeupDateValidation.test.ts`).

- ✅ **Phase 2 — Makeup concurrency invariant** — `createMakeupSession()`: добавлен `SELECT ... FOR UPDATE` на строку оригинальной сессии перед проверкой `existingMakeup` (сериализует конкурентные создания). Добавлен `.catch(P2002 → MAKEUP_ALREADY_EXISTS 409)` для safety-net на уровне БД. Миграция `20260612000000`: partial unique index `LessonSession_active_makeup_unique` ON (`makeupForSessionId`) WHERE `makeupForSessionId IS NOT NULL AND status != 'CANCELLED' AND deletedAt IS NULL`. 5 интеграционных тестов (`scheduleFreeze_makeupConcurrency.test.ts`). Обновлён characterization test `scheduleChr_makeupCRUD.test.ts` — gap закрыт.

- ✅ **Phase 3 — Restore session roster reconciliation** — `restoreSession()`: после `changeSessionStatus(→ UPCOMING)` теперь вызывает `reconcileRosterOnMemberAdd()` + `reconcileRosterOnMemberRemove()` из `rosterService.ts` — добавляет новых ACTIVE участников, удаляет WITHDRAWN (если нет attendance). Импорт rosterService добавлен в `scheduleLifecycleService.ts`. 5 интеграционных тестов (`scheduleFreeze_restoreRoster.test.ts`).

- ✅ **Phase 4 — Freeze Cancellation ADR** — `ARCHITECTURAL_DECISIONS.md`: добавлен ADR-027. Зафиксировано: отмена заморозки **prospective only** — исторические FROZEN-записи посещаемости остаются неизменными, кредиты не списываются ретроспективно. Реализовано корректно в `cancelAllActiveFreezes()`. Ретроспективные исправления требуют явного OWNER flow с аудит-трейлом.

#### 2026-06-10 (Schedule Closure Invariants — F-01/F-02/F-03/F-06)

- ✅ **F-01 — `isAttendanceAllowed()` enforced in `markAttendance()`** — `services/attendanceService.ts`: заменена ручная проверка `status === 'CANCELLED' || 'INVALIDATED'` на `!isAttendanceAllowed(session.status)` из `sessionStateMachine`. Импорт `isAttendanceAllowed` добавлен. Теперь посещаемость принимается только для `IN_PROGRESS` и `COMPLETED` — `UPCOMING` и `LOCKED` возвращают `SESSION_NOT_SUBMITTABLE`. 6 интеграционных тестов (`scheduleClosure_attendanceGate.test.ts`).

- ✅ **F-02 — Restore blocked when active makeup exists** — `services/scheduleLifecycleService.ts::restoreSession()`: добавлена pre-flight проверка на наличие non-CANCELLED makeup сессии (`makeupForSessionId = sessionId`). Если существует — выбрасывает `ACTIVE_MAKEUP_EXISTS` (409, lifecycleError). Предотвращает создание двух одновременно UPCOMING сессий для одного слота и двойного списания кредитов. 5 интеграционных тестов (`scheduleClosure_restoreWithMakeup.test.ts`).

- ✅ **F-03 — LESSON_SKIP freeze cleanup on session cancel** — `services/scheduleLifecycleService.ts::changeSessionStatus()`: в блоке `targetStatus === 'CANCELLED'` добавлена очистка orphaned LESSON_SKIP freezes через `studentFreeze.updateMany(→ CANCELLED)` + синхронизация legacy `StudentProfile.isFrozen` (сбрасывается, если не осталось других ACTIVE freezes). Предотвращает постоянное накопление zombie freezes и corruption `isFrozen` legacy cache. 8 интеграционных тестов (`scheduleClosure_freezeOrphanOnCancel.test.ts`).

- ✅ **F-06 — Atomic restore: status + roster in single transaction** — `services/scheduleLifecycleService.ts::restoreSession()`: весь body обёрнут в `prismaClient.$transaction()`. `changeSessionStatus` получает `dbClient` (tx) вместо `prismaClient`, `reconcileRosterOnMemberAdd/Remove` также получают `dbClient`. Если reconcile падает — транзакция rollback, сессия остаётся CANCELLED (recoverable state). Устранён non-atomic failure mode Phase 3. 3 интеграционных теста (`scheduleClosure_atomicRestore.test.ts`).

#### 2026-06-10 (Schedule P0 Final Closure — F-01/F-03/F-04)

- ✅ **F-01 — cancelSession transaction boundary** — `services/scheduleLifecycleService.ts::changeSessionStatus()`: весь набор side-effects (session update + audit log + LESSON_SKIP freeze cleanup + isFrozen sync) обёрнут в единый `$transaction()`. Определение наличия outer tx через `typeof (client as any).$transaction`. Zombie freezes от partial failure теперь невозможны.

- ✅ **F-03 — validateSessionTimeBounds() — канонический SOT для рабочих часов** — `services/scheduleValidation.ts`: добавлена `validateSessionTimeBounds(prisma, schoolId, startTime, endTime)`. Сравнивает HH:mm строки лексикографически против `School.workStart`/`School.workEnd`. Вызывается из `rescheduleSession` (до `$transaction`) и `moveSession` (внутри `$transaction`). Бросает 422 `TIME_OUTSIDE_WORKING_HOURS` при нарушении. 6 unit-тестов (`scheduleValidation.test.ts`).

- ✅ **F-04 — FOR UPDATE lock внутри markAttendance** — `services/attendanceService.ts`: добавлен `SELECT id FROM "StudentProfile" WHERE id = $id FOR UPDATE` внутри блока `wantDeduct`, до вызова `findActiveFreeze()`. Создаёт total order с `createFreeze`/`createOpenEndedFreeze`, которые уже держат этот же lock. Инвариант ACTIVE FREEZE ⇒ NO CREDIT DEDUCTION теперь self-contained на уровне сервиса. 5 unit-тестов (`attendanceService.test.ts`).

#### 2026-06-11 (Schedule Closure — D-01/D-02/D-03/D-04/D-05/D-06)

- ✅ **D-01 — Shared freeze cleanup helper: `cancelLessonSkipFreezesForSession`** — `services/scheduleLifecycleService.ts`: инлайн-блок очистки LESSON_SKIP freezes из `changeSessionStatus.runTx` вынесен в module-level хелпер `cancelLessonSkipFreezesForSession(txClient, sessionId)`. Хелпер вызывается из `changeSessionStatus` (прежнее поведение) и из `moveSession` (после отмены оригинальной сессии) — одинаковый инвариант в обоих путях. До фикса: `moveSession` обходил cleanup → zombie freezes. 2 unit-теста (`scheduleLifecycleService.test.ts`).

- ✅ **D-02 — validateSessionTimeBounds в PATCH /session/:id/details** — `routes/schedule.ts`: добавлен вызов `validateSessionTimeBounds(prisma, schoolId, newStartTime, newEndTime)` до `lessonSession.update`, когда `startTime` или `endTime` изменяется. Возвращает 422 `TIME_OUTSIDE_WORKING_HOURS` при нарушении рабочих часов. 4 unit-теста (`scheduleDetailsTimeBounds.test.ts`).

- ✅ **D-03 — assertNoCreditDeductedAttendance перемещён внутрь транзакции** — `services/scheduleLifecycleService.ts::changeSessionStatus()`: вызов `assertNoCreditDeductedAttendance(session.id, targetStatus, client)` перемещён из-за начала `runTx` (outside tx) внутрь callback `runTx(txClient)` с `txClient`. Устраняет TOCTOU-окно между проверкой и фактическим update. 2 unit-теста (`scheduleLifecycleService.test.ts`).

- ✅ **D-04 — replaceTeacher: write-boundary (update+audit в одной транзакции)** — `services/scheduleLifecycleService.ts::replaceTeacher()`: `lessonSession.update` и `logScheduleAction` обёрнуты в `prismaClient.$transaction`. Уведомления и socket-эмиты остаются вне транзакции (best-effort). 2 unit-теста (`scheduleLifecycleService.test.ts`).

- ✅ **D-05 — invalidateSession LOCKED path: write-boundary** — `services/scheduleLifecycleService.ts::invalidateSession()` LOCKED-ветка: `lessonSession.update` и `logScheduleAction` обёрнуты в `prismaClient.$transaction`. Socket-эмиты и best-effort нотификации остаются вне транзакции. 2 unit-теста (`scheduleLifecycleService.test.ts`).

- ✅ **D-06 — POST /:id/apply: schoolId в block lookup** — `routes/schedule.ts`: добавлен `schoolId: req.user!.schoolId!` в `lessonBlock.findFirst` where-клаузу. До фикса: студент мог указать blockId из другой школы → запрос проходил tenant-проверку, создавался EnrollmentRequest с чужим schoolId. 4 unit-теста (`d06CrossTenantEnrollment.test.ts`).

#### 2026-06-14 (Fix — закрытие GroupMembership при soft-delete группы)

- ✅ **Dead ACTIVE memberships при удалении группы** — оба пути soft-delete группы оставляли `GroupMembership.status = ACTIVE`, указывающими на удалённую группу (накопилось ~4132 «мёртвых» членства по школе). Новый инвариант: **`status = ACTIVE` ⇒ `studentGroup.deletedAt IS NULL`**.
  - `services/groupLifecycleService.ts::archiveGroup()` — при установке `deletedAt` в той же транзакции закрывает все ACTIVE-членства группы (`status → WITHDRAWN`, `leftAt = archivedAt`, `leftReason = 'GROUP_ARCHIVED'`); счётчик `closedMemberships` пишется в audit `after`. Roster reconciliation не нужен (архив требует COMPLETED → будущие сессии уже инвалидированы).
  - `routes/settings.ts` (`clear-all-data`) — массовый wipe школы теперь закрывает все ACTIVE-членства (`leftReason = 'SCHOOL_DATA_CLEARED'`) вместе с soft-delete групп/блоков/сессий.
  - **Backfill-миграция** `20260614000000_close_orphaned_memberships` — однократно закрывает все ACTIVE-членства, чьи группы уже soft-deleted (`leftAt = COALESCE(group.deletedAt, NOW())`, `leftReason = 'BACKFILL_ARCHIVED_GROUP'`).
  - **Defensive read-фильтры** (`studentGroup: { deletedAt: null }`) добавлены в кросс-групповые чтения активных членств: `sessionService.snapshotNewSessions`, `churnService`, `academicAnalyticsService`, `routes/parent.ts`, `routes/analytics.ts` (×3), `routes/schedule.ts` (student schedule). Защита от будущих регрессий.
  - Тесты: `integration/groupLifecycle.test.ts` (архив закрывает членства, не трогает живую группу) + `integration/securityHardening.test.ts` (после clear-all-data нет ACTIVE-членств).

#### 2026-06-19 (Баланс — единственный источник правды, `paidUntil` производная)

- ✅ **Статус оплаты выводится из баланса** — раньше студент оставался «просрочено» после оплаты: клиент сравнивал `paidUntil < today`, сервер — `credits <= 0`, и ни один путь оплаты не двигал `paidUntil` (только CSV-импорт). Теперь `StudentProfile.credits` — единственный источник правды; «просрочено» = `!isFrozen && credits <= 0` и на сервере (`routes/students.ts`), и на клиенте (`Students.tsx`, `GroupDetail.tsx`).
- ✅ **`paidUntil` — производная дата только для отображения** — пересчитывается из баланса хелпером `lib/paidUntilDerivation.ts` (`deriveStatus` + `recomputeAndPersistPaidUntil` + `recomputePaidUntilForSchool`). Вызывается в той же транзакции при каждом изменении баланса: `creditIssuanceService.ts` (выдача + реверс), `routes/credits.ts` (`POST /add`). Не трогает idempotency-ключи, `creditDeducted`, `CreditIssuance`.
- ✅ **Два режима оплаты** — `SchoolFinanceConfig.billingMode` (`PER_LESSON` | `CALENDAR_MONTH`, по умолчанию `PER_LESSON`; миграция `20260619000000_add_billing_mode`). `PER_LESSON`: дата = когда закончатся кредиты, по реальному расписанию `LessonSession` (1 кредит = 1 урок), при нехватке горизонта — экстраполяция по недельной частоте. `CALENDAR_MONTH`: `today + (credits × pricePerLesson ÷ basePrice)` месяцев. Переключатель в `CrmSettings` → «Режим оплаты»; смена режима пересчитывает даты всех студентов школы (`PATCH /settings/finance`).
- ✅ **Backfill** — `scripts/backfill-paid-until.ts` (`npx tsx scripts/backfill-paid-until.ts [schoolId] [--dry]`), курсорная пагинация по 500, идемпотентен. Применён к школе #1 (1033 студента).
- Все денежные вычисления через `Prisma.Decimal`; даты привязаны к UTC-полудню; «сегодня» считается в таймзоне школы.

#### 2026-07-02 (Quick payment — carry-over wallet, ни один сом не пропадает)
- ✅ **Carry-over кошелёк для быстрой оплаты** — `routes/students.ts` (`PATCH /students/:id`): сумма оплаты сначала целиком банкуется в `StudentProfile.moneyBalance` (ранее мёртвая колонка из Phase 7), затем покупается `floor(moneyBalance / pricePerLesson)` кредитов, остаток остаётся в кошельке до следующей оплаты. Раньше остаток (`amount mod pricePerLesson`) молча отбрасывался: 2×100 сом = 0 уроков при цене 193. Теперь оплаты от 1 сома накапливаются, пока не покроют урок. Атомарный `increment` на `moneyBalance` берёт row lock → конкурентные оплаты одного студента сериализуются.
- ✅ **`LessonCreditLog` пишется только при creditsToAdd > 0** — денежный след всегда в `StudentPayment`; кредитный леджер не засоряется нулевыми записями от мелких банкуемых оплат.
- ✅ **Валидация `paymentAmount`** — 400 при non-finite (`Infinity`) или > 10 000 000 (раньше `Math.floor(Infinity/193)` ронял транзакцию 500-й).
- ✅ **API** — `GET /students/:id/payment-history` возвращает `monthly.moneyBalance`; PATCH-ответ включает обновлённый `moneyBalance`. Клиент (`Students.tsx` PaymentTab): превью `= N ур.` считает `floor((wallet + amount) / pricePerLesson)`, в карточке баланса строка «Накоплено: X с из Y с за урок» при wallet > 0.
- ✅ **Тест** — `financialConsistencyIdempotency.test.ts` тест 4: 150 сом → 0 кредитов + 150 в кошельке (StudentPayment есть, LessonCreditLog нет); +100 сом → +1 кредит, 50 в кошельке; 99 млн → 400. Все 9 тестов файла green.

#### 2026-07-02 (Part 2 — Quick payment hardening: idempotency, race, currency, pricePerLesson drift)
- ✅ **Стабильный Idempotency-Key на клиенте** — `Students.tsx` PaymentTab: ключ генерировался `crypto.randomUUID()` на каждый клик → retry после timeout шёл с новым ключом и записывал оплату дважды. Теперь ключ живёт в `payKeyRef`, регенерируется только при изменении суммы (включая сброс после успеха) — retry той же суммы реплеится сервером.
- ✅ **Конкурентная гонка одного ключа → replay вместо 500** — `routes/students.ts` PATCH: два одновременных запроса с одним ключом оба проходили replay-проверку, проигравший падал на unique constraint с 500. Теперь P2002 в catch → повторный lookup `StudentPayment` по ключу → 200 с актуальным профилем (оплата применена ровно один раз).
- ✅ **Валюта из конфига школы** — уведомление об оплате писало захардкоженный "KGS"; теперь `SchoolFinanceConfig.currency`.
- ✅ **Ошибки оплаты видны админу** — клиентский catch показывал «Не удалось сохранить» на всё; теперь `err.response.data.error` (например 403 finance-gate для ADMIN) с fallback.
- ✅ **pricePerLesson не устаревает** — `routes/settings.ts` PATCH /finance: `pricePerLesson` пересчитывался только когда `basePrice` И `billingDays` приходили вместе; апдейт одного поля оставлял цену устаревшей → неверный расчёт кредитов на каждой будущей оплате. Теперь пересчёт при изменении любого из двух, недостающее значение читается из конфига. Тест 5 в `financialConsistencyIdempotency.test.ts` (settings router добавлен в тестовое приложение). Все 5 тестов файла green; server/client `tsc` = 0.

#### 2026-07-03 (Attendance UI fixes + кнопка «Книга»)
- ✅ **Статусы больше не сбрасываются в «Не отмечен» после сдачи посещаемости** — `GroupRow.tsx` `handleSubmitAttendance`: `onReload()` (полный `loadFromServer`) пересобирал G с `ta: null`, а guard `attLoadedKeyRef` блокировал повторный fetch посещаемости — статусы «пропадали» до переоткрытия попапа. Теперь тот же приём, что в `handleReopenAttendance`: `await onReload` → сброс guard → `loadAttendanceForCurrentRow()`. Дублирующий pre-reload GET `for-date` удалён.
- ✅ **Единый вид пилюли «Присутствует»** — убран `boxShadow: inset…` и затемнение для отправленных статусов: сданный и несданный статус выглядят одинаково; dim остаётся только для in-flight коррекции и урока, который ещё нельзя отмечать.
- ✅ **Кнопка «Книга» (перенос с roachmaster)** — новый флаг `GroupMembership.bookIssued` (миграция `20260703000000`), `PATCH /groups/:id/students/book` (один студент или вся группа, `schedule:write`), `bookIssued` в membership-select `GET /schedule`. UI: пилюля «Книга» в строке студента + bulk-пилюля в шапке группы; optimistic update с точным revert при ошибке (`persistBook` в `GroupRow.tsx`). Скрыта для TEACHER и legacy-групп без `studentGroupId`.
- ✅ **Bulk-отметка в шапке группы** — кнопка «✓ Все присутствуют» заменена пилюлей в шапке (как на roachmaster): клик переключает всю группу «Присутствует» ↔ «Не отмечен» (`markAllPresent` в `useSchedule.ts`, состояние `group.gta`). Доступна только до сдачи (guard `markAllDisabled` не изменён).

#### 2026-07-03 (Part 2 — Attendance UI polish + performance)
- ✅ **Убран flash «Не отмечен» после сдачи** — `useSchedule.loadFromServer` теперь сохраняет текущие `stu.ta`/`gta` при merge свежего payload в G (payload ничего не знает о посещаемости); `loadAttendanceForCurrentRow(preserveMarks)` не сбрасывает отметки перед re-fetch того же дня. Кнопка «Сдача...» отпускается сразу после ответа сервера — reload идёт фоном.
- ✅ **Payload `GET /schedule` похудел в разы** — membership-select слал полный `studentProfile` (credits, moneyBalance, notes...) на каждого участника каждого блока (~2000 объектов на школу). Теперь slim: `{ id, user: { firstName, lastName } }` + `bookIssued`. Это была главная причина «долгой загрузки».
- ✅ **Клик по статусу больше не перерисовывает всё расписание** — (1) `getGroupsInCell` читает G через ref: его identity не меняется на per-student правках, поэтому grid-level useMemo в WeekGrid/RoomsView/TeacherView/GroupView не пересчитывают всю сетку на каждый клик (чипы не рендерят ta/book); структурные изменения (roster, глава) бампают `structureTick`. (2) memo-компаратор `GroupRow` сравнивает свою группу (`stu`/`gta`/`cc`), а не весь `sched.G` — раньше один клик перерисовывал все 89 строк попапа, теперь только строки своей группы.
- ✅ **Bulk-строка выровнена по колонкам** — отдельная строка над списком студентов зеркалит layout `StudentRow` (padding 16, gap 8, хвост 44px под ⋮); у пилюль посещаемости фиксированная ширина (`minWidth: 104`) — колонка не «гуляет» и layout не прыгает при переключении статуса. «+ Добавить студента» переехал в эту строку.
- ✅ **Глава «− N +» (перенос с roachmaster)** — контрол в bulk-строке, optimistic + revert. Новый `PATCH /groups/:id/chapter` (только ACTIVE группа, `schedule:write`): обновляет `StudentGroup.chapter` + блоки в транзакции. **Намеренно** без identity-lock `groupHasLifecycleHistory` — смена главы это прогресс, не смена идентичности когорты; level по-прежнему под полным lock.

#### 2026-07-04 (Part 3 — Per-student глава + отказ от full reload после сдачи)
- ✅ **Глава у каждого студента** — контрол «− N +» в каждой строке студента (как книга/посещаемость); источник правды `StudentProfile.chapter`, приходит в slim membership-select `GET /schedule`. Bulk «− N +» в шапке группы теперь обновляет главу группы + блоков + **всех** ACTIVE участников. `PATCH /groups/:id/chapter` расширен опциональным `studentProfileIds` (только указанные профили, membership-scoped). Optimistic + revert, in-flight guard.
- ✅ **Сдача/переоткрытие посещаемости больше не перезагружают всю школу** — `handleSubmitAttendance`/`handleReopenAttendance` звали `onReload()` = `reloadSchedule` (policy + все блоки + кабинеты + rebuild G) после каждой сдачи, хотя сдача ничего структурного не меняет. Теперь `sched.loadWeekSessions(wk)` (недельные session read models) + точечный re-fetch посещаемости. Full reload остаётся только у структурных операций (отмена, lifecycle, edit, roster).

#### 2026-07-04 (Part 4 — Schedule grid render performance)
- ✅ **Кэш `Intl.DateTimeFormat` в `tzUtils.ts`** — `dateInTz`/`getMondayInTz` создавали новый форматтер на каждый вызов (~0.1 мс каждый); сетка зовёт их сотни раз за рендер (каждый `RoomBlock` → `weekDates` = 7 вызовов, каждая ячейка → `dateKey`). Теперь форматтеры кэшируются per-timezone — десятки мс с каждого рендера недельной сетки.
- ✅ **`getGroupsInCell` в один проход** — `lessonCandidatesForCell` вызывался дважды на группу (в `.filter`, затем в `.map`) для каждой ячейки × каждой группы при каждом пересчёте grid-memo (каждый realtime-event / смена недели). Теперь кандидаты считаются один раз; логика включения/override не изменена.

#### 2026-07-04 (Part 4 — Memoизация grid-видов: клики в попапе больше не перерисовывают сетку)
- ✅ **React.memo на всех 5 grid-видах** (`WeekGrid`, `RoomsView`, `MonthView`, `TeacherView`, `GroupView`) через `schedViewPropsEqual(schedKeys)` (`scheduleTypes.ts`): `sched` сравнивается по конкретным полям, которые вид реально рендерит; остальные props — по identity. Каждый клик посещаемости/книги в попапе раньше перерисовывал всю сетку позади (сотни ячеек, ×2 в dev StrictMode) — теперь виды пропускают рендер, т.к. `ta`/`book` в чипах не отображаются.
- ✅ **Контракт `structureTick`** — виды, читающие `sched.G` напрямую (Rooms/Teacher/Group), сравнивают `structureTick` вместо `G`; тик бампается только на grid-видимых изменениях G (roster, chapter). Поля данных чипов `RoomBlock` (`groupColors`, `weekSessions`, `sessionStatuses`, `cancelledSessions`) включены в ключи всех четырёх видов, где он рендерится.
- ✅ **Стабилизированы хендлеры в `Schedule.tsx`** (`handleCellClick`, `handleDayAnnotation`, `handleDayMenu`, open-settings/control, month day click) через `useCallback` — иначе memo никогда бы не срабатывал. ⚠️ Новые props для этих видов добавлять только стабильными (useCallback/useMemo/состояние), иначе memo молча перестанет работать.
- ✅ **`loadWeekSessions` сохраняет identity состояния при неизменном payload** — realtime-события перезапрашивают неделю на каждый клик посещаемости в школе; свежие-но-равные объекты `weekSessions`/`cancelledSessions`/`sessionStatuses` меняли identity `getGroupsInCell` и сводили на нет memo всех grid-view. Теперь JSON-сравнение перед setState: без изменений → тот же объект → React bail-out.
- ✅ **WeekGrid монтирует только активный layout** — мобильное и десктопное дерево всегда рендерились оба (скрыты CSS); теперь `useIsMobile` (как в RoomsView/TeacherView/GroupView) монтирует одно — вдвое меньше React-работы и DOM.
- ✅ **Debounce audit-key (1 сек)** — каждый realtime-event дёргал `GET /schedule/policy-conflicts`; burst событий (сдача посещаемости группы) теперь коалесцируется в один запрос. `allTeachers` в `Schedule.tsx` обёрнут в useMemo.
- ✅ **SlotPanel лениво** — статический импорт в `Schedule.tsx`/`TeacherSchedule.tsx` тянул самый тяжёлый чанк расписания (~54KB gzip + parse) до первого рендера страницы, хотя панель рендерится только по клику на ячейку. Теперь `React.lazy` + `Suspense`: страница открывается без него, чанк подгружается при первом клике (и кэшируется).
- ✅ **Первый рендер данных сетки не ждёт teachers/cabinets** — mount-батч `Promise.allSettled` из 5 запросов красил сетку только после самого медленного; `/users?role=TEACHER` и `/settings/cabinets` нужны SlotPanel/фильтрам, не сетке — вынесены в независимые запросы.
- ✅ **Ctrl+scroll zoom без relayout на каждый тик** — `useZoomCtrlScroll` (и WeekGrid, чей inline-дубликат удалён в пользу хука) писал CSS `zoom` на каждое wheel-событие = полный relayout таблицы на тик. Теперь во время жеста — GPU `transform: scale()` (composite-only), через 150 мс после последнего тика — один настоящий `zoom` + sync в state.

#### 2026-07-04 (Part 5 — Server N+1 в policy-conflicts + кэш candidates в getGroupsInCell)
- ✅ **`GET /schedule/policy-conflicts`: 1.43s → 0.20s** — `await getPolicyForDate()` вызывался внутри циклов (до 300 сессий + до 100 блоков × 14 дней горизонта = сотни последовательных DB round-trip'ов на запрос), хотя все итерации резолвят одни и те же ~14 дат. Новый `makeCachedPolicyResolver(schoolId)` в `policyService.ts` — request-scoped мемо по дате (никогда не кэшируется между запросами — политики редактируемы). Применён в обоих циклах `schedule.ts` и в repair-цикле `settings.ts`. Этот запрос стартует при mount страницы расписания параллельно с grid-запросами и конкурировал с ними за Postgres.
- ✅ **Кэш candidates/slot-resolution в `useSchedule`** — grid-memo зовёт `getGroupsInCell` для каждой ячейки (22 слота × 7 дней = 154); кандидаты пары (группа, день) и резолюция времени→слот идентичны для всех 22 ячеек дня, но пересчитывались в каждой (~12k вычислений за проход при 158 блоках). `cellCalc` useMemo (deps = deps getGroupsInCell) с двумя Map: кандидаты на `${gid}|${ci}|${dk}`, слот на `${start}|${end}`. Безопасно при ta/book-правках: кандидаты зависят только от структурных полей + weekSessions, оба инвалидируют кэш.
#### 2026-07-04 (Merge dev → devroach10: missing billing migration + test fix)
- ✅ **Недостающая миграция `20260704000000_proportional_billing_payment_cancellation`** — колонки `StudentProfile.billingLessonsGranted`, `StudentPayment.cancelledAt/cancelledById` были добавлены в `schema.prisma` фичей proportional-billing, но миграции под них не было → `prisma migrate deploy` на dev/prod оставил бы схему без колонок и сломал бы оплату в рантайме. Добавлена additive-миграция (3× `ALTER TABLE`), применена к тестовой БД.
- ✅ **Тест `financialConsistencyIdempotency` #4 приведён к accumulator-модели** — тест ассертил `moneyBalance === 50`, читая сырой накопитель, но по дизайну `moneyBalance` — это running total (250, не декрементится), а «забанкованные к следующему уроку» 50 — производное поле `moneyBanked` в ответе API. Конфиг теста выражал цену через инертный для этого пути `pricePerLesson`; заменён на `basePrice: 200, billingDays: 1`. Ассерты теперь: `moneyBalance = 250`, `billingLessonsGranted = 1`, `moneyBanked = 50`.

#### 2026-07-04 (Atomic Grammar/Club pair deletion)
- ✅ **`DELETE /schedule/group-pair/:studentGroupId`** — `routes/schedule.ts`: новый endpoint, устраняет P0-дефект, при котором удаление Grammar+Club пары в `SlotPanel.handleRemoveGroup` выполнялось циклом `api.delete` по каждому blockId — если первый DELETE проходил, а второй падал (сетевой сбой, конкурентная блокировка версии, недопустимый transition), группа оставалась в half-deleted состоянии. Новый роут находит активные блоки группы сам (`schoolId, studentGroupId, deletedAt: null, endDate: null` — тот же инвариант «активного блока», что и guard в `POST /group-pair`) и архивирует их в одной transaction: либо оба блока архивируются, либо ни одного. Self-healing: если группа уже застряла в half-deleted состоянии (от старого бага), следующий вызов доархивирует оставшийся блок. 404, если активных блоков не найдено или группа принадлежит другой школе. Права — `schedule:delete` (OWNER/SUPERADMIN, как и у существующего `DELETE /:id`).
- ✅ **`archiveLessonBlockInTx(tx, params)`** — `services/blockArchiveService.ts`: транзакционное тело вынесено из `archiveLessonBlock()` в отдельную функцию, принимающую готовый `tx`. Позволяет архивировать несколько блоков (пару) атомарно в одной внешней transaction вместо того, чтобы каждый блок открывал свою. `archiveLessonBlock()` — обёртка (`client.$transaction(tx => archiveLessonBlockInTx(tx, params))`), поведение и сигнатура для существующих вызывающих (`DELETE /:id`) не изменились.
- ✅ **`SlotPanel.handleRemoveGroup`** — цикл `api.delete` по `relatedBlockIdsOf(g)` заменён на один вызов `DELETE /schedule/group-pair/:studentGroupId`, когда у группы есть `studentGroupId`. Для legacy-блоков без `StudentGroup` (нет backend-инварианта пары) поведение прежнее — цикл по `relatedBlockIdsOf`.
- ✅ **Тесты** — `integration/groupPairDelete.test.ts` (9): атомарное удаление пары, grammar-only, self-healing half-deleted пары, изоляция закрытой истории (`endDate` в прошлом не трогается), 404 без активных блоков, 404 cross-tenant, 403 ADMIN, атомарность отката при сбое второго блока (mock), регрессия для существующего `DELETE /:id`.

#### 2026-07-04 (Part 3 — Group-Pair Write Ownership guard)
- ✅ **`PUT /schedule/:id` guard** — `routes/schedule.ts`: если у существующего блока есть активная пара (`studentGroupId` задан, `endDate === null`, не архивирован) → `409 { code: 'GROUP_PAIR_OWNED' }` до любой мутации. Раньше этот роут мог молча отредактировать только Grammar или только Club половину пары (кабинет/учитель/дни/сплит), рассинхронизировав пару в обход `PUT /group-pair`.
- ✅ **`DELETE /schedule/:id` guard** — тот же чек (`isActiveGroupOwnedBlock`) перед вызовом `archiveLessonBlock`; блок сначала подгружается (`studentGroupId, endDate, deletedAt`), при активной паре — `409 GROUP_PAIR_OWNED`, архивация не запускается. `archiveLessonBlockInTx` не тронут — он по-прежнему используется легитимно внутри `DELETE /group-pair` для архивации обеих половин пары.
- ✅ **`POST /schedule` guard** — если в теле передан `studentGroupId`, для которого уже есть активный блок (`schoolId, studentGroupId, deletedAt: null, endDate: null`) → `409 { code: 'GROUP_ALREADY_IN_SCHEDULE' }`, зеркалит существующий guard в `POST /group-pair`.
- ✅ **Общий хелпер `isActiveGroupOwnedBlock(block)`** — `routes/schedule.ts`, рядом с `isInactiveGroup`. "Активная" пара = тот же инвариант, что и в `DELETE /group-pair`: `studentGroupId` задан, `endDate === null`, `deletedAt` пуст. Закрытые исторические версии (`endDate` в прошлом) и standalone-блоки без `studentGroupId` не блокируются.
- ✅ **Frontend не тронут** — статический аудит подтвердил, что `EditGroupPanel` и `SlotPanel` уже вызывают только group-pair endpoints; гварды — backend-only enforcement на случай прямых API-вызовов, скриптов или будущей регрессии.
- ✅ **Тесты** — новый `integration/groupPairWriteOwnership.test.ts` (7): PUT/DELETE/POST guard срабатывает на активной паре с no-mutation проверкой, PUT/DELETE/POST по-прежнему работают для standalone-блока, PUT не блокирует закрытую историческую версию (`endDate` в прошлом), POST разрешён когда у группы только закрытая/удалённая история. `groupPairDelete.test.ts` обновлён: старый тест "existing single-block route, unchanged" теперь использует standalone-блок (не сгруппированный), добавлен regression-тест на 409 для активного сгруппированного блока. `testDb.ts::createBlock` — `groupId` стал опциональным для создания standalone-фикстур.
- ⚠️ **Follow-up тикет (P1, отдельный PR)** — `checkStudentScheduleConflicts` (обе копии, `scheduleValidation.ts` и `schedule.ts`) и `GET /schedule/available` читают legacy `StudentGroup.students`/`StudentProfile.enrolledGroups` (relation `"GroupStudents"`), а не `GroupMembership`. Запись зачисления с миграции на `GroupMembership` идёт только в `GroupMembership` — легаси-relation больше не пишется production-кодом → конфликт расписания студента и исключение "уже записан" в available-list молча не срабатывают для всех, кто зачислен современным путём. Не в скоупе этого PR (только write ownership).

#### 2026-07-04 (Part 4 — Policy Transition Control: itemized pre-save preview + deep-link)
- ✅ **Forensic finding** — до начала кодирования выяснилось, что запрошенная "Schedule Policy Transition Control" уже реализована на ~85%: `SchoolSchedulePolicy` (temporal, `effectiveFrom`/`effectiveTo`), next-Monday переход (`getNextMondayDateInTz`/`getFirstWorkingDateStr`), `GET /schedule/policy-conflicts` + `PolicyConflictsPanel` (построчный список конфликтов с deep-link в `handlePolicyConflictAction`), pre-save preview (`GET /settings/policy-impact` + `PolicyImpactModal`) — всё уже существовало. Единственный реальный content-gap: pre-save модал в Settings показывал только агрегированные счётчики, без построчного списка групп и deep-link.
- ✅ **`computePolicyImpact()`** — `services/policyService.ts`: добавлен `affectedGroups[]` (blockId, studentGroupId, groupName, level, type, reason `NON_WORKING_DAY`/`OUTSIDE_WORK_HOURS`, days, startTime, endTime) в ответ. Заодно исправлен баг: запрос `allBlocks` не фильтровал `endDate: null`, из-за чего закрытые исторические блоки (после reschedule/split) ошибочно попадали в подсчёт конфликтов — приведено к тому же инварианту «активного блока» (`deletedAt: null AND endDate: null`), что используется во всём модуле расписания.
- ✅ **`PolicyImpactModal`** (`CrmSettings.tsx`) — вместо только счётчиков теперь рендерит построчный список затронутых групп (имя, уровень, причина) с кнопкой «Открыть», которая переходит на `/{slug}/{owner|admin}/schedule?focusBlockId=&focusDate=&focusStart=&focusEnd=&focusGroupId=`.
- ✅ **`Schedule.tsx`** — новый `useEffect` на query-параметры `focus*`: после завершения начальной загрузки (`!loading`) синтезирует `PolicyConflictAction` типа `edit-block` и передаёт в уже существующий `handlePolicyConflictAction`, переиспользуя весь механизм перехода на нужную неделю и открытия `SlotPanel` для группы, который ранее был доступен только из `PolicyConflictsPanel` на самой странице расписания. Параметры очищаются из URL после обработки (`setSearchParams({}, { replace: true })`).
- ✅ **Тесты** — `policyEffectiveDate.test.ts`: 2 новых теста (`affectedGroups` содержит имя/уровень/причину; закрытые блоки с `endDate` в прошлом исключены из `affectedGroups`/`affectedBlockIds`).

#### 2026-07-04 (Part 5 — Operational Control Discoverability: mount OperationalDebtPanel, working deep-link)
- ✅ **Forensic finding** — audit "operational control surfaces" (`PolicyConflictsPanel`, `OperationalDebtPanel`, `DirectorCommandCenter`, `DirectorChangeFeed`, `GET /schedule/integrity`) обнаружил, что только `PolicyConflictsPanel` реально смонтирован и рабочий. `OperationalDebtPanel` — полностью реализован, backed рабочим schoolId-scoped `GET /schedule/operational-debt`, но **нигде не импортировался** — orphaned dead code, `onOpenAttendance` callback не имел ни одной реализации. `DirectorCommandCenter`/`useDirectorCommandData`/`DirectorChangeFeed` (+ `GET /schedule/audit/feed`) и `GET /schedule/integrity` — тоже orphaned, но вне скоупа этого PR (не generic redesign, конкретно про operational debt).
- ✅ **`operationalDebtReadModelService.ts`** — `sessionContextSelect` теперь включает `lessonBlockId`; `OverdueAttendanceDebt` получил поле `blockId`. Без этого поля не было возможности построить deep-link: `sessionId`/`groupId` (StudentGroup id) не подходят под существующий `PolicyConflictAction.edit-block`/`open-session`, которым нужен `blockId`.
- ✅ **`OperationalDebtPanel.tsx`** — смонтирован в `Schedule.tsx` внутри существующего модала «Операционный контроль», рядом с `PolicyConflictsPanel` (не создавался второй control-surface). Добавлен `onDebtState?` callback (по образцу `onConflictState` у `PolicyConflictsPanel`).
- ✅ **`Schedule.tsx`** — `handleOpenOverdueAttendance()`: клик «Открыть» на overdue-attendance строке вызывает тот же `handlePolicyConflictAction({ type: 'edit-block', ... })`, что и «Редактировать группу» в `PolicyConflictsPanel` — переиспользован существующий edit-flow, не создан новый. Toolbar-бейдж «Операционный контроль» теперь проактивно опрашивает и `/schedule/policy-conflicts`, и `/schedule/operational-debt?limit=1` (`refreshControlIndicator`), чтобы индикатор был виден до первого открытия модала.
- ✅ **Тесты** — новый `integration/operationalDebtBlockId.test.ts`: `getOperationalDebt()` возвращает `blockId`, совпадающий с `LessonSession.lessonBlockId`.
- ⚠️ **Remaining risk (pre-existing, не introduced этим PR)** — `/schedule/policy-conflicts`, `/schedule/operational-debt`, `/schedule/audit/feed` защищены только `schedule:read`, которым также обладают TEACHER/STUDENT/PARENT — OWNER/ADMIN-only граница обеспечивается только скрытием кнопки на фронтенде, не самим API. `/schedule/integrity` — единственный endpoint в этой группе с правильным `analytics:read`. Не исправлялось в этом PR (не входило в scope, чисто discoverability).
- ⚠️ **Не в скоупе** — `DirectorCommandCenter`, `DirectorChangeFeed`, `GET /schedule/integrity` остаются orphaned; `reschedule-session` вариант `PolicyConflictAction` остаётся мёртвым (ни одна кнопка его не диспатчит) — не трогалось, т.к. policy conflicts logic уже работает и трогать её было запрещено этим scope.

#### 2026-07-04 (Part 6 — Operational Control Backend RBAC Hardening)
- ✅ **Forensic finding** — Part 5 задокументировал риск как "не в скоупе"; в этом PR он закрыт. `server/src/lib/permissions.ts`: `schedule:read` держат SUPERADMIN/OWNER/ADMIN/TEACHER/STUDENT/PARENT — то есть любой аутентифицированный пользователь школы. Три из четырёх school-wide read-model эндпоинтов (`policy-conflicts`, `operational-debt`, `audit/feed`) были защищены только `schedule:read`; `attendance-dashboard` — только `attendance:write` (тоже есть у TEACHER). Ни один из четырёх не фильтрует данные по вызывающему пользователю (`teacherId`/`studentId`) — только по `schoolId`, в отличие от `GET /schedule/teacher` и `GET /schedule/student`, которые честно скоупят через `req.user!.userId` → `staffProfile.id`/`studentProfile.id`.
- ✅ **Permission fix** — `routes/schedule.ts`: `GET /policy-conflicts`, `GET /operational-debt`, `GET /audit/feed`, `GET /attendance-dashboard` переведены с `schedule:read`/`attendance:write` на `analytics:read` (SUPERADMIN/OWNER/ADMIN only) — тот же permission, что уже использует `GET /schedule/integrity` и teacher-workload дашборды (`teacher-lesson-counts`, `teacher-lesson-calendar-admin`) в этом же файле. Новый permission-string не создавался.
- ✅ **Не тронуто** — `GET /schedule/integrity` (уже `analytics:read`) и `GET /settings/policy-impact` (уже `settings:write`) не менялись — уже были корректны. `GET /schedule/teacher`/`GET /schedule/student` (собственное расписание учителя/студента) не тронуты — они session:write/schedule:read, но уже скоуплены по `req.user!.userId`, это другой контракт.
- ✅ **Тесты** — новый `integration/scheduleOperationalControlRBAC.test.ts` (24 теста): для каждого из 4 эндпоинтов — OWNER 200, ADMIN 200, TEACHER 403, STUDENT 403, PARENT 403; cross-tenant isolation на `policy-conflicts`; регрессия — `GET /schedule/teacher`/`GET /schedule/student` всё ещё 200 для своих ролей, `GET /schedule/integrity` всё ещё 403 для TEACHER (прецедент не менялся).
- ⚠️ **Remaining risk** — TEACHER/STUDENT/PARENT ролей с явным per-user scoped operational view для этих же данных нет (продукт этого не требует сейчас); если понадобится — отдельный endpoint, не переиспользование этих школ-wide роутов.

#### 2026-07-05 (Part 11 — Freeze не покрывал урок того же дня → списывался кредит)
- 🐛 **Root cause** — `LessonSession.date` хранится как UTC-noon-сентинель (`YYYY-MM-DDT12:00:00.000Z`), а `createFreeze` писал `startDate`/`endDate` как сырой timestamp. Постановка на паузу после 12:00 UTC давала `startDate > sessionDate`, поэтому `findActiveFreezesForSession` (PERIOD-предикат `startDate <= sessionDate`) не находил заморозку и Submit Attendance списывал кредит, хотя студент показан «на паузе».
- ✅ **Fix** — `freezeService.createFreeze` теперь нормализует PERIOD `startDate`/`endDate` к noon-сентинелю через `dateInTz(d, timezone)` (единая точка — покрывает и `createOpenEndedFreeze` admin-toggle, и route-путь; заодно чинит латентный баг с `endDate` в последний день). Файлы: `server/src/services/freezeService.ts`.
- ✅ **Backfill** — 3 активных PERIOD-заморозки со старыми сырыми timestamp-ами приведены к noon-сентинелю (иначе уже созданные паузы остались бы битыми).
- ⚠️ **Финансы** — уже ошибочно списанные кредиты (напр. sp#73 Дарья → -1) не возвращаются автоматически; коррекция только через explicit ledger-flow по решению владельца.
- ✅ **Убран промежуточный шаг «Редактировать посещаемость» + модал причины** — на сданной (finalized) сессии `GroupRow.tsx` раньше показывал кнопку «Редактировать посещаемость», которая открывала модал с обязательной причиной ≥5 симв. до разблокировки, после чего каждый клик по студенту авто-сохранялся отдельным PATCH. Теперь сданная сессия **редактируется напрямую**: пилюли посещаемости переключаются локально (`sched.cycleAttendance`, без сети), как при первичной отметке, а единственная кнопка снова называется «Сдать посещаемость».
- ✅ **Reopen спрятан внутрь Save** — `handleSubmitAttendance`: если сессия finalized (`backendCanReopenAttendance`), перед bulk-сабмитом делается один `POST /schedule/session/:id/attendance/reopen` с авто-причиной `'Редактирование посещаемости'` (проходит серверный `assertReason`), затем обычный `submit-attendance` (который 409-ит на finalized-сессии, поэтому reopen обязателен). Backend/схема не менялись.
- ✅ **Финансово безопасно** — списание кредита гейтится write-once флагом `Attendance.creditDeducted` (`wantDeduct = !existing.creditDeducted`, не зависит от статуса), а `reopenAttendance` этот флаг НЕ сбрасывает → resubmit = идемпотентный skip: нет двойного списания, нет авто-возврата (коррекция PRESENT↔ABSENT меняет только статус + audit). Это тот же путь `markAttendance`, что и прежний reopen-flow — сменилась только кнопка-триггер.
- ✅ **Гейтинг** — `canEditAttendanceNow` теперь включает `backendCanReopenAttendance`; `StudentRow.attClickable = attendanceEditable || (submitted && !!onToggle)` (per-student PATCH сохранён как fallback, если submit упал между reopen и finalize). Из label/title/`handleAttendancePrimaryAction` убраны reopen-ветки.
- ✅ **Удалено** — reopen-модал (JSX), `handleReopenAttendance`, состояния `showReopenModal`/`reopenReason`/`reopenLoading` и импорты `Modal*` в `GroupRow.tsx`.
- ⚠️ **Trade-off для владельца** — (1) аудит фиксирует generic-причину вместо введённой человеком (поле заполнено, данные не теряются, но текст менее информативен); (2) Save по сданной сессии всегда пишет пару `AttendanceAudit(REOPEN)`+`(FINALIZE)`, даже если ничего не изменилось (безвредный шум в логе, кредиты не трогаются — dirty-check намеренно не добавлен, чтобы не плодить точки отказа). Если нужна человеко-читаемая причина обратно — вернуть модал.

#### 2026-07-04 (Part 7 — Orphaned Control Surfaces Cleanup)
- ✅ **Forensic finding** — Part 5 задокументировал `DirectorCommandCenter`/`useDirectorCommandData`/`DirectorChangeFeed`/`GET /schedule/integrity` как orphaned, но оставил вне scope. Полный аудит в этом PR показал: `DirectorCommandCenter` (327 строк) и его хук `useDirectorCommandData` (281 строка) нигде не импортировались вне себя, не были смонтированы, без тестов; коммит их появления описывал их как замену `DailyKpiBar` (180 строк) и `GroupLifecycleDashboard` (233 строки) — но замена так и не была подключена, оставив мёртвыми все три поколения одновременно (1039 строк суммарно).
- ✅ **Удалено** — `DirectorCommandCenter.tsx`, `useDirectorCommandData.ts`, `DailyKpiBar.tsx`, `GroupLifecycleDashboard.tsx`. Ни один не имел внешних импортов, тестов или упоминаний в API-контрактах — чистый dead code, не future-feature.
- ✅ **`DirectorChangeFeed` смонтирован** (не удалён) — компонент был самодостаточным (свои loading/error/empty states), уже принимал тот же `refreshKey`-паттерн, что `PolicyConflictsPanel`/`OperationalDebtPanel` (`auditRefreshKey` в `Schedule.tsx`), а его единственный backend (`GET /schedule/audit/feed`) уже был RBAC-hardened (`analytics:read`, Part 6) и покрыт тестами в `scheduleOperationalControlRBAC.test.ts`. Добавлен как третья read-only панель в существующий модал «Операционный контроль» (`Schedule.tsx`) — второй control-center не создавался.
- ✅ **`GET /schedule/integrity` оставлен backend-only** — уже документирован в `API_CONTRACTS.md`, уже `analytics:read`, UI consumer не добавлялся (требует отдельного дизайна, не входит в operational control без явного product decision).
- ✅ **Doc fix** — `API_CONTRACTS.md`, секция `GET /schedule/attendance-dashboard`: роль в доке была устаревшей (`attendance:write`), обновлена до фактической `analytics:read` (захардкожено в Part 6, но доку тогда не поправили).
- ⚠️ **Remaining risk** — нет.

#### 2026-07-04 (Part 8 — Product Scope Correction: Operational Control = policy/conflict only)
- ⚠️ **Product decision superseding Part 5 and Part 7** — «Операционный контроль» на странице расписания определён как **schedule policy/conflict control only**, не generic operational-debt dashboard. Part 5 mounted `OperationalDebtPanel` (overdue attendance, cancelled-without-compensation, teacher/group risk counters) and Part 7 mounted `DirectorChangeFeed` (recent-changes feed) inside this modal — both are now **removed** (deleted, not just unmounted), because they don't belong in a policy/conflict control surface.
- ✅ **Удалено (UI)** — `OperationalDebtPanel.tsx`, `DirectorChangeFeed.tsx`, and all their wiring in `Schedule.tsx`: `hasOperationalDebt()`/`OperationalDebtSummaryResponse` type, `controlHasDebt` state, `handleOpenOverdueAttendance()`, the `operational-debt` half of `refreshControlIndicator()`, and the JSX mounts. The «Операционный контроль» modal now renders only `PolicyConflictsPanel`.
- ✅ **Удалено (backend)** — `GET /schedule/operational-debt` and `GET /schedule/audit/feed` routes in `routes/schedule.ts`, plus their backing read-model services `operationalDebtReadModelService.ts` and `scheduleAuditReadModelService.ts` in full (no other caller existed for either — confirmed by grep before deletion). `write-boundary-allowlist.json` entries for both files removed.
- ✅ **Тесты** — `operationalDebtBlockId.test.ts` deleted (tested only the deleted service). `scheduleOperationalControlRBAC.test.ts`: `PROTECTED_ENDPOINTS` trimmed to `/policy-conflicts` and `/attendance-dashboard` only. `jest.mock('../../services/{operationalDebtReadModelService,scheduleAuditReadModelService}')` calls removed from `d06CrossTenantEnrollment.test.ts` and `scheduleDetailsTimeBounds.test.ts` (would otherwise throw "Cannot find module" at test run since the mocked files no longer exist).
- ✅ **Не тронуто** — `GET /schedule/policy-conflicts`, `GET /schedule/attendance-dashboard`, `GET /schedule/integrity` (still backend-only, still `analytics:read`, still documented). `ScheduleActionLog` write-side lifecycle audit (`lib/auditLog.ts::logScheduleAction`, direct `scheduleActionLog.create` calls across `scheduleLifecycleService.ts`, `groupLifecycleService.ts`, `groupPromotionService.ts`, `salaryCorrectionService.ts`, `freezeService.ts`, `blockArchiveService.ts`) is unrelated write-side infrastructure, not touched — only the read-model that displayed it as a UI feed was removed.
- ⚠️ **Remaining risk** — нет. Schedule Operational Control is now single-purpose: policy/conflict transition control only.

#### 2026-07-04 (Part 9 — Live credit balance in group rows)
- ✅ **Live credit badge** — `GroupRow.tsx` StudentRow заменил статичный badge «кредит списан» на фактический баланс кредитов студента (`SchedStudent.cr`): зелёный при >0, красный при ≤0. Paid-until метка теперь всегда показывается («оплачено до —» когда не задано).
- ✅ **Backend отдаёт баланс без reload** — `submitAttendanceAndFinalize` возвращает `balances: [{ studentProfileId, credits }]` (post-deduction, внутри той же транзакции), `updateAttendanceWhileEditable` возвращает `credits` после коррекции. `GroupRow` применяет их через `sched.updateStudent(..., { cr })` — строка отражает новый (возможно отрицательный) баланс без полной перезагрузки расписания. Файлы: `services/attendanceFinalizationService.ts`, `GroupRow.tsx`, `hooks/useSchedule.ts`, `scheduleTypes.ts`.
- ✅ **Schedule GET** — membership select в `GET /schedule` добавил `credits` + `paidUntil` (после разбиения роутов — теперь в `routes/schedule/scheduleBlocks.routes.ts`), чтобы начальный рендер строки имел баланс. `useSchedule.ts::fmtPaidUntil` форматирует `paidUntil` ISO → `DD.MM.YYYY` для `SchedStudent.pd`.
- ✅ **Тесты** — unit tx-моки (`attendanceFinalizationService.test.ts`, `attendanceSameDay.test.ts`) получили `studentProfile.findMany/findUnique` stub, иначе post-write чтение баланса кидает. См. `API_CONTRACTS.md` submit-attendance / correction response.
- ✅ **Смена недели/дня без remount всей сетки** — `WeekGrid` перемонтировал всё поддерево через `key={viewWk}`/`key={mobileDay}` только чтобы переиграть CSS slide-анимацию (~1000 DOM-узлов перестраивались на каждую навигацию). Теперь ref + рестарт анимации inline-override'ом (`animation:'none'` → reflow → `''`) в useLayoutEffect — React диффит существующее дерево, анимация та же.

#### 2026-07-04 (Part 5 — Сдача посещаемости: ~200 → ~40 запросов в транзакции)
- ✅ **Batched submit-attendance** — `submitAttendanceAndFinalize` выполнял ~13 последовательных запросов НА КАЖДОГО студента (сессия, конфиг школы, existing attendance и FOR UPDATE lock — дублировались per-student). Теперь все инвариантные чтения выполняются один раз на группу: один `FOR UPDATE ... WHERE id IN (...) ORDER BY id` (детерминированный порядок — меньше риск deadlock), один `attendance.findMany`, один проход `sessionStudent` (findMany + createMany), один `schoolFinanceConfig`, один батч-запрос заморозок (`findActiveFreezesForSession` в freezeService — `findActiveFreeze` теперь делегирует ему), audit-записи через `createMany`. Замер на dev: сдача 15 студентов со списанием кредитов — **~250ms** (было 1–2s); повторная сдача ~100ms.
- ✅ **`markAttendance(pre?)`** — опциональный pre-контекст (сессия, existing, price, freeze) для батч-пути; вся guard-логика, atomic claim `creditDeducted`, идемпотентность и финансовые записи не изменены и выполняются по-прежнему per-student. Путь коррекции (PATCH одного студента) не тронут — без `pre` работает как раньше.
- ✅ **Redis cache invalidation после сдачи — fire-and-forget** — ответ больше не ждёт Redis SCAN (`teacher-cal:*`); худший случай — кэш календаря доживает свой TTL 120s.
- ✅ Проверено вживую: reopen → resubmit не списывает кредит повторно (балансы остаются −1, idempotent skip).

#### 2026-07-05 (Part 10 — Schedule trash/perf/legacy cleanup pass)
- ✅ **Dead code removed** — 7 unused types/consts from `scheduleTypes.ts` (HwTask, WaitlistEntry, SlotNote, AttSubmission, SubstituteOverride, SlotCtx, NC), unused style exports in `roomBlockStyles.ts`/`weekGridStyles.ts`, the dead `canOpenAttendance` field, `datesForWeekday`/`isAttendanceStatus` (only referenced by their own unit tests, removed together), and `ServerBlock.students` in `scheduleBlockMerge.ts` (LessonBlock has no such column). Backend: `reopenSession`/`lockSession`/`submitAttendance` (zero callers, including tests), `dispatchFreezeAppliedNotifications`/`dispatchFreezeReversedNotifications` (unused parallel dispatchers — `freezeService.ts` already notifies inline), `LifecycleContext`/`LifecycleTransitionResult` types, and a wasteful dead-relation include on the teacher-assign route. Kept as documented debt, not deleted: `assertLifecycleTransitionAllowed` and `buildLifecycleAuditPayload` have real dedicated test coverage despite no production caller; `invalidateSession` looks deliberately built (superadmin override + salary guard + notifications) but simply unwired.
- ✅ **Unused-import trim** — every one of the 9 split route files and 9 split lifecycle-service files still carried its full copy-pasted import header from before the `routes/schedule.ts` / `scheduleLifecycleService.ts` split; trimmed using `tsc --noEmit --noUnusedLocals --noUnusedParameters` as the source of truth.
- ✅ **Dedup** — session/cell key builders (`sessionKey`/`scKey` from `scheduleKeys.ts`) at ~20 call sites; 3 duplicated day-abbreviation arrays → `DAYS_SHORT`; duplicated `lessonWord` pluralizer; collapsed-rooms/collapsed-teachers localStorage readers → `readCollapsedMap()`; the mobile day-nav trio (`defaultMobileDay`/`prevDay`/`nextDay`, confirmed byte-identical in RoomsView/TeacherView/GroupView — WeekGrid's differs and was left alone) → `useMobileDayNav()` hook; `isAdminOrOwner()`/`normalizeScheduleDays()` added to `scheduleRouteUtils.ts` replacing 4 and 2 inline copies; `scheduleRouteUtils.ts`'s `checkStudentScheduleConflicts` renamed to `mapStudentScheduleConflicts` (collision with `scheduleValidation.ts`'s throwing function of the same name — naming trap, not a runtime bug); 3 hand-rolled roster-snapshot blocks in `scheduleEnrollment.routes.ts` replaced with `rosterService.ts`'s `reconcileRosterOnMemberAdd` (verified line-by-line equivalence first — `groupMembership.upsert` stays inline since that helper only owns the session-snapshot step).
- ✅ **Perf** — `RoomBlock` no longer recomputes the full week-dates array per card render (callers pass the single relevant date directly); `tzUtils.ts`'s `timeInTz` now caches its `Intl.DateTimeFormat` like its siblings; `MonthView`'s per-cell active/cancelled counts moved into a `useMemo`; `Schedule.tsx`'s `refreshAfterPolicyAction` wrapped in `useCallback`.
- ✅ **4 real bugs found and fixed while tracing the dead `StudentGroup.students` relation** (confirmed dead-on-write — nothing but `scripts/backfill-memberships.ts` reads it):
  1. **Reschedule never notified anyone** — `sessionReschedule.ts` fetched `.students` then read `.memberships` off the same never-populated shape, always `[]`. Root-caused: extracted `studentUserIdsFromMemberships()` into `lifecycleShared.ts`, migrated all 5 lifecycle files that build this list onto it.
  2. **`validateSingleSessionOverride`'s capacity fallback always read 0** from the dead relation, contradicting this file's own documented invariant. Fixed to count active `GroupMembership` rows.
  3. **`GET /schedule/available`'s seat count always read 0** — fed `MyClasses.tsx`'s capacity display/apply-disable, which as a result never worked. Fixed via a live `groupBy` count, response shape unchanged.
  4. **`GET /students` (list) never remapped `memberships → enrolledGroups`**, unlike its two sibling endpoints — `StudentPicker`'s "already enrolled elsewhere" badge never rendered. Extracted `mapEnrolledGroups()`, migrated all 3 endpoints onto it.
- ✅ **Docs** — fixed stale references to the now-deleted monolithic `routes/schedule.ts` in this file, `SCHEDULE_UI_CONTRACT.md`, and the "Follow-up" note in Part 1 above (which described bugs already fixed by the time of this audit, not the ones actually still broken). `SCHEDULE_LIFECYCLE_RFC.md`'s `Status: DRAFT` header corrected — content has been fully implemented for a while.
- ✅ **Verification** — server: `tsc --noEmit` clean, full Jest suite `--runInBand` (94 suites / 1290 tests, all green except a pre-existing unrelated `dbIdempotency` infra issue confirmed by isolated rerun) plus every targeted regression test for the 4 bug fixes. Client: `tsc --noEmit` clean, full vitest suite green.
- ⚠️ **Remaining risk / logged debt (not touched, reasons in the branch's final report)** — `CreateGroupForm.tsx` capacity thresholds vs. `scheduleConflicts.ts`'s `checkCapacity` (different values — product decision, not cleanup); bare-key localStorage fallback for collapsed rooms/teachers (user-preference migration compat); `POST /fix-block-days` 410 tombstone (intentional deprecation signal); `invalidateSession` (unwired, flag for owner); `window.confirm()` in `GroupRowStudentRow.tsx`/`SlotPanel.tsx` and `handleRealtimeStructureRefresh`'s missing debounce (both are behavior changes, this pass only reports per its own rules, doesn't silently fix); a handful of genuinely-unused local variables outside import headers (`scheduleGroupPair.routes.ts`, `schedulePolicy.routes.ts`, `lifecycleGuards.ts` — different cleanup category than this pass covered).

#### 2026-07-05 (Part 11 — Stale conflict false positives from completed/closed blocks)
- ✅ **Every conflict/limit check in `scheduleValidation.ts` false-positived against long-closed blocks** — a `StudentGroup` keeps its `GroupMembership` rows `ACTIVE` through `COMPLETED` status by design (only `archiveGroup()` withdraws them — see `groupLifecycleService.ts`); `completeGroup()`/`GroupPromotionService.promoteGroup()` only close the group's `LessonBlock`s via `endDate` + `status: 'COMPLETED'`, `deletedAt` stays `null`. Five separate queries only filtered `deletedAt: null` without excluding already-closed (`endDate` in the past) blocks — `findStudentScheduleConflicts`, the cabinet-conflict check, the teacher-conflict check, the grammar/club sibling-day check (all in `validateScheduleBlock`), and `checkTeacherWorkload`'s max-lessons-per-day count. Reproduced with a real promoted group (`COMPLETED`, blocks closed via `endDate` but not deleted, memberships still `ACTIVE`): creating a new pair at the old slot threw both a false "student already in group X" conflict and a false "teacher already teaches group X" conflict, while the grid correctly showed nothing scheduled there (the blocks really are closed — the grid wasn't the bug). Fixed by adding a shared `stillLiveBlockFilter()` helper (same "still live" cutoff `GET /schedule` already uses: `endDate: null OR endDate >= startOfToday`) to all 5 query sites. Verified against the real dev-DB rows that reproduced both symptoms (conflict source now empty for the student and the teacher) plus full `scheduleValidation.test.ts` unit suite (20/20) and the `groupPromotion`/`groupLifecycle`/`groupCompletionSemantics`/`scheduleVersioningInvariant`/`groupPairValidation` integration suites, all green.
- ⚠️ **Two related predicate divergences found, deliberately not fixed here (flagged for a separate decision)**: (1) a block `CANCELLED` via `PATCH /:id/status` (no `endDate`/`deletedAt` change) is correctly excluded from the schedule grid but still passes `stillLiveBlockFilter` — i.e. still counts as a live conflict source; folding a `status !== 'CANCELLED'` guard into these 5 queries is a broader "does cancelling free the slot immediately" product decision, not a drive-by fix. (2) `scheduleAvailability.routes.ts`'s student-facing `GET /available` has no `endDate` awareness at all — same class of bug, but out of scope for an Owner/Admin-facing fix.

#### 2026-07-06 (Part 12 — Read-only truth card action guards)
- ✅ **Closed the remaining gaps between `group.isReadOnly` (block-level truth: COMPLETED/CANCELLED/closed/SOFT_DELETED) and GroupRow's action gating** — Part 10/11 folded `isReadOnly` into `scheduleReadOnly` for most gates, but a few still read the raw panel-level `scheduleReadOnly` prop or nothing at all, so a tombstoned-but-not-panel-locked card (e.g. `blockVisibility: SOFT_DELETED` with `group.status` still `ACTIVE`) could leak live actions: "+ Добавить студента" had no read-only check whatsoever; the `autoOpenEditGroup` effect recomputed `groupEditLocked` locally from the bare prop; `canResumeGroup` never checked `isTeacher` or read-only at all (a paused+tombstoned group's Resume button stayed clickable); `GroupActionsMenu`'s pause/resume/complete/delete sections were gated by the raw prop so they still rendered (individually disabled, not hidden) on a tombstoned card.
- ✅ **Fix** — one `effectiveReadOnly = scheduleReadOnly || !!group.isReadOnly` in `GroupRow.tsx`, routed through all of the above instead of each gate re-deriving the OR independently. `canBook`/`canChapter` in `groupRowActionState.ts` already used this pattern (in-flight fix carried over from the prior session) — now every gate does.
- ✅ **Tests** — extended `groupRowActionState.test.ts`'s existing `scheduleReadOnly: true` cases to also assert `canBook`/`canChapter`, and to assert `isGroupActive: true` alongside every action being `false` — proves a SOFT_DELETED tombstone with the group lifecycle still `ACTIVE` has no active actions, not just an archived/completed group.
- ✅ **Verification** — client: full vitest suite green (189/189), `tsc`/`vite build` clean. Server: untouched by this change, `tsc --noEmit` clean (sanity check only).
- **Файлы:** `client/src/components/schedule/GroupRow.tsx`, `client/src/components/schedule/groupRowActionState.ts`, `client/src/components/schedule/groupRowActionState.test.ts`.

#### 2026-07-13 (Part 13 — Promote same-day double-booking + GroupDetail delete/promote gaps)

- ✅ **Root cause: `completeGroup()`'s `effectiveDate` default was a raw timestamp, not a calendar-day boundary** — `groupLifecycleService.ts::completeGroup` defaulted `effectiveDate` to `new Date()` (exact click time). `LessonSession.date` is always stored at `T12:00:00Z` for its calendar day, so whether *today's own* session got invalidated silently depended on whether the group was completed before or after 12:00 UTC — a group promoted in the evening (school-local time, UTC+6) left today's now-superseded session sitting as if nothing happened, while the block itself flipped to `COMPLETED`. Fixed by defaulting `effectiveDate` to UTC-midnight of "now" (`groupLifecycleService.ts:222`), matching the explicit `T00:00:00.000Z` normalization the manual `POST /blocks/:id/complete-group` route already used — today's session is now reliably in scope for invalidation regardless of time of day.
- ✅ **Root cause: `GroupPromotionService.promoteGroup` started the new group's copied blocks "now" while the source group's blocks stayed valid through today (`endDate: effectiveDate`, inclusive)** — same teacher/cabinet/day/time template existed in both groups for the promotion day, so the schedule grid rendered both group cards in the same cell and flagged a false `⚠ Конфликт учителя`. Fixed: when `completeSourceGroup` is true (the default, used by the "Повысить уровень" button), the new group's blocks now start the day *after* `effectiveDate` — `groupPromotionService.ts` computes one shared `effectiveDate` and passes it into `completeGroup()` so both boundaries derive from the same instant. When `completeSourceGroup=false` (deliberate parallel-run/fork via direct API use), behavior is unchanged — that path already requires manual re-scheduling since it copies the same teacher/cabinet verbatim onto a still-active source.
- ✅ **`GroupDetail.tsx` — "Удалить группу" always failed on non-COMPLETED groups** — `DELETE /groups/:id` → `archiveGroup()` requires `status === 'COMPLETED'` (canonical policy, `groupLifecyclePolicy.ts`), but the page's delete button had no status gate and no permission gate, so clicking it on an ACTIVE/PAUSED group (the common case) always 422'd with "Only completed groups can be archived," and ADMIN saw the button too even though the route is OWNER-only. The already-existing but never-wired `GroupActionModal.tsx` (built for exactly this: status-aware Завершить/Приостановить/Возобновить/Архивировать/Удалить, `canArchiveGroup`-gated) is now wired into `GroupDetail.tsx`, replacing the raw delete button. `usePermissions().canArchiveGroup` now also gates the "Повысить уровень" button (previously visible to ADMIN, always 403'd server-side).
- ✅ **`GroupDetail.tsx` — promote left the admin on the wrong (now-completed) group** — `promoteLevel()` re-fetched the same `groupId` after promoting instead of following the newly-created group returned by `POST /groups/:id/promote` (`data.newGroup.id`). Now navigates to the new group's detail page directly.
- ✅ **Verification** — server: `tsc --noEmit` clean, `groupLifecyclePolicy.test.ts` unit suite green (74/74, pure logic, no DB). Integration suites (`groupPromotion.test.ts`, `groupLifecyclePolicyGuards.test.ts`, etc.) hit a pre-existing, unrelated test-DB drift (`User.username` column missing from the test database — not touched by this change) and could not run to completion; not caused by this diff. Client: `tsc --noEmit` clean.
- **Файлы:** `server/src/services/groupLifecycleService.ts`, `server/src/services/groupPromotionService.ts`, `client/src/pages/dashboard/admin/GroupDetail.tsx`.

#### 2026-07-07 (Part 13 — Убран reason-prompt при переоткрытии посещаемости + чистка галочек в тостах)
- ✅ **«Редактировать посещаемость» открывает редактирование сразу** — удалён `AttendanceReopenModal` (попап «Причина изменений»). Клик по кнопке теперь напрямую вызывает `handleReopenAttendance`, без обязательного комментария. Reason больше не требуется ни при reopen, ни при последующих корректировках: `assertReason` удалён, `reopenAttendance` и `updateAttendanceWhileEditable` пишут `normalizeReason(...) || null` в аудит (who/when по-прежнему фиксируются). Два серверных теста на `ATTENDANCE_REASON_REQUIRED` удалены.
- ✅ **Убраны хвостовые ✓ в тостах** — `toast.success('Посещаемость сдана')` и `toast.success('Добавлен')` (у тостов react-hot-toast уже есть зелёная иконка-галочка слева). Это были единственные два тоста с ✓ во всём клиенте.
- **Файлы:** `server/src/services/attendanceFinalizationService.ts`, `server/src/__tests__/unit/attendanceFinalizationService.test.ts`, `client/src/components/schedule/GroupRow.tsx`, `client/src/components/schedule/useGroupRowActions.ts`, удалён `client/src/components/schedule/AttendanceReopenModal.tsx`.

#### 2026-07-07 (Part 14 — StudentGroup.name удалён; группы идентифицируются по level/chapter)
- ✅ **Колонка `StudentGroup.name` удалена из схемы** (миграция `20260707000000_drop_student_group_name`) — имя группы убрано из продукта, группа идентифицируется парой level/chapter. Все server-роуты/сервисы (`groups.ts`, `groupPromotionService.ts`, `waitlistService.ts`, `policyService.ts`, `importexport.ts` и др.) и клиент (Groups, GroupDetail, CreateGroupForm, EditGroupPanel, GroupEditorModal, PromoteResultModal и др.) переведены на level/chapter; в таблице Групп колонка «Глава» заменена на «Кабинет».
- ✅ **Общий `ui/SearchInput`** — единый компонент поиска заменил ad-hoc инпуты на страницах дашборда (Groups, Students, Teachers, Salary, Schools, Staff и др.).
- ✅ **Юнит-тесты выровнены с изменениями поведения** — `SESSION_CANCELLED` исключён из `EVENTS_REQUIRING_REASON` (причина отмены опциональна); same-day markability: сессия «сегодня» размечается весь календарный день, не только после startTime (`hasSessionStarted` в `tzUtils.ts`, изменение из Part 13/10cc5f83).
- **Файлы:** `server/prisma/schema.prisma`, `server/prisma/migrations/20260707000000_drop_student_group_name/`, `server/src/services/scheduleLifecycleTypes.ts`, `server/src/__tests__/unit/scheduleLifecycleService.test.ts`, `server/src/__tests__/unit/attendanceSameDay.test.ts`, `client/src/components/ui/SearchInput.tsx` (новый) + затронутые страницы/компоненты.
- ✅ **Инфраструктура интеграционных тестов: устранена утечка соединений** — каждый integration-сьют держал пул синглтона `lib/prisma` (роуты), jest сбрасывает module registry между сьютами без disconnect → пулы копились и исчерпывали `max_connections` Postgres в середине прогона (симптом: `too many clients already`, 500-ки в случайных сьютах). Добавлен `setupFilesAfterEnv` (`helpers/disconnectPrisma.setup.ts`): грузит `.env.test` до импортов сьюта и делает `$disconnect()` синглтона в `afterAll` (лениво, устойчиво к `jest.mock`). Полный integration-прогон: 73/73 сьютов, 920/920 тестов зелёные.

#### 2026-07-08 (Part 15 — Комментарий к группе)
- ✅ **`StudentGroup.comment` (nullable TEXT)** — свободный текст-заметка на группу (миграция `20260708000000_add_group_comment`). Настраивается внутри группы (`GroupDetail` — textarea в форме «Редактировать», доступна при любом статусе, не только ACTIVE; maxLength 2000, сервер обрезает по 2000). `PUT /groups/:id` принимает `comment` (пустая строка → `null`). GET-роуты (список и `/:id`) возвращают поле автоматически (spread). В таблице Групп добавлена колонка «Комментарий» (truncate + title tooltip); в шапке `GroupDetail` комментарий показан под учителями.
- **Файлы:** `server/prisma/schema.prisma`, `server/prisma/migrations/20260708000000_add_group_comment/`, `server/src/routes/groups.ts`, `client/src/pages/dashboard/admin/Groups.tsx`, `client/src/pages/dashboard/admin/GroupDetail.tsx`.

#### 2026-07-08 (Part 16 — paidUntil: один источник правды, устранён рассинхрон с балансом)
- ✅ **Симптомы:** студент с 0 кредитов показывал «оплачено до 12.08.2026» (зелёным), студент с 25 кредитами — «оплачено до 26.05.2026» (красным). Деньги/уроки не терялись — `credits` + `LessonCreditLog` точны; врала производная дата `StudentProfile.paidUntil`. Три причины: (1) дата — проекция от «сегодня» на момент последнего события баланса, без событий она молча уезжает в прошлое; (2) импорт писал `paidUntil` сырьём из Excel и менял `credits` без пересчёта — прямое нарушение контракта «единственный писатель `recomputeAndPersistPaidUntil`»; (3) `StudentPaymentModal` (мёртвый компонент, ноль импортов) содержал фантомный редактор даты — сервер `paidUntil` из body игнорирует, модалка после «сохранения» показывала несохранённую дату.
- ✅ **Cron `paidUntilRecompute`** — ежедневный + при старте: пересчёт `paidUntil` из баланса для всех школ через существующий `recomputePaidUntilForSchool()` (батчи по 500, рассчитан на 50k+). Лечит дрейф времени и любые пропущенные события — событийные хуки в принципе не могут закрыть «время идёт», периодический пересчёт закрывает всё.
- ✅ **Импорт больше не пишет `paidUntil`** — удалены записи даты из файла во всех трёх путях (update/restore/create) + `parsePaidUntil` (сервер); после любого изменения `credits` — `recomputeAndPersistPaidUntil` в той же транзакции. Если в файле есть колонка paidUntil — в отчёт импорта добавляется `[INFO]`, что колонка игнорируется и дата рассчитывается из баланса.
- ✅ **Удалён `StudentPaymentModal.tsx`** — мёртвый код с фантомным редактором даты.
- **Инвариант:** `StudentProfile.credits` (+ledger) — единственный источник правды оплаты; `paidUntil` — derived/display-only, единственный писатель `recomputeAndPersistPaidUntil()`, свежесть гарантируется событиями баланса + ежедневным cron.
- ✅ **Cron `financialConsistency` (сторож)** — `consistencyCheckService.runChecks()` (15 финансовых проверок) раньше запускался только вручную (админ-эндпоинт, после импорта, скрипт); теперь ежедневно для всех школ, report-only: CRITICAL → `log.error` (`FINANCIAL_ALERT`, попадает в Sentry), WARNING → `log.warn`. Никаких авто-починок.
- ⚠️ **Первый прогон сторожа сразу нашёл (dev-БД, зафиксировано для отдельного разбора, в этом PR не трогалось):** (1) CRITICAL — 18 zombie-сессий (активные `LessonSession` под архивированным `LessonBlock`); (2) 6,2 млн строк `SessionStudent` при 9 170 сессиях: 9 086 сессий навсегда в UPCOMING, ростер-снапшоты по 1 033 студента на сессию — при выходе студента из группы (WITHDRAWN) его снапшоты будущих сессий не удаляются, «сессии-призраки» копятся; (3) предикат check6 слишком широкий — флагает студента с ЛЮБЫМ withdrawn-членством где угодно, а не вышедшего из группы этой сессии (шумит на 6,2 млн строк).
- **Файлы:** `server/src/lib/cronJobs.ts`, `server/src/routes/importexport.ts`, удалён `client/src/components/ui/StudentPaymentModal.tsx`.

#### 2026-07-08 (Part 17 — Управление кабинетами в настройках)
- ✅ **`CabinetsCard` в CRM Settings → вкладка «Расписание»** — раньше кабинеты добавлялись только в мастере онбординга (после завершения — недоступен); теперь список/добавление/переименование/удаление доступны OWNER в настройках. Эндпоинты `GET/POST /settings/cabinets`, `DELETE /settings/cabinets/:id` (`settings:write`) существовали; сервер блокирует удаление кабинета, занятого в активных блоках, и дубликаты имён — ошибки показываются как есть. Удаление через `ConfirmModal`, никакого autosave (каждое действие — явный клик).
- ✅ **`usageCount` в `GET /settings/cabinets`** — число активных блоков на кабинет (filtered `_count`, один запрос); в списке показывается «N занятий / не используется», так что ещё до клика «Удалить» видно, какой кабинет занят.
- ✅ **`PATCH /settings/cabinets/:id`** (новый, `settings:write`) — переименование и смена вместимости; пропущенные/невалидные поля сохраняют текущие значения, пустое имя и дубликат → 400, чужая школа → 404. Инлайн-редактирование строки в `CabinetsCard` (Изменить → инпуты → Сохранить/Отмена). Блоки ссылаются на кабинет по id — переименование безопасно для расписания.
- **Тесты:** `settingsCabinets.test.ts` (integration, 5 шт.) — usageCount считает только не удалённые блоки; PATCH rename/capacity, фолбэк на текущие значения, дубликат/пустое имя, cross-tenant 404.
- **Файлы:** `client/src/pages/dashboard/admin/CrmSettings.tsx`, `server/src/routes/settings.ts`, `server/src/__tests__/integration/settingsCabinets.test.ts`.

#### 2026-07-08 (Part 18 — Заморозка больше не перезаписывает статус посещаемости)
- ✅ **Студента на паузе теперь можно отметить present/absent — отметка сохраняется** — раньше `markAttendance` при активной заморозке жёстко ставил `status='FROZEN'`, из-за чего любой выбор админа отображался как «Отсутствует». Убрали перезапись: `effectiveStatus = status` в обеих ветках (UPDATE/CREATE). **Финансовая гарантия не изменилась** — пропуск списания по-прежнему полностью управляется `isFreezeSkip` → `creditDeducted=false` + запись `FREEZE_SKIP` в `LessonCreditLog`; поле `status` было и остаётся чисто отображаемым. Синий значок «на паузе» теперь привязан к текущему состоянию заморозки студента (`st==='ho'`), а не к статусу посещаемости: показывается всегда, пока студент на паузе, и снимается только снятием с паузы (`showPaused = s.st === 'ho' || frozenStudentIds.has(s.id)`). `frozenStudentIds` оставлен для подсветки legacy-строк со статусом `FROZEN`.
- **Файлы:** `server/src/services/attendanceService.ts`, `client/src/components/schedule/GroupRow.tsx`, `GroupRowStudentRow.tsx`, `useGroupRowActions.ts`. Тесты обновлены под новый контракт: `__tests__/unit/attendanceService.test.ts`, `__tests__/integration/freezeSystem.test.ts`.
- ✅ **Метка «на паузе» на дашбордах студента/родителя** — раз урок замороженного студента теперь хранит реальный present/absent, добавили отдельный индикатор «на паузе» рядом со статусом, чтобы факт паузы не терялся. Сигнал per-lesson: `creditDeducted === false` (freeze-skip) либо legacy `status === 'FROZEN'`. Такие уроки по-прежнему исключаются из процента посещаемости. Только клиент — бэкенд-эндпоинты (`/students/me/attendance`, `/schedule/student`, parent) уже отдают `creditDeducted`. **Файлы:** `client/src/pages/dashboard/student/Attendance.tsx`, `Overview.tsx`, `Schedule.tsx`, `parent/ParentDashboard.tsx`.

#### 2026-07-08 (Part 19 — Сданная посещаемость редактируется как черновик, сохранение по одной кнопке)
- ✅ **Убран отдельный клик «Редактировать посещаемость» + per-click сохранение** — раньше сданную посещаемость надо было сначала переоткрыть (кнопка), после чего каждый клик по студенту сразу писался на сервер (`PATCH /session/:id/attendance`). Теперь сданная сессия редактируется как **локальный черновик** точно так же, как ещё не сданная: клики по пилюлям только меняют `group.stu[].ta` в памяти (`cycleAttendance`), на сервер ничего не летит. Единственная кнопка внизу карточки теперь называется **«Сохранить изменения»** и при нажатии делает `reopen` (без причины) → `submit-attendance` одним действием (`reopenThenSubmit`).
- ✅ **Причина переоткрытия удалена из UI** — поля ввода причины не было и раньше (`reopen` слал `{}`); убрали отображение «Причина: …» и мёртвую передачу `attendanceReopenReason` в коррекцию. Бэкенд по-прежнему принимает `reason` как опциональный — контракт не менялся.
- **Финансовая гарантия не изменилась** — повторный `submit-attendance` после `reopen` идемпотентен по кредитам: флаг `Attendance.creditDeducted` write-once, поэтому `markAttendance` даёт `CREDIT_SKIP_IDEMPOTENT` (нет двойного списания; смена present↔absent не возвращает кредит — absent тоже тарифицируется, как и было). Аудит сохранён: `AttendanceAudit` пишет каждую смену статуса + `REOPEN`/`FINALIZE`.
- **Удалено:** per-student correction path (`handleToggleStudent`, `savingStudentId`, `studentCorrErrors`, `correcting`/`correctionError`) и `handleReopenAttendance` — заменены черновиком + batch-submit.
- **Файлы:** `client/src/components/schedule/groupRowActionState.ts` (finalized → editable draft, лейбл «Сохранить изменения»), `GroupRowStudentRow.tsx` (всегда локальный `cycleAttendance`), `useGroupRowActions.ts` (`reopenThenSubmit`), `GroupRow.tsx` (rewire). Тест: `groupRowActionState.test.ts` (+2 кейса на finalized-draft и блокировку при неотмеченном студенте). Бэкенд не менялся.

#### 2026-07-08 (Part 20 — Аудит всей денежной математики + 3 бага в зарплате)
- ✅ **Полный аудит money-math** по слоям: кредиты (deduction/issuance/refund/void/adjustment), пропорциональный биллинг (`moneyBalance`/`billingLessonsGranted`), инвойсы/аллокации (`paymentService`), зарплата (`salary.ts`), аналитика. Вердикт: `creditIssuanceService`, `refundService`, `paymentService`, `financialAdjustmentService`, биллинг в `students.ts` — образцовые (Decimal-математика, FOR UPDATE-локи, идемпотентность, ledger, clamp-ы, unique-констрейнты). Найденные баги — все в `salary.ts`:
- ✅ **БАГ 1 (главный): двойное/нулевое применение корректировок при частичных выплатах.** `adjustmentNet` отбирался по окну дат оплачиваемых сессий: две частичные выплаты с пересекающимися окнами вычитали один штраф ДВАЖДЫ; «полная» выплата после частичной брала весь месяц заново; корректировка, датированная вне всех окон, не применялась никогда. **Фикс:** учёт применённого — `remainingAdjustmentNet = monthAdjustmentNet(корректировки месяца) − appliedAdjustmentNet(прошлые выплаты)`, где применённое выплатой = `amount − lessonsCount × rateSnapshot` (эффект clamp ≥ 0 автоматически переносит недоприменённый штраф на следующую выплату; rateSnapshot каждой выплаты свой — смена ставки не искажает). Инвариант: за период корректировки применяются РОВНО один раз. Свойство самопочинки: по историческим данным, испорченным старой логикой, следующая выплата автоматически докомпенсирует разницу. Оконная логика (`isFullPayment`/`adjDateFilter`) удалена целиком. `remainingAmount` в GET /salary исправлен той же формулой.
- ✅ **БАГ 2: `POST /salary/adjustment` не валидировал amount** — NaN/отрицательное/гигантское число принималось (отрицательный «бонус» = скрытый штраф в обход OWNER-права). Теперь: конечное положительное ≤ 10 млн, иначе 400.
- ✅ **БАГ 3: `DELETE /salary/adjustment/:id` позволял удалить корректировку, уже применённую выплатой** (создание после выплаты запрещено гардом PERIOD_ALREADY_PAID, а удаление — не было). Теперь симметричный гард: 409 PERIOD_ALREADY_PAID.
- ✅ **Мелочь: `POST /credits/add`** — amount теперь валидируется как ненулевое целое ±10 000 (раньше дробное/Infinity падало 500-кой из Prisma), paymentAmount — конечное неотрицательное ≤ 10 млн.
- ✅ **Тесты:** новый `salaryAdjustmentMath.test.ts` (5 тестов: штраф один раз на две выплаты, clamp-перенос большого штрафа, бонус не дублируется, смена ставки) — чистые функции `monthAdjustmentNet`/`appliedAdjustmentNet`/`remainingAdjustmentNet` экспортированы из `salary.ts`. Полный unit-прогон PASS; интеграционные `salaryAttribution`/`salaryConsistency`/`salaryCorrectionFlow`/`creditLedger`/`financialConsistency`/`refundsAdjustments` PASS.
- ℹ️ **Отмечено, не баг:** зарплатные суммы считаются в JS-числах (не Decimal) — при 2-значных суммах погрешность (~1e-10) гасится округлением Decimal(10,2) при записи; `GET /credits/logs` без пагинации (перф, не учёт); аналитика — display-only округления.
- **Файлы:** `server/src/routes/salary.ts`, `server/src/routes/credits.ts`, `server/src/__tests__/unit/salaryAdjustmentMath.test.ts` (новый).

#### 2026-07-09 (Part 21 — Визуальный рефайн панели «Редактировать группу»)
- ✅ **Визуальная полировка `EditGroupPanel` (стили только, ноль логики)** — типографика/отступы/радиусы по 8px-ритму: заголовок 15px, поля 13px с фокус-кольцом и hover (новый класс `.sch-field` в `index.css` — inline-стили не умеют `:focus`/`:hover`), карточки Грамматика/Клуб с левой акцентной полосой, ⚠-предупреждения как мягкие чипы (`--sch-orange*`), кнопки 40px с transition/hover (`.sch-btn-primary/-outline/-ghost`), крестик как icon-button (`.sch-icon-btn`), кружки дней 32px с hover (`.sch-day`).
- ✅ **Починен дарк-мод в этих компонентах** — захардкоженные light-only цвета заменены токенами: белые кружки дней (`#fff` → `--sch-bg`), бордеры карточек `#a5d6a7`/`#90caf9` → новые токены `--sch-green-border`/`--sch-blue-border` (+ `--sch-border-hover`), вся локальная палитра `teacherAvailabilityStyles.ts` → `--sch-*` vars (дропдаун учителя был белым в тёмной теме), баннеры статуса/read-only и сплит-диалог (`#fff` → `--sch-bg`). Триггер выбора учителя теперь использует `.sch-field` — единый вид с нативными селектами.
- **Файлы:** `client/src/index.css` (токены + классы `.sch-*`), `client/src/components/schedule/scheduleTheme.ts`, `EditGroupPanel.tsx`, `DaySelector.tsx`, `TeacherAvailabilitySelect.tsx`, `teacherAvailabilityStyles.ts`. `DaySelector`/`TeacherAvailabilitySelect` также используются в `CreateGroupForm` и `GroupDetail` — полировка распространяется туда же.

#### 2026-07-09 (Part 22 — Перф-проход для слабого железа: layout-анимации, backdrop-blur, transition-all, lazy Sentry)
- ✅ **Сайдбар: мгновенное открытие/закрытие** — убраны `transition-[width]` с `<aside>` (`Sidebar.tsx`) и `transition-all` по `margin-left` с `<main>` (`Layout.tsx`): анимация layout-свойств пересчитывала раскладку всей страницы каждый кадр (главный источник лагов на слабых машинах). Мёртвый `willChange: 'width'` удалён.
- ✅ **WeekGrid (мобайл): панель дней больше не анимирует `max-h` во время скролла** — коллапс по `navHidden` теперь мгновенный (было: reflow всей сетки каждый кадр 200-мс анимации прямо в процессе скролла).
- ✅ **`backdrop-blur` удалён во всём клиенте (33 места)** — самый дорогой CSS-эффект для слабых GPU (пересчёт размытия каждый кадр под движущимся контентом): мобильная нижняя навигация, оверлеи всех модалок, липкие шапки лендингов. Где блюр маскировал прозрачный фон, поднята непрозрачность (Landing header 48→92, AuthCard 70→90, Header 82→95, SchoolLanding nav 80→95).
- ✅ **`transition-all` → `transition` (150 мест)** — дефолтный Tailwind-transition покрывает цвета/opacity/shadow/transform, но не layout-свойства; случайные анимации padding/размеров при смене классов исключены. Два прогресс-бара, намеренно анимирующих ширину, переведены на `transition-[width]` (`OwnerOnboarding.tsx`, `Students.tsx`).
- ✅ **Sentry вынесен из стартового бандла** — `@sentry/react` (~39 KB gzip) теперь грузится динамическим импортом после первой отрисовки (`main.tsx` → новый `client/src/lib/sentry.ts`); без `VITE_SENTRY_DSN` чанк не грузится вообще. Entry-чанк в проде с Sentry легче на ~39 KB gzip.
- **Файлы:** `client/src/components/layout/{Sidebar,Layout,AuthLayout,Navbar}.tsx`, `client/src/components/schedule/WeekGrid.tsx`, `client/src/main.tsx`, `client/src/lib/sentry.ts` (новый), + ~50 файлов механической замены классов. Тесты: 191 PASS, build PASS.

#### 2026-07-10 (Part 23 — Финансовый контроль: существующие проверки стали видимы владельцу)
Идея из `anthropics/financial-services` (fund-admin: GL recon / break-trace): найденный break должен доходить до человека с объяснением причины и рекомендацией — «staged for human sign-off». Детекция уже была (15 checks + R1–R7), но жила только в логах/Sentry.
- ✅ **Страница «Финансовый контроль» (OWNER)** — новый `client/src/pages/dashboard/owner/FinanceControl.tsx`, роут `/owner/finance-control`, пункт в сайдбаре. Дёргает существующие `GET /admin/consistency-check` + `GET /admin/reconciliation`, показывает статус «✅ всё сходится / ⚠️ N проблем» и карточки: русское название, объяснение, «Что делать», количество, ID записей. Русские тексты — маппинг на клиенте по `check`-строке / `issueType` с graceful fallback на серверный текст для новых проверок. Read-only: страница ничего не чинит сама.
- ✅ **Watchdog → уведомление владельцу** — `financialConsistencyWatchdog` (cronJobs.ts) при CRITICAL-нарушениях теперь шлёт `notifySchoolAdmins` (тип `FINANCIAL_CONSISTENCY_ALERT`, агрегат по школе). Крон суточный → максимум одно уведомление в день на школу, отдельный дедуп не нужен.
- ✅ **check13 без слепой зоны** — сверка `StudentProfile.credits ≟ sum(LessonCreditLog)` раньше брала фикс. `take: 500` (студенты 501+ не проверялись никогда); теперь полный проход батчами по 1000 через id-курсор (`consistencyCheckService.ts`).
- **Файлы:** `server/src/services/consistencyCheckService.ts`, `server/src/lib/cronJobs.ts`, `client/src/pages/dashboard/owner/FinanceControl.tsx` (новый), `client/src/router/index.tsx`, `client/src/components/layout/Sidebar.tsx`. TypeScript PASS (оба), client build PASS, financialConsistency-тесты 34/34 PASS, smoke live-эндпоинтов PASS.

#### 2026-07-10 (Part 24 — Месячная выписка-выверка по кредитам (roll-forward))
Идея из `anthropics/financial-services` (fund-admin: roll-forward + NAV tie-out): «Opening + activity = Closing; the schedule must foot — if it doesn't, surface, don't plug». Журнал кредитов существовал, но не был виден в UI ни в каком виде.
- ✅ **`GET /credits/statement/:studentProfileId?month=YYYY-MM`** — roll-forward по `LessonCreditLog`: `opening + added + deducted = closing` + foot-check `profile.credits ≟ sum(ledger)` (all-time, поле `foots`). Расхождение возвращается явно, не маскируется. Границы месяца — UTC (`ponytail:` комментарий с upgrade path на School.timezone). Тенант-гард, `finance:read`.
- ✅ **Компонент `CreditStatement`** (`components/ui/CreditStatement.tsx`, новый) — сворачиваемая выписка в PaymentTab карточки студента (`Students.tsx`): селектор месяца (12 мес.), «Было на начало → строки → Стало на конец», красный баннер при `foots=false`. Ленивая загрузка при первом раскрытии.
- ✅ **Кросс-периодная непрерывность бесплатно** — closing месяца N = opening месяца N+1 автоматически (обе цифры — суммы по одному append-only журналу); подтверждено live-smoke (июнь −2 → июль opening −2).
- ℹ️ Зарплатная выверка НЕ дублировалась: Payslip уже показывает «Выплачено X · осталось Y» (computed vs paid tie-out существует).
- **Файлы:** `server/src/routes/credits.ts`, `client/src/components/ui/CreditStatement.tsx` (новый), `client/src/pages/dashboard/admin/Students.tsx`, `API_CONTRACTS.md`. Тесты: новый `creditStatement.test.ts` 4/4 PASS (roll-forward math, foot-check, tenant isolation, bad month). TypeScript PASS (оба), client build PASS, live-smoke PASS.

#### 2026-07-11 (Part 25 — Help-топики: со School-уровня на platform-уровень (SUPERADMIN))

Не про расписание, но здесь единственный обязательный changelog для схемных изменений по правилу CLAUDE.md.

- ✅ **Новая singleton-таблица `PlatformSettings` (id всегда 1)** — платформенный конфиг вне мульти-тенантной модели; см. `DATABASE_CONSTRAINTS.md`. Миграция `20260711000000_add_platform_settings`.
- ✅ **Help-топики переехали со School-уровня на platform-уровень** — раньше каждый OWNER школы редактировал свои топики (`School.settings.help`, вкладка «Помощь» в CrmSettings), теперь один набор топиков на весь платформенный `/help`, редактируется только SUPERADMIN. Публичный `GET /api/settings/help` (читают все роли всех школ) теперь читает `PlatformSettings`, а не `School.settings`. `PATCH /api/settings/help` удалён; новые `GET/PATCH /api/superadmin/help` (SUPERADMIN-only) в `routes/superadmin.ts`.
- ✅ **Вкладка «Помощь» удалена из `CrmSettings.tsx`** (`HelpTab`, tab-запись); функционал воссоздан в `pages/dashboard/superadmin/Settings.tsx` (`HelpTopicsSection`) с той же валидацией на клиенте (`normalizeHelpUrl`).
- **Не изменилось:** `Help.tsx` (публичная страница) и `lib/helpTopics.ts` (sanitize/read) — эндпоинт и форма ответа те же, поменялся только источник данных на сервере.
- **Файлы:** `server/prisma/schema.prisma`, `server/prisma/migrations/20260711000000_add_platform_settings/`, `server/src/routes/settings.ts`, `server/src/routes/superadmin.ts`, `client/src/pages/dashboard/admin/CrmSettings.tsx`, `client/src/pages/dashboard/superadmin/Settings.tsx`. Тесты: `helpTopics.test.ts` 9 PASS (lib не менялась). TS: client + server чисто.

#### 2026-07-11 (Part 26 — check6 исправлен, выписка для студента, таймзонные границы, dev-БД синхронизирована)
- ✅ **check6 переписан (2 бага)** (`consistencyCheckService.ts`) — (1) *корреляция*: старый `memberships: { some: WITHDRAWN } }` флагал студента во ВСЕХ его группах, если он отчислен хотя бы из одной (~35k false positives на dev-данных); теперь raw SQL join `GroupMembership` по группе самой сессии. (2) *память*: старая версия тянула ВСЕ нарушающие id в память (6.2M строк на dev) — теперь `LIMIT 20` + отдельный `COUNT(*)`; `FailFn` получил опц. параметр `totalCount`, чтобы `count` в отчёте не врал.
- ✅ **Границы месяца выписки — по таймзоне школы** (`credits.ts`) — `fromZonedTime`/`formatInTimeZone` (date-fns-tz уже был в deps, `tzUtils.ts`-паттерн); дефолтный месяц — текущий в таймзоне школы. `ponytail:`-коммент про UTC снят. Тест: запись в 2026-06-30T20:00Z для Asia/Bishkek попадает в июль, июнь пуст, continuity держится.
- ✅ **`GET /credits/my-statement`** — студент видит собственную выписку: профиль резолвится из JWT userId (self-scoped by construction, без `finance:read`). `CreditStatement` компонент получил self-service режим (без `studentProfileId` бьёт в my-statement, мягкий текст при расхождении); смонтирован в Student Overview. Общая логика вынесена в `buildCreditStatement()`.
- ✅ **Dev-БД синхронизирована** — `db push --accept-data-loss` (намеренный drop `StudentGroup.name` из миграции 20260707) + `migrate resolve --applied` ×4 → `migrate status: up to date`. Старый дрифт (StudentFreeze) тоже закрыт.
- ✅ **Данные dev починены** — удалено 6 181 012 ghost-attendee строк (WITHDRAWN из группы сессии, только UPCOMING, батчами по 100k); 18 zombie-сессий → CANCELLED (гард: 0 attendance, 0 TeacherPaymentLesson, ни одна не заблокирована). Consistency-check после ремонта: **0 нарушений**.
- **Файлы:** `server/src/services/consistencyCheckService.ts`, `server/src/routes/credits.ts`, `client/src/components/ui/CreditStatement.tsx`, `client/src/pages/dashboard/student/Overview.tsx`, `API_CONTRACTS.md`. Тесты: creditStatement 7/7 (+таймзонная граница, +student self-service, +403), financialConsistency 34/34. TypeScript PASS (оба), build PASS, live-smoke PASS (my-statement 200, чужой id студентом 403, consistency-check 0 violations).

#### 2026-07-11 (Part 27 — «+ Платёж» объединён с quick-payment: деньги всегда конвертируются в кредиты)
- ✅ **Idempotency-Key починен в financeApi** — сервер требует заголовок на `POST /payments`/refunds/allocate, клиент его не слал → форма «Добавить платёж» была сломана (400). `paymentApi.create/allocate`, `refundApi.create` теперь принимают ключ; модалки держат один UUID на попытку (стабилен при ретрае, обновляется при смене инпутов — паттерн `payKeyRef` из Students.tsx).
- ✅ **«Добавить платёж» → quick-payment flow** — модалка на финансовой странице бьёт в `PATCH /students/:id` (`paymentAmount`) вместо `POST /payments`: раньше платёж записывался в доход, но студент не получал ни кошелька, ни кредитов. Теперь оба входа (карточка студента и финансовая страница) — один поток: `moneyBalance` → пропорциональный пересчёт в уроки → ledger → `paidUntil`. `POST /payments` остаётся только для инвойсного учёта.
- ✅ **Quick-payment: `CARD` и `paymentDate`** (`students.ts`) — метод «КАРТА» больше не схлопывается в CASH; опциональная дата задним числом пишется в `StudentPayment.createdAt` (это поле — дата платежа везде, где показывается). 400 на невалидную дату.
- ✅ **Отмена top-up'а из финансового списка** — крестик на строке `CREDIT_TOPUP` (hover на десктопе / в карточке на мобилке, OWNER/SUPERADMIN) зовёт существующий `POST /students/:id/payments/:paymentId/cancel` (полный откат кредитов + REFUND ledger). Для этого `GET /payments?includeCredits=true` теперь отдаёт `studentProfile.user.id` у top-up'ов.
- ✅ **Отменённые top-up'ы больше не считаются доходом** (`payments.ts`) — раньше маппинг хардкодил `status: CONFIRMED`, и отменённый StudentPayment продолжал раздувать поступления месяца; теперь `cancelledAt` → `status: VOIDED` (+`voidedAt`).
- ✅ **Аннулированные остаются видимыми в списке** — VOIDED-строки больше не выкидываются из «Все поступления»: показываются серым с бейджем «Аннулирован» (видимый след), но все суммы (итого, по методам, по админам) считаются только из не-VOIDED (`confirmedPayments`).
- ✅ **Комментарий к поступлению** — иконка 💬 на строке (hover/мобилка, canWrite) → инлайн-инпут под строкой (Enter/Esc), заметка показывается под именем студента. Новые эндпоинты: `PATCH /payments/:id/note` (finance:write) и `PATCH /students/:id/payments/:paymentId/note` (students:write) — trim, cap 500, пусто → null, разрешено на отменённых. Live-smoke PASS (200 + отражение в списке, чужой студент 404).
- ✅ **Сортировка по колонкам «Все поступления»** — тот же паттерн, что в Students: клик по заголовку → asc → desc → off (off = серверный порядок, дата desc), шевроны на активной колонке, пустые значения всегда в конце. Все 6 колонок сортируемы, локальный state (без URL).
- **Файлы:** `client/src/lib/financeApi.ts`, `client/src/pages/dashboard/admin/FinanceDashboard.tsx`, `client/src/components/ui/RefundModal.tsx`, `client/src/types/index.ts`, `server/src/routes/students.ts`, `server/src/routes/payments.ts`, `API_CONTRACTS.md`. Тесты: financialConsistencyIdempotency PASS. TypeScript PASS (оба).

#### 2026-07-11 (Part 28 — «Расходы — зарплаты»: таблица как «Все поступления», аннулирование вместо удаления)
- ✅ **TeacherPayment: void вместо hard delete** (`schema.prisma`, миграция `20260711000000_teacher_payment_void_status`) — новые поля `status PaymentStatus @default(CONFIRMED)`, `voidedAt`, `voidedById` (FK → User), `voidReason`. `DELETE /salary/pay/:paymentId` больше не удаляет запись: ставит `VOIDED` + кто/когда/почему, удаляет `TeacherPaymentLesson`-линки (уроки снова доступны к оплате — как раньше при delete), 409 на повторное аннулирование. Аудит-экшен переименован `SALARY_PAYMENT_DELETED` → `SALARY_PAYMENT_VOIDED`.
- ✅ **Вся зарплатная математика исключает VOIDED** — `GET /salary` (totalPaidAmount/paidLessonsCount/remainingAmount/isPaid считаются из confirmed-подмножества; сами VOIDED-строки остаются в `payments[]` как след), `GET /salary/my`, гарды `PERIOD_ALREADY_PAID` (create/delete adjustment), `priorPayments` внутри транзакции `POST /salary/pay` (доля корректировок аннулированной выплаты возвращается в пул), `check10` consistency-проверки (у VOIDED нет линков — это норма, не denorm-рассинхрон), скрипт `repair-orphan-payments` (VOIDED без линков — не сироты).
- ✅ **Комментарий к выплате** — новый `PATCH /salary/pay/:paymentId/note` (salary:write; trim, cap 500, пусто → null, разрешено на аннулированных). `GET /salary` и `GET /salary/history/:staffProfileId` теперь отдают `status`, `note`, `voidReason`, `voidedAt` по каждой выплате.
- ✅ **FinanceDashboard: секция «Расходы — зарплаты» переделана в таблицу транзакций** — вместо сводки по сотрудникам показываются отдельные выплаты месяца с теми же колонками/паттернами, что «Все поступления»: Преподаватель | Уроки | Статус | Выплатил | Дата | Сумма; сортировка по всем колонкам (asc → desc → off), 💬-комментарий с инлайн-редактором, ✕-аннулирование с причиной (prompt), VOIDED-строки серые с бейджем «Аннулирован» + причина. Футер: «Итого выплачено» (только confirmed) и «Осталось к выплате» (сумма remainingAmount).
- ✅ **SalaryPayslip / SalaryHistory** — аннулированные выплаты в истории показываются с бейджем «Аннулирована», зачёркнутой суммой и причиной; кнопка «Отменить» скрыта; баннер «Частично выплачено» и все итоги истории игнорируют VOIDED; текст модалки отражает новую семантику (запись остаётся, уроки снова оплачиваемы).
- ✅ **«Кто принимал деньги»: раскрытый список — тоже таблица** (2026-07-12) — колонки Студент | Метод | Статус | Дата | Сумма (grid `ADMIN_GRID`, без колонки «Принял» — список уже сгруппирован по принимающему), сортировка по заголовкам (общий хелпер `sortPaymentList` с «Все поступления», один `adminSort`-state — раскрыт всегда один админ), 💬-комментарий с инлайн-редактором на каждой строке, заметка под именем студента. На мобилке строки складываются как раньше (flex-wrap), заголовки скрыты.
- **Файлы:** `server/prisma/schema.prisma` (+миграция), `server/src/routes/salary.ts`, `server/src/services/consistencyCheckService.ts`, `server/src/scripts/repair-orphan-payments.ts`, `client/src/hooks/useSalaryApi.ts`, `client/src/pages/dashboard/admin/FinanceDashboard.tsx`, `client/src/pages/dashboard/admin/SalaryPayslip.tsx`, `client/src/pages/dashboard/admin/SalaryHistory.tsx`, тест `salaryConsistency.test.ts` (S12 → void-семантика). Тесты: salaryConsistency 14/14 PASS, tenantIsolation + financialConsistencyIdempotency2B 29/29 PASS. TypeScript PASS (оба), client build PASS. Live-smoke PASS (GET /salary с новыми полями, PATCH note 200).

#### 2026-07-12 (Part 29 — Заметка в профиле сотрудника)
- ✅ **StaffProfile.notes** (`schema.prisma`, миграция `20260712000000_add_staff_notes`) — свободная заметка у учителя и администратора, зеркало `StudentProfile.notes`. `PATCH /users/:id/staff-profile` принимает `notes` (`null` очищает); `GET /users` / `GET /users/:id` возвращают её в `staffProfile` автоматически (include).
- ✅ **UI: вкладка «Информация» профиля сотрудника** (`owner/Staff.tsx`) — textarea «Заметки» + кнопка «Сохранить заметку» (disabled пока нет изменений), тот же паттерн, что у студента. Работает и для учителя, и для админа — модалка общая.
- **Файлы:** `server/prisma/schema.prisma` (+миграция), `server/src/routes/users.ts`, `client/src/pages/dashboard/owner/Staff.tsx`, `API_CONTRACTS.md`, `DATABASE_CONSTRAINTS.md`. TypeScript PASS (оба). Live-smoke PASS (PATCH notes → GET /users возвращает заметку).

#### 2026-07-14 (Part 30 — Teacher schedule: "Посещаемость сейчас недоступна" на уроке без сессии)

- ✅ **Root cause: `GET /schedule/teacher` не считал truth-display поля** — в отличие от `GET /schedule` (admin/owner), teacher-эндпоинт собирал блоки напрямую из Prisma и никогда не вызывал `classifyBlockVisibility()`/`computeConflictEligible()`, так что `isScheduleActive`/`isReadOnly`/`blockVisibility` на каждом блоке были `undefined`. Общая клиентская merge-логика (`scheduleBlockMerge.ts:253`: `isReadOnly: blocks.length > 0 && !blocks.some(b => b.isScheduleActive)`) трактует `undefined` как «не активен» → `group.isReadOnly = true` на **всех** карточках учителя, всегда. Это глушило `effectiveReadOnly` в `GroupRow.tsx`, что убивало `todayUpcomingMarkable` — специально написанный фолбэк «урок уже начался, но `LessonSession` ещё не создан → всё равно разрешить отметить посещаемость» (`groupRowActionState.ts`). Проявляется только когда для урока ещё нет строки `LessonSession` (rolling-window генерация не успела/только что создан блок) — если сессия уже есть, `backendCanEditAttendance` работает независимо и баг не виден. Симптом: кнопка «Сдать посещаемость» всегда disabled с общей причиной «Посещаемость сейчас недоступна», хотя урок явно прошёл.
- ✅ **Fix** — `GET /schedule/teacher` теперь считает те же truth-display поля, что и `GET /schedule` (переиспользует уже импортированные `classifyBlockVisibility`/`computeConflictEligible`/`getPolicyForDate`, ровно тот же паттерн).
- ✅ **Verification** — `tsc --noEmit` + `npm run build` чистые (server). Live-smoke как TEACHER (`hunya-shkola`, аккаунт `teacher1@hunya-shkola.test`): до фикса `GET /schedule/teacher` отдавал блок без `isScheduleActive` → кнопка disabled; после фикса — `isScheduleActive: true`, кнопка активна, реальная сдача посещаемости прошла (кредиты списаны 20→19 у всех 4 студентов, `paidUntil` пересчитан, тост «Посещаемость сдана», индикатор ячейки `!` → `✓`).
- **Файлы:** `server/src/routes/schedule/scheduleBlocks.routes.ts`.

#### 2026-07-13 (Part 30 — «Кто принимал деньги»: аннулированные не исчезают)
- ✅ **Группы по сотрудникам строятся из всех строк месяца** (`FinanceDashboard.tsx`) — раньше `incomeByAdmin` собирался из confirmed-подмножества, и отменённый платёж пропадал из раскрытого списка целиком (вместе со строкой сотрудника, если платёж был единственным). Теперь VOIDED-строки остаются в раскрытом списке (серые, бейдж «Аннулирован»), а сумма и счётчик «N платежей» считают только не-VOIDED. Ничего на вкладке «Финансы» больше не исчезает при аннулировании — меняется только статус.
- ✅ **Единое поведение трёх таблиц транзакций** («Все поступления», «Кто принимал деньги», «Расходы — зарплаты») — кнопка 💬 удалена: клик по строке открывает/закрывает инлайн-редактор комментария (общий `toggleNoteEditor`, кнопки внутри строки со `stopPropagation`). Крестик и ↻ всегда видимы: hover-оверлей заменён фиксированной 7-й колонкой `84px` в `PAY_GRID` (как в `ADMIN_GRID`).
- **Файлы:** `client/src/pages/dashboard/admin/FinanceDashboard.tsx`. TypeScript PASS.

#### 2026-07-13 (Part 31 — Блоки «без привязки» запрещены на уровне API)
- ✅ **`POST /schedule` требует `studentGroupId`** (`scheduleBlocks.routes.ts`) — блок расписания больше нельзя создать без привязки к StudentGroup: отсутствующий/невалидный id → `400 STUDENT_GROUP_REQUIRED`; группа проверяется в рамках школы (`findFirst { id, schoolId, deletedAt: null }`, раньше был `findUnique` без tenant-фильтра) → 404 если не найдена. `level`/`chapter` всегда берутся из группы (тело игнорируется — группа источник правды).
- ✅ **`PUT /schedule/:id` не даёт отвязать или оставить блок без группы** — явный `studentGroupId: null/""` → `400 STUDENT_GROUP_REQUIRED`; сохранение легаси-блока «без привязки» без указания группы → тот же 400 (привяжи или удали); перепривязка к уже расписанной группе → `409 GROUP_ALREADY_IN_SCHEDULE` (зеркало POST-guard, иначе дубль пары в сетке).
- Клиент не менялся: UI и так создаёт всё через `group-pair` (группа обязательна), а `EditGroupPanel` не сохраняет без группы. Существующие строки «— Без привязки —» остаются видимыми; чинятся привязкой через `PUT /schedule/:id` или удалением строки (SlotPanel умеет удалять их поблочно). Тесты: `groupPairWriteOwnership.test.ts` — старые «still allows standalone» инвертированы, добавлены кейсы bind/unbind/rebind (11 PASS); schedule-сьюты 81 PASS.

#### 2026-08-09 (Part 32 — Full audit: TEACHER session-ownership guard, missing role gates, capacity/freeze bugs)

Полный аудит по `AUDIT_BRIEF_2026-08-08.md` на ветке `feature/full-app-check-2` (систематический проход по 40 route-файлам через параллельные Explore-агенты + живое тестирование против локальной БД с двумя реальными школами). Ниже — только находки, касающиеся schedule/attendance/credits; полный отчёт по всем 13 разделам брифа — в PR-описании.

- ✅ **TEACHER мог отмечать посещаемость и менять статус ЛЮБОЙ сессии школы, не только своей** — `requirePermission('attendance:write'/'session:write')` пускал TEACHER, но нигде не проверялось, что сессия назначена именно этому учителю (с учётом замены — `getEffectiveSessionTeacherId`). Новый общий хелпer `assertTeacherOwnsSession()` (`scheduleRouteUtils.ts`) — no-op для OWNER/ADMIN/SUPERADMIN, для TEACHER бросает `TeacherOwnershipError` (403/404), подхватываемый `sendLifecycleError`. Подключён в `POST /session/submit-attendance`, `GET/PATCH /session/:id/attendance`, `POST /session/:id/attendance/reopen` (`scheduleAttendance.routes.ts`) и `PATCH /session/:id/status` (`scheduleSessions.routes.ts`). Live-verified: чужой TEACHER → 403 «Эта сессия не назначена вам», сам назначенный TEACHER → 200, замена (`isManualTeacher`) корректно переключает владельца.
- ✅ **4 GET-роута школьного расписания были вообще без role-гейта** — `schedule/` (`scheduleBlocks.routes.ts GET /`, отдаёт кредиты/заметки/isFrozen каждого студента школы), `GET /session/for-date`, `GET /session/:id/logs`, `GET /session/:id/students` (`scheduleSessions.routes.ts`) пускали любую авторизованную роль, включая STUDENT. Добавлен `requirePermission('students:read')` (OWNER/ADMIN/TEACHER, как и везде в кодовой базе для доступа к данным студентов) на все 4.
- ✅ **`PATCH /schedule/enrollment/:id/approve/:studentProfileId` не проверял вместимость группы** — в отличие от соседних `/add` и bulk-`/students` (которые считают `effectiveCap = min(maxStudents, cabinet.capacity)`), approve из вейтлиста мог провести студента в уже полную группу. Добавлена та же проверка перед upsert.
- ✅ **Импорт CSV с `paused=true` не создавал `StudentFreeze`** (`importexport.ts`) — писал только `StudentProfile.isFrozen` (legacy cache), а реальный гейт списания кредита (`attendanceService`) смотрит только на живые строки `StudentFreeze` (CLAUDE.md: isFrozen — только кэш). Импортированный «замороженный» студент по факту продолжал терять кредиты на посещаемости. Новый `ensureImportFreeze()` создаёт открытый `PERIOD`-фриз в той же транзакции при `paused=true` (только создание — `paused=false` на update намеренно no-op, как и раньше у `isFrozen`).
- ✅ **3 запроса к `LessonSession` не фильтровали по `schoolId` на верхнем уровне** — `scheduleDashboard.routes.ts` (teacher-lesson-calendar ×2) и `scheduleBlocks.routes.ts` (`GET /teacher`, substitute-сессии) фильтровали школу только через вложенный `lessonBlock: { schoolId }`, из-за чего Postgres не мог использовать `@@index([schoolId, ...])` на самой `LessonSession` — сканирование по всем школам вместо одной. Добавлен `schoolId` в верхний `where` во всех трёх местах (не IDOR — вложенный фильтр уже был корректен, только производительность).
- ✅ **Cancel-guard повторно проверен по всем 9 путям, которые могут отменить/инвалидировать сессию или блок** — все корректно блокируют операцию при `Attendance.creditDeducted=true` (или более строгим «есть посещаемость» для блок-уровневых каскадов) и ни один не делает автоматический возврат кредита, включая bulk-cancel/restore и split-группу. Единственная зацепка: `invalidateSession()` не вызывает `assertNoCreditDeductedAttendance`, но на сегодня не подключена ни к одному роуту (latent risk, не эксплуатируется).
- Regression-тесты: `teacherOwnership.test.ts` (6 кейсов на `assertTeacherOwnsSession`), `auditFixes2026-08-09.test.ts` (cross-tenant IDOR на groups/import-export).
- **Файлы:** `server/src/routes/schedule/scheduleRouteUtils.ts`, `scheduleAttendance.routes.ts`, `scheduleSessions.routes.ts`, `scheduleBlocks.routes.ts`, `scheduleDashboard.routes.ts`, `scheduleEnrollment.routes.ts`, `server/src/routes/importexport.ts`. TypeScript PASS (оба, strict и `tsconfig.test.json`). Server: 24 unit + 76 integration suites PASS. Client: build + lint (0 errors) + 18 test files PASS.

#### 2026-08-18 (Part 33 — Mobile UX audit batch 1: synthesized planned lessons, mobile day selector, student search)

- ✅ **`GET /schedule/teacher-lesson-calendar-admin` synthesizes planned lessons beyond the session horizon** (`scheduleDashboard.routes.ts`) — `LessonSession` rows only exist out to `ROLLING_DAYS` (14 days, `sessionService.ts`), so this admin/owner payroll calendar previously rendered blank for any week beyond that horizon (e.g. the tail of the current month). It now falls back to computing occurrence dates directly from `LessonBlock` recurrence (same date-arithmetic helper the sibling `teacher-lesson-calendar` endpoint already used) and marks those rows `isSynthesized: true`, `status: 'UPCOMING'`, `paymentId: null`, negative sentinel `id`. **`ROLLING_DAYS` itself was deliberately NOT increased** — raising it would grow the persisted `LessonSession` row count at 50 schools × thousands of sessions/day; synthesizing on read for a display-only calendar is the cheaper fix. Real rows always win: a synthesized entry is skipped whenever a real `LessonSession` already exists for that `(block, date)`, whenever the date is in the past, whenever the block's status no longer allows generation (`blockAllowsSessionGeneration`), or whenever its `StudentGroup` is paused/completed/archived — so a synthesized row can never be mistaken for, or paid as, a real taught lesson. Full contract: `API_CONTRACTS.md`.
- ✅ **Mobile week view: day selector defaulted to Monday instead of today** (`WeekGrid.tsx`) — `sched.aDays` (active school days) is empty on first mount, so the effect that picks the default mobile day ran once against `[]` and never re-ran when real data arrived (only depended on `[viewWk]`, an array reference that doesn't change on data load). Now also keyed on a stable string derived from `aDays`' values (`aDays.join(',')`), so the effect re-fires exactly once when `[]` → real values, without re-firing (and clobbering a manually picked day) on every unrelated reload.
- ✅ **`StudentPicker` add-student search only searched a stale 50-row snapshot** (`components/schedule/StudentPicker.tsx`) — it fetched page 1 (50 students, alphabetical) once on first focus and filtered that snapshot in memory, so a student created after that snapshot (or simply outside the first 50 alphabetically) was unreachable no matter what was typed. Replaced with debounced (350ms) server-side search (`GET /students?search=&limit=30`) with an `AbortController` guarding against an in-flight request for an earlier keystroke overwriting the results of a later one; shows "Показаны первые N из M" when the server reports more matches than fit on the page.
- **Файлы:** `server/src/routes/schedule/scheduleDashboard.routes.ts`, `client/src/components/schedule/WeekGrid.tsx`, `client/src/components/schedule/StudentPicker.tsx`. `API_CONTRACTS.md` updated with the new endpoint contract.

#### 2026-08-19 (Part 34 — Finance Control: resolved violation details + check6 false-positive fix)

- ✅ **Finance Control (`/owner/finance-control`) showed only raw numeric ids per violation** — no student/lesson/date, no way to act without manually searching the DB. New `server/src/services/violationDetailService.ts` resolves each check's/issue's ids into `{ label, sublabel, scheduleTarget? }` (student or teacher name, lesson date/group/status) via one query per entity kind (`sessionStudent`, `attendance`, `lessonCreditLog`, `teacherPaymentLesson`, `lessonSession`, `lessonBlock`, `teacherPayment`, `studentProfile`, `invoice`, `school`). Wired into both `GET /admin/consistency-check` and `GET /admin/reconciliation` (`admin.ts`) via a `check`/`issueType` → entity-kind map; reconciliation batches per issueType (capped at 20 ids) to avoid an N+1 query storm. When the entity traces to a `LessonBlock`, `scheduleTarget` gives `{blockId, groupId, startTime, endTime}` and the client (`FinanceControl.tsx`) builds the same `?openBlockId=&openGroupId=&openStart=&openEnd=` deep-link `GroupDetail.tsx` already uses to jump straight into that slot in `/owner/schedule`. If the underlying `LessonBlock` is itself soft-deleted, no link is emitted (the schedule grid can't resolve a deleted block) — the sublabel says so instead (`(блок удалён — уроки не были отменены)`) rather than the link silently 404ing as "группа не найдена". Checks without a mapped entity kind keep the old raw-id fallback. `API_CONTRACTS.md` updated with the enriched `consistency-check` response shape.
- ✅ **check6 (`UPCOMING SessionStudent for WITHDRAWN student`, ghost attendee) was reporting 66,836 false positives on one dev school** — its raw SQL filtered `ls.status = 'UPCOMING'` but never checked `deletedAt` on the session or its block. `DELETE /api/settings/clear-all-data` (`settings.ts`) correctly soft-deletes `LessonSession`/`LessonBlock` on wipe, but never touches `status`, so a wiped school's sessions stay `status='UPCOMING'` forever — check6 was counting all of them as live conflicts. check9 (zombie session) already filtered this correctly for the same underlying reason; check6 now matches it: added `AND ls."deletedAt" IS NULL AND lb."deletedAt" IS NULL` to both the sample and count queries in `consistencyCheckService.ts`. Verified against real data: reported count dropped from 66,851 to the genuine 15 (3 groups, students withdrawn but still on one upcoming session's roster each) — no data migration was needed, only the check query was wrong.
- ✅ **`scheduleTarget` also went dead when the *group* (not the block) was archived** — completing then archiving a `StudentGroup` (`groupLifecycleService.ts`) sets `StudentGroup.deletedAt` but leaves `LessonBlock.deletedAt` null, so the first version of this fix (which only checked the block) still linked into a group the schedule grid no longer shows → same "группа не найдена" 404. `violationDetailService.ts`'s `blockTarget`/`blockNote` now also check `lessonBlock.studentGroup.deletedAt`. Root cause of *why* a completed/archived group can still surface here at all: `groupLifecycleService.completeGroup()` only invalidates future sessions (`date >= effectiveDate`, default today) — an `UPCOMING` session dated in the past (e.g. never taught, never marked) survives archival untouched, with zero `attendance`/`creditLog`/`teacherPaymentLesson`, and keeps matching check6 forever since its `GroupMembership` is now `WITHDRAWN` too. Not fixed here (would be a data mutation on 3 identified rows, session ids 16496/16502/16508 on this dev school — flagged to the user, not applied without explicit go-ahead per Product Owner Principle).
- **Файлы:** `server/src/services/violationDetailService.ts` (new), `server/src/routes/admin.ts`, `server/src/services/consistencyCheckService.ts`, `client/src/pages/dashboard/owner/FinanceControl.tsx`. `API_CONTRACTS.md` updated.
