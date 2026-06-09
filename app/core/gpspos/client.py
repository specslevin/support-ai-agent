"""HTTP client for nav.gpspos.ru API."""

from __future__ import annotations

from typing import Any

import httpx

from .auth import GpsPosAuth


def _base_url_for_client(base: str) -> str:
    b = base.rstrip("/")
    return f"{b}/"


class GpsPosAPIError(Exception):
    """Raised when the API returns an error after retries and token refresh handling."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        response: httpx.Response | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response = response


class GpsPosClient:
    def __init__(self, auth: GpsPosAuth, base_url: str) -> None:
        self._auth = auth
        self._client = httpx.AsyncClient(
            base_url=_base_url_for_client(base_url),
            timeout=30.0,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        for attempt in range(2):
            token = await self._auth.get_token()
            req_kwargs = dict(kwargs)
            headers = {**(req_kwargs.pop("headers", None) or {}), "Authorization": f"Bearer {token}"}
            r = await self._client.request(method, path, headers=headers, **req_kwargs)
            if r.status_code == 401 and attempt == 0:
                await self._auth.refresh_token()
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError("Unauthorized after token refresh")
