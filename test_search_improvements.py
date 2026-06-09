import asyncio
import os
from dotenv import load_dotenv

load_dotenv()

from app.core.ai.tools import build_tool_functions
from app.core.gpspos import GpsPosAuth, GpsPosClient, GpsPosDiagnostics, GpsPosSettings
from app.core.okdesk import OkdeskClient, OkdeskService, OkdeskSettings


async def main():
    gps = GpsPosSettings()
    auth = GpsPosAuth(gps)
    client = GpsPosClient(auth, gps.BASE_URL)
    diagnostics = GpsPosDiagnostics(client)

    okdesk = OkdeskService(OkdeskClient(OkdeskSettings()))
    tools = build_tool_functions(okdesk, diagnostics)

    print("=" * 60)
    print("🔍 Тест 1: search_company('Россети')")
    print("=" * 60)
    result = await tools["search_company"]("Россети", limit=5)
    for c in result:
        print(f"  [{c['source']}] ID={c['id']} — {c['name']}")
    if not result:
        print("  (пусто)")
    print()

    print("=" * 60)
    print("🔍 Тест 2: search_company('Ситиматик')")
    print("=" * 60)
    result = await tools["search_company"]("Ситиматик", limit=5)
    for c in result:
        print(f"  [{c['source']}] ID={c['id']} — {c['name']}")
    if not result:
        print("  (пусто)")
    print()

    print("=" * 60)
    print("🔍 Тест 3: list_companies(limit=5)")
    print("=" * 60)
    result = await tools["list_companies"](limit=5)
    for c in result:
        print(f"  ID={c['id']} — {c['name']}")
    print(f"  ... всего результатов: {len(result)}")
    print()

    print("=" * 60)
    print("🔍 Тест 4: list_companies(search='Россети', limit=10)")
    print("=" * 60)
    result = await tools["list_companies"](search="Россети", limit=10)
    for c in result:
        print(f"  ID={c['id']} — {c['name']}")
    if not result:
        print("  (пусто)")
    print()

    print("✅ Поиск компаний улучшен. Протестируй в Telegram")


if __name__ == "__main__":
    asyncio.run(main())
