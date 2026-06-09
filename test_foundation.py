import asyncio
import os

from dotenv import load_dotenv

load_dotenv()

from app.core.db.database import init_db
from app.core.ai.llm import LLMClient


async def main():
    print("🔄 Создание таблиц...")
    await init_db()
    print("✅ Таблицы созданы")

    llm = LLMClient()

    print("🔄 Отправка тестового запроса к LLM...")
    response = await llm.chat([
        {"role": "user", "content": "Привет, ты работаешь? Напиши одно слово."}
    ])
    print(f"🤖 Ответ LLM: {response}")

    print("✅ Фундамент готов!")


if __name__ == "__main__":
    asyncio.run(main())
