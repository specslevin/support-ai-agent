#!/usr/bin/env python3
"""Quick test for Okdesk API client. Reads .env, calls get_me() and list_companies()."""

from __future__ import annotations

import asyncio

from app.core.okdesk import OkdeskClient, OkdeskService, OkdeskSettings


async def main() -> None:
    settings = OkdeskSettings()
    client = OkdeskClient(settings)
    service = OkdeskService(client)

    try:
        print("=== get_me() ===")
        me = await service.get_me()
        print(me)
    except Exception as e:
        print(f"get_me() failed: {e}")

    try:
        print("\n=== list_companies() ===")
        companies = await service.list_companies()
        if companies:
            for c in companies:
                print(f"  #{c.id} {c.name}")
        else:
            print("  (empty)")
    except Exception as e:
        print(f"list_companies() failed: {e}")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
