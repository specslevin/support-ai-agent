"""Support agent orchestrator: message → LLM (stub) → tools → reply."""

from __future__ import annotations

import json
import re
from typing import Any

import structlog
from pydantic import BaseModel, Field

from app.core.gpspos.diagnostics import GpsPosDiagnostics
from app.core.tools.registry import ToolRegistryMap

log = structlog.get_logger(__name__)


class ToolCallSpec(BaseModel):
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class AgentModelReply(BaseModel):
    thought: str
    tool_calls: list[ToolCallSpec] | None = None
    final_response: str | None = None


_STATUS_RE = re.compile(
    r"(?i)^\s*(?:/статус|статус)\s+(.+?)\s*$",
)
_SIMPLE_STATUS_RE = re.compile(
    r"(?i)^\s*/статус\s*$",
)


def _safe_parse_agent_json(text: str) -> AgentModelReply | None:
    text = text.strip()
    if not text:
        return None
    try:
        return AgentModelReply.model_validate_json(text)
    except Exception:
        return None


def _format_status_for_user(payload: dict[str, Any] | None) -> str:
    if not payload:
        return "Статус недоступен (нет данных по объекту или объект не найден)."
    online = payload.get("online")
    lat = payload.get("lat")
    lng = payload.get("lng")
    spd = payload.get("speed")
    sat = payload.get("sat")
    t = payload.get("time")
    parts = []
    if online is not None:
        parts.append("онлайн" if online else "офлайн")
    if lat is not None and lng is not None:
        parts.append(f"координаты: {lat}, {lng}")
    if spd is not None:
        parts.append(f"скорость: {spd}")
    if sat is not None:
        parts.append(f"спутники: {sat}")
    if t is not None:
        parts.append(f"время (unix): {t}")
    return "Статус объекта: " + "; ".join(parts) if parts else json.dumps(payload, ensure_ascii=False)


async def mock_llm_call(
    *,
    user_message: str,
    user_id: int,
    diagnostics: GpsPosDiagnostics,
    tool_results: list[dict[str, Any]] | None = None,
) -> AgentModelReply:
    """Deterministic stub: `/статус <id|plate>` or follow-up formatting."""
    _ = user_id
    if tool_results is not None:
        lines: list[str] = []
        for block in tool_results:
            name = block.get("name")
            res = block.get("result")
            if name == "get_object_status":
                lines.append(_format_status_for_user(res if isinstance(res, dict) else None))
            else:
                lines.append(f"{name}: {json.dumps(res, ensure_ascii=False)}")
        return AgentModelReply(
            thought="Сформирован ответ по данным инструментов (mock).",
            final_response="\n".join(lines) if lines else "Нет данных от инструментов.",
        )

    m = _STATUS_RE.match(user_message.strip())
    if m:
        ident = m.group(1).strip()
        oid: int | None = None
        if ident.isdigit():
            oid = int(ident)
        else:
            info = await diagnostics.find_object_by_identifier(ident)
            if info is not None:
                oid = info.id
        if oid is None:
            return AgentModelReply(
                thought="Идентификатор не найден; нужен числовой object_id или точный госномер/IMEI из базы.",
                final_response=(
                    "Не удалось сопоставить объект. Укажите числовой ID объекта в мониторинге "
                    "или проверьте госномер/IMEI. При необходимости создайте заявку в Okdesk."
                ),
            )
        return AgentModelReply(
            thought=f"Запрошен статус объекта {oid} по команде пользователя.",
            tool_calls=[ToolCallSpec(name="get_object_status", arguments={"object_id": oid})],
        )

    if _SIMPLE_STATUS_RE.match(user_message.strip()):
        return AgentModelReply(
            thought="Нет идентификатора в команде /статус.",
            final_response=(
                "Укажите ID объекта или идентификатор: например `/статус 12345` или `/статус А777НЕ777`."
            ),
        )

    demo = _safe_parse_agent_json(user_message)
    if demo is not None:
        return demo

    return AgentModelReply(
        thought="Общий запрос без распознанной команды (mock).",
        final_response=(
            "Я в режиме заглушки LLM. Напишите `/статус <ID или госномер>` для проверки, "
            "или опишите проблему — позже подключим полноценную модель. "
            "Если вопрос не решается в чате, создайте заявку в Okdesk."
        ),
    )


class SupportAgent:
    def __init__(
        self,
        tool_registry: ToolRegistryMap,
        diagnostics: GpsPosDiagnostics,
        *,
        llm_provider: str = "mock",
    ) -> None:
        self._tools = tool_registry
        self._diagnostics = diagnostics
        self._llm_provider = (llm_provider or "mock").strip().lower()

    async def _llm_turn(
        self,
        user_message: str,
        user_id: int,
        *,
        tool_results: list[dict[str, Any]] | None = None,
    ) -> AgentModelReply:
        if self._llm_provider == "mock":
            return await mock_llm_call(
                user_message=user_message,
                user_id=user_id,
                diagnostics=self._diagnostics,
                tool_results=tool_results,
            )
        # hermes / yandex: same JSON contract can be plugged here later
        log.warning("llm_provider_fallback_mock", provider=self._llm_provider)
        return await mock_llm_call(
            user_message=user_message,
            user_id=user_id,
            diagnostics=self._diagnostics,
            tool_results=tool_results,
        )

    async def _run_tool_calls(self, calls: list[ToolCallSpec]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for tc in calls:
            fn = self._tools.get(tc.name)
            if fn is None:
                out.append({"name": tc.name, "error": f"unknown_tool:{tc.name}"})
                log.warning("tool_unknown", tool=tc.name)
                continue
            try:
                result = await fn(**tc.arguments)
                out.append({"name": tc.name, "result": result})
                log.info("tool_ok", tool=tc.name)
            except Exception as e:  # noqa: BLE001
                log.exception("tool_fail", tool=tc.name, error=str(e))
                out.append({"name": tc.name, "error": str(e)})
        return out

    async def process_message(self, user_message: str, user_id: int) -> str:
        log.info("agent_message_in", user_id=user_id, len=len(user_message))

        first = await self._llm_turn(user_message, user_id, tool_results=None)
        if first.tool_calls:
            results = await self._run_tool_calls(first.tool_calls)
            second = await self._llm_turn(user_message, user_id, tool_results=results)
            text = (second.final_response or "").strip()
            log.info("agent_message_out", user_id=user_id, len=len(text), used_tools=True)
            return text or "Пустой ответ агента после инструментов."

        text = (first.final_response or "").strip()
        log.info("agent_message_out", user_id=user_id, len=len(text), used_tools=False)
        return text or "Пустой ответ агента."


__all__ = ["AgentModelReply", "SupportAgent", "mock_llm_call", "ToolCallSpec"]
