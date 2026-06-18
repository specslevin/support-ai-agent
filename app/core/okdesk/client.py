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

    async def upload_attachment(
        self,
        issue_id: int,
        filename: str,
        content: bytes,
        content_type: str = "application/octet-stream",
    ) -> dict[str, Any] | None:
        """Upload a file to an issue as an attachment.

        Okdesk supports ``POST /api/v1/issues/{id}/attachments`` with
        multipart/form-data.  The file field must be named ``attachment_file``.
        If the endpoint is unavailable (404/422) we fall back to attaching the
        file via a private comment with ``attachment_file`` in the multipart
        body of ``POST /api/v1/issues/{id}/comments``.

        Returns the parsed JSON response, or None on failure (caller should
        log and continue — not raise).
        """
        url_direct = f"{self._base_url}/issues/{issue_id}/attachments"
        params = {"api_token": self._token}
        files = {"attachment_file": (filename, content, content_type)}

        r = await self._client.post(url_direct, params=params, files=files, timeout=60.0)

        if r.status_code in (404, 405, 422):
            # Endpoint not available for this Okdesk plan/version — fallback:
            # create a private (internal) comment that carries the file.
            url_comment = f"{self._base_url}/issues/{issue_id}/comments"
            data_fields = {
                "comment[content]": f"[Вложение из родительской заявки: {filename}]",
                "comment[public]": "false",
            }
            r = await self._client.post(
                url_comment,
                params=params,
                data=data_fields,
                files={"comment[attachments][][attachment_file]": (filename, content, content_type)},
                timeout=60.0,
            )

        if r.status_code >= 400:
            print(f"[Okdesk] upload_attachment failed {r.status_code}: {r.text[:200]}")
            return None

        try:
            return r.json()
        except Exception:
            return {"status": r.status_code}
