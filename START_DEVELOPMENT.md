# 🚀 START DEVELOPMENT: Phase 1 Backend (3 Steps)

> **Для:** claude-sonnet-4-6
> **Скопируй это в новую сессию как первое сообщение**

---

## Контекст

Разрабатываю **web dashboard для анализа GPS-заявок** (support.gpspos.ru интерфейс).

**Архитектура:** React + FastAPI (параллельная разработка)
**Текущая фаза:** Phase 1 — Backend Infrastructure (3 дня)
**API решение:** Public REST API (Okdesk) + SQLite Cache (официально, надежно)

---

## ШАГ 1: Database Models & Migration

**Время:** ~2-3 часа

**Что нужно:**

Расширить `app/core/db/models.py` с 3 новыми таблицами для веб-панели:

### 1.1 IssueCache Table
```python
class IssueCache(Base):
    """Cache Okdesk issues locally for fast queries"""
    __tablename__ = "issue_cache"
    
    # Fields needed:
    # - id (primary key)
    # - external_id (Okdesk issue ID, unique)
    # - subject (заявка название)
    # - description
    # - status (opened, in_progress, solved, etc.)
    # - priority (code: low, normal, high)
    # - company_id (FK to companies)
    # - object_id (FK to objects, Geo object)
    # - created_at
    # - updated_at
    # - synced_at (when last synced from Okdesk)
    # - contact_name (клиент контакт)
```

### 1.2 AnalysisCache Table
```python
class AnalysisCache(Base):
    """Store mileage analyses & AI suggestions"""
    __tablename__ = "analysis_cache"
    
    # Fields:
    # - id (primary key)
    # - issue_id (FK to issue_cache)
    # - mileage_from_sheet (float, путевой лист)
    # - mileage_from_system (float, данные трекера)
    # - discrepancy_percent (calculated)
    # - ai_suggestion (text, от DeepSeek)
    # - recommendation (opened, ok, review - тип проблемы)
    # - notes (текст от техподдержки)
    # - created_at
```

### 1.3 WebDashboardUser Table (Опционально для v1.1)
```python
class WebDashboardUser(Base):
    """Web panel users (optional for Phase 1)"""
    __tablename__ = "web_dashboard_users"
    
    # Fields:
    # - id (primary key)
    # - email (unique)
    # - hashed_password
    # - role (viewer, support, admin)
    # - created_at
```

**Требования:**
- Использовать SQLAlchemy async (как существующий код)
- Правильные foreign keys + cascade delete
- Indexes на часто запрашиваемые поля (external_id, status, synced_at)
- Типы данных matching с Okdesk (status codes, etc)

**После:** Создай миграцию БД (или просто скрипт, который создаст таблицы)

---

## ШАГ 2: CacheService & Okdesk Integration

**Время:** ~3-4 часа

**Что нужно:** Создать `app/core/services/cache_service.py`

### 2.1 CacheService Class

```python
class CacheService:
    def __init__(self, db_session, okdesk_service, geo_service):
        self.db = db_session
        self.okdesk = okdesk_service
        self.geo = geo_service
    
    async def refresh_issue_cache(self, hours: int = 24) -> int:
        """
        Sync ALL issues from Okdesk REST API → SQLite cache.
        
        Strategy: REST API has limit of 20 per request
        So we make multiple requests with offset:
        - Request 1: limit=20, offset=0
        - Request 2: limit=20, offset=20
        - Request 3: limit=20, offset=40
        
        Then deduplicate and store in cache.
        
        Returns: Number of synced issues
        """
        # TODO: Implement
        pass
    
    async def get_issues_from_cache(
        self,
        status: str | None = None,
        company: str | None = None,
        search: str | None = None,
        sort: str = "created_at",
        order: str = "desc",
    ) -> list[IssueCache]:
        """Query issues from cache with filters"""
        # TODO: Implement
        pass
    
    async def get_issue_with_analysis(self, issue_id: int) -> dict:
        """Get issue + latest analysis + geo data"""
        # TODO: Implement
        pass
    
    async def save_analysis(
        self,
        issue_id: int,
        mileage_sheet: float,
        ai_suggestion: str,
        recommendation: str,
    ) -> AnalysisCache:
        """Save user-submitted analysis"""
        # TODO: Implement
        pass
```

**Логика refresh_issue_cache():**

1. **Get from REST API (multiple requests)**
   - Loop: offset = 0, 20, 40, ...
   - Each: `okdesk.list_issues(limit=20, offset=offset)`
   - Stop когда получим < 20 issues
   - Collect all issues, deduplicate by ID

2. **Store in SQLite**
   - For each issue: INSERT or UPDATE in issue_cache
   - Set synced_at = now()

3. **Handle errors gracefully**
   - Log warnings, don't crash
   - Return count of synced issues

**Логика get_issues_from_cache():**

