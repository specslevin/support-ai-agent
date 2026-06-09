# 🤖 Support AI Agent — Контекст проекта

## 🎯 Цель
Автоматизация работы специалиста техподдержки GPSPOS через Telegram-бота с ИИ-агентом.

## 🏗 Архитектура
```
support-ai-agent/
├── app/
│   ├── main.py                 # FastAPI entry point + lifespan
│   ├── core/
│   │   ├── config.py          # Единый EnvSettings для .env
│   │   ├── llm/
│   │   │   ├── router.py      # YandexGPT + Ollama fallback
│   │   │   ├── yandex_client.py
│   │   │   └── ollama_client.py
│   │   ├── gpspos/
│   │   │   ├── auth.py        # Token/Refresh, кеш
│   │   │   ├── client.py      # httpx async client с retry
│   │   │   ├── models.py      # Pydantic модели ответов
│   │   │   └── diagnostics.py # Высокоуровневые методы для техподдержки
│   │   ├── tools/
│   │   │   ├── definitions.py # OpenAI-style function schemas
│   │   │   └── registry.py    # Связка name → async function
│   │   ├── agent/
│   │   │   ├── orchestrator.py # Message → LLM → tools → response
│   │   │   └── prompts.py     # Системные промпты на русском
│   │   └── telegram/
│   │       ├── bot.py         # aiogram init + proxy support
│   │       ├── handlers.py    # /start, /статус, text messages
│   │       └── settings.py    # TELEGRAM_PROXY_URL и др.
│   └── modules/               # (опционально) вынесенные модули
├── scripts/
│   ├── deploy.sh              # Ubuntu 24.04 setup
│   └── run_prod.sh            # uvicorn production run
├── .env.example              # Шаблон конфигурации
├── requirements.txt          # Зависимости
└── README.md                 # Документация
```

## 🔑 Ключевые компоненты

| Модуль | Ответственность | Статус |
|--------|----------------|--------|
| `gpspos_client` | API навигации: статус, события, геокод | ✅ Работает |
| `tools registry` | Function calling для LLM | ✅ Готов |
| `orchestrator` | Цикл: сообщение → LLM → инструменты → ответ | ✅ Заглушка |
| `telegram bot` | Приём/отправка сообщений, polling с ретраями | ✅ Работает |
| `llm router` | YandexGPT + Ollama fallback | 🟡 В разработке |

## 🌐 Внешние интеграции

- **GPSPOS API** (`nav.gpspos.ru/api`) — мониторинг транспорта ✅
- **Telegram Bot API** — интерфейс для пользователя ✅
- **Okdesk** — заявки (планируется) ⏳
- **Hermes LLM** (Ollama) — локальная модель (планируется) ⏳

## ⚙️ Конфигурация (.env)

```env
# GPSPOS
GPSPOS_USERNAME=
GPSPOS_PASSWORD=
GPSPOS_BASE_URL=https://nav.gpspos.ru/api

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_MODE=polling  # или webhook
TELEGRAM_PROXY_URL=socks5://127.0.0.1:1080  # опционально

# LLM
LLM_PROVIDER=mock  # mock / hermes / yandex
HERMES_API_URL=http://localhost:8080/v1
```

## 🚀 Запуск

```bash
# Локально (тест)
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# Продакшен (без reload)
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# Деплой на Ubuntu
bash scripts/deploy.sh
```

## 📋 Статус разработки

- [x] Базовая структура FastAPI
- [x] GPSPOS API клиент + диагностика
- [x] Tools registry для function calling
- [x] Telegram бот с polling + proxy
- [x] Orchestrator с mock LLM
- [x] Оkdesk интеграция: заявки, компании, контакты, оборудование
- [x] Многоисточниковая синхронизация компаний (160 шт. из issues/contacts/equipment)
- [ ] Подключение Hermes LLM (Ollama)
- [ ] Деплой на VDS
- [ ] E2E тесты

## 👥 Роли в разработке

- **Пользователь**: идеи, контроль качества, финальное тестирование
- **Проджект (я)**: архитектура, промпты для Cursor, анализ отчётов
- **Cursor**: генерация кода по промптам