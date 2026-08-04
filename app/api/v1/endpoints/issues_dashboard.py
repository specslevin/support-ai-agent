"""Dashboard endpoints for browsing and analysing Okdesk issues."""

from __future__ import annotations

import datetime as _dt
import json
import re
import urllib.parse
# Алиас: имя `fields` уже занято локальной переменной в /issues/{id}/fields.
from dataclasses import asdict, fields as _dc_fields
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, ValidationError

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
from app.services.issue_automation import (_SIGNATURE_IMAGE_RE,
                                           IssueAutomationService, ParsedIssue,
                                           TelemetryFacts, _plate_format_suspect)

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/issues", tags=["dashboard:issues"])


# Псевдо-источники строки разбора: номер взят из темы/описания/комментария, а не
# из вложения. Бесплатный `parse` помечает ТАК ВСЕ строки, даже когда номера
# фактически пришли из имён отдельных актов (Жигулевское), поэтому форму письма
# по такому источнику не судим (класс 19 сессии C4).
_TEXT_SOURCES = ("(из текста заявки)", "(из комментария клиента)")
# Сколько разных ТС в ОДНОМ вложении делает его «общим списком»: у Чапаевского в
# одном .docx 12-30 позиций, у Жигулевского в файле 1 акт (максимум 2).
_AGG_PLATES_PER_FILE = 5


def _plates_by_source(objects: list[dict[str, object]]) -> dict[str, set[str]]:
    """Гос.номера, сгруппированные по источнику строки (полю ``file``)."""
    by_source: dict[str, set[str]] = {}
    for o in objects:
        plate = o.get("plate")
        if not plate:
            continue
        by_source.setdefault(str(o.get("file") or ""), set()).add(str(plate))
    return by_source


def _is_aggregate(company_name: str | None, description: str | None,
                  objects: list[dict[str, object]]) -> bool:
    """Сводная заявка — отвечаем ОДНИМ письмом, детей НЕ создаём.

    Класс 19 сессии C4: решает ФОРМА письма, а не число машин (решение
    пользователя, интервью 4). Одно вложение с общим списком ТС (архетип
    Чапаевского) — всегда сводный ответ; отдельный акт на каждую машину (архетип
    Жигулевского) — поштучно. Порог по числу ТС остался только страховкой от
    выгрузок по всему парку.
    """
    if company_name and "одкр" in company_name.lower():
        return True
    plates = {o.get("plate") for o in objects if o.get("plate")}
    by_source = _plates_by_source(objects)
    # Общий список ТС внутри ОДНОГО вложения. Раньше здесь решал порог 25, и один
    # архетип письма резался пополам: Чапаевское 4913 и 4798 (17 ТС) разрезались
    # на детей, а 4843 (29) и 4580 (30) отвечались сводно — при одинаковых письмах
    # одного автора.
    if any(len(v) >= _AGG_PLATES_PER_FILE
           for k, v in by_source.items() if k not in _TEXT_SOURCES):
        return True
    # «Один акт = один файл» — поштучно, сколько бы машин ни было: у Жигулевского
    # 4880 это 28 отдельных актов, и порог 25 разворачивал их в сводный ответ
    # вопреки форме письма. Порог применяем только к письмам, где на источник
    # приходится в среднем больше одного ТС.
    if len(plates) < 2 * max(1, len(by_source)):
        return False
    # Очень много ТС — сводная выгрузка по всему парку, а не письмо про
    # конкретные машины: 62959 приложил два XLSX на ~91 строку каждый (182 строки,
    # весь парк ПО) как ДОКАЗАТЕЛЬСТВО сбоя списка, и разбор трактовал это как 91
    # отдельную претензию по пробегу. Порог 25 — та же граница, за которой модель
    # перестаёт держать объекты по отдельности (_AI_BATCH_MAX_OBJECTS), и он
    # заведомо выше самых больших РЕАЛЬНЫХ писем-заявок (11-13 ТС).
    if len(plates) >= 25:
        return True
    body = (description or "").strip()
    if not body and len(plates) >= 5:
        return True
    return False


# Заявка, удалённая или слитая в Okdesk. Okdesk отдаёт на неё HTTP 200 с телом
# {"errors": "Записи не существует"} — без ключа `id`, поэтому Issue.model_validate
# падает ValidationError, а эндпоинты валились в 500 / показывали общую ноту.
_GONE_DETAIL = "Заявка удалена или слита в Okdesk — разбор невозможен"
_GONE_NOTE = "Заявка удалена или слита в Okdesk"


async def _live_issue(okdesk: OkdeskService, external_id: int,
                      issue_id: int | None = None):
    """``okdesk.get_issue`` + распознавание «мёртвой» заявки.

    Уточняющий запрос (``issue_exists``) делаем ТОЛЬКО после ValidationError:
    у здоровой заявки (подавляющее большинство) поход в Okdesk по-прежнему один.

    Поднимает ``HTTPException(410)``, когда заявка точно слита/удалена. Если
    ``issue_exists`` вернул ``None`` (сеть/5xx — неопределённо) или ``True``
    (валидация упала по другой причине), пробрасываем исходную ошибку и ведём
    себя как раньше.
    """
    try:
        return await okdesk.get_issue(external_id)
    except httpx.HTTPStatusError as exc:
        # Честный 404 от Okdesk — тот же случай, уточняющий запрос не нужен.
        if exc.response is not None and exc.response.status_code == 404:
            log.warning("okdesk_issue_gone", issue_id=issue_id,
                        external_id=external_id, http_status=404)
            raise HTTPException(status_code=410, detail=_GONE_DETAIL) from None
        raise
    except ValidationError:
        alive = await okdesk.issue_exists(external_id)
        if alive is False:
            log.warning("okdesk_issue_gone", issue_id=issue_id,
                        external_id=external_id)
            raise HTTPException(status_code=410, detail=_GONE_DETAIL) from None
        raise


def _is_gone(exc: HTTPException) -> bool:
    """Это наш 410 «заявки больше нет»?"""
    return exc.status_code == 410


def _empty_parse_payload(note: str) -> dict[str, object]:
    """Валидный пустой разбор по фактам — контракт /parse не меняется."""
    return {
        "parsed": {}, "objects": [], "total": 0,
        "jamming_count": 0, "ok_count": 0,
        "telemetry": None, "verdict": None, "heuristic_category": None,
        "verdict_source": None, "spec_vehicle": False,
        "needs_remote_diagnostics": False, "is_aggregate": False,
        "note": note,
    }


def _empty_batch_payload(note: str) -> dict[str, object]:
    """Валидный пустой разбор по объектам — контракт /automate_batch не меняется."""
    return {
        "total": 0,
        "jamming_count": 0,
        "ok_count": 0,
        "is_aggregate": False,
        "objects": [],
        "note": note,
    }


def _failed_automate_payload(reasoning: str) -> dict[str, object]:
    """Валидный результат ИИ-разбора с needs_review — контракт /automate не меняется."""
    return {
        "parsed": {
            "plate": None, "date": None, "sheet_mileage_km": None,
            "declared_system_km": None, "llm_extracted": False,
        },
        "telemetry": {},
        "category": "Общий разбор",
        "confidence": 0.0,
        "draft_answer": "",
        "reasoning": reasoning,
        "needs_review": True,
        "error": "automation_failed",
        # Вердикта нет вообще — источник не указываем (не «rules» и не «ai»).
        "verdict_source": None,
        "heuristic_category": None,
    }


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
    digest, _ = await _build_comments_context(external_id, okdesk, max_chars)
    return digest


async def _build_comments_context(
    external_id: int, okdesk: OkdeskService, max_chars: int = 6000,
) -> tuple[str, list[tuple[str, str]] | None]:
    """Дайджест переписки для МОДЕЛИ + комментарии КЛИЕНТА для РАЗБОРА.

    Возвращает ``(digest, client_comments)``, где ``client_comments`` —
    ``[(дата комментария ISO, текст), …]`` только по авторам-контактам
    (``author.type == "contact"`` в сыром payload).

    Зачем отдельный список: дату/пробег неисправности можно брать ТОЛЬКО из слов
    клиента и только не позже его сообщения (65781 — «27.07.2026 питание было
    восстановлено» в НАШЕМ ответе поддержки становилось датой неисправности).
    Из строкового дайджеста этого не вытащить: роль и дату в нём не отличить от
    текста, а ISO-таймштампы разбор вычищает (``_scrub_iso_dates``).
    Дайджест для модели остаётся ПОЛНЫМ — она должна видеть всю переписку.
    """
    from app.services.issue_automation import _strip_html

    try:
        comments = await okdesk.get_issue_comments(external_id)
    except Exception:
        log.warning("automate_comments_fetch_failed", external_id=external_id)
        return "", []
    if not comments:
        return "", []

    # Recover timestamps from the raw payload (the parsed model drops them, same
    # as the /comments endpoint).
    raw_dates: dict[int, str] = {}
    raw_roles: dict[int, str] = {}
    _role_tags = {"contact": "клиент", "client": "клиент",
                  "employee": "сотрудник", "staff": "сотрудник",
                  "user": "сотрудник", "operator": "сотрудник"}
    _CLIENT_ROLE = "клиент"
    meta_ok = True
    try:
        raw = await okdesk._client.get_issue_comments(external_id)
        raw_rows = raw if isinstance(raw, list) else (
            raw.get("data") if isinstance(raw, dict) else None)
        for r in raw_rows or []:
            if isinstance(r, dict) and r.get("id") is not None:
                ts = r.get("published_at") or r.get("created_at")
                if ts:
                    raw_dates[r["id"]] = ts
                author = r.get("author")
                if isinstance(author, dict):
                    tag = _role_tags.get(str(author.get("type") or "").lower())
                    if tag:
                        raw_roles[r["id"]] = tag
    except Exception:
        log.warning("automate_comments_meta_failed", external_id=external_id)
        # Роли авторов не восстановились — отличить клиента от сотрудника нечем.
        # Отдаём None (а не пустой список): вызывающий разбор в этом случае
        # работает по прежней схеме (весь дайджест), а не считает, что клиент
        # молчал. Иначе сбой Okdesk молча ломал бы добор даты из переписки.
        meta_ok = False

    rows: list[tuple[str, str]] = []
    client_rows: list[tuple[str, str]] = []
    for c in comments:
        text = _strip_html(getattr(c, "content", None))
        if not text:
            continue
        author = (c.author.name if getattr(c, "author", None) else None) or "—"
        role = raw_roles.get(getattr(c, "id", None))
        if role:
            author = f"{author} [{role}]"
        raw_date = (getattr(c, "created_at", None)
                    or raw_dates.get(getattr(c, "id", None)) or "")
        date = str(raw_date)[:16].replace("T", " ")
        rows.append((date, f"{author} • {date} • {text}"))
        # Для разбора дат: только клиент и только с известной датой сообщения.
        if role == _CLIENT_ROLE and raw_date:
            client_rows.append((str(raw_date), text))
    if not rows:
        return "", ([] if meta_ok else None)
    # Chronological order (empty dates sort first, then ascending by timestamp).
    rows.sort(key=lambda r: r[0])
    client_rows.sort(key=lambda r: r[0])
    lines = [line for _, line in rows]
    digest = "\n".join(lines)
    if len(digest) > max_chars:
        digest = digest[:max_chars].rstrip() + "…"
    return digest, (client_rows if meta_ok else None)


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


