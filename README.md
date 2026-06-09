# support-ai-agent

FastAPI-сервис техподдержки: Okdesk, GPSPOS (nav.gpspos.ru), Telegram-бот (aiogram 3.x), заглушка LLM.

## Запуск

```bash
python -m pip install -r requirements.txt
# Создайте .env из шаблона и заполните секреты:
cp .env.example .env
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Для разработки с автоперезагрузкой можно добавить `--reload`; для стабильного polling Telegram лучше запуск **без** `--reload`, чтобы не рвать соединение при перезапуске процесса.

## Настройка прокси (Telegram)

Если API Telegram недоступен или нестабилен (VPN, корпоративная сеть), задайте в `.env`:

| Переменная | Описание |
|------------|----------|
| `TELEGRAM_PROXY_URL` | URL прокси или пусто для прямого подключения |
| `TELEGRAM_PROXY_VERIFY_SSL` | `true` / `false` — проверка TLS к API (только для отладки) |

Примеры значений `TELEGRAM_PROXY_URL`:

- **SOCKS5** (Tor, многие VPN-клиенты): `socks5://127.0.0.1:1080`
- **SOCKS5 с логином**: `socks5://user:pass@host:1080`
- **HTTP-прокси с авторизацией**: `http://user:pass@proxy.example.com:8080`
- **HTTP без авторизации**: `http://proxy.example.com:8080`

Нужен пакет **`aiohttp-socks`** (указан в `requirements.txt`). Polling при сетевых ошибках автоматически делает паузы 1 → 2 → 4 → 8 → 16 с и продолжает попытки.

## Эндпоинты

- `GET /health` — проверка живости
- `POST /webhook/telegram` — webhook Telegram (режим `TELEGRAM_MODE=webhook`)
- `GET /docs` — OpenAPI
