"""FastAPI dependencies: shared singletons and factory wiring."""

from __future__ import annotations

import functools
from typing import Any, cast

import httpx
import structlog

from app.core.config import EnvSettings
from app.core.gpspos.auth import GpsPosAuth
from app.core.gpspos.client import GpsPosClient
from app.core.gpspos.config import GpsPosSettings
from app.core.gpspos.diagnostics import GpsPosDiagnostics
from app.core.okdesk.client import OkdeskClient
from app.core.okdesk.config import OkdeskSettings
from app.core.okdesk.service import OkdeskService
from app.services.intelligence_service import IntelligenceService, LLMRouter

log = structlog.get_logger(__name__)


class AppTestSettings(EnvSettings):
    TEST_API_TOKEN: str = "dev-change-me"


class LlmSettings(EnvSettings):
    YC_LLM_API_KEY: str | None = None
    YC_FOLDER_ID: str | None = None
    YC_LLM_MODEL: str = "yandexgpt/latest"
    OLLAMA_BASE_URL: str = "http://127.0.0.1:11434"
    OLLAMA_MODEL: str = "llama3.2"
    OLLAMA_TIMEOUT_SEC: float = 120.0


class YandexOllamaLLMRouter:
    """
    Tries Yandex Foundation Models (REST), then falls back to Ollama /api/chat.
    Implements the :class:`LLMRouter` contract.
    """

    def __init__(self) -> None:
        self._cfg = LlmSettings()
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=15.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def chat(self, system: str, user: str) -> str:
        yandex_ok = bool(self._cfg.YC_LLM_API_KEY and self._cfg.YC_FOLDER_ID)
        if yandex_ok:
            try:
                return await self._yandex_complete(system, user)
            except Exception as e:  # noqa: BLE001
                log.warning(
                    "yandex_llm_fail_fallback_ollama",
                    module="llm",
                    error=str(e),
                )
        return await self._ollama_complete(system, user)

    async def _yandex_complete(self, system: str, user: str) -> str:
        folder = (self._cfg.YC_FOLDER_ID or "").strip()
        key = (self._cfg.YC_LLM_API_KEY or "").strip()
        model_uri = f"gpt://{folder}/{self._cfg.YC_LLM_MODEL}"
        url = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion"
        body: dict[str, Any] = {
            "modelUri": model_uri,
            "completionOptions": {
                "temperature": 0.2,
                "maxTokens": 2000,
            },
            "messages": [
                {"role": "system", "text": system},
                {"role": "user", "text": user},
            ],
        }
        r = await self._client.post(
            url,
            json=body,
            headers={"Authorization": f"Api-Key {key}"},
        )
        r.raise_for_status()
        data = r.json()
        alts = data.get("result", {}).get("alternatives", [])
        if not alts:
            raise ValueError("Yandex: empty alternatives")
        text = (alts[0].get("message") or {}).get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Yandex: no text in response")
        return text.strip()

    async def _ollama_complete(self, system: str, user: str) -> str:
        base = self._cfg.OLLAMA_BASE_URL.rstrip("/")
        url = f"{base}/api/chat"
        body = {
            "model": self._cfg.OLLAMA_MODEL,
            "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        r = await self._client.post(url, json=body)
        r.raise_for_status()
        data = r.json()
        msg = (data or {}).get("message") or {}
        content = msg.get("content", "")
        if not isinstance(content, str) or not str(content).strip():
            raise ValueError("Ollama: empty content")
        return str(content).strip()


@functools.lru_cache
def _llm_router_instance() -> YandexOllamaLLMRouter:
    return YandexOllamaLLMRouter()


@functools.lru_cache
def _gps_diagnostics() -> GpsPosDiagnostics:
    gcfg = GpsPosSettings()
    auth = GpsPosAuth(gcfg)
    client = GpsPosClient(auth, gcfg.BASE_URL)
    return GpsPosDiagnostics(client)


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


async def get_llm_router() -> LLMRouter:
    """Return shared LLM router (Yandex, then Ollama)."""
    return cast(LLMRouter, _llm_router_instance())


async def get_gpspos_diagnostics() -> GpsPosDiagnostics:
    """Return shared :class:`GpsPosDiagnostics` pipeline."""
    return _gps_diagnostics()


async def get_okdesk_client() -> OkdeskClient:
    """Return shared Okdesk REST client."""
    return _okdesk_client()


async def get_okdesk_service() -> OkdeskService:
    """Return shared OkdeskService."""
    return _okdesk_service()


async def get_intelligence_service() -> IntelligenceService:
    """Return shared :class:`IntelligenceService` wired with singleton deps."""
    return _intelligence_service()


@functools.lru_cache
def get_test_token_settings() -> AppTestSettings:
    return AppTestSettings()
