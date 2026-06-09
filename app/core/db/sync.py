from __future__ import annotations

import structlog
from sqlalchemy import select

from app.core.db.database import AsyncSessionLocal
from app.core.db.models import Company as DBCompany
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)


async def _upsert_companies(
    session: AsyncSessionLocal,
    companies: list[tuple[int, str]],
) -> int:
    saved = 0
    for ext_id, name in companies:
        existing = (
            await session.execute(
                select(DBCompany).where(DBCompany.external_id == ext_id)
            )
        ).scalar_one_or_none()

        if existing:
            if existing.name != name:
                existing.name = name
                saved += 1
        else:
            session.add(
                DBCompany(
                    external_id=ext_id,
                    name=name,
                    source="okdesk",
                )
            )
            saved += 1
    return saved


async def sync_companies(okdesk: OkdeskService) -> int:
    # 1. Discover all company IDs from all sources
    all_ids = await okdesk.discover_company_ids()
    if not all_ids:
        log.warning("sync_companies_no_data")
        return 0

    # 2. Get IDs already in local DB
    async with AsyncSessionLocal() as session:
        existing_result = await session.execute(
            select(DBCompany.external_id)
        )
        known_ids: set[int] = {row[0] for row in existing_result}

    # 3. Fetch full company data for all discovered IDs
    companies_data: list[tuple[int, str]] = []
    fetched_set: set[int] = set()
    missing_ids = all_ids - known_ids

    # Fetch from bulk endpoint first (gives us many in one call)
    for c in await okdesk.list_companies(limit=100):
        if c.id not in fetched_set:
            companies_data.append((c.id, c.name))
            fetched_set.add(c.id)

    # Fetch remaining missing ones individually
    fetched_missing = 0
    for cid in sorted(missing_ids):
        if cid in fetched_set:
            continue
        try:
            c = await okdesk.get_company(cid)
            companies_data.append((c.id, c.name))
            fetched_set.add(c.id)
            fetched_missing += 1
        except Exception:
            log.warning("sync_company_fetch_failed", company_id=cid)

    # 4. Upsert all into DB
    saved = 0
    async with AsyncSessionLocal() as session:
        saved = await _upsert_companies(session, companies_data)
        await session.commit()

    log.info(
        "sync_companies_done",
        total_ids=len(all_ids),
        known=len(known_ids),
        fetched_missing=fetched_missing,
        upserted=len(companies_data),
        saved=saved,
    )
    return saved
