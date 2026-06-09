"""Settings for geo.gpspos.ru API client."""

from __future__ import annotations

from pydantic import AliasChoices, Field, field_validator

from app.core.config import EnvSettings


class GpsposGeoSettings(EnvSettings):
    BASE_URL: str = Field(
        default="https://geo.gpspos.ru/api",
        validation_alias=AliasChoices("GPSPOS_GEO_BASE_URL", "GEO_BASE_URL"),
    )
    USERNAME: str = Field(
        ...,
        description="Geo API account user name (required).",
        validation_alias=AliasChoices("GPSPOS_GEO_USERNAME", "GEO_USERNAME"),
    )
    PASSWORD: str = Field(
        ...,
        description="Geo API account password (required).",
        validation_alias=AliasChoices("GPSPOS_GEO_PASSWORD", "GEO_PASSWORD"),
    )
    SUB_USER_ID: int = Field(
        default=0,
        validation_alias=AliasChoices("GPSPOS_GEO_SUB_USER_ID", "GEO_SUB_USER_ID"),
    )

    @field_validator("USERNAME", "PASSWORD")
    @classmethod
    def non_empty_credentials(cls, v: str) -> str:
        if not isinstance(v, str) or not v.strip():
            raise ValueError("must not be empty")
        return v.strip()
