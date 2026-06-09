import asyncio
from dotenv import load_dotenv

load_dotenv()

from app.core.ai.tools import build_tool_functions
from app.core.db.database import AsyncSessionLocal, init_db
from app.core.db.models import Company as DBCompany
from app.core.db.sync import sync_companies
from app.core.gpspos import GpsPosAuth, GpsPosClient, GpsPosDiagnostics, GpsPosSettings
from app.core.okdesk import OkdeskClient, OkdeskService, OkdeskSettings
from sqlalchemy import func, select


async def main():
    await init_db()

    gps = GpsPosSettings()
    auth = GpsPosAuth(gps)
    client = GpsPosClient(auth, gps.BASE_URL)
    diagnostics = GpsPosDiagnostics(client)

    okdesk = OkdeskService(OkdeskClient(OkdeskSettings()))

    print("🔄 Синхронизация компаний из Okdesk...")
    count = await sync_companies(okdesk)
    print(f"✅ Синхронизировано: {count} компаний")

    async with AsyncSessionLocal() as session:
        total = (await session.execute(select(func.count(DBCompany.id)))).scalar()
        print(f"📊 Всего компаний в БД: {total}")

    tools = build_tool_functions(okdesk, diagnostics)

    print()
    print("=" * 60)
    print("🔍 Тест 1: search_company('Россети')")
    print("=" * 60)
    result = await tools["search_company"]("Россети", limit=5)
    for c in result:
        print(f"  [{c['source']}] ID={c['id']} — {c['name']}")
    if not result:
        print("  (не найдено)")

    print()
    print("=" * 60)
    print("🔍 Тест 2: search_company('Ситиматик')")
    print("=" * 60)
    result = await tools["search_company"]("Ситиматик", limit=5)
    for c in result:
        print(f"  [{c['source']}] ID={c['id']} — {c['name']}")
    if not result:
        print("  (не найдено)")

    print()
    print("=" * 60)
    print("🔍 Тест 3: search_company('СПЕЦ')")
    print("=" * 60)
    result = await tools["search_company"]("СПЕЦ", limit=5)
    for c in result:
        print(f"  [{c['source']}] ID={c['id']} — {c['name']}")
    if not result:
        print("  (не найдено)")

    print()
    print("=" * 60)
    print("🔍 Тест 4: list_companies(limit=5)")
    print("=" * 60)
    result = await tools["list_companies"](limit=5)
    for c in result:
        print(f"  [{c['source']}] ID={c['id']} — {c['name']}")

    print()
    print("=" * 60)
    print("🔍 Тест 5: list_companies(search='тех', limit=5)")
    print("=" * 60)
    result = await tools["list_companies"](search="тех", limit=5)
    for c in result:
        print(f"  [{c['source']}] ID={c['id']} — {c['name']}")
    if not result:
        print("  (не найдено)")

    print()
    print("✅ Поиск компаний улучшен. Протестируй в Telegram")


if __name__ == "__main__":
    asyncio.run(main())
