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


def fetch_templates_for_category(
    category_name: str | None, limit: int = 3
) -> list[dict]:
    """Return active okdesk-console templates matching an analysis category.

    Read-only. Loosely matches ``category_name`` (e.g. an AI analysis label such
    as "Глушение", "Не было питания", "Терминал подключился", "Данные верны")
    against either the template's category name OR the template's own name using
    a case-insensitive substring test. Results are ordered ``is_favorite`` first,
    then ``usage_count`` desc. When nothing matches (or no category given) falls
    back to the globally most-used templates so the AI still has phrasing refs.

    Returns up to ``limit`` dicts ``{name, content, category, is_dynamic}``.
    Never raises — on any failure returns ``[]``.
    """
    if limit <= 0:
        return []
    try:
        if not OKDESK_CONSOLE_DB.exists():
            return []
        conn = sqlite3.connect(str(OKDESK_CONSOLE_DB))
        conn.row_factory = sqlite3.Row
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT t.name, t.content, t.is_dynamic, t.is_favorite,
                       t.usage_count, c.name AS category_name
                FROM templates t
                LEFT JOIN categories c ON c.id = t.category_id
                WHERE t.active = 1 AND t.content IS NOT NULL AND t.content != ''
                ORDER BY t.is_favorite DESC, t.usage_count DESC
                """
            )
            rows = [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()
    except Exception:
        log.warning("fetch_templates_for_category_failed", category=category_name)
        return []

    def _shape(r: dict) -> dict:
        return {
            "name": r.get("name"),
            "content": r.get("content"),
            "category": r.get("category_name"),
            "is_dynamic": bool(r.get("is_dynamic")),
        }

    needle = (category_name or "").strip().lower()
    if needle:
        matched = [
            r
            for r in rows
            if needle in (r.get("category_name") or "").lower()
            or needle in (r.get("name") or "").lower()
        ]
        if matched:
            return [_shape(r) for r in matched[:limit]]

    # Generic fallback: globally most-used templates (rows already ordered).
    return [_shape(r) for r in rows[:limit]]


def _read_categories() -> list[dict]:
    if not OKDESK_CONSOLE_DB.exists():
        return []
    conn = sqlite3.connect(str(OKDESK_CONSOLE_DB))
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()
        cur.execute("SELECT id, name, color FROM categories ORDER BY id")
        return [dict(r) for r in cur.fetchall()]
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


@router.get("/categories")
async def list_categories() -> list[dict]:
    """Return template categories [{id, name, color}] from okdesk-console (read-only)."""
    try:
        return _read_categories()
    except Exception:
        log.exception("list_categories_failed")
        raise HTTPException(status_code=500, detail="Failed to read categories")
