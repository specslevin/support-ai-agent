"""Maps LLM tool names to async GPSPOS implementations for an agentic loop."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from app.core.gpspos.diagnostics import GpsPosDiagnostics

ToolHandler = Callable[..., Awaitable[Any]]
ToolRegistryMap = dict[str, ToolHandler]

TOOL_REGISTRY: ToolRegistryMap = {}


def build_tool_registry(diagnostics: GpsPosDiagnostics) -> ToolRegistryMap:
    """
    Build a name → coroutine-function map and store it on :data:`TOOL_REGISTRY`.

    Returns the same mapping for convenience (e.g. local binding in tests).
    """

    global TOOL_REGISTRY

    async def get_object_status(object_id: int) -> dict[str, Any] | None:
        st = await diagnostics.get_object_status(object_id)
        if st is None:
            return None
        return st.model_dump(mode="json")

    async def get_object_info(object_id: int) -> dict[str, Any]:
        return await diagnostics.get_object_info(object_id)

    async def get_events(object_id: int, hours: int = 24) -> list[dict[str, Any]]:
        items = await diagnostics.get_last_events(object_id, hours=hours)
        return [e.model_dump(mode="json") for e in items]

    async def reverse_geocode(lat: float, lng: float) -> str:
        return await diagnostics.reverse_geocode(lat, lng)

    TOOL_REGISTRY = {
        "get_object_status": get_object_status,
        "get_object_info": get_object_info,
        "get_events": get_events,
        "reverse_geocode": reverse_geocode,
    }
    return TOOL_REGISTRY
