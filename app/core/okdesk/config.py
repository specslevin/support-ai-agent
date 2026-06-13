"""Settings for Okdesk API client."""

from __future__ import annotations

from pydantic import AliasChoices, Field

from app.core.config import EnvSettings


class OkdeskSettings(EnvSettings):
    BASE_URL: str = Field(
        default="https://your-domain.okdesk.ru/api/v1",
        validation_alias=AliasChoices("OKDESK_BASE_URL", "BASE_URL"),
    )
    API_TOKEN: str = Field(
        ...,
        description="Okdesk API token (required).",
        validation_alias=AliasChoices("OKDESK_API_TOKEN", "API_TOKEN"),
    )
    EMPLOYEE_ID: int = Field(
        default=22,
        description="Okdesk employee ID linked to the API token.",
        validation_alias=AliasChoices("OKDESK_EMPLOYEE_ID", "EMPLOYEE_ID"),
    )
