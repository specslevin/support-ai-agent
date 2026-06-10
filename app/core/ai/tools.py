from __future__ import annotations

import json
from typing import Any

import structlog
from sqlalchemy import select

from app.core.db.database import AsyncSessionLocal
from app.core.db.models import Company as DBCompany
from app.core.gpspos.diagnostics import GpsPosDiagnostics
from app.core.gpspos_geo.service import GpsposGeoService
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)

AVAILABLE_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_company",
            "description": (
                "Search for companies by name using fuzzy matching. "
                "Queries both the local database and Okdesk CRM. "
                "Returns matching companies with id, name, and source. "
                "Use this when the user asks to find a company by name."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Company name or substring to search for. Supports partial matches.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default 5)",
                    },
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_companies",
            "description": (
                "Get a list of all companies from Okdesk CRM. "
                "Optionally filter by search substring. "
                "Returns companies with id and name."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of companies to return (default 10)",
                    },
                    "search": {
                        "type": "string",
                        "description": "Optional substring to filter companies by name",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_object_status",
            "description": (
                "Get current monitoring status of a vehicle or device by its license plate "
                "(gosnumber), IMEI, or name. Returns online/offline, coordinates, speed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "License plate (gosnumber), IMEI, or name of the vehicle",
                    },
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_geo_objects",
            "description": (
                "Get a list of all tracked vehicles/devices from GPSPOS Geo (geo.gpspos.ru). "
                "Returns object id, name, IMEI, and subscription info. "
                "Use when the user asks what objects are registered in the geo system."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_geo_object_status",
            "description": (
                "Get current GPS status of a vehicle or device by its numeric object_id "
                "from GPSPOS Geo (geo.gpspos.ru). Returns coordinates, speed, online flag. "
                "Use after list_geo_objects to look up the id."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "object_id": {
                        "type": "integer",
                        "description": "Numeric object id from GPSPOS Geo",
                    },
                },
                "required": ["object_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_geozones",
            "description": (
                "Get a list of geofence zones configured in GPSPOS Geo (geo.gpspos.ru). "
                "Returns zone id and name. Use when the user asks about geofences."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_issues",
            "description": (
                "Get a list of support tickets/issues from Okdesk. "
                "Optionally filter by company name. Returns issue id, title, status, date."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "company_name": {
                        "type": "string",
                        "description": "Optional company name to filter issues by",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max number of issues to return (default 5)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_issue_details",
            "description": (
                "Get full details of a specific Okdesk ticket by its numeric id. "
                "Returns title, description, status, priority, company, contact, dates. "
                "Use this after list_issues to read the full content of a ticket."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "issue_id": {
                        "type": "integer",
                        "description": "Numeric Okdesk issue id",
                    },
                },
                "required": ["issue_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_issue_comments",
            "description": (
                "Get comments/replies on a specific Okdesk ticket. "
                "Returns a list of comments with author, text, and timestamp. "
                "Use to read the conversation history on a ticket."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "issue_id": {
                        "type": "integer",
                        "description": "Numeric Okdesk issue id",
                    },
                },
                "required": ["issue_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_comment",
            "description": (
                "Add an internal comment to an Okdesk ticket. "
                "The comment is internal (not visible to client). "
                "Use only when the user explicitly asks to add a note or comment to a ticket."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "issue_id": {
                        "type": "integer",
                        "description": "Numeric Okdesk issue id",
                    },
                    "text": {
                        "type": "string",
                        "description": "Comment text to add",
                    },
                },
                "required": ["issue_id", "text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_company_equipment",
            "description": (
                "Get a list of equipment (trackers, devices) registered for a company in Okdesk. "
                "Returns equipment id, serial number, model, kind. "
                "Use when the user asks what equipment/devices a company has."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "company_name": {
                        "type": "string",
                        "description": "Company name to look up equipment for",
                    },
                },
                "required": ["company_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_object_events",
            "description": (
                "Get event history for a tracked vehicle/device from GPSPOS Geo (geo.gpspos.ru). "
                "Returns events (ignition on/off, geofence entry/exit, alarms) with timestamps. "
                "Use when the user asks what happened with a vehicle in the last N hours."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "object_id": {
                        "type": "integer",
                        "description": "Numeric object id from GPSPOS Geo (use list_geo_objects to find it)",
                    },
                    "hours": {
                        "type": "integer",
                        "description": "How many hours back to look (default 24, max 72)",
                    },
                },
                "required": ["object_id"],
            },
        },
    },
]


def build_tool_functions(
    okdesk: OkdeskService,
    gpspos: GpsPosDiagnostics,
    geo: GpsposGeoService | None = None,
) -> dict[str, Any]:
    async def search_company(
        name: str, limit: int = 5
    ) -> list[dict[str, Any]]:
        seen: set[int] = set()
        results: list[dict[str, Any]] = []

        async with AsyncSessionLocal() as session:
            stmt = select(DBCompany).where(
                DBCompany.name.ilike(f"%{name}%")
            ).order_by(DBCompany.name)
            db_companies = (await session.execute(stmt)).scalars().all()
            for c in db_companies:
                if c.external_id not in seen:
                    seen.add(c.external_id)
                    results.append(
                        {"id": c.external_id, "name": c.name, "source": c.source}
                    )

        if len(results) < limit:
            okdesk_companies = await okdesk.list_companies()
            lower = name.lower()
            for c in okdesk_companies:
                if c.id not in seen and lower in c.name.lower():
                    seen.add(c.id)
                    results.append({"id": c.id, "name": c.name, "source": "okdesk"})

        return results[:limit]

    async def list_companies(
        limit: int = 10, search: str | None = None
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []

        async with AsyncSessionLocal() as session:
            stmt = select(DBCompany).order_by(DBCompany.name)
            if search:
                stmt = stmt.where(DBCompany.name.ilike(f"%{search}%"))
            db_companies = (await session.execute(stmt)).scalars().all()
            for c in db_companies:
                results.append({"id": c.external_id, "name": c.name, "source": c.source})

        if search and not results:
            all_okdesk = await okdesk.list_companies()
            lower = search.lower()
            for c in all_okdesk:
                if lower in c.name.lower():
                    results.append({"id": c.id, "name": c.name, "source": "okdesk"})

        return results[:limit]

    async def get_object_status(name: str) -> dict[str, Any]:
        obj = await gpspos.find_object_by_identifier(name)
        if obj is None:
            return {"error": f"Object '{name}' not found"}

        status = await gpspos.get_object_status(obj.id)
        if status is None:
            return {"error": f"Status unavailable for object '{obj.name}'"}

        return {
            "object_id": obj.id,
            "name": obj.name,
            "gosnumber": getattr(obj, "stateNumber", None),
            "imei": obj.imei,
            "online": status.online,
            "lat": status.lat,
            "lng": status.lng,
            "speed": status.speed,
            "satellites": status.sat,
            "time": status.time,
        }

    async def list_issues(
        company_name: str | None = None, limit: int = 5
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if company_name:
            companies = await okdesk.list_companies(search=company_name)
            if companies:
                params["company_id"] = companies[0].id
            else:
                return []

        issues = await okdesk.list_issues(**params)
        return [
            {
                "id": i.id,
                "title": i.title,
                "status": i.status.name if i.status else "unknown",
                "created_at": str(i.created_at) if i.created_at else None,
                "company": i.company.name if i.company else None,
            }
            for i in issues[:limit]
        ]

    async def list_geo_objects() -> list[dict[str, Any]]:
        if geo is None:
            return [{"error": "GPSPOS Geo not configured"}]
        objects = await geo.list_objects()
        return [
            {
                "id": o.id,
                "name": o.name,
                "imei": o.imei,
                "payed_till": str(o.payedTill) if o.payedTill else None,
            }
            for o in objects
        ]

    async def get_geo_object_status(object_id: int) -> dict[str, Any]:
        if geo is None:
            return {"error": "GPSPOS Geo not configured"}
        status = await geo.get_object_status(object_id)
        if status is None:
            return {"error": f"Status unavailable for object_id={object_id}"}
        return {
            "object_id": object_id,
            "online": status.online,
            "lat": status.lat,
            "lng": status.lng,
            "speed": status.speed,
            "satellites": status.sat,
            "time": status.time,
        }

    async def list_geozones() -> list[dict[str, Any]]:
        if geo is None:
            return [{"error": "GPSPOS Geo not configured"}]
        zones = await geo.list_geozones()
        return [{"id": z.get("id"), "name": z.get("name")} for z in zones]

    async def get_issue_details(issue_id: int) -> dict[str, Any]:
        try:
            issue = await okdesk.get_issue(issue_id)
        except Exception as e:
            return {"error": f"Issue {issue_id} not found: {e}"}
        return {
            "id": issue.id,
            "title": issue.title,
            "description": issue.description,
            "status": issue.status.name if issue.status else None,
            "priority": issue.priority.name if issue.priority else None,
            "type": issue.type.name if issue.type else None,
            "company": issue.company.name if issue.company else None,
            "contact": issue.contact.name if issue.contact else None,
            "created_at": issue.created_at,
            "updated_at": issue.updated_at,
            "deadline_at": issue.deadline_at,
        }

    async def get_issue_comments(issue_id: int) -> list[dict[str, Any]]:
        try:
            comments = await okdesk.get_issue_comments(issue_id)
        except Exception as e:
            return [{"error": f"Could not fetch comments for issue {issue_id}: {e}"}]
        return [
            {
                "id": c.id,
                "author": c.author.name if c.author else None,
                "content": c.content,
                "created_at": c.created_at,
                "is_internal": c.is_internal,
            }
            for c in comments
        ]

    async def add_comment(issue_id: int, text: str) -> dict[str, Any]:
        try:
            result = await okdesk.add_comment(issue_id, text)
            return {"ok": True, "result": result}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def get_company_equipment(company_name: str) -> list[dict[str, Any]]:
        companies = await okdesk.list_companies(search=company_name)
        if not companies:
            return [{"error": f"Company '{company_name}' not found"}]
        company_id = companies[0].id
        try:
            equipment = await okdesk.list_equipment(company_id=company_id)
        except Exception as e:
            return [{"error": f"Could not fetch equipment: {e}"}]
        return [
            {
                "id": eq.id,
                "serial_number": eq.serial_number,
                "inventory_number": eq.inventory_number,
                "kind": eq.equipment_kind.name if eq.equipment_kind else None,
                "model": eq.equipment_model.name if eq.equipment_model else None,
                "manufacturer": eq.equipment_manufacturer.name if eq.equipment_manufacturer else None,
            }
            for eq in equipment
        ]

    async def get_object_events(object_id: int, hours: int = 24) -> list[dict[str, Any]]:
        if geo is None:
            return [{"error": "GPSPOS Geo not configured"}]
        hours = min(hours, 72)
        events = await geo.get_object_history(object_id, hours=hours)
        return [
            {
                "time": e.get("time"),
                "type": e.get("type"),
                "text": e.get("text"),
                "status": e.get("status"),
            }
            for e in events[:50]
        ]

    return {
        "search_company": search_company,
        "list_companies": list_companies,
        "get_object_status": get_object_status,
        "list_issues": list_issues,
        "list_geo_objects": list_geo_objects,
        "get_geo_object_status": get_geo_object_status,
        "list_geozones": list_geozones,
        "get_issue_details": get_issue_details,
        "get_issue_comments": get_issue_comments,
        "add_comment": add_comment,
        "get_company_equipment": get_company_equipment,
        "get_object_events": get_object_events,
    }
