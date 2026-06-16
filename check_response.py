#!/usr/bin/env python3
"""Check full API response structure."""

import asyncio
import json
import sys

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from dotenv import load_dotenv
import httpx
from app.core.okdesk.config import OkdeskSettings


async def check():
    load_dotenv()
    settings = OkdeskSettings()

    async with httpx.AsyncClient(timeout=30.0) as client:
        url = f"{settings.BASE_URL}/issues/list"
        params = {"api_token": settings.API_TOKEN, "limit": 100}

        r = await client.get(url, params=params)

        print(f"Status: {r.status_code}")
        print(f"Headers:\n{json.dumps(dict(r.headers), indent=2, ensure_ascii=False)}\n")

        # Check if response is list or object
        data = r.json()
        print(f"Response type: {type(data)}")

        if isinstance(data, list):
            print(f"Response is LIST with {len(data)} items\n")
            print("First issue sample:")
            if data:
                print(json.dumps(data[0], indent=2, ensure_ascii=False))
        elif isinstance(data, dict):
            print(f"Response is DICT with keys: {list(data.keys())}\n")
            print(f"Full response:")
            print(json.dumps(data, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    asyncio.run(check())
