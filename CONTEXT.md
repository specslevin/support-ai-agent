# Support AI Agent — Контекст проекта

> Этот файл поддерживается Claude Code и обновляется в начале каждой сессии.
> **Последнее обновление:** 2026-06-13 (сессия 6)

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
GET  /api/v1/employees                 — список активных сотрудников
```

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

## Последние изменения (сессия 6)

| Коммит | Что сделано |
|---|---|
| `f94eee9` | feat: assignee — показ, "Взять себе", picker по группам |
| `efc1657` | fix: правильные Okdesk ID сотрудников, build фронтенда |
| `b0135da` | fix: sync assignee для всех заявок (не только активных) |
| `cb74484` | feat: пагинация 20/50/100 |
| `f6b1c0a` | feat: полные детали заявки из Okdesk |
| `3321cf2` | fix: ftcheckbox параметры (1→Да, 0→скрыть) |
| `87b72c8` | fix: скрывать параметры < 3 символов |
| `d767c39` | fix: извлечение телефона из contact_person |

---

## Нерешённые проблемы

- **Диск сервера** — мониторить (был 89% в июне)
- **Wialon не подключён** к агенту
- **Okdesk webhook не настроен** — нужно добавить URL в настройках Okdesk
- **Phase 3** (AI-анализ пробегов) — отложена

---

## Дальнейшие шаги

1. ✅ Phase 1 Backend (IssueCache, CacheService, API)
2. ✅ Phase 1.5 (фоновый refresh каждые 5 мин)
3. ✅ Phase 2 (React frontend, дашборд заявок)
4. ⬜ Phase 3: AI-анализ пробегов (DeepSeek + Geo mileage)
5. ⬜ Phase 4: Polish + улучшения UX
