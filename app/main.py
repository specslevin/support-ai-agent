"""FastAPI entry: health, API v1, Telegram webhook/polling, structlog."""

from __future__ import annotations

import asyncio
import sys
from contextlib import asynccontextmanager

from dotenv import load_dotenv
import structlog
from aiogram import Dispatcher
from aiogram.types import Update
from fastapi import FastAPI, HTTPException, Request

from .api.v1.router import api_v1_router
from .core.agent.orchestrator import SupportAgent
from .core.ai.agent import AIAgent
from .core.db.database import init_db
from .core.db.sync import sync_companies
from .core.gpspos.auth import GpsPosAuth
from .core.gpspos.client import GpsPosClient
from .core.gpspos.config import GpsPosSettings
from .core.gpspos.diagnostics import GpsPosDiagnostics
from .core.okdesk import OkdeskClient, OkdeskService, OkdeskSettings
from .core.telegram.bot import create_bot, run_polling_with_retries, setup_dispatcher
from .core.telegram.settings import TelegramRuntimeSettings
from .core.tools.registry import build_tool_registry


def _configure_structlog() -> None:
    shared = [structlog.processors.TimeStamper(fmt="iso", key="timestamp")]
    is_tty = bool(sys.stdout) and sys.stdout.isatty()
    if is_tty:
        proc = structlog.dev.ConsoleRenderer()
    else:
        proc = structlog.processors.JSONRenderer()
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            *shared,
            proc,
        ],
        cache_logger_on_first_use=True,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_dotenv()
    _configure_structlog()
    log = structlog.get_logger(__name__)
    log.info("app_startup_begin")

    tg = TelegramRuntimeSettings()
    gps = GpsPosSettings()

    auth = GpsPosAuth(gps)
    client = GpsPosClient(auth, gps.BASE_URL)
    diagnostics = GpsPosDiagnostics(client)
    registry = build_tool_registry(diagnostics)
    agent = SupportAgent(registry, diagnostics, llm_provider=tg.LLM_PROVIDER)

    okdesk_settings = OkdeskSettings()
    okdesk_client = OkdeskClient(okdesk_settings)
    okdesk_service = OkdeskService(okdesk_client)

    await init_db()
    synced = await sync_companies(okdesk_service)
    log.info("startup_sync_companies", count=synced)
    ai_agent = AIAgent(okdesk=okdesk_service, gpspos=diagnostics)

    app.state.gpspos_auth = auth
    app.state.gpspos_client = client
    app.state.gpspos_diagnostics = diagnostics
    app.state.support_agent = agent
    app.state.okdesk_service = okdesk_service
    app.state.ai_agent = ai_agent

    polling_task: asyncio.Task[None] | None = None
    token = tg.TELEGRAM_BOT_TOKEN.strip()
    if token:
        proxy_raw = (tg.TELEGRAM_PROXY_URL or "").strip()
        bot = create_bot(
            token,
            proxy_url=proxy_raw or None,
            proxy_verify_ssl=tg.TELEGRAM_PROXY_VERIFY_SSL,
        )
        dp = Dispatcher()
        setup_dispatcher(dp, agent, ai_agent=ai_agent, okdesk_service=okdesk_service)
        app.state.telegram_bot = bot
        app.state.telegram_dp = dp
        secret = (tg.TELEGRAM_WEBHOOK_SECRET or "").strip() or None
        app.state.telegram_webhook_secret = secret

        mode = tg.TELEGRAM_MODE.strip().lower()
        if mode == "webhook":
            wh_url = (tg.TELEGRAM_WEBHOOK_URL or "").strip()
            if wh_url:
                if secret:
                    await bot.set_webhook(url=wh_url, secret_token=secret)
                else:
                    await bot.set_webhook(url=wh_url)
                log.info("telegram_webhook_set", url=wh_url, has_secret=bool(secret))
            else:
                log.warning("telegram_webhook_mode_missing_url")
        elif mode == "polling":
            polling_task = asyncio.create_task(run_polling_with_retries(dp, bot))
            log.info("telegram_polling_started", resilient=True)
        else:
            log.warning("telegram_unknown_mode", mode=mode)
    else:
        log.warning("telegram_disabled_no_token")

    log.info("app_started", app="support-ai", docs=True)

    yield

    if polling_task:
        polling_task.cancel()
        try:
            await polling_task
        except asyncio.CancelledError:
            pass

    tb = getattr(app.state, "telegram_bot", None)
    if tb is not None:
        try:
            await tb.delete_webhook(drop_pending_updates=False)
        except Exception:
            log.exception("telegram_delete_webhook_failed")
        try:
            await tb.session.close()
        except Exception:
            log.exception("telegram_bot_session_close_failed")

    try:
        await client.aclose()
    except Exception:
        log.exception("gpspos_client_close_failed")
    try:
        await auth.aclose()
    except Exception:
        log.exception("gpspos_auth_close_failed")

    log.info("app_shutdown_done")


app = FastAPI(
    title="Support AI Agent",
    description="Okdesk + GPSPOS + LLM support pipeline",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)


@app.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/webhook/telegram", tags=["telegram"])
async def telegram_webhook(request: Request) -> dict[str, bool]:
    tb = getattr(request.app.state, "telegram_bot", None)
    dp = getattr(request.app.state, "telegram_dp", None)
    if tb is None or dp is None:
        raise HTTPException(status_code=503, detail="telegram bot is not configured")
    secret = getattr(request.app.state, "telegram_webhook_secret", None)
    if secret:
        got = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if got != secret:
            raise HTTPException(status_code=403, detail="invalid webhook secret")
    try:
        data = await request.json()
        update = Update.model_validate(data)
    except Exception as e:
        raise HTTPException(status_code=400, detail="invalid update") from e
    await dp.feed_update(tb, update)
    return {"ok": True}


app.include_router(api_v1_router)