1. **Build SQL query**
   - SELECT from issue_cache
   - WHERE status = ? (if provided)
   - WHERE subject LIKE ? (if search provided)
   - WHERE company_id IN (SELECT id FROM companies WHERE name LIKE ?) (if company)
   - ORDER BY {sort} {order}

2. **Return paginated results** (pagination in endpoint, not here)

---

## ШАГ 3: API Endpoints для веб-панели

**Время:** ~3-4 часа

**Что нужно:** Создать `app/api/v1/endpoints/issues_dashboard.py`

### 3.1 Pydantic Schemas (в `app/api/v1/schemas/issues.py`)

```python
class IssueListRequest(BaseModel):
    status: str | None = None  # 'open', 'closed', etc
    company: str | None = None
    search: str | None = None
    page: int = Field(1, ge=1)
    limit: int = Field(10, ge=1, le=100)
    sort: str = "created_at"
    order: str = Field("desc", regex="^(asc|desc)$")

class IssueResponse(BaseModel):
    id: int
    external_id: int
    subject: str
    status: str
    priority: str | None
    company: str | None
    contact_name: str | None
    created_at: str
    synced_at: str

class IssueDetailResponse(BaseModel):
    issue: IssueResponse
    object: dict | None  # Geo object data
    comments_count: int
    latest_analysis: dict | None

class AnalysisInput(BaseModel):
    mileage_from_sheet: float
    notes: str | None = None

class AnalysisResult(BaseModel):
    analysis_id: str
    mileage_from_sheet: float
    mileage_from_system: float | None
    discrepancy_percent: float | None
    ai_suggestion: str
    recommendation: str
    created_at: str

class PaginatedResponse(BaseModel):
    data: list[IssueResponse]
    pagination: dict  # {page, limit, total, total_pages}
```

### 3.2 Endpoints

```python
# app/api/v1/endpoints/issues_dashboard.py

from fastapi import APIRouter, Query, Depends, HTTPException
from app.core.services.cache_service import CacheService
from app.api.v1.schemas.issues import *

router = APIRouter(prefix="/issues", tags=["dashboard:issues"])

@router.get("")
async def list_issues(
    status: str | None = Query(None),
    company: str | None = Query(None),
    search: str | None = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    sort: str = Query("created_at"),
    order: str = Query("desc", regex="^(asc|desc)$"),
    cache_service: CacheService = Depends(get_cache_service),
) -> dict:
    """
    Get paginated list of issues with filters.
    
    Query params:
    - status: open|closed|in_progress
    - company: filter by company name
    - search: search in subject
    - page: page number (1-indexed)
    - limit: items per page (1-100)
    - sort: field to sort by
    - order: asc|desc
    """
    try:
        # Get from cache
        issues = await cache_service.get_issues_from_cache(
            status=status,
            company=company,
            search=search,
            sort=sort,
            order=order,
        )
        
        # Paginate
        total = len(issues)
        start = (page - 1) * limit
        paginated = issues[start : start + limit]
        
        return {
            "data": [IssueResponse.from_orm(i) for i in paginated],
            "pagination": {
                "page": page,
                "limit": limit,
                "total": total,
                "total_pages": (total + limit - 1) // limit,
            }
        }
    except Exception as e:
        log.exception("list_issues_failed")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{issue_id}")
async def get_issue_details(
    issue_id: int,
    cache_service: CacheService = Depends(get_cache_service),
    geo_service = Depends(get_geo_service),
) -> IssueDetailResponse:
    """Get full details of issue + geo data + analysis"""
    try:
        issue_data = await cache_service.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        
        # Get geo data if object linked
        geo_data = None
        if issue_data.get("object_id"):
            geo_data = await geo_service.get_object_status(issue_data["object_id"])
        
        return IssueDetailResponse(
            issue=issue_data["issue"],
            object=geo_data.model_dump() if geo_data else None,
            comments_count=issue_data.get("comments_count", 0),
            latest_analysis=issue_data.get("latest_analysis"),
        )
    except HTTPException:
        raise
    except Exception as e:
        log.exception("get_issue_details_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/{issue_id}/analysis")
async def submit_analysis(
    issue_id: int,
    data: AnalysisInput,
    cache_service: CacheService = Depends(get_cache_service),
    ai_agent = Depends(get_ai_agent),
) -> AnalysisResult:
    """
    Submit mileage analysis and get AI suggestion.
    
    Flow:
    1. Get issue context + geo data
    2. Call AI agent with: issue, mileage_sheet, mileage_system
    3. Get suggestion + recommendation
    4. Save to DB
    5. Return result
    """
    try:
        # Get issue + geo data
        issue_data = await cache_service.get_issue_with_analysis(issue_id)
        if not issue_data:
            raise HTTPException(status_code=404, detail="Issue not found")
        
        # Get mileage from system (geo data)
        mileage_system = await cache_service.get_object_mileage(
            issue_data["object_id"]
        )
        
        # Call AI agent
        ai_result = await ai_agent.analyze_mileage_discrepancy(
            issue=issue_data,
            mileage_from_sheet=data.mileage_from_sheet,
            mileage_from_system=mileage_system,
        )
        
        # Save analysis
        saved = await cache_service.save_analysis(
            issue_id=issue_id,
            mileage_sheet=data.mileage_from_sheet,
            ai_suggestion=ai_result["suggestion"],
            recommendation=ai_result["recommendation"],
        )
        
        return AnalysisResult(
            analysis_id=str(saved.id),
            mileage_from_sheet=saved.mileage_from_sheet,
            mileage_from_system=mileage_system,
            discrepancy_percent=(
                (mileage_system - saved.mileage_from_sheet) / mileage_system * 100
                if mileage_system
                else None
            ),
            ai_suggestion=saved.ai_suggestion,
            recommendation=saved.recommendation,
            created_at=saved.created_at.isoformat(),
        )
    except HTTPException:
        raise
    except Exception as e:
        log.exception("submit_analysis_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{issue_id}/comments")
async def get_issue_comments(
    issue_id: int,
    okdesk_service = Depends(get_okdesk_service),
) -> list[dict]:
    """Get comments on issue from Okdesk"""
    try:
        comments = await okdesk_service.get_issue_comments(issue_id)
        return [
            {
                "id": c.id,
                "author": c.author.name if c.author else "Unknown",
                "content": c.content,
                "created_at": c.created_at.isoformat(),
                "is_internal": c.is_internal,
            }
            for c in comments
        ]
    except Exception as e:
        log.exception("get_comments_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/{issue_id}/comments")
async def add_comment(
    issue_id: int,
    text: str = Query(..., min_length=1),
    okdesk_service = Depends(get_okdesk_service),
) -> dict:
    """Add comment to issue in Okdesk"""
    try:
        result = await okdesk_service.add_comment(issue_id, text)
        return {"ok": True, "result": result}
    except Exception as e:
        log.exception("add_comment_failed", issue_id=issue_id)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/cache/refresh")
async def refresh_cache(
    cache_service: CacheService = Depends(get_cache_service),
) -> dict:
    """Force refresh issue cache from Okdesk"""
    try:
        count = await cache_service.refresh_issue_cache()
        return {"ok": True, "synced": count}
    except Exception as e:
        log.exception("refresh_cache_failed")
        raise HTTPException(status_code=500, detail=str(e))
```

