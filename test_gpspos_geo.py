#!/usr/bin/env python3
"""Test all major Geo API endpoints: objects, status, history, geozones, events."""

from __future__ import annotations

import asyncio
import json

from app.core.gpspos_geo import (
    GpsposGeoAuth,
    GpsposGeoClient,
    GpsposGeoSettings,
    GpsposGeoService,
)


async def main() -> None:
    settings = GpsposGeoSettings()
    auth = GpsposGeoAuth(settings)
    client = GpsposGeoClient(auth, settings.BASE_URL)
    svc = GpsposGeoService(client)

    print("=" * 60)

    # --- 1. Objects ---
    print("1. OBJECTS (первые 3)")
    print("-" * 40)
    objects: list | None = None
    try:
        objects = await svc.list_objects()
        print(f"   ✅ Всего объектов: {len(objects)}")
        for obj in objects[:3]:
            d = obj.model_dump(exclude_none=True)
            print(f"   #{obj.id}: {obj.name} | IMEI={obj.imei} | "
                  f"{obj.stateNumber} | {obj.deviceType}")
            print(f"      Поля: {list(d.keys())}")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 2. Object status ---
    print("2. OBJECT STATUS (первый объект)")
    print("-" * 40)
    oid: int | None = None
    try:
        if objects:
            oid = objects[0].id
            status = await svc.get_object_status(oid)
            if status:
                d = status.model_dump()
                print(f"   ✅ Object #{oid}: online={status.online} | "
                      f"lat={status.lat} lng={status.lng} | "
                      f"speed={status.speed} sat={status.sat} | time={status.time}")
                print(f"      Поля: {list(d.keys())}")
            else:
                print(f"   ⚠️ Статус для объекта #{oid} не получен (нет данных)")
        else:
            print("   ⚠️ Нет объектов для проверки статуса")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 3. Geozones ---
    print("3. GEOZONES")
    print("-" * 40)
    try:
        geozones = await svc.list_geozones()
        print(f"   ✅ Всего геозон: {len(geozones)}")
        for gz in geozones[:3]:
            print(f"   #{gz.get('id', '?')}: {gz.get('name', '—')}")
    except Exception as e:
        print(f"   ❌ {e}")

    try:
        groups = await svc.list_geozone_groups()
        print(f"   ✅ Групп геозон: {len(groups)}")
    except Exception as e:
        print(f"   ❌ groups: {e}")
    print()

    # --- 4. Events ---
    print("4. EVENTS (текущие неподтверждённые)")
    print("-" * 40)
    try:
        events = await svc.list_events()
        print(f"   ✅ Всего событий: {len(events)}")
        for ev in events[:5]:
            d = ev.model_dump()
            print(f"   #{ev.id}: object={ev.objectId} type={ev.type} "
                  f"status={ev.status}")
            print(f"      text: {ev.text}")
            print(f"      Поля: {list(d.keys())}")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 5. Object history ---
    print("5. OBJECT HISTORY (первый объект, 24ч)")
    print("-" * 40)
    try:
        if oid:
            history = await svc.get_object_history(oid, hours=24)
            print(f"   ✅ История объекта #{oid}: {len(history)} записей")
            if history:
                print(f"   Первая запись:")
                print(json.dumps(history[0], indent=2, ensure_ascii=False)[:500])
        else:
            print("   ⚠️ Нет объекта для проверки истории")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 6. Reverse geocode ---
    print("6. REVERSE GEOCODE (координаты Москвы)")
    print("-" * 40)
    try:
        addr = await svc.reverse_geocode(55.7558, 37.6173)
        print(f"   ✅ Адрес: {addr}")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    await auth.aclose()
    await client.aclose()
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
