# Support AI Agent — Контекст проекта

> Этот файл поддерживается Claude Code и обновляется в начале каждой сессии.
> **Последнее обновление:** 2026-06-11 (сессия 2)

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
│   ├── api/v1/                         # REST endpoints (health, webhooks, test)
│   ├── core/
│   │   ├── ai/
│   │   │   ├── agent.py               # AIAgent — главный агент (DeepSeek + tool calling)
│   │   │   ├── llm.py                 # LLMClient (AsyncOpenAI → DeepSeek API)
│   │   │   └── tools.py               # 7 инструментов + build_tool_functions()
│   │   ├── agent/                      # SupportAgent — старый оркестратор (legacy)
│   │   │   ├── orchestrator.py        # regex-роутинг + mock LLM
│   │   │   └── prompts.py
│   │   ├── db/
│   │   │   ├── database.py            # SQLite async (support_agent.db)
│   │   │   ├── models.py              # Company, ChatHistory
│   │   │   └── sync.py                # sync_companies() — синхронизация с Okdesk
│   │   ├── gpspos/                     # GPSPOS Nav API (nav.gpspos.ru)
│   │   │   ├── auth.py                # token refresh, кэш
│   │   │   ├── client.py              # httpx async
│   │   │   ├── diagnostics.py         # find_object_by_identifier, get_object_status
│   │   │   └── models.py
│   │   ├── gpspos_geo/                 # GPSPOS Geo API (geo.gpspos.ru)
│   │   │   ├── client.py
│   │   │   ├── service.py             # list_objects, get_status, list_geozones
│   │   │   └── config.py
│   │   ├── okdesk/                     # Okdesk CRM
│   │   │   ├── client.py
│   │   │   ├── service.py             # list_companies, list_issues, ...
│   │   │   └── models.py
│   │   ├── wialon/                     # Wialon API (заглушка, не подключена к агенту)
│   │   │   ├── client.py
│   │   │   ├── service.py
│   │   │   └── models.py
│   │   └── telegram/
│   │       ├── bot.py                 # create_bot, run_polling_with_retries
│   │       ├── handlers.py            # /start, /статус, text → AIAgent
│   │       └── settings.py
│   └── services/
│       └── intelligence_service.py    # LLM-triage для заявок (не подключена)
├── scripts/
│   ├── deploy.sh
│   └── run_prod.sh
├── requirements.txt
├── .env                               # секреты (не в git)
└── .env.example
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
| **SupportAgent** (`core/agent/`) | 🟡 Legacy | старый оркестратор, ещё используется |
| **IntelligenceService** | ⚠️ Не подключена | LLM-triage, отдельный модуль |

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
| 2026-06-11 | `af7df44` | feat: 5 новых инструментов (детали заявки, комментарии, оборудование, события Geo) |
| 2026-06-11 | `df8be05` | fix: SIGTERM — выход из polling loop при остановке сервиса |
| 2026-06-09 | `0e3677f` | feat: интеграция GPSPOS Geo в lifespan, DI, инструменты агента |
| 2026-06-08 | `01920d5` | feat: рефакторинг, удаление дублей, заглушки Wialon/Geo |

---

## Нерешённые проблемы

- **Диск 56%** — почищен 2026-06-11 (удалён .vscode-server 2.5GB, npm кэш, journal)
- **Wialon не подключён** к агенту — есть клиент/сервис, но нет инструментов
- **SupportAgent (legacy)** — дублирует логику AIAgent, надо решить судьбу
- **IntelligenceService** — написан, но не интегрирован в пайплайн
- **История в БД** — нет инструмента для просмотра из бота

---

## Дальнейшие шаги (к обсуждению)

1. Подключить Wialon к инструментам агента
2. Разобраться с legacy SupportAgent — убрать или оставить как fallback
3. Добавить в агент инструмент просмотра истории чата
4. Настроить мониторинг (uptime, лог-ошибки)
5. Почистить диск сервера
