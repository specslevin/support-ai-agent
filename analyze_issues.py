#!/usr/bin/env python3
"""Analyze Okdesk issues from the last week to understand support patterns."""

import asyncio
import json
import sys
from datetime import datetime, timedelta
from typing import Any

# Force UTF-8 output on Windows
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from dotenv import load_dotenv

from app.core.okdesk import OkdeskClient, OkdeskService, OkdeskSettings


async def analyze_issues() -> None:
    """Fetch and analyze issues from the last 7 days."""
    load_dotenv()

    settings = OkdeskSettings()
    client = OkdeskClient(settings)
    service = OkdeskService(client)

    # Get issues - try without date filter first
    print(f"📊 Fetching ALL issues (no date filter)...\n")

    try:
        # Try to get all issues with pagination
        all_issues = []
        offset = 0
        page_size = 100

        while True:
            print(f"Fetching issues: offset={offset}, limit={page_size}...", end=" ")
            issues = await service.list_issues(limit=page_size, offset=offset)
            print(f"got {len(issues)}")

            if not issues:
                break

            all_issues.extend(issues)

            if len(issues) < page_size:
                break

            offset += page_size

        issues = all_issues
        print(f"\n✅ Found {len(issues)} total issues\n")

        if not issues:
            print("No issues found.")
            await client.aclose()
            return

        # Analyze each issue
        analysis_results = []

        for idx, issue in enumerate(issues, 1):
            print(f"\n{'='*80}")
            print(f"Issue #{idx}: ID {issue.id}")
            print(f"{'='*80}")

            # Basic info
            print(f"Title: {issue.title}")
            print(f"Status: {issue.status.name if issue.status else 'N/A'}")
            print(f"Priority: {issue.priority.name if issue.priority else 'N/A'}")
            print(f"Type: {issue.type.name if issue.type else 'N/A'}")
            print(f"Company: {issue.company.name if issue.company else 'N/A'}")
            print(f"Contact: {issue.contact.name if issue.contact else 'N/A'}")
            print(f"Created: {issue.created_at}")
            print(f"Updated: {issue.updated_at}")
            if issue.description:
                print(f"\nDescription:\n{issue.description[:500]}")

            # Get comments
            try:
                comments = await service.get_issue_comments(issue.id)
                print(f"\n💬 Comments ({len(comments)}):")
                for comment in comments[:5]:  # Show first 5
                    print(f"  [{comment.author.name if comment.author else 'Unknown'}] {comment.created_at}")
                    print(f"    {comment.content[:200]}...")
                    if comment.is_internal:
                        print(f"    (internal)")
            except Exception as e:
                print(f"⚠️ Could not fetch comments: {e}")

            # Get commenters to identify who is handling the issue
            handlers = set()
            try:
                comments = await service.get_issue_comments(issue.id)
                for comment in comments:
                    if comment.author and comment.author.name:
                        # Exclude system notifications
                        if "Системное" not in comment.author.name:
                            handlers.add(comment.author.name)
            except:
                pass

            # Collect data
            analysis_results.append({
                "id": issue.id,
                "title": issue.title,
                "status": issue.status.name if issue.status else None,
                "priority": issue.priority.name if issue.priority else None,
                "company": issue.company.name if issue.company else None,
                "contact": issue.contact.name if issue.contact else None,
                "created_at": str(issue.created_at),
                "updated_at": str(issue.updated_at),
                "type": issue.type.name if issue.type else None,
                "handlers": list(handlers),  # Who is handling this issue
            })

        # Summary statistics
        print(f"\n\n{'='*80}")
        print("📈 SUMMARY STATISTICS")
        print(f"{'='*80}\n")

        # By status
        statuses = {}
        for issue in issues:
            status = issue.status.name if issue.status else "Unknown"
            statuses[status] = statuses.get(status, 0) + 1

        print("By Status:")
        for status, count in sorted(statuses.items()):
            print(f"  {status}: {count}")

        # By priority
        priorities = {}
        for issue in issues:
            priority = issue.priority.name if issue.priority else "Unknown"
            priorities[priority] = priorities.get(priority, 0) + 1

        print("\nBy Priority:")
        for priority, count in sorted(priorities.items()):
            print(f"  {priority}: {count}")

        # By type
        types = {}
        for issue in issues:
            issue_type = issue.type.name if issue.type else "Unknown"
            types[issue_type] = types.get(issue_type, 0) + 1

        print("\nBy Type:")
        for issue_type, count in sorted(types.items()):
            print(f"  {issue_type}: {count}")

        # By handlers
        handlers = {}
        for issue in issues:
            if issue.id in [r["id"] for r in analysis_results]:
                result = next(r for r in analysis_results if r["id"] == issue.id)
                for handler in result["handlers"]:
                    handlers[handler] = handlers.get(handler, 0) + 1

        if handlers:
            print("\nBy Handler (who processes issues):")
            for handler, count in sorted(handlers.items(), key=lambda x: x[1], reverse=True):
                print(f"  {handler}: {count}")

        # Save to JSON
        with open("issues_analysis.json", "w", encoding="utf-8") as f:
            json.dump(analysis_results, f, ensure_ascii=False, indent=2)
        print("\n✅ Analysis saved to issues_analysis.json")

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(analyze_issues())
