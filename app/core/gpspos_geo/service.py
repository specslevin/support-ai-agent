"""High-level helpers for geo.gpspos.ru API: objects, status, history, geozones, events."""

from __future__ import annotations

import re
import time
from typing import Any

from .client import GpsposGeoClient
from app.core.gpspos.models import EventItem, ObjectInfo, ObjectStatus


def _decode_cp1251(text: str) -> str:
    try:
        return text.encode("latin1").decode("cp1251")
    except Exception:
        return text


def _unwrap_list(data: Any, *keys: str) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in keys or ("data", "items", "objects", "result", "value", "list"):
            v = data.get(key)
            if isinstance(v, list):
                return [x for x in v if isinstance(x, dict)]
    return []


class GpsposGeoService:
    def __init__(self, client: GpsposGeoClient) -> None:
        self._client = client

    async def list_objects(self) -> list[ObjectInfo]:
        raw = await self._client.request("GET", "Objects")
        rows = _unwrap_list(raw)
        result: list[ObjectInfo] = []
        for r in rows:
            try:
                result.append(ObjectInfo.model_validate(r))
            except Exception:
                continue
        return result

    async def get_object(self, object_id: int) -> ObjectInfo:
        data = await self._client.request("GET", f"Objects/{object_id}")
        if isinstance(data, dict) and "payedTill" not in data:
            for k in ("data", "item", "object", "result"):
                inner = data.get(k)
                if isinstance(inner, dict) and "payedTill" in inner:
                    data = inner
                    break
        return ObjectInfo.model_validate(data)

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

    async def get_object_history(self, object_id: int, hours: int = 24) -> list[dict[str, Any]]:
        now = int(time.time()) * 1000
        body = {"from": now - hours * 3600 * 1000, "till": now}
        raw = await self._client.request("POST", f"ObjectsHistory/Events/{object_id}", json=body)
        if isinstance(raw, list):
            rows = [x for x in raw if isinstance(x, dict)]
            for row in rows:
                if isinstance(row.get("text"), str):
                    row["text"] = _decode_cp1251(row["text"])
            return rows
        return []

    async def list_geozones(self) -> list[dict[str, Any]]:
        raw = await self._client.request("GET", "Geozones")
        return _unwrap_list(raw)

    async def list_geozone_groups(self) -> list[dict[str, Any]]:
        raw = await self._client.request("GET", "Geozones/Groups")
        return _unwrap_list(raw)

    async def list_events(self) -> list[EventItem]:
        raw = await self._client.request("GET", "Events")
        rows = _unwrap_list(raw)
        result: list[EventItem] = []
        for r in rows:
            try:
                ev = EventItem.model_validate(r)
                ev.text = _decode_cp1251(ev.text)
                result.append(ev)
            except Exception:
                continue
        return result

    _PLATE_CORE = re.compile(r"[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}", re.I)
    # Special equipment plate: 4 digits + 2 letters in either order (5297СУ / СУ5297).
    _SPECIAL_RE = re.compile(r"(\d{4})([АВЕКМНОРСТУХ]{2})|([АВЕКМНОРСТУХ]{2})(\d{4})", re.I)
    # Latin lookalikes → Cyrillic, so "A759PC" (latin) matches "А759РС" (cyrillic).
    _TRANSLIT = str.maketrans("ABEKMHOPCTYX", "АВЕКМНОРСТУХ")

    @classmethod
    def _norm_plate(cls, value: Any) -> str:
        return str(value or "").replace(" ", "").upper().translate(cls._TRANSLIT)

    @classmethod
    def _plate_core(cls, norm: str) -> str:
        """Plate core without region code (Х371РХ64 → Х371РХ)."""
        m = cls._PLATE_CORE.search(norm)
        return m.group(0) if m else norm

    @classmethod
    def _special_sig(cls, norm: str) -> str | None:
        """Canonical signature for special-equipment plates: «DDDDLL» regardless
        of order (СУ5297 / 5297СУ → '5297СУ'). None if not a special plate."""
        m = cls._SPECIAL_RE.search(norm)
        if not m:
            return None
        return (m.group(1) + m.group(2)) if m.group(1) else (m.group(4) + m.group(3))

    async def find_object_by_plate(self, plate: str) -> dict[str, Any] | None:
        """Find a tracked object by license plate (gosnumber).

        Rosseti objects store the plate inside ``name`` (e.g. ``"УАЗ-390995 Т489КО56"``),
        sometimes in ``stateNumber``/``number``. The region code may be missing in
        geo (``"Х371РХ ГАЗ"`` vs issue ``"Х371РХ64"``), so we also match by the plate
        core (letters+digits without region). Returns the raw object dict or None.
        """
        needle = self._norm_plate(plate)
        if not needle:
            return None
        core = self._plate_core(needle)
        special = self._special_sig(needle)  # for спецтехника (5297СУ / СУ5297)
        raw = await self._client.request("GET", "Objects")
        rows = _unwrap_list(raw)
        partial: dict[str, Any] | None = None
        core_match: dict[str, Any] | None = None
        special_match: dict[str, Any] | None = None
        for r in rows:
            for f in (r.get("stateNumber"), r.get("name"), r.get("number")):
                nf = self._norm_plate(f)
                if not nf:
                    continue
                if nf == needle:
                    return r
                if needle in nf and partial is None:
                    partial = r
                elif core and core in nf and core_match is None:
                    core_match = r
                elif special and special_match is None and self._special_sig(nf) == special:
                    special_match = r
        return partial or core_match or special_match

    async def get_daily_stats(
        self, object_id: int, from_ms: int, till_ms: int
    ) -> list[dict[str, Any]]:
        """Per-day statistics. ``length`` is mileage in METERS, ``day`` is YYYYMMDD int."""
        body = {"from": from_ms, "till": till_ms}
        raw = await self._client.request(
            "POST", f"ObjectsHistory/DailyStat/{object_id}", json=body
        )
        return _unwrap_list(raw)

    async def get_packets(
        self, object_id: int, from_ms: int, till_ms: int
    ) -> list[dict[str, Any]]:
        """Raw telemetry packets: time(ms), speed, sat, lat, lng, tags{pwr_ext,pwr_int,hdop,pdop}."""
        body = {"from": from_ms, "till": till_ms, "objectId": object_id}
        raw = await self._client.request("POST", "ObjectPackets", json=body)
        if isinstance(raw, list):
            return [x for x in raw if isinstance(x, dict)]
        return _unwrap_list(raw, "packets", "data")

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
