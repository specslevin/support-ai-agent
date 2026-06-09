"""Client for geo.gpspos.ru monitoring API."""

from __future__ import annotations

from .client import GpsposGeoClient, GpsposGeoAuth
from .config import GpsposGeoSettings
from .service import GpsposGeoService
from app.core.gpspos.models import EventItem, GeoResult, ObjectInfo, ObjectStatus, TokenResponse

__all__ = [
    "EventItem",
    "GeoResult",
    "GpsposGeoAuth",
    "GpsposGeoClient",
    "GpsposGeoSettings",
    "GpsposGeoService",
    "ObjectInfo",
    "ObjectStatus",
    "TokenResponse",
]
