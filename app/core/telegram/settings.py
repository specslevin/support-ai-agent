"""Runtime settings for Telegram bot and LLM provider selection."""

from __future__ import annotations

from app.core.config import EnvSettings


class TelegramRuntimeSettings(EnvSettings):
    TELEGRAM_BOT_TOKEN: str = ""
    TELEGRAM_WEBHOOK_URL: str | None = None
    TELEGRAM_MODE: str = "polling"
    TELEGRAM_WEBHOOK_SECRET: str | None = None
    TELEGRAM_PROXY_URL: str | None = None
    TELEGRAM_PROXY_VERIFY_SSL: bool = True
    LLM_PROVIDER: str = "mock"
    HERMES_API_URL: str = "http://localhost:8080/v1"
