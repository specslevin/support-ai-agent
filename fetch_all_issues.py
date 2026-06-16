#!/usr/bin/env python3
"""Fetch ALL issues from Okdesk with proper pagination."""

import asyncio
import json
import sys
from typing import Any

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from dotenv import load_dotenv
from app.core.okdesk import OkdeskClient, OkdeskSettings


async def fetch_all_issues() -> None:
    """Fetch all issues with multiple pagination strategies."""
    load_dotenv()

    settings = OkdeskSettings()
    client = OkdeskClient(settings)

    print("Trying different pagination strategies...\n")

    # Strategy 1: Large limit
    print("Strategy 1: limit=1000")
    data1 = await client._request("GET", "issues/list", params={"limit": 1000})
    issues1 = data1 if isinstance(data1, list) else []
    print(f"  Got {len(issues1)} issues\n")

    # Strategy 2: offset-based pagination
    print("Strategy 2: offset-based pagination")
    all_issues = []
    offset = 0
    page_size = 100

    while True:
        data = await client._request("GET", "issues/list", params={"offset": offset, "limit": page_size})
        rows = data if isinstance(data, list) else []
        print(f"  offset={offset}: got {len(rows)} issues")

        if not rows:
            break

        all_issues.extend(rows)

        if len(rows) < page_size:
            break

        offset += page_size

    print(f"\n  Total with offset: {len(all_issues)}\n")

    # Strategy 3: Try with status filter (to get only open)
    print("Strategy 3: Filter by status code")
    open_issues = []
    for status_code in ["open", "opened", "active", "new"]:
        try:
            data = await client._request("GET", "issues/list", params={"status": status_code, "limit": 1000})
            rows = data if isinstance(data, list) else []
            print(f"  status={status_code}: got {len(rows)} issues")
            if rows:
                open_issues.extend(rows)
        except Exception as e:
            print(f"  status={status_code}: error {e}")

    print(f"\n  Total with status filter: {len(open_issues)}\n")

    # Show actual statuses from all issues
    print("Unique issue statuses in all_issues:")
    statuses = set()
    for issue in all_issues:
        if isinstance(issue, dict) and "status" in issue:
            if isinstance(issue["status"], dict):
                statuses.add(issue["status"].get("name"))
            else:
                statuses.add(str(issue["status"]))

    for status in sorted(statuses):
        count = sum(1 for i in all_issues if isinstance(i, dict) and
                   (i.get("status", {}).get("name") if isinstance(i.get("status"), dict) else i.get("status")) == status)
        print(f"  '{status}': {count}")

    # Save raw data
    with open("all_issues_raw.json", "w", encoding="utf-8") as f:
        json.dump(all_issues, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Saved {len(all_issues)} issues to all_issues_raw.json")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(fetch_all_issues())
