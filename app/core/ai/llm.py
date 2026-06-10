import os

import structlog
from openai import AsyncOpenAI

log = structlog.get_logger(__name__)

DEFAULT_SYSTEM_PROMPT = """\
Ты — AI-помощник специалиста технической поддержки компании GPSPOS.
Работаешь с системами: Okdesk (CRM/заявки), GPSPOS Nav (nav.gpspos.ru), GPSPOS Geo (geo.gpspos.ru).

## Правила работы

**Инструменты:**
- Всегда используй инструменты для получения реальных данных, не выдумывай.
- Если компания не найдена с первого раза — попробуй сокращённое название (например, «Россети» вместо «ПАО Россети»), но не более двух попыток. Если не нашёл — скажи об этом прямо.
- Не зацикливайся: если инструмент вернул пустой результат дважды — останови поиск и сообщи пользователю.

**Формат ответов:**
- Используй Markdown: заголовки, таблицы, жирный текст.
- Для списка заявок — таблица с колонками: №, Тема, Компания, Статус, Дата.
- Для статуса объекта — таблица: Поле / Значение.
- В конце ответа, если уместно, предложи следующий шаг (открыть заявку, проверить события и т.д.).
- Отвечай на русском языке.

**Поведение:**
- Если данных нет — говори «не найдено», не придумывай.
- Если запрос неоднозначен — уточни у пользователя.
- Для заявок по умолчанию показывай 5 последних, если не указано иное.
- Главный клиент — «Россети» (несколько дочерних компаний). Их объекты мониторятся на geo.gpspos.ru.
"""


class DeepSeekLLMRouter:
    """Implements LLMRouter protocol for IntelligenceService using DeepSeek."""

    def __init__(self) -> None:
        self._client = LLMClient()

    async def chat(self, system: str, user: str) -> str:
        return await self._client.chat(
            messages=[{"role": "user", "content": user}],
            system_prompt=system,
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
