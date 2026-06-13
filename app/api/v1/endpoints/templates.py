"""Templates endpoint — reads from okdesk-console SQLite DB."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import structlog
from fastapi import APIRouter, HTTPException

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/templates", tags=["templates"])

OKDESK_CONSOLE_DB = Path("/home/okdesk/okdesk-console/app.db")


def _read_templates() -> list[dict]:
    if not OKDESK_CONSOLE_DB.exists():
        return []
    conn = sqlite3.connect(str(OKDESK_CONSOLE_DB))
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT t.id, t.name, t.content, t.category_id, t.usage_count,
                   t.is_favorite, t.is_dynamic,
                   c.name AS category_name, c.color AS category_color
            FROM templates t
            LEFT JOIN categories c ON c.id = t.category_id
            WHERE t.active = 1
            ORDER BY c.id, t.is_favorite DESC, t.usage_count DESC
            """
        )
        rows = cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("")
async def list_templates() -> list[dict]:
    """Return all active templates from okdesk-console, grouped info included."""
    try:
        return _read_templates()
    except Exception:
        log.exception("list_templates_failed")
        raise HTTPException(status_code=500, detail="Failed to read templates")
