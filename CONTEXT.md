# Support AI Agent — Контекст проекта

> Этот файл поддерживается Claude Code и обновляется в начале каждой сессии.
> **Последнее обновление:** 2026-06-13 (сессия 5)

---

## Цель

Telegram-бот для специалиста техподдержки GPSPOS. Бот принимает вопрос в свободной форме,
вызывает нужные инструменты (Okdesk, GPSPOS, GPSPOS Geo) и возвращает структурированный ответ.

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
│   ├── main.py                         # FastAPI + lifespan (DI, polling запуск)
│   ├── api/v1/
│   │   ├── router.py                   # агрегатор роутов
│   │   ├── endpoints/
│   │   │   ├── webhooks.py             # POST /webhooks/okdesk
│   │   │   ├── test.py                 # POST /test/pipeline
│   │   │   └── issues_dashboard.py    # ✅ NEW: 6 endpoints для дашборда
│   │   └── schemas/
│   │       └── issues.py              # ✅ NEW: Pydantic schemas
│   ├── core/
│   │   ├── ai/
│   │   │   ├── agent.py               # AIAgent (DeepSeek + tool calling)
│   │   │   ├── llm.py                 # LLMClient → DeepSeek API
│   │   │   └── tools.py               # 12 инструментов
│   │   ├── db/
│   │   │   ├── database.py            # SQLite async (support_agent.db)
│   │   │   ├── models.py              # Company, Object, Issue, ChatHistory, IssueCache, AnalysisCache ✅
│   │   │   └── sync.py                # sync_companies()
│   │   ├── services/
│   │   │   └── cache_service.py       # ✅ NEW: CacheService (refresh + query + save)
│   │   ├── gpspos/                     # GPSPOS Nav API (nav.gpspos.ru)
│   │   ├── gpspos_geo/                 # GPSPOS Geo API (geo.gpspos.ru)
│   │   ├── okdesk/                     # Okdesk CRM REST API
│   │   ├── wialon/                     # Wialon API (заглушка)
│   │   └── telegram/                   # aiogram 3.x бот
│   └── services/
│       └── intelligence_service.py    # LLM-triage для webhook
├── frontend/                          # 🚧 Phase 2 — React (в разработке)
├── scripts/
├── requirements.txt
├── .env
└── CONTEXT.md / WEB_DASHBOARD_ARCHITECTURE.md
```

---

## Статус компонентов

| Компонент | Статус | Примечание |
|---|---|---|
| **AIAgent** (`core/ai/agent.py`) | ✅ Работает | DeepSeek, tool calling, история в БД |
| **LLMClient** (`core/ai/llm.py`) | ✅ Работает | DeepSeek API (`deepseek-v4-flash`) |
| **Tools** (`core/ai/tools.py`) | ✅ 12 инструментов | см. ниже |
| **Okdesk** (`core/okdesk/`) | ✅ Работает | компании, заявки, поиск |
| **GPSPOS Nav** (`core/gpspos/`) | ✅ Работает | статус объекта по госномеру/IMEI |
| **GPSPOS Geo** (`core/gpspos_geo/`) | ✅ Работает | объекты, статус, геозоны |
| **DB sync** (`core/db/sync.py`) | ✅ Работает | 164 компании синхронизируются |
| **Telegram polling** | ✅ Работает | aiogram 3.x, resilient polling |
| **Wialon** (`core/wialon/`) | ⚠️ Заглушка | клиент есть, в агент НЕ подключён |
| **IntelligenceService** | ✅ Подключена | LLM-triage через DeepSeek, webhook `/api/v1/webhooks/okdesk` |
| **IssueCache / AnalysisCache** | ✅ Phase 1 | DB таблицы + CacheService + 6 API endpoints |
| **Dashboard API** (`api/v1/issues`) | ✅ Задеплоен | 1000 заявок в кэше, pagination/filter/search |

---

## Инструменты агента (AIAgent tools)

**Okdesk:**
1. `search_company(name)` — нечёткий поиск компании (DB + Okdesk)
2. `list_companies(limit, search)` — список всех компаний
3. `list_issues(company_name, limit)` — список заявок (фильтр по компании)
4. `get_issue_details(issue_id)` — полное содержимое заявки (описание, статус, приоритет, даты)
5. `get_issue_comments(issue_id)` — комментарии/переписка по заявке
6. `add_comment(issue_id, text)` — написать внутренний комментарий в заявку
7. `get_company_equipment(company_name)` — оборудование компании (трекеры, устройства)

**GPSPOS Nav (nav.gpspos.ru):**
8. `get_object_status(name)` — статус объекта по госномеру/IMEI

**GPSPOS Geo (geo.gpspos.ru):**
9. `list_geo_objects()` — список всех объектов
10. `get_geo_object_status(object_id)` — текущий статус объекта (координаты, скорость)
11. `list_geozones()` — список геозон
12. `get_object_events(object_id, hours)` — история событий объекта (зажигание, геозоны, тревоги)

---

## Конфигурация (.env на сервере)

```env
# GPSPOS Nav
GPSPOS_USERNAME=sergey.r
GPSPOS_BASE_URL=https://nav.gpspos.ru/api

