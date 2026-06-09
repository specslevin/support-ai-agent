#!/usr/bin/env python3
"""Test Wialon Remote API: login only (to check credentials)."""

from __future__ import annotations

import asyncio
import sys

from app.core.wialon import WialonClient, WialonService, WialonSettings


async def main() -> None:
    settings = WialonSettings()

    if not settings.PASSWORD.strip():
        print("⚠️  Заполни WIALON_PASSWORD в .env")
        sys.exit(1)

    client = WialonClient(settings)
    svc = WialonService(client)

    print("=" * 60)
    print("WIALON LOGIN")
    print("-" * 40)

    try:
        result = await svc.login()
        if result.ssid:
            print(f"   ✅ Успешная авторизация")
            print(f"   eid  = {result.eid}")
            print(f"   ssid = {result.ssid[:20]}...")
        elif result.error:
            print(f"   ❌ Ошибка авторизации: error={result.error}")
            print(f"      (4=invalid session, 7=bad credentials, 8=token expired)")
        else:
            print(f"   ⚠️ Неизвестный ответ: {result.model_dump()}")
    except Exception as e:
        print(f"   ❌ {e}")

    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
