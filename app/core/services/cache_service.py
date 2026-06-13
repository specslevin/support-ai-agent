"""CacheService: sync Okdesk issues into SQLite and serve dashboard queries."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db.models import AnalysisCache, IssueCache, Object, Company
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)

_OKDESK_PAGE_SIZE = 100


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class CacheService:
    def __init__(self, db: AsyncSession, okdesk: OkdeskService) -> None:
        self.db = db
        self.okdesk = okdesk

    # ------------------------------------------------------------------
    # Sync
    # ------------------------------------------------------------------

    async def refresh_issue_cache(self) -> int:
        """Pull all issues from Okdesk REST API and upsert into issue_cache.

        Okdesk paginates via `page` (1-indexed), 100 per request max.
        We loop until we get fewer results than requested.

        Returns the number of issues upserted.
        """
        collected: list[Any] = []
        page_num = 1
        while True:
            try:
                # Okdesk uses page[number] / page[size] style pagination
                batch = await self.okdesk.list_issues(
                    **{"page[number]": page_num, "page[size]": _OKDESK_PAGE_SIZE}
                )
            except Exception:
                log.warning("okdesk_list_issues_failed", page=page_num)
                break
            collected.extend(batch)
            log.debug("okdesk_page_fetched", page=page_num, count=len(batch))
            if len(batch) < _OKDESK_PAGE_SIZE:
                break
            page_num += 1

        # Deduplicate by external ID (last write wins)
        by_id: dict[int, Any] = {}
        for issue in collected:
            by_id[issue.id] = issue

        # Pre-load company and object external_id → local id maps
        company_map = await self._load_company_map()
        object_map = await self._load_object_map()

        synced_at = datetime.utcnow()
        count = 0
        for ext_id, issue in by_id.items():
            row = await self._get_or_create_issue_cache(ext_id)
            row.subject = issue.title
            row.description = issue.description
            row.status = issue.status.code if issue.status else None
            row.priority = issue.priority.code if issue.priority else None
            row.company_id = company_map.get(issue.company.id) if issue.company else None
            row.company_name = issue.company.name if issue.company else None
            row.object_id = object_map.get(issue.service_object.id) if issue.service_object else None
            row.contact_name = issue.contact.name if issue.contact else None
            row.created_at = _parse_dt(issue.created_at)
            row.updated_at = _parse_dt(issue.updated_at)
            row.synced_at = synced_at
            self.db.add(row)
            count += 1

        await self.db.commit()
        log.info("issue_cache_refreshed", count=count)
        return count

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    async def get_issues_from_cache(
        self,
        status: str | None = None,
        company: str | None = None,
        search: str | None = None,
        sort: str = "created_at",
        order: str = "desc",
    ) -> list[IssueCache]:
        stmt = select(IssueCache)
        if status:
            stmt = stmt.where(IssueCache.status == status)
        if company:
            stmt = stmt.where(IssueCache.company_name.ilike(f"%{company}%"))
        if search:
            stmt = stmt.where(IssueCache.subject.ilike(f"%{search}%"))

        col = getattr(IssueCache, sort, IssueCache.created_at)
        stmt = stmt.order_by(col.desc() if order == "desc" else col.asc())

        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def get_issue_with_analysis(self, issue_id: int) -> dict[str, Any] | None:
        """Return IssueCache row plus its latest AnalysisCache entry."""
        result = await self.db.execute(
            select(IssueCache).where(IssueCache.id == issue_id)
        )
        row = result.scalar_one_or_none()
        if not row:
            return None

        analysis_result = await self.db.execute(
            select(AnalysisCache)
            .where(AnalysisCache.issue_id == issue_id)
            .order_by(AnalysisCache.created_at.desc())
            .limit(1)
        )
        latest = analysis_result.scalar_one_or_none()

        return {"issue": row, "latest_analysis": latest}

    async def save_analysis(
        self,
        issue_id: int,
        mileage_sheet: float,
        ai_suggestion: str,
        recommendation: str,
        mileage_system: float | None = None,
        notes: str | None = None,
    ) -> AnalysisCache:
        discrepancy = None
        if mileage_system:
            discrepancy = (mileage_system - mileage_sheet) / mileage_system * 100

        row = AnalysisCache(
            issue_id=issue_id,
            mileage_from_sheet=mileage_sheet,
            mileage_from_system=mileage_system,
            discrepancy_percent=discrepancy,
            ai_suggestion=ai_suggestion,
            recommendation=recommendation,
            notes=notes,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _get_or_create_issue_cache(self, external_id: int) -> IssueCache:
        result = await self.db.execute(
            select(IssueCache).where(IssueCache.external_id == external_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            row = IssueCache(external_id=external_id)
        return row

    async def _load_company_map(self) -> dict[int, int]:
        """Map Okdesk company external_id → local DB id."""
        result = await self.db.execute(select(Company.external_id, Company.id))
        return {ext: local for ext, local in result.all()}

    async def _load_object_map(self) -> dict[int, int]:
        """Map Okdesk object external_id → local DB id."""
        result = await self.db.execute(select(Object.external_id, Object.id))
        return {ext: local for ext, local in result.all()}
