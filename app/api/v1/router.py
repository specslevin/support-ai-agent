"""Aggregate API v1 routes."""

from __future__ import annotations

from fastapi import APIRouter

from .endpoints import employees, issues_dashboard, test, webhooks

api_v1_router = APIRouter(prefix="/api/v1", tags=["support-ai"])
api_v1_router.include_router(webhooks.router, tags=["webhooks"])
api_v1_router.include_router(test.router, tags=["test"])
api_v1_router.include_router(issues_dashboard.router)
api_v1_router.include_router(employees.router)
