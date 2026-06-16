#!/usr/bin/env python3
"""Fetch ALL issues from Okdesk API with proper pagination."""

import asyncio
import json
import sys
from typing import Any

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from dotenv import load_dotenv
from app.core.okdesk import OkdeskClient, OkdeskSettings


async def get_all_issues() -> None:
    """Fetch all issues using multiple requests."""
    load_dotenv()

    settings = OkdeskSettings()
    client = OkdeskClient(settings)

    print("Fetching ALL issues from Okdesk API...\n")

    all_issues = []
    seen_ids = set()

    # Strategy: Keep requesting with offset until we get no new issues
    offset = 0
    batch_size = 100
    max_iterations = 10  # Safety limit

    for iteration in range(max_iterations):
        print(f"Request {iteration + 1}: offset={offset}, limit={batch_size}")

        try:
            data = await client._request(
                "GET",
                "issues/list",
                params={"offset": offset, "limit": batch_size}
            )

            if not isinstance(data, list):
                print(f"  ⚠️ Response is not a list: {type(data)}")
                break

            print(f"  Got {len(data)} issues")

            if not data:
                print("  No more issues, stopping.")
                break

            # Add new issues
            new_count = 0
            for issue in data:
                if isinstance(issue, dict) and "id" in issue:
                    issue_id = issue["id"]
                    if issue_id not in seen_ids:
                        all_issues.append(issue)
                        seen_ids.add(issue_id)
                        new_count += 1

            print(f"  Added {new_count} new issues (total: {len(all_issues)})\n")

            # If we got less than batch_size, we've reached the end
            if len(data) < batch_size:
                print("Got less issues than requested, stopping.")
                break

            offset += batch_size

        except Exception as e:
            print(f"  ❌ Error: {e}\n")
            break

    print(f"\n{'='*80}")
    print(f"✅ TOTAL: {len(all_issues)} unique issues\n")

    # Statistics
    if all_issues:
        # By status
        statuses = {}
        for issue in all_issues:
            if isinstance(issue.get("status"), dict):
                status = issue["status"].get("name", "Unknown")
            else:
                status = str(issue.get("status", "Unknown"))
            statuses[status] = statuses.get(status, 0) + 1

        print("By Status:")
        for status, count in sorted(statuses.items()):
            print(f"  {status}: {count}")

        # By type
        types = {}
        for issue in all_issues:
            if isinstance(issue.get("type"), dict):
                issue_type = issue["type"].get("name", "Unknown")
            else:
                issue_type = str(issue.get("type", "Unknown"))
            types[issue_type] = types.get(issue_type, 0) + 1

        print("\nBy Type:")
        for issue_type, count in sorted(types.items()):
            print(f"  {issue_type}: {count}")

        # Save to file
        with open("all_issues_complete.json", "w", encoding="utf-8") as f:
            json.dump(all_issues, f, ensure_ascii=False, indent=2)

        print(f"\n✅ Saved to all_issues_complete.json")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(get_all_issues())
