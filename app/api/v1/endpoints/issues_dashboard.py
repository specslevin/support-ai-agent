"""Dashboard endpoints for browsing and analysing Okdesk issues."""

from __future__ import annotations

import json
import re
import urllib.parse

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

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
from app.core.okdesk.client import OkdeskAPIError
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


async def _build_comments_digest(external_id: int, okdesk: OkdeskService,
                                 max_chars: int = 6000) -> str:
    """Compact chronological digest of issue comments for the AI analyzer.

    Each line: «author • date • text» (html stripped). Bounded to ~max_chars.
    Best-effort: any failure returns "" so the analysis still proceeds.
    """
    from app.services.issue_automation import _strip_html

    try:
        comments = await okdesk.get_issue_comments(external_id)
    except Exception:
        log.warning("automate_comments_fetch_failed", external_id=external_id)
        return ""
    if not comments:
        return ""
    # Recover timestamps from the raw payload (the parsed model drops them, same
    # as the /comments endpoint).
    raw_dates: dict[int, str] = {}
    try:
        raw = await okdesk._client.get_issue_comments(external_id)
        raw_rows = raw if isinstance(raw, list) else (
            raw.get("data") if isinstance(raw, dict) else None)
        for r in raw_rows or []:
            if isinstance(r, dict) and r.get("id") is not None:
                ts = r.get("published_at") or r.get("created_at")
                if ts:
                    raw_dates[r["id"]] = ts
    except Exception:
        log.warning("automate_comments_meta_failed", external_id=external_id)

    rows: list[tuple[str, str]] = []
    for c in comments:
        text = _strip_html(getattr(c, "content", None))
        if not text:
            continue
        author = (c.author.name if getattr(c, "author", None) else None) or "—"
        date = (getattr(c, "created_at", None) or raw_dates.get(getattr(c, "id", None)) or "")
        date = str(date)[:16].replace("T", " ")
        rows.append((date, f"{author} • {date} • {text}"))
    if not rows:
        return ""
    # Chronological order (empty dates sort first, then ascending by timestamp).
    rows.sort(key=lambda r: r[0])
    lines = [line for _, line in rows]
    digest = "\n".join(lines)
    if len(digest) > max_chars:
        digest = digest[:max_chars].rstrip() + "…"
    return digest


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


def _short_company(company_name: str | None) -> str:
    """«ПАО "Россети Волга" Самарские РС Самарское ПО» → «Россети\\nСамарское».

    Возвращает короткую строку: бренд («Россети») + название ПО/РС/города.
    Если распарсить не удалось — отдаём company_name как есть.
    """
    if not company_name:
        return ""
    name = company_name.strip()
    # Бренд: первое вхождение «Россети» (с возможным регионом в кавычках).
    brand = "Россети" if re.search(r"россет", name, re.I) else None
    # Название ПО / РС / города — берём слово(а) перед «ПО»/«РС».
    unit: str | None = None
    m = re.search(r"([A-ZА-ЯЁ][\wа-яё-]+(?:\s+[A-ZА-ЯЁ][\wа-яё-]+)?)\s+ПО\b", name)
    if m:
        unit = m.group(1).strip()
    else:
        m = re.search(r"([A-ZА-ЯЁ][\wа-яё-]+(?:\s+[A-ZА-ЯЁ][\wа-яё-]+)?)\s+РС\b", name)
        if m:
            unit = m.group(1).strip()
    if brand and unit:
        return f"{brand}\n{unit}"
    if brand:
        return brand
    return name


def _extract_vehicle(title: str | None, description: str | None,
                     plate: str | None) -> str:
    """Строка «модель + номер» для монтажника.

    Тема заявки обычно содержит «МОДЕЛЬ НОМЕР» — берём её как основу (это самый
    надёжный человекочитаемый вид). Если темы нет — собираем из распознанного
    номера. Возвращаем пустую строку, если ничего нет."""
    t = (title or "").strip()
    if t:
        # Уберём служебные префиксы вроде «Расхождение пробега:» если есть.
        t = re.sub(r"^\s*(расхождение пробега|заявка)\s*[:\-]?\s*", "", t, flags=re.I).strip()
        if t:
            return t
    return plate or ""


def _extract_address(parameters: list, description: str | None) -> str | None:
    """Адрес/местоположение из параметров заявки; эвристика из описания опц."""
    from app.core.okdesk.models import IssueParameter

    addr_re = re.compile(r"адрес|мест[оа]|располож|локац", re.I)
    for p in parameters:
        param: IssueParameter = p  # type: ignore[assignment]
        name = f"{param.name or ''} {param.code or ''}"
        if param.value and addr_re.search(name):
            v = param.value.strip()
            if len(v) >= 3:
                return v
    # Эвристика из описания: строка после «адрес ...»/«местоположение ...».
    body = re.sub(r"<[^>]+>", " ", description or "")
    m = re.search(r"(?:адрес|местоположени\w*|мест\w*\s+техник\w*)[^\wа-яё]{0,3}([^\n]{5,120})", body, re.I)
    if m:
        return m.group(1).strip()
    return None


def _param_value(parameters: list, pattern: str) -> str | None:
    """Значение параметра заявки по совпадению имени/кода с regex. Параметры
    Okdesk у структурированных заявок содержат «Номер телефона»/«Контактное лицо»/
    «Местоположение техники» — это самый надёжный источник для монтажника (64239)."""
    rx = re.compile(pattern, re.I)
    for p in parameters or []:
        name = f"{getattr(p, 'name', '') or ''} {getattr(p, 'code', '') or ''}"
        val = getattr(p, "value", None)
        if val and str(val).strip() and rx.search(name):
            return str(val).strip()
    return None


