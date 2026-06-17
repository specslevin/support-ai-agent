"""Dashboard endpoints for browsing and analysing Okdesk issues."""

from __future__ import annotations

import json
import urllib.parse

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.services import attachment_reader

from app.api.v1.schemas.issues import (
    AnalysisInput,
    AnalysisResult,
    BulkAssignee,
    BulkStatus,
    BulkType,
    CreateChildren,
    IssueResponse,
    PaginatedIssuesResponse,
)
from app.core.dependencies import (
    get_cache_service,
    get_issue_automation_service,
    get_okdesk_service,
)
from app.core.okdesk.models import Employee
from app.core.okdesk.service import OkdeskService
from app.core.services.cache_service import CacheService
from app.services.issue_automation import IssueAutomationService

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/issues", tags=["dashboard:issues"])


def _is_aggregate(company_name: str | None, description: str | None,
                  objects: list[dict[str, object]]) -> bool:
    """Aggregate (ОДКР) issue — answer once, do NOT split into children.

    TRUE if the company is ОДКР, OR the issue body is empty AND there are
    >= 5 distinct plates across attachments.
    """
    if company_name and "одкр" in company_name.lower():
        return True
    body = (description or "").strip()
    if not body:
        plates = {o.get("plate") for o in objects if o.get("plate")}
        if len(plates) >= 5:
            return True
    return False


