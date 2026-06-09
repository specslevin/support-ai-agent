"""Okdesk webhooks."""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from ....core.dependencies import get_intelligence_service, get_okdesk_client
from ....core.okdesk import OkdeskClient, OkdeskWebhookPayload
from ....services.intelligence_service import IntelligenceService

log = structlog.get_logger(__name__)
router = APIRouter()


@router.post("/webhooks/okdesk")
async def post_okdesk_webhook(
    payload: OkdeskWebhookPayload,
    intelligence_service: IntelligenceService = Depends(get_intelligence_service),
    okdesk_client: OkdeskClient = Depends(get_okdesk_client),
) -> JSONResponse:
    try:
        issue = payload.issue
        log.info(
            "webhook_received",
            module="okdesk",
            client="okdesk",
            issue_id=issue.id,
            event_type=payload.event_type,
            company_id=issue.company.id,
        )
        out = await intelligence_service.process_issue_text(issue.body)
        draft = str(out.get("draft", ""))
        internal_note = str(out.get("internal_note", ""))
        if internal_note:
            try:
                await okdesk_client.add_internal_comment(issue.id, internal_note)
            except Exception:  # noqa: BLE001
                log.exception(
                    "okdesk_internal_comment_failed",
                    module="okdesk",
                    issue_id=issue.id,
                )
        return {
            "status": "processed",
            "draft": draft,
            "internal_note": internal_note,
        }
    except Exception:  # noqa: BLE001
        log.exception("okdesk_webhook_unhandled", module="okdesk", client="okdesk")
        return JSONResponse(
            status_code=500,
            content={"error": "Processing failed. Please try again later."},
        )
