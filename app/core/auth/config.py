"""Auth configuration from environment.

Env vars (all optional — sensible dev defaults so the demo works out of the box;
override in production):

  AUTH_SECRET          — HMAC signing secret for tokens.
  AUTH_ADMIN_USERS     — comma-separated ``user:password`` pairs, role=admin.
  AUTH_DEMO_USERS      — comma-separated ``user:password`` pairs, role=demo.
  AUTH_TOKEN_TTL_SEC   — token lifetime in seconds (default 12h).

Example:
  AUTH_ADMIN_USERS="sergei:s3cret,claude:c0de"
  AUTH_DEMO_USERS="demo:demo"
"""

from __future__ import annotations

import hmac
import os

import structlog

log = structlog.get_logger(__name__)

_DEFAULT_TTL = 12 * 3600
_DEFAULT_SECRET = "change-me-support-ai-secret"  # noqa: S105 — dev fallback only


def _parse_users(raw: str | None, role: str) -> dict[str, tuple[str, str]]:
    users: dict[str, tuple[str, str]] = {}
    for pair in (raw or "").split(","):
        pair = pair.strip()
        if not pair or ":" not in pair:
            continue
        username, password = pair.split(":", 1)
        username = username.strip()
        if username:
            users[username] = (password, role)
    return users


class AuthConfig:
    def __init__(self) -> None:
        self.secret = os.getenv("AUTH_SECRET") or _DEFAULT_SECRET
        if self.secret == _DEFAULT_SECRET:
            log.warning("auth_default_secret_in_use",
                        hint="set AUTH_SECRET in production")
        admins = _parse_users(os.getenv("AUTH_ADMIN_USERS", "admin:admin"), "admin")
        demos = _parse_users(os.getenv("AUTH_DEMO_USERS", "demo:demo"), "demo")
        # admin overrides demo on a username clash
        self.users: dict[str, tuple[str, str]] = {**demos, **admins}
        try:
            self.ttl = int(os.getenv("AUTH_TOKEN_TTL_SEC", str(_DEFAULT_TTL)))
        except ValueError:
            self.ttl = _DEFAULT_TTL
        log.info("auth_config_loaded",
                 admins=sum(1 for _, r in self.users.values() if r == "admin"),
                 demos=sum(1 for _, r in self.users.values() if r == "demo"))

    def authenticate(self, username: str, password: str) -> str | None:
        """Return the role on success, else None (constant-time password check)."""
        rec = self.users.get((username or "").strip())
        if not rec:
            return None
        stored_pw, role = rec
        if hmac.compare_digest(stored_pw, password or ""):
            return role
        return None
