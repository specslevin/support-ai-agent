"""Pydantic schemas for the issues dashboard API."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class IssueResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    external_id: int
    subject: str | None
    status: str | None
    priority: str | None
    company_name: str | None
    contact_name: str | None
    assignee_name: str | None
    created_at: str | None
    updated_at: str | None
    deadline_at: str | None
    synced_at: str

    @classmethod
    def from_orm_row(cls, row: object) -> "IssueResponse":
        from app.core.db.models import IssueCache
        r: IssueCache = row  # type: ignore[assignment]
        return cls(
            id=r.id,
            external_id=r.external_id,
            subject=r.subject,
            status=r.status,
            priority=r.priority,
            company_name=r.company_name,
            contact_name=r.contact_name,
            assignee_name=r.assignee_name,
            created_at=r.created_at.isoformat() if r.created_at else None,
            updated_at=r.updated_at.isoformat() if r.updated_at else None,
            deadline_at=r.deadline_at.isoformat() if getattr(r, "deadline_at", None) else None,
            synced_at=r.synced_at.isoformat(),
        )


class AnalysisInput(BaseModel):
    mileage_from_sheet: float
    notes: str | None = None


class AnalysisResult(BaseModel):
    analysis_id: str
    mileage_from_sheet: float
    mileage_from_system: float | None
    discrepancy_percent: float | None
    ai_suggestion: str | None
    recommendation: str | None
    created_at: str


class PaginatedIssuesResponse(BaseModel):
    data: list[IssueResponse]
    pagination: dict[str, int]


class BulkAssignee(BaseModel):
    issue_ids: list[int] = Field(..., min_length=1)
    assignee_id: int


class BulkType(BaseModel):
    issue_ids: list[int] = Field(..., min_length=1)
    type_code: str


class BulkStatus(BaseModel):
    issue_ids: list[int] = Field(..., min_length=1)
    status_code: str
    comment: str | None = None
    comment_public: bool = True
    delay_to: str | None = None


class ChildIssueItem(BaseModel):
    plate: str
    date: str | None = None
    address: str | None = None
    sheet_mileage_km: float | None = None
    system_mileage_km: float | None = None
    verdict: str | None = None
    file: str | None = None  # Source attachment filename (used to copy attachment to child)


class CreateChildren(BaseModel):
    objects: list[ChildIssueItem] = Field(..., min_length=1)
