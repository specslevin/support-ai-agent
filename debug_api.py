#!/usr/bin/env python3
"""Debug Okdesk API to find correct parameters for fetching all open issues."""

import asyncio
import sys
import json

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from dotenv import load_dotenv
from app.core.okdesk import OkdeskClient, OkdeskSettings


async def debug():
    load_dotenv()
    settings = OkdeskSettings()
    client = OkdeskClient(settings)

    print("Testing different parameter combinations...\n")

    # Try different parameter combinations
    tests = [
        {"limit": 1000},
        {"limit": 1000, "offset": 0},
        {"limit": 500},
        {"page[size]": 1000},
        {"page[size]": 500},
        {"per_page": 1000},
        {"status_code": "open"},
        {"status_code": "opened"},
        {"status": "Открыта", "limit": 1000},
        {"limit": 1000, "created[from]": "2000-01-01"},  # All time
    ]

    results = []

    for params in tests:
        try:
            print(f"Testing: {params}")
            data = await client._request("GET", "issues/list", params=params)
            count = len(data) if isinstance(data, list) else 0
            print(f"  Result: {count} issues\n")
            results.append({"params": params, "count": count, "sample": data[0] if data and isinstance(data, list) else None})
        except Exception as e:
            print(f"  Error: {e}\n")

    # Show best result
    best = max(results, key=lambda x: x["count"]) if results else None
    if best:
        print(f"\n✅ Best result: {best['count']} issues with params {best['params']}")

        # Show sample keys from first issue
        if best["sample"]:
            print(f"\nSample issue keys:")
            for key in best["sample"].keys():
                print(f"  - {key}")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(debug())