@router.get("/{issue_id}/installer_export")
async def installer_export(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Готовые тексты «для монтажника» (КАЛЕНДАРЬ + МЕССЕНДЖЕР) для копирования.

    Read-only: собирает поля из живой заявки Okdesk, кэша (название компании) и
    контакта (телефон). Любое недостающее поле заменяется плейсхолдером — запрос
    не падает. Доступно всем авторизованным (включая demo) — это просмотр."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        cached_issue = issue_data["issue"]
        external_id = cached_issue.external_id
        live = await okdesk.get_issue(external_id)

        # Приоритет — ПАРАМЕТРЫ заявки (у структурированных заявок есть «Номер
        # телефона»/«Контактное лицо»/«Местоположение техники» — ровно то, что нужно
        # монтажнику, 64239). Фолбэк телефона — get_contact (в самой заявке его нет).
        phone = _param_value(live.parameters, r"телефон|тел\b|моб")
        contact_name = (_param_value(live.parameters, r"контактн|ответственн|контакт")
                        or (live.contact.name if live.contact else None))
        contact_id = live.contact.id if live.contact else None
        if not phone and contact_id:
            try:
                contact = await okdesk.get_contact(contact_id)
                phone = contact.mobile_phone or contact.phone
            except Exception:
                log.warning("installer_export_contact_failed", issue_id=issue_id, contact_id=contact_id)

        # Компания: в live она часто пустая — берём из кэша.
        company_name = (getattr(cached_issue, "company_name", None)
                        or (live.company.name if live.company else None))
        company_short = _short_company(company_name)

        # Номер + дата неисправности из разбора темы/описания.
        parsed = automation.parse_issue(live.title, live.description, None)
        plate = parsed.plate
        date_ru: str | None = None
        if parsed.date:
            try:
                import datetime as _d
                date_ru = _d.date.fromisoformat(parsed.date[:10]).strftime("%d.%m.%Y")
            except ValueError:
                date_ru = parsed.date

        vehicle = _extract_vehicle(live.title, live.description, plate)
        address = _extract_address(live.parameters, live.description)

        # «не в сети с ДАТА» (без даты — плейсхолдер для ручного заполнения).
        status_line = f"не в сети с {date_ru}" if date_ru else "не в сети с ____"
        # Компонент города для КАЛЕНДАРЯ: вторая строка company_short («Самарское»).
        city = company_short.split("\n", 1)[1] if "\n" in company_short else ""

        ph_phone = phone or "____"
        ph_vehicle = vehicle or "____"
        ph_addr = address or "____"
        ph_contact = contact_name or "____"

        # КАЛЕНДАРЬ
        calendar = (
            f"{ph_phone}\n\n"
            f"{company_short or '____'}\n\n"
            f"{ph_vehicle}\n\n"
            f"{status_line}"
        )

        # МЕССЕНДЖЕР
        messenger = (
            f"Добрый день. Новая заявка. Терминал {status_line}\n"
            f"Объект обслуживания:\n"
            f"   {ph_vehicle}\n"
            f"Местоположение техники\n"
            f"   {ph_addr}\n"
            f"Контактное лицо\n"
            f"   {ph_contact}\n"
            f"Номер телефона\n"
            f"   {ph_phone}"
        )

        return {
            "calendar": calendar,
            "messenger": messenger,
            "fields": {
                "phone": phone,
                "company_short": company_short or None,
                "city": city or None,
                "vehicle": vehicle or None,
                "plate": plate,
                "date": date_ru,
                "status_line": status_line,
                "contact_name": contact_name,
                "address": address,
            },
        }
    except HTTPException:
        raise
    except Exception:
        log.exception("installer_export_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to build installer export")


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
        # Комментарии по заявке — свежие факты «с места» (оператор/клиент). ИИ
        # учитывает их: восстановленное питание → ответ о восстановлении (не
        # диагностика); ранее выданная диагностика без данных → выезд бригады.
        # Best-effort: любой сбой получения комментариев не должен ломать разбор.
        comments_digest = await _build_comments_digest(external_id, okdesk)
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
            resolved = await cache.find_similar_resolved(
                category=category, plate=plate, flags=flags, sender=sender, limit=3,
            )
            # Append operator-approved answer TEMPLATES for the same category as
            # extra few-shot phrasing references. The downstream formatter renders
            # only the first 3 examples, so cap resolved cases at 2 to guarantee
            # at least one template survives. Additive & best-effort — any failure
            # leaves the resolved-case behaviour untouched.
            try:
                from app.api.v1.endpoints.templates import (
                    fetch_templates_for_category,
                )

                templates = fetch_templates_for_category(category, limit=2)
                if templates:
                    examples: list[dict[str, object]] = list(resolved[:2])
                    for tpl in templates:
                        examples.append({
                            # SAME keys the resolved-case examples / _format_examples use:
                            "plate": "шаблон",
                            "fault_date": None,
                            "category": tpl.get("category") or category,
                            "answer": tpl.get("content"),
                            "flags": [],
                            "source": "template",
                            "is_dynamic": tpl.get("is_dynamic"),
                        })
                    return examples
            except Exception:
                log.warning("example_provider_templates_failed", category=category)
            return resolved

        result = await automation.automate(
            live.title,
            live.description,
            params,
            issue_type=live.type.name if live.type else None,
            attachments_text=attachments_text or None,
            sender=sender,
            comments=comments_digest or None,
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
        # Не валим запрос в 500 (фронт показывает «Ошибка анализа. Попробуйте
        # снова.» и теряет результат). Вместо этого отдаём валидный результат
        # разбора с needs_review=True и понятным reasoning, чтобы оператор увидел,
        # что произошло, и мог разобрать заявку вручную. Кейс 64196: непредвиденный
        # сбой в одном из вызовов (Okdesk/LLM/инструмент) ронял весь разбор.
        log.exception("automate_issue_failed", issue_id=issue_id)
        return {
            "parsed": {
                "plate": None, "date": None, "sheet_mileage_km": None,
                "declared_system_km": None, "llm_extracted": False,
            },
            "telemetry": {},
            "category": "Общий разбор",
            "confidence": 0.0,
            "draft_answer": "",
            "reasoning": (
                "Не удалось выполнить автоматический разбор заявки из-за "
                "внутренней ошибки (сбой обращения к Okdesk/телеметрии/ИИ). "
                "Разберите заявку вручную или повторите попытку позже."
            ),
            "needs_review": True,
            "error": "automation_failed",
        }


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


@router.get("/{issue_id}/template_values")
async def get_template_values(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Suggested placeholder->value map for dynamic templates.

    Best-effort: computed from the CACHED automate result only (no AI re-run,
    no token spend). Returns only keys we can confidently fill. Time-window
    placeholders (время_с/время_по/время/дата_восстановления) are intentionally
    omitted — the operator fills those.
    """
    values: dict[str, str] = {}
    try:
        import datetime as _dt

        # [сегодня] is cheap and always available.
        today = _dt.date.today().strftime("%d.%m.%Y")
        values["сегодня"] = today

        issue_data = await cache.get_issue_with_analysis(issue_id)
        if issue_data:
            external_id = issue_data["issue"].external_id
            cached = await cache.get_result_cache(external_id, "automate")
            if cached and isinstance(cached.get("data"), dict):
                data = cached["data"]
                parsed = data.get("parsed") or {}
                telemetry = data.get("telemetry") or {}

                # [дата] -> fault date ISO -> DD.MM.YYYY
                iso = parsed.get("date")
                if isinstance(iso, str) and iso:
                    try:
                        d = _dt.date.fromisoformat(iso[:10])
                        values["дата"] = d.strftime("%d.%m.%Y")
                    except ValueError:
                        pass

                # [пробег]/[количество] -> real system mileage (km)
                sys_km = telemetry.get("system_mileage_km")
                if isinstance(sys_km, (int, float)):
                    num = str(int(round(sys_km)))
                    values["пробег"] = num
                    values["количество"] = num
    except Exception:
        log.exception("get_template_values_failed", issue_id=issue_id)
        return {"values": {}}
    return {"values": values}


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
        objects: list[dict[str, object]] = []
        note: str | None = None
        # ocr_progress: complete=False означает, что OCR части вложений не дошёл до
        # конца (сервер слаб, большой PDF за окно запроса не успевает) — фронт
        # авто-дораспознаёт, повторяя запрос, пока complete не станет True.
        ocr_progress: dict[str, object] = {"complete": True, "attachments_total": 0,
                                            "attachments_done": 0, "pages_done": 0}
        try:
            objects = await automation.analyze_batch(external_id, live.attachments,
                                                     issue_title=live.title,
                                                     issue_description=live.description,
                                                     ocr_cache=cache,
                                                     progress_out=ocr_progress)
        except Exception:
            # analyze_batch is best-effort and shouldn't raise, but guard anyway
            # so a single bad attachment never turns into a 500 «Ошибка разбора».
            log.warning("automate_batch_analyze_failed", issue_id=issue_id)
            objects = []
        if not objects:
            # No extractable acts / OCR empty / no plates (e.g. ОДКРА «письма»):
            # degrade gracefully instead of failing the whole request.
            note = (
                "Не удалось разобрать вложения по объектам: во вложениях нет "
                "распознаваемых гос.номеров (вероятно, это письма/сканы без таблицы ТС). "
                "Обработайте заявку вручную."
            )
        jamming = sum(1 for o in objects if o.get("verdict") == "Глушение")
        ok_data = sum(1 for o in objects if o.get("verdict") == "Данные верны")
        company_name = getattr(issue_data["issue"], "company_name", None)
        payload = {
            "total": len(objects),
            "jamming_count": jamming,
            "ok_count": ok_data,
            "is_aggregate": _is_aggregate(company_name, live.description, objects),
            "objects": objects,
            "note": note,
            "ocr_progress": ocr_progress,
        }
        try:
            await cache.save_result_cache(external_id, "batch", json.dumps(payload, ensure_ascii=False))
        except Exception:
            log.warning("batch_cache_save_failed", issue_id=issue_id)
        return payload
    except HTTPException:
        raise
    except Exception:
        # Last-resort guard: still return a usable payload rather than a 500 so
        # the operator sees a note instead of «Ошибка разбора».
        log.exception("automate_batch_failed", issue_id=issue_id)
        return {
            "total": 0,
            "jamming_count": 0,
            "ok_count": 0,
            "is_aggregate": False,
            "objects": [],
            "note": "Не удалось выполнить разбор по объектам. Обработайте заявку вручную.",
        }


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


class VerdictUpdate(BaseModel):
    plate: str
    verdict: str
    file: str | None = None
    date: str | None = None  # ISO-дата выезда/неисправности: один ТС может иметь
                             # РАЗНЫЕ вердикты за разные даты (63617) — правим строку,
                             # а не весь объект.


# Вердикты, которые оператор может выставить вручную в таблице разбора.
_EDITABLE_VERDICTS = {
    "Глушение", "Данные верны", "Не было питания",
    "Нет данных", "Терминал подключился", "Проверить",
}


def _norm_plate(p: object) -> str:
    return re.sub(r"[\s\-]", "", str(p or "")).upper()


@router.post("/{issue_id}/batch/verdict")
async def update_batch_verdict(
    issue_id: int,
    body: VerdictUpdate,
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Оператор корректирует вердикт по ТС в сохранённом разборе.

    Изменение пишется в кэш batch и используется при составлении общего ответа.
    Доступно только не-demo (POST блокируется middleware для demo)."""
    if body.verdict not in _EDITABLE_VERDICTS:
        raise HTTPException(status_code=400, detail="Недопустимый вердикт")
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id
    cached = await cache.get_result_cache(external_id, "batch")
    if not cached or not cached.get("data", {}).get("objects"):
        raise HTTPException(status_code=400, detail="Сначала выполните разбор по вложениям")
    data = cached["data"]
    objects = data.get("objects") or []
    target = _norm_plate(body.plate)
    updated = 0
    for o in objects:
        if (_norm_plate(o.get("plate")) == target
                and (not body.file or o.get("file") == body.file)
                # Если дата передана — правим ТОЛЬКО строку этой даты (у одного ТС
                # за разные даты могут быть разные вердикты, 63617).
                and (not body.date or o.get("date") == body.date)):
            o["verdict"] = body.verdict
            o["verdict_edited"] = True
            updated += 1
    if not updated:
        raise HTTPException(status_code=404, detail="ТС не найдено в разборе")
    data["jamming_count"] = sum(1 for o in objects if o.get("verdict") == "Глушение")
    data["ok_count"] = sum(1 for o in objects if o.get("verdict") == "Данные верны")
    try:
        await cache.save_result_cache(external_id, "batch", json.dumps(data, ensure_ascii=False))
    except Exception:
        log.warning("batch_verdict_save_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Не удалось сохранить вердикт")
    return {"ok": True, "updated": updated, **data}


class PlateUpdate(BaseModel):
    old_plate: str
    new_plate: str
    file: str | None = None
    date: str | None = None  # ISO — правим строку конкретной даты, а не все строки ТС


@router.post("/{issue_id}/batch/plate")
async def update_batch_plate(
    issue_id: int,
    body: PlateUpdate,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Оператор исправляет гос.номер ТС в сохранённом разборе (OCR исказил номер —
    напр. М567МВ→MS69MB, 64722) и система ЗАНОВО ищет ТС в гео по верному номеру,
    обновляя вердикт/трек/пробег этой строки.

    Правится ТОЛЬКО строка (old_plate, date, file) — у одного ТС за разные даты
    свои строки, чужую дату не трогаем."""
    new_plate = (body.new_plate or "").strip()
    if not new_plate:
        raise HTTPException(status_code=400, detail="Новый гос.номер пуст")
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id
    cached = await cache.get_result_cache(external_id, "batch")
    if not cached or not cached.get("data", {}).get("objects"):
        raise HTTPException(status_code=400, detail="Сначала выполните разбор по вложениям")
    data = cached["data"]
    objects: list[dict] = data.get("objects") or []
    target = _norm_plate(body.old_plate)
    updated = 0
    for i, o in enumerate(objects):
        if (_norm_plate(o.get("plate")) == target
                and (not body.file or o.get("file") == body.file)
                and (not body.date or o.get("date") == body.date)):
            # Перепроверка в гео по верному номеру: дату/ПЛ/заявл.систему/адрес/файл
            # берём из этой же строки, телеметрию и вердикт считаем заново.
            try:
                fresh = await automation._analyze_object(
                    new_plate, o.get("date"), o.get("sheet_mileage_km"),
                    o.get("address"), o.get("file") or "",
                    declared=o.get("declared_system_km"),
                )
            except Exception:
                log.warning("batch_plate_reanalyze_failed", issue_id=issue_id, plate=new_plate)
                raise HTTPException(status_code=502, detail="Не удалось перепроверить ТС в гео")
            fresh["plate_edited"] = True
            objects[i] = fresh
            updated += 1
    if not updated:
        raise HTTPException(status_code=404, detail="ТС не найдено в разборе")
    data["total"] = len(objects)
    data["jamming_count"] = sum(1 for o in objects if o.get("verdict") == "Глушение")
    data["ok_count"] = sum(1 for o in objects if o.get("verdict") == "Данные верны")
    try:
        await cache.save_result_cache(external_id, "batch", json.dumps(data, ensure_ascii=False))
    except Exception:
        log.warning("batch_plate_save_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Не удалось сохранить гос.номер")
    return {"ok": True, "updated": updated, **data}


class AiFeedbackBody(BaseModel):
    rating: str  # 'good' | 'bad'
    error_kind: str | None = None  # 'wrong_verdict' | 'wrong_plate' | 'wrong_date' | 'wrong_mileage' | 'other'
    comment: str | None = None
    correct_category: str | None = None


async def _ai_category_of(cache: CacheService, external_id: int) -> str | None:
    """Категория, которую выдал ИИ (для записи рядом с оценкой оператора)."""
    for kind in ("automate", "batch"):
        cached = await cache.get_result_cache(external_id, kind)
        d = (cached or {}).get("data") if cached else None
        if isinstance(d, dict):
            if d.get("category"):
                return str(d.get("category"))
            objs = d.get("objects")
            if objs:  # batch: сводно по вердиктам
                verdicts = sorted({str(o.get("verdict")) for o in objs if o.get("verdict")})
                return ", ".join(verdicts) if verdicts else None
    return None


@router.post("/{issue_id}/ai_feedback")
async def add_ai_feedback(
    issue_id: int,
    body: AiFeedbackBody,
    request: Request,
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Оценка оператором качества ИИ-разбора: 'good' (верно) / 'bad' (ошибка)+комментарий."""
    if body.rating not in ("good", "bad"):
        raise HTTPException(status_code=400, detail="rating must be 'good' or 'bad'")
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id
    user = getattr(request.state, "user", None)
    ai_cat = await _ai_category_of(cache, external_id)
    res = await cache.save_ai_feedback(
        external_id, body.rating, error_kind=body.error_kind, comment=body.comment,
        ai_category=ai_cat, correct_category=body.correct_category,
        created_by=(user.get("u") if user else None),
    )
    return {"ok": True, **res}


@router.get("/{issue_id}/ai_feedback")
async def get_ai_feedback(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Последняя оценка ИИ-разбора по заявке (для подсветки в карточке)."""
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id
    fb = await cache.get_latest_ai_feedback(external_id)
    return {"feedback": fb}


@router.get("/ai_feedback/list")
async def list_ai_feedback(
    rating: str | None = Query(None, description="'good' | 'bad' | None=все"),
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Список оценок ИИ-разбора (экран «хорошо разобрано / с ошибками»)."""
    items = await cache.list_ai_feedback(rating=rating)
    return {"items": items, "count": len(items)}


@router.post("/ai_feedback/{feedback_id}/resolve")
async def resolve_ai_feedback(
    feedback_id: int,
    request: Request,
    resolved: bool = Query(True, description="true=исправлено, false=снять отметку"),
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Отметить оценку (обычно «ошибка») как разобранную и ИСПРАВЛЕННУЮ — чтобы в
    экране «Оценки ИИ» отличать обработанные от ещё не исправленных."""
    user = getattr(request.state, "user", None)
    ok = await cache.set_ai_feedback_resolved(
        feedback_id, resolved, by=(user.get("u") if user else None))
    if not ok:
        raise HTTPException(status_code=404, detail="Оценка не найдена")
    return {"ok": True, "resolved": resolved}


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
            objects = await automation.analyze_batch(external_id, live.attachments,
                                                     issue_title=live.title,
                                                     issue_description=live.description,
                                                     ocr_cache=cache)

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


async def _attach_source_file_to_child(
    *,
    okdesk: OkdeskService,
    parent_external_id: int,
    parent_attachments: list,
    child_id: int,
    source_filename: str | None,
) -> None:
    """Download the matching attachment from the parent and upload it to the child.

    Matching strategy:
    1. If *source_filename* is provided — find attachments whose
       ``attachment_file_name`` equals it (case-insensitive).
    2. If nothing matches (or no filename given) — attach ALL parent attachments
       as a best-effort fallback (avoids losing the source data).
    Deduplication: we track what we've already uploaded by attachment id.
    """
    if not parent_attachments:
        return

    # Determine which attachments to copy.
    candidates = []
    if source_filename:
        needle = source_filename.lower()
        candidates = [
            a for a in parent_attachments
            if a.attachment_file_name and a.attachment_file_name.lower() == needle
        ]

    if not candidates:
        # Fallback: attach all parent attachments (but skip duplicates later).
        candidates = list(parent_attachments)

    seen_ids: set[int] = set()
    for attachment in candidates:
        if attachment.id in seen_ids:
            continue
        seen_ids.add(attachment.id)

        result = await okdesk.download_attachment(parent_external_id, attachment.id)
        if result is None:
            log.warning(
                "source_attachment_download_failed",
                parent_id=parent_external_id,
                attachment_id=attachment.id,
            )
            continue

        file_bytes, content_type = result
        filename = attachment.attachment_file_name or f"attachment_{attachment.id}"

        upload_result = await okdesk.upload_attachment(
            child_id, filename, file_bytes, content_type
        )
        if upload_result is None:
            log.warning(
                "source_attachment_upload_failed",
                child_id=child_id,
                filename=filename,
            )
        else:
            log.info(
                "source_attachment_copied",
                parent_id=parent_external_id,
                child_id=child_id,
                filename=filename,
            )


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
        # Ответственного дочерней наследуем от родительской заявки.
        parent_assignee_id = parent.assignee.id if getattr(parent, "assignee", None) else None

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
                # Наследуем ответственного от родителя (best-effort, не ломает создание).
                if parent_assignee_id:
                    try:
                        await okdesk.assign_issue(child.id, parent_assignee_id)
                    except Exception:
                        log.warning("child_assign_failed", child_id=child.id)
                # Immediately cache the child so openExternal can find it without a full refresh
                await cache.cache_single_issue(child.id)
            except Exception:
                log.warning("create_child_failed", plate=obj.plate)
                created.append({"plate": obj.plate, "ok": False})
                continue

            # Вложения к дочерней НЕ копируем: все нужные данные (номер, дата, пробег
            # по системе и путевому листу) уже есть в теле дочерней заявки. Прежний
            # фоллбэк цеплял ВСЕ вложения родителя — это лишнее (64444).

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
        result = await automation.build_track(
            live.title, live.description, attachments_text=attachments_text or None,
            date_from=date_from, date_to=date_to,
        )
        # The independent single-plate parse in build_track sometimes fails where
        # automate() succeeds: automate has an LLM-extraction fallback (e.g. the
        # fault date hidden in an HTML table — issue 64196). When the parse can't
        # produce a clean plate+date, reuse the plate/date the AI already found
        # (cached automate result) so the track panel matches the AI analysis.
        if isinstance(result, dict) and result.get("error") == "no_plate_or_date":
            fb_plate: str | None = None
            fb_date: str | None = None
            try:
                cached = await cache.get_result_cache(external_id, "automate")
                if cached and isinstance(cached.get("data"), dict):
                    parsed = cached["data"].get("parsed") or {}
                    p = parsed.get("plate")
                    d = parsed.get("date")
                    if isinstance(p, str) and p:
                        fb_plate = p
                    if isinstance(d, str) and d:
                        fb_date = d[:10]
            except Exception:
                log.warning("track_fallback_cache_failed", issue_id=issue_id)
            # Secondary fallback: first plate from the text + parsed date, when
            # the cached automate result is missing one of the two fields.
            try:
                from app.services.issue_automation import extract_all_plates

                if not fb_plate:
                    plates = extract_all_plates(
                        f"{live.title or ''} {attachments_text or ''}"
                    )
                    if plates:
                        fb_plate = plates[0]
                if not fb_date:
                    parsed_again = automation.parse_issue(
                        live.title, live.description, None,
                        extra_text=attachments_text or None,
                    )
                    if parsed_again.date:
                        fb_date = parsed_again.date
            except Exception:
                log.warning("track_fallback_extract_failed", issue_id=issue_id)
            if fb_plate and fb_date:
                result = await automation.build_track(
                    "", "", plate=fb_plate, fault_date=fb_date,
                    date_from=date_from, date_to=date_to,
                )
        return result
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

        # Okdesk returns the comment timestamp as `published_at` (the parsed
        # IssueComment model uses extra="ignore", so that field is dropped and
        # `created_at` ends up None). Re-read the raw payload to recover the
        # timestamp the frontend renders via formatDate(c.created_at), plus the
        # visibility flag (`public`) and the author type (`author.type`) the UI
        # uses to distinguish client vs employee / public vs private comments.
        raw_dates: dict[int, str] = {}
        raw_public: dict[int, bool] = {}
        raw_author_kind: dict[int, str] = {}

        def _map_author_kind(author_type: object) -> str:
            # Okdesk `author.type` values: "contact" (client portal user),
            # "employee"/"user"/"staff" (support staff). Map to UI buckets.
            t = str(author_type or "").lower()
            if t in ("contact", "client"):
                return "client"
            if t in ("employee", "staff", "user", "operator"):
                return "employee"
            return "system"

        try:
            raw = await okdesk._client.get_issue_comments(external_id)
            raw_rows = raw if isinstance(raw, list) else (raw.get("data") if isinstance(raw, dict) else None)
            for r in raw_rows or []:
                if not isinstance(r, dict):
                    continue
                cid = r.get("id")
                if cid is None:
                    continue
                ts = r.get("published_at") or r.get("created_at")
                if ts:
                    raw_dates[cid] = ts
                pub = r.get("public")
                if pub is not None:
                    raw_public[cid] = bool(pub)
                author = r.get("author")
                if isinstance(author, dict):
                    raw_author_kind[cid] = _map_author_kind(author.get("type"))
        except Exception:
            log.warning("comment_meta_lookup_failed", issue_id=issue_id)

        return [
            {
                "id": c.id,
                "author": c.author.name if c.author else "Unknown",
                "content": c.content,
                "created_at": c.created_at or raw_dates.get(c.id),
                "is_internal": c.is_internal,
                # Best-effort UI metadata: default public=True, kind=employee.
                "is_public": raw_public.get(c.id, True),
                "author_kind": raw_author_kind.get(c.id, "employee"),
            }
            for c in comments
        ]
    except HTTPException:
        raise
    except Exception:
        log.exception("get_comments_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to fetch comments")


@router.get("/{issue_id}/extracted")
async def get_extracted(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Что извлечено из тела/вложений заявки БЕЗ запуска ИИ-анализа.

    Лёгкий разбор: regex по тексту (гос.номер, дата неисправности, пробег по
    путевому листу, пробег «в системе» заявленный клиентом) + сырой извлечённый
    текст вложений. Телеметрия и LLM НЕ вызываются."""
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        live = await okdesk.get_issue(external_id)
        att_text = ""
        try:
            att_text = await automation.read_attachments(external_id, live.attachments or [])
        except Exception:
            log.warning("extracted_attachments_failed", issue_id=issue_id)
        parsed = automation.parse_issue(live.title, live.description, None, extra_text=att_text)
        body_text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", live.description or "")).strip()
        return {
            "plate": parsed.plate,
            "date": parsed.date,
            "sheet_mileage_km": parsed.sheet_mileage_km,
            "declared_system_km": parsed.declared_system_km,
            "body_text": body_text[:4000],
            "attachments_text": (att_text or "")[:8000],
            "attachments_count": len(live.attachments or []),
        }
    except HTTPException:
        raise
    except Exception:
        log.exception("get_extracted_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to extract issue data")


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


class IssueParametersUpdate(BaseModel):
    """Кастом-параметры заявки, которые оператор может править вручную.

    Все поля опциональны: шлём в Okdesk только переданные. Пустые обязательные
    параметры (Местоположение техники / Контактное лицо / Номер телефона)
    блокируют перевод заявки в статус «В работе» (баг 64197)."""
    address: str | None = None
    contact_person: str | None = None
    tel_person: str | None = None


@router.post("/{issue_id}/parameters")
async def update_issue_parameters(
    issue_id: int,
    body: IssueParametersUpdate,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> dict[str, object]:
    """Обновить кастом-параметры заявки в Okdesk и кэш.

    Нужно, чтобы заполнить обязательные поля (Местоположение техники /
    Контактное лицо / Номер телефона) и затем перевести заявку «В работе».
    Доступно только не-demo (POST блокируется middleware для demo)."""
    if body.address is None and body.contact_person is None and body.tel_person is None:
        raise HTTPException(status_code=400, detail="Нужно передать хотя бы один параметр")
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id

        await okdesk.update_issue_parameters(
            external_id,
            address=body.address,
            contact_person=body.contact_person,
            tel_person=body.tel_person,
        )

        # Параметры в Okdesk уже обновлены: сбой обновления локального кэша
        # не должен выглядеть как ошибка записи.
        try:
            await cache.refresh_single_issue(issue_id, external_id)
        except Exception:
            log.warning("update_params_refresh_cache_failed", issue_id=issue_id)

        # Возвращаем актуальные параметры из свежей выгрузки заявки.
        try:
            live = await okdesk.get_issue(external_id)
            parameters = _build_parameters(live.parameters)
        except Exception:
            parameters = []
        return {"ok": True, "parameters": parameters}
    except HTTPException:
        raise
    except OkdeskAPIError as exc:
        log.warning("update_params_okdesk_rejected", issue_id=issue_id, status=exc.status_code, body=exc.body)
        raise HTTPException(status_code=400, detail=f"Okdesk отклонил изменение параметров: {exc.body}")
    except httpx.HTTPStatusError as exc:
        body_txt = (exc.response.text or "")[:500] if exc.response is not None else ""
        log.warning("update_params_okdesk_http_error", issue_id=issue_id, body=body_txt)
        raise HTTPException(status_code=502, detail=f"Okdesk вернул ошибку при изменении параметров: {body_txt}")
    except Exception:
        log.exception("update_issue_parameters_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to update issue parameters")


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


# Автоматические системные комментарии Okdesk (смена статуса и т.п.) — НЕ ответ
# оператора, их нельзя класть в базу эталонов.
_SYSTEM_COMMENT_RE = re.compile(
    r"перешл\w*\s+в\s+статус|изменил\w*\s+статус|статус\w*\s+заявки\s+измен"
    r"|если\s+остал\w*\s+вопрос\w*\s+можете\s+повторно",
    re.I,
)


def _is_system_comment(text: str) -> bool:
    return bool(_SYSTEM_COMMENT_RE.search(text))


async def _operator_answer_from_comments(external_id: int, okdesk: OkdeskService) -> str | None:
    """Последний ПУБЛИЧНЫЙ СОДЕРЖАТЕЛЬНЫЙ комментарий сотрудника = ответ оператора.

    Пропускаем приватные заметки, комментарии клиента и АВТО-сообщения Okdesk
    (смена статуса «Заявка перешла в статус …»), чтобы в базу эталонов попадал
    реальный ответ, а не системный шум."""
    try:
        raw = await okdesk._client.get_issue_comments(external_id)
    except Exception:
        return None
    rows = raw if isinstance(raw, list) else (raw.get("data") if isinstance(raw, dict) else [])
    best_ts = ""
    best_text: str | None = None
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        if r.get("public") is False:
            continue  # приватная заметка — не ответ клиенту
        author = r.get("author")
        atype = str((author.get("type") if isinstance(author, dict) else "") or "").lower()
        if atype in ("contact", "client", "clientuser"):
            continue  # комментарий клиента, а не оператора
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(r.get("content") or ""))).strip()
        if not text or len(text) < 15 or _is_system_comment(text):
            continue  # пусто / слишком коротко / системное авто-сообщение
        ts = str(r.get("published_at") or r.get("created_at") or "")
        if ts >= best_ts:
            best_ts, best_text = ts, text
    return best_text


@router.post("/training/backfill")
async def backfill_training(
    request: Request,
    limit: int = Query(200, ge=1, le=2000),
    dry_run: bool = Query(False),
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Наполнить базу эталонов (few-shot) из УЖЕ решённых заявок (только admin).

    Большинство заявок закрывают прямо в Okdesk, минуя кнопку «Решить» в дашборде,
    поэтому их (факты телеметрии → ответ оператора) нет в few-shot. Эндпоинт
    сканирует решённые заявки, берёт итоговый публичный ответ оператора и сохраняет
    эталон для распознаваемых заявок «расхождение пробега» (с номером+датой),
    пропуская уже сохранённые. ``dry_run=true`` только считает, ничего не пишет."""
    user = getattr(request.state, "user", None)
    if not user or user.get("r") != "admin":
        raise HTTPException(status_code=403, detail="Только для администратора")
    existing = await cache.existing_training_sample_ids()
    resolved: list = []
    for st in ("completed", "closed"):
        try:
            resolved += await cache.get_issues_from_cache(status=st)
        except Exception:
            log.warning("backfill_list_failed", status=st)
    added = scanned = skipped_existing = no_answer = not_mileage = 0
    for iss in resolved:
        if added >= limit:
            break
        ext = getattr(iss, "external_id", None)
        if ext is None:
            continue
        if ext in existing:
            skipped_existing += 1
            continue
        scanned += 1
        try:
            live = await okdesk.get_issue(ext)
            # Дёшево отсеиваем не-пробеговые: нужен распознаваемый номер+дата.
            parsed = automation.parse_issue(live.title, live.description, None)
            if not parsed.plate or not parsed.date:
                not_mileage += 1
                continue
            answer = await _operator_answer_from_comments(ext, okdesk)
            if not answer:
                no_answer += 1
                continue
            if dry_run:
                added += 1
                continue
            sample = await automation.build_training_sample(
                live.title, live.description, answer,
                getattr(iss, "status", None) or "completed",
            )
            if not sample:
                not_mileage += 1
                continue
            await cache.save_training_sample(ext, sample)
            existing.add(ext)
            added += 1
        except Exception:
            log.warning("backfill_issue_failed", external_id=ext)
    return {
        "dry_run": dry_run, "added": added, "scanned": scanned,
        "skipped_existing": skipped_existing, "no_answer": no_answer,
        "not_mileage": not_mileage,
    }


@router.get("/training/stats")
async def training_stats(
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Сколько эталонов в базе few-shot."""
    ids = await cache.existing_training_sample_ids()
    return {"count": len(ids)}


@router.post("/{issue_id}/resolve")
async def resolve_issue(
    issue_id: int,
    status_code: str = Query(..., description="Target status code: completed or delayed"),
    comment: str | None = Query(None),  # необязателен: для «В работе»/«Открыть» нужна
                                        # только смена статуса без ответа клиенту
    comment_public: bool = Query(True),
    delay_to: str | None = Query(None, description="Required when status_code=delayed (ISO datetime)"),
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Send a comment and change issue status in one action."""
    # Полный набор кодов статусов Okdesk этого аккаунта (см. диагностику 64453):
    # opened, wait(=В работе), delayed(=Ожидание ответа), no_time(=Отложить),
    # completed(=Решена), inst_fin(=Завершена), closed. Хедер-дропдаун шлёт wait/
    # no_time — раньше их не было в ALLOWED → HTTP 400 (баг 64453/64306).
    ALLOWED = {"completed", "delayed", "opened", "closed", "wait", "no_time", "inst_fin"}
    if status_code not in ALLOWED:
        raise HTTPException(status_code=400, detail=f"status_code must be one of {ALLOWED}")
    # delayed/no_time («Ожидание ответа»/«Отложить») в Okdesk требуют срок delay_to.
    if status_code in ("delayed", "no_time") and not delay_to:
        raise HTTPException(status_code=400, detail=f"delay_to is required for status '{status_code}'")
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id

        status_result = await okdesk.change_issue_status(external_id, status_code, comment=comment, comment_public=comment_public, delay_to=delay_to)
        status_changed = status_result.get("code") == status_code

        # Best-effort: статус УЖЕ изменён в Okdesk. Сбой обновления локального
        # кэша не должен попасть в except OkdeskAPIError/HTTPStatusError ниже и
        # ввести оператора в заблуждение («отклонено», хотя смена прошла).
        try:
            await cache.refresh_single_issue(issue_id, external_id)
        except Exception:
            log.warning("resolve_refresh_cache_failed", issue_id=issue_id)

        # Groundwork for AI training: record (telemetry → operator decision).
        # Best-effort, must never break the resolve action.
        try:
            # Обучающий образец имеет смысл только когда оператор дал ответ (комментарий).
            # Смена статуса без комментария («В работе»/«Открыть») — образец не пишем.
            live = await okdesk.get_issue(external_id) if comment else None
            sample = (await automation.build_training_sample(
                live.title, live.description, comment, status_code
            )) if (comment and live) else None
            if sample:
                latest = (issue_data.get("latest_analysis"))
                await cache.save_training_sample(
                    external_id, sample,
                    ai_category=getattr(latest, "recommendation", None),
                    ai_was_used=latest is not None,
                )
        except Exception:
            log.warning("training_sample_record_failed", issue_id=issue_id)

        # Инвалидация кэша анализа (1.4): после решения/комментария старый разбор устарел.
        await cache.delete_result_cache(external_id, "automate")

        return {
            "ok": True,
            "status_changed": status_changed,
            "status": status_result,
        }
    except HTTPException:
        raise
    except OkdeskAPIError as exc:
        # Okdesk отклонил операцию (валидация / недопустимый переход статуса).
        # Показываем оператору реальную причину из тела ответа Okdesk.
        log.warning("resolve_issue_okdesk_rejected", issue_id=issue_id, status=exc.status_code, body=exc.body)
        raise HTTPException(status_code=400, detail=f"Okdesk отклонил смену статуса: {exc.body}")
    except httpx.HTTPStatusError as exc:
        # Прочие HTTP-ошибки от Okdesk (auth, not found, 5xx).
        body = (exc.response.text or "")[:500] if exc.response is not None else ""
        log.warning("resolve_issue_okdesk_http_error", issue_id=issue_id, status=exc.response.status_code if exc.response is not None else None, body=body)
        raise HTTPException(status_code=502, detail=f"Okdesk вернул ошибку при смене статуса: {body}")
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
        # Новый комментарий может изменить верный ответ — сбрасываем кэш анализа (1.4).
        await cache.delete_result_cache(external_id, "automate")
        return {"ok": True, "result": result}
    except HTTPException:
        raise
    except Exception:
        log.exception("add_comment_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to add comment")
