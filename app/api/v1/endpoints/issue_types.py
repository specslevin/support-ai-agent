"""Issue types endpoint."""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException

from app.core.dependencies import get_okdesk_service
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/issue-types", tags=["dashboard:issue_types"])


@router.get("")
async def list_issue_types(
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> list[dict[str, object]]:
    """Return available Okdesk issue types (excluding 'inner')."""
    try:
        return await okdesk.list_issue_types()
    except Exception:
        log.exception("list_issue_types_failed")
        raise HTTPException(status_code=500, detail="Failed to fetch issue types")
