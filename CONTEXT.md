# Support AI Agent — Контекст проекта

> Этот файл поддерживается Claude Code и обновляется в начале каждой сессии.
> **Последнее обновление:** 2026-06-16 (сессия 9)

---

## Цель

Telegram-бот + веб-дашборд для техподдержки GPSPOS.  
Бот принимает вопросы, вызывает инструменты (Okdesk, GPSPOS, GPSPOS Geo) и возвращает ответ.  
Дашборд — интерфейс для управления заявками Okdesk.

---

## Сервер (прод)

| Параметр | Значение |
|---|---|
| Host | `155.212.186.165` (Beget VPS, Ubuntu 24.04) |
| User | `root` |
| SSH-ключ | `/c/Users/sPec/.ssh/id_ed25519` |
| Путь к проекту | `/opt/support-ai-agent` |
| Порт | `8001` |
| Сервис systemd | `support-ai-agent.service` |
| Диск | ~89% занят — мониторить |

**Рядом на сервере:** `/home/okdesk/okdesk-console/` — Okdesk Console (порт 8000, `okdesk.service`)

SSH-команда: `ssh -i /c/Users/sPec/.ssh/id_ed25519 root@155.212.186.165`

---

## Архитектура

```
support-ai-agent/
├── app/
│   ├── main.py                         # FastAPI + lifespan + SPA fallback + bg refresh
│   ├── static/                         # ✅ Собранный React (Vite build output)
│   ├── api/v1/
│   │   ├── router.py                   # агрегатор роутов
│   │   └── endpoints/
│   │       ├── webhooks.py             # POST /webhooks/okdesk
│   │       ├── test.py                 # POST /test/pipeline
│   │       ├── issues_dashboard.py     # ✅ 7 endpoints для дашборда
│   │       └── employees.py           # ✅ GET /employees — список сотрудников
│   ├── core/
│   │   ├── db/
│   │   │   ├── database.py            # SQLite async (support_agent.db)
│   │   │   └── models.py              # IssueCache (+ assignee_name), AnalysisCache, ...
│   │   ├── services/
│   │   │   └── cache_service.py       # ✅ CacheService: refresh, assign, query
│   │   └── okdesk/
│   │       ├── models.py              # Issue, Employee, IssueParameter, ...
│   │       └── service.py             # assign_issue, list_employees, ...
│   └── services/
│       └── intelligence_service.py
├── frontend/                          # ✅ React 18 + TypeScript + Vite
│   └── src/
│       ├── App.tsx                    # Layout + UserSelector ("Я:")
│       ├── components/
│       │   ├── IssuesList.tsx         # Таблица + пагинация (20/50/100)
│       │   ├── IssueDetail.tsx        # Детали: все поля Okdesk + ответственный
│       │   ├── IssueFilters.tsx       # Фильтры: статус, компания, поиск
│       │   └── StatusBadge.tsx        # Цветные бейджи статусов
│       ├── store/
│       │   ├── issuesStore.ts         # Zustand: фильтры, пагинация
│       │   └── userStore.ts           # Zustand: текущий пользователь (localStorage)
│       ├── api/client.ts              # axios: все API вызовы
│       └── types/index.ts             # TS интерфейсы
└── CONTEXT.md / WEB_DASHBOARD_ARCHITECTURE.md
```

---

## Статус компонентов

