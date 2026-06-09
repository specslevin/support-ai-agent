"""High-level GPSPOS helpers for objects, events, and geocoding (nav.gpspos.ru)."""

from __future__ import annotations

import time
from typing import Any, Iterable

from .client import GpsPosClient
from .models import EventItem, ObjectInfo, ObjectStatus


_SOON_DAYS = 7


def _objects_from_payload(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in ("data", "items", "objects", "result", "value", "list"):
            v = data.get(key)
            if isinstance(v, list):
                return [x for x in v if isinstance(x, dict)]
    return []


def _contains_identifier(obj: ObjectInfo, identifier: str) -> bool:
    needle = identifier.strip().lower()
    if not needle:
        return False
    for field in (obj.imei, obj.stateNumber, obj.phone, obj.name):
        if field and field.strip().lower() == needle:
            return True
    return False


class GpsPosDiagnostics:
    """Async helpers on top of :class:`GpsPosClient`."""

    def __init__(self, client: GpsPosClient) -> None:
        self._client = client

    async def find_object_by_identifier(self, identifier: str) -> ObjectInfo | None:
        raw = await self._client.request("GET", "Objects")
        rows = _objects_from_payload(raw)
        for row in rows:
            try:
                o = ObjectInfo.model_validate(row)
            except Exception:
                continue
            if _contains_identifier(o, identifier):
                return o
        return None

    async def get_object_status(self, object_id: int) -> ObjectStatus | None:
        data = await self._client.request("GET", f"ObjectsStatus/{object_id}")
        if not isinstance(data, dict):
            return None
        pos = data.get("positions")
        if not isinstance(pos, list) or not pos:
            return None
        first = pos[0]
        if not isinstance(first, dict):
            return None
        return ObjectStatus.model_validate(first)

    async def check_subscription(self, object_id: int) -> dict[str, int | str]:
        data = await self._client.request("GET", f"Objects/{object_id}")
        if isinstance(data, dict) and "payedTill" not in data:
            for k in ("data", "item", "object", "result"):
                inner = data.get(k)
                if isinstance(inner, dict) and "payedTill" in inner:
                    data = inner
                    break
        if not isinstance(data, dict):
            raise ValueError("GET Objects/{id} returned non-object body")
        info = ObjectInfo.model_validate(data)
        now = time.time()
        payed = float(info.payedTill)
        if payed < now:
            return {"status": "expired", "days_left": 0}
        days_left = max(0, int((payed - now) // 86400))
        soon_cutoff = now + _SOON_DAYS * 86400
        if payed < soon_cutoff:
            status: str = "soon"
        else:
            status = "active"
        return {"status": status, "days_left": days_left}

    async def get_object_info(self, object_id: int) -> dict[str, Any]:
        """Device profile (plate, IMEI, etc.) plus subscription summary."""
        data = await self._client.request("GET", f"Objects/{object_id}")
        if isinstance(data, dict) and "payedTill" not in data:
            for k in ("data", "item", "object", "result"):
                inner = data.get(k)
                if isinstance(inner, dict) and "payedTill" in inner:
                    data = inner
                    break
        if not isinstance(data, dict):
            raise ValueError("GET Objects/{id} returned non-object body")
        info = ObjectInfo.model_validate(data)
        now = time.time()
        payed = float(info.payedTill)
        if payed < now:
            subscription: dict[str, int | str] = {"status": "expired", "days_left": 0}
        else:
            days_left = max(0, int((payed - now) // 86400))
            soon_cutoff = now + _SOON_DAYS * 86400
            if payed < soon_cutoff:
                subscription = {"status": "soon", "days_left": days_left}
            else:
                subscription = {"status": "active", "days_left": days_left}
        return {
            "device": info.model_dump(mode="json"),
            "subscription": subscription,
        }

    async def get_last_events(self, object_id: int, hours: int = 24) -> list[EventItem]:
        now = int(time.time())
        body = {"from": now - hours * 3600, "till": now}
        raw = await self._client.request(
            "POST",
            f"ObjectsHistory/Events/{object_id}",
            json=body,
        )
        items: Iterable[dict[str, Any]]
        if isinstance(raw, list):
            items = [x for x in raw if isinstance(x, dict)]
        elif isinstance(raw, dict):
            for key in ("data", "items", "events", "result", "value", "list"):
                v = raw.get(key)
                if isinstance(v, list):
                    items = [x for x in v if isinstance(x, dict)]
                    break
            else:
                items = []
        else:
            items = []
        out: list[EventItem] = []
        for row in items:
            try:
                out.append(EventItem.model_validate(row))
            except Exception:
                continue
        return out

    async def reverse_geocode(self, lat: float, lng: float) -> str:
        body = [{"latitude": lat, "longitude": lng}]
        raw = await self._client.request("POST", "ReverseGeocoder", json=body)
        if isinstance(raw, list) and raw:
            first = raw[0]
            if isinstance(first, dict):
                addr = first.get("address")
                if isinstance(addr, str) and addr.strip():
                    return addr.strip()
        if isinstance(raw, dict):
            addr = raw.get("address")
            if isinstance(addr, str) and addr.strip():
                return addr.strip()
        return "Адрес не определён"
