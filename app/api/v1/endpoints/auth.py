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
