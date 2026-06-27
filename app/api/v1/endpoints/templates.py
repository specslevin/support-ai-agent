"""Templates endpoints.

Reads templates from OUR app SQLite (tables ``app_templates`` /
``app_template_categories``) so they can later be edited safely. Falls back to
the legacy okdesk-console DB until ``POST /templates/migrate`` has been run.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import structlog
from fastapi import APIRouter, Body, HTTPException, Request
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


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == column for r in rows)


def _our_read_templates(current_user: str | None = None) -> list[dict] | None:
    """Return templates from OUR DB, or None if our tables are empty/missing.

    Visibility filter: shared templates (``user_id IS NULL``) are returned to
    everyone; personal templates only to their owner. When ``current_user`` is
    None, only shared templates are returned.
    """
    conn = _our_db_conn()
    if conn is None:
        return None
    try:
        if not _table_exists(conn, "app_templates"):
            return None
        has_owner = _column_exists(conn, "app_templates", "user_id")
        owner_select = "t.user_id" if has_owner else "NULL AS user_id"
        if has_owner:
            visibility = "AND (t.user_id IS NULL OR t.user_id = ?)"
            params: tuple = (current_user,) if current_user else ()
            if not current_user:
                visibility = "AND t.user_id IS NULL"
        else:
            visibility = ""
            params = ()
        cur = conn.execute(
            f"""
            SELECT t.original_id AS id, t.name, t.content, t.category_id,
                   t.usage_count, t.is_favorite, t.is_dynamic, {owner_select},
                   c.name AS category_name, c.color AS category_color
            FROM app_templates t
            LEFT JOIN app_template_categories c
                   ON c.original_id = t.category_id
            WHERE t.active = 1 {visibility}
            ORDER BY t.category_id, t.is_favorite DESC, t.usage_count DESC
            """,
            params,
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
# Display helpers — dedup + default sort
# --------------------------------------------------------------------------- #
_WS_RE = re.compile(r"\s+")


def _normalize_content(content: str | None) -> str:
    """Normalize template body for duplicate detection: trim, collapse runs of
    whitespace to a single space, lowercase. Empty/None -> ""."""
    if not content:
        return ""
    return _WS_RE.sub(" ", content.strip()).lower()


def _dedupe_templates(rows: list[dict]) -> list[dict]:
    """Collapse templates with the same normalized content to one row, keeping
    the instance with the highest ``usage_count`` (ties keep the first seen).
    Rows with empty content are passed through untouched (never merged).

    Deduplication is scoped by owner (``user_id``): a personal template is never
    collapsed into a shared one (or another user's), so each visibility bucket
    keeps its own copy."""
    best: dict[tuple, dict] = {}
    out: list[dict] = []
    for r in rows:
        content_key = _normalize_content(r.get("content"))
        if not content_key:
            out.append(r)
            continue
        key = (r.get("user_id"), content_key)
        prev = best.get(key)
        if prev is None:
            best[key] = r
            out.append(r)
        elif int(r.get("usage_count") or 0) > int(prev.get("usage_count") or 0):
            # Replace the kept instance in-place to preserve overall order.
            idx = out.index(prev)
            out[idx] = r
            best[key] = r
    return out


def _sort_by_usage(rows: list[dict]) -> list[dict]:
    """Favorites first, then by usage_count desc, then name (stable, display-only)."""
    return sorted(
        rows,
        key=lambda r: (
            0 if r.get("is_favorite") else 1,
            -int(r.get("usage_count") or 0),
            (r.get("name") or "").lower(),
        ),
    )


# --------------------------------------------------------------------------- #
# Public read helpers — prefer OUR DB, fall back to console DB
# --------------------------------------------------------------------------- #
def _read_templates(dedupe: bool = True, current_user: str | None = None) -> list[dict]:
    ours = _our_read_templates(current_user=current_user)
    rows = ours if ours is not None else _console_read_templates()
    if dedupe:
        rows = _dedupe_templates(rows)
    return _sort_by_usage(rows)


def _current_user(request: Request) -> str | None:
    """Username from the auth-middleware payload on ``request.state.user``
    (``{"u": username, "r": role}``), or None if unauthenticated."""
    user = getattr(request.state, "user", None)
    if isinstance(user, dict):
        return user.get("u") or None
    return None


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
async def list_templates(request: Request, dedupe: bool = True) -> list[dict]:
    """Active templates (our DB, console fallback). Same shape the UI consumes.

    Sorted favorites-first, then by ``usage_count`` desc (popular on top).
    ``dedupe=true`` (default) collapses templates with identical normalized
    content to a single instance (the most-used one); pass ``dedupe=false`` to
    get every row (e.g. for admin auditing). Dedup is display-only — nothing is
    deleted from the DB.

    Visibility: shared templates (``user_id IS NULL``) are returned to everyone;
    personal templates only to their owner (the authenticated user).
    """
    try:
        return _read_templates(dedupe=dedupe, current_user=_current_user(request))
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


# --------------------------------------------------------------------------- #
# CRUD on OUR DB (app_templates / app_template_categories) — async ORM only.
# Targets ONLY our tables; never writes to the okdesk-console DB.
# --------------------------------------------------------------------------- #
async def _shape_template(session, tpl: Template) -> dict:
    """Render a ``Template`` row in the SAME shape ``GET /templates`` returns.

    ``GET`` exposes the console-side id (``original_id``) as ``id`` and joins
    categories on ``original_id``. For locally-created rows ``original_id`` is
    NULL, so we fall back to the primary key ``id`` to keep a stable identifier
    the other CRUD endpoints can address.
    """
    category_name = None
    category_color = None
    if tpl.category_id is not None:
        cat = (
            await session.execute(
                select(TemplateCategory).where(
                    TemplateCategory.original_id == tpl.category_id
                )
            )
        ).scalar_one_or_none()
        if cat is not None:
            category_name = cat.name
            category_color = cat.color
    return {
        "id": tpl.original_id if tpl.original_id is not None else tpl.id,
        "name": tpl.name,
        "content": tpl.content,
        "category_id": tpl.category_id,
        "usage_count": tpl.usage_count,
        "is_favorite": tpl.is_favorite,
        "is_dynamic": tpl.is_dynamic,
        "user_id": tpl.user_id,
        "category_name": category_name,
        "category_color": category_color,
    }


async def _get_template_or_404(session, template_id: int) -> Template:
    """Resolve a template by the public id (``original_id`` first, then PK)."""
    tpl = (
        await session.execute(
            select(Template).where(Template.original_id == template_id)
        )
    ).scalar_one_or_none()
    if tpl is None:
        tpl = (
            await session.execute(
                select(Template).where(Template.id == template_id)
            )
        ).scalar_one_or_none()
    if tpl is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return tpl


@router.post("")
async def create_template(request: Request, payload: dict = Body(...)) -> dict:
    """Create a template in OUR DB.

    Body: ``{name, content, category_id?, is_dynamic?, is_favorite?,
    is_personal?}``. Inserts into ``app_templates`` with ``active=1,
    usage_count=0, source="local"``. If ``is_personal`` is truthy the template
    is owned by the authenticated user (``user_id`` set); otherwise it is shared
    (``user_id`` NULL). Returns the created row in the ``GET /templates`` shape.
    """
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    owner = _current_user(request) if payload.get("is_personal") else None
    if payload.get("is_personal") and not owner:
        raise HTTPException(
            status_code=401, detail="Личный шаблон требует авторизации"
        )
    try:
        async with AsyncSessionLocal() as session:
            tpl = Template(
                original_id=None,
                name=name,
                content=payload.get("content"),
                category_id=payload.get("category_id"),
                active=1,
                usage_count=0,
                is_dynamic=1 if payload.get("is_dynamic") else 0,
                is_favorite=1 if payload.get("is_favorite") else 0,
                user_id=owner,
                source="local",
            )
            session.add(tpl)
            await session.commit()
            await session.refresh(tpl)
            return await _shape_template(session, tpl)
    except HTTPException:
        raise
    except Exception:
        log.exception("create_template_failed")
        raise HTTPException(status_code=500, detail="Failed to create template")


def _assert_can_modify(tpl: Template, current_user: str | None) -> None:
    """Forbid modifying/deleting someone else's personal template.

    Shared templates (``user_id`` NULL) stay editable for everyone (as before);
    a personal template can only be changed by its owner.
    """
    if tpl.user_id is not None and tpl.user_id != current_user:
        raise HTTPException(
            status_code=403, detail="Чужой личный шаблон нельзя изменить"
        )


@router.put("/{template_id}")
async def update_template(
    request: Request, template_id: int, payload: dict = Body(...)
) -> dict:
    """Partial update of a template (name/content/category_id/is_dynamic/
    is_favorite/active). Returns the updated row in the ``GET`` shape. 404 if
    not found. 403 if it is another user's personal template."""
    try:
        async with AsyncSessionLocal() as session:
            tpl = await _get_template_or_404(session, template_id)
            _assert_can_modify(tpl, _current_user(request))
            if "name" in payload:
                new_name = (payload.get("name") or "").strip()
                if not new_name:
                    raise HTTPException(
                        status_code=400, detail="name cannot be empty"
                    )
                tpl.name = new_name
            if "content" in payload:
                tpl.content = payload.get("content")
            if "category_id" in payload:
                tpl.category_id = payload.get("category_id")
            if "is_dynamic" in payload:
                tpl.is_dynamic = 1 if payload.get("is_dynamic") else 0
            if "is_favorite" in payload:
                tpl.is_favorite = 1 if payload.get("is_favorite") else 0
            if "active" in payload:
                tpl.active = 1 if payload.get("active") else 0
            await session.commit()
            await session.refresh(tpl)
            return await _shape_template(session, tpl)
    except HTTPException:
        raise
    except Exception:
        log.exception("update_template_failed", template_id=template_id)
        raise HTTPException(status_code=500, detail="Failed to update template")


@router.delete("/{template_id}")
async def delete_template(request: Request, template_id: int) -> dict:
    """Soft delete: set ``active=0`` so it disappears from ``GET /templates``.
    404 if not found. 403 if it is another user's personal template."""
    try:
        async with AsyncSessionLocal() as session:
            tpl = await _get_template_or_404(session, template_id)
            _assert_can_modify(tpl, _current_user(request))
            tpl.active = 0
            await session.commit()
            return {"ok": True}
    except HTTPException:
        raise
    except Exception:
        log.exception("delete_template_failed", template_id=template_id)
        raise HTTPException(status_code=500, detail="Failed to delete template")


@router.post("/{template_id}/usage")
async def increment_template_usage(template_id: int) -> dict:
    """Increment ``usage_count`` by 1. Returns ``{ok, usage_count}``. 404 if not
    found."""
    try:
        async with AsyncSessionLocal() as session:
            tpl = await _get_template_or_404(session, template_id)
            tpl.usage_count = int(tpl.usage_count or 0) + 1
            await session.commit()
            await session.refresh(tpl)
            return {"ok": True, "usage_count": tpl.usage_count}
    except HTTPException:
        raise
    except Exception:
        log.exception("increment_template_usage_failed", template_id=template_id)
        raise HTTPException(status_code=500, detail="Failed to update usage")


@router.post("/categories")
async def create_category(payload: dict = Body(...)) -> dict:
    """Create a category ``{name, color?}`` in OUR DB. Returns the created
    category ``{id, name, color}`` (``id`` is the console-side ``original_id``
    when set, else the PK — matching ``GET /templates/categories``)."""
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    try:
        async with AsyncSessionLocal() as session:
            cat = TemplateCategory(
                original_id=None,
                name=name,
                color=payload.get("color"),
            )
            session.add(cat)
            await session.commit()
            await session.refresh(cat)
            return {
                "id": cat.original_id if cat.original_id is not None else cat.id,
                "name": cat.name,
                "color": cat.color,
            }
    except HTTPException:
        raise
    except Exception:
        log.exception("create_category_failed")
        raise HTTPException(status_code=500, detail="Failed to create category")
