"""OpenAI-compatible function definitions for GPSPOS tools (LLM function calling)."""

from __future__ import annotations

from typing import Any, TypedDict


class _FunctionSpec(TypedDict):
    name: str
    description: str
    parameters: dict[str, Any]


class _ToolEntry(TypedDict):
    type: str
    function: _FunctionSpec


AVAILABLE_TOOLS: list[_ToolEntry] = [
    {
        "type": "function",
        "function": {
            "name": "get_object_status",
            "description": (
                "Get the current monitoring status of a GPS device: whether it is online or offline, "
                "last known Unix timestamp, latitude and longitude (WGS84), speed, and satellite count. "
                "Use this when the user asks where a vehicle is, if it is online, or for live coordinates. "
                "Requires the numeric object/device id from the fleet (not IMEI or plate)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "object_id": {
                        "type": "integer",
                        "description": (
                            "Fleet object id (primary key in the monitoring system). "
                            "Obtain it from object lists or prior lookups when the user does not provide it."
                        ),
                    },
                },
                "required": ["object_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_object_info",
            "description": (
                "Retrieve detailed device and vehicle information: IMEI, human-readable name, state registration "
                "plate (license plate), phone number, device type, paid-until timestamp (Unix), and a derived "
                "subscription summary (active, expiring soon within 7 days, or expired with days left). "
                "Use for questions about subscription, plate number, IMEI, or device metadata."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "object_id": {
                        "type": "integer",
                        "description": "Fleet object id for the device/vehicle to describe.",
                    },
                },
                "required": ["object_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_events",
            "description": (
                "Fetch recent monitoring events for a device: alarms, sensor triggers, and textual event "
                "descriptions within a time window ending at now. Each item includes event type, status, "
                "time (Unix seconds), and free-text details. Use when the user asks about alerts, history, "
                "or what happened recently on a unit."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "object_id": {
                        "type": "integer",
                        "description": "Fleet object id whose event log should be queried.",
                    },
                    "hours": {
                        "type": "integer",
                        "description": (
                            "Look-back window in hours from the current time. "
                            "If omitted, defaults to 24 hours. Use a smaller window for very recent issues "
                            "or a larger one for broader history (e.g. 72)."
                        ),
                    },
                },
                "required": ["object_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reverse_geocode",
            "description": (
                "Convert geographic coordinates (latitude and longitude in decimal degrees, WGS84) into a "
                "human-readable address string using the provider geocoder. Use after obtaining coordinates "
                "from status or map context when the user wants a street or place description."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "lat": {
                        "type": "number",
                        "description": "Latitude in decimal degrees (e.g. 55.7558).",
                    },
                    "lng": {
                        "type": "number",
                        "description": "Longitude in decimal degrees (e.g. 37.6173).",
                    },
                },
                "required": ["lat", "lng"],
            },
        },
    },
]
