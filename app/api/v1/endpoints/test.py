"""Test pipeline endpoint (protected)."""

from __future__ import annotations

import time
from typing import Any

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from ....core.dependencies import get_intelligence_service, get_test_token_settings
from ....services.intelligence_service import IntelligenceService

log = structlog.get_logger(__name__)
router = APIRouter()


class PipelineTestRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Issue text to triage")
    object_id: int | None = Field(
        default=None,
        description="Optional object id; appended to triage text as test context",
    )


@router.post("/test/pipeline")
async def post_test_pipeline(
    body: PipelineTestRequest,
    intelligence_service: IntelligenceService = Depends(get_intelligence_service),
    x_test_token: str | None = Header(default=None, alias="X-Test-Token"),
) -> dict[str, Any]:
    settings = get_test_token_settings()
    if not x_test_token or x_test_token != settings.TEST_API_TOKEN:
        log.warning("test_pipeline_unauthorized", module="okdesk", client="test")
        raise HTTPException(status_code=403, detail="Invalid or missing X-Test-Token")
    t0 = time.perf_counter()
    text = body.text
    if body.object_id is not None:
        text = f"{text}\n(тест: object_id={body.object_id})"
    result = await intelligence_service.process_issue_text(text)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    log.info(
        "test_pipeline_ok",
        module="okdesk",
        client="test",
        elapsed_ms=round(elapsed_ms, 2),
    )
    return {
        "result": result,
        "metrics": {
            "elapsed_ms": round(elapsed_ms, 3),
            "object_id_echo": body.object_id,
        },
    }
