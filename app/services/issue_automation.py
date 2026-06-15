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
    {"key": "Терминал подключился", "when": "Пробег по системе заметно МЕНЬШЕ путевого листа при в целом чистом треке — терминал терял связь/питание, данные копились в чёрном ящике и выгрузились (или выгрузятся) позже, после чего пробег сходится с ПЛ. Если в системе уже сошлось — указать актуальный пробег; если ещё нет — предупредить, что данные догрузятся.",
     "template": "Добрый день! Терминал временно терял связь, данные из внутренней памяти выгрузились. Пробег за {date} составил {system_km} км. Если терминал ещё не выгрузил все данные за период потери связи, пробег обновится после восстановления связи."},
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
                    params: list[dict[str, Any]] | None = None,
                    extra_text: str | None = None) -> ParsedIssue:
        title = title or ""
        body = _strip_html(description)
        text = f"{title} {body} {extra_text or ''}"
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

        # по путевому листу / по ПЛ / по одометру <num> <unit>
        sm = re.search(r"(?:путев\w*\s+лист\w*|одометр\w*|по\s*ПЛ|ПЛ)\D{0,6}(\d+(?:[.,]\d+)?)\s*(км|м)?", text, re.I)
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

            # teleport jumps (track shots / прострелы): distance/time → impossible speed.
            # Also sum the REAL driven distance from the track (excluding teleport
            # jumps) — this is the live source of truth and reflects data that the
            # terminal uploaded late from its black box, unlike the precomputed
            # DailyStat.length which can lag badly (see issue 64070: DailyStat 53.9 km
            # vs real track 178.8 km after the buffer caught up).
            jumps = 0
            max_impl = 0.0
            track_m = 0.0
            for i in range(1, len(packets)):
                a, b = packets[i - 1], packets[i]
                if not (a.get("lat") and a.get("lng") and b.get("lat") and b.get("lng")):
                    continue
                dt = ((b.get("time") or 0) - (a.get("time") or 0)) / 1000.0
                if dt <= 0:
                    continue
                dist = _haversine_m(a["lat"], a["lng"], b["lat"], b["lng"])
                impl = dist / dt * 3.6
                max_impl = max(max_impl, impl)
                if impl > _TELEPORT_KMH:
                    jumps += 1
                else:
                    track_m += dist
            facts.teleport_jumps = jumps
            facts.max_implied_kmh = round(max_impl, 1)
            # Prefer the live track distance over the (possibly stale) DailyStat.
            if track_m > 0:
                facts.system_mileage_km = round(track_m / 1000.0, 2)

        self._derive_flags(facts)
        return facts

    @staticmethod
    def _derive_flags(f: TelemetryFacts) -> None:
        if f.power_off_ratio and f.power_off_ratio > 0.2:
            f.flags.append("power_off")
        # Jamming = the GPS POSITION is corrupted: track shots (teleports) and/or
        # loss of satellites. Isolated speed spikes alone are NOT enough — a
        # terminal can report a bogus 138 km/h on a single noisy fix while the
        # track stays clean (e.g. 64070). Real jamming (64051) shows many
        # teleports with impossible implied speeds and/or satellite dropouts.
        jamming = (
            f.teleport_jumps >= 5
            or (f.max_implied_kmh is not None and f.max_implied_kmh > 500 and f.teleport_jumps >= 2)
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
            sheet = parsed.sheet_mileage_km
            system = f.system_mileage_km
            tol = max(5.0, sheet * 0.1)
            if abs(sheet - system) <= tol:
                return "Данные верны"
            if "track_gap" in f.flags:
                return "Изменили настройки"
        # System lower than the waybill with a clean track is ambiguous —
        # could be legitimate (пробуксовка/малая скорость → «Данные верны») or
        # a delayed black-box upload (→ «Терминал подключился»). We don't force
        # it here; the LLM decides with the catalog guidance and the operator
        # confirms (large gaps are flagged needs_review in automate()).
        return "Данные верны"

    # ----- LLM refinement ------------------------------------------------
    async def _draft_with_llm(self, parsed: ParsedIssue, f: TelemetryFacts, hint: str,
                              attachments_text: str | None = None) -> dict[str, Any]:
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
            "Важно: если пробег по системе заметно МЕНЬШЕ путевого листа, а трек чистый (нет глушения/обрывов) — "
            "это почти всегда временная потеря связи/питания терминала: данные копятся в чёрном ящике и "
            "выгружаются позже, пробег потом сходится. В этом случае НЕ выбирай «Данные верны», ставь умеренную "
            "уверенность (≤0.7) и рекомендуй перепроверить пробег после выгрузки. "
            "Не выдумывай данные, которых нет. Верни СТРОГО JSON без пояснений: "
            '{"category": "...", "answer": "...", "confidence": 0.0-1.0, "reasoning": "..."}'
        )
        att_block = ""
        if attachments_text and attachments_text.strip():
            att_block = f"\nТекст из вложений заявки (путевые листы и т.п.):\n{attachments_text[:4000]}\n"
        user = (
            f"Каталог категорий ответов:\n{catalog}\n\n"
            f"Факты по заявке (JSON):\n{json.dumps(facts, ensure_ascii=False)}\n"
            f"{att_block}\n"
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
    async def read_attachments(self, issue_external_id: int, attachments: list[Any]) -> str:
        """Download + extract text from extractable attachments, concatenated."""
        from app.services import attachment_reader

        parts: list[str] = []
        for a in attachments:
            name = getattr(a, "attachment_file_name", None) or ""
            if not attachment_reader.is_extractable(name):
                continue
            try:
                result = await self._okdesk.download_attachment(issue_external_id, a.id)
                if not result:
                    continue
                text = attachment_reader.extract_text(name, result[0])
                if text.strip():
                    parts.append(f"=== Вложение: {name} ===\n{text}")
            except Exception:  # pragma: no cover - best effort
                log.warning("attachment_read_failed", issue=issue_external_id, name=name)
        return "\n\n".join(parts)

    async def automate(self, title: str | None, description: str | None,
                       params: list[dict[str, Any]] | None = None,
                       issue_type: str | None = None,
                       attachments_text: str | None = None) -> AutomationResult:
        parsed = self.parse_issue(title, description, params, extra_text=attachments_text)
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
        llm = await self._draft_with_llm(parsed, telemetry, hint, attachments_text=attachments_text)
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
        # Large under-recording (system << waybill) means the snapshot may be
        # incomplete (delayed black-box upload) — always send to review and
        # cap confidence, no matter how sure the model sounded.
        under_recording = (
            parsed.sheet_mileage_km
            and telemetry.system_mileage_km is not None
            and telemetry.system_mileage_km < parsed.sheet_mileage_km * 0.7
        )
        if under_recording:
            confidence = min(confidence, 0.7)
        return AutomationResult(
            parsed=parsed, telemetry=telemetry, category=category,
            confidence=confidence, draft_answer=draft, reasoning=reasoning,
            needs_review=confidence < 0.85 or bool(under_recording),
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

    async def build_training_sample(
        self, title: str | None, description: str | None,
        operator_answer: str, final_status: str,
    ) -> dict[str, Any] | None:
        """Build a (telemetry facts → operator decision) sample for later AI training.

        Best-effort: returns None if the issue isn't a parseable mileage ticket.
        Never raises — callers log decisions, they must not fail on this.
        """
        parsed = self.parse_issue(title, description, None)
        if not parsed.plate or not parsed.date:
            return None
        telemetry = TelemetryFacts()
        try:
            telemetry = await self.gather_telemetry(parsed.plate, parsed.date)
        except Exception:  # pragma: no cover - best effort
            log.warning("training_sample_telemetry_failed", plate=parsed.plate)
        return {
            "issue_title": title,
            "issue_description": description,
            "plate": parsed.plate,
            "fault_date": parsed.date,
            "mileage_sheet_km": parsed.sheet_mileage_km,
            "mileage_system_km": telemetry.system_mileage_km,
            "telemetry_json": json.dumps(asdict(telemetry), ensure_ascii=False),
            "operator_answer": operator_answer,
            "final_status": final_status,
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
