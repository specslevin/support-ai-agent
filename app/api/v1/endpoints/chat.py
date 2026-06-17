"""AI chat workspace: translate a natural-language operator request into
issue-list filters, run them against the cache, and return matching issues."""

from __future__ import annotations

import json

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db.models import ChatHistory
from app.core.dependencies import (
    get_cache_service,
    get_db_session,
    get_issue_automation_service,
)
from app.core.services.cache_service import CacheService
from app.services.issue_automation import IssueAutomationService

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/chat", tags=["chat"])

# Filter keys we accept from the LLM and forward to the cache query.
_ALLOWED_FILTERS = {"company", "status", "search", "assignee"}
_ALLOWED_STATUS = {"opened", "wait", "delayed", "completed", "closed"}
_MAX_RESULTS = 30

_SYSTEM_PROMPT = (
    "Ты — ассистент диспетчера техподдержки GPSPOS. Переведи запрос оператора на "
    "русском в фильтры для списка заявок. Ответь СТРОГО валидным JSON без markdown: "
    '{"reply": "<короткий ответ оператору>", "filters": {"company": <строка|null>, '
    '"status": <"opened"|"wait"|"delayed"|"completed"|"closed"|null>, '
    '"search": <строка|null>, "assignee": <строка|null>}}. '
    'company — часть названия компании, status — код статуса (открытые=opened, '
    'в ожидании=wait, отложенные=delayed, выполненные=completed, закрытые=closed), '
    "search — ключевые слова темы, assignee — имя ответственного. Незаданные поля = null."
)


class ChatRequest(BaseModel):
    message: str
    user_id: str | None = None


class ChatIssue(BaseModel):
    id: int
    external_id: int | None = None
    subject: str | None = None
    company_name: str | None = None
    status: str | None = None
    assignee_name: str | None = None


class ChatResponse(BaseModel):
    reply: str
    filters: dict[str, str]
    issues: list[ChatIssue]


def _parse_filters(raw: str) -> tuple[str, dict[str, str]]:
    """Best-effort parse of the LLM JSON. Returns (reply, whitelisted filters)."""
    text = (raw or "").strip()
    # Strip markdown fences if the model wrapped the JSON.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    # Slice to the outermost object to tolerate leading/trailing prose.
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]
    data = json.loads(text)
    reply = str(data.get("reply") or "").strip() or "Вот что нашёл по вашему запросу."
    filters: dict[str, str] = {}
    raw_filters = data.get("filters") or {}
    if isinstance(raw_filters, dict):
        for key, value in raw_filters.items():
            if key not in _ALLOWED_FILTERS or value in (None, ""):
                continue
            val = str(value).strip()
            if not val:
                continue
            if key == "status" and val not in _ALLOWED_STATUS:
                continue
            filters[key] = val
    return reply, filters


@router.post("", response_model=ChatResponse)
async def chat(
    body: ChatRequest,
    cache: CacheService = Depends(get_cache_service),
    automation: IssueAutomationService = Depends(get_issue_automation_service),
    db: AsyncSession = Depends(get_db_session),
) -> ChatResponse:
    """Interpret the operator's request and return matching issues."""
    message = (body.message or "").strip()
    if not message:
        return ChatResponse(reply="Введите запрос.", filters={}, issues=[])

    reply = "Не понял запрос. Попробуйте уточнить, например: «открытые заявки Жигулёвского ПО»."
    filters: dict[str, str] = {}

    try:
        raw = await automation._llm.chat(_SYSTEM_PROMPT, message)
        reply, filters = _parse_filters(raw)
    except Exception as exc:  # noqa: BLE001 — never 500 on LLM/parse failure
        log.warning("chat.llm_failed", error=str(exc))
        return ChatResponse(reply=reply, filters={}, issues=[])

    issues: list[ChatIssue] = []
    try:
        rows = await cache.get_issues_from_cache(**filters)
        for row in rows[:_MAX_RESULTS]:
            issues.append(
                ChatIssue(
                    id=row.id,
                    external_id=row.external_id,
                    subject=row.subject,
                    company_name=row.company_name,
                    status=row.status,
                    assignee_name=row.assignee_name,
                )
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("chat.cache_failed", error=str(exc), filters=filters)

    # Best-effort: persist the turn to chat_history.
    try:
        uid = body.user_id or "operator"
        db.add(ChatHistory(user_id=uid, role="user", content=message))
        db.add(ChatHistory(user_id=uid, role="assistant", content=reply))
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("chat.history_failed", error=str(exc))

    return ChatResponse(reply=reply, filters=filters, issues=issues)