# GPSPOS Geo
GPSPOS_GEO_BASE_URL=https://geo.gpspos.ru/api
GPSPOS_GEO_USERNAME=admin

# Wialon (не активно)
WIALON_BASE_URL=https://host.local3.wialon.host/wialon/ajax.html

# Telegram
TELEGRAM_MODE=polling

# LLM
LLM_PROVIDER=mock          # для SupportAgent (legacy)
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-v4-flash

# Okdesk
OKDESK_BASE_URL=https://gpspos.okdesk.ru/api/v1
```

---

## Деплой

```bash
# Код
git push origin main
ssh -i /c/Users/sPec/.ssh/id_ed25519 root@155.212.186.165 \
  "cd /opt/support-ai-agent && git pull && systemctl restart support-ai-agent.service"

# Проверка
ssh ... "systemctl status support-ai-agent && curl -s http://localhost:8001/health"
```

---

## Последние изменения

| Дата | Коммит | Что сделано |
|---|---|---|
| 2026-06-13 | `7553f98` | fix: page[size]=50, лимит 1000 заявок на refresh |
| 2026-06-13 | `49d525a` | fix: Okdesk pagination — page[number]/page[size] |
| 2026-06-13 | `fe00ee4` | feat: Phase 1 backend — IssueCache, CacheService, 6 dashboard endpoints |
| 2026-06-11 | `2f88347` | feat: IntelligenceService → Okdesk webhook через DeepSeek |
| 2026-06-11 | `b867cac` | feat: /история, улучшен промпт, удалён legacy SupportAgent |
| 2026-06-11 | `af7df44` | feat: 5 новых инструментов (детали заявки, комментарии, оборудование, события Geo) |

---

## Нерешённые проблемы

- **Diск сервера** — мониторить (был 89% в июне)
- **Wialon не подключён** к агенту — есть клиент/сервис, но нет инструментов
- **Okdesk webhook не настроен** — нужно добавить URL в настройках Okdesk
- **Cache refresh только ручной** — фоновая задача (каждые 5 мин) запланирована на Phase 1.5
- **IssueCache.company_name** — у ~половины заявок null (Okdesk не всегда возвращает company)

---

## Дальнейшие шаги

### Текущая фаза: Phase 2 — React Frontend
1. ✅ Phase 1 Backend задеплоен (1000 заявок в кэше)
2. 🚧 **Phase 2: React + Vite frontend** — в работе
3. ⬜ Phase 1.5: фоновый refresh каждые 5 мин (BackgroundTasks или APScheduler)
4. ⬜ Phase 3: AI-анализ пробегов (DeepSeek + Geo mileage)
5. ⬜ Phase 4: Polish + deploy frontend
