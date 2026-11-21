# Eduschool App

Eduschool App — это мультитенантная SaaS-платформа для управления языковыми школами (расписание, студенты, преподаватели, абонементы).

For AI workflow and development rules, see `../CLAUDE.md`.

## Documentation Map

For humans and AI assistants: use `../CLAUDE.md` for workflow/rules, `SYSTEM_BLUEPRINT.md` for the system overview, and the other docs as technical references.

| Need | Read |
|------|------|
| Workflow and development rules | `../CLAUDE.md` |
| System overview | `SYSTEM_BLUEPRINT.md` |
| Architecture decisions | `ARCHITECTURAL_DECISIONS.md`, `ARCHITECTURE.md` |
| Schedule internals | `AI_SCHEDULE_HANDOFF.md`, `SCHEDULE_UI_CONTRACT.md`, `SCHEDULE_LIFECYCLE_RFC.md` |
| API and data rules | `API_CONTRACTS.md`, `DATABASE_CONSTRAINTS.md` |
| Frontend state | `FRONTEND_STATE_RULES.md` |
| Deployment, operations, testing | `DEPLOYMENT.md`, `OPERATIONS.md`, `TESTING_STRATEGY.md` |

## Стек технологий
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, React Router v7, PWA
- **Backend**: Node.js, Express, TypeScript, PostgreSQL, Prisma ORM, express-rate-limit
- **Инфраструктура**: Docker Compose для БД PostgreSQL

## Главная механика (Ядро / "Антигравитация")
Главная бизнес-логика системы завязана на связке Расписание ↔ Посещаемость ↔ Баланс абонемента (Кредиты). Эту механику важно понимать перед внесением изменений:

1. **StudentGroup (Когорта)** — единица записи студентов. Студенты состоят в группе через membership/snapshot-модели, а не через список `students` на `LessonBlock`.
2. **LessonBlock (Шаблон урока)** — recurring-расписание группы (Grammar/Club, дни, слот, кабинет, преподаватель). Историческая правда хранится в сессиях.
3. **LessonSession (Сессия/Урок)** — конкретный урок в определенную дату. Сессия хранит снапшоты преподавателя/кабинета/времени; замены фиксируются через session-level teacher fields.
4. **Attendance (Посещаемость)** — отмечается для конкретной `LessonSession`. Статусы: PRESENT, ABSENT, LATE, FROZEN. Флаг `creditDeducted` контролирует идемпотентность списания.
5. **Кредиты и LessonCreditLog** — кредиты списываются только через Submit Attendance. Каждое изменение баланса строго фиксируется в `LessonCreditLog`.
6. **Вместимость (Капасити)** — количество студентов в группе жестко валидируется на уровне `Cabinet.capacity` и `LessonBlock.maxStudents`. Для желающих, когда мест нет, есть очередь заявок (`EnrollmentRequest`).

Подробное описание архитектуры, структур БД и Data Flow находится в файле [ARCHITECTURE.md](ARCHITECTURE.md).

## Ключевые системы (добавлено)
- **Двухфакторная аутентификация (2FA) & Passkeys** — поддержка WebAuthn и TOTP (через Google Authenticator) для повышенной безопасности аккаунтов.
- **Система уведомлений** — функционал для массовой рассылки сообщений (броадкастов) от администраторов студентам и преподавателям, а также системные уведомления.
- **Блокировка школ** — SuperAdmin может заблокировать школу. Пользователи получают 7 дней до отключения с баннером-предупреждением в интерфейсе.
- **Rate Limiting** — защита от брутфорса на `/login` и `/register` (10 запросов/15 мин).
- **24 индекса БД** — B-Tree индексы на всех ключевых полях для работы при 30+ школах.
- **Очистка уведомлений** — автоматически удаляются уведомления старше 90 дней при старте сервера.
- **PWA** — приложение устанавливается на телефон/компьютер как нативное.
- **Адаптивная навигация** — боковая панель на десктопе, нижняя панель на мобильном.

## Communications module status

In-app Communications v1 is closed for the current product scope. It covers the notifications center, campaigns, role/user/group targeting, recipient preview, templates, drafts, scheduled sending, and delivery analytics/message logs.

Future scope is limited to external delivery integrations and related provider work: WhatsApp, Telegram, Email, SMS, Push/mobile, automations, recurring campaigns, and external delivery billing/compliance.

## Инструкция для новых разработчиков

1. Установи Docker Desktop
2. В корневой директории подними БД: `docker-compose up -d`
3. Установи зависимости: 
   - На бэкенде: `cd server && npm install`
   - На фронтенде: `cd client && npm install`
4. Настрой переменные окружения: скопируй `server/.env.example` в `server/.env`
5. Накати миграции БД: `cd server && npx prisma migrate deploy`
6. Сгенерируй Prisma Client: `cd server && npx prisma generate`
7. Запусти оба проекта одновременно (из корня): `npm run dev`
