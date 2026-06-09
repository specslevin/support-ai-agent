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

    return {
        "search_company": search_company,
        "list_companies": list_companies,
        "get_object_status": get_object_status,
        "list_issues": list_issues,
        "list_geo_objects": list_geo_objects,
        "get_geo_object_status": get_geo_object_status,
        "list_geozones": list_geozones,
    }
