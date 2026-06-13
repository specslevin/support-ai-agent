"""Employees endpoint — list Okdesk support staff."""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException

from app.core.dependencies import get_okdesk_service
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/employees", tags=["dashboard:employees"])


@router.get("")
async def list_employees(
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> list[dict[str, object]]:
    """Return active Okdesk employees (support staff)."""
    try:
        employees = await okdesk.list_employees(**{"page[size]": 50})
        return [
            {
                "id": e.id,
                "name": f"{e.last_name or ''} {e.first_name or ''}".strip(),
            }
            for e in employees
            if e.active
        ]
    except Exception:
        log.exception("list_employees_failed")
        raise HTTPException(status_code=500, detail="Failed to fetch employees")
