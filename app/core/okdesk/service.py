"""High-level Okdesk helpers for issues, companies, contacts, and equipment."""

from __future__ import annotations

from typing import Any

from .client import OkdeskClient
from .models import Company, Contact, Employee, Equipment, EquipmentCompany, Issue


def _ensure_list(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    return []


class OkdeskService:
    def __init__(self, client: OkdeskClient) -> None:
        self._client = client

    async def get_me(self) -> dict[str, Any]:
        data = await self._client._request("GET", "employees/list", params={"limit": 1})
        rows = _ensure_list(data)
        if rows:
            return Employee.model_validate(rows[0]).model_dump()
        return {}

    async def list_companies(self, **params: Any) -> list[Company]:
        data = await self._client._request("GET", "companies/list", params=params)
        rows = _ensure_list(data)
        return [Company.model_validate(r) for r in rows]

    async def get_company(self, company_id: int) -> Company:
        data = await self._client._request("GET", "companies/", params={"id": company_id})
        return Company.model_validate(data)

    async def create_company(self, **fields: Any) -> Company:
        data = await self._client._request("POST", "companies", json={"company": fields})
        return Company.model_validate(data)

    async def list_contacts(self, **params: Any) -> list[Contact]:
        data = await self._client._request("GET", "contacts/list", params=params)
        rows = _ensure_list(data)
        return [Contact.model_validate(r) for r in rows]

    async def get_contact(self, contact_id: int) -> Contact:
        data = await self._client._request("GET", "contacts/", params={"id": contact_id})
        return Contact.model_validate(data)

    async def list_issues(self, **params: Any) -> list[Issue]:
        data = await self._client._request("GET", "issues/list", params=params)
        rows = _ensure_list(data)
        return [Issue.model_validate(r) for r in rows]

    async def get_issue(self, issue_id: int) -> Issue:
        data = await self._client._request("GET", f"issues/{issue_id}")
        return Issue.model_validate(data)

    async def create_issue(self, **fields: Any) -> Issue:
        data = await self._client._request("POST", "issues", json={"issue": fields})
        return Issue.model_validate(data)

    async def list_equipment(self, **params: Any) -> list[Equipment]:
        data = await self._client._request("GET", "equipments/list", params=params)
        rows = _ensure_list(data)
        return [Equipment.model_validate(r) for r in rows]

    async def get_equipment(self, equipment_id: int) -> Equipment:
        data = await self._client._request("GET", f"equipments/{equipment_id}")
        return Equipment.model_validate(data)

    async def discover_company_ids(self) -> set[int]:
        """Collect all company IDs from companies, issues, contacts, and equipment."""
        ids: set[int] = set()

        for c in await self.list_companies(limit=100):
            ids.add(c.id)

        for issue in await self.list_issues():
            if issue.company and issue.company.id:
                ids.add(issue.company.id)

        for contact in await self.list_contacts():
            if contact.company_id:
                ids.add(contact.company_id)

        for equip in await self.list_equipment():
            if isinstance(equip.company, EquipmentCompany):
                ids.add(equip.company.id)
            if isinstance(equip.maintenance_entity, EquipmentCompany):
                ids.add(equip.maintenance_entity.id)

        return ids
