"""aiogram 3.x bot factory, optional proxy, resilient polling."""

from __future__ import annotations

import asyncio

import structlog
from aiohttp import ClientError
from aiogram import Bot, Dispatcher
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.exceptions import TelegramNetworkError

from app.core.ai.agent import AIAgent
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)

# After this many consecutive polling failures, log critical and reset the streak (then retry forever).
_MAX_CONSECUTIVE_POLL_FAILURES = 10
_BACKOFF_MAX_SEC = 16


def _backoff_sec(attempt: int) -> int:
    if attempt < 1:
        return 1
    return min(_BACKOFF_MAX_SEC, 2 ** (attempt - 1))


def _build_aiohttp_session(proxy_url: str | None, verify_ssl: bool) -> AiohttpSession:
    proxy = proxy_url.strip() if proxy_url else None
    if proxy:
        session = AiohttpSession(proxy=proxy)
        scheme = proxy.split("://", 1)[0] if "://" in proxy else "unknown"
        log.info("telegram_proxy_enabled", scheme=scheme)
        init = {**session._connector_init, "force_close": True}
        session._connector_init = init
        session._should_reset_connector = True
    else:
        session = AiohttpSession()

    if not verify_ssl:
        session._connector_init = {**session._connector_init, "ssl": False}
        session._should_reset_connector = True
        log.warning("telegram_proxy_ssl_verify_disabled")

    return session


def create_bot(
    token: str,
    *,
    proxy_url: str | None = None,
    proxy_verify_ssl: bool = True,
) -> Bot:
    session = _build_aiohttp_session(proxy_url, proxy_verify_ssl)
    return Bot(token=token, session=session)


def setup_dispatcher(
    dp: Dispatcher,
    ai_agent: AIAgent | None = None,
    okdesk_service: OkdeskService | None = None,
) -> None:
    from .handlers import build_handlers_router

    dp.include_router(build_handlers_router(ai_agent=ai_agent, okdesk_service=okdesk_service))


async def run_polling_with_retries(dp: Dispatcher, bot: Bot) -> None:
    """
    Long-polling loop with exponential backoff on transport errors.
    Cancels cleanly on ``asyncio.CancelledError`` (app shutdown).
    """
    failures = 0
    while True:
        try:
            log.info("telegram_polling_start", failures_streak=failures)
            await dp.start_polling(bot)
            # start_polling() returned without exception — dispatcher was stopped
            # (e.g. via SIGTERM signal handler). Exit the loop cleanly.
            log.info("telegram_polling_stopped")
            break
        except asyncio.CancelledError:
            log.info("telegram_polling_cancelled")
            raise
        except (TelegramNetworkError, ClientError, OSError, TimeoutError) as e:
            failures += 1
            delay = _backoff_sec(failures)
            log.warning(
                "telegram_polling_network_error",
                error=str(e),
                error_type=type(e).__name__,
                failures_streak=failures,
                sleep_sec=delay,
            )
            if failures >= _MAX_CONSECUTIVE_POLL_FAILURES:
                log.critical(
                    "telegram_polling_max_failures",
                    failures=_MAX_CONSECUTIVE_POLL_FAILURES,
                    detail="resetting failure streak; will keep retrying",
                )
                failures = 0
            await asyncio.sleep(delay)
        except Exception as e:
            failures += 1
            delay = _backoff_sec(failures)
            log.exception(
                "telegram_polling_unexpected_error",
                error=str(e),
                error_type=type(e).__name__,
                failures_streak=failures,
                sleep_sec=delay,
            )
            if failures >= _MAX_CONSECUTIVE_POLL_FAILURES:
                log.critical(
                    "telegram_polling_max_failures",
                    failures=_MAX_CONSECUTIVE_POLL_FAILURES,
                    detail="resetting failure streak after unexpected errors",
                )
                failures = 0
            await asyncio.sleep(delay)
