"""HTTP client for Wialon Remote API (single-endpoint, svc/params/sid)."""

from __future__ import annotations

import json
from typing import Any

import httpx

from .config import WialonSettings


class WialonClient:
    def __init__(self, settings: WialonSettings) -> None:
        self._settings = settings
        self._base_url = settings.BASE_URL
        self.ssid: str | None = None

    async def login(self) -> dict[str, Any]:
        params = {"user": self._settings.USERNAME, "password": self._settings.PASSWORD}
        data = await self._call("core/login", params)
        if isinstance(data, dict) and data.get("ssid"):
            self.ssid = data["ssid"]
        return data

    async def _request(self, svc: str, params: dict | None = None) -> dict[str, Any]:
        if params is None:
            params = {}
        for attempt in range(2):
            data = await self._call(svc, params)
            err = data.get("error") if isinstance(data, dict) else None
            if err in (4, 8) and attempt == 0:
                await self.login()
                continue
            if not isinstance(data, dict):
                raise ValueError(f"Wialon response is not a JSON object: {data}")
            return data
        raise RuntimeError(f"Authorization failed after re-login")

    async def _call(self, svc: str, params: dict | None) -> Any:
        query_params: dict[str, str] = {"svc": svc, "params": json.dumps(params or {})}
        if self.ssid:
            query_params["sid"] = self.ssid
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(self._base_url, params=query_params)
            r.raise_for_status()
            return r.json()

    async def get_user(self) -> dict[str, Any]:
        return await self._request("core/get_user_data")

    async def search_items(self, item_type: str = "avl_unit", limit: int = 10) -> dict[str, Any]:
        params = {"spec": {"itemsType": item_type, "propName": "sys_name",
                           "propValueMask": "*", "sortType": "sys_name",
                           "orLogic": 0, "limit": limit}}
        return await self._request("core/search_items", params)

    async def get_unit_data(self, unit_id: int, flags: int = 0x1) -> dict[str, Any]:
        params = {"unitId": unit_id, "flags": flags}
        return await self._request("unit/get_data", params)

    async def get_messages(self, unit_id: int, from_time: int, to_time: int) -> dict[str, Any]:
        params = {"unitId": unit_id, "timeFrom": from_time, "timeTo": to_time,
                  "flags": 0xFFFF, "tzOffset": 0}
        return await self._request("unit/get_messages", params)
