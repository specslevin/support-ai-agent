"""Issue automation pipeline for «Расхождение пробега» tickets.

Flow: parse issue (plate, date, declared mileage) → find geo object →
fetch DailyStat (real system mileage) + ObjectPackets (telemetry) →
analyse power / satellites / track gaps → classify cause and draft an
answer for the operator to confirm.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any

import structlog

from app.core.gpspos_geo.service import GpsposGeoService
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)

# Voltage below this on the external power input is treated as "power off".
_POWER_OFF_V = 7.0
# Satellites below this means effectively no reliable GPS fix.
_MIN_SAT = 4
# A gap in telemetry longer than this (minutes) during the day is a track break.
_TRACK_GAP_MIN = 30
# Implied speed (km/h) between two consecutive points above this = a "teleport"
# (track shot / прострел) — a strong GPS jamming/spoofing signature.
_TELEPORT_KMH = 150
# Plausible top speed (km/h) for the tracked vehicles; spikes above = spoofing.
_SPEED_SPIKE_KMH = 110


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

# Plate: letter + 3 digits + 2 letters, optional 2-3 region digits
# (some tickets omit the region, e.g. "Х774НВ").
_PLATE_RE = re.compile(r"[АВЕКМНОРСТУХABEKMHOPCTYX]\d{3}[АВЕКМНОРСТУХABEKMHOPCTYX]{2}\d{0,3}", re.I)
_DATE_RE = re.compile(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})")


def _strip_html(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip()


def _to_km(value: float, unit: str | None) -> float:
    if unit and unit.lower().startswith("м") and not unit.lower().startswith("км"):
        return round(value / 1000.0, 3)
    return value


def _parse_number(raw: str) -> float:
    return float(raw.replace(",", ".").replace(" ", ""))


@dataclass
class ParsedIssue:
    plate: str | None = None
    date: str | None = None  # ISO date YYYY-MM-DD
    sheet_mileage_km: float | None = None  # по путевому листу
    declared_system_km: float | None = None  # «в ПК», то что увидел клиент


@dataclass
class TelemetryFacts:
    object_id: int | None = None
    object_name: str | None = None
    system_mileage_km: float | None = None  # из DailyStat length
    max_speed: float | None = None
    move_time_min: float | None = None
    packets: int = 0
    avg_sat: float | None = None
    low_sat_ratio: float | None = None  # доля пакетов с sat < _MIN_SAT
    min_power_v: float | None = None
    avg_power_v: float | None = None
    power_off_ratio: float | None = None  # доля пакетов с pwr_ext < _POWER_OFF_V
    max_gap_min: float | None = None  # макс разрыв трека, минут
    zero_coord_moving_ratio: float | None = None  # координаты 0 при скорости>0 (глушение)
    max_speed_packet: float | None = None  # макс скорость по сырым пакетам
    speed_spike_count: int = 0  # пакетов со скоростью > _SPEED_SPIKE_KMH
    teleport_jumps: int = 0  # «прострелы» трека (телепорты координат)
    max_implied_kmh: float | None = None  # макс расчётная скорость между точками
    flags: list[str] = field(default_factory=list)


@dataclass
class AutomationResult:
    parsed: ParsedIssue
    telemetry: TelemetryFacts
    category: str
    confidence: float
    draft_answer: str
    reasoning: str
    needs_review: bool = True
    error: str | None = None


# Canonical answer catalogue mirroring okdesk-console templates (category -> guidance).
_CATEGORY_CATALOG: list[dict[str, str]] = [
    {"key": "Данные верны", "when": "Реальный пробег системы близок к путевому листу, обрывов трека нет, питание в норме. Разницу объясняем пробуксовкой/малой скоростью/диаметром колёс.",
     "template": "Добрый день! Обрывов в треке и неисправностей терминала не обнаружено. Пробег за {date} по данным системы составил {system_km} км. Разница между пробегом по путевому листу и данными терминала могла возникнуть из-за пробуксовки колёс, движения на минимальной скорости/расстояниях или нестандартного диаметра колёс. Данным системы мониторинга можно верить."},
    {"key": "Глушение", "when": "Признаки РЭБ: пропадание спутников и/или нулевые координаты при движении, прострелы трека.",
     "template": "Добрый день! Расхождение пробега связано с проездом в зоне глушения GPS/ГЛОНАСС-сигнала (воздействие средств РЭБ). В такие моменты терминал не может корректно определить местоположение и пробег. Устранить эти сбои невозможно, оборудование исправно."},
    {"key": "Не было питания", "when": "Напряжение внешнего питания падало до нуля — терминал был обесточен, трек за этот период восстановить нельзя.",
     "template": "Здравствуйте! В указанную дату ({date}) отсутствовало питающее напряжение на входах терминала. Нет возможности восстановить трек за период, когда питание терминала было отключено."},
    {"key": "Терминал подключился", "when": "Терминал выгрузил данные позже, пробег теперь корректный и близок к ПЛ.",
     "template": "Добрый день! Терминал подключился и выгрузил данные. Пробег за {date} составил {system_km} км."},
    {"key": "Изменили настройки", "when": "Трек был, но детектор поездок занижал пробег; после корректировки настроек пробег отобразился полностью.",
     "template": "Добрый день! Изменили настройки детектора поездок. Трек отобразился полностью, пробег за {date} составил {system_km} км."},
    {"key": "Диагностика", "when": "Терминал не на связи / нет данных за дату и нет признаков глушения или штатного отключения — нужна удалённая диагностика силами клиента.",
     "template": "Здравствуйте! Для первичной удалённой диагностики терминала просим: 1. Включить питание терминала (массу или клеммы АКБ) и не выключать до конца рабочего дня. 2. Проверить целостность проводов питания. 3. Проверить светодиодную индикацию на корпусе. Сообщите о результате."},
]


class IssueAutomationService:
    def __init__(self, okdesk: OkdeskService, geo: GpsposGeoService, llm: Any) -> None:
        self._okdesk = okdesk
        self._geo = geo
        self._llm = llm

    # ----- parsing -------------------------------------------------------
    def parse_issue(self, title: str | None, description: str | None,
                    params: list[dict[str, Any]] | None = None) -> ParsedIssue:
        title = title or ""
        body = _strip_html(description)
        text = f"{title} {body}"
        parsed = ParsedIssue()

        m = _PLATE_RE.search(title) or _PLATE_RE.search(text)
        if m:
            parsed.plate = m.group(0).upper()

        dm = _DATE_RE.search(text)
        if dm:
            d, mo, y = int(dm.group(1)), int(dm.group(2)), int(dm.group(3))
            try:
                parsed.date = _dt.date(y, mo, d).isoformat()
            except ValueError:
                pass

        # по путевому листу / по ПЛ <num> <unit>
        sm = re.search(r"(?:путев\w*\s+лист\w*|по\s*ПЛ|ПЛ)\D{0,6}(\d+(?:[.,]\d+)?)\s*(км|м)?", text, re.I)
        if sm:
            parsed.sheet_mileage_km = _to_km(_parse_number(sm.group(1)), sm.group(2))

        # «в ПК <num> <unit>» — то, что клиент видит в системе
        cm = re.search(r"в\s*ПК\D{0,6}(\d+(?:[.,]\d+)?)\s*(км|м)?", text, re.I)
        if cm:
            parsed.declared_system_km = _to_km(_parse_number(cm.group(1)), cm.group(2))
        return parsed

    # ----- telemetry -----------------------------------------------------
    async def gather_telemetry(self, plate: str, iso_date: str) -> TelemetryFacts:
        facts = TelemetryFacts()
        obj = await self._geo.find_object_by_plate(plate)
        if not obj:
            facts.flags.append("object_not_found")
            return facts
        oid = int(obj["id"])
        facts.object_id = oid
        facts.object_name = obj.get("name")

        day = _dt.date.fromisoformat(iso_date)
        start = _dt.datetime.combine(day, _dt.time.min)
        end = start + _dt.timedelta(days=1)
        from_ms = int(start.timestamp() * 1000)
        till_ms = int(end.timestamp() * 1000)

        stats = await self._geo.get_daily_stats(oid, from_ms, till_ms)
        ymd = int(day.strftime("%Y%m%d"))
        row = next((r for r in stats if r.get("day") == ymd), stats[0] if stats else None)
        if row:
            facts.system_mileage_km = round(float(row.get("length") or 0) / 1000.0, 2)
            facts.max_speed = row.get("maxSpeed")
            facts.move_time_min = round(float(row.get("moveTime") or 0) / 60000.0, 1)

        packets = await self._geo.get_packets(oid, from_ms, till_ms)
        facts.packets = len(packets)
        if packets:
            packets.sort(key=lambda p: p.get("time") or 0)
            sats = [p.get("sat") or 0 for p in packets]
            powers = [
                (p.get("tags") or {}).get("pwr_ext")
                for p in packets
                if isinstance(p.get("tags"), dict) and (p.get("tags") or {}).get("pwr_ext") is not None
            ]
            facts.avg_sat = round(sum(sats) / len(sats), 1)
            facts.low_sat_ratio = round(sum(1 for s in sats if s < _MIN_SAT) / len(sats), 2)
            if powers:
                facts.min_power_v = round(min(powers), 1)
                facts.avg_power_v = round(sum(powers) / len(powers), 1)
                facts.power_off_ratio = round(sum(1 for v in powers if v < _POWER_OFF_V) / len(powers), 2)
            moving_zero = sum(
                1 for p in packets
                if (p.get("speed") or 0) > 0 and (not p.get("lat") or not p.get("lng"))
            )
            facts.zero_coord_moving_ratio = round(moving_zero / len(packets), 2)
            # max telemetry gap (minutes)
            times = [p.get("time") or 0 for p in packets]
            gaps = [(times[i] - times[i - 1]) for i in range(1, len(times))]
            facts.max_gap_min = round(max(gaps) / 60000.0, 1) if gaps else 0.0

            # speed spikes (spoofing): implausibly high reported speed
            speeds = [p.get("speed") or 0 for p in packets]
            facts.max_speed_packet = max(speeds) if speeds else 0
            facts.speed_spike_count = sum(1 for s in speeds if s > _SPEED_SPIKE_KMH)

            # teleport jumps (track shots / прострелы): distance/time → impossible speed
            jumps = 0
            max_impl = 0.0
            for i in range(1, len(packets)):
                a, b = packets[i - 1], packets[i]
                if not (a.get("lat") and a.get("lng") and b.get("lat") and b.get("lng")):
                    continue
                dt = ((b.get("time") or 0) - (a.get("time") or 0)) / 1000.0
                if dt <= 0:
                    continue
                impl = _haversine_m(a["lat"], a["lng"], b["lat"], b["lng"]) / dt * 3.6
                max_impl = max(max_impl, impl)
                if impl > _TELEPORT_KMH:
                    jumps += 1
            facts.teleport_jumps = jumps
            facts.max_implied_kmh = round(max_impl, 1)

        self._derive_flags(facts)
        return facts

    @staticmethod
    def _derive_flags(f: TelemetryFacts) -> None:
        if f.power_off_ratio and f.power_off_ratio > 0.2:
            f.flags.append("power_off")
        # Jamming needs strong / corroborated evidence — a couple of brief
        # GPS hiccups (2-3 teleports at ~160 km/h) are normal noise, not РЭБ.
        # True jamming (e.g. 64051) shows many teleports, impossible implied
        # speeds, speed spikes and satellite dropouts together.
        jamming = (
            f.teleport_jumps >= 5
            or (f.max_implied_kmh is not None and f.max_implied_kmh > 500 and f.teleport_jumps >= 2)
            or f.speed_spike_count >= 3
            or (f.low_sat_ratio is not None and f.low_sat_ratio > 0.08)
            or (f.zero_coord_moving_ratio is not None and f.zero_coord_moving_ratio > 0.15)
        )
        if jamming:
            f.flags.append("jamming")
        if f.max_gap_min and f.max_gap_min > _TRACK_GAP_MIN:
            f.flags.append("track_gap")
        if f.packets == 0:
            f.flags.append("no_data")

    def _heuristic_category(self, parsed: ParsedIssue, f: TelemetryFacts) -> str:
        if "no_data" in f.flags:
            return "Диагностика"
        if "power_off" in f.flags:
            return "Не было питания"
        if "jamming" in f.flags:
            return "Глушение"
        if parsed.sheet_mileage_km and f.system_mileage_km is not None:
            diff = abs(parsed.sheet_mileage_km - f.system_mileage_km)
            tol = max(5.0, parsed.sheet_mileage_km * 0.1)
            if diff <= tol:
                return "Данные верны"
            if "track_gap" in f.flags:
                return "Изменили настройки"
        return "Данные верны"

    # ----- LLM refinement ------------------------------------------------
    async def _draft_with_llm(self, parsed: ParsedIssue, f: TelemetryFacts, hint: str) -> dict[str, Any]:
        catalog = "\n".join(
            f"- {c['key']}: {c['when']}\n  Шаблон: {c['template']}" for c in _CATEGORY_CATALOG
        )
        facts = {
            "гос_номер": parsed.plate,
            "дата": parsed.date,
            "пробег_по_путевому_листу_км": parsed.sheet_mileage_km,
            "пробег_заявленный_клиентом_км": parsed.declared_system_km,
            "реальный_пробег_системы_км": f.system_mileage_km,
            "макс_скорость": f.max_speed,
            "пакетов_телеметрии": f.packets,
            "среднее_спутников": f.avg_sat,
            "доля_слабого_сигнала": f.low_sat_ratio,
            "мин_напряжение_В": f.min_power_v,
            "доля_без_питания": f.power_off_ratio,
            "макс_разрыв_трека_мин": f.max_gap_min,
            "доля_нулевых_координат_в_движении": f.zero_coord_moving_ratio,
            "макс_скорость_по_пакетам": f.max_speed_packet,
            "выбросов_скорости_свыше_110": f.speed_spike_count,
            "телепортов_трека": f.teleport_jumps,
            "макс_расчётная_скорость_между_точками": f.max_implied_kmh,
            "признаки": f.flags,
        }
        system = (
            "Ты — ассистент техподдержки GPSPOS. По данным телеметрии классифицируй причину "
            "расхождения пробега и составь короткий вежливый ответ клиенту на русском. "
            "Выбери одну категорию из каталога. Подставь реальные числа (дату, пробег) в ответ. "
            "Не выдумывай данные, которых нет. Верни СТРОГО JSON без пояснений: "
            '{"category": "...", "answer": "...", "confidence": 0.0-1.0, "reasoning": "..."}'
        )
        user = (
            f"Каталог категорий ответов:\n{catalog}\n\n"
            f"Факты по заявке (JSON):\n{json.dumps(facts, ensure_ascii=False)}\n\n"
            f"Подсказка эвристики (вероятная категория): {hint}\n\n"
            "Ответ строго в JSON."
        )
        raw = await self._llm.chat(system, user)
        return self._parse_llm_json(raw)

    @staticmethod
    def _parse_llm_json(raw: str) -> dict[str, Any]:
        if not raw:
            return {}
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return {}
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return {}

    # ----- orchestration -------------------------------------------------
    async def automate(self, title: str | None, description: str | None,
                       params: list[dict[str, Any]] | None = None,
                       issue_type: str | None = None) -> AutomationResult:
        parsed = self.parse_issue(title, description, params)
        telemetry = TelemetryFacts()
        if not parsed.plate:
            is_mileage = bool(issue_type and "пробег" in issue_type.lower())
            if issue_type and not is_mileage:
                reason = (
                    f"Заявка типа «{issue_type}» — автоанализ расхождения пробега неприменим. "
                    "Инструмент работает с заявками о расхождении пробега."
                )
            else:
                reason = (
                    "Не удалось определить гос.номер ТС из заявки. "
                    "Проверьте, что номер указан в теме или описании."
                )
            return AutomationResult(
                parsed=parsed, telemetry=telemetry, category="Диагностика",
                confidence=0.0, draft_answer="", reasoning=reason,
                error="plate_not_parsed",
            )
        if not parsed.date:
            return AutomationResult(
                parsed=parsed, telemetry=telemetry, category="Диагностика",
                confidence=0.0, draft_answer="", reasoning="Не удалось определить дату из заявки.",
                error="date_not_parsed",
            )
        try:
            telemetry = await self.gather_telemetry(parsed.plate, parsed.date)
        except Exception as e:  # pragma: no cover - network errors
            log.exception("gather_telemetry_failed", plate=parsed.plate)
            return AutomationResult(
                parsed=parsed, telemetry=telemetry, category="Диагностика",
                confidence=0.0, draft_answer="", reasoning="Ошибка получения данных из geo.gpspos.ru.",
                error=str(e),
            )
        if "object_not_found" in telemetry.flags:
            return AutomationResult(
                parsed=parsed, telemetry=telemetry, category="Диагностика",
                confidence=0.0, draft_answer="",
                reasoning=f"Объект с гос.номером {parsed.plate} не найден в geo.gpspos.ru.",
                error="object_not_found",
            )

        hint = self._heuristic_category(parsed, telemetry)
        llm = await self._draft_with_llm(parsed, telemetry, hint)
        category = llm.get("category") or hint
        draft = (llm.get("answer") or "").strip()
        confidence = float(llm.get("confidence") or 0.0)
        reasoning = llm.get("reasoning") or ""
        if not draft:
            # fallback to catalog template
            tpl = next((c for c in _CATEGORY_CATALOG if c["key"] == category), _CATEGORY_CATALOG[0])
            draft = tpl["template"].format(
                date=parsed.date or "",
                system_km=telemetry.system_mileage_km if telemetry.system_mileage_km is not None else "",
            )
            confidence = confidence or 0.4
            reasoning = reasoning or f"Эвристика: {hint}"
        return AutomationResult(
            parsed=parsed, telemetry=telemetry, category=category,
            confidence=confidence, draft_answer=draft, reasoning=reasoning,
            needs_review=confidence < 0.85,
        )

    async def build_track(self, title: str | None, description: str | None,
                          max_points: int = 2500) -> dict[str, Any]:
        """Return track points + telemetry series for map/charts rendering.

        Points: {t(ms), lat, lng, speed, sat, pwr}. ``teleports`` are indices i
        where the jump from point i-1 to i is physically impossible (GPS spoofing).
        """
        parsed = self.parse_issue(title, description, None)
        if not parsed.plate or not parsed.date:
            return {"error": "no_plate_or_date", "parsed": asdict(parsed), "points": []}
        obj = await self._geo.find_object_by_plate(parsed.plate)
        if not obj:
            return {"error": "object_not_found", "parsed": asdict(parsed), "points": []}
        oid = int(obj["id"])
        day = _dt.date.fromisoformat(parsed.date)
        start = _dt.datetime.combine(day, _dt.time.min)
        from_ms = int(start.timestamp() * 1000)
        till_ms = int((start + _dt.timedelta(days=1)).timestamp() * 1000)
        packets = await self._geo.get_packets(oid, from_ms, till_ms)
        packets.sort(key=lambda p: p.get("time") or 0)

        teleports: list[int] = []
        for i in range(1, len(packets)):
            a, b = packets[i - 1], packets[i]
            if not (a.get("lat") and a.get("lng") and b.get("lat") and b.get("lng")):
                continue
            dt = ((b.get("time") or 0) - (a.get("time") or 0)) / 1000.0
            if dt <= 0:
                continue
            impl = _haversine_m(a["lat"], a["lng"], b["lat"], b["lng"]) / dt * 3.6
            if impl > _TELEPORT_KMH:
                teleports.append(i)

        step = max(1, len(packets) // max_points)
        tele_set = set(teleports)
        points: list[dict[str, Any]] = []
        index_map: dict[int, int] = {}
        for i, p in enumerate(packets):
            if i % step != 0 and i not in tele_set:
                continue
            tags = p.get("tags") if isinstance(p.get("tags"), dict) else {}
            index_map[i] = len(points)
            points.append({
                "t": p.get("time"),
                "lat": round(p["lat"], 5) if p.get("lat") else None,
                "lng": round(p["lng"], 5) if p.get("lng") else None,
                "speed": p.get("speed") or 0,
                "sat": p.get("sat") or 0,
                "pwr": round(tags.get("pwr_ext"), 1) if tags.get("pwr_ext") is not None else None,
            })
        return {
            "parsed": asdict(parsed),
            "object_id": oid,
            "object_name": obj.get("name"),
            "total_packets": len(packets),
            "points": points,
            "teleports": [index_map[i] for i in teleports if i in index_map],
        }

    def to_dict(self, r: AutomationResult) -> dict[str, Any]:
        return {
            "parsed": asdict(r.parsed),
            "telemetry": asdict(r.telemetry),
            "category": r.category,
            "confidence": r.confidence,
            "draft_answer": r.draft_answer,
            "reasoning": r.reasoning,
            "needs_review": r.needs_review,
            "error": r.error,
        }
