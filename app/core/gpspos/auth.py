"""Token acquisition and refresh for nav.gpspos.ru API."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from .config import GpsPosSettings
from .models import TokenResponse


def _base_url_for_client(base: str) -> str:
    b = base.rstrip("/")
    return f"{b}/"


class GpsPosAuth:
    """Caches access token; POST /Token and POST /Token/Refresh per API docs."""

    def __init__(self, settings: GpsPosSettings) -> None:
        self._settings = settings
        self._lock = asyncio.Lock()
        self._access_token: str | None = None
        self._expires_at: float = 0.0
        self._client = httpx.AsyncClient(
            base_url=_base_url_for_client(settings.BASE_URL),
            timeout=30.0,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _apply_token_response(self, data: dict[str, Any]) -> str:
        parsed = TokenResponse.model_validate(data)
        self._access_token = parsed.accessToken
        if parsed.expiresInSec is not None and parsed.expiresInSec > 0:
            self._expires_at = time.time() + float(parsed.expiresInSec)
        else:
            self._expires_at = time.time() + 3600.0
        return self._access_token

    def _cached_token_if_valid(self) -> str | None:
        if not self._access_token:
            return None
        if time.time() >= self._expires_at:
            return None
        return self._access_token

    async def get_token(self) -> str:
        async with self._lock:
            cached = self._cached_token_if_valid()
            if cached is not None:
                return cached
            body = {
                "subUserId": self._settings.SUB_USER_ID,
                "userName": self._settings.USERNAME,
                "password": self._settings.PASSWORD,
            }
            r = await self._client.post("Token", json=body)
            r.raise_for_status()
            payload = r.json()
            if not isinstance(payload, dict):
                raise ValueError("Token response is not a JSON object")
            return self._apply_token_response(payload)

    async def refresh_token(self) -> str:
        async with self._lock:
            body = {"subUserId": self._settings.SUB_USER_ID}
            r = await self._client.post("Token/Refresh", json=body)
            r.raise_for_status()
            payload = r.json()
            if not isinstance(payload, dict):
                raise ValueError("Token/Refresh response is not a JSON object")
            return self._apply_token_response(payload)