@router.get("", response_model=PaginatedIssuesResponse)
async def list_issues(
    status: str | None = Query(None, description="Filter by status code"),
    company: str | None = Query(None, description="Filter by company name (partial)"),
    search: str | None = Query(None, description="Search in subject"),
    assignee: str | None = Query(None, description="Filter by assignee name, or '__none__' for unassigned"),
    issue_id: int | None = Query(None, description="Exact Okdesk issue number (external_id)"),
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    sort: str = Query("created_at"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    cache: CacheService = Depends(get_cache_service),
) -> PaginatedIssuesResponse:
    """Return a paginated list of cached issues with optional filters."""
    try:
        issues = await cache.get_issues_from_cache(
            status=status, company=company, search=search,
            assignee=assignee, issue_id=issue_id, sort=sort, order=order,
        )
        total = len(issues)
        start = (page - 1) * limit
        page_items = issues[start : start + limit]
        return PaginatedIssuesResponse(
            data=[IssueResponse.from_orm_row(i) for i in page_items],
            pagination={
                "page": page,
                "limit": limit,
                "total": total,
                "total_pages": max(1, (total + limit - 1) // limit),
            },
        )
    except Exception:
        log.exception("list_issues_failed")
        raise HTTPException(status_code=500, detail="Failed to list issues")


@router.get("/cache/refresh")
async def refresh_cache(
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Force-sync the issue cache from Okdesk REST API."""
    try:
        count = await cache.refresh_issue_cache()
        return {"ok": True, "synced": count}
    except Exception:
        log.exception("refresh_cache_failed")
        raise HTTPException(status_code=500, detail="Cache refresh failed")


async def _external_id(cache: CacheService, issue_id: int) -> int | None:
    data = await cache.get_issue_with_analysis(issue_id)
    return data["issue"].external_id if data else None


@router.post("/bulk/assignee")
async def bulk_assign(
    body: BulkAssignee,
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Assign many issues to one employee."""
    results = []
    for iid in body.issue_ids:
        try:
            row = await cache.assign_issue(iid, body.assignee_id)
            results.append({"issue_id": iid, "ok": bool(row)})
        except Exception:
            log.warning("bulk_assign_item_failed", issue_id=iid)
            results.append({"issue_id": iid, "ok": False})
    ok = sum(1 for r in results if r["ok"])
    return {"ok": True, "succeeded": ok, "failed": len(results) - ok, "results": results}


@router.post("/bulk/type")
async def bulk_change_type(
    body: BulkType,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> dict[str, object]:
    """Change the type of many issues."""
    results = []
    for iid in body.issue_ids:
        try:
            ext = await _external_id(cache, iid)
            if ext is None:
                results.append({"issue_id": iid, "ok": False})
                continue
            await okdesk.change_issue_type(ext, body.type_code)
            results.append({"issue_id": iid, "ok": True})
        except Exception:
            log.warning("bulk_type_item_failed", issue_id=iid)
            results.append({"issue_id": iid, "ok": False})
    ok = sum(1 for r in results if r["ok"])
    return {"ok": True, "succeeded": ok, "failed": len(results) - ok, "results": results}


@router.post("/bulk/status")
async def bulk_change_status(
    body: BulkStatus,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> dict[str, object]:
    """Change status (with optional comment) for many issues."""
    if body.status_code == "delayed" and not body.delay_to:
        raise HTTPException(status_code=400, detail="delay_to is required for status 'delayed'")
    results = []
    for iid in body.issue_ids:
        try:
            ext = await _external_id(cache, iid)
            if ext is None:
                results.append({"issue_id": iid, "ok": False})
                continue
            res = await okdesk.change_issue_status(
                ext, body.status_code,
                comment=body.comment, comment_public=body.comment_public,
                delay_to=body.delay_to,
            )
            await cache.refresh_single_issue(iid, ext)
            results.append({"issue_id": iid, "ok": res.get("code") == body.status_code})
        except Exception:
            log.warning("bulk_status_item_failed", issue_id=iid)
            results.append({"issue_id": iid, "ok": False})
    ok = sum(1 for r in results if r["ok"])
    return {"ok": True, "succeeded": ok, "failed": len(results) - ok, "results": results}


import re as _re


def _looks_like_phone(value: str) -> bool:
    return len(_re.sub(r"\D", "", value)) >= 7


def _format_param(p: object) -> str | None:
    from app.core.okdesk.models import IssueParameter
    param: IssueParameter = p  # type: ignore[assignment]
    if not param.value:
        return None
    if param.field_type == "ftcheckbox":
        return "Да" if param.value == "1" else None
    # tel_person must look like a real phone number
    if param.code == "tel_person" and not _looks_like_phone(param.value):
        return None
    # Skip other obviously garbage short values
    if len(param.value.strip()) < 3:
        return None
    return param.value


def _extract_phone_from_contact(contact_value: str | None) -> str | None:
    """Extract phone number from 'Иванов И.И. тел. 89001234567' style strings."""
    if not contact_value:
        return None
    m = _re.search(r"(?:тел\.?\s*)?([\d\s\-\+\(\)]{7,})", contact_value)
    if m:
        phone = _re.sub(r"\s+", " ", m.group(1).strip())
        if len(_re.sub(r"\D", "", phone)) >= 7:
            return phone
    return None


def _build_parameters(params: list) -> list[dict[str, str]]:
    from app.core.okdesk.models import IssueParameter
    result: list[dict[str, str]] = []
    contact_value: str | None = None
    tel_shown = False

    for p in params:
        if p.code == "contact_person":
            contact_value = p.value

    for p in params:
        formatted = _format_param(p)
        if formatted is not None:
            result.append({"name": p.name, "value": formatted})
            if p.code == "tel_person":
                tel_shown = True

    # If tel_person was absent or garbage, try to extract phone from contact_person
    if not tel_shown and contact_value:
        phone = _extract_phone_from_contact(contact_value)
        if phone:
            result.append({"name": "Номер телефона", "value": phone})

    return result


_SOURCE_LABELS: dict[str, str] = {
    "from_email": "Email",
    "from_operator": "Оператор",
    "from_client": "Клиент (портал)",
    "from_telegram": "Telegram",
    "from_api": "API",
    "from_phone": "Телефон",
}


@router.get("/{issue_id}")
async def get_issue_details(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> dict[str, object]:
    """Return full issue details plus latest analysis and live Okdesk fields."""
    try:
        data = await cache.get_issue_with_analysis(issue_id)
        if not data:
            raise HTTPException(status_code=404, detail="Issue not found")
        row = data["issue"]
        latest = data["latest_analysis"]

        # Fetch live detail from Okdesk for fields not stored in cache
        okdesk_detail: dict[str, object] = {}
        try:
            live = await okdesk.get_issue(row.external_id)
            okdesk_detail = {
                "description": live.description,
                "source": _SOURCE_LABELS.get(live.source or "", live.source),
                "deadline_at": live.deadline_at,
                "completed_at": live.completed_at,
                "planned_reaction_at": live.planned_reaction_at,
                "reacted_at": live.reacted_at,
                "delayed_to": live.delayed_to,
                "spent_time_total": live.spent_time_total,
                "type_name": live.type.name if live.type else None,
                "type_code": live.type.code if live.type else None,
                "author_name": live.author.name if live.author else None,
                "service_object_name": live.service_object.name if live.service_object else None,
                "parent_id": live.parent_id,
                "child_ids": live.child_ids,
                "parameters": _build_parameters(live.parameters),
            }
        except Exception:
            log.warning("okdesk_detail_fetch_failed", issue_id=issue_id)

        return {
            "issue": IssueResponse.from_orm_row(row).model_dump(),
            "okdesk_detail": okdesk_detail,
            "latest_analysis": (
                {
                    "id": latest.id,
                    "mileage_from_sheet": latest.mileage_from_sheet,
                    "mileage_from_system": latest.mileage_from_system,
                    "discrepancy_percent": latest.discrepancy_percent,
                    "ai_suggestion": latest.ai_suggestion,
                    "recommendation": latest.recommendation,
                    "created_at": latest.created_at.isoformat(),
                }
                if latest
                else None
            ),
        }
    except HTTPException:
        raise
    except Exception:
        log.exception("get_issue_details_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to fetch issue")


@router.post("/{issue_id}/automate")
async def automate_issue(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Analyse a mileage-discrepancy issue and draft an answer for operator review.

    Reads the live Okdesk issue, pulls real telemetry from geo.gpspos.ru,
    classifies the cause and returns a draft answer (nothing is sent automatically).
    """
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        live = await okdesk.get_issue(external_id)
        params = _build_parameters(live.parameters)
        attachments_text = ""
        if live.attachments:
            attachments_text = await automation.read_attachments(external_id, live.attachments)
        # Отправитель: даёт LLM контекст формата письма (разные дочерние Россети
        # оформляют акты по-разному).
        cached_issue = issue_data["issue"]
        sender = {
            k: v for k, v in {
                "компания": getattr(cached_issue, "company_name", None),
                "контакт": getattr(cached_issue, "contact_name", None),
                "источник": getattr(live, "source", None),
            }.items() if v
        } or None
        # RAG: provide similar past resolved cases as few-shot examples. The
        # callback runs inside automate() once the heuristic category is known,
        # so retrieval is category-aware. Failures are swallowed inside automate.
        async def _example_provider(
            category: str, plate: str | None, flags: list[str]
        ) -> list[dict[str, object]]:
            return await cache.find_similar_resolved(
                category=category, plate=plate, flags=flags, sender=sender, limit=3,
            )

        result = await automation.automate(
            live.title,
            live.description,
            params,
            issue_type=live.type.name if live.type else None,
            attachments_text=attachments_text or None,
            sender=sender,
            example_provider=_example_provider,
        )

        # Persist the analysis so the dashboard can show it later.
        try:
            await cache.save_analysis(
                issue_id=issue_id,
                mileage_sheet=result.parsed.sheet_mileage_km or 0.0,
                ai_suggestion=result.draft_answer,
                recommendation=result.category,
                notes=result.reasoning,
                mileage_system=result.telemetry.system_mileage_km,
            )
        except Exception:
            log.warning("automate_save_analysis_failed", issue_id=issue_id)

        result_dict = automation.to_dict(result)
        try:
            await cache.save_result_cache(external_id, "automate", json.dumps(result_dict, ensure_ascii=False))
        except Exception:
            log.warning("automate_cache_save_failed", issue_id=issue_id)
        return result_dict
    except HTTPException:
        raise
    except Exception:
        log.exception("automate_issue_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Automation failed")


@router.get("/{issue_id}/automate")
async def get_cached_automate(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Return the last cached automate result (no AI re-run, no token spend)."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        cached = await cache.get_result_cache(external_id, "automate")
        if not cached:
            return {"cached": False}
        return {"cached": True, "created_at": cached["created_at"], **cached["data"]}
    except HTTPException:
        raise
    except Exception:
        log.exception("get_cached_automate_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to read cached analysis")


@router.get("/{issue_id}/attachments")
async def list_issue_attachments(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> list[dict[str, object]]:
    """List attachments of an issue with type/extractable flags."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        live = await okdesk.get_issue(external_id)
        return [
            {
                "id": a.id,
                "name": a.attachment_file_name,
                "size": a.attachment_file_size,
                "is_public": a.is_public,
                "kind": attachment_reader.kind(a.attachment_file_name or ""),
                "extractable": attachment_reader.is_extractable(a.attachment_file_name or ""),
            }
            for a in live.attachments
        ]
    except HTTPException:
        raise
    except Exception:
        log.exception("list_attachments_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to list attachments")


@router.get("/{issue_id}/attachments/{attachment_id}/download")
async def download_issue_attachment(
    issue_id: int,
    attachment_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> Response:
    """Proxy-download an attachment (so the token/presigned URL stays server-side)."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        live = await okdesk.get_issue(external_id)
        meta = next((a for a in live.attachments if a.id == attachment_id), None)
        result = await okdesk.download_attachment(external_id, attachment_id)
        if not result:
            raise HTTPException(status_code=404, detail="Attachment not available")
        data, content_type = result
        name = (meta.attachment_file_name if meta else None) or f"attachment_{attachment_id}"
        quoted = urllib.parse.quote(name)
        return Response(
            content=data,
            media_type=content_type,
            headers={"Content-Disposition": f"inline; filename*=UTF-8''{quoted}"},
        )
    except HTTPException:
        raise
    except Exception:
        log.exception("download_attachment_failed", issue_id=issue_id, attachment_id=attachment_id)
        raise HTTPException(status_code=500, detail="Failed to download attachment")


@router.post("/{issue_id}/automate_batch")
async def automate_batch(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Per-object analysis for «общая» issues with many attachments (one act per ТС)."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        live = await okdesk.get_issue(external_id)
        objects = await automation.analyze_batch(external_id, live.attachments)
        jamming = sum(1 for o in objects if o.get("verdict") == "Глушение")
        ok_data = sum(1 for o in objects if o.get("verdict") == "Данные верны")
        company_name = getattr(issue_data["issue"], "company_name", None)
        payload = {
            "total": len(objects),
            "jamming_count": jamming,
            "ok_count": ok_data,
            "is_aggregate": _is_aggregate(company_name, live.description, objects),
            "objects": objects,
        }
        try:
            await cache.save_result_cache(external_id, "batch", json.dumps(payload, ensure_ascii=False))
        except Exception:
            log.warning("batch_cache_save_failed", issue_id=issue_id)
        return payload
    except HTTPException:
        raise
    except Exception:
        log.exception("automate_batch_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Batch analysis failed")


@router.get("/{issue_id}/automate_batch")
async def get_cached_batch(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Return the last cached batch result (no re-run)."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        cached = await cache.get_result_cache(external_id, "batch")
        if not cached:
            return {"cached": False}
        return {"cached": True, "created_at": cached["created_at"], **cached["data"]}
    except HTTPException:
        raise
    except Exception:
        log.exception("get_cached_batch_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to read cached batch")


@router.post("/{issue_id}/compose_answer")
async def compose_answer(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Compose ONE comprehensive answer for an aggregate (ОДКР) issue.

    Loads the cached batch result (or runs analyze_batch if absent), then asks
    the LLM to summarise all objects grouped by verdict into a single answer.
    """
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        company_name = getattr(issue_data["issue"], "company_name", None)

        cached = await cache.get_result_cache(external_id, "batch")
        if cached and cached.get("data", {}).get("objects"):
            objects = cached["data"]["objects"]
        else:
            live = await okdesk.get_issue(external_id)
            objects = await automation.analyze_batch(external_id, live.attachments)

        # Best-effort: surface prior resolved answers for the same vehicles so
        # the aggregate stays consistent with what the client was told before.
        prior: dict[str, dict] = {}
        try:
            plates = [str(o.get("plate")) for o in objects if o.get("plate")]
            if plates:
                prior = await cache.prior_answers_for_plates(plates)
        except Exception:
            log.warning("compose_answer_prior_lookup_failed", issue_id=issue_id)
            prior = {}

        answer = await automation.compose_aggregate_answer(objects, company_name, prior=prior)
        return {"answer": answer, "linked_count": len(prior)}
    except HTTPException:
        raise
    except Exception:
        log.exception("compose_answer_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to compose answer")


@router.post("/{issue_id}/create_children")
async def create_children(
    issue_id: int,
    body: CreateChildren,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> dict[str, object]:
    """Create child («вложенные») issues under a batch issue — one per object."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        parent = await okdesk.get_issue(external_id)
        contact_id = parent.contact.id if parent.contact else None

        created = []
        for obj in body.objects:
            title = obj.plate
            # Use DD.MM.YYYY + explicit «Дата неисправности» marker so the child
            # issue's own automate can parse the date back (ISO wasn't readable).
            date_ru = "—"
            if obj.date:
                try:
                    import datetime as _d
                    date_ru = _d.date.fromisoformat(obj.date).strftime("%d.%m.%Y")
                except ValueError:
                    date_ru = obj.date
            if obj.verdict == "Нет данных":
                desc = (
                    f"Расхождение пробега. Дата неисправности: {date_ru}. "
                    f"Нет данных от терминала за дату — требуется удалённая диагностика. "
                    f"(создано из общей заявки #{external_id})"
                )
            else:
                desc = (
                    f"Расхождение пробега. Дата неисправности: {date_ru}. "
                    f"По системе {obj.system_mileage_km if obj.system_mileage_km is not None else '—'} км, "
                    f"путевой лист {obj.sheet_mileage_km if obj.sheet_mileage_km is not None else '—'} км. "
                    f"(создано из общей заявки #{external_id})"
                )
            try:
                child = await okdesk.create_child_issue(
                    external_id, title, desc, address=obj.address, contact_id=contact_id,
                )
                created.append({"plate": obj.plate, "issue_id": child.id, "ok": True})
                # Immediately cache the child so openExternal can find it without a full refresh
                await cache.cache_single_issue(child.id)
            except Exception:
                log.warning("create_child_failed", plate=obj.plate)
                created.append({"plate": obj.plate, "ok": False})
        ok = sum(1 for c in created if c["ok"])
        return {"ok": True, "created": ok, "failed": len(created) - ok, "results": created}
    except HTTPException:
        raise
    except Exception:
        log.exception("create_children_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to create child issues")


@router.get("/{issue_id}/track")
async def get_issue_track(
    issue_id: int,
    plate: str | None = Query(None, description="Override plate (per-object track from batch)"),
    date: str | None = Query(None, description="Override fault date YYYY-MM-DD"),
    date_from: str | None = Query(None, description="Interval start YYYY-MM-DD"),
    date_to: str | None = Query(None, description="Interval end YYYY-MM-DD"),
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Return GPS track + telemetry series (speed/voltage/satellites) for charts and map."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        # Per-object track (from batch разбор) — skip attachment OCR, use plate/date directly.
        if plate and date:
            return await automation.build_track("", "", plate=plate, fault_date=date,
                                                date_from=date_from, date_to=date_to)
        live = await okdesk.get_issue(external_id)
        attachments_text = ""
        if live.attachments:
            attachments_text = await automation.read_attachments(external_id, live.attachments)
        return await automation.build_track(
            live.title, live.description, attachments_text=attachments_text or None,
            date_from=date_from, date_to=date_to,
        )
    except HTTPException:
        raise
    except Exception:
        log.exception("get_issue_track_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to build track")


@router.post("/{issue_id}/analysis", response_model=AnalysisResult)
async def submit_analysis(
    issue_id: int,
    data: AnalysisInput,
    cache: CacheService = Depends(get_cache_service),
) -> AnalysisResult:
    """Save a mileage analysis for an issue (AI suggestion deferred to Phase 2)."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")

        saved = await cache.save_analysis(
            issue_id=issue_id,
            mileage_sheet=data.mileage_from_sheet,
            ai_suggestion="",
            recommendation="review",
            notes=data.notes,
        )
        return AnalysisResult(
            analysis_id=str(saved.id),
            mileage_from_sheet=saved.mileage_from_sheet or 0.0,
            mileage_from_system=saved.mileage_from_system,
            discrepancy_percent=saved.discrepancy_percent,
            ai_suggestion=saved.ai_suggestion or "",
            recommendation=saved.recommendation,
            created_at=saved.created_at.isoformat(),
        )
    except HTTPException:
        raise
    except Exception:
        log.exception("submit_analysis_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to save analysis")


@router.get("/{issue_id}/comments")
async def get_issue_comments(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> list[dict[str, object]]:
    """Fetch comments from Okdesk for a cached issue."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        comments = await okdesk.get_issue_comments(external_id)
        return [
            {
                "id": c.id,
                "author": c.author.name if c.author else "Unknown",
                "content": c.content,
                "created_at": c.created_at,
                "is_internal": c.is_internal,
            }
            for c in comments
        ]
    except HTTPException:
        raise
    except Exception:
        log.exception("get_comments_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to fetch comments")


@router.patch("/{issue_id}/type")
async def change_issue_type(
    issue_id: int,
    type_code: str = Query(..., description="Okdesk issue type code"),
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> dict[str, object]:
    """Change issue type in Okdesk."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        result = await okdesk.change_issue_type(external_id, type_code)
        return {"ok": True, "type_code": result["code"], "type_name": result["name"]}
    except HTTPException:
        raise
    except Exception:
        log.exception("change_issue_type_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to change issue type")


@router.patch("/{issue_id}/assignee")
async def assign_issue(
    issue_id: int,
    assignee_id: int = Query(..., description="Okdesk employee ID"),
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Assign issue to an employee in Okdesk and update local cache."""
    try:
        row = await cache.assign_issue(issue_id, assignee_id)
        if not row:
            raise HTTPException(status_code=404, detail="Issue not found")
        return {"ok": True, "assignee_name": row.assignee_name}
    except HTTPException:
        raise
    except Exception:
        log.exception("assign_issue_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to assign issue")


@router.post("/{issue_id}/resolve")
async def resolve_issue(
    issue_id: int,
    status_code: str = Query(..., description="Target status code: completed or delayed"),
    comment: str = Query(..., min_length=1),
    comment_public: bool = Query(True),
    delay_to: str | None = Query(None, description="Required when status_code=delayed (ISO datetime)"),
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Send a comment and change issue status in one action."""
    ALLOWED = {"completed", "delayed", "opened"}
    if status_code not in ALLOWED:
        raise HTTPException(status_code=400, detail=f"status_code must be one of {ALLOWED}")
    if status_code == "delayed" and not delay_to:
        raise HTTPException(status_code=400, detail="delay_to is required for status 'delayed'")
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id

        status_result = await okdesk.change_issue_status(external_id, status_code, comment=comment, comment_public=comment_public, delay_to=delay_to)
        status_changed = status_result.get("code") == status_code

        await cache.refresh_single_issue(issue_id, external_id)

        # Groundwork for AI training: record (telemetry → operator decision).
        # Best-effort, must never break the resolve action.
        try:
            live = await okdesk.get_issue(external_id)
            sample = await automation.build_training_sample(
                live.title, live.description, comment, status_code
            )
            if sample:
                latest = (issue_data.get("latest_analysis"))
                await cache.save_training_sample(
                    external_id, sample,
                    ai_category=getattr(latest, "recommendation", None),
                    ai_was_used=latest is not None,
                )
        except Exception:
            log.warning("training_sample_record_failed", issue_id=issue_id)

        return {
            "ok": True,
            "status_changed": status_changed,
            "status": status_result,
        }
    except HTTPException:
        raise
    except Exception:
        log.exception("resolve_issue_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to resolve issue")


@router.post("/{issue_id}/comments")
async def add_comment(
    issue_id: int,
    text: str = Query(..., min_length=1),
    is_public: bool = Query(True, description="Public comment (visible to client) or private"),
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> dict[str, object]:
    """Add a comment to an issue in Okdesk."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        result = await okdesk.add_comment(external_id, text, public=is_public)
        return {"ok": True, "result": result}
    except HTTPException:
        raise
    except Exception:
        log.exception("add_comment_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to add comment")