**Требования:**
- Правильная обработка ошибок (404, 500)
- Логирование через structlog
- Pydantic валидация
- DI (Depends) для сервисов
- Docstrings на каждый endpoint

---

## Integration Checklist

После реализации всех 3 шагов:

- [ ] Шаг 1: IssueCache, AnalysisCache таблицы созданы
- [ ] Шаг 1: Миграция БД выполнена (или скрипт инициализации)
- [ ] Шаг 2: CacheService создан с методами refresh + get + save
- [ ] Шаг 2: Логика обхода лимита 20 (несколько requests) реализована
- [ ] Шаг 3: Все 5 endpoints работают (list, get, analysis, comments, refresh)
- [ ] Шаг 3: Pydantic schemas валидируют данные
- [ ] Integration: `app/api/v1/router.py` include новый роутер
- [ ] Integration: `app/core/dependencies.py` добавить get_cache_service()
- [ ] Testing: curl requests тестируют каждый endpoint

---

## Testing Commands (после реализации)

```bash
# 1. List issues
curl "http://localhost:8000/api/v1/issues?status=open&page=1&limit=5"

# 2. Get issue details
curl "http://localhost:8000/api/v1/issues/64099"

# 3. Get comments
curl "http://localhost:8000/api/v1/issues/64099/comments"

# 4. Submit analysis
curl -X POST "http://localhost:8000/api/v1/issues/64099/analysis" \
  -H "Content-Type: application/json" \
  -d '{
    "mileage_from_sheet": 12500,
    "notes": "водитель указал 12500, система показала 12800"
  }'

# 5. Force refresh cache
curl "http://localhost:8000/api/v1/cache/refresh"
```

---

## Notes

- 🔑 **API Decision:** Используем Public REST API (Okdesk) + SQLite Cache (надежно, официально)
- 📊 **Data flow:** Okdesk → REST API → Loop (offset 0,20,40) → Deduplicate → SQLite
- ⚡ **Caching:** SQLite является источником истины (source of truth)
- 🔄 **Sync:** Background task будет обновлять кэш каждые 5 минут (Phase 1.5)
- 🎯 **Scope:** На этом этапе только backend, НЕ фронтенд

---

## Timeline: 3 дня

- **День 1:** Шаг 1 (Models + Migration) — 2-3 часа
- **День 2:** Шаг 2 (CacheService) — 3-4 часа  
- **День 3:** Шаг 3 (Endpoints) — 3-4 часа
- **Итого:** ~10-12 часов работы

---

**Готов? Начинай с Шага 1! 🚀**
