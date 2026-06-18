"""FastAPI entry: health, API v1, Telegram webhook/polling, structlog."""

from __future__ import annotations

import asyncio
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
import structlog
from aiogram import Dispatcher
from aiogram.types import Update
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from .api.v1.router import api_v1_router
from .core.auth import AuthConfig, verify_token
from .core.ai.agent import AIAgent
from .core.db.database import AsyncSessionLocal, init_db
from .core.db.sync import sync_companies
from .core.services.cache_service import CacheService
from .core.gpspos.auth import GpsPosAuth
from .core.gpspos.client import GpsPosClient
from .core.gpspos.config import GpsPosSettings
from .core.gpspos.diagnostics import GpsPosDiagnostics
from .core.gpspos_geo.client import GpsposGeoAuth, GpsposGeoClient
from .core.gpspos_geo.config import GpsposGeoSettings
from .core.gpspos_geo.service import GpsposGeoService
from .core.okdesk import OkdeskClient, OkdeskService, OkdeskSettings
from .core.telegram.bot import create_bot, run_polling_with_retries, setup_dispatcher
from .core.telegram.settings import TelegramRuntimeSettings


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
    geo_settings = GpsposGeoSettings()
    geo_auth = GpsposGeoAuth(geo_settings)
    geo_client = GpsposGeoClient(geo_auth, geo_settings.BASE_URL)
    geo_service = GpsposGeoService(geo_client)
    log.info("gpspos_geo_initialized", base_url=geo_settings.BASE_URL)

    okdesk_settings = OkdeskSettings()
    okdesk_client = OkdeskClient(okdesk_settings)
    okdesk_service = OkdeskService(okdesk_client)

    await init_db()
    synced = await sync_companies(okdesk_service)
    log.info("startup_sync_companies", count=synced)
    ai_agent = AIAgent(okdesk=okdesk_service, gpspos=diagnostics, gpspos_geo=geo_service)

    app.state.gpspos_auth = auth
    app.state.gpspos_client = client
    app.state.gpspos_diagnostics = diagnostics
    app.state.okdesk_service = okdesk_service
    app.state.ai_agent = ai_agent
    app.state.gpspos_geo_service = geo_service
    app.state.auth_config = AuthConfig()

    async def _cache_refresh_loop(interval: int = 300) -> None:
        _log = structlog.get_logger("cache_refresh")
        while True:
            await asyncio.sleep(interval)
            try:
                async with AsyncSessionLocal() as db:
                    svc = CacheService(db=db, okdesk=okdesk_service)
                    count = await svc.refresh_issue_cache()
                _log.info("cache_auto_refreshed", synced=count)
            except asyncio.CancelledError:
                raise
            except Exception:
                _log.exception("cache_auto_refresh_failed")

    cache_task = asyncio.create_task(_cache_refresh_loop())
    log.info("cache_refresh_scheduled", interval_sec=300)

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
        setup_dispatcher(dp, ai_agent=ai_agent, okdesk_service=okdesk_service)
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

    cache_task.cancel()
    try:
        await cache_task
    except asyncio.CancelledError:
        pass

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
        await geo_client.aclose()
    except Exception:
        log.exception("gpspos_geo_client_close_failed")
    try:
        await geo_auth.aclose()
    except Exception:
        log.exception("gpspos_geo_auth_close_failed")

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


# Paths under /api/v1 that must stay open: login itself, the external Okdesk
# webhook (carries its own X-Okdesk-Secret) and the test route (own X-Test-Token).
_AUTH_PUBLIC_PREFIXES = ("/api/v1/auth/login", "/api/v1/webhooks", "/api/v1/test")
_DEMO_WRITE_ALLOWED_METHODS = ("GET", "HEAD", "OPTIONS")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Enforce a valid token on /api/v1 routes; block writes for the demo role.

    Non-API paths (SPA, static, /health, /docs, Telegram webhook) are untouched —
    the React app must load so the user can reach the login screen.
    """
    path = request.url.path
    if path.startswith("/api/v1/") and not path.startswith(_AUTH_PUBLIC_PREFIXES):
        if request.method == "OPTIONS":
            return await call_next(request)
        cfg = getattr(request.app.state, "auth_config", None)
        auth_header = request.headers.get("Authorization", "")
        token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else None
        payload = verify_token(token, cfg.secret) if cfg else None
        if not payload:
            return JSONResponse({"detail": "Не авторизовано"}, status_code=401)
        request.state.user = payload
        if payload.get("r") == "demo" and request.method not in _DEMO_WRITE_ALLOWED_METHODS:
            return JSONResponse(
                {"detail": "Демо-режим: только просмотр. Изменения недоступны."},
                status_code=403,
            )
    return await call_next(request)


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

# Serve React frontend from app/static if it exists
_static_dir = Path(__file__).parent / "static"
if _static_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_static_dir / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        return FileResponse(str(_static_dir / "index.html"))