# Обязательная тройка кастом-атрибутов Okdesk: без них заявку не перевести
# «В работе». Правится из карточки (POST /issues/{id}/parameters).
_EDITABLE_PARAM_CODES = ("address", "contact_person", "tel_person")


def _editable_parameters(params: list) -> list[dict[str, str]]:
    """Обязательная тройка по КОДАМ и с СЫРЫМИ значениями — для правки в карточке.

    Отдельно от ``_build_parameters``, потому что тот показывает параметры человеку
    и для этого их чистит: прячет короткие значения, выбрасывает непохожий на
    телефон ``tel_person`` и ДОБАВЛЯЕТ «Номер телефона», вытащенный из «Контактного
    лица». Для формы правки такая витрина врёт: поле выглядит заполненным, оператор
    его не трогает, а в Okdesk атрибут по-прежнему пуст — и заявка так же не идёт
    «В работе». Здесь отдаём ровно то, что лежит в Okdesk.
    """
    by_code = {getattr(p, "code", None): p for p in params or []}
    out: list[dict[str, str]] = []
    for code in _EDITABLE_PARAM_CODES:
        p = by_code.get(code)
        out.append({
            "code": code,
            "name": (getattr(p, "name", None) if p else None) or code,
            "value": str(getattr(p, "value", None) or "") if p else "",
        })
    return out


def _okdesk_portal_url(external_id: int | None = None) -> str | None:
    """Ссылка на заявку в портале Okdesk (кнопка «открыть в Okdesk»).

    Адрес портала известен только бэкенду — в ``OKDESK_BASE_URL`` лежит адрес API
    (``https://<домен>/api/v1``). Отрезаем API-хвост и собираем путь агента.
    Пустой/дефолтный домен → ``None``: лучше не показать кнопку, чем вести в никуда.
    """
    try:
        from app.core.okdesk.config import OkdeskSettings
        base = (OkdeskSettings().BASE_URL or "").strip()
    except Exception:
        return None
    base = re.sub(r"/api/v\d+/?$", "", base).rstrip("/")
    if not base or "your-domain" in base:
        return None
    return f"{base}/issues/{external_id}" if external_id is not None else base


async def _related_issues(cache: CacheService, parent_id: int | None,
                          child_ids: list[int]) -> list[dict[str, object]]:
    """Связанные заявки со статусом и темой (а не только id).

    Тянем из ЛОКАЛЬНОГО кэша заявок: Okdesk отдаёт в связях только id, а
    отдельный сетевой запрос на каждую дочернюю заявку — это N обращений при
    открытии карточки. Нет в кэше — отдаём одну строку с id (кликабельна, но без
    подписи), чтобы связь всё равно была видна.
    """
    out: list[dict[str, object]] = []
    wanted: list[tuple[int, str]] = []
    if parent_id is not None:
        wanted.append((parent_id, "parent"))
    wanted.extend((cid, "child") for cid in child_ids or [])
    for ext_id, role in wanted:
        row = None
        try:
            found = await cache.get_issues_from_cache(issue_id=ext_id)
            row = found[0] if found else None
        except Exception:
            log.warning("related_issue_lookup_failed", external_id=ext_id)
        out.append({
            "external_id": ext_id,
            "role": role,
            "subject": getattr(row, "subject", None),
            "status": getattr(row, "status", None),
            "url": _okdesk_portal_url(ext_id),
        })
    return out


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
                # Правимые из карточки поля (PATCH /issues/{id}/fields): приоритет
                # и плановая продолжительность. Имя приоритета берём из справочника
                # на фронте, здесь только код.
                "priority_code": live.priority.code if live.priority else None,
                "planned_execution_in_hours": live.planned_execution_in_hours,
                "type_name": live.type.name if live.type else None,
                "type_code": live.type.code if live.type else None,
                "author_name": live.author.name if live.author else None,
                "service_object_name": live.service_object.name if live.service_object else None,
                "parent_id": live.parent_id,
                "child_ids": live.child_ids,
                "related": await _related_issues(cache, live.parent_id, live.child_ids),
                "parameters": _build_parameters(live.parameters),
                # Та же тройка, но сырьём и по кодам — для формы правки.
                "editable_parameters": _editable_parameters(live.parameters),
                # Адрес заявки в портале Okdesk: домен знает только бэкенд.
                "okdesk_url": _okdesk_portal_url(row.external_id),
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
        live = await _live_issue(okdesk, external_id, issue_id)

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
        parsed = automation.parse_issue(live.title, live.description, None,
                                        created_at=live.created_at)
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
    plate: str | None = Query(None, description="Manual override of the vehicle plate (typo/wrong plate)"),
    date: str | None = Query(None, description="Manual override of the fault date (YYYY-MM-DD)"),
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
        live = await _live_issue(okdesk, external_id, issue_id)
        params = _build_parameters(live.parameters)
        attachments_text = ""
        if live.attachments:
            attachments_text = await automation.read_attachments(external_id, live.attachments)
        # Комментарии по заявке — свежие факты «с места» (оператор/клиент). ИИ
        # учитывает их: восстановленное питание → ответ о восстановлении (не
        # диагностика); ранее выданная диагностика без данных → выезд бригады.
        # Best-effort: любой сбой получения комментариев не должен ломать разбор.
        # client_comments — те же комментарии, но ТОЛЬКО клиентские и со своими
        # датами: из них разбор добирает дату неисправности (см.
        # _build_comments_context). Модель получает полный дайджест.
        comments_digest, client_comments = await _build_comments_context(
            external_id, okdesk)
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
            created_at=live.created_at,
            attachments_text=attachments_text or None,
            sender=sender,
            comments=comments_digest or None,
            client_comments=client_comments,
            example_provider=_example_provider,
            plate_override=plate,
            date_override=date,
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
        # Детерминированный срез того же прогона — в ОТДЕЛЬНЫЙ кэш фактов (kind
        # "parse"). Телеметрия уже собрана, повторных запросов нет; зато факты
        # переживут следующую инвалидацию ИИ-результата и отдадутся бесплатно.
        try:
            await cache.save_result_cache(
                external_id, "parse",
                # Тема/описание/текст вложений нужны строке, чтобы узнать ИМЯ акта,
                # откуда пришёл её номер: без них источник останется псевдо-«(из
                # текста заявки)» и правило сводности по форме письма ослепнет
                # (C4, класс 19).
                json.dumps(automation.facts_dict(
                    result, source_texts=(live.title, live.description,
                                          attachments_text or None)),
                           ensure_ascii=False))
        except Exception:
            log.warning("automate_facts_cache_save_failed", issue_id=issue_id)
        return result_dict
    except HTTPException as exc:
        if _is_gone(exc):
            # Заявки в Okdesk больше нет: разбирать нечего, но 410 здесь означал
            # бы для фронта «Ошибка анализа». Отдаём валидный пустой результат с
            # честной причиной. Кэш НЕ перезаписываем — прежний разбор ценнее.
            return _failed_automate_payload(
                f"{_GONE_NOTE}. Автоматический разбор невозможен.")
        raise
    except Exception:
        # Не валим запрос в 500 (фронт показывает «Ошибка анализа. Попробуйте
        # снова.» и теряет результат). Вместо этого отдаём валидный результат
        # разбора с needs_review=True и понятным reasoning, чтобы оператор увидел,
        # что произошло, и мог разобрать заявку вручную. Кейс 64196: непредвиденный
        # сбой в одном из вызовов (Okdesk/LLM/инструмент) ронял весь разбор.
        log.exception("automate_issue_failed", issue_id=issue_id)
        return _failed_automate_payload(
            "Не удалось выполнить автоматический разбор заявки из-за "
            "внутренней ошибки (сбой обращения к Okdesk/телеметрии/ИИ). "
            "Разберите заявку вручную или повторите попытку позже."
        )


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


