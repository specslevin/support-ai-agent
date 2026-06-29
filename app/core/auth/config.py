"""Auth configuration: file-backed user store, seeded from environment.

On first run (no users file yet) the store is SEEDED from env vars, with
passwords hashed. After that the JSON file is the source of truth, so passwords
changed through the admin UI persist across restarts.

Env vars (used for the initial seed / signing only):
  AUTH_SECRET          — HMAC signing secret for tokens.
  AUTH_ADMIN_USERS     — comma-separated ``user:password`` pairs, role=admin.
  AUTH_DEMO_USERS      — comma-separated ``user:password`` pairs, role=demo.
  AUTH_TOKEN_TTL_SEC   — token lifetime in seconds (default 12h).
  AUTH_USERS_FILE      — path to the JSON user store (default <root>/auth_users.json).

Bootstrap default (if nothing set): admin:admin / demo:demo — change via UI.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import structlog

from .security import hash_password, verify_password

log = structlog.get_logger(__name__)

_DEFAULT_TTL = 12 * 3600
_DEFAULT_SECRET = "change-me-support-ai-secret"  # noqa: S105 — dev fallback only

# Допустимые роли: admin (полный доступ + управление учётками), operator (доступ
# к записи как admin, но без админ-эндпоинтов), demo (только просмотр).
_ROLES = ("admin", "operator", "demo")


def _parse_seed(raw: str | None, role: str) -> dict[str, tuple[str, str]]:
    """Parse ``user:password`` pairs → {username: (password, role)}."""
    out: dict[str, tuple[str, str]] = {}
    for pair in (raw or "").split(","):
        pair = pair.strip()
        if not pair or ":" not in pair:
            continue
        username, password = pair.split(":", 1)
        username = username.strip()
        if username:
            out[username] = (password, role)
    return out


class AuthConfig:
    def __init__(self) -> None:
        self.secret = os.getenv("AUTH_SECRET") or _DEFAULT_SECRET
        if self.secret == _DEFAULT_SECRET:
            log.warning("auth_default_secret_in_use", hint="set AUTH_SECRET in production")
        try:
            self.ttl = int(os.getenv("AUTH_TOKEN_TTL_SEC", str(_DEFAULT_TTL)))
        except ValueError:
            self.ttl = _DEFAULT_TTL
        self._path = Path(
            os.getenv("AUTH_USERS_FILE")
            or (Path(__file__).resolve().parents[3] / "auth_users.json")
        )
        # users: {username: {"pw_hash": str, "role": "admin"|"demo"}}
        self.users: dict[str, dict[str, str]] = self._load_or_seed()
        log.info("auth_config_loaded",
                 store=str(self._path),
                 admins=sum(1 for u in self.users.values() if u.get("role") == "admin"),
                 demos=sum(1 for u in self.users.values() if u.get("role") == "demo"))

    # ----- persistence ---------------------------------------------------
    def _load_or_seed(self) -> dict[str, dict[str, str]]:
        if self._path.exists():
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
                users = data.get("users") if isinstance(data, dict) else None
                if isinstance(users, dict) and users:
                    return {u: dict(v) for u, v in users.items()}
            except Exception:
                log.warning("auth_users_file_unreadable_reseeding", path=str(self._path))
        # Seed from env (defaults admin:admin / demo:demo), hash passwords.
        seed = {**_parse_seed(os.getenv("AUTH_DEMO_USERS", "demo:demo"), "demo"),
                **_parse_seed(os.getenv("AUTH_ADMIN_USERS", "admin:admin"), "admin")}
        users = {u: {"pw_hash": hash_password(pw), "role": role}
                 for u, (pw, role) in seed.items()}
        self._save(users)
        log.info("auth_users_seeded", count=len(users))
        return users

    def _save(self, users: dict[str, dict[str, str]]) -> None:
        try:
            self._path.write_text(
                json.dumps({"users": users}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            log.exception("auth_users_save_failed", path=str(self._path))

    # ----- API -----------------------------------------------------------
    def authenticate(self, username: str, password: str) -> str | None:
        rec = self.users.get((username or "").strip())
        if not rec:
            return None
        if verify_password(password or "", rec.get("pw_hash", "")):
            return rec.get("role")
        return None

    def list_users(self) -> list[dict[str, str]]:
        return [{"username": u, "role": v.get("role", "")} for u, v in sorted(self.users.items())]

    def set_password(self, username: str, new_password: str) -> bool:
        rec = self.users.get((username or "").strip())
        if not rec or not (new_password or "").strip():
            return False
        rec["pw_hash"] = hash_password(new_password)
        self._save(self.users)
        log.info("auth_password_changed", username=username)
        return True

    # ----- user management (admin) --------------------------------------
    def _admin_count(self) -> int:
        return sum(1 for v in self.users.values() if v.get("role") == "admin")

    def create_user(self, username: str, password: str, role: str) -> bool:
        """Создать учётку. False, если имя занято/пустое, пароль пуст или роль
        невалидна. role ∈ {admin, operator, demo}."""
        username = (username or "").strip()
        if (not username or username in self.users
                or not (password or "").strip()
                or role not in _ROLES):
            return False
        self.users[username] = {"pw_hash": hash_password(password), "role": role}
        self._save(self.users)
        log.info("auth_user_created", username=username, role=role)
        return True

    def delete_user(self, username: str) -> bool:
        """Удалить учётку. False, если пользователя нет ИЛИ это последний admin."""
        username = (username or "").strip()
        rec = self.users.get(username)
        if not rec:
            return False
        if rec.get("role") == "admin" and self._admin_count() <= 1:
            return False
        del self.users[username]
        self._save(self.users)
        log.info("auth_user_deleted", username=username)
        return True

    def set_role(self, username: str, role: str) -> bool:
        """Сменить роль. False, если пользователя нет, роль невалидна ИЛИ это
        попытка снять admin с последнего администратора."""
        username = (username or "").strip()
        rec = self.users.get(username)
        if not rec or role not in _ROLES:
            return False
        if rec.get("role") == "admin" and role != "admin" and self._admin_count() <= 1:
            return False
        rec["role"] = role
        self._save(self.users)
        log.info("auth_role_changed", username=username, role=role)
        return True
