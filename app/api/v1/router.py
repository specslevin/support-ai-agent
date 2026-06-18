"""Aggregate API v1 routes."""

from __future__ import annotations

from fastapi import APIRouter

from .endpoints import (
    auth,
    chat,
    employees,
    issue_types,
    issues_dashboard,
    objects,
    templates,
    test,
    webhooks,
)

api_v1_router = APIRouter(prefix="/api/v1", tags=["support-ai"])
api_v1_router.include_router(auth.router)
api_v1_router.include_router(webhooks.router, tags=["webhooks"])
api_v1_router.include_router(test.router, tags=["test"])
api_v1_router.include_router(issues_dashboard.router)
api_v1_router.include_router(employees.router)
api_v1_router.include_router(templates.router)
api_v1_router.include_router(issue_types.router)
api_v1_router.include_router(objects.router)
api_v1_router.include_router(chat.router)
