# Support AI Agent — Контекст проекта

> Этот файл поддерживается Claude Code и обновляется в начале каждой сессии.
> **Последнее обновление:** 2026-06-15 (сессия 7)

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
GET  /api/v1/issues                    — список с фильтрами и пагинацией
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
POST /api/v1/issues/{id}/automate      — автоанализ «Расхождение пробега» + черновик ответа
GET  /api/v1/issues/{id}/track         — точки трека + телеметрия (карта/графики)
GET  /api/v1/issues/{id}/attachments   — список вложений (+ extractable/kind)
GET  /api/v1/issues/{id}/attachments/{att_id}/download — проксированное скачивание
POST /api/v1/issues/bulk/assignee|type|status          — массовое редактирование
```

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

---

## Нерешённые проблемы / TODO

- **Разбор «общих» заявок** на несколько ТС (тип «Внутренняя», список ТС во вложении) в отдельные заявки — см. память `project_batch_issue_split`.
- **OCR ограничен** 6 страницами/документ, ~200 DPI; парсер ПЛ из табличного OCR можно докрутить.
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
