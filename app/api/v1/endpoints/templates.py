"""Templates endpoints.

Reads templates from OUR app SQLite (tables ``app_templates`` /
``app_template_categories``) so they can later be edited safely. Falls back to
the legacy okdesk-console DB until ``POST /templates/migrate`` has been run.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import structlog
from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app.core.db.database import AsyncSessionLocal
from app.core.db.models import Template, TemplateCategory

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/templates", tags=["templates"])

OKDESK_CONSOLE_DB = Path("/home/okdesk/okdesk-console/app.db")
# Our app DB (matches DATABASE_URL "sqlite+aiosqlite:///./support_agent.db").
OUR_DB = Path("./support_agent.db")


# --------------------------------------------------------------------------- #
# Console DB reads (legacy fallback)
# --------------------------------------------------------------------------- #
def _console_read_templates() -> list[dict]:
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
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def _console_read_categories() -> list[dict]:
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


def _console_read_all_for_category() -> list[dict]:
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
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Our DB reads (preferred) — small sync sqlite read, consistent with above
# --------------------------------------------------------------------------- #
def _our_db_conn() -> sqlite3.Connection | None:
    if not OUR_DB.exists():
        return None
    conn = sqlite3.connect(str(OUR_DB))
    conn.row_factory = sqlite3.Row
    return conn


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    )
    return cur.fetchone() is not None


def _our_read_templates() -> list[dict] | None:
    """Return templates from OUR DB, or None if our tables are empty/missing."""
    conn = _our_db_conn()
    if conn is None:
        return None
    try:
        if not _table_exists(conn, "app_templates"):
            return None
        cur = conn.execute(
            """
            SELECT t.original_id AS id, t.name, t.content, t.category_id,
                   t.usage_count, t.is_favorite, t.is_dynamic,
                   c.name AS category_name, c.color AS category_color
            FROM app_templates t
            LEFT JOIN app_template_categories c
                   ON c.original_id = t.category_id
            WHERE t.active = 1
            ORDER BY t.category_id, t.is_favorite DESC, t.usage_count DESC
            """
        )
        rows = [dict(r) for r in cur.fetchall()]
        return rows or None
    finally:
        conn.close()


def _our_read_categories() -> list[dict] | None:
    conn = _our_db_conn()
    if conn is None:
        return None
    try:
        if not _table_exists(conn, "app_template_categories"):
            return None
        cur = conn.execute(
            """
            SELECT original_id AS id, name, color
            FROM app_template_categories ORDER BY original_id
            """
        )
        rows = [dict(r) for r in cur.fetchall()]
        return rows or None
    finally:
        conn.close()


def _our_read_all_for_category() -> list[dict] | None:
    conn = _our_db_conn()
    if conn is None:
        return None
    try:
        if not _table_exists(conn, "app_templates"):
            return None
        cur = conn.execute(
            """
            SELECT t.name, t.content, t.is_dynamic, t.is_favorite,
                   t.usage_count, c.name AS category_name
            FROM app_templates t
            LEFT JOIN app_template_categories c
                   ON c.original_id = t.category_id
            WHERE t.active = 1 AND t.content IS NOT NULL AND t.content != ''
            ORDER BY t.is_favorite DESC, t.usage_count DESC
            """
        )
        rows = [dict(r) for r in cur.fetchall()]
        return rows or None
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Public read helpers — prefer OUR DB, fall back to console DB
# --------------------------------------------------------------------------- #
def _read_templates() -> list[dict]:
    ours = _our_read_templates()
    if ours is not None:
        return ours
    return _console_read_templates()


def _read_categories() -> list[dict]:
    ours = _our_read_categories()
    if ours is not None:
        return ours
    return _console_read_categories()


def fetch_templates_for_category(
    category_name: str | None, limit: int = 3
) -> list[dict]:
    """Return active templates matching an analysis category (few-shot refs).

    Read-only. Prefers OUR migrated tables, falls back to the okdesk-console DB
    when ours are empty. Loosely matches ``category_name`` against either the
    template's category name OR the template's own name (case-insensitive
    substring). On no match (or no category) falls back to the globally
    most-used templates. Never raises — returns ``[]`` on any failure.

    Returns up to ``limit`` dicts ``{name, content, category, is_dynamic}``.
    """
    if limit <= 0:
        return []
    try:
        rows = _our_read_all_for_category()
        if rows is None:
            rows = _console_read_all_for_category()
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

    return [_shape(r) for r in rows[:limit]]


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.get("")
async def list_templates() -> list[dict]:
    """Active templates (our DB, console fallback). Same shape the UI consumes."""
    try:
        return _read_templates()
    except Exception:
        log.exception("list_templates_failed")
        return []


@router.get("/categories")
async def list_categories() -> list[dict]:
    """Template categories [{id, name, color}] (our DB, console fallback)."""
    try:
        return _read_categories()
    except Exception:
        log.exception("list_categories_failed")
        return []


@router.post("/migrate")
async def migrate_templates() -> dict:
    """Copy categories + templates from the okdesk-console DB into OUR tables.

    Idempotent UPSERT keyed by ``original_id`` (the console-side id), so it is
    safe to re-run — existing rows are updated, new ones inserted. Returns
    ``{ok, templates, categories}`` counts.
    """
    try:
        categories = _console_read_categories()
        templates = _console_read_templates()
    except Exception:
        log.exception("migrate_read_console_failed")
        raise HTTPException(status_code=500, detail="Failed to read console DB")

    cat_count = 0
    tpl_count = 0
    try:
        async with AsyncSessionLocal() as session:
            # Categories
            for c in categories:
                oid = c.get("id")
                if oid is None:
                    continue
                existing = (
                    await session.execute(
                        select(TemplateCategory).where(
                            TemplateCategory.original_id == oid
                        )
                    )
                ).scalar_one_or_none()
                if existing is None:
                    session.add(
                        TemplateCategory(
                            original_id=oid,
                            name=c.get("name") or "",
                            color=c.get("color"),
                        )
                    )
                else:
                    existing.name = c.get("name") or ""
                    existing.color = c.get("color")
                cat_count += 1

            # Templates
            for t in templates:
                oid = t.get("id")
                if oid is None:
                    continue
                existing = (
                    await session.execute(
                        select(Template).where(Template.original_id == oid)
                    )
                ).scalar_one_or_none()
                if existing is None:
                    session.add(
                        Template(
                            original_id=oid,
                            name=t.get("name") or "",
                            content=t.get("content"),
                            category_id=t.get("category_id"),
                            active=1,
                            usage_count=int(t.get("usage_count") or 0),
                            is_dynamic=1 if t.get("is_dynamic") else 0,
                            is_favorite=1 if t.get("is_favorite") else 0,
                            source="console",
                        )
                    )
                else:
                    existing.name = t.get("name") or ""
                    existing.content = t.get("content")
                    existing.category_id = t.get("category_id")
                    existing.usage_count = int(t.get("usage_count") or 0)
                    existing.is_dynamic = 1 if t.get("is_dynamic") else 0
                    existing.is_favorite = 1 if t.get("is_favorite") else 0
                tpl_count += 1

            await session.commit()
    except Exception:
        log.exception("migrate_upsert_failed")
        raise HTTPException(status_code=500, detail="Failed to migrate templates")

    return {"ok": True, "templates": tpl_count, "categories": cat_count}
