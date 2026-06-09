import asyncio
import os

from dotenv import load_dotenv

load_dotenv()

from app.core.ai.agent import AIAgent
from app.core.db.database import init_db
from app.core.gpspos import GpsPosAuth, GpsPosClient, GpsPosDiagnostics, GpsPosSettings
from app.core.okdesk import OkdeskClient, OkdeskService, OkdeskSettings


async def main():
    print("🔄 Инициализация БД...")
    await init_db()
    print("✅ Таблицы созданы")

    print("🔄 Инициализация сервисов...")
    gps_settings = GpsPosSettings()
    gps_auth = GpsPosAuth(gps_settings)
    gps_client = GpsPosClient(gps_auth, gps_settings.BASE_URL)
    diagnostics = GpsPosDiagnostics(gps_client)

    okdesk_settings = OkdeskSettings()
    okdesk_client = OkdeskClient(okdesk_settings)
    okdesk_service = OkdeskService(okdesk_client)

    agent = AIAgent(okdesk=okdesk_service, gpspos=diagnostics)
    print("✅ Агент создан")

    query = "Найди компанию Ситиматик и покажи последние 3 заявки по ней."
    print(f"\n🔍 Запрос: {query}\n")

    response = await agent.run(query, user_id="test_user")

    print(f"\n🤖 Ответ агента:\n{response}")
    print("\n✅ Инструменты и Агент созданы. Запусти python test_agent.py")


if __name__ == "__main__":
    asyncio.run(main())
