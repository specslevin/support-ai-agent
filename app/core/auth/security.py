"""Stateless signed auth tokens (stdlib HMAC-SHA256, no JWT dependency).

Token format: ``<base64url(payload)>.<base64url(hmac)>`` where payload is a
compact JSON ``{"u": username, "r": role, "exp": unix_ts}``. Tampering breaks
the signature; expiry is enforced on verify. Good enough for an internal
dashboard with a small fixed set of users.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

_PBKDF2_ITERS = 200_000


def hash_password(password: str) -> str:
    """Salted PBKDF2-SHA256 hash, format ``pbkdf2_sha256$iters$salt_hex$hash_hex``."""
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"), salt, _PBKDF2_ITERS)
    return f"pbkdf2_sha256${_PBKDF2_ITERS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", (password or "").encode("utf-8"), bytes.fromhex(salt_hex), int(iters)
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(body: str, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    return _b64e(digest)


def make_token(username: str, role: str, secret: str, ttl_sec: int) -> str:
    payload = {"u": username, "r": role, "exp": int(time.time()) + int(ttl_sec)}
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{body}.{_sign(body, secret)}"


def verify_token(token: str | None, secret: str) -> dict[str, Any] | None:
    """Return the decoded payload if the token is valid and unexpired, else None."""
    if not token:
        return None
    try:
        body, sig = token.split(".", 1)
        if not hmac.compare_digest(sig, _sign(body, secret)):
            return None
        payload = json.loads(_b64d(body))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except Exception:
        return None
