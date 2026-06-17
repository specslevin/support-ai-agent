"""CacheService: sync Okdesk issues into SQLite and serve dashboard queries."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db.models import AnalysisCache, IssueCache, Object, Company, TrainingSample, ResultCache
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)

_OKDESK_PAGE_SIZE = 50
_OKDESK_MAX_PAGES = 60  # sync most recent 3000 issues
_OKDESK_PAGE_RETRIES = 3  # повторы при сбое страницы, чтобы не терять хвост синка


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
        while page_num <= _OKDESK_MAX_PAGES:
            # Повторяем страницу при транзиентной ошибке — иначе один сбой
            # обрывал весь синк и хвост заявок «терялся».
            batch: list[Any] | None = None
            for attempt in range(_OKDESK_PAGE_RETRIES):
                try:
                    # Okdesk uses page[number] / page[size] style pagination
                    batch = await self.okdesk.list_issues(
                        **{"page[number]": page_num, "page[size]": _OKDESK_PAGE_SIZE}
                    )
                    break
                except Exception:
                    log.warning("okdesk_list_issues_failed", page=page_num, attempt=attempt + 1)
                    # backoff перед повтором (429/сетевой сбой не лечится мгновенным ретраем)
                    if attempt + 1 < _OKDESK_PAGE_RETRIES:
                        await asyncio.sleep(1.5 * (attempt + 1))
            if batch is None:
                log.error("okdesk_sync_aborted", page=page_num, collected=len(collected))
                break
            collected.extend(batch)
            log.debug("okdesk_page_fetched", page=page_num, count=len(batch))
            if len(batch) < _OKDESK_PAGE_SIZE:
                break
            page_num += 1
        else:
            # Цикл дошёл до лимита страниц без break — возможно, часть заявок не влезла.
            log.warning("okdesk_sync_hit_page_cap", max_pages=_OKDESK_MAX_PAGES)

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

        # Batch-sync assignees for active issues (opened/wait/delayed)
        await self._sync_assignees_for_active()

        return count

    async def _sync_assignees_for_active(self) -> None:
        """Fetch assignee from Okdesk for all issues missing assignee_name.

        Limited to 500 most recently updated to keep refresh time reasonable.
        """
        result = await self.db.execute(
            select(IssueCache)
            .where(IssueCache.assignee_name.is_(None))
            .order_by(IssueCache.updated_at.desc())
            .limit(500)
        )
        rows = list(result.scalars().all())
        if not rows:
            return
        log.info("assignee_sync_start", count=len(rows))
        updated = 0
        for row in rows:
            try:
                detail = await self.okdesk.get_issue(row.external_id)
                if detail.assignee and detail.assignee.name:
                    row.assignee_name = detail.assignee.name
                    self.db.add(row)
                    updated += 1
            except Exception:
                log.warning("assignee_fetch_failed", external_id=row.external_id)
        await self.db.commit()
        log.info("assignee_sync_done", updated=updated)

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    async def get_issues_from_cache(
        self,
        status: str | None = None,
        company: str | None = None,
        search: str | None = None,
        assignee: str | None = None,
        issue_id: int | None = None,
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
        if assignee:
            if assignee == "__none__":
                stmt = stmt.where(IssueCache.assignee_name.is_(None))
            else:
                stmt = stmt.where(IssueCache.assignee_name.ilike(f"%{assignee}%"))
        if issue_id:
            stmt = stmt.where(IssueCache.external_id == issue_id)

        col = getattr(IssueCache, sort, IssueCache.created_at)
        stmt = stmt.order_by(col.desc() if order == "desc" else col.asc())

        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def get_issue_with_analysis(self, issue_id: int) -> dict[str, Any] | None:
        """Return IssueCache row plus its latest AnalysisCache entry.

        If assignee_name is missing, fetch it from Okdesk and persist lazily.
        """
        result = await self.db.execute(
            select(IssueCache).where(IssueCache.id == issue_id)
        )
        row = result.scalar_one_or_none()
        if not row:
            return None

        # Lazy-fetch assignee from Okdesk if not cached yet
        if row.assignee_name is None:
            try:
                detail = await self.okdesk.get_issue(row.external_id)
                assignee = getattr(detail, "assignee", None)
                if assignee and hasattr(assignee, "name"):
                    row.assignee_name = assignee.name
                if row.assignee_name:
                    self.db.add(row)
                    await self.db.commit()
            except Exception:
                log.warning("assignee_fetch_failed", issue_id=issue_id)

        analysis_result = await self.db.execute(
            select(AnalysisCache)
            .where(AnalysisCache.issue_id == issue_id)
            .order_by(AnalysisCache.created_at.desc())
            .limit(1)
        )
        latest = analysis_result.scalar_one_or_none()

        return {"issue": row, "latest_analysis": latest}

    async def assign_issue(self, issue_id: int, assignee_id: int) -> IssueCache | None:
        """Assign issue to employee in Okdesk and update local cache."""
        result = await self.db.execute(
            select(IssueCache).where(IssueCache.id == issue_id)
        )
        row = result.scalar_one_or_none()
        if not row:
            return None
        updated = await self.okdesk.assign_issue(row.external_id, assignee_id)
        if updated.assignee and updated.assignee.name:
            row.assignee_name = updated.assignee.name
            self.db.add(row)
            await self.db.commit()
        return row

    async def refresh_single_issue(self, issue_id: int, external_id: int) -> None:
        """Update the cached status and assignee for a single issue after a status change."""
        try:
            detail = await self.okdesk.get_issue(external_id)
            result = await self.db.execute(
                select(IssueCache).where(IssueCache.id == issue_id)
            )
            row = result.scalar_one_or_none()
            if row:
                row.status = detail.status.code if detail.status else row.status
                if detail.assignee and detail.assignee.name:
                    row.assignee_name = detail.assignee.name
                row.updated_at = _parse_dt(detail.updated_at)
                self.db.add(row)
                await self.db.commit()
        except Exception:
            log.warning("refresh_single_issue_failed", issue_id=issue_id)

    async def cache_single_issue(self, external_id: int) -> None:
        """Fetch a newly created Okdesk issue and upsert it into issue_cache.

        Used right after create_child_issue so openExternal can find it immediately.
        """
        try:
            issue = await self.okdesk.get_issue(external_id)
            company_map = await self._load_company_map()
            object_map = await self._load_object_map()
            row = await self._get_or_create_issue_cache(external_id)
            row.subject = issue.title
            row.description = issue.description
            row.status = issue.status.code if issue.status else None
            row.priority = issue.priority.code if issue.priority else None
            row.company_id = company_map.get(issue.company.id) if issue.company else None
            row.company_name = issue.company.name if issue.company else None
            row.object_id = object_map.get(issue.service_object.id) if issue.service_object else None
            row.contact_name = issue.contact.name if issue.contact else None
            if issue.assignee and issue.assignee.name:
                row.assignee_name = issue.assignee.name
            row.created_at = _parse_dt(issue.created_at)
            row.updated_at = _parse_dt(issue.updated_at)
            row.synced_at = datetime.utcnow()
            self.db.add(row)
            await self.db.commit()
            log.info("child_issue_cached", external_id=external_id)
        except Exception:
            log.warning("cache_single_issue_failed", external_id=external_id)

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

    async def save_result_cache(self, external_id: int, kind: str, result_json: str) -> None:
        """Upsert a cached analysis result for (issue, kind)."""
        existing = await self.db.execute(
            select(ResultCache).where(
                ResultCache.issue_external_id == external_id, ResultCache.kind == kind
            )
        )
        row = existing.scalar_one_or_none()
        if row:
            row.result_json = result_json
        else:
            self.db.add(ResultCache(issue_external_id=external_id, kind=kind, result_json=result_json))
        await self.db.commit()

    async def get_result_cache(self, external_id: int, kind: str) -> dict[str, Any] | None:
        import json as _json
        res = await self.db.execute(
            select(ResultCache).where(
                ResultCache.issue_external_id == external_id, ResultCache.kind == kind
            )
        )
        row = res.scalar_one_or_none()
        if not row:
            return None
        try:
            data = _json.loads(row.result_json)
        except (ValueError, TypeError):
            return None
        return {"data": data, "created_at": row.created_at.isoformat()}

    async def save_training_sample(
        self, issue_external_id: int, payload: dict[str, Any],
        ai_category: str | None = None, ai_was_used: bool = False,
    ) -> None:
        """Persist an operator decision + telemetry as a future training example."""
        row = TrainingSample(
            issue_external_id=issue_external_id,
            issue_title=payload.get("issue_title"),
            issue_description=payload.get("issue_description"),
            plate=payload.get("plate"),
            fault_date=payload.get("fault_date"),
            mileage_sheet_km=payload.get("mileage_sheet_km"),
            mileage_system_km=payload.get("mileage_system_km"),
            telemetry_json=payload.get("telemetry_json"),
            ai_category=ai_category,
            ai_was_used=1 if ai_was_used else 0,
            operator_answer=payload.get("operator_answer"),
            final_status=payload.get("final_status"),
        )
        self.db.add(row)
        await self.db.commit()

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
