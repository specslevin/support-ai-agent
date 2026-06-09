#!/usr/bin/env python3
"""Extended test for ALL Okdesk API methods. Shows data structure and first records."""

from __future__ import annotations

import asyncio
import json

from app.core.okdesk import OkdeskClient, OkdeskService, OkdeskSettings


def _trim(s: str, n: int = 200) -> str:
    return s if len(s) <= n else s[:n] + "…"


async def main() -> None:
    settings = OkdeskSettings()
    client = OkdeskClient(settings)
    svc = OkdeskService(client)

    print("=" * 60)

    # --- 1. get_me ---
    print("1. GET ME (текущий сотрудник)")
    print("-" * 40)
    try:
        me = await svc.get_me()
        print(f"   ✅ Employee: {me.get('last_name', '')} {me.get('first_name', '')} "
              f"<{me.get('email', '')}> — {me.get('position', '')}")
        print(f"   Поля: {list(me.keys())}")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 2. Companies ---
    print("2. COMPANIES (первые 3)")
    print("-" * 40)
    try:
        companies = await svc.list_companies(limit=3)
        print(f"   ✅ Всего в ответе: {len(companies)}")
        for c in companies:
            d = c.model_dump(exclude_none=True)
            print(f"   #{c.id}: {c.name}")
            print(f"      Поля: {list(d.keys())}")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 3. get_company(593) ---
    print("3. GET COMPANY (id=593)")
    print("-" * 40)
    try:
        c = await svc.get_company(593)
        d = c.model_dump(exclude_none=True)
        print(f"   ✅ #{c.id}: {c.name}")
        print(f"   Полные данные:")
        print(json.dumps(d, indent=4, ensure_ascii=False)[:1500])
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 4. Issues ---
    print("4. ISSUES (последние 3)")
    print("-" * 40)
    issues: list | None = None
    try:
        issues = await svc.list_issues(limit=3)
        print(f"   ✅ Всего в ответе: {len(issues)}")
        for iss in issues:
            d = iss.model_dump(exclude_none=True)
            status = iss.status.name if iss.status else "—"
            priority = iss.priority.name if iss.priority else "—"
            print(f"   #{iss.id}: {_trim(iss.title or '', 60)}")
            print(f"      Статус: {status} | Приоритет: {priority}")
            print(f"      Поля: {list(d.keys())}")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 5. get_issue ---
    print("5. GET ISSUE (первый ID из списка)")
    print("-" * 40)
    try:
        if issues:
            iss = await svc.get_issue(issues[0].id)
            d = iss.model_dump(exclude_none=True)
            print(f"   ✅ #{iss.id}: {_trim(iss.title or '', 60)}")
            print(f"   Полные данные:")
            print(json.dumps(d, indent=4, ensure_ascii=False)[:1500])
        else:
            print("   ⚠️ Нет заявок для проверки")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 6. Contacts ---
    print("6. CONTACTS (первые 3)")
    print("-" * 40)
    contacts: list | None = None
    try:
        contacts = await svc.list_contacts(limit=3)
        print(f"   ✅ Всего в ответе: {len(contacts)}")
        for cnt in contacts:
            d = cnt.model_dump(exclude_none=True)
            print(f"   #{cnt.id}: {cnt.name} | {cnt.phone or '—'} | {cnt.email or '—'}")
            print(f"      Поля: {list(d.keys())}")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 7. get_contact ---
    print("7. GET CONTACT (первый ID из списка)")
    print("-" * 40)
    try:
        if contacts:
            cnt = await svc.get_contact(contacts[0].id)
            d = cnt.model_dump(exclude_none=True)
            print(f"   ✅ #{cnt.id}: {cnt.name}")
            print(f"   Полные данные:")
            print(json.dumps(d, indent=4, ensure_ascii=False)[:1500])
        else:
            print("   ⚠️ Нет контактов для проверки")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 8. Equipment ---
    print("8. EQUIPMENT (первые 3)")
    print("-" * 40)
    equipment: list | None = None
    try:
        equipment = await svc.list_equipment(limit=3)
        print(f"   ✅ Всего в ответе: {len(equipment)}")
        for eq in equipment:
            d = eq.model_dump(exclude_none=True)
            cname = eq.company.name if eq.company else "—"
            print(f"   #{eq.id}: {eq.inventory_number or eq.serial_number or '—'} | {cname}")
            print(f"      Поля: {list(d.keys())}")
    except Exception as e:
        print(f"   ❌ {e}")
    print()

    # --- 9. get_equipment ---
    print("9. GET EQUIPMENT (первый ID из списка)")
    print("-" * 40)
    try:
        if equipment:
            eq = await svc.get_equipment(equipment[0].id)
            d = eq.model_dump(exclude_none=True)
            print(f"   ✅ #{eq.id}: {eq.inventory_number or eq.serial_number or '—'}")
            print(f"   Полные данные:")
            print(json.dumps(d, indent=4, ensure_ascii=False)[:1500])
        else:
            print("   ⚠️ Нет оборудования для проверки")
    except Exception as e:
        print(f"   ❌ {e}")

    # --- 10. create_company (dry run — без реального создания) ---
    print("\n10. CREATE COMPANY (без вызова — проверка формата)")
    print("-" * 40)
    print("   Формат POST /companies: {\"company\": {\"name\": \"...\", ...}}")
    print("   Формат POST /issues:   {\"issue\": {\"subject\": \"...\", ...}}")
    print()

    await client.aclose()

    await client.aclose()
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
