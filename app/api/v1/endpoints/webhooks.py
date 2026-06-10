"""Okdesk webhooks."""

from __future__ import annotations

import os

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import JSONResponse

from ....core.dependencies import get_intelligence_service, get_okdesk_client
from ....core.okdesk.client import OkdeskClient
from ....core.okdesk.models import OkdeskWebhookPayload
from ....services.intelligence_service import IntelligenceService

log = structlog.get_logger(__name__)
router = APIRouter()

# Only process these Okdesk event types — ignore updates, comments, etc.
_PROCESS_EVENTS = {"issue.create", "issue_created", "created"}


def _get_webhook_secret() -> str | None:
    return os.getenv("OKDESK_WEBHOOK_SECRET") or None


@router.post("/webhooks/okdesk")
async def post_okdesk_webhook(
    payload: OkdeskWebhookPayload,
    x_okdesk_secret: str | None = Header(default=None, alias="X-Okdesk-Secret"),
    intelligence_service: IntelligenceService = Depends(get_intelligence_service),
    okdesk_client: OkdeskClient = Depends(get_okdesk_client),
) -> JSONResponse:
    # Verify secret if configured
    secret = _get_webhook_secret()
    if secret and x_okdesk_secret != secret:
        log.warning("webhook_invalid_secret", event_type=payload.event_type)
        raise HTTPException(status_code=403, detail="Invalid webhook secret")

    issue = payload.issue
    company_id = issue.company.id if issue.company else None

    log.info(
        "webhook_received",
        issue_id=issue.id,
        event_type=payload.event_type,
        company_id=company_id,
    )

    # Only auto-triage new tickets
    if payload.event_type.lower() not in _PROCESS_EVENTS:
        log.info("webhook_skipped", event_type=payload.event_type, issue_id=issue.id)
        return JSONResponse({"status": "skipped", "reason": f"event_type={payload.event_type}"})

    body = (issue.body or issue.subject or "").strip()
    if not body:
        log.warning("webhook_empty_body", issue_id=issue.id)
        return JSONResponse({"status": "skipped", "reason": "empty body"})

    try:
        out = await intelligence_service.process_issue_text(body)
        draft = str(out.get("draft", ""))
        internal_note = str(out.get("internal_note", ""))
        actions = out.get("actions", [])

        log.info(
            "webhook_processed",
            issue_id=issue.id,
            actions=[a.get("type") for a in actions],
        )

        if internal_note:
            try:
                await okdesk_client.add_internal_comment(issue.id, internal_note)
                log.info("webhook_comment_added", issue_id=issue.id)
            except Exception:
                log.exception("webhook_comment_failed", issue_id=issue.id)

        return JSONResponse({
            "status": "processed",
            "draft": draft,
            "internal_note": internal_note,
            "actions": actions,
        })

    except Exception:
        log.exception("webhook_unhandled", issue_id=issue.id)
        return JSONResponse(
            status_code=500,
            content={"error": "Processing failed"},
        )
