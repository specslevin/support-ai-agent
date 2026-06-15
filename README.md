# support-ai-agent

Центр управления заявками Okdesk — React + FastAPI dashboard для GPS-поддержки.
ИИ-автоанализ заявок «Расхождение пробега» (geo-телеметрия + DeepSeek), карта трека и графики,
чтение вложений с OCR, массовое редактирование.

## Быстрый старт

```bash
cp .env.example .env  # заполнить секреты
pip install -r requirements.txt
# OCR сканов (системная зависимость):
sudo apt-get install -y tesseract-ocr tesseract-ocr-rus
# Собрать frontend:
cd frontend && npm install && npm run build && cd ..
uvicorn app.main:app --host 0.0.0.0 --port 8001
```

Сервис доступен на `http://localhost:8001` (frontend отдаётся как static из FastAPI).

## .env — обязательные переменные

| Переменная | Описание |
|---|---|
| `OKDESK_API_TOKEN` | API-токен Okdesk |
| `OKDESK_BASE_URL` | `https://gpspos.okdesk.ru/api/v1` |
| `OKDESK_EMPLOYEE_ID` | ID сотрудника-владельца токена (по умолчанию `22`) |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота |
| `DEEPSEEK_API_KEY` | Ключ LLM (DeepSeek) |
| `GPSPOS_GEO_BASE_URL` | `https://geo.gpspos.ru/api` |
| `GPSPOS_GEO_USERNAME` / `GPSPOS_GEO_PASSWORD` | Доступ к geo.gpspos.ru |

## Возможности

- **Дашборд заявок**: список с фильтрами (№ заявки, тема, статус, ответственный, компания — комбинируются) и пагинацией (запоминается), детали из Okdesk, комментарии, смена статуса/типа/ответственного.
- **ИИ-автоанализ** «Расхождение пробега»: парсинг (гос.номер, дата неисправности, ПЛ) → данные geo (пробег из трека пакетов, напряжение, спутники, телепорты) → классификация (Данные верны / Глушение / Не было питания / Терминал подключился / Изменили настройки / Диагностика) → черновик ответа → «В комментарий» / «Ответить и решить».
- **Карта трека + графики** (Leaflet + uPlot): трек с подсветкой телепортов, графики скорость/напряжение/спутники, зум колёсиком, синхронная точка на карте, статистика по интервалу.
- **Вложения + OCR**: чтение PDF/Word/Excel и сканов (tesseract rus+eng) — текст идёт в анализ ИИ; просмотр/скачивание в UI.
- **Массовое редактирование**: чекбоксы + bulk статус/тип/ответственный с шаблонами.
- **Разбор «общих» заявок**: для заявок с несколькими вложениями (акт на ТС) — таблица вердиктов по каждому объекту, массовый ответ про глушение и создание вложенных заявок по объектам с корректными данными.
- **Задел для обучения**: каждое решение пишется в `training_samples` (телеметрия + ответ оператора).

## Архитектура

```
app/
├── api/v1/endpoints/
│   ├── issues_dashboard.py   # CRUD + actions + automate/track/attachments/bulk
│   ├── employees.py          # Список сотрудников
│   ├── issue_types.py        # Типы заявок (Okdesk issues/types)
│   └── templates.py          # Шаблоны ответов (из okdesk-console SQLite)
├── services/
│   ├── issue_automation.py   # Парсинг → телеметрия → классификация → черновик → трек → training sample
│   └── attachment_reader.py  # Извлечение текста: PDF/Word/Excel + OCR (PyMuPDF + tesseract)
├── core/
│   ├── okdesk/               # Okdesk API client + service + models (+ attachments)
│   ├── services/cache_service.py   # SQLite кэш заявок + training samples
│   ├── db/models.py          # IssueCache, AnalysisCache, TrainingSample, ...
│   ├── ai/                   # DeepSeek LLM
│   ├── telegram/             # Telegram-бот (aiogram 3.x)
│   ├── gpspos_geo/           # GPSPOS Geo API (объекты, DailyStat, ObjectPackets)
│   └── gpspos/               # GPSPOS Nav API
frontend/src/
├── components/
│   ├── IssueDetail.tsx       # Карточка заявки: анализ ИИ, вложения, комментарии, действия
│   ├── IssuesList.tsx        # Список + чекбоксы + панель массовых действий
│   ├── TrackPanel.tsx        # Карта трека (Leaflet) + графики (uPlot) + статистика
│   ├── IssueFilters.tsx      # Фильтры (статус, компания, поиск)
│   └── StatusBadge.tsx       # Бейдж статуса
├── api/client.ts             # Axios API клиент
├── store/                    # Zustand stores (persist: pageSize, lastTemplate)
└── types/index.ts            # TypeScript типы
```

## API endpoints

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/v1/issues` | Список заявок; фильтры `status`/`company`/`search`/`assignee`/`issue_id` (комбинируются), пагинация |
| GET | `/api/v1/issues/{id}` | Детали заявки + live Okdesk данные |
| POST | `/api/v1/issues/{id}/automate` | ИИ-автоанализ + черновик ответа |
| GET | `/api/v1/issues/{id}/track` | Точки трека + телеметрия (карта/графики) |
| GET | `/api/v1/issues/{id}/attachments` | Список вложений |
| GET | `/api/v1/issues/{id}/attachments/{att_id}/download` | Скачивание вложения (прокси) |
| POST | `/api/v1/issues/{id}/resolve` | Смена статуса + комментарий |
| POST | `/api/v1/issues/{id}/comments` | Добавить комментарий (public/private) |
| PATCH | `/api/v1/issues/{id}/type` | Сменить тип заявки |
| PATCH | `/api/v1/issues/{id}/assignee` | Назначить ответственного |
| POST | `/api/v1/issues/bulk/assignee\|type\|status` | Массовое редактирование |
| POST | `/api/v1/issues/{id}/automate_batch` | Разбор «общей» заявки по объектам (вложение = ТС) |
| POST | `/api/v1/issues/{id}/create_children` | Создать вложенные заявки по объектам |
| GET | `/api/v1/issues/cache/refresh` | Обновить кэш из Okdesk |
| GET | `/api/v1/employees` | Список сотрудников |
| GET | `/api/v1/issue-types` | Типы заявок |
| GET | `/api/v1/templates` | Шаблоны ответов |

## Деплой (production)

```
Сервер:   root@155.212.186.165
Путь:     /opt/support-ai-agent
Сервис:   systemd support-ai-agent (порт 8001)
Frontend: собирается в app/static/ командой npm run build
OCR:      tesseract-ocr + tesseract-ocr-rus (установлены системно)
```

```bash
# Локально: собрать фронт, закоммитить, запушить
cd frontend && npm run build && cd ..
git add -A && git commit -m "..." && git push origin main
# На сервере:
ssh -i ~/.ssh/id_ed25519 root@155.212.186.165 \
  "cd /opt/support-ai-agent && git pull --rebase origin main && \
   ./.venv/bin/pip install -r requirements.txt && systemctl restart support-ai-agent"
```
