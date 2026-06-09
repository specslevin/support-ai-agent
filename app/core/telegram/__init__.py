"""Telegram bot (aiogram 3.x) integration."""

from __future__ import annotations

from .bot import create_bot, run_polling_with_retries, setup_dispatcher
from .settings import TelegramRuntimeSettings

__all__ = [
    "TelegramRuntimeSettings",
    "create_bot",
    "run_polling_with_retries",
    "setup_dispatcher",
]
