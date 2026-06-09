"""Pydantic models for nav.gpspos.ru API responses."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class TokenResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    accessToken: str
    expiresInSec: int | None = None


class ObjectStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")

    objectId: int
    online: bool
    time: int
    lat: float
    lng: float
    speed: float
    sat: int


class ObjectInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    imei: str
    name: str
    stateNumber: str
    phone: str
    deviceType: str
    payedTill: int


class GeoResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    address: str
    street: str
    error: str


class EventItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    objectId: int
    time: int
    type: int
    status: int
    text: str
    resetTime: int
    notificationId: int
