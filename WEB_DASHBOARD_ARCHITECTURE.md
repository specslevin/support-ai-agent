# Web Dashboard Architecture Plan

**Date Created:** 2026-06-13
**Project:** support-ai-agent web panel for techsupport
**Purpose:** Analyze GPS mileage discrepancy issues with Okdesk integration + GPSPOS Geo API

---

## Overview

**Problem:** Okdesk REST API использует нестандартную пагинацию `page[number]`/`page[size]` (max 50/запрос). В системе 25,000+ заявок; кэшируем последние 1000.

**Solution:** Build web dashboard with:
- React 18 + TypeScript + Vite frontend
- FastAPI backend (extend existing app)
- SQLite cache layer (2-level: SQLite + React Query)
- Real-time Okdesk + Geo data integration
- AI-powered analysis suggestions (DeepSeek)

**Visual Style:** Dark theme (morph.com style) + lime-green accent (#99d52a) from existing Figma UI Kit

---

## Tech Stack Selection

### Frontend
- **React 18 + TypeScript**
- **Vite** (fast bundler)
- **TanStack Query** (data caching + sync)
- **Zustand** (state management)
- **Tailwind CSS** (dark theme styling)
- **Leaflet + react-leaflet** (map widget)
- **axios** (HTTP client)

### Backend (extend existing FastAPI)
- Existing: FastAPI, SQLite, Okdesk API, GPSPOS Geo API
- Add: CacheService, new endpoints, background tasks
- Add DB tables: IssueCache, AnalysisCache, WebDashboardUser

### Styling
- **UI Kit from Figma:** Inter + Instrument Sans typography, lime-green #99d52a accent
- **Dark theme:** #0f0f0f background, #1a1a1a surface
- **Status colors:** open=red, in_progress=yellow, closed=green

---

## Architecture Diagram

```
User (Dashboard)
  ↓
React Component (Zustand + React Query)
  ↓
API Request (axios) → /api/v1/issues?status=open
  ↓
FastAPI Endpoint
  ├─ Check SQLite cache (issues, objects)
  ├─ If stale (>5min): call Okdesk API + Geo API
  ├─ Store in SQLite (issues_cache, analysis_cache)
  └─ Return to Frontend
  ↓
React Query caches + UI renders
```

---

## Backend Endpoints (New)

All under `/api/v1`:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/issues` | List all issues with filters (status, company, search, date, sort) |
| GET | `/issues/{issue_id}` | Full details + Geo data + comments |
| POST | `/issues/{issue_id}/analysis` | Submit mileage analysis, get AI suggestion |
| GET | `/issues/{issue_id}/comments` | Issue comments (REST polling) |
| POST | `/issues/{issue_id}/comments` | Add comment to issue |
| GET | `/objects/{object_id}/status` | Current Geo object status (cached) |
| GET | `/objects/{object_id}/history` | Event history (ignition, geofence, alarms) |
| GET | `/cache/refresh-issues` | Force sync Okdesk → SQLite |

---

## Database Extensions

Add 3 tables to SQLite:

1. **issue_cache** — fast local copy of Okdesk issues
   - external_id, subject, status, company_id, object_id, created_at, synced_at

2. **analysis_cache** — saved mileage analyses
   - issue_id, mileage_sheet, mileage_system, ai_suggestion, recommendation, created_at

3. **web_dashboard_user** — (optional) RBAC for web panel
   - email, hashed_password, role (viewer/support/admin)

---

## Frontend Page Layout

```
Dashboard
├─ Header (logo, user menu, theme toggle)
├─ Sidebar Nav (Issues, Objects, Reports, Settings)
├─ Main Content
│  ├─ Issues List Panel
│  │  ├─ Filters (status, company, date, search)
│  │  ├─ Table/Cards (31 items)
│  │  └─ Pagination
│  │
│  └─ Issue Details (split-view or modal)
│     ├─ Issue Info
│     ├─ Object Info (Geo API)
│     ├─ Mileage Comparison (sheet vs system)
│     ├─ Analysis Form (input mileage_sheet → AI suggests)
│     ├─ Comments Section (polling or WebSocket v1.1)
│     └─ Actions (Change Status, Send Comment, Resolve)
```

---

## Key Features

### Phase 1: Backend Cache Infrastructure ✅ ЗАВЕРШЁН (2026-06-13)
- ✅ IssueCache, AnalysisCache — SQLAlchemy models с индексами
- ✅ CacheService — refresh (page[number]/page[size]), query, save_analysis
- ✅ 6 dashboard endpoints: list, detail, refresh, analysis, comments GET/POST
- ✅ Задеплоен: 1000 заявок синхронизировано за ~25 сек
- ⬜ Phase 1.5: фоновый refresh каждые 5 мин (APScheduler)

### Phase 2: Frontend Setup 🚧 В РАБОТЕ
- React 18 + TypeScript + Vite
- TanStack Query + Zustand + Tailwind CSS dark theme
- API client (axios → /api/v1/issues)
- Issues list с фильтрами и пагинацией
- Issue detail panel

### Phase 3: Core Features
- Issue Details (с Geo данными + карта Leaflet)
- Analysis Form (ввод пробега → AI suggestion от DeepSeek)
- Comments section
- Actions (смена статуса)

### Phase 4: Polish & Deploy
- UI lime-green #99d52a accent, Inter font
- Build + serve через FastAPI static files
- Оптимизация React Query (staleTime, cacheTime)

**Total:** MVP v1.0 ≈ 4-6 недель от Phase 1

---

## Data Caching Strategy

### 2-Level Cache

**Level 1: SQLite (Cold Cache)**
- issue_cache: synced from Okdesk, TTL=5min
- analysis_cache: user-submitted analyses, TTL=1hour
- Background refresh every 5 minutes

**Level 2: React Query (Hot Cache)**
- staleTime: 1 minute
- cacheTime: 5 minutes
- Background refetch: 5 minutes
- User can force refresh: GET /cache/refresh-issues

### Invalidation
When user submits analysis:
1. Save to analysis_cache (DB)
2. Return to frontend
3. React Query invalidates query: `queryClient.invalidateQueries(['issue', id])`
4. Auto-refetch with new analysis data

---

## Critical Files to Create/Modify

### Backend
1. **app/core/db/models.py** — add IssueCache, AnalysisCache, WebDashboardUser
2. **app/core/services/cache_service.py** — new file, CacheService class
3. **app/api/v1/endpoints/issues_dashboard.py** — new file, endpoints
4. **app/api/v1/endpoints/objects_dashboard.py** — new file, Geo endpoints
5. **app/main.py** — add background cache refresh task
6. **app/core/dependencies.py** — add get_cache_service()

### Frontend
1. **frontend/src/api/client.ts** — axios instance + methods
2. **frontend/src/store/issuesStore.ts** — Zustand state
3. **frontend/src/components/IssuesList.tsx** — list view
4. **frontend/src/components/IssueDetails.tsx** — details panel
5. **frontend/src/components/IssueAnalysisForm.tsx** — analysis form
6. **frontend/src/styles/theme.ts** — color theme + tokens
7. **tailwind.config.js** — Tailwind config with dark theme

---

## Design References

- **Figma UI Kit:** DarkTheme with lime-green (#99d52a) accent, Inter + Instrument Sans fonts
- **Style Inspiration:** morph.com (minimal, functional, data-focused)
- **Accessibility:** WCAG 2.1 AA (semantic HTML, ARIA labels)

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Cache desync | Okdesk webhook on `/cache/refresh-issue/{id}` |
| Slow Geo API | Redis caching + async requests |
| No WebSocket | REST polling (3s) for MVP, WebSocket in v1.1 |
| AI context too large | Optimize DeepSeek prompt, use fast model |
| No auth | Optional JWT + session cookie |

---

## Future Enhancements (v1.1+)

- WebSocket for real-time comments
- Redis caching (instead of SQLite for scale)
- RBAC (Admin/Support/Viewer roles)
- Reports & analytics dashboard
- Batch operations (change status for multiple)
- Email notifications
- Slack/Telegram integration