| Компонент | Статус | Примечание |
|---|---|---|
| **Telegram бот** | ✅ Работает | aiogram 3.x, polling |
| **AIAgent + Tools** | ✅ 12 инструментов | DeepSeek, Okdesk/GPSPOS/Geo |
| **IssueCache** | ✅ 1000 заявок | пагинация page[number]/page[size], обновление каждые 5 мин |
| **Dashboard API** | ✅ Задеплоен | 7 endpoints: list, detail, refresh, assign, comments, analysis |
| **Employees API** | ✅ Задеплоен | GET /api/v1/employees |
| **React Frontend** | ✅ Задеплоен | Phase 2 завершён |
| **Ответственный** | ✅ Работает | batch sync для всех заявок, "Взять себе", picker по группам |
| **Детали заявки** | ✅ Полные | описание, сроки, параметры (с извлечением телефона), связанные |
| **Пагинация** | ✅ 20/50/100 | селектор в нижней панели таблицы |
| **Wialon** | ⚠️ Заглушка | клиент есть, в агент НЕ подключён |
| **Автоанализ заявки** | ✅ Phase A | парсинг → geo DailyStat+ObjectPackets → классификация (DeepSeek) → черновик ответа |
| **Пагинация persist** | ✅ | `limit` сохраняется в localStorage (issues-prefs) |
| **Вложения + OCR** | ✅ Фаза B | список/просмотр + ИИ читает PDF/Word/Excel/сканы (tesseract rus+eng, PyMuPDF) |
| **Карта+графики заявки** | ✅ | Leaflet трек + uPlot телеметрия, зум, синк с картой |
| **Задел обучения ИИ** | ✅ | таблица training_samples при решении заявки |

---

## Сотрудники техподдержки (Okdesk ID)

| Имя | ID | Группа |
|---|---|---|
| Свириденко | 21 | Первая линия |
| Рогозин | 22 | Первая линия |
| Лебедь | 2 | Вторая линия |
| Игнашкин | 3 | Вторая линия |

---

## API endpoints (дашборд)

```
GET  /api/v1/issues                    — список; фильтры status/company/search/assignee/issue_id (комбинируются)
GET  /api/v1/issues/cache/refresh      — принудительная синхронизация
GET  /api/v1/issues/{id}               — детали + live данные из Okdesk
POST /api/v1/issues/{id}/analysis      — сохранить анализ пробега
GET  /api/v1/issues/{id}/comments      — комментарии из Okdesk
POST /api/v1/issues/{id}/comments      — добавить комментарий
PATCH /api/v1/issues/{id}/assignee     — назначить ответственного
PATCH /api/v1/issues/{id}/type         — сменить тип
POST /api/v1/issues/{id}/resolve       — комментарий + смена статуса в одно действие
GET  /api/v1/employees                 — список активных сотрудников
GET  /api/v1/issue-types               — типы заявок (Okdesk issues/types)
GET  /api/v1/templates                 — шаблоны ответов из okdesk-console
POST /api/v1/issues/{id}/automate      — автоанализ + черновик (POST = прогон ИИ + кэш)
GET  /api/v1/issues/{id}/automate      — кэш автоанализа (без прогона ИИ)
GET  /api/v1/issues/{id}/track[?plate=&date=] — трек+телеметрия; plate/date = трек конкретного ТС (из разбора)
GET  /api/v1/issues/{id}/attachments   — список вложений (+ extractable/kind)
GET  /api/v1/issues/{id}/attachments/{att_id}/download — проксированное скачивание
POST /api/v1/issues/bulk/assignee|type|status          — массовое редактирование
POST /api/v1/issues/{id}/automate_batch                — разбор «общей» заявки по объектам (POST = прогон + кэш)
GET  /api/v1/issues/{id}/automate_batch                — кэш разбора (без прогона)
POST /api/v1/issues/{id}/create_children               — создать вложенные заявки по объектам
```
Результаты автоанализа и разбора кэшируются в таблице `result_cache` (kind=automate|batch) — UI показывает сохранённое без повторного прогона ИИ; кнопка «Обновить» = форс-прогон (POST).

## Автоматизация (Phase A) + анализ

