# Schedule UI Contract

## Grammar/Club Save Contract

- Editing an existing `SchedGroup` is one logical schedule command, not a sequence of unrelated block writes.
- `EditGroupPanel` saves via `PUT /api/v1/schedule/group-pair/:studentGroupId`.
- Do not reintroduce the old multi-request edit flow: `PUT /groups/:id`, then `PUT /schedule/:grammarBlockId`, then `PUT /schedule/:clubBlockId`, then optional `POST /schedule` for club creation.
- The pair endpoint owns final-state validation, `applyFrom` split, `StudentGroup` metadata update, session sync, and cache invalidation.
- Frontend components may preview conflicts, but they must not orchestrate partial Grammar/Club saves.

## React StrictMode Save-State Rule

- Components that use `mountedRef` around async saves must set it back to `true` inside the effect body.
- Required pattern:

```ts
const mountedRef = useRef(true);
useEffect(() => {
  mountedRef.current = true;
  return () => { mountedRef.current = false; };
}, []);
```

- Forbidden pattern:

```ts
useEffect(() => () => { mountedRef.current = false; }, []);
```

The forbidden form breaks in React StrictMode dev remounts and leaves save buttons stuck on `Сохранение...`.

Короткий контракт для правок расписания после разделения `SlotPanel` на компоненты. Перед изменениями в `client/src/components/schedule/*`, `client/src/hooks/useSchedule.ts`, `client/src/utils/scheduleConflicts.ts` и `server/src/routes/schedule/*.routes.ts` сверяться с этим файлом и с `AI_SCHEDULE_HANDOFF.md`.

## Главные правила

- `TimeSlot` задает время урока. Формы создания/редактирования группы берут время из выбранного слота; `EditSessionPanel` не должен показывать ручное редактирование времени обычного урока.
- `LessonBlock` это шаблон расписания: тип `GRAMMAR` или `SPEAKING_CLUB`, дни, слот, кабинет, учитель, `startDate/endDate`.
- `LessonSession` это конкретный урок на дату. Он создается/синхронизируется автоматически. В UI редактирования урока меняются только разовые параметры: замена учителя, кабинет, статус, make-up.
- Одна `StudentGroup` может иметь два блока в одном слоте: Grammar и Speaking Club. В клиентской модели они показываются одной карточкой `SchedGroup`.
- В `SchedGroup` обязательно сохранять реальные ids обоих блоков: `grammarBlockId` и `clubBlockId`. Не угадывать Club только через `linkedIds`.
- Все действия по конкретному уроку (замена, отмена, посещаемость, отображение `weekSessions`) должны получать id через helpers `grammarBlockIdOf`, `clubBlockIdOf`, `lessonBlockIdForDay` из `scheduleTypes.ts`, а не через прямые `group.id`/`linkedIds[0]`.

## День Grammar/Club

- Grammar и Club одной группы не могут стоять в один и тот же день.
- UI не должен оставлять пересечение дней. Если пользователь выбирает день в Grammar, этот день автоматически убирается из Club. Если выбирает день в Club, этот день автоматически убирается из Grammar.
- Backend тоже валидирует это правило через `GRAMMAR_CLUB_DAY_CONFLICT`; frontend не должен полагаться только на backend.
- Конфликт одного дня не должен блокировать посещаемость другого дня. Блокировать можно только текущую ячейку, где реально пересекаются Grammar и Club.

## Конфликты

- Все frontend-проверки конфликтов должны идти через `client/src/utils/scheduleConflicts.ts`.
- Проверки конфликтов обязаны учитывать дату ячейки через `targetStartDate`, чтобы закрытые или будущие версии блока не конфликтовали с текущей датой.
- При редактировании исключать оба связанных блока из проверки: текущий Grammar и текущий Club.
- При сохранении пары Grammar/Club избегать временного backend-конфликта: если изменение убирает старое пересечение, сначала сохранить блок, который убирает конфликт, затем второй блок.

## Раскрытие карточки

- Клик по шапке карточки открывает/закрывает студентов.
- Inline-формы `EditGroupPanel`, `EditSessionPanel` и `StudentPicker` должны закрываться при сворачивании карточки.
- Если форма открыта через меню у свернутой карточки, карточка сначала раскрывается, потом показывается форма.

## Обязательная проверка после правок

- `npm.cmd test -- scheduleConflicts`
- `npm.cmd run build`
- Ручной сценарий: открыть слот, открыть меню группы, открыть редактирование группы, переключить день из Grammar в Club и убедиться, что день удалился из другой строки.
- Ручной сценарий: открыть `Редактировать урок`; там не должно быть полей времени начала/конца.

## Мобильная раскладка расписания

- Единый источник правды для мобильного слота — `components/schedule/MobileSlotSection.tsx`. Все четыре мобильных представления (`WeekGrid`, `RoomsView`, `TeacherView`, `GroupView`) обязаны использовать его.
- Время слота печатается **один раз** — в sticky-шапке секции. Запрещено возвращать левую колонку времени (`w-14`): все карточки внутри слота делят одно время, колонка съедала ~68px (≈23%) ширины карточки на всю высоту слота.
- Не передавать `slotTime` в `RoomBlock` на мобильном — время уже в шапке секции. `slotTime` остаётся только для десктопных pivot-таблиц (Rooms/Teacher/Group), где колонка — кабинет/учитель/группа, а не время.
- Карточка урока на мобильном — `RoomBlock` с `layout="mobile"`: уровень + вместимость в первой строке, кабинет + пилюли преподавателей во второй, чипы-исключения (замена, пауза, доп. урок, backend-truth) только когда применимы. `layout="cell"` (по умолчанию) — плотная раскладка для ячейки десктопной таблицы, менять её вместе с мобильной нельзя.
- Цветовой код преподавателя — единственный источник `roomBlockStyles.ts → TEACHER_PILL`: Grammar зелёный, Club синий. Десктопная ячейка и мобильная карточка обязаны читать цвета оттуда, хардкодить `#E8F5E9` / `#E3F2FD` заново запрещено.
- Префикс `Гр:` / `Кл:` показывается всегда, даже если в этот день идёт только один блок: цвет сам по себе не читается пользователем с дальтонизмом.
- Заменённый преподаватель остаётся видимым, но зачёркнутым и приглушённым; кто реально ведёт урок — в чипе `Замена: X` под строкой.
- Список слотов обязан быть собственным scroll-контейнером (`useContainerHeight` + `overflow-y-auto`), иначе sticky-шапка секции цепляется к странице и уезжает под `MobileDayBar`, высота которого меняется при collapse-on-scroll.
- Тап по шапке слота и по «+» открывает пустой слот (`onCellClick(day, slotId)`) — это поведение перенесено со старой колонки времени и не должно теряться.
