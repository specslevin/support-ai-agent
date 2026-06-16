#!/usr/bin/env python3
"""Collect 200+ recent issues with descriptions and comments for analysis."""

import asyncio
import json
import sys

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from dotenv import load_dotenv
from app.core.okdesk import OkdeskClient, OkdeskService, OkdeskSettings

TARGET = 300


async def main() -> None:
    load_dotenv()
    settings = OkdeskSettings()
    client = OkdeskClient(settings)
    service = OkdeskService(client)

    # Okdesk list paginates via id cursor: pagination[from_id] / pagination[direction]=reverse
    collected: dict[int, dict] = {}
    last_id = None
    page = 0
    while len(collected) < TARGET and page < 40:
        params = {"pagination[limit]": 100, "pagination[direction]": "reverse"}
        if last_id is not None:
            params["pagination[from_id]"] = last_id
        data = await client._request("GET", "issues/list", params=params)
        rows = data if isinstance(data, list) else []
        if not rows:
            break
        for r in rows:
            collected[r["id"]] = r
        last_id = min(r["id"] for r in rows)
        page += 1
        print(f"page {page}: +{len(rows)}, total {len(collected)}, last_id={last_id}")

    ids = sorted(collected.keys(), reverse=True)[:TARGET]
    print(f"\nFetching detail + comments for {len(ids)} issues...")

    out = []
    for i, iid in enumerate(ids, 1):
        rec = {}
        try:
            issue = await service.get_issue(iid)
            rec = {
                "id": issue.id,
                "title": issue.title,
                "description": issue.description,
                "type": issue.type.name if issue.type else None,
                "type_code": issue.type.code if issue.type else None,
                "status": issue.status.name if issue.status else None,
                "company": issue.company.name if issue.company else None,
                "contact": issue.contact.name if issue.contact else None,
                "assignee": issue.assignee.name if issue.assignee else None,
                "author": issue.author.name if issue.author else None,
                "created_at": issue.created_at,
                "updated_at": issue.updated_at,
                "parameters": [{"name": p.name, "value": p.value} for p in issue.parameters],
                "comments": [],
            }
            try:
                comments = await service.get_issue_comments(iid)
                rec["comments"] = [
                    {
                        "author": c.author.name if c.author else None,
                        "author_type": c.author.type if c.author else None,
                        "created_at": c.created_at,
                        "is_internal": c.is_internal,
                        "content": c.content,
                    }
                    for c in comments
                ]
            except Exception as e:
                rec["comments_error"] = str(e)
        except Exception as e:
            rec = {"id": iid, "error": str(e)}
        out.append(rec)
        if i % 20 == 0:
            print(f"  {i}/{len(ids)}")

    with open("dataset.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\nSaved {len(out)} issues to dataset.json")
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
