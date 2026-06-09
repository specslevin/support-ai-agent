"""Support agent: orchestrator and prompts."""

from __future__ import annotations

from .orchestrator import AgentModelReply, SupportAgent, ToolCallSpec, mock_llm_call
from .prompts import AGENT_RESPONSE_SCHEMA_HINT, FOLLOWUP_SYSTEM_PROMPT, SUPPORT_AGENT_SYSTEM_PROMPT

__all__ = [
    "AGENT_RESPONSE_SCHEMA_HINT",
    "AgentModelReply",
    "FOLLOWUP_SYSTEM_PROMPT",
    "SUPPORT_AGENT_SYSTEM_PROMPT",
    "SupportAgent",
    "ToolCallSpec",
    "mock_llm_call",
]
