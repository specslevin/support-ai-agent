"""HTTP client for geo.gpspos.ru API (same auth as nav.gpspos.ru)."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from .config import GpsposGeoSettings
from app.core.gpspos.models import TokenResponse


def _base_url_for_client(base: str) -> str:
    b = base.rstrip("/")
    return f"{b}/"


class GpsposGeoAuth:
    def __init__(self, settings: GpsposGeoSettings) -> None:
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


class GpsposGeoClient:
    def __init__(self, auth: GpsposGeoAuth, base_url: str) -> None:
        self._auth = auth
        self._client = httpx.AsyncClient(
            base_url=_base_url_for_client(base_url),
            timeout=30.0,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        # Все вызовы geo — читающие (Objects/ObjectPackets/ReverseGeocoder — POST
        # лишь по форме запроса), поэтому повтор безопасен и для POST.
        # 30.07.2026: geo подвисал ~6 минут, каждый запрос трека умирал по
        # таймауту 30с → панель отдавала 500. Один повтор с паузой закрывает
        # короткие провалы сети/сервиса, не растягивая ожидание вдвое надолго.
        last_transport_error: Exception | None = None
        for attempt in range(2):
            token = await self._auth.get_token()
            req_kwargs = dict(kwargs)
            headers = {**(req_kwargs.pop("headers", None) or {}), "Authorization": f"Bearer {token}"}
            try:
                r = await self._client.request(method, path, headers=headers, **req_kwargs)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_transport_error = exc
                if attempt == 0:
                    await asyncio.sleep(1.0)
                    continue
                raise
            if r.status_code == 401 and attempt == 0:
                await self._auth.refresh_token()
                continue
            r.raise_for_status()
            return r.json()
        if last_transport_error is not None:
            raise last_transport_error
        raise RuntimeError("Unauthorized after token refresh")
