"""Pydantic models for Wialon Remote API responses."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class LoginResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    eid: int | None = None
    ssid: str | None = None
    error: int | None = None


class WialonError(BaseModel):
    model_config = ConfigDict(extra="ignore")

    error: int | None = None


class UserData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int | None = None
    nm: str | None = None
    crt: int | None = None
    bact: int | None = None
    fl: int | None = None
    prf: dict | None = None


class Unit(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    nm: str
    uid: str | None = None
    cls: int | None = None
    ua: str | None = None


class UnitData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int | None = None
    nm: str | None = None
    uid: str | None = None
    prp: dict | None = None


class Message(BaseModel):
    model_config = ConfigDict(extra="ignore")

    t: int | None = None
    p: str | None = None
    tp: str | None = None
    f: int | None = None
    c: str | None = None
    a: str | None = None
    x: float | None = None
    y: float | None = None
    z: float | None = None
    s: float | None = None
    alt: float | None = None
