"""Pydantic models for Okdesk API responses."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class CompanyCategory(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int | str | None = None
    code: str | None = None
    name: str | None = None
    color: str | None = None


class CompanyBrief(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    name: str


class Company(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    name: str
    additional_name: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    site: str | None = None
    comment: str | None = None
    active: bool | None = None
    crm_1c_id: str | None = None
    coordinates: list[float] | None = None
    category: CompanyCategory | None = None
    contacts: list[CompanyBrief] | None = None
    default_assignee: CompanyBrief | None = None
    default_assignee_group: CompanyBrief | None = None
    observers: list[CompanyBrief] | None = None
    external_observers: list[CompanyBrief] | None = None


class Contact(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    name: str
    last_name: str | None = None
    first_name: str | None = None
    patronymic: str | None = None
    position: str | None = None
    phone: str | None = None
    mobile_phone: str | None = None
    email: str | None = None
    comment: str | None = None
    active: bool | None = None
    company_id: int | None = None
    company_name: str | None = None
    login: str | None = None
    crm_1c_id: str | None = None
    updated_at: str | None = None
    telegram_username: str | None = None
    additional_emails: str | None = None


class EquipmentCompany(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    name: str


class EquipmentKind(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int | None = None
    code: str | None = None
    name: str | None = None
    description: str | None = None


class Equipment(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    serial_number: str | None = None
    inventory_number: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    company: str | EquipmentCompany | None = None
    maintenance_entity: EquipmentCompany | None = None
    equipment_kind: EquipmentKind | None = None
    equipment_manufacturer: EquipmentCompany | None = None
    equipment_model: EquipmentCompany | None = None
    comment: str | None = None
    type: str | None = None


class IssueStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str | None = None
    name: str | None = None
    color: str | None = None


class IssueType(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str | None = None
    name: str | None = None


class IssuePriority(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str | None = None
    name: str | None = None
    color: str | None = None


class IssueAuthor(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int | None = None
    name: str | None = None
    type: str | None = None


class IssueParameter(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str | None = None
    name: str | None = None
    field_type: str | None = None
    value: str | None = None


class Attachment(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    attachment_file_name: str | None = None
    attachment_file_size: int | None = None
    is_public: bool | None = None
    description: str | None = None
    created_at: str | None = None
    comment_id: int | None = None


class Issue(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    title: str | None = None
    description: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    completed_at: str | None = None
    deadline_at: str | None = None
    delayed_to: str | None = None
    planned_reaction_at: str | None = None
    reacted_at: str | None = None
    without_answer: bool | None = None
    source: str | None = None
    spent_time_total: float | None = None
    group_id: int | None = None
    parent_id: int | None = None
    child_ids: list[int] = []
    parameters: list[IssueParameter] = []
    attachments: list[Attachment] = []
    status: IssueStatus | None = None
    type: IssueType | None = None
    priority: IssuePriority | None = None
    company: IssueAuthor | None = None
    contact: IssueAuthor | None = None
    author: IssueAuthor | None = None
    service_object: IssueAuthor | None = None
    agreement: IssueAuthor | None = None
    assignee: IssueAuthor | None = None


class Employee(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    last_name: str | None = None
    first_name: str | None = None
    patronymic: str | None = None
    position: str | None = None
    email: str | None = None
    login: str | None = None
    phone: str | None = None
    active: bool | None = None
    comment: str | None = None


class IssueComment(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    content: str | None = None
    created_at: str | None = None
    author: IssueAuthor | None = None
    is_internal: bool | None = None


class OkdeskCompanyBrief(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    name: str
    phone: str | None = None
    active: bool | None = None


class OkdeskIssueBrief(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    number: str | None = None
    subject: str | None = None
    body: str | None = None
    status_code: str | None = None
    company: OkdeskCompanyBrief | None = None
    created_at: str | None = None


class OkdeskWebhookPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    issue: OkdeskIssueBrief
    event_type: str
