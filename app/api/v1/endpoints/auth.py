"""Authentication endpoints: login + current-user.

Logout is client-side (drop the token). The auth middleware (see ``app.main``)
enforces the token on every other ``/api/v1`` route and blocks write methods for
the ``demo`` role.
"""

from __future__ import annotations

import structlog
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ....core.auth import make_token

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    username: str
    role: str


class LoginOut(BaseModel):
    token: str
    user: UserOut


@router.post("/login", response_model=LoginOut)
async def login(body: LoginIn, request: Request) -> LoginOut:
    cfg = getattr(request.app.state, "auth_config", None)
    if cfg is None:
        raise HTTPException(status_code=503, detail="Авторизация не настроена")
    role = cfg.authenticate(body.username, body.password)
    if not role:
        log.info("login_failed", username=body.username[:40])
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    token = make_token(body.username, role, cfg.secret, cfg.ttl)
    log.info("login_ok", username=body.username[:40], role=role)
    return LoginOut(token=token, user=UserOut(username=body.username, role=role))


@router.get("/me", response_model=UserOut)
async def me(request: Request) -> UserOut:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Не авторизовано")
    return UserOut(username=user.get("u", ""), role=user.get("r", ""))


def _require_admin(request: Request) -> None:
    user = getattr(request.state, "user", None)
    if not user or user.get("r") != "admin":
        raise HTTPException(status_code=403, detail="Только для администратора")


class PasswordIn(BaseModel):
    password: str


@router.get("/users", response_model=list[UserOut])
async def list_users(request: Request) -> list[UserOut]:
    """List all accounts (admin only) — for the password-management UI."""
    _require_admin(request)
    cfg = getattr(request.app.state, "auth_config", None)
    if cfg is None:
        raise HTTPException(status_code=503, detail="Авторизация не настроена")
    return [UserOut(**u) for u in cfg.list_users()]


@router.post("/users/{username}/password")
async def change_password(username: str, body: PasswordIn, request: Request) -> dict[str, bool]:
    """Change the password of any account (admin only)."""
    _require_admin(request)
    cfg = getattr(request.app.state, "auth_config", None)
    if cfg is None:
        raise HTTPException(status_code=503, detail="Авторизация не настроена")
    if not (body.password or "").strip():
        raise HTTPException(status_code=400, detail="Пароль не может быть пустым")
    if not cfg.set_password(username, body.password):
        raise HTTPException(status_code=404, detail="Учётная запись не найдена")
    return {"ok": True}
