# Документация проекта support-ai-agent

**Последнее обновление:** 2026-06-15 (сессия 7)  
**Статус:** Production — дашборд + ИИ-автоанализ + вложения/OCR + карта/графики + массовое редактирование

---

## Что это

Центр управления заявками технической поддержки GPS-мониторинга (GPSPOS).  
Интегрирован с Okdesk (helpdesk), GPSPOS Geo API, Telegram-ботом и DeepSeek LLM.

---

## Компоненты

### Backend (FastAPI + SQLite)

| Файл | Назначение |
|---|---|
| `app/main.py` | Точка входа, startup/shutdown, static files |
| `app/api/v1/router.py` | Регистрация всех роутеров |
| `app/api/v1/endpoints/issues_dashboard.py` | Главные endpoints заявок |
| `app/api/v1/endpoints/employees.py` | Список сотрудников Okdesk |
| `app/api/v1/endpoints/issue_types.py` | Типы заявок |
| `app/api/v1/endpoints/templates.py` | Шаблоны из okdesk-console SQLite |
| `app/core/okdesk/client.py` | HTTP клиент Okdesk API |
| `app/core/okdesk/service.py` | Высокоуровневые методы Okdesk |
| `app/core/okdesk/models.py` | Pydantic модели ответов Okdesk |
| `app/core/okdesk/config.py` | Настройки (токен, base URL, employee_id) |
| `app/core/services/cache_service.py` | Кэш заявок в SQLite + refresh + training samples |
| `app/core/db/models.py` | SQLAlchemy модели (IssueCache, AnalysisCache, TrainingSample...) |
| `app/services/issue_automation.py` | **ИИ-автоанализ**: парсинг → телеметрия geo → классификация → черновик → трек → обучающий пример |
| `app/services/attachment_reader.py` | Чтение вложений: PDF/Word/Excel + **OCR** сканов (PyMuPDF + tesseract rus+eng) |
| `app/core/ai/` | DeepSeek LLM agent + tools |
| `app/core/telegram/` | Telegram-бот (aiogram 3.x) |
| `app/core/gpspos_geo/` | GPSPOS Geo API: объекты, DailyStat, ObjectPackets (трек/телеметрия) |
| `app/core/gpspos/` | GPSPOS Nav API |

### Frontend (React 18 + TypeScript + Vite)

| Файл | Назначение |
|---|---|
| `frontend/src/components/IssueDetail.tsx` | Карточка заявки: автоанализ ИИ, вложения, комментарии, шаблоны, действия |
| `frontend/src/components/IssuesList.tsx` | Список + чекбоксы + панель массовых действий |
| `frontend/src/components/TrackPanel.tsx` | Карта трека (Leaflet) + графики телеметрии (uPlot) + статистика по интервалу |
| `frontend/src/components/IssueFilters.tsx` | Фильтры (статус, компания, поиск, сортировка) |
| `frontend/src/components/StatusBadge.tsx` | Бейдж статуса с цветом |
| `frontend/src/api/client.ts` | Axios-клиент всех API вызовов |
| `frontend/src/store/issuesStore.ts` | Zustand: выбор/подсветка заявки, чекбоксы, persist (pageSize, lastTemplate) |
| `frontend/src/store/userStore.ts` | Zustand: текущий пользователь |
| `frontend/src/types/index.ts` | TypeScript интерфейсы |

---

## Функциональность dashboard

### Список заявок
- Фильтры: № заявки (external_id), тема, статус, **ответственный** (+ «Не назначен»), компания — **комбинируются** (AND)
- Чекбоксы + массовое редактирование (ответственный/тип/статус с шаблонами)
- Сортировка по дате/приоритету, пагинация (размер запоминается)
- Обновление кэша вручную

### Карточка заявки (IssueDetail)
- Live данные из Okdesk (не кэш): тип, описание, сроки, автор, параметры
- **Смена типа заявки** — inline выпадашка, доступные типы берутся из Okdesk API
- **Смена статуса** — клик на бейдж статуса → dropdown с доступными переходами (цвета Okdesk)
  - Бизнес-правила: "В работу" только для типов `departure`/`departure_fuel`; финальные статусы заблокированы если тип `inner`
  - Форма с комментарием (обязательный для delayed/no_time) + поле "Отложить до" (для delayed/no_time)
  - Чекбокс "Публичный комментарий" (по умолчанию включён)
