"""FastAPI dependencies: shared singletons and factory wiring."""

from __future__ import annotations

import functools
from typing import AsyncGenerator, cast

import structlog
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ai.llm import DeepSeekLLMRouter
from app.core.config import EnvSettings
from app.core.db.database import AsyncSessionLocal
from app.core.gpspos.auth import GpsPosAuth
from app.core.gpspos.client import GpsPosClient
from app.core.gpspos.config import GpsPosSettings
from app.core.gpspos.diagnostics import GpsPosDiagnostics
from app.core.gpspos_geo.client import GpsposGeoAuth, GpsposGeoClient
from app.core.gpspos_geo.config import GpsposGeoSettings
from app.core.gpspos_geo.service import GpsposGeoService
from app.core.okdesk.client import OkdeskClient
from app.core.okdesk.config import OkdeskSettings
from app.core.okdesk.service import OkdeskService
from app.core.services.cache_service import CacheService
from app.services.intelligence_service import IntelligenceService, LLMRouter
from app.services.issue_automation import IssueAutomationService

log = structlog.get_logger(__name__)


class AppTestSettings(EnvSettings):
    TEST_API_TOKEN: str = "dev-change-me"


@functools.lru_cache
def _llm_router_instance() -> DeepSeekLLMRouter:
    return DeepSeekLLMRouter()


@functools.lru_cache
def _gps_diagnostics() -> GpsPosDiagnostics:
    gcfg = GpsPosSettings()
    auth = GpsPosAuth(gcfg)
    client = GpsPosClient(auth, gcfg.BASE_URL)
    return GpsPosDiagnostics(client)


@functools.lru_cache
def _gpspos_geo_service() -> GpsposGeoService:
    cfg = GpsposGeoSettings()
    auth = GpsposGeoAuth(cfg)
    client = GpsposGeoClient(auth, cfg.BASE_URL)
    return GpsposGeoService(client)


@functools.lru_cache
def _okdesk_client() -> OkdeskClient:
    ocfg = OkdeskSettings()
    return OkdeskClient(ocfg)


@functools.lru_cache
def _okdesk_service() -> OkdeskService:
    return OkdeskService(_okdesk_client())


@functools.lru_cache
def _intelligence_service() -> IntelligenceService:
    return IntelligenceService(
        cast(LLMRouter, _llm_router_instance()),
        _gps_diagnostics(),
        _okdesk_client(),
    )


@functools.lru_cache
def _issue_automation_service() -> IssueAutomationService:
    return IssueAutomationService(
        _okdesk_service(),
        _gpspos_geo_service(),
        _llm_router_instance(),
    )


async def get_issue_automation_service() -> IssueAutomationService:
    """Return shared :class:`IssueAutomationService` for mileage-discrepancy automation."""
    return _issue_automation_service()


async def get_llm_router() -> LLMRouter:
    """Return shared LLM router (Yandex, then Ollama)."""
    return cast(LLMRouter, _llm_router_instance())


async def get_gpspos_diagnostics() -> GpsPosDiagnostics:
    """Return shared :class:`GpsPosDiagnostics` pipeline."""
    return _gps_diagnostics()


async def get_gpspos_geo_service() -> GpsposGeoService:
    """Return shared :class:`GpsposGeoService` for geo.gpspos.ru."""
    return _gpspos_geo_service()


async def get_okdesk_client() -> OkdeskClient:
    """Return shared Okdesk REST client."""
    return _okdesk_client()


async def get_okdesk_service() -> OkdeskService:
    """Return shared OkdeskService."""
    return _okdesk_service()


async def get_intelligence_service() -> IntelligenceService:
    """Return shared :class:`IntelligenceService` wired with singleton deps."""
    return _intelligence_service()


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    """Yield a per-request async DB session."""
    async with AsyncSessionLocal() as session:
        yield session


async def get_cache_service(
    db: AsyncSession = Depends(get_db_session),
) -> CacheService:
    """Return a CacheService bound to the request-scoped DB session."""
    return CacheService(db=db, okdesk=_okdesk_service())


@functools.lru_cache
def get_test_token_settings() -> AppTestSettings:
    return AppTestSettings()
