"""Dashboard endpoints for browsing and analysing Okdesk issues."""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.v1.schemas.issues import (
    AnalysisInput,
    AnalysisResult,
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


@router.get("", response_model=PaginatedIssuesResponse)
async def list_issues(
    status: str | None = Query(None, description="Filter by status code"),
    company: str | None = Query(None, description="Filter by company name (partial)"),
    search: str | None = Query(None, description="Search in subject"),
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    sort: str = Query("created_at"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    cache: CacheService = Depends(get_cache_service),
) -> PaginatedIssuesResponse:
    """Return a paginated list of cached issues with optional filters."""
    try:
        issues = await cache.get_issues_from_cache(
            status=status, company=company, search=search, sort=sort, order=order
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
        result = await automation.automate(
            live.title,
            live.description,
            params,
            issue_type=live.type.name if live.type else None,
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

        return automation.to_dict(result)
    except HTTPException:
        raise
    except Exception:
        log.exception("automate_issue_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Automation failed")


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
