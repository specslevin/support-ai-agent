"""Object resolution endpoint: resolve a vehicle plate to a real GPSPOS object."""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.dependencies import get_object_resolver_service
from app.core.services.object_resolver import ObjectResolverService

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/objects", tags=["dashboard:objects"])


@router.get("/resolve")
async def resolve_object(
    plate: str = Query(..., min_length=1, description="Vehicle plate / госномер"),
    resolver: ObjectResolverService = Depends(get_object_resolver_service),
) -> dict[str, object]:
    """Resolve a plate to its GPSPOS object mapping (cached).

    Returns ``{found: true, ...mapping}`` on a hit, or ``{found: false}`` when
    the plate cannot be matched to any tracked object.
    """
    try:
        mapping = await resolver.resolve_object(plate)
    except Exception:
        log.exception("object_resolve_failed", plate=plate)
        raise HTTPException(status_code=502, detail="Failed to resolve object")
    if mapping is None:
        return {"found": False}
    return {"found": True, **mapping}
