"""LLM-driven triage and GPSPOS cross-checks for support issues."""

from __future__ import annotations

import json
import re
from typing import Any, Protocol

import httpx
import structlog

from app.core.gpspos.client import GpsPosAPIError
from app.core.gpspos.diagnostics import GpsPosDiagnostics
from app.core.okdesk.client import OkdeskClient

log = structlog.get_logger(__name__)

_SYSTEM_PROMPT = (
    "Ты ассистент техподдержки. Проанализируй текст заявки. "
    "Если упоминается трекер, объект, госномер, IMEI — извлеки идентификатор. "
    "Если проблема связана с подключением, статусом, питанием — верни JSON: "
    '{"action": "check_gpspos_status", "identifier": "...", "check_type": "status|subscription|events"}. '
    "Если это вопрос по счёту/доступу — "
    '{"action": "check_subscription", "identifier": "..."}. '
    "Иначе — "
    '{"action": "draft_reply", "suggested_text": "..."}. '
    "Отвечай ТОЛЬКО валидным JSON."
)

_GPS_UNAVAILABLE = "⚠️ Не удалось проверить оборудование."


class LLMRouter(Protocol):
    """Minimal contract for the LLM backend used by :class:`IntelligenceService`."""

    async def chat(self, system: str, user: str) -> str:
        """Return assistant text (expected to be a single JSON object for triage)."""
        ...


def _extract_json_object(raw: str) -> dict[str, Any]:
    text = raw.strip()
    m = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
    if m:
        text = m.group(1)
    else:
        j = text.find("{")
        k = text.rfind("}")
        if j >= 0 and k > j:
            text = text[j : k + 1]
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("LLM output is not a JSON object")
    return data


