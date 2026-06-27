"""CacheService: sync Okdesk issues into SQLite and serve dashboard queries."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta
from typing import Any

import structlog
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db.models import AnalysisCache, IssueCache, Object, Company, TrainingSample, ResultCache, AiFeedback
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
            row.deadline_at = _parse_dt(getattr(issue, "deadline_at", None))
            row.synced_at = synced_at
            self.db.add(row)
            count += 1

        await self.db.commit()
        log.info("issue_cache_refreshed", count=count)

        # Авто-чистка «призраков»: активные заявки, которых больше нет в Okdesk
        # (слиты/удалены) — иначе висят open навсегда (синк только upsert).
        await self._cleanup_merged_ghosts(set(by_id.keys()))

        # Batch-sync assignees for active issues (opened/wait/delayed)
        await self._sync_assignees_for_active()

        return count

    # Активные статусы (заявка «в работе», не финальная)
    _ACTIVE_STATUSES = ("opened", "wait", "delayed", "no_time")

    async def _cleanup_merged_ghosts(self, seen_ids: set[int]) -> int:
        """Заявки в активном статусе, которых НЕ было в свежей выгрузке Okdesk,
        проверяем поштучно через issue_exists. Слитая/удалённая заявка отдаёт
        {"errors": ...} (HTTP 200) либо 404 → закрываем локально (status='closed').
        При неопределённом ответе (сеть/5xx) не трогаем — попробуем в след. синк.
        """
        result = await self.db.execute(
            select(IssueCache)
            .where(IssueCache.status.in_(self._ACTIVE_STATUSES))
            .where(IssueCache.external_id.notin_(seen_ids))
            .order_by(IssueCache.updated_at.desc())
            .limit(300)
        )
        rows = list(result.scalars().all())
        if not rows:
            return 0
        closed = 0
        for row in rows:
            exists = await self.okdesk.issue_exists(row.external_id)
            if exists is False:  # слита/удалена в Okdesk
                row.status = "closed"
                self.db.add(row)
                closed += 1
            # exists is True/None — оставляем как есть
        await self.db.commit()
        if closed:
            log.info("ghost_issues_closed", count=closed)
        return closed

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
        # Сортировка по сроку: заявки без дедлайна — всегда внизу (NULLs last),
        # чтобы «старые сверху» показывало реальные приближающиеся/просроченные.
        if sort == "deadline_at":
            stmt = stmt.order_by(IssueCache.deadline_at.is_(None),
                                 col.desc() if order == "desc" else col.asc())
        else:
            stmt = stmt.order_by(col.desc() if order == "desc" else col.asc())

        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def issues_due_soon(self, within_hours: int = 24) -> list[dict[str, Any]]:
        """Активные заявки с приближающимся/просроченным сроком (для уведомлений).

        deadline_at хранится как МСК-wall-clock (naive); сравниваем с МСК-now."""
        now_msk = datetime.utcnow() + timedelta(hours=3)
        horizon = now_msk + timedelta(hours=within_hours)
        floor = now_msk - timedelta(days=30)  # не алертить совсем древние просрочки
        stmt = (
            select(IssueCache)
            .where(IssueCache.deadline_at.isnot(None))
            .where(IssueCache.deadline_at <= horizon)
            .where(IssueCache.deadline_at >= floor)
            .where(IssueCache.status.in_(self._ACTIVE_STATUSES))
            .order_by(IssueCache.deadline_at.asc())
        )
        rows = list((await self.db.execute(stmt)).scalars().all())
        out: list[dict[str, Any]] = []
        for r in rows:
            dl = r.deadline_at
            out.append({
                "external_id": r.external_id,
                "subject": r.subject or "",
                "deadline": dl.strftime("%d.%m %H:%M") if dl else "",
                "overdue": bool(dl and dl < now_msk),
            })
        return out

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
            row.deadline_at = _parse_dt(getattr(issue, "deadline_at", None))
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

    async def delete_result_cache(self, external_id: int, kind: str | None = None) -> None:
        """Инвалидация кэша анализа (1.4): после нового комментария/решения старый
        результат может устареть — удаляем, чтобы следующий анализ был свежим."""
        stmt = delete(ResultCache).where(ResultCache.issue_external_id == external_id)
        if kind:
            stmt = stmt.where(ResultCache.kind == kind)
        try:
            await self.db.execute(stmt)
            await self.db.commit()
        except Exception:
            log.warning("delete_result_cache_failed", external_id=external_id, kind=kind)
            try:
                await self.db.rollback()
            except Exception:
                pass

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

    async def save_ai_feedback(self, external_id: int, rating: str,
                               error_kind: str | None = None, comment: str | None = None,
                               ai_category: str | None = None,
                               correct_category: str | None = None,
                               created_by: str | None = None) -> dict[str, Any]:
        """Сохранить оценку оператора качества ИИ-разбора (новая запись на каждую оценку)."""
        row = AiFeedback(
            issue_external_id=external_id, rating=rating, error_kind=error_kind,
            comment=comment, ai_category=ai_category, correct_category=correct_category,
            created_by=created_by,
        )
        self.db.add(row)
        await self.db.commit()
        return {"id": row.id, "rating": rating}

    async def get_latest_ai_feedback(self, external_id: int) -> dict[str, Any] | None:
        res = await self.db.execute(
            select(AiFeedback).where(AiFeedback.issue_external_id == external_id)
            .order_by(AiFeedback.created_at.desc())
        )
        row = res.scalars().first()
        if not row:
            return None
        return {
            "rating": row.rating, "error_kind": row.error_kind, "comment": row.comment,
            "ai_category": row.ai_category, "correct_category": row.correct_category,
            "created_by": row.created_by, "created_at": row.created_at.isoformat(),
        }

    async def list_ai_feedback(self, rating: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        """Список оценок (для экрана «хорошо разобрано / с ошибками»), новые сверху."""
        stmt = select(AiFeedback).order_by(AiFeedback.created_at.desc()).limit(limit)
        if rating in ("good", "bad"):
            stmt = stmt.where(AiFeedback.rating == rating)
        rows = list((await self.db.execute(stmt)).scalars().all())
        return [{
            "issue_external_id": r.issue_external_id, "rating": r.rating,
            "error_kind": r.error_kind, "comment": r.comment, "ai_category": r.ai_category,
            "correct_category": r.correct_category, "created_by": r.created_by,
            "created_at": r.created_at.isoformat(),
        } for r in rows]

    async def find_similar_resolved(
        self,
        *,
        category: str | None,
        plate: str | None,
        flags: list[str],
        sender: dict[str, Any] | None = None,
        limit: int = 3,
    ) -> list[dict[str, Any]]:
        """Retrieve similar past RESOLVED cases for few-shot prompting.

        Reads :class:`TrainingSample` rows with a non-empty operator answer and a
        final status in (completed, closed), scores each by structural similarity
        to the current issue, and returns the top ``limit`` as compact dicts:
        ``{plate, fault_date, category, answer, flags}``.

        Scoring (deterministic):
          +3 same ai_category
          +2 same region (last 2-3 digits of plate match)
          +1 per shared telemetry flag (parsed safely from telemetry_json)
          +1 same sender company (if available)
        Ties broken by most recent created_at. Never raises on garbage data.
        """
        import json as _json

        try:
            result = await self.db.execute(
                select(TrainingSample)
                .where(TrainingSample.operator_answer.isnot(None))
                .where(TrainingSample.operator_answer != "")
                .where(TrainingSample.final_status.in_(("completed", "closed")))
                .order_by(TrainingSample.created_at.desc())
                .limit(400)
            )
            rows = list(result.scalars().all())
        except Exception:
            log.warning("find_similar_resolved_query_failed")
            return []

        def _region(p: str | None) -> str | None:
            if not p:
                return None
            m = re.search(r"(\d{2,3})$", p.strip())
            return m.group(1) if m else None

        cur_region = _region(plate)
        cur_company = (sender or {}).get("компания") or (sender or {}).get("company")
        cur_flags = set(flags or [])

        scored: list[tuple[int, datetime, dict[str, Any]]] = []
        for row in rows:
            score = 0
            if category and row.ai_category and row.ai_category == category:
                score += 3
            r_region = _region(row.plate)
            if cur_region and r_region and cur_region == r_region:
                score += 2
            row_flags: list[str] = []
            if row.telemetry_json:
                try:
                    data = _json.loads(row.telemetry_json)
                    raw_flags = data.get("flags") if isinstance(data, dict) else None
                    if isinstance(raw_flags, list):
                        row_flags = [str(x) for x in raw_flags]
                except (ValueError, TypeError):
                    row_flags = []
            score += len(cur_flags.intersection(row_flags))
            if cur_company and row.issue_title and cur_company.lower() in (row.issue_title or "").lower():
                score += 1
            if score <= 0:
                continue
            scored.append((
                score,
                row.created_at or datetime.min,
                {
                    "plate": row.plate,
                    "fault_date": row.fault_date,
                    "category": row.ai_category,
                    "answer": row.operator_answer,
                    "flags": row_flags,
                },
            ))

        scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
        return [item for _, _, item in scored[:limit]]

    async def prior_answers_for_plates(self, plates: list[str]) -> dict[str, dict]:
        """For each plate, find the most recent RESOLVED TrainingSample with a
        non-empty operator answer and return what was previously told to the
        client for that exact vehicle.

        Returns ``{normalized_plate: {category, answer, fault_date}}`` only for
        plates that have a prior answer. Best-effort — never raises; on a query
        failure returns whatever was gathered so far (possibly empty).
        """
        def _norm(p: str | None) -> str | None:
            if not p:
                return None
            n = re.sub(r"[\s\-]", "", str(p)).upper()
            return n or None

        wanted = {n for n in (_norm(p) for p in (plates or [])) if n}
        if not wanted:
            return {}

        out: dict[str, dict] = {}
        try:
            result = await self.db.execute(
                select(TrainingSample)
                .where(TrainingSample.plate.isnot(None))
                .where(TrainingSample.operator_answer.isnot(None))
                .where(TrainingSample.operator_answer != "")
                .where(TrainingSample.final_status.in_(("completed", "closed")))
                .order_by(TrainingSample.created_at.desc())
            )
            rows = list(result.scalars().all())
        except Exception:
            log.warning("prior_answers_for_plates_query_failed")
            return out

        # rows are newest-first; first hit per normalized plate wins.
        for row in rows:
            norm = _norm(row.plate)
            if not norm or norm not in wanted or norm in out:
                continue
            out[norm] = {
                "category": row.ai_category,
                "answer": row.operator_answer,
                "fault_date": row.fault_date,
            }
            if len(out) == len(wanted):
                break
        return out

    async def save_training_sample(
        self, issue_external_id: int, payload: dict[str, Any],
        ai_category: str | None = None, ai_was_used: bool = False,
    ) -> None:
        """Persist an operator decision + telemetry as a future training example.

        Upsert by issue: one sample per ``issue_external_id`` (re-resolving or
        backfilling the same issue replaces the old sample, no duplicates)."""
        await self.db.execute(
            delete(TrainingSample).where(TrainingSample.issue_external_id == issue_external_id)
        )
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

    async def existing_training_sample_ids(self) -> set[int]:
        """External ids that already have a training sample (for backfill dedup)."""
        try:
            result = await self.db.execute(select(TrainingSample.issue_external_id))
            return {row[0] for row in result.all() if row[0] is not None}
        except Exception:
            log.warning("existing_training_sample_ids_failed")
            return set()

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
