"""Личные сохранённые фильтры списка заявок (per-user, приватные).

Каждая запись привязана к текущему пользователю по ``request.state.user["u"]``.
Неаутентифицированный запрос → 401. Чужие записи не видны и не изменяемы (404).

Shape ответа (единый для всех эндпоинтов, на него завязан фронтенд):
``{id, name, filters: {status, company, search, assignee, issueId, sort, order},
   position, created_at, updated_at}``
где ``filters`` — распарсенный объект (json.loads), а не строка.
"""

from __future__ import annotations

import json

import structlog
from fastapi import APIRouter, Body, HTTPException, Request
from sqlalchemy import select

from app.core.db.database import AsyncSessionLocal
from app.core.db.models import SavedFilter

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/saved-filters", tags=["saved-filters"])


def _require_user(request: Request) -> str:
    """Username из auth-middleware (``request.state.user == {"u", "r"}``).
    401, если запрос не аутентифицирован."""
    user = getattr(request.state, "user", None)
    if isinstance(user, dict):
        username = user.get("u")
        if username:
            return str(username)
    raise HTTPException(status_code=401, detail="Unauthorized")


def _serialize(row: SavedFilter) -> dict[str, object]:
    """Единый shape ответа. ``filters`` — распарсенный объект, не строка."""
    try:
        filters = json.loads(row.filters_json) if row.filters_json else {}
    except (ValueError, TypeError):
        filters = {}
    return {
        "id": row.id,
        "name": row.name,
        "filters": filters,
        "position": row.position,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.get("")
async def list_saved_filters(request: Request) -> list[dict[str, object]]:
    """Список сохранённых фильтров текущего пользователя (по position, потом name)."""
    username = _require_user(request)
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(SavedFilter)
            .where(SavedFilter.username == username)
            .order_by(SavedFilter.position.asc(), SavedFilter.name.asc())
        )
        rows = result.scalars().all()
        return [_serialize(r) for r in rows]


@router.post("")
async def create_saved_filter(
    request: Request, payload: dict = Body(...)
) -> dict[str, object]:
    """Создать фильтр ``{name, filters, position?}``. Возвращает созданный."""
    username = _require_user(request)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    filters = payload.get("filters")
    if not isinstance(filters, dict):
        raise HTTPException(status_code=400, detail="filters must be an object")
    position = payload.get("position")
    position = int(position) if isinstance(position, (int, float)) else 0
    async with AsyncSessionLocal() as session:
        row = SavedFilter(
            username=username,
            name=name,
            filters_json=json.dumps(filters, ensure_ascii=False),
            position=position,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return _serialize(row)


@router.put("/{filter_id}")
async def update_saved_filter(
    request: Request, filter_id: int, payload: dict = Body(...)
) -> dict[str, object]:
    """Обновить ``{name?, filters?, position?}`` — только свою запись (иначе 404)."""
    username = _require_user(request)
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(SavedFilter).where(
                SavedFilter.id == filter_id,
                SavedFilter.username == username,
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Saved filter not found")

        if "name" in payload:
            name = (payload.get("name") or "").strip()
            if not name:
                raise HTTPException(status_code=400, detail="name is required")
            row.name = name
        if "filters" in payload:
            filters = payload.get("filters")
            if not isinstance(filters, dict):
                raise HTTPException(status_code=400, detail="filters must be an object")
            row.filters_json = json.dumps(filters, ensure_ascii=False)
        if "position" in payload:
            position = payload.get("position")
            row.position = int(position) if isinstance(position, (int, float)) else 0

        await session.commit()
        await session.refresh(row)
        return _serialize(row)


@router.delete("/{filter_id}")
async def delete_saved_filter(request: Request, filter_id: int) -> dict[str, object]:
    """Удалить свою запись (иначе 404). Возвращает ``{ok: true}``."""
    username = _require_user(request)
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(SavedFilter).where(
                SavedFilter.id == filter_id,
                SavedFilter.username == username,
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Saved filter not found")
        await session.delete(row)
        await session.commit()
        return {"ok": True}
