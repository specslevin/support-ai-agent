"""ObjectResolverService: resolve a vehicle plate (госномер) to a real GPSPOS
geo object, with DB-backed caching.

Reuses :meth:`GpsposGeoService.find_object_by_plate` for matching (latin→cyrillic
normalization, region/core fallback). The cache lives in the ``object_resolve_cache``
table (auto-created via ``Base.metadata.create_all`` at startup), so resolutions
persist across restarts. This is the foundation for a rigid issue↔object link and
per-object answer aggregation (ОДКР).
"""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db.models import ObjectResolveCache
from app.core.gpspos_geo.service import GpsposGeoService

log = structlog.get_logger(__name__)


def _to_mapping(row: ObjectResolveCache) -> dict[str, Any] | None:
    """Cache row → resolved mapping. ``object_id is None`` is a cached miss."""
    if row.object_id is None:
        return None
    return {
        "plate_norm": row.plate_norm,
        "object_id": row.object_id,
        "name": row.name,
        "imei": row.imei,
        "phone": row.phone,
    }


def _from_raw(plate_norm: str, raw: dict[str, Any]) -> dict[str, Any]:
    """Raw geo object dict → resolved mapping."""
    return {
        "plate_norm": plate_norm,
        "object_id": raw.get("id"),
        "name": raw.get("name"),
        "imei": raw.get("imei"),
        "phone": raw.get("phone"),
    }


class ObjectResolverService:
    def __init__(self, db: AsyncSession, geo: GpsposGeoService) -> None:
        self.db = db
        self.geo = geo

    async def resolve_object(self, plate: str) -> dict[str, Any] | None:
        """Resolve a plate to its GPSPOS object mapping (cached).

        Returns ``{plate_norm, object_id, name, imei, phone}`` on a hit, or
        ``None`` if the plate cannot be matched to any tracked object.
        """
        plate_norm = GpsposGeoService._norm_plate(plate)
        if not plate_norm:
            return None

        existing = await self.db.execute(
            select(ObjectResolveCache).where(ObjectResolveCache.plate_norm == plate_norm)
        )
        cached = existing.scalar_one_or_none()
        if cached is not None:
            return _to_mapping(cached)

        raw = await self.geo.find_object_by_plate(plate)
        mapping = _from_raw(plate_norm, raw) if raw else None

        # Fuzzy-совпадение (исправленная опечатка) НЕ пишем в вечный кэш как
        # канонический маппинг: объект мог просто временно отсутствовать в гео.
        if raw and raw.get("fuzzy_plate_match"):
            return mapping

        # Persist both hits and misses (object_id=None) so repeated lookups of an
        # unknown plate don't re-scan the whole Objects list every time.
        row = ObjectResolveCache(
            plate_norm=plate_norm,
            object_id=mapping["object_id"] if mapping else None,
            name=mapping["name"] if mapping else None,
            imei=mapping["imei"] if mapping else None,
            phone=mapping["phone"] if mapping else None,
        )
        self.db.add(row)
        await self.db.commit()

        if mapping is None:
            # Coverage gap: surface unresolved plates so we can spot blind spots.
            log.warning("object_resolve_miss", plate=plate, plate_norm=plate_norm)

        return mapping

    async def resolve_plates(self, plates: list[str]) -> dict[str, dict[str, Any] | None]:
        """Resolve many plates at once (deduped). Keyed by the ORIGINAL plate
        string so callers can map results back. Foundation for ОДКР aggregation."""
        result: dict[str, dict[str, Any] | None] = {}
        # Dedup by normalized form to avoid resolving the same vehicle twice.
        seen: dict[str, dict[str, Any] | None] = {}
        for plate in plates:
            norm = GpsposGeoService._norm_plate(plate)
            if norm in seen:
                result[plate] = seen[norm]
                continue
            mapping = await self.resolve_object(plate)
            seen[norm] = mapping
            result[plate] = mapping
        return result
