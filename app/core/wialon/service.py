"""High-level helpers for Wialon Remote API."""

from __future__ import annotations

from typing import Any

from .client import WialonClient
from .models import LoginResponse, Unit, UnitData, UserData


class WialonService:
    def __init__(self, client: WialonClient) -> None:
        self._client = client

    async def login(self) -> LoginResponse:
        data = await self._client.login()
        return LoginResponse.model_validate(data)

    async def get_user(self) -> UserData:
        data = await self._client.get_user()
        return UserData.model_validate(data)

    async def search_units(self, limit: int = 10) -> list[Unit]:
        data = await self._client.search_items("avl_unit", limit)
        items = data.get("items", [])
        result: list[Unit] = []
        for item in items:
            try:
                result.append(Unit.model_validate(item))
            except Exception:
                continue
        return result

    async def get_unit_data(self, unit_id: int) -> UnitData:
        data = await self._client.get_unit_data(unit_id)
        return UnitData.model_validate(data)

    async def get_messages(self, unit_id: int, from_time: int, to_time: int) -> list[dict[str, Any]]:
        data = await self._client.get_messages(unit_id, from_time, to_time)
        msgs = data.get("messages", [])
        if isinstance(msgs, list):
            return [m for m in msgs if isinstance(m, dict)]
        return []
