import os

import structlog
from openai import AsyncOpenAI

log = structlog.get_logger(__name__)

DEFAULT_SYSTEM_PROMPT = (
    "Ты — AI-помощник специалиста технической поддержки GPSPOS. "
    "Отвечай четко, по делу, используй данные из контекста. "
    "Если не знаешь ответа — так и скажи.\n\n"
    "Ты умеешь искать компании по названию (даже по части названия).\n"
    "Примеры:\n"
    "- «Найди компанию Россети» — ищет все компании, в названии которых есть «Россети»\n"
    "- «Покажи список компаний» — выводит список всех компаний из Okdesk\n"
    "- «Найди компанию Ситиматик и покажи последние 3 заявки» — ищет компанию, затем заявки"
)


class LLMClient:
    def __init__(self):
        api_key = os.getenv("DEEPSEEK_API_KEY", "sk-placeholder")
        base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
        model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

        key_preview = f"{api_key[:8]}..." if api_key else "MISSING"
        log.info(
            "llm_client_init",
            model=model,
            base_url=base_url,
            api_key_preview=key_preview,
        )

        self.model = model
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def chat(
        self,
        messages: list[dict],
        system_prompt: str | None = None,
    ) -> str:
        full_messages: list[dict] = [
            {"role": "system", "content": system_prompt or DEFAULT_SYSTEM_PROMPT}
        ]
        full_messages.extend(messages)

        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=full_messages,
                temperature=0.7,
                max_tokens=2048,
            )
            return response.choices[0].message.content or ""
        except Exception:
            return "Ошибка связи с AI"
