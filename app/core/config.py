"""Central defaults for environment-backed configuration (`.env` + process env)."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict

# Loaded from the current working directory when the file exists (typically project root).
ENV_FILE_SETTINGS = SettingsConfigDict(
    env_file=".env",
    env_file_encoding="utf-8",
    extra="ignore",
)


class EnvSettings(BaseSettings):
    """Base class: OS environment variables plus optional `.env` in CWD."""

    model_config = ENV_FILE_SETTINGS
