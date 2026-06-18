"""Lightweight username/password auth with admin/demo roles.

Stateless signed tokens (stdlib HMAC, no extra deps). Users are configured via
environment variables — secrets never live in code. See ``AuthConfig``.
"""

from .config import AuthConfig
from .security import make_token, verify_token

__all__ = ["AuthConfig", "make_token", "verify_token"]
