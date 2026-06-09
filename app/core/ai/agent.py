from __future__ import annotations

import json
from typing import Any

import structlog

from app.core.ai.llm import DEFAULT_SYSTEM_PROMPT, LLMClient
from app.core.ai.tools import AVAILABLE_TOOLS, build_tool_functions
from app.core.db.database import AsyncSessionLocal
from app.core.db.models import ChatHistory
from app.core.gpspos.diagnostics import GpsPosDiagnostics
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)


class AIAgent:
    def __init__(
        self,
        okdesk: OkdeskService,
        gpspos: GpsPosDiagnostics,
    ) -> None:
        self.llm = LLMClient()
        self.tool_definitions = AVAILABLE_TOOLS
        self.tool_functions = build_tool_functions(okdesk, gpspos)

    async def run(self, user_message: str, user_id: str) -> str:
        system_msg: dict[str, str] = {
            "role": "system",
            "content": DEFAULT_SYSTEM_PROMPT,
        }

        messages: list[dict[str, Any]] = [
            {"role": "user", "content": user_message},
        ]

        max_turns = 10
        for turn in range(max_turns):
            log.info(
                "llm_call",
                turn=turn,
                tool_count=len(self.tool_definitions),
            )
            api_kwargs: dict[str, Any] = dict(
                model=self.llm.model,
                messages=[system_msg, *messages],
                tools=self.tool_definitions,
                tool_choice="auto",
                temperature=0.7,
                max_tokens=2048,
            )

            try:
                response = await self.llm.client.chat.completions.create(**api_kwargs)
                msg = response.choices[0].message
            except Exception:
                log.exception("llm_api_error", turn=turn)
                text = "Ошибка связи с AI"
                await self._save_history(user_id, user_message, text)
                return text

            if not msg.tool_calls:
                text = msg.content or ""
                log.info("llm_response", text_len=len(text))
                await self._save_history(user_id, user_message, text)
                return text

            log.info(
                "tool_calls_received",
                turn=turn,
                names=[tc.function.name for tc in msg.tool_calls],
            )
            messages.append(msg.model_dump())

            for tc in msg.tool_calls:
                fn = self.tool_functions.get(tc.function.name)
                if fn is None:
                    result_text = json.dumps(
                        {"error": f"Unknown tool: {tc.function.name}"}
                    )
                else:
                    args = json.loads(tc.function.arguments)
                    log.info("executing_tool", tool=tc.function.name, args=args)
                    result = await fn(**args)
                    result_text = json.dumps(
                        result, ensure_ascii=False, default=str
                    )

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_text,
                })

        fallback = "Агент превысил лимит итераций. Попробуйте уточнить запрос."
        await self._save_history(user_id, user_message, fallback)
        return fallback

    async def _save_history(
        self, user_id: str, user_message: str, response: str
    ) -> None:
        async with AsyncSessionLocal() as session:
            session.add(ChatHistory(user_id=user_id, role="user", content=user_message))
            session.add(
                ChatHistory(user_id=user_id, role="assistant", content=response)
            )
            await session.commit()