class IntelligenceService:
    """
    Triage support text via LLM, optionally run GPSPOS diagnostics, and
    return draft client wording plus an internal note for the operator.
    """

    def __init__(
        self,
        llm_router: LLMRouter,
        gpspos_client: GpsPosDiagnostics,
        okdesk_client: OkdeskClient,
    ) -> None:
        self._llm = llm_router
        self._gps = gpspos_client
        self._okdesk = okdesk_client

    async def process_issue_text(self, text: str) -> dict[str, Any]:
        """
        Run LLM triage, optional GPS checks, and return draft + internal fields.

        Returns:
            ``{"draft": str, "internal_note": str, "actions": list[dict[str, Any]]}``
        """
        actions: list[dict[str, Any]] = []
        try:
            raw = await self._llm.chat(_SYSTEM_PROMPT, text)
        except Exception as e:  # noqa: BLE001
            log.exception("intelligence_llm_failed", module="okdesk", error=str(e))
            return {
                "draft": "Сейчас не удалось автоматически обработать заявку. Мы уточним детали у вас вручную.",
                "internal_note": f"Ошибка LLM: {e!s}",
                "actions": [{"type": "llm_error", "detail": str(e)}],
            }
        try:
            plan = _extract_json_object(raw)
        except (json.JSONDecodeError, ValueError) as e:
            log.warning("intelligence_json_parse", module="okdesk", error=str(e), raw_preview=raw[:300])
            return {
                "draft": raw.strip()[:4000] if raw else "—",
                "internal_note": "Ответ LLM не удалось разобрать как JSON; черновик взялся из сырого текста.",
                "actions": [{"type": "parse_error", "detail": str(e)}],
            }

        act = str(plan.get("action", "draft_reply"))
        log.info("intelligence_plan", module="okdesk", action=act, raw_keys=list(plan.keys()))

        if act == "check_subscription" or (
            act == "check_gpspos_status" and str(plan.get("check_type", "")).lower() == "subscription"
        ):
            return await self._run_gps_subscription(plan, text, actions)
        if act == "check_gpspos_status":
            ct = str(plan.get("check_type", "status")).lower()
            if ct == "status":
                return await self._run_gps_status(plan, text, actions)
            if ct == "events":
                return await self._run_gps_events(plan, text, actions)
            if ct == "subscription":
                return await self._run_gps_subscription(plan, text, actions)
        if act == "draft_reply":
            suggested = str(plan.get("suggested_text", "")).strip()
            if not suggested:
                suggested = "Мы уточним информацию и ответим в ближайшее время."
            actions.append({"type": "draft_reply", "source": "llm"})
            return {
                "draft": suggested,
                "internal_note": "Черновик сформирован LLM (без проверок оборудования).",
                "actions": actions,
            }

        actions.append({"type": "unhandled_action", "plan": plan})
        return {
            "draft": "Мы уточним детали и свяжемся с вами по заявке.",
            "internal_note": f"Необработанный сценарий: {json.dumps(plan, ensure_ascii=False)[:2000]}",
            "actions": actions,
        }

    def _identifier(self, plan: dict[str, Any]) -> str:
        return str(plan.get("identifier", "")).strip()

    async def _run_gps_status(
        self,
        plan: dict[str, Any],
        _original_text: str,
        actions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        ident = self._identifier(plan)
        if not ident:
            return {
                "draft": "Пожалуйста, укажите в заявке госномер, IMEI или идентификатор объекта — так мы сможем проверить его статус.",
                "internal_note": "LLM: check_gpspos_status, но идентификатор пустой.",
                "actions": actions + [{"type": "missing_identifier", "check": "status"}],
            }
        try:
            obj = await self._gps.find_object_by_identifier(ident)
        except (GpsPosAPIError, OSError, httpx.RequestError) as e:
            log.warning("intelligence_gpspos_find_failed", module="okdesk", error=str(e), identifier=ident)
            return self._gps_fail(actions, "status", str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("intelligence_gpspos_find_unexpected", module="okdesk", error=str(e))
            return self._gps_fail(actions, "status", str(e))
        if obj is None:
            return {
                "draft": f"По идентификатору «{ident}» в системе мониторинга совпадений не найдено. Проверьте, пожалуйста, данные.",
                "internal_note": f"find_object: не найдено по «{ident}» (status).",
                "actions": actions + [{"type": "object_not_found", "identifier": ident}],
            }
        try:
            st = await self._gps.get_object_status(obj.id)
        except (GpsPosAPIError, OSError, httpx.RequestError) as e:
            log.warning("intelligence_gpspos_status_failed", module="okdesk", error=str(e), object_id=obj.id)
            return self._gps_fail(actions, f"get_object_status:{obj.id}", str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("intelligence_gpspos_status_unexpected", module="okdesk", object_id=obj.id)
            return self._gps_fail(actions, f"get_object_status:{obj.id}", str(e))
        if st is None:
            return {
                "draft": "Статус объекта сейчас не получен (нет текущей позиции). Перезвоним или ответим после проверки.",
                "internal_note": f"status: object_id={obj.id}, нет positions.",
                "actions": actions + [{"type": "gpspos_status", "object_id": obj.id, "empty": True}],
            }
        online_ru = "онлайн" if st.online else "оффлайн"
        internal = (
            f"status: object_id={obj.id}, online={st.online}, time={st.time}, "
            f"lat={st.lat}, lng={st.lng}, speed={st.speed}, sat={st.sat}."
        )
        draft = (
            f"По запросу: объект сейчас {online_ru}, скорость {st.speed}, спутники {st.sat}. "
            f"Координаты уточнены; при необходимости сотрудник перезвонит с деталями."
        )
        actions.append(
            {
                "type": "gpspos_status",
                "object_id": obj.id,
                "online": st.online,
                "speed": st.speed,
            }
        )
        return {"draft": draft, "internal_note": internal, "actions": actions}

    async def _run_gps_subscription(
        self,
        plan: dict[str, Any],
        _original_text: str,
        actions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        ident = self._identifier(plan)
        if not ident:
            return {
                "draft": "Пожалуйста, укажите в заявке госномер, IMEI или идентификатор, чтобы проверить подписку.",
                "internal_note": "LLM: check_subscription, но идентификатор пустой.",
                "actions": actions + [{"type": "missing_identifier", "check": "subscription"}],
            }
        try:
            obj = await self._gps.find_object_by_identifier(ident)
        except (GpsPosAPIError, OSError, httpx.RequestError) as e:
            log.warning("intelligence_gpspos_find_failed", module="okdesk", error=str(e), identifier=ident)
            return self._gps_fail(actions, "subscription", str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("intelligence_gpspos_find_unexpected", module="okdesk", error=str(e))
            return self._gps_fail(actions, "subscription", str(e))
        if obj is None:
            return {
                "draft": f"По идентификатору «{ident}» в системе мониторинга совпадений не найдено.",
                "internal_note": f"find_object: не найдено по «{ident}» (subscription).",
                "actions": actions + [{"type": "object_not_found", "identifier": ident}],
            }
        try:
            sub = await self._gps.check_subscription(obj.id)
        except (GpsPosAPIError, OSError, httpx.RequestError) as e:
            log.warning("intelligence_gpspos_sub_failed", module="okdesk", error=str(e), object_id=obj.id)
            return self._gps_fail(actions, f"check_subscription:{obj.id}", str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("intelligence_gpspos_sub_unexpected", module="okdesk", object_id=obj.id)
            return self._gps_fail(actions, f"check_subscription:{obj.id}", str(e))
        status = str(sub.get("status", "unknown"))
        days_left = int(sub.get("days_left", 0))
        if status == "expired":
            draft = "По выбранному объекту подписка в системе мониторинга истекла. Оформите продление, чтобы сохранить доступ."
        elif status == "soon":
            draft = f"Подписка ещё активна, осталось ориентировочно {days_left} сут. Рекомендуем заранее продлить доступ."
        else:
            draft = f"Подписка активна, осталось ориентировочно {days_left} сут."
        internal = f"subscription: object_id={obj.id}, status={status}, days_left={days_left}."
        actions.append({"type": "gpspos_subscription", "object_id": obj.id, "sub": sub})
        return {"draft": draft, "internal_note": internal, "actions": actions}

    async def _run_gps_events(
        self,
        plan: dict[str, Any],
        _original_text: str,
        actions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        ident = self._identifier(plan)
        if not ident:
            return {
                "draft": "Пожалуйста, укажите госномер, IMEI или идентификатор, чтобы просмотреть последние события.",
                "internal_note": "LLM: events, пустой идентификатор.",
                "actions": actions + [{"type": "missing_identifier", "check": "events"}],
            }
        try:
            obj = await self._gps.find_object_by_identifier(ident)
        except (GpsPosAPIError, OSError, httpx.RequestError) as e:
            log.warning("intelligence_gpspos_find_failed", module="okdesk", error=str(e), identifier=ident)
            return self._gps_fail(actions, "events", str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("intelligence_gpspos_find_unexpected", module="okdesk", error=str(e))
            return self._gps_fail(actions, "events", str(e))
        if obj is None:
            return {
                "draft": f"По идентификатору «{ident}» в системе мониторинга совпадений не найдено.",
                "internal_note": f"find: не «{ident}» (events).",
                "actions": actions + [{"type": "object_not_found", "identifier": ident}],
            }
        try:
            evs = await self._gps.get_last_events(obj.id, hours=24)
        except (GpsPosAPIError, OSError, httpx.RequestError) as e:
            log.warning("intelligence_gpspos_events_failed", module="okdesk", error=str(e), object_id=obj.id)
            return self._gps_fail(actions, f"get_last_events:{obj.id}", str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("intelligence_gpspos_events_unexpected", module="okdesk", object_id=obj.id)
            return self._gps_fail(actions, f"get_last_events:{obj.id}", str(e))
        if not evs:
            draft = "За последние 24 часа по объекту зарегистрированных событий не видно. Если ситуация сохраняется, напишите, что именно наблюдали — проверим глубже."
        else:
            head = evs[0]
            recent = f"Последняя запись: время {head.time}, тип {head.type}, статус {head.status}, «{head.text}»"
            if len(evs) > 1:
                recent += f" (и ещё {len(evs) - 1} соб.)"
            draft = f"Кратко по событиям: {recent}."
        internal = f"events 24h: object_id={obj.id}, count={len(evs)}."
        actions.append({"type": "gpspos_events", "object_id": obj.id, "count": len(evs)})
        return {"draft": draft, "internal_note": internal, "actions": actions}

    def _gps_fail(
        self,
        actions: list[dict[str, Any]],
        stage: str,
        err: str,
    ) -> dict[str, Any]:
        actions = actions + [{"type": "gpspos_error", "stage": stage, "error": err}]
        return {
            "draft": (
                "Сейчас не удалось автоматически сверить данные с сервером мониторинга. "
                "Мы проверим вручную и ответим."
            ),
            "internal_note": f"{_GPS_UNAVAILABLE} (этап: {stage}, {err})",
            "actions": actions,
        }
