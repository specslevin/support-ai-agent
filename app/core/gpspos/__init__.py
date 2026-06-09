"""Client for nav.gpspos.ru monitoring API."""

from __future__ import annotations

from .auth import GpsPosAuth
from .client import GpsPosAPIError, GpsPosClient
from .config import GpsPosSettings
from .diagnostics import GpsPosDiagnostics
from .models import EventItem, GeoResult, ObjectInfo, ObjectStatus, TokenResponse

__all__ = [
    "GpsPosAPIError",
    "GpsPosAuth",
    "GpsPosClient",
    "GpsPosDiagnostics",
    "GpsPosSettings",
    "EventItem",
    "GeoResult",
    "ObjectInfo",
    "ObjectStatus",
    "TokenResponse",
]
