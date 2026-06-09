"""Settings for nav.gpspos.ru API client."""

from __future__ import annotations

from pydantic import AliasChoices, Field, field_validator

from app.core.config import EnvSettings


class GpsPosSettings(EnvSettings):
    BASE_URL: str = Field(
        default="https://nav.gpspos.ru/api",
        validation_alias=AliasChoices("GPSPOS_BASE_URL", "BASE_URL"),
    )
    USERNAME: str = Field(
        ...,
        description="API account user name (required).",
        validation_alias=AliasChoices("GPSPOS_USERNAME", "USERNAME"),
    )
    PASSWORD: str = Field(
        ...,
        description="API account password (required).",
        validation_alias=AliasChoices("GPSPOS_PASSWORD", "PASSWORD"),
    )
    SUB_USER_ID: int = Field(
        default=0,
        validation_alias=AliasChoices("GPSPOS_SUB_USER_ID", "SUB_USER_ID"),
    )

    @field_validator("USERNAME", "PASSWORD")
    @classmethod
    def non_empty_credentials(cls, v: str) -> str:
        if not isinstance(v, str) or not v.strip():
            raise ValueError("must not be empty")
        return v.strip()
