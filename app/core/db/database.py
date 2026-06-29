from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = "sqlite+aiosqlite:///./support_agent.db"

engine = create_async_engine(DATABASE_URL, echo=False)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


def _column_exists(conn, table: str, column: str) -> bool:
    """True if ``column`` exists on ``table`` (SQLite, sync conn)."""
    rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == column for r in rows)


def _run_lightweight_migrations(conn) -> None:
    """Idempotent additive schema migrations for SQLite.

    ``Base.metadata.create_all`` only creates missing tables — it never adds
    columns to existing ones. New nullable columns on existing tables are added
    here, guarded by a column-existence check so re-runs are safe.
    """
    # app_templates.user_id — personal vs shared templates.
    # NULL = shared (visible to everyone); a username = owned by that user.
    if not _column_exists(conn, "app_templates", "user_id"):
        conn.exec_driver_sql("ALTER TABLE app_templates ADD COLUMN user_id TEXT")

    # ai_feedback: отметка «разобрано и исправлено» (resolved) + кто/когда.
    if not _column_exists(conn, "ai_feedback", "resolved"):
        conn.exec_driver_sql("ALTER TABLE ai_feedback ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0")
    if not _column_exists(conn, "ai_feedback", "resolved_at"):
        conn.exec_driver_sql("ALTER TABLE ai_feedback ADD COLUMN resolved_at DATETIME")
    if not _column_exists(conn, "ai_feedback", "resolved_by"):
        conn.exec_driver_sql("ALTER TABLE ai_feedback ADD COLUMN resolved_by TEXT")


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_run_lightweight_migrations)