- **Добавить комментарий** — textarea + выбор шаблона + чекбокс публичности
- **Шаблоны ответов** — из okdesk-console (отдельный сервис на порту 8000), категории с цветами, избранные, поиск
- **Назначить ответственного** — dropdown сотрудников
- **Быстрое решение** — кнопки «Решить»/«Ожидание» прямо в поле комментария (без модалок), шаблоны
- **Вложения** — список с иконками/размером, бейдж «🤖 ИИ читает», просмотр/скачивание

### ИИ-автоанализ «Расхождение пробега»
- Кнопка «🤖 Автоанализ»: парсинг заявки (гос.номер, дата неисправности по «за <дата>», ПЛ/одометр с единицей) → данные geo → классификация → черновик ответа.
- **Пробег** считается из реального трека (haversine по пакетам, без телепортов), а не из устаревшего `DailyStat.length` — отражает догрузку из чёрного ящика.
- **Категории**: Данные верны / Глушение (по телепортам трека и потере спутников, не по выбросам скорости) / Не было питания / Терминал подключился (обрыв связи + поздняя выгрузка) / Изменили настройки / Диагностика.
- Текст вложений (включая OCR сканов) идёт в парсинг и в промпт DeepSeek.
- Занижение пробега vs ПЛ → уверенность ≤0.7 + флаг «нужна проверка».
- Кнопки внизу блока: «↓ В комментарий» / «✓ Ответить и решить».

### Карта трека + графики (TrackPanel)
- Кнопка «🗺 Карта и графики» в шапке деталей → панель выезжает влево; свернуть — кнопкой «◀ Свернуть» в самой панели.
- **Статус объекта**: онлайн/офлайн, дата последнего сообщения, IMEI и телефон терминала (копирование по клику).
- Карта (Leaflet + OSM): трек, телепорты подсвечены пунктиром, старт/финиш, курсор-маркер при наведении на график.
- Графики (uPlot): скорость/напряжение/спутники, зум колёсиком, drag-выделение.
- Статистика по выбранному интервалу (пробег, скорости, спутники, питание, длительность).

### Массовое редактирование
- Чекбоксы (нейтральный серый) в строках + «выбрать всё» на странице.
- Панель действий: ответственный / тип / статус (с комментарием и шаблонами) для всех выбранных.

### Разбор «общих» заявок (batch)
- Заявка с ≥2 извлекаемыми вложениями (один акт на ТС) → одиночный автоанализ скрыт, кнопка «🗂 Разбор по объектам (N)».
- Таблица: гос.номер / дата / ПЛ / система / вердикт (Глушение / Данные верны / …) + 🗺 трек каждого ТС.
- Глушение приоритетнее совпадения пробега: спуфинг (круг/телепорты) = трек недостоверен → не «данные верны», даже если пробег совпал.
- Кнопка массового ответа про глушение одним комментарием.
- По объектам «данные верны» — **создание вложенных заявок** (`create_children`): дочерняя заявка в Okdesk с `parent_id`, тип «Расхождение пробега».

### Кэш анализа
- Результаты автоанализа и разбора сохраняются в `result_cache` (kind=automate|batch).
- UI показывает сохранённый результат без повторного прогона ИИ (экономия токенов); кнопка «Обновить» = форс-прогон (POST). GET-эндпоинты отдают кэш.

### Распознавание гос.номеров
- Обычные: А123ВС[64], с/без региона, латиница↔кириллица (A759PC→А759РС).
- Спецтехника: 4 цифры + 2 буквы в любом порядке (5297СУ / СУ5297); сопоставление с geo по канонической сигнатуре.
- Связанные заявки (родительская/дочерние) кликабельны — открываются по № в панели деталей.

### Создание заявок в Okdesk (нюансы)
- `POST issues` тело `{"issue": {...}}`. Тип на создании ИГНОРИРУЕТСЯ → ставится отдельным `PATCH issues/{id}/types`.
- Тип «Расхождение пробега» требует непустой кастомный параметр `address` (Местоположение техники). Коды: `address`, `contact_person`, `tel_person`.

