"""HTTP client for Okdesk API."""

from __future__ import annotations

from typing import Any

import httpx

from .config import OkdeskSettings


class OkdeskClient:
    def __init__(self, settings: OkdeskSettings) -> None:
        self._token = settings.API_TOKEN
        self._base_url = settings.BASE_URL.rstrip("/")
        self._employee_id = settings.EMPLOYEE_ID
        self._client = httpx.AsyncClient(timeout=30.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, endpoint: str, **kwargs: Any) -> Any:
        url = f"{self._base_url}/{endpoint.lstrip('/')}"

        params = {**(kwargs.pop("params", None) or {}), "api_token": self._token}

        r = await self._client.request(method, url, params=params, **kwargs)

        if r.status_code in (401, 403):
            print(f"[Okdesk] Auth error {r.status_code}: {r.text}")
            r.raise_for_status()
        if r.status_code == 404:
            print(f"[Okdesk] Not found {r.status_code}: {r.text}")
            r.raise_for_status()
        if r.status_code >= 500:
            print(f"[Okdesk] Server error {r.status_code}: {r.text}")
            r.raise_for_status()

        r.raise_for_status()
        return r.json()

    async def get_issue_comments(self, issue_id: int) -> Any:
        return await self._request("GET", f"issues/{issue_id}/comments")

    async def add_comment(self, issue_id: int, content: str, public: bool = True) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"issues/{issue_id}/comments",
            json={"content": content, "author_id": self._employee_id, "public": public},
        )

    async def list_equipment_by_company(self, company_id: int) -> Any:
        return await self._request("GET", "equipments/list", params={"company_id": company_id})

    async def get_attachment_url(self, issue_id: int, attachment_id: int) -> str | None:
        """Resolve the (short-lived, presigned) download URL for an attachment."""
        data = await self._request("GET", f"issues/{issue_id}/attachments/{attachment_id}")
        if isinstance(data, dict):
            return data.get("attachment_url")
        return None

    async def download_attachment(self, issue_id: int, attachment_id: int) -> tuple[bytes, str] | None:
        """Download attachment bytes. Returns (data, content_type) or None."""
        url = await self.get_attachment_url(issue_id, attachment_id)
        if not url:
            return None
        r = await self._client.get(url, follow_redirects=True)
        r.raise_for_status()
        return r.content, r.headers.get("content-type", "application/octet-stream")
