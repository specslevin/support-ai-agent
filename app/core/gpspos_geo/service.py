"""High-level helpers for geo.gpspos.ru API: objects, status, history, geozones, events."""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

import structlog

from .client import GpsposGeoClient
from app.core.gpspos.models import EventItem, ObjectInfo, ObjectStatus

log = structlog.get_logger(__name__)


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
    _OBJECTS_TTL = 120.0  # сек: кэш списка /Objects (внутри одного пакетного разбора)

    def __init__(self, client: GpsposGeoClient) -> None:
        self._client = client
        self._objects_cache: tuple[float, list[dict[str, Any]]] | None = None
        self._objects_lock = asyncio.Lock()

    async def _objects_cached(self) -> list[dict[str, Any]]:
        """Список всех объектов с коротким TTL-кэшем.

        ``find_object_by_plate`` раньше качал ВЕСЬ список на каждый вызов — в
        пакетном разборе (десятки/сотни ТС) это давало сотни полных загрузок и
        многоминутные таймауты (63317). Кэш на 120с + Lock (чтобы при истёкшем TTL
        8 параллельных корутин разбора не сделали 8 одновременных загрузок)."""
        now = time.time()
        if self._objects_cache and now - self._objects_cache[0] < self._OBJECTS_TTL:
            return self._objects_cache[1]
        async with self._objects_lock:
            # Повторная проверка: пока ждали лок, другой корутиной кэш мог обновиться.
            now = time.time()
            if self._objects_cache and now - self._objects_cache[0] < self._OBJECTS_TTL:
                return self._objects_cache[1]
            raw = await self._client.request("GET", "Objects")
            rows = _unwrap_list(raw)
            self._objects_cache = (now, rows)
            return rows

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
    # Full plate with optional region digits — for fuzzy extraction from object names.
    _PLATE_FULL = re.compile(r"[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{0,3}")
    # Special equipment plate: 4 digits + 2 letters in either order (5297СУ / СУ5297).
    _SPECIAL_RE = re.compile(r"(\d{4})([АВЕКМНОРСТУХ]{2})|([АВЕКМНОРСТУХ]{2})(\d{4})", re.I)
    # Latin lookalikes → Cyrillic, so "A759PC" (latin) matches "А759РС" (cyrillic).
    _TRANSLIT = str.maketrans("ABEKMHOPCTYX", "АВЕКМНОРСТУХ")

    @classmethod
    def _norm_plate(cls, value: Any) -> str:
        return str(value or "").replace(" ", "").replace("-", "").upper().translate(cls._TRANSLIT)

    @classmethod
    def _plate_core(cls, norm: str) -> str:
        """Plate core without region code (Х371РХ64 → Х371РХ)."""
        m = cls._PLATE_CORE.search(norm)
        return m.group(0) if m else norm

    @classmethod
    def _special_candidates(cls, norm: str) -> tuple[str, str] | None:
        """Both orderings of a special-equipment plate (СУ5297 → ('5297СУ','СУ5297')).
        Used to substring-search the object name (whose model часть, напр. «РТ 300»,
        иначе ломает однозначную сигнатуру). None if not a special plate."""
        m = cls._SPECIAL_RE.search(norm)
        if not m:
            return None
        digits, letters = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
        return (digits + letters, letters + digits)

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
        special = self._special_candidates(needle)  # for спецтехника (5297СУ / СУ5297)
        rows = await self._objects_cached()
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
                elif special and special_match is None and (special[0] in nf or special[1] in nf):
                    special_match = r
        found = partial or core_match or special_match
        if found is not None:
            return found
        return self._fuzzy_find(needle, rows, plate)

    @staticmethod
    def _fuzzy_plate_eq(a: str, b: str) -> bool:
        """Плейты «почти равны»: одинаковая длина, ЦИФРЫ совпадают полностью и
        позиционно, расхождение в БУКВАХ — от 1 до 2 позиций (опечатки OCR)."""
        if len(a) != len(b) or a == b:
            return False
        letter_diff = 0
        for ca, cb in zip(a, b):
            if ca == cb:
                continue
            if ca.isdigit() or cb.isdigit():
                return False
            letter_diff += 1
            if letter_diff > 2:
                return False
        return letter_diff >= 1

    def _fuzzy_find(self, needle: str, rows: list[dict[str, Any]],
                    plate: str) -> dict[str, Any] | None:
        """Финальный fuzzy-проход по опечаткам OCR/клиента (64838: в теме
        Т643ТС58, реальный объект М643ТЕ58). Кандидат — объект, у которого
        цифры номера совпадают полностью и позиционно, а буквы расходятся ≤2.
        Принимаем ТОЛЬКО единственного кандидата, иначе None (без ложных
        срабатываний)."""
        if not self._PLATE_CORE.search(needle):
            return None  # не похоже на обычный гос.номер — fuzzy неприменим
        needle_core = self._plate_core(needle)
        # «Единственность» считаем по РАЗНЫМ номерам, а не по строкам: один ТС
        # часто задвоен в гео (старый/новый терминал с тем же номером) — такие
        # дубли не должны отменять fuzzy-спасение.
        by_plate: dict[str, tuple[dict[str, Any], str]] = {}
        for r in rows:
            hit: str | None = None
            for f in (r.get("stateNumber"), r.get("name"), r.get("number")):
                nf = self._norm_plate(f)
                if not nf:
                    continue
                for cand in self._PLATE_FULL.findall(nf):
                    if self._fuzzy_plate_eq(needle, cand):
                        hit = cand
                        break
                    # Регион отсутствует с одной из сторон — сравниваем ядра.
                    if len(cand) != len(needle) and self._fuzzy_plate_eq(
                            needle_core, self._plate_core(cand)):
                        hit = cand
                        break
                if hit:
                    break
            if hit:
                key = self._plate_core(hit) or hit
                by_plate.setdefault(key, (r, hit))
                if len(by_plate) > 1:
                    return None
        if len(by_plate) == 1:
            obj, matched = next(iter(by_plate.values()))
            log.warning("plate_fuzzy_matched", query_plate=plate,
                        matched_plate=matched, object_name=obj.get("name"))
            # Маркер для вызывающих: маппинг неточный (опечатка исправлена) —
            # его нельзя кэшировать как канонический (object_resolver).
            return {**obj, "fuzzy_plate_match": matched}
        return None

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