@router.post("/{issue_id}/parse")
async def parse_issue_facts(
    issue_id: int,
    plate: str | None = Query(None, description="Manual override of the vehicle plate"),
    date: str | None = Query(None, description="Manual override of the fault date (YYYY-MM-DD)"),
    attachments: bool = Query(
        False, description="Читать вложения (OCR): дорого по CPU, только по кнопке"),
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """ДЕТЕРМИНИРОВАННЫЙ разбор: факты + предварительный вердикт БЕЗ DeepSeek.

    Работает для заявки ЛЮБОГО типа, где нашёлся гос.номер: regex-парсер + реальная
    телеметрия geo.gpspos.ru + лестница правил. Возвращает такую же таблицу строк
    (``objects``), как разбор по вложениям, — и для 1 ТС, и для N. Ни одного токена.
    По умолчанию вложения НЕ читаются (OCR запускается только с ``attachments=true``).
    """
    ocr_progress: dict[str, object] = {"complete": True, "attachments_total": 0,
                                       "attachments_done": 0, "pages_done": 0}
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        live = await _live_issue(okdesk, external_id, issue_id)
        params = _build_parameters(live.parameters)
        # Комментарии — бесплатный (для токенов) источник: у форвард-писем тело
        # лежит в первом комментарии, иначе номер/дата не найдутся.
        comments_digest, client_comments = await _build_comments_context(
            external_id, okdesk)
        payload = await automation.parse_facts(
            external_id, live.title, live.description, params,
            attachments=(live.attachments if attachments else None),
            comments=comments_digest or None,
            client_comments=client_comments,
            plate_override=plate, date_override=date,
            created_at=live.created_at,
            ocr_cache=cache,
            progress_out=(ocr_progress if attachments else None),
        )
        if attachments:
            # Тот же знаменатель, что в /automate_batch: подпись письма не
            # считается «недоделанным» вложением (класс 11).
            _discount_signature_attachments(ocr_progress, live.attachments)
        objects = payload.get("objects") or []
        if not objects:
            payload["note"] = (
                "Не удалось определить гос.номер по теме и тексту заявки. "
                "Укажите номер вручную или выполните разбор по вложениям."
            )
        company_name = getattr(issue_data["issue"], "company_name", None)
        payload["is_aggregate"] = _is_aggregate(company_name, live.description, objects)
        try:
            await cache.save_result_cache(external_id, "parse",
                                          json.dumps(payload, ensure_ascii=False))
        except Exception:
            log.warning("parse_cache_save_failed", issue_id=issue_id)
        return payload
    except HTTPException as exc:
        if _is_gone(exc):
            # Причина — в самой ноте, а не в общем «обработайте вручную».
            # В result_cache ничего не пишем: пустышка затёрла бы прежний разбор.
            return _empty_parse_payload(
                f"{_GONE_NOTE} — разбирать нечего.")
        raise
    except Exception:
        # Как и в automate_batch: отдаём валидный пустой разбор с пояснением,
        # а не 500 — оператор видит причину и работает вручную.
        log.exception("parse_issue_facts_failed", issue_id=issue_id)
        return _empty_parse_payload(
            "Не удалось выполнить разбор по фактам. Обработайте заявку вручную.")


@router.get("/{issue_id}/parse")
async def get_cached_parse(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Вернуть последний детерминированный разбор из кэша (без пересчёта).

    Переживает ИИ-прогон: kind ``parse`` отдельный от ``automate``.
    """
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        cached = await cache.get_result_cache(external_id, "parse")
        if not cached:
            return {"cached": False}
        return {"cached": True, "created_at": cached["created_at"], **cached["data"]}
    except HTTPException:
        raise
    except Exception:
        log.exception("get_cached_parse_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to read cached parse")


async def _cached_facts(cache: CacheService, external_id: int) -> dict | None:
    """Разбор из кэша: сначала полный ИИ-прогон, затем детерминированные факты.

    Оба kind несут одинаковые по форме поля ``parsed``/``telemetry``, поэтому
    потребители (шаблоны, трек) получают полный набор полей и когда ИИ-разбор
    сброшен/не запускался, а бесплатный разбор по фактам уже есть.
    """
    for kind in ("automate", "parse"):
        try:
            cached = await cache.get_result_cache(external_id, kind)
        except Exception:
            continue
        if cached and isinstance(cached.get("data"), dict):
            data = cached["data"]
            if data.get("parsed"):
                return data
    return None


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
            data = await _cached_facts(cache, external_id)
            if data:
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


async def _ocr_state(cache: CacheService, external_id: int, attachment_id: int,
                     extractable: bool) -> dict[str, object]:
    """Статус распознавания ОДНОГО вложения из кэша ``ocr:<att_id>``.

    ``status``: ``unavailable`` — текстового слоя нет (растровый скан, OCR его не
    берёт); ``done`` — прочитан полностью; ``partial`` — большой PDF дочитан до
    N-й страницы (``analyze_batch`` идёт порциями, чтобы не блокировать сервис);
    ``queued`` — ещё не читался.
    """
    if not extractable:
        return {"status": "unavailable", "pages_done": 0, "complete": False}
    try:
        cached = await cache.get_result_cache(external_id, f"ocr:{attachment_id}")
    except Exception:
        cached = None
    if not cached:
        return {"status": "queued", "pages_done": 0, "complete": False}
    d = cached.get("data") or {}
    pages = int(d.get("next") or 0)
    complete = bool(d.get("complete"))
    return {
        "status": "done" if complete else "partial",
        "pages_done": pages,
        "complete": complete,
    }


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
        live = await _live_issue(okdesk, external_id, issue_id)
        out: list[dict[str, object]] = []
        for a in live.attachments:
            name = a.attachment_file_name or ""
            extractable = attachment_reader.is_extractable(name)
            out.append({
                "id": a.id,
                "name": a.attachment_file_name,
                "size": a.attachment_file_size,
                "is_public": a.is_public,
                "kind": attachment_reader.kind(name),
                "extractable": extractable,
                # Что ИИ уже прочитал в ЭТОМ файле. Данные лежали в кэше
                # `ocr:<att_id>` и наружу не выходили: оператор видел «ИИ читает»
                # у файла, который распознан на 4 страницы из 6.
                "ocr": await _ocr_state(cache, external_id, a.id, extractable),
            })
        return out
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
        live = await _live_issue(okdesk, external_id, issue_id)
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


def _sync_head_with_single_row(parsed_out: dict[str, object],
                               objects: list[dict[str, object]]) -> None:
    """Свести шапку ``parsed`` с ЕДИНСТВЕННОЙ строкой разбора (класс 10, C3).

    Политика та же, что в ``IssueAutomationService.parse_facts`` (см. комментарий
    «Одна строка — синхронизируем сводный parsed с тем, что реально разобрано»),
    но с УСИЛЕНИЕМ: при одной строке значение СТРОКИ побеждает значение шапки, а
    не только добирает пустое. Шапку считает ``parse_issue`` по теме письма, где
    номер склеивается с датой («FW: акт Н 718 НВ29.07.26г» → Н718НВ29 вместо
    Н718НВ763), а строка приходит из текста акта — она точнее. Если строк
    несколько, шапку не досочиняем: сводить N строк в одну шапку смысла нет.

    TODO(уборка): объединить с версией в ``parse_facts`` — политика должна быть
    одна, сейчас она продублирована здесь, чтобы не трогать сервис.
    """
    if len(objects) != 1:
        return
    row = objects[0]
    for field in ("plate", "date", "sheet_mileage_km", "declared_system_km"):
        value = row.get(field)
        # Пустое значение строки шапку не «уточняет» — не затираем то, что
        # разобрано из темы/тела (иначе теряли бы дату при OCR без даты).
        if value is None or value == "":
            continue
        parsed_out[field] = value
    # Бейдж «номер подозрительный» фронт считает по шапке (IssueDetail.tsx), так
    # что пересчитываем его по итоговому номеру, а не по номеру из темы.
    parsed_out["plate_format_suspect"] = _plate_format_suspect(
        parsed_out.get("plate"))  # type: ignore[arg-type]


def _discount_signature_attachments(progress: dict[str, object],
                                    attachments: list[Any] | None) -> None:
    """Убрать из знаменателя ``ocr_progress`` картинки из подписи письма (класс 11).

    ``analyze_batch`` считает ``attachments_total`` до того, как отбросит
    ``image001.png`` (подпись Outlook), поэтому при полностью выполненном разборе
    оператор видел «1 из 2» (заявка 4931/66194: PDF акта + image001.jpg).
    Правим в обработчике, а не в сервисе: то же правило имени файла
    (``_SIGNATURE_IMAGE_RE``) применимо к ``live.attachments`` без каких-либо
    внутренних состояний OCR. Пропущенные остаются видны в
    ``attachments_skipped``, а знаменатель никогда не опускается ниже уже
    сделанного (в сервисе список вложений ещё и обрезан лимитом
    ``_BATCH_MAX_ATTACHMENTS``, так что вычитать «в слепую» нельзя).

    ``attachments_skipped`` значит «вложение в разбор не пошло» и складывается из
    ДВУХ причин, поэтому число здесь ПРИБАВЛЯЕМ, а не перезаписываем: сервис уже
    мог положить туда файлы, отрезанные лимитом (П4, класс 4). Отличить одно от
    другого можно по ``complete``: картинка подписи его не сбрасывает, а вот
    отрезанный лимитом файл — сбрасывает, потому что данные реально потеряны.
    """
    skipped = 0
    for att in attachments or []:
        name = (getattr(att, "attachment_file_name", None) or "").strip()
        if name and _SIGNATURE_IMAGE_RE.match(name):
            skipped += 1
    if not skipped:
        return
    total = progress.get("attachments_total")
    done = progress.get("attachments_done")
    prev = progress.get("attachments_skipped")
    progress["attachments_skipped"] = skipped + (prev if isinstance(prev, int) else 0)
    if isinstance(total, int) and isinstance(done, int):
        progress["attachments_total"] = max(total - skipped, done, 0)


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
        live = await _live_issue(okdesk, external_id, issue_id)
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
                                                     created_at=live.created_at,
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
        # Сводный `parsed` пакетный разбор раньше не отдавал вовсе, и фронт не мог
        # показать ни ярлык типа заявки, ни пометку «год исправлен» — они приходили
        # только через /parse. Считаем без единого сетевого вызова: parse_issue —
        # это regex по теме и телу.
        parsed_head = automation.parse_issue(live.title, live.description,
                                             created_at=live.created_at)
        parsed_out = asdict(parsed_head)
        parsed_out["plate_format_suspect"] = _plate_format_suspect(parsed_head.plate)
        parsed_out["issue_intent"] = next(
            (o.get("issue_intent") for o in objects if o.get("issue_intent")), None)
        # Шапка не должна расходиться со строкой таблицы (класс 10): при
        # единственной строке она показывает ЕЁ номер/дату/пробеги.
        _sync_head_with_single_row(parsed_out, objects)
        # «1 из 2» при complete=true — картинка из подписи письма в знаменателе.
        _discount_signature_attachments(ocr_progress, live.attachments)
        payload = {
            "parsed": parsed_out,
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
    except HTTPException as exc:
        if _is_gone(exc):
            # Причина — в ноте; кэш ("batch" хранит правки оператора) не трогаем.
            return _empty_batch_payload(
                f"{_GONE_NOTE} — разбирать нечего.")
        raise
    except Exception:
        # Last-resort guard: still return a usable payload rather than a 500 so
        # the operator sees a note instead of «Ошибка разбора».
        log.exception("automate_batch_failed", issue_id=issue_id)
        return _empty_batch_payload(
            "Не удалось выполнить разбор по объектам. Обработайте заявку вручную.")


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


# Латинские двойники → кириллица, чтобы «o006cx63» совпадал с «О006СХ63».
# Тот же маппинг, что в GpsposGeoService._norm_plate (эталон нормализации).
_PLATE_TRANSLIT = str.maketrans("ABEKMHOPCTYX", "АВЕКМНОРСТУХ")


def _norm_plate(p: object) -> str:
    return re.sub(r"[\s\-]", "", str(p or "")).upper().translate(_PLATE_TRANSLIT)


async def _objects_doc(cache: CacheService, external_id: int) -> tuple[str, dict]:
    """Документ разбора по объектам для ручных правок оператора.

    Приоритет — «batch» (разбор по вложениям, там уже могут быть правки), при его
    отсутствии — детерминированный «parse»: строки в нём того же формата, поэтому
    вердикт/номер правятся так же. Возвращает (kind, data)."""
    for kind in ("batch", "parse"):
        cached = await cache.get_result_cache(external_id, kind)
        if cached and (cached.get("data") or {}).get("objects"):
            return kind, cached["data"]
    raise HTTPException(status_code=400, detail="Сначала выполните разбор по вложениям")


def _mark_operator_touched(data: dict) -> None:
    """Пометить документ разбора как правленный вручную.

    Одиночная карточка показывает кэш «automate» — он богаче (уверенность,
    обоснование, черновик), — а все ручные правки уходят в «parse»: их видно до
    перезагрузки страницы, после неё таблица снова берёт automate и правка
    пропадает с экрана, хотя в кэше лежит. Флаг говорит фронту, что с этого
    момента авторитетен «parse». Альтернативы хуже: дублировать каждую правку в
    оба кэша — это ручное сопоставление полей (в automate вердикт зовётся
    `category`), а гонять разбор при каждом открытии карточки — лишняя работа
    на ровном месте."""
    data["operator_touched"] = True


@router.post("/{issue_id}/batch/verdict")
async def update_batch_verdict(
    issue_id: int,
    body: VerdictUpdate,
    request: Request,
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
    kind, data = await _objects_doc(cache, external_id)
    objects = data.get("objects") or []
    target = _norm_plate(body.plate)
    user = getattr(request.state, "user", None)
    edited_by = (user.get("u") if user else None)
    edited_at = _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")
    updated = 0
    for o in objects:
        if (_norm_plate(o.get("plate")) == target
                and (not body.file or o.get("file") == body.file)
                # Если дата передана — правим ТОЛЬКО строку этой даты (у одного ТС
                # за разные даты могут быть разные вердикты, 63617).
                and (not body.date or o.get("date") == body.date)):
            o["verdict"] = body.verdict
            o["verdict_edited"] = True
            # Вердикт больше не «правила» и не ИИ — это решение оператора.
            o["verdict_source"] = "operator"
            # Кто и когда переписал вердикт: пилюля «✎ оператор» без имени и
            # времени не даёт понять, стоит ли ей верить (правка могла быть
            # неделю назад и по старым данным).
            o["verdict_edited_by"] = edited_by
            o["verdict_edited_at"] = edited_at
            # Обоснование и черновик остались от ИИ и объясняли ДРУГОЙ вердикт —
            # снимаем, иначе текст спорит с пилюлей.
            o.pop("reasoning", None)
            o.pop("draft_answer", None)
            o.pop("confidence", None)
            updated += 1
    if not updated:
        raise HTTPException(status_code=404, detail="ТС не найдено в разборе")
    data["jamming_count"] = sum(1 for o in objects if o.get("verdict") == "Глушение")
    data["ok_count"] = sum(1 for o in objects if o.get("verdict") == "Данные верны")
    if kind == "parse" and len(objects) == 1:
        # Сводные поля одиночного разбора дублируют единственную строку.
        data["verdict"] = objects[0].get("verdict")
        data["verdict_source"] = objects[0].get("verdict_source")
    _mark_operator_touched(data)
    try:
        await cache.save_result_cache(external_id, kind, json.dumps(data, ensure_ascii=False))
    except Exception:
        log.warning("batch_verdict_save_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Не удалось сохранить вердикт")
    return {"ok": True, "updated": updated, **data}


@router.post("/{issue_id}/batch/ai")
async def batch_ai_verdicts(
    issue_id: int,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """ОДИН платный вызов ИИ на ВСЮ заявку: уверенность, обоснование и черновик
    ответа по КАЖДОМУ объекту разбора.

    До этого шага строки несли только вердикт правил: ``analyze_batch`` токенов не
    тратит, а ``automate`` умеет оценивать лишь один ТС и на пакетной заявке
    возвращал ``null``. Здесь модель получает факты всех строк разом.

    Ручные правки оператора не перезаписываются (``verdict_source == "operator"``),
    строки без телеметрии в модель не уходят — обосновывать нечего.
    """
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id
    kind, data = await _objects_doc(cache, external_id)
    objects: list[dict] = data.get("objects") or []
    try:
        live = await okdesk.get_issue(external_id)
        title, description = live.title, live.description
    except Exception:
        log.warning("batch_ai_live_fetch_failed", issue_id=issue_id)
        title, description = getattr(issue_data["issue"], "subject", None), None
    comments_digest = None
    try:
        comments_digest = await _build_comments_digest(external_id, okdesk)
    except Exception:
        log.warning("batch_ai_comments_failed", issue_id=issue_id)
    try:
        res = await automation.ai_batch_verdicts(
            objects, issue_title=title, issue_description=description,
            comments=comments_digest or None)
    except Exception:
        log.exception("batch_ai_failed", issue_id=issue_id)
        raise HTTPException(status_code=502, detail="ИИ не ответил. Попробуйте снова.")
    rows: dict[int, dict] = res.get("rows") or {}
    for idx, upd in rows.items():
        if not (0 <= idx < len(objects)):
            continue
        o = objects[idx]
        if upd.get("verdict"):
            o["verdict"] = upd["verdict"]
        # Источник меняем даже когда вердикт совпал с правилами: у строки теперь
        # ЕСТЬ обоснование и уверенность, а фронт по источнику решает, показывать
        # ли полосу доверия и блок «Почему такой вердикт».
        o["verdict_source"] = "ai"
        o["confidence"] = upd.get("confidence")
        o["reasoning"] = upd.get("reasoning")
        o["draft_answer"] = upd.get("draft_answer")
    data["jamming_count"] = sum(1 for o in objects if o.get("verdict") == "Глушение")
    data["ok_count"] = sum(1 for o in objects if o.get("verdict") == "Данные верны")
    # Метка «ИИ по этой заявке уже звали»: фронт по ней гасит платную кнопку и
    # показывает, когда именно был прогон.
    data["ai_called_at"] = _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")
    # Сводный ответ по всей заявке, написанный моделью (гос.номера уже сверены с
    # составом заявки в ai_batch_verdicts). Отдельно от per-object черновиков:
    # оператор выбирает, что вставить в поле ответа.
    data["ai_summary_answer"] = res.get("summary")
    notes = [n for n in (res.get("note"), res.get("summary_note")) if n]
    if notes:
        data["ai_note"] = " ".join(notes)
    else:
        data.pop("ai_note", None)
    if kind == "parse" and len(objects) == 1:
        # Сводные поля одиночного разбора идут за единственной строкой.
        row = objects[0]
        data["verdict"] = row.get("verdict")
        data["verdict_source"] = row.get("verdict_source")
        data["confidence"] = row.get("confidence")
        data["reasoning"] = row.get("reasoning")
        data["draft_answer"] = row.get("draft_answer")
    try:
        await cache.save_result_cache(external_id, kind, json.dumps(data, ensure_ascii=False))
    except Exception:
        log.warning("batch_ai_save_failed", issue_id=issue_id)
    return {"ok": True, "updated": len(rows), "sent": res.get("sent", 0),
            "skipped": res.get("skipped", 0), **data}


class DateUpdate(BaseModel):
    date: str                 # ISO YYYY-MM-DD: новая дата неисправности строки
    plate: str | None = None
    file: str | None = None
    old_date: str | None = None
    index: int | None = None  # точный селектор строки, как в PlateUpdate


@router.post("/{issue_id}/batch/date")
async def update_batch_date(
    issue_id: int,
    body: DateUpdate,
    cache: CacheService = Depends(get_cache_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Оператор исправляет ДАТУ неисправности в строке разбора — телеметрия и
    вердикт этой строки считаются заново за новую дату.

    Симметрично ``/batch/plate``: клиент так же часто путает дату, как и номер
    (в т.ч. опечатка года), а раньше дату можно было поправить только у одиночной
    заявки через полный платный ``automate``.
    """
    new_date = (body.date or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", new_date):
        raise HTTPException(status_code=400, detail="Дата должна быть в формате YYYY-MM-DD")
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id
    kind, data = await _objects_doc(cache, external_id)
    objects: list[dict] = data.get("objects") or []
    if body.index is not None and 0 <= body.index < len(objects):
        match_idx = [body.index]
    else:
        target = _norm_plate(body.plate) if body.plate else None
        match_idx = [
            i for i, o in enumerate(objects)
            if (target is None or _norm_plate(o.get("plate")) == target)
            and (not body.file or o.get("file") == body.file)
            and (not body.old_date or o.get("date") == body.old_date)
        ]
    updated = 0
    for i in match_idx:
        o = objects[i]
        plate = o.get("plate")
        if not plate:
            # Без номера искать в гео нечего — сначала впишите гос.номер.
            raise HTTPException(status_code=400,
                                detail="Сначала укажите гос.номер в этой строке")
        try:
            fresh = await automation._analyze_object(
                str(plate), new_date, o.get("sheet_mileage_km"),
                o.get("address"), o.get("file") or "",
                declared=o.get("declared_system_km"),
                # Оператор правит НАЧАЛО интервала — конец у строки остаётся её
                # собственным, иначе многодневная жалоба схлопнется в одни сутки
                # (C4, классы 12, 13). Дату оператора днём отправки не считаем.
                date_to=o.get("date_to"),
            )
        except Exception:
            log.warning("batch_date_reanalyze_failed", issue_id=issue_id, date=new_date)
            raise HTTPException(status_code=502, detail="Не удалось перепроверить ТС в гео")
        fresh["plate_edited"] = bool(o.get("plate_edited"))
        fresh["date_edited"] = True
        objects[i] = fresh
        updated += 1
    if not updated:
        raise HTTPException(status_code=404, detail="Строка не найдена в разборе")
    data["total"] = len(objects)
    data["jamming_count"] = sum(1 for o in objects if o.get("verdict") == "Глушение")
    data["ok_count"] = sum(1 for o in objects if o.get("verdict") == "Данные верны")
    if kind == "parse" and len(objects) == 1:
        row = objects[0]
        data["verdict"] = row.get("verdict")
        data["verdict_source"] = row.get("verdict_source")
        data["telemetry"] = row.get("telemetry")
        data["heuristic_category"] = row.get("heuristic_category")
        parsed0 = data.get("parsed")
        if isinstance(parsed0, dict):
            parsed0["date"] = row.get("date")
    _mark_operator_touched(data)
    try:
        await cache.save_result_cache(external_id, kind, json.dumps(data, ensure_ascii=False))
    except Exception:
        log.warning("batch_date_save_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Не удалось сохранить дату")
    return {"ok": True, "updated": updated, **data}


class PlateUpdate(BaseModel):
    old_plate: str
    new_plate: str
    file: str | None = None
    date: str | None = None  # ISO — правим строку конкретной даты, а не все строки ТС
    index: int | None = None  # точный индекс строки в objects: нужен для строк БЕЗ
                              # номера (несколько нераспознанных актов с одной датой
                              # в одном файле имеют одинаковый ключ date+file)


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
    kind, data = await _objects_doc(cache, external_id)
    objects: list[dict] = data.get("objects") or []
    target = _norm_plate(body.old_plate)
    # Точный индекс строки (если передан и валиден) — единственный надёжный селектор
    # для строк без номера. Иначе матчим по (old_plate, date, file).
    if body.index is not None and 0 <= body.index < len(objects):
        match_idx = [body.index]
    else:
        match_idx = [
            i for i, o in enumerate(objects)
            if _norm_plate(o.get("plate")) == target
            and (not body.file or o.get("file") == body.file)
            and (not body.date or o.get("date") == body.date)
        ]
    updated = 0
    for i in match_idx:
        o = objects[i]
        # Перепроверка в гео по верному номеру: дату/ПЛ/заявл.систему/адрес/файл
        # берём из этой же строки, телеметрию и вердикт считаем заново.
        try:
            fresh = await automation._analyze_object(
                new_plate, o.get("date"), o.get("sheet_mileage_km"),
                o.get("address"), o.get("file") or "",
                declared=o.get("declared_system_km"),
                # Номер сменился, интервал строки — нет (C4, классы 12, 13).
                date_to=o.get("date_to"),
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
    if kind == "parse" and len(objects) == 1:
        # Сводные поля одиночного разбора идут за единственной строкой.
        row = objects[0]
        data["verdict"] = row.get("verdict")
        data["verdict_source"] = row.get("verdict_source")
        data["telemetry"] = row.get("telemetry")
        data["heuristic_category"] = row.get("heuristic_category")
        parsed0 = data.get("parsed")
        if isinstance(parsed0, dict):
            parsed0["plate"] = row.get("plate")
    _mark_operator_touched(data)
    try:
        await cache.save_result_cache(external_id, kind, json.dumps(data, ensure_ascii=False))
    except Exception:
        log.warning("batch_plate_save_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Не удалось сохранить гос.номер")
    return {"ok": True, "updated": updated, **data}


class MileageUpdate(BaseModel):
    index: int | None = None  # точный селектор строки, как в PlateUpdate/DateUpdate
    plate: str | None = None  # фолбэк-селектор, когда индекс строки неизвестен
    date: str | None = None
    file: str | None = None
    sheet_mileage_km: float | None = None    # колонка «ПЛ»: путевой лист/одометр
    declared_system_km: float | None = None  # колонка «ГЛОНАСС заявл.»: со слов клиента
    # None в теле означает «поле не передано, не менять», поэтому стереть ошибочно
    # распознанную цифру в null иначе нечем — нужны явные флаги.
    clear_sheet: bool = False
    clear_declared: bool = False


# Верхняя граница суточного пробега: за сутки ТС физически не проедет 100 000 км,
# такое число — всегда промах OCR или лишние нули, набранные оператором.
_MAX_DAILY_KM = 100_000.0


def _telemetry_from_row(raw: object) -> TelemetryFacts | None:
    """Собрать ``TelemetryFacts`` обратно из строки разбора (там лежит ``asdict``).

    Ключи dict совпадают с полями dataclass один в один, но кэш переживает деплои:
    строка, разобранная старой версией, не знает новых полей, а строка из более
    новой принесёт лишние — прямой ``TelemetryFacts(**raw)`` на такой упал бы
    TypeError и уронил бы правку цифр. Поэтому фильтруем по актуальному набору
    полей; недостающие берут значения по умолчанию."""
    if not isinstance(raw, dict) or not raw:
        return None
    known = {f.name for f in _dc_fields(TelemetryFacts)}
    try:
        return TelemetryFacts(**{k: v for k, v in raw.items() if k in known})
    except Exception:
        return None


@router.post("/{issue_id}/batch/mileage")
async def update_batch_mileage(
    issue_id: int,
    body: MileageUpdate,
    cache: CacheService = Depends(get_cache_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Оператор исправляет ПРОБЕГ в строке разбора (ПЛ и/или заявленный клиентом
    по ГЛОНАСС) — вердикт строки пересчитывается по этим цифрам.

    OCR регулярно перевирает пробег в акте, и вердикт правил считается по мусору.
    Раньше оператору оставалось только вручную переставить вердикт: исходная цифра
    в таблице оставалась неверной, а обоснование с ней не сходилось.

    В ОТЛИЧИЕ от ``/batch/plate`` и ``/batch/date`` гео здесь НЕ дёргаем: пробег из
    акта — данные клиента, телеметрия от них не зависит, а лишний поход в гео стоит
    времени и способен уронить строку в 502 на ровном месте. Вердикт пересчитываем
    из УЖЕ сохранённой в строке телеметрии."""
    if (body.sheet_mileage_km is None and body.declared_system_km is None
            and not body.clear_sheet and not body.clear_declared):
        raise HTTPException(status_code=400, detail="Не передано ни одного значения")
    for value in (body.sheet_mileage_km, body.declared_system_km):
        if value is None:
            continue
        if value < 0:
            raise HTTPException(status_code=400, detail="Пробег не может быть отрицательным")
        if value > _MAX_DAILY_KM:
            raise HTTPException(
                status_code=400,
                detail=f"Пробег за сутки не может быть больше {int(_MAX_DAILY_KM)} км — проверьте цифру")
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id
    kind, data = await _objects_doc(cache, external_id)
    objects: list[dict] = data.get("objects") or []
    if body.index is not None and 0 <= body.index < len(objects):
        match_idx = [body.index]
    else:
        target = _norm_plate(body.plate) if body.plate else None
        match_idx = [
            i for i, o in enumerate(objects)
            if (target is None or _norm_plate(o.get("plate")) == target)
            and (not body.file or o.get("file") == body.file)
            and (not body.date or o.get("date") == body.date)
        ]
    updated = 0
    for i in match_idx:
        o = objects[i]
        # clear_* сильнее значения: явное «стереть» не должно зависеть от того,
        # прислал ли клиент заодно старое число в том же поле.
        if body.clear_sheet:
            o["sheet_mileage_km"] = None
        elif body.sheet_mileage_km is not None:
            o["sheet_mileage_km"] = body.sheet_mileage_km
        if body.clear_declared:
            o["declared_system_km"] = None
        elif body.declared_system_km is not None:
            o["declared_system_km"] = body.declared_system_km
        # Маркер ручной правки цифр — по образцу plate_edited/date_edited: в таблице
        # видно, что число пришло не из OCR.
        o["mileage_edited"] = True
        updated += 1
        if o.get("verdict_source") == "operator":
            # Вердикт уже переставлен оператором осознанно — цифры чиним, но его
            # решение молча перебивать пересчётом нельзя.
            continue
        t = _telemetry_from_row(o.get("telemetry"))
        if t is None:
            # Телеметрии в строке нет (объект не искали или гео не ответило) —
            # пересчитывать вердикт не из чего, оставляем прежний.
            continue
        o["verdict"] = IssueAutomationService._verdict_from_facts(
            t, o.get("sheet_mileage_km"), o.get("declared_system_km"),
            bool(o.get("spec_vehicle")))
        # Вторая эвристика тоже зависит от ПЛ (issue_automation.py:1507) и уходит в
        # промпт как «подсказка_эвристики» — оставить её от старых цифр значит
        # подсунуть модели устаревшую подсказку в следующем платном прогоне.
        # Сети не требует: считается из той же телеметрии.
        o["heuristic_category"] = automation._heuristic_category(
            ParsedIssue(plate=o.get("plate"), date=o.get("date"),
                        sheet_mileage_km=o.get("sheet_mileage_km")), t)
        o["verdict_source"] = "rules"
        # Обоснование, черновик и уверенность объясняли вердикт по СТАРЫМ цифрам —
        # снимаем, иначе текст спорит с пересчитанной таблицей.
        o.pop("reasoning", None)
        o.pop("draft_answer", None)
        o.pop("confidence", None)
    if not updated:
        raise HTTPException(status_code=404, detail="Строка не найдена в разборе")
    data["total"] = len(objects)
    data["jamming_count"] = sum(1 for o in objects if o.get("verdict") == "Глушение")
    data["ok_count"] = sum(1 for o in objects if o.get("verdict") == "Данные верны")
    if kind == "parse" and len(objects) == 1:
        _mirror_parse_root(data, objects)
        parsed0 = data.get("parsed")
        if isinstance(parsed0, dict):
            # Шапка одиночного разбора дублирует строку: без этого рядом с
            # исправленной таблицей остались бы старые цифры OCR.
            parsed0["sheet_mileage_km"] = objects[0].get("sheet_mileage_km")
            parsed0["declared_system_km"] = objects[0].get("declared_system_km")
    _mark_operator_touched(data)
    try:
        await cache.save_result_cache(external_id, kind, json.dumps(data, ensure_ascii=False))
    except Exception:
        log.warning("batch_mileage_save_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Не удалось сохранить пробег")
    return {"ok": True, "updated": updated, **data}


class RowAdd(BaseModel):
    plate: str
    date: str                 # ISO YYYY-MM-DD: дата неисправности новой строки
    file: str | None = None   # имя акта, если оператор знает, откуда строка


class RowDelete(BaseModel):
    index: int                # точный селектор строки, как в PlateUpdate/DateUpdate
    # Снимок строки с экрана оператора: сверяем перед удалением, чтобы не снести
    # соседнюю строку, если список успел перестроиться в другой вкладке.
    plate: str | None = None
    date: str | None = None
    file: str | None = None


def _mirror_parse_root(data: dict, objects: list[dict]) -> None:
    """Свести корневые поля одиночного разбора («parse») к ПЕРВОЙ строке.

    В kind == "parse" корень дублирует данные первой строки, и часть фронта читает
    именно его. Правки вердикта/номера меняют строку на месте, поэтому им хватает
    зеркалирования при единственной строке; добавление и удаление меняют САМ СОСТАВ
    и порядок строк, поэтому корень надо переклеивать всегда, пока строки есть:
    иначе после удаления первой строки в корне остались бы вердикт и телеметрия
    уже удалённого ТС."""
    if not objects:
        return
    row = objects[0]
    data["verdict"] = row.get("verdict")
    data["verdict_source"] = row.get("verdict_source")
    data["telemetry"] = row.get("telemetry")
    data["heuristic_category"] = row.get("heuristic_category")
    parsed0 = data.get("parsed")
    if isinstance(parsed0, dict):
        parsed0["plate"] = row.get("plate")
        parsed0["date"] = row.get("date")


@router.post("/{issue_id}/batch/row")
async def add_batch_row(
    issue_id: int,
    body: RowAdd,
    cache: CacheService = Depends(get_cache_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Оператор добавляет в разбор строку, которой там нет: OCR не увидел акт, либо
    ТС названо только в тексте письма или комментарии.

    Вердикт по новой строке считает система (правила по фактам гео), поэтому
    ``verdict_source`` остаётся «rules»: человек задал только номер и дату, решение
    приняла машина — пилюля «✎ оператор» здесь была бы обманом."""
    plate = (body.plate or "").strip()
    if not plate:
        raise HTTPException(status_code=400, detail="Гос.номер пуст")
    new_date = (body.date or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", new_date):
        raise HTTPException(status_code=400, detail="Дата должна быть в формате YYYY-MM-DD")
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id
    kind, data = await _objects_doc(cache, external_id)
    objects: list[dict] = data.get("objects") or []
    target = _norm_plate(plate)
    # Ключ строки разбора — (номер, дата), как при дедупликации в analyze_batch:
    # один ТС за одну дату разбирается один раз, поэтому повтор — это почти всегда
    # случайный второй клик, а не второй акт.
    if any(_norm_plate(o.get("plate")) == target and o.get("date") == new_date
           for o in objects):
        raise HTTPException(status_code=400, detail="Такая строка уже есть в разборе")
    try:
        fresh = await automation._analyze_object(
            plate, new_date, None, None, body.file or "", declared=None)
    except Exception:
        log.warning("batch_row_add_failed", issue_id=issue_id, plate=plate, date=new_date)
        raise HTTPException(status_code=502, detail="Не удалось проверить ТС в гео")
    # Единственный признак «строку завёл оператор»: в актах её нет, и при следующем
    # форс-разборе вложений она исчезнет — UI обязан отличать её от строк OCR.
    fresh["manual_row"] = True
    objects.append(fresh)
    data["objects"] = objects
    data["total"] = len(objects)
    data["jamming_count"] = sum(1 for o in objects if o.get("verdict") == "Глушение")
    data["ok_count"] = sum(1 for o in objects if o.get("verdict") == "Данные верны")
    if kind == "parse":
        _mirror_parse_root(data, objects)
    _mark_operator_touched(data)
    try:
        await cache.save_result_cache(external_id, kind, json.dumps(data, ensure_ascii=False))
    except Exception:
        log.warning("batch_row_add_save_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Не удалось сохранить строку")
    return {"ok": True, "updated": 1, **data}


@router.post("/{issue_id}/batch/row/delete")
async def delete_batch_row(
    issue_id: int,
    body: RowDelete,
    cache: CacheService = Depends(get_cache_service),
) -> dict[str, object]:
    """Оператор убирает из разбора лишнюю строку: OCR распознал дубль акта или
    вытащил ТС, которого в заявке нет.

    Удаление НЕ запоминается: следующий форс-прогон ``/automate_batch`` или
    ``/parse`` вернёт строку, если она снова найдётся во вложениях. Это осознанно —
    список строк остаётся производным от актов, а не отдельным состоянием, которое
    пришлось бы синхронизировать; чинить надо сам акт или номер в строке."""
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id
    kind, data = await _objects_doc(cache, external_id)
    objects: list[dict] = data.get("objects") or []
    if not (0 <= body.index < len(objects)):
        raise HTTPException(status_code=404, detail="Строка не найдена в разборе")
    # Пустой objects _objects_doc считает отсутствующим разбором, и добавить строку
    # обратно через /batch/row стало бы уже некуда — перезапуск разбора дешевле.
    if len(objects) == 1:
        raise HTTPException(
            status_code=400,
            detail="Нельзя удалить единственную строку разбора — используйте «Обновить разбор»")
    row = objects[body.index]
    # Индекс сам по себе ненадёжен: список мог перестроиться в другой вкладке
    # (правка номера, повторный разбор), и оператор удалил бы не ту строку.
    if ((body.plate is not None and _norm_plate(row.get("plate")) != _norm_plate(body.plate))
            or (body.date is not None and row.get("date") != body.date)
            or (body.file is not None and (row.get("file") or "") != body.file)):
        raise HTTPException(status_code=409, detail="Строка изменилась, обновите разбор")
    objects.pop(body.index)
    data["objects"] = objects
    data["total"] = len(objects)
    data["jamming_count"] = sum(1 for o in objects if o.get("verdict") == "Глушение")
    data["ok_count"] = sum(1 for o in objects if o.get("verdict") == "Данные верны")
    if kind == "parse":
        _mirror_parse_root(data, objects)
    _mark_operator_touched(data)
    try:
        await cache.save_result_cache(external_id, kind, json.dumps(data, ensure_ascii=False))
    except Exception:
        log.warning("batch_row_delete_save_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Не удалось сохранить разбор")
    return {"ok": True, "updated": 1, **data}


class AiFeedbackBody(BaseModel):
    rating: str  # 'good' | 'bad'
    error_kind: str | None = None  # 'wrong_verdict' | 'wrong_plate' | 'wrong_date' | 'wrong_mileage' | 'other'
    comment: str | None = None
    correct_category: str | None = None
    # Чей разбор оценивают: 'rules' (бесплатный разбор правилами), 'ai' (отвечал
    # DeepSeek), 'operator' (строку переписали руками). Фронт присылает источник
    # вердикта выбранной строки; старые записи без источника считаем 'ai'.
    verdict_source: str | None = None


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
    """Оценка оператором качества разбора: 'good' (верно) / 'bad' (ошибка)+комментарий.

    Оценивать можно ЛЮБОЙ разбор, а не только платный прогон DeepSeek: дефекты
    даты/номера/пробега чаще всего рождаются в бесплатном разборе по правилам, и
    без оценки о них было некуда сообщить. Чей разбор оценили — в
    ``verdict_source``."""
    if body.rating not in ("good", "bad"):
        raise HTTPException(status_code=400, detail="rating must be 'good' or 'bad'")
    if body.verdict_source is not None and body.verdict_source not in ("rules", "ai", "operator"):
        raise HTTPException(status_code=400, detail="verdict_source must be 'rules', 'ai' or 'operator'")
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
        verdict_source=body.verdict_source,
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
    scope: str = Query("all", description="'all' — один текст по всем объектам, "
                                         "'object' — только по выбранному ТС"),
    index: int | None = Query(None, description="Индекс строки разбора для scope=object"),
    plate: str | None = Query(None, description="Гос.номер строки для scope=object"),
    date: str | None = Query(None, description="ISO-дата строки для scope=object"),
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
) -> dict[str, object]:
    """Ответ клиенту ПО ПРАВИЛАМ — без единого обращения к модели.

    ``scope=all``    — один текст по всем объектам: гос.номера группируются по
    вердикту в КОДЕ (модель на этом путалась, 64435), формулировки готовые.
    ``scope=object`` — текст по одной строке разбора из шаблона её категории
    (``_CATEGORY_CATALOG``) с подставленными датой и реальным пробегом.

    Раньше метод жил только под агрегатные (ОДКР) заявки и звался из чипа
    «черновик ИИ», хотя модель тут не участвует. Теперь доступен любой заявке и
    подписан честно.
    """
    try:
        issue_data = await cache.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        external_id = issue_data["issue"].external_id
        company_name = getattr(issue_data["issue"], "company_name", None)

        # Разбор берём из того же документа, что и ручные правки оператора:
        # сначала batch, затем детерминированный parse (одиночная заявка).
        objects: list[dict] = []
        for kind in ("batch", "parse"):
            cached = await cache.get_result_cache(external_id, kind)
            if cached and (cached.get("data") or {}).get("objects"):
                objects = cached["data"]["objects"]
                break
        if not objects:
            live = await _live_issue(okdesk, external_id, issue_id)
            objects = await automation.analyze_batch(external_id, live.attachments,
                                                     issue_title=live.title,
                                                     issue_description=live.description,
                                                     ocr_cache=cache,
                                                     created_at=live.created_at)
        if not objects:
            raise HTTPException(status_code=400,
                                detail="Сначала выполните разбор — по чему составлять ответ")

        if scope == "object":
            row = None
            if index is not None and 0 <= index < len(objects):
                row = objects[index]
            elif plate:
                target = _norm_plate(plate)
                row = next((o for o in objects
                            if _norm_plate(o.get("plate")) == target
                            and (not date or o.get("date") == date)), None)
            if row is None:
                raise HTTPException(status_code=404, detail="Строка разбора не найдена")
            return {"answer": automation.rules_answer_for_object(row),
                    "scope": "object", "source": "rules", "linked_count": 0}

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
        return {"answer": answer, "scope": "all", "source": "rules",
                "linked_count": len(prior)}
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


# Маркер в описании дочерней заявки, созданной нашим сплиттером (см. ниже).
_CHILD_MARK = "создано из общей заявки"
# Кандидатов на «такой ребёнок уже есть» ищем в ЛОКАЛЬНОМ кэше по ровному
# совпадению темы с гос.номером. Окно и лимит держат цену проверки в 0-2 запросах
# к Okdesk: замер по базе (599 номеров) — точное совпадение плюс 45 дней даёт
# максимум 6 кандидатов, у 80% номеров их 0 или 1.
_CHILD_LOOKUP_DAYS = 45
_CHILD_LOOKUP_LIMIT = 6


def _child_body(desc: str) -> str:
    """Тело описания дочерней заявки БЕЗ хвоста «(создано из общей заявки #…)».

    Родитель у дубля другой, поэтому сравнивать описания целиком нельзя."""
    return desc.split(f"({_CHILD_MARK}")[0].strip()


async def _existing_child(cache: CacheService, okdesk: OkdeskService,
                          plate: str | None, date_ru: str, body: str) -> int | None:
    """Внешний id уже созданного ребёнка с той же парой (гос.номер, дата).

    Класс 18 сессии C4: клиент дважды прислал одно письмо («Заявка 156»: 65762 в
    08:30 и 65764 в 08:44), и сплиттер создал из ОБОИХ родителей одинаковых детей
    (4555/65800 и 4560/65804, К690ОК за 22.07). Проверка дешёвая: у ребёнка в
    локальном `issue_cache` тема РОВНО равна гос.номеру, а дата неисправности
    лежит только в описании (в кэше оно пустое) — описание берём живьём из
    Okdesk и только у отобранных кандидатов. Best-effort: любая осечка проверки
    не мешает создать заявку.

    Пары (номер, дата) для дубля НЕ достаточно: после починки класса 5 у одного
    ТС за один день бывает ДВА путевых листа (4880 М790ЕА: №ТР139 129/0 и №ТР138
    227/158) — это две законные дочерние заявки. Поэтому дублем считаем только
    полное совпадение тела описания (номер, дата И цифры пробега).
    """
    if not plate or not date_ru or date_ru == "—":
        return None
    # Ищем по НОРМАЛИЗОВАННОМУ номеру: LIKE в SQLite регистронезависим только для
    # латиницы, поэтому «к690ок» и латинское «K690OK» без нормализации кандидата
    # не находят. Тема ребёнка пишется тем же нормализованным номером.
    want = _norm_plate(plate)
    try:
        rows = await cache.get_issues_from_cache(search=want)
    except Exception:
        log.warning("child_dup_lookup_failed", plate=plate)
        return None
    # created_at в кэше — МСК-wall-clock, utcnow отстаёт на 3 часа; на окне в 45
    # дней это неважно, а дата неисправности у настоящего дубля всегда свежая.
    edge = _dt.datetime.utcnow() - _dt.timedelta(days=_CHILD_LOOKUP_DAYS)
    cands = [r for r in rows
             if _norm_plate(getattr(r, "subject", None)) == want
             and (getattr(r, "created_at", None) or edge) >= edge]
    cands.sort(key=lambda r: getattr(r, "created_at", None) or edge, reverse=True)
    for row in cands[:_CHILD_LOOKUP_LIMIT]:
        try:
            live = await okdesk.get_issue(row.external_id)
        except Exception:
            continue
        desc = getattr(live, "description", None) or ""
        if _CHILD_MARK not in desc or f"Дата неисправности: {date_ru}" not in desc:
            continue
        if _child_body(desc) == body:
            return row.external_id
        log.info("child_same_plate_other_act", plate=plate, date=date_ru,
                 existing_id=row.external_id)
    return None


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
        parent = await _live_issue(okdesk, external_id, issue_id)
        contact_id = parent.contact.id if parent.contact else None
        # Ответственного дочерней наследуем от родительской заявки.
        parent_assignee_id = parent.assignee.id if getattr(parent, "assignee", None) else None

        created = []
        # Описания детей, созданных в ЭТОМ запросе: второй раз тот же ребёнок не
        # создаётся даже внутри одного вызова (класс 18 сессии C4).
        done: dict[str, int] = {}
        # Пометки строк разбора берём из КЭША, а не из тела запроса: фронт их не
        # присылает, а в описание ребёнка (оно уходит в Okdesk и его видит клиент)
        # нельзя подставлять пробег, накрученный прострелами трека (класс 10), и
        # нельзя обещать удалённую диагностику по терминалу, который молчит
        # месяцами (класс 22). Сессия C4, решения интервью 4.
        row_marks: dict[tuple[str, str], set[str]] = {}
        for _kind in ("batch", "parse"):
            try:
                _cached = await cache.get_result_cache(external_id, _kind)
            except Exception:
                continue
            _data = (_cached or {}).get("data")
            if not isinstance(_data, dict):
                continue
            for _o in _data.get("objects") or []:
                _marks = (set(_o.get("flags") or ()) | set(_o.get("warnings") or ())
                          | set((_o.get("telemetry") or {}).get("flags") or ()))
                if _marks:
                    _key = (_norm_plate(_o.get("plate")) or "", str(_o.get("date") or ""))
                    row_marks.setdefault(_key, set()).update(_marks)
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
            marks = row_marks.get(
                (_norm_plate(obj.plate) or "", str(obj.date or "")), frozenset())
            if obj.verdict == "Нет данных":
                cause = ("Терминал не выходит на связь задолго до даты неисправности — "
                         "требуется проверка оборудования на месте, удалённой диагностикой "
                         "данные не восстановить. "
                         if "tracker_silent" in marks else
                         "Нет данных от терминала за дату — требуется удалённая диагностика. ")
                desc = (
                    f"Расхождение пробега. Дата неисправности: {date_ru}. "
                    f"{cause}"
                    f"(создано из общей заявки #{external_id})"
                )
            else:
                # Цифру пробега подставляем ТОЛЬКО когда ей можно верить.
                sys_txt = ("не показателен (трек рваный, прострелы координат)"
                           if "mileage_unreliable" in marks
                           else f"{obj.system_mileage_km if obj.system_mileage_km is not None else '—'} км")
                desc = (
                    f"Расхождение пробега. Дата неисправности: {date_ru}. "
                    f"По системе {sys_txt}, "
                    f"путевой лист {obj.sheet_mileage_km if obj.sheet_mileage_km is not None else '—'} км. "
                    f"(создано из общей заявки #{external_id})"
                )
            # Дубль ребёнка (класс 18): такой же ребёнок уже создан — в этом же
            # запросе или из другого родителя (клиент прислал письмо дважды).
            # Ничего не создаём и не меняем, а отдаём ссылку на существующую заявку.
            body_key = _child_body(desc)
            dup_id = done.get(body_key)
            if dup_id is None:
                dup_id = await _existing_child(cache, okdesk, obj.plate, date_ru, body_key)
            if dup_id is not None:
                created.append({
                    "plate": obj.plate, "issue_id": dup_id, "ok": True,
                    "existing": True, "url": _okdesk_portal_url(dup_id),
                    "note": (f"Дочерняя заявка на {obj.plate} за {date_ru} уже есть "
                             f"— #{dup_id}, повторно не создаём"),
                })
                continue
            try:
                child = await okdesk.create_child_issue(
                    external_id, title, desc, address=obj.address, contact_id=contact_id,
                )
                created.append({"plate": obj.plate, "issue_id": child.id, "ok": True})
                done[body_key] = child.id
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

        # `existing` считаем отдельно: это НЕ созданная и НЕ провалившаяся строка
        # (класс 18) — фронт получает по ней ссылку на уже существующего ребёнка.
        existing_n = sum(1 for c in created if c.get("existing"))
        ok = sum(1 for c in created if c["ok"] and not c.get("existing"))
        failed = sum(1 for c in created if not c["ok"])
        return {"ok": True, "created": ok, "existing": existing_n,
                "failed": failed, "results": created}
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
        # Приоритет — номер/дата из сохранённого ИИ-анализа: он учитывает РУЧНУЮ
        # правку оператора (64838: клиент ошибся в номере, но опечатка совпала с
        # чужим реальным ТС), LLM-извлечение и alt-plate. Иначе независимый парс
        # трека взял бы исходный (неверный) номер из темы и построил трек по
        # чужому объекту, расходясь с анализом.
        try:
            data0 = await _cached_facts(cache, external_id)
            if data0:
                cp = data0.get("parsed") or {}
                cplate, cdate = cp.get("plate"), cp.get("date")
                if isinstance(cplate, str) and cplate and isinstance(cdate, str) and cdate:
                    return await automation.build_track(
                        "", "", plate=cplate, fault_date=cdate[:10],
                        date_from=date_from, date_to=date_to)
        except Exception:
            log.warning("track_prefer_automate_failed", issue_id=issue_id)
        live = await _live_issue(okdesk, external_id, issue_id)
        attachments_text = ""
        if live.attachments:
            attachments_text = await automation.read_attachments(external_id, live.attachments)
        # Пустое description: тело письма нередко лежит в первом комментарии
        # (64871) — подтягиваем комментарии и отдаём их текст парсеру, чтобы
        # гос.номер из тела письма находился.
        comments_text = ""
        if not (live.description or "").strip():
            from app.services.issue_automation import _scrub_iso_dates

            # Без ISO-таймштампов публикации — иначе дата первого комментария
            # подхватилась бы парсером как «дата неисправности».
            comments_text = _scrub_iso_dates(
                await _build_comments_digest(external_id, okdesk))
        extra_text = "\n".join(t for t in (attachments_text, comments_text) if t) or None
        result = await automation.build_track(
            live.title, live.description, attachments_text=extra_text,
            created_at=live.created_at,
            date_from=date_from, date_to=date_to,
        )
        # The independent single-plate parse in build_track sometimes fails where
        # automate() succeeds: automate has an LLM-extraction fallback (e.g. the
        # fault date hidden in an HTML table — issue 64196). When the parse can't
        # produce a clean plate+date, reuse the plate/date the AI already found
        # (cached automate result) so the track panel matches the AI analysis.
        if isinstance(result, dict) and result.get("error") in (
                "no_plate_or_date", "no_plate", "no_date"):
            # То, что build_track УЖЕ распарсил (номер при "no_date" и т.п.) —
            # бесплатный первоисточник, не пере-парсим тот же текст заново.
            fb_plate: str | None = None
            fb_date: str | None = None
            parsed0 = result.get("parsed") or {}
            if isinstance(parsed0.get("plate"), str) and parsed0.get("plate"):
                fb_plate = parsed0["plate"]
            if isinstance(parsed0.get("date"), str) and parsed0.get("date"):
                fb_date = parsed0["date"][:10]
            try:
                data1 = await _cached_facts(cache, external_id)
                if data1:
                    parsed = data1.get("parsed") or {}
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
                        f"{live.title or ''} {extra_text or ''}"
                    )
                    if plates:
                        fb_plate = plates[0]
                if not fb_date:
                    parsed_again = automation.parse_issue(
                        live.title, live.description, None,
                        extra_text=extra_text, created_at=live.created_at,
                    )
                    if parsed_again.date:
                        fb_date = parsed_again.date
            except Exception:
                log.warning("track_fallback_extract_failed", issue_id=issue_id)
            # Номер найден, а дата — нет: НЕ угадываем дату (created_at ≠ дата
            # неисправности — молча показали бы трек не за тот день). Фронт
            # покажет "no_date" с просьбой задать период вручную.
            if fb_plate and fb_date:
                result = await automation.build_track(
                    "", "", plate=fb_plate, fault_date=fb_date,
                    date_from=date_from, date_to=date_to,
                )
        return result
    except HTTPException:
        raise
    except (httpx.TimeoutException, httpx.TransportError):
        # geo подвис (30.07.2026 — ~6 минут): раньше это был голый 500 и красное
        # «Ошибка загрузки трека» без намёка, что виноват внешний сервис и надо
        # просто повторить. Отдаём мягкий код — панель объяснит и предложит повтор.
        log.warning("get_issue_track_geo_unavailable", issue_id=issue_id)
        return {"error": "geo_unavailable", "points": []}
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

        def _map_author_kind(author: dict) -> str:
            # Okdesk `author.type` values: "contact" (client portal user),
            # "employee"/"user"/"staff" (support staff). Map to UI buckets.
            # ВАЖНО: авто-уведомления Okdesk (смена статуса и т.п.) приходят как
            # author.type='employee' от ПСЕВДО-аккаунта «Системное уведомление»
            # (id=6 в нашей инсталляции) — по типу неотличимы от живого сотрудника.
            # Ловим их по автору, иначе красятся как комментарий оператора (64725).
            name = str(author.get("name") or "").lower()
            if "системное уведомлен" in name or str(author.get("id")) == "6":
                return "system"
            t = str(author.get("type") or "").lower()
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
                    raw_author_kind[cid] = _map_author_kind(author)
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
        live = await _live_issue(okdesk, external_id, issue_id)
        att_text = ""
        try:
            att_text = await automation.read_attachments(external_id, live.attachments or [])
        except Exception:
            log.warning("extracted_attachments_failed", issue_id=issue_id)
        parsed = automation.parse_issue(live.title, live.description, None, extra_text=att_text,
                                        created_at=live.created_at)
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
    Доступно только не-demo (POST блокируется middleware для demo).

    Пустую строку в Okdesk не отправляем: обязательный атрибут он отклоняет
    (422 «не может быть пустым»), а из формы пустое поле приходит как «я его не
    менял». Стереть значение через API нельзя — только заменить."""
    if body.address is None and body.contact_person is None and body.tel_person is None:
        raise HTTPException(status_code=400, detail="Нужно передать хотя бы один параметр")
    empty = [name for name, val in (("address", body.address),
                                    ("contact_person", body.contact_person),
                                    ("tel_person", body.tel_person))
             if val is not None and not val.strip()]
    if empty:
        raise HTTPException(
            status_code=400,
            detail="Okdesk не принимает пустое значение обязательного атрибута — "
                   "введите значение или оставьте поле как было")
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

        # Возвращаем актуальные параметры из свежей выгрузки заявки — и сырую
        # тройку тоже: по ней форма понимает, что реально легло в Okdesk.
        try:
            live = await okdesk.get_issue(external_id)
            parameters = _build_parameters(live.parameters)
            editable = _editable_parameters(live.parameters)
        except Exception:
            parameters, editable = [], []
        return {"ok": True, "parameters": parameters, "editable_parameters": editable}
    except HTTPException:
        raise
    except OkdeskAPIError as exc:
        log.warning("update_params_okdesk_rejected", issue_id=issue_id, status=exc.status_code, body=exc.body)
        raise HTTPException(status_code=400, detail=f"Okdesk отклонил изменение параметров: {exc.body}")
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code if exc.response is not None else 0
        body_txt = (exc.response.text or "")[:500] if exc.response is not None else ""
        log.warning("update_params_okdesk_http_error", issue_id=issue_id, status=status, body=body_txt)
        if status == 403:
            raise HTTPException(
                status_code=403,
                detail="У API-ключа Okdesk нет права менять дополнительные атрибуты — "
                       "нужно добавить его в роль сотрудника, к которому привязан ключ")
        raise HTTPException(status_code=502, detail=f"Okdesk вернул ошибку при изменении параметров: {body_txt}")
    except Exception:
        log.exception("update_issue_parameters_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to update issue parameters")


class IssueFieldsUpdate(BaseModel):
    """Поля заявки, правку которых мы разрешаем из карточки.

    Белый список, а не «что придёт»: PATCH заявки в Okdesk принимает и company_id
    с contact_id, но подмена клиента у живой заявки — это не «быстрая правка», и
    ошибку там не откатить. Наблюдатели и оборудование требуют выбора сущностей
    Okdesk (отдельные справочники) — заведём, когда понадобятся.
    """
    title: str | None = None
    deadline_at: str | None = None          # ISO 'YYYY-MM-DDTHH:MM' (МСК-время заявки)
    priority: str | None = None             # code из GET /issues/meta/priorities
    planned_execution_in_hours: float | None = None


@router.get("/meta/priorities")
async def list_issue_priorities(
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> list[dict[str, object]]:
    """Справочник приоритетов заявки — чтобы фронт не хардкодил коды Okdesk."""
    try:
        return await okdesk.list_issue_priorities()
    except Exception:
        log.exception("list_issue_priorities_failed")
        raise HTTPException(status_code=502, detail="Не удалось получить список приоритетов")


@router.patch("/{issue_id}/fields")
async def update_issue_fields(
    issue_id: int,
    body: IssueFieldsUpdate,
    cache: CacheService = Depends(get_cache_service),
    okdesk: OkdeskService = Depends(get_okdesk_service),
) -> dict[str, object]:
    """Быстрая правка полей заявки прямо из карточки (тема, срок, приоритет,
    плановая продолжительность).

    Раньше из карточки правились только тип, ответственный и три кастом-параметра —
    за сроком и приоритетом приходилось идти в Okdesk. Уходит РОВНО то, что
    оператор изменил (переданные не-None поля), остальное не трогаем.

    Каждое поле — СВОЙ эндпоинт Okdesk: `PATCH /issues/{id}` принимает только тему
    и описание, а срок/приоритет/продолжительность живут в `/deadlines`,
    `/priorities`, `/planned_execution_in_minutes`. Раньше всё уходило одним
    PATCH'ем — Okdesk отвечал 200 и молча игнорировал всё, кроме темы.

    Из карточки сейчас приходит ТОЛЬКО тема: на остальные три эндпоинта наш
    API-ключ получает 403 (право выдаётся роли сотрудника, к которому привязан
    ключ), поэтому в UI они показаны на просмотр. Поддержку здесь сознательно
    оставляем рабочей — когда права выдадут, менять надо будет только фронт.
    """
    fields = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    if not fields:
        raise HTTPException(status_code=400, detail="Нет полей для обновления")
    if "title" in fields and not str(fields["title"]).strip():
        raise HTTPException(status_code=400, detail="Тема не может быть пустой")
    issue_data = await cache.get_issue_with_analysis(issue_id)
    if not issue_data:
        raise HTTPException(status_code=404, detail="Issue not found")
    external_id = issue_data["issue"].external_id

    # Порядок фиксирован: сначала тема (один PATCH), потом остальные по одному
    # запросу на поле. Ошибка на любом шаге прерывает — уже применённые поля
    # остаются, поэтому в detail пишем, что именно не прошло.
    async def _apply(field: str, value: object) -> None:
        if field == "title":
            await okdesk.update_issue_fields(external_id, {"title": str(value)})
        elif field == "deadline_at":
            await okdesk.set_issue_deadline(external_id, str(value))
        elif field == "priority":
            await okdesk.set_issue_priority(external_id, str(value))
        elif field == "planned_execution_in_hours":
            await okdesk.set_issue_planned_execution(external_id, float(value))  # type: ignore[arg-type]
        else:
            # Новое поле в IssueFieldsUpdate без своего эндпоинта Okdesk: молча
            # «сохранить» его — это ровно тот баг, который здесь и починен.
            raise HTTPException(status_code=400, detail=f"Поле «{field}» не умеем сохранять в Okdesk")

    for field, value in sorted(fields.items(), key=lambda kv: kv[0] != "title"):
        try:
            await _apply(field, value)
        except HTTPException:
            raise
        except OkdeskAPIError as e:
            log.warning("update_issue_fields_rejected", issue_id=issue_id, field=field, detail=str(e)[:200])
            raise HTTPException(status_code=400, detail=f"Okdesk отклонил «{field}»: {e}")
        except httpx.HTTPStatusError as e:
            status = e.response.status_code if e.response is not None else 0
            if status == 403:
                # Права даются роли сотрудника, к которому привязан API-ключ
                # (Okdesk: «Изменение приоритета заявки», «Смена планового времени
                # решения», «Плановая продолжительность»). Кодом это не обойти.
                log.warning("update_issue_fields_forbidden", issue_id=issue_id, field=field)
                raise HTTPException(
                    status_code=403,
                    detail=f"У API-ключа Okdesk нет права менять «{field}» — "
                           "нужно добавить действие в роль сотрудника, к которому привязан ключ")
            log.warning("update_issue_fields_http_error", issue_id=issue_id, field=field, status=status)
            raise HTTPException(status_code=502, detail=f"Okdesk вернул ошибку на «{field}» (HTTP {status})")
        except Exception:
            log.exception("update_issue_fields_failed", issue_id=issue_id, field=field)
            raise HTTPException(status_code=502, detail=f"Не удалось сохранить «{field}» в Okdesk")
    # Кэш заявки держит тему/срок/приоритет — обновляем полным upsert'ом
    # (refresh_single_issue тянет только статус и ответственного), иначе список
    # слева и подсветка просрочки останутся на старых данных до синхронизации.
    try:
        await cache.cache_single_issue(external_id)
    except Exception:
        log.warning("update_issue_fields_refresh_failed", issue_id=issue_id)
    return {"ok": True, "updated": sorted(fields)}


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
            parsed = automation.parse_issue(live.title, live.description, None,
                                            created_at=live.created_at)
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
                created_at=live.created_at,
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
                live.title, live.description, comment, status_code,
                created_at=live.created_at
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

        # Инвалидация кэша анализа (1.4): после решения/комментария старый разбор
        # устарел. Факты (kind "parse") устаревают так же — в комментарии может
        # прийти новая дата/номер. Кэш вложений (ocr:*) и разбор по объектам
        # ("batch", там правки оператора) НЕ трогаем — они дорогие/ручные.
        await cache.delete_result_cache(external_id, "automate")
        await cache.delete_result_cache(external_id, "parse")

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
        # Новый комментарий может изменить верный ответ (в т.ч. дату/номер) —
        # сбрасываем и ИИ-разбор, и детерминированные факты (1.4).
        await cache.delete_result_cache(external_id, "automate")
        await cache.delete_result_cache(external_id, "parse")
        return {"ok": True, "result": result}
    except HTTPException:
        raise
    except Exception:
        log.exception("add_comment_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail="Failed to add comment")