```
app/services/issue_automation.py        # IssueAutomationService: parse → telemetry → classify → draft → track → training sample
app/services/attachment_reader.py       # PDF/Word/Excel + OCR (PyMuPDF+tesseract rus+eng)
app/core/gpspos_geo/service.py          # find_object_by_plate, get_daily_stats, get_packets
```
- **Пробег**: считается из реального трека (сумма haversine по пакетам, без телепортов) — НЕ из DailyStat.length (он отстаёт, не отражает догрузку из чёрного ящика).
- **Парсинг**: гос.номер (с/без региона), дата неисправности (приоритет «за <дата>», не первая дата отчёта), ПЛ/одометр (требует единицу км/м).
- **Категории**: Данные верны / Глушение / Не было питания / Терминал подключился / Изменили настройки / Диагностика. Глушение — по телепортам трека/потере спутников (НЕ по одиночным выбросам скорости). Обрыв трека → «Терминал подключился» (потеря связи + поздняя выгрузка). Занижение пробега vs ПЛ → conf ≤0.7 + needs_review.
- Текст вложений (вкл. OCR сканов) идёт в парсинг + промпт DeepSeek.
- Каждое решение через систему → строка в `training_samples` (факты телеметрии + ответ оператора) для будущего обучения.
- ⚠️ Снапшот в моменте ≠ финальные данные (поздняя выгрузка) — поэтому неопределённость честно помечается на проверку.

**Дата неисправности** (приоритет): «Дата неисправности <дата>» → «в системе [с] <дата>» → «за <дата>» → дата в теме → первая дата. (Первая дата в тексте обычно дата отчёта/отправки, не неисправности — особенно акты Волжского ПО.)
**Поиск объекта geo** по ядру гос.номера без региона (Х371РХ64 → находит «Х371РХ ГАЗ»).
**Назначение ответственного**: `PATCH issues/{id}/assignees` (мн.ч.) + `{assignee_id, group_id}` — группа сотрудника ОБЯЗАТЕЛЬНА (бэкенд резолвит её из employees/list). Путь `issues/{id}/assignee` (ед.ч.) — 404.
**OCR под systemd**: PATH сервиса = только venv, без `/usr/bin` → pytesseract не находил бинарь и OCR молча не работал. Путь к tesseract прописан явно в `attachment_reader._ensure_tesseract_cmd`.
**Гос.номер латиница↔кириллица**: канонизация (A759PC → А759РС) в `_norm_plate`.
**Спецтехника**: формат 4 цифры + 2 буквы в любом порядке (5297СУ / СУ5297); сопоставление с geo по канонической сигнатуре (`_special_sig`), т.к. порядок цифр/букв и регион в данных geo непостоянны.
**Дата неисправности** также из ISO (YYYY-MM-DD) — для дочерних заявок (раньше ISO не читался; теперь дочерние пишут «Дата неисправности: ДД.ММ.ГГГГ»).
**Разбор по объектам**: глушение приоритетнее совпадения пробега (спуфинг/круг = трек недостоверен, не «данные верны» даже если пробег совпал). У каждого объекта — кнопка 🗺 (трек этого ТС через `track?plate=&date=`).
**Разбор «общих» заявок**: заявка с ≥2 извлекаемыми вложениями (по акту на ТС) → одиночный автоанализ скрыт, показывается «Разбор по объектам» (таблица вердиктов). По объектам «данные верны» — кнопка создания вложенных заявок.
**Создание заявок в Okdesk**: `POST issues` тело `{"issue": {...}}`. Тип на создании ИГНОРИРУЕТСЯ (ставится отдельным `PATCH issues/{id}/types`). Тип «Расхождение пробега» требует кастомный параметр `address` (Местоположение техники) непустым; коды параметров: `address`, `contact_person`, `tel_person`.

---

## Деплой

```bash
# Локально: build frontend + commit + push
cd frontend && npm run build
cd .. && git add app/static/ && git commit -m "..." && git push origin main

# На сервере:
ssh -i /c/Users/sPec/.ssh/id_ed25519 root@155.212.186.165 \
  "cd /opt/support-ai-agent && git pull --rebase origin main && systemctl restart support-ai-agent"

# Проверка
curl http://localhost:8001/api/v1/employees
```

---

## Последние изменения (сессия 7 — 2026-06-15)

