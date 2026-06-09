"""Settings for Wialon Remote API client."""

from __future__ import annotations

from pydantic import AliasChoices, Field, field_validator

from app.core.config import EnvSettings


class WialonSettings(EnvSettings):
    BASE_URL: str = Field(
        default="https://host.local3.wialon.host/wialon/ajax.html",
        validation_alias=AliasChoices("WIALON_BASE_URL", "BASE_URL"),
    )
    USERNAME: str = Field(
        ...,
        description="Wialon account user name (required).",
        validation_alias=AliasChoices("WIALON_USERNAME", "WIALON_USER"),
    )
    PASSWORD: str = Field(
        ...,
        description="Wialon account password (required).",
        validation_alias=AliasChoices("WIALON_PASSWORD", "WIALON_PASS"),
    )

    @field_validator("USERNAME", "PASSWORD")
    @classmethod
    def non_empty(cls, v: str) -> str:
        if not isinstance(v, str) or not v.strip():
            raise ValueError("must not be empty")
        return v.strip()