### Обучение ИИ (задел)
- Каждое решение через систему → строка в `training_samples` (телеметрия + ответ оператора + статус) для будущего few-shot/fine-tune.

---

## Okdesk API

**Документация:** https://apidocs.okdesk.ru/apidoc/  
Полный справочник всех методов: компании, сотрудники, контакты, заявки, оборудование, объекты, склады, база знаний, телефония, прайс-листы, номенклатура, справочники.

### Используемые endpoints

| Метод | Endpoint | Назначение |
|---|---|---|
| GET | `issues/list` | Список заявок |
| GET | `issues/{id}` | Детали заявки |
| POST | `issues/{id}/comments` | Добавить комментарий (`content`, `author_id`, `public`) |
| GET | `issues/{id}/comments` | Список комментариев |
| POST | `issues/{id}/statuses` | Сменить статус (`code`, `comment`, `comment_public`, `delay_to`) |
| PATCH | `issues/{id}/types` | Сменить тип заявки (`code`) |
| PATCH | `issues/{id}/assignees` | **Назначить ответственного** — тело `{assignee_id, group_id}`; группа сотрудника ОБЯЗАТЕЛЬНА (бэкенд резолвит из employees/list). Путь `issues/{id}/assignee` (ед.ч.) = 404 |
| POST | `issues` | **Создать заявку** — тело `{"issue": {title, description, parent_id, contact_id, custom_parameters}}`. Тип на создании игнорируется (ставить через `issues/{id}/types`) |
| GET | `issues/types` | Список типов заявок (НЕ `references/issue_types` — это 404) |
| GET | `issues/statuses` | Список статусов с кодами и цветами |
| GET | `employees/list` | Список сотрудников |
| GET | `issues/{id}/attachments/{att_id}` | Метаданные вложения + presigned `attachment_url` (живёт ~30с) |

### Статусы Okdesk

| Код | Название | Цвет |
|---|---|---|
| `opened` | Открыта | #3edad8 |
| `delayed` | Ожидание ответа | #bb7db2 |
| `no_time` | Отложена | #f68741 |
| `wait` | В работе | #2b6684 |
| `inst_fin` | Работы завершены | #012e67 |
| `completed` | Решена | #67a030 |
| `closed` | Закрыта | #787880 |

### Типы заявок

`mileage`, `refuel`, `drain`, `settings`, `subscribe`, `agro`, `service`, `departure`, `departure_fuel`, `new_mount`, `geo_galaxy`, `call`, `spam`, `inner` (дефолтный = не выбран)

---

## Шаблоны ответов (okdesk-console)

Отдельный сервис на том же сервере:
- Путь: `/home/okdesk/okdesk-console/`
- SQLite DB: `/home/okdesk/okdesk-console/app.db`
- Порт: 8000 (не доступен снаружи, требует cookie-auth)
- Наш backend читает SQLite напрямую (bypass cookie auth)

---

## Деплой

**Сервер:** `root@155.212.186.165`  
**Путь:** `/opt/support-ai-agent`  
**Сервис:** `systemd support-ai-agent` (порт 8001)

**OCR (системно установлено):** `tesseract-ocr` + `tesseract-ocr-rus`.
⚠️ systemd-юнит имеет минимальный PATH (только venv), поэтому путь к бинарю tesseract прописан явно в коде (`attachment_reader._ensure_tesseract_cmd`). OCR блокирует event loop (~15–20с на сканах) — кандидат на вынос в threadpool/кэш.

```bash
# Деплой новой версии:
git pull
./.venv/bin/pip install -r requirements.txt   # при новых зависимостях
cd frontend && npm run build && cd ..          # обычно фронт собирается локально и коммитится
systemctl restart support-ai-agent

# Логи:
journalctl -u support-ai-agent -f
```

---

## Tech Stack

| Слой | Технологии |
|---|---|
| Backend | FastAPI, Python 3.12, SQLAlchemy async, SQLite, httpx |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand, Axios, Leaflet, uPlot |
| Вложения/OCR | pypdf, python-docx, openpyxl, PyMuPDF, pytesseract + tesseract-ocr (rus+eng) |
| AI | DeepSeek LLM (deepseek-v4-flash) |
| Bot | aiogram 3.x, Telegram |
| Infra | Ubuntu VPS, systemd, Nginx (если нужен) |