| Коммит | Что сделано |
|---|---|
| `a0e7d6a` | feat: Phase A — автоанализ заявок «Расхождение пробега» |
| `0e00dc2` | feat: детект глушения по телепортам/выбросам/спутникам |
| `4eb386c` | feat: карта трека (Leaflet) + графики (uPlot) |
| `3bdd3c3` | feat: зум графика, точка на карте, быстрое решение из комментария |
| `164f343` | feat: маркер на карте, сортировка/память шаблонов |
| `30f9458` | feat: задел обучения (TrainingSample), подсветка строки |
| `c47dc88`/`26f48d4` | feat: Фаза B — вложения + OCR (PyMuPDF + tesseract rus+eng) |
| `717c02b` | feat: Фаза C — массовое редактирование (чекбоксы + bulk) |
| `57eede4` | fix: пробег из трека пакетов; путь типов issues/types; шаблоны в bulk |
| `7483ab3`/`11b16d0` | fix: калибровка глушения, сценарий поздней выгрузки |
| `4c56a7f` | fix: дата «за <дата>», ПЛ/одометр с единицей, обрыв→терминал подключился |

### Сессия 8 (после дня эксплуатации)

| Коммит | Что сделано |
|---|---|
| `877bc8c` | fix: назначение (PATCH issues/{id}/assignees + group_id) — чинит bulk и «Взять себе»; дата из «дата неисправности»/«в системе»; поиск объекта по ядру номера без региона |
| `63ba0fb` | fix: явный путь к tesseract (systemd PATH без /usr/bin) — OCR сканов молча не работал |
| `7e49beb` | feat: фильтры № заявки и ответственный (комбинируются); статус объекта в панели карты (онлайн/посл.сообщение/IMEI/телефон с копированием) + кнопка свернуть из панели |
| `843f96f` | fix: build_track читает вложения (трек для заявок с датой/номером в скане) |

### Сессия 9 (наблюдения за 2-й день)

| Что сделано |
|---|
| fix: латиница↔кириллица в гос.номере (A759PC→А759РС) |
| fix: смена типа через список-кнопки (срабатывает с первого раза); № заявки только с клавиатуры; серые чекбоксы; липкая шапка деталей |
| feat: разбор «общих» заявок — пакетный анализ по ТС из вложений (таблица вердиктов) + массовый ответ про глушение |
| feat: создание вложенных заявок в Okdesk по объектам «данные верны» (parent_id + тип отдельным вызовом) |
| feat: для batch-заявок одиночный автоанализ скрыт; тостер при решении без типа |
| feat: кэш/история анализа (result_cache) — показ без повторного прогона ИИ, кнопка «Обновить» |
| feat: карта+графики по каждому объекту разбора (🗺), per-object track `?plate=&date=` |
| fix: глушение приоритетнее совпадения пробега в разборе (спуфинг ≠ «данные верны») |
| fix: распознавание спецтехники (5297СУ/СУ5297); дата из ISO; связанные заявки кликабельны; статус объекта в треке виден без данных за дату |

---

## Нерешённые проблемы / TODO

- **Разбор «общих» заявок** на несколько ТС (тип «Внутренняя», список ТС во вложении) в отдельные заявки — см. память `project_batch_issue_split`.
- **OCR ограничен** 6 страницами/документ, ~200 DPI; парсер ПЛ из табличного OCR можно докрутить.
- **OCR блокирует event loop** (~15–20с при автоанализе/карте на сканах) — вынести в threadpool/фон или кэшировать извлечённый текст.
- **Обучение ИИ**: `training_samples` копится — следующий шаг few-shot retrieval / fine-tune.
- **Телефония Mango** и **Telegram-канал** — будущие каналы заявок.
- **Wialon** не подключён к агенту. **Okdesk webhook** не настроен. **Диск сервера** — мониторить (сейчас 69%).

---

## Дальнейшие шаги

1. ✅ Phase 1–2 (Backend cache, React дашборд)
2. ✅ Phase A: автоанализ (geo-телеметрия + классификация + черновик + решение)
3. ✅ Phase B: вложения + OCR (ИИ читает акты/путевые листы)
4. ✅ Phase C: массовое редактирование + карта/графики + задел обучения
5. ⬜ Разбор «общих» заявок; обучение ИИ на накопленных решениях; Mango/Telegram
