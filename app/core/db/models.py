from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    external_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    source: Mapped[str] = mapped_column(String(50), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    objects: Mapped[list["Object"]] = relationship(
        "Object", back_populates="company", cascade="all, delete-orphan"
    )
    issues: Mapped[list["Issue"]] = relationship(
        "Issue", back_populates="company", cascade="all, delete-orphan"
    )


class Object(Base):
    __tablename__ = "objects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    external_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    imei: Mapped[str] = mapped_column(String(50), nullable=False)
    company_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("companies.id"), nullable=False
    )
    last_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_update: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="unknown", nullable=False)

    company: Mapped["Company"] = relationship("Company", back_populates="objects")
    issues: Mapped[list["Issue"]] = relationship(
        "Issue", back_populates="object_", cascade="all, delete-orphan"
    )


class Issue(Base):
    __tablename__ = "issues"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    external_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False)
    company_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("companies.id"), nullable=False
    )
    object_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("objects.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    company: Mapped["Company"] = relationship("Company", back_populates="issues")
    object_: Mapped["Object | None"] = relationship("Object", back_populates="issues")


class IssueCache(Base):
    """Dashboard cache of Okdesk issues synced via REST API."""

    __tablename__ = "issue_cache"
    __table_args__ = (
        Index("ix_issue_cache_external_id", "external_id"),
        Index("ix_issue_cache_status", "status"),
        Index("ix_issue_cache_synced_at", "synced_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    external_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
    subject: Mapped[str | None] = mapped_column(String(500), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    priority: Mapped[str | None] = mapped_column(String(50), nullable=True)
    company_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True
    )
    company_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    object_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("objects.id", ondelete="SET NULL"), nullable=True
    )
    contact_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    assignee_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    analyses: Mapped[list["AnalysisCache"]] = relationship(
        "AnalysisCache", back_populates="issue", cascade="all, delete-orphan"
    )


class AnalysisCache(Base):
    """Mileage analyses and AI suggestions for dashboard issues."""

    __tablename__ = "analysis_cache"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    issue_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("issue_cache.id", ondelete="CASCADE"), nullable=False
    )
    mileage_from_sheet: Mapped[float | None] = mapped_column(Float, nullable=True)
    mileage_from_system: Mapped[float | None] = mapped_column(Float, nullable=True)
    discrepancy_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    ai_suggestion: Mapped[str | None] = mapped_column(Text, nullable=True)
    recommendation: Mapped[str | None] = mapped_column(String(50), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    issue: Mapped["IssueCache"] = relationship("IssueCache", back_populates="analyses")


class ResultCache(Base):
    """Cached analysis results (automate / batch) so we don't re-run the AI and
    re-spend tokens on every open. Keyed by (issue_external_id, kind)."""

    __tablename__ = "result_cache"
    __table_args__ = (
        Index("ix_result_cache_lookup", "issue_external_id", "kind"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    issue_external_id: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)  # 'automate' | 'batch'
    result_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class TrainingSample(Base):
    """Groundwork for AI training: operator decisions paired with telemetry facts.

    Each row is one resolved issue — the telemetry we computed + what the
    operator actually answered and which status they set. Accumulated over time
    this becomes the dataset for few-shot retrieval and/or fine-tuning.
    """

    __tablename__ = "training_samples"
    __table_args__ = (
        Index("ix_training_samples_issue", "issue_external_id"),
        Index("ix_training_samples_created", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    issue_external_id: Mapped[int] = mapped_column(Integer, nullable=False)
    issue_title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    issue_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    plate: Mapped[str | None] = mapped_column(String(32), nullable=True)
    fault_date: Mapped[str | None] = mapped_column(String(16), nullable=True)
    mileage_sheet_km: Mapped[float | None] = mapped_column(Float, nullable=True)
    mileage_system_km: Mapped[float | None] = mapped_column(Float, nullable=True)
    telemetry_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ai_was_used: Mapped[bool] = mapped_column(Integer, default=0, nullable=False)
    operator_answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    final_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class AiFeedback(Base):
    """Оценка оператором качества ИИ-разбора заявки (петля обратной связи).

    rating: 'good' — разобрано верно; 'bad' — ошибка разбора. Для 'bad' оператор
    указывает тип ошибки и комментарий, опц. правильную категорию. Используется
    для (а) экрана «хорошо разобрано / с ошибками», (б) роста few-shot из верных
    разборов и точечного исправления промпта/правил по ошибкам.
    """

    __tablename__ = "ai_feedback"
    __table_args__ = (
        Index("ix_ai_feedback_issue", "issue_external_id"),
        Index("ix_ai_feedback_rating", "rating"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    issue_external_id: Mapped[int] = mapped_column(Integer, nullable=False)
    rating: Mapped[str] = mapped_column(String(8), nullable=False)  # 'good' | 'bad'
    error_kind: Mapped[str | None] = mapped_column(String(64), nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    correct_category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    # Отметка «разобрано и исправлено» — чтобы в экране «Оценки ИИ» отличать
    # обработанные ошибки от ещё не исправленных, когда их накопится много.
    resolved: Mapped[bool] = mapped_column(Integer, default=0, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)


class ObjectResolveCache(Base):
    """Cached plate→GPSPOS-object resolution so we don't re-scan the Objects list
    on every lookup. Keyed by normalized plate. Foundation for reliable
    issue↔object linking and per-object answer aggregation (ОДКР)."""

    __tablename__ = "object_resolve_cache"
    __table_args__ = (
        Index("ix_object_resolve_cache_plate", "plate_norm"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plate_norm: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    object_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    imei: Mapped[str | None] = mapped_column(String(50), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )


class TemplateCategory(Base):
    """Our editable copy of okdesk-console answer-template categories.

    Migrated from the live console DB so we can edit safely. ``original_id``
    keeps the console-side id for idempotent UPSERT.
    """

    __tablename__ = "app_template_categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    original_id: Mapped[int | None] = mapped_column(Integer, unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    color: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Template(Base):
    """Our editable copy of okdesk-console answer templates (few-shot for AI).

    Migrated from the live console DB so edits don't touch the production
    console. ``original_id`` keeps the console-side id for idempotent UPSERT.
    """

    __tablename__ = "app_templates"
    __table_args__ = (
        Index("ix_app_templates_category", "category_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    original_id: Mapped[int | None] = mapped_column(Integer, unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(500), nullable=False)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    category_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    active: Mapped[bool] = mapped_column(Integer, default=1, nullable=False)
    usage_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_dynamic: Mapped[bool] = mapped_column(Integer, default=0, nullable=False)
    is_favorite: Mapped[bool] = mapped_column(Integer, default=0, nullable=False)
    # Ownership: NULL = shared (visible to everyone), a username = personal
    # (visible only to that user). Added via lightweight migration in init_db.
    user_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source: Mapped[str] = mapped_column(
        String(32), default="console", nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ChatHistory(Base):
    __tablename__ = "chat_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
