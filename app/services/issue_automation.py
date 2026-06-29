"""Issue automation pipeline for «Расхождение пробега» tickets.

Flow: parse issue (plate, date, declared mileage) → find geo object →
fetch DailyStat (real system mileage) + ObjectPackets (telemetry) →
analyse power / satellites / track gaps → classify cause and draft an
answer for the operator to confirm.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
import math
import os
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Awaitable, Callable

import structlog

from app.core.gpspos_geo.service import GpsposGeoService
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)

# Пороги телеметрии параметризуются через env (1.4) — дефолты прежние, можно
# подстраивать под типы терминалов без правки кода.
def _envf(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return float(default)


def _envi(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return int(default)


# Voltage below this on the external power input is treated as "power off".
_POWER_OFF_V = _envf("TELEMETRY_POWER_OFF_V", 7.0)
# Readings below this are implausible glitches (sensor noise / dropped frame),
# NOT a real "0 volts" — excluded from min/avg voltage so the answer doesn't
# claim «0 В» while the terminal actually reported 27 В (see 64281).
_GLITCH_V = _envf("TELEMETRY_GLITCH_V", 2.0)
# Satellites below this means effectively no reliable GPS fix.
_MIN_SAT = _envi("TELEMETRY_MIN_SAT", 4)
# A gap in telemetry longer than this (minutes) during the day is a track break.
_TRACK_GAP_MIN = _envi("TELEMETRY_TRACK_GAP_MIN", 30)
# Implied speed (km/h) between two consecutive points above this = a "teleport"
# (track shot / прострел) — a strong GPS jamming/spoofing signature.
_TELEPORT_KMH = _envf("TELEMETRY_TELEPORT_KMH", 150)
# Plausible top speed (km/h) for the tracked vehicles; spikes above = spoofing.
_SPEED_SPIKE_KMH = _envf("TELEMETRY_SPEED_SPIKE_KMH", 110)
# Параллелизм разбора объектов в пакетной заявке (сводные письма с десятками ТС).
# Последовательно сотни запросов телеметрии давали таймаут (63317, 187 записей,
# ~270с). Ограниченная конкуренция держит нагрузку на GPSPOS в рамках.
_BATCH_CONCURRENCY = _envi("BATCH_CONCURRENCY", 8)

# Trackers/Okdesk report in Moscow time (UTC+3); the prod server runs in UTC.
# Day windows MUST be built in MSK — otherwise the daily window is shifted by 3h
# and DailyStat.day / packet windows miss the real Moscow day, producing a false
# «нет данных» even when data exists (see 64284).
_MSK = _dt.timezone(_dt.timedelta(hours=3))


def _msk_day_window_ms(day: _dt.date) -> tuple[int, int]:
    """[00:00; 24:00) of ``day`` in Moscow time, as unix-ms for the Geo API."""
    start = _dt.datetime.combine(day, _dt.time.min, tzinfo=_MSK)
    end = start + _dt.timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _msk_today() -> _dt.date:
    return _dt.datetime.now(_MSK).date()


def _msk_date_from_ms(ms: float) -> _dt.date:
    return _dt.datetime.fromtimestamp(ms / 1000.0, _MSK).date()


# Latin lookalikes → Cyrillic, so a plate parsed as "Y538OK" normalises to
# "У538ОК" — consistent with geo object matching and the batch path (64250).
_PLATE_TRANSLIT = str.maketrans("ABEKMHOPCTYX", "АВЕКМНОРСТУХ")


def _normalize_plate(raw: str | None) -> str:
    """Канонический гос.номер: убрать пробелы/дефисы, срезать суффикс RUS/RU,
    upper-case, латиница→кириллица.

    Единая нормализация для ВСЕХ путей (одиночный разбор, списки, таблицы, batch).
    Раньше ``extract_all_plates`` не делал translit → один и тот же номер из OCR
    распознавался и в кириллице, и в латинице (``М203УО`` vs ``M203YO``) как ДВА
    разных объекта с противоречивыми вердиктами (64481). Суффикс RUS — частый
    хвост в темах Северо-Восточного ПО («…ТУRUS», 64494/64228)."""
    p = re.sub(r"[\s\-]", "", raw or "").upper()
    p = re.sub(r"(RUS|RU)$", "", p)
    return p.translate(_PLATE_TRANSLIT)


def _plate_dedup_key(p: str) -> str:
    """Ключ дедупа без хвоста региона: «М469НА73» и «М469НА» — один ТС (64513:
    номер из темы с регионом и из акта без региона давали дубль). Срезаем 2-3
    цифры региона ТОЛЬКО после двух букв (обычный формат), спецномера не трогаем."""
    return re.sub(r"(?<=[АВЕКМНОРСТУХ]{2})\d{2,3}$", "", p)


# --- Правила разбора особых заявок (см. память project-overdue-rules) ----------
# Спецтехника без км-пробега: модель из списка ИЛИ номер НЕ обычного формата
# (буква-3цифры-2буквы). Тракторы/погрузчики/буровые/мульчеры меряются моточасами,
# поэтому км-вердикт «Глушение/Данные верны» по пробегу для них ненадёжен.
_SPEC_MODEL_RE = re.compile(
    r"\b(?:мтз|беларус[ь]?|трактор|погрузчик|экскаватор|бульдозер|каток|автогрейдер|"
    r"грейдер|буров|мульчер|bobcat|jcb|кировец|к-?70[01]|т-?150|т-?170|дэк|эо-?\d|"
    r"тгм|мтлб|мксм|пкт|treemme)\b", re.I)


def _is_standard_plate(p: str | None) -> bool:
    """Обычный гражданский номер: буква + 3 цифры + 2 буквы [+ регион]."""
    return bool(re.fullmatch(rf"[{_L}]\d{{3}}[{_L}]{{2}}\d{{0,3}}", p or ""))


def _is_special_vehicle(plate: str | None, text: str | None = None) -> bool:
    """Спецтехника (без км-пробега): номер спецформата ИЛИ модель из списка."""
    if plate and not _is_standard_plate(plate):
        return True
    return bool(text and _SPEC_MODEL_RE.search(text))


# «Ложный wait»: клиент подтвердил питание/массу/индикацию и/или просит удалённую
# диагностику — мяч на НАШЕЙ стороне, заявка зависает. Стандартный шаблон «включите
# питание» уже исчерпан → нужна удалённая диагностика по телеметрии либо выезд.
_POWER_OK_RE = re.compile(
    r"масс[аы]\s+(?:включена|подключена|есть)|питани[ея][^.]{0,20}(?:есть|включен|подключ)|"
    r"индикаци[яи][^.]{0,40}(?:гори|свети|есть|мига)|клемм[ыа][^.]{0,20}подключ|"
    r"тс\s+(?:в\s+работе|на\s+линии|работает)|терминал[^.]{0,25}(?:работает|на\s+связи)",
    re.I)
_REMOTE_DIAG_RE = re.compile(r"удал[её]нн\w+\s+диагностик", re.I)


def _client_awaiting_remote_diag(comments: str | None) -> bool:
    """True, если клиент подтвердил питание/работу ТС (наш шаблон исчерпан)."""
    if not comments:
        return False
    return bool(_POWER_OK_RE.search(comments) or _REMOTE_DIAG_RE.search(comments))


@dataclass(frozen=True)
class FormatProfile:
    """Ожидаемый формат заявки для конкретного ПО (производственного отделения).

    Помогает (а) выбрать стратегию разбора и (б) подсказать ИИ в промпте, что
    искать. Привязка МЯГКАЯ: ключ ищется как подстрока в company_name; при
    отсутствии совпадения возвращается None и работает обычная эвристика."""
    key: str               # подстрока company_name (ПО)
    data_location: str     # 'subject' | 'attachments' | 'subject_or_attachments'
    cardinality: str       # 'single' | 'multi'
    attachment_format: str  # 'none' | 'act_per_object' | 'one_doc_many' | 'table'
    hint: str              # человекочитаемая подсказка для LLM-промпта


# Закономерности по дочерним «Россети Волга» (выведены из реальных тем/авторов
# заявок). Порядок важен: более специфичные ПО — раньше общих компаний.
_FORMAT_PROFILES: list[FormatProfile] = [
    FormatProfile(
        "Волжское ПО", "subject_or_attachments", "single", "act_per_object",
        "Форвард-письмо (FW/Отправка): один акт ГЛОНАСС = один ТС; гос.номер и "
        "дата неисправности есть и в теме, и в акте."),
    FormatProfile(
        "Жигулевское ПО", "subject_or_attachments", "multi", "act_per_object",
        "Несколько ТС: каждый — отдельный акт (Word). Тема перечисляет все "
        "через запятую: «дата_номер_модель_Заявка№ ЖПО»."),
    FormatProfile(
        "Чапаевское ПО", "attachments", "multi", "one_doc_many",
        "«Общая» заявка: ОДИН документ Word содержит НЕСКОЛЬКО ТС внутри "
        "(в теме номеров нет, только «Общая_Заявка N_ЧПО»)."),
    FormatProfile(
        "Самарское ПО", "subject", "single", "none",
        "Один ТС: гос.номер прямо в теме (часто спецтехника: 9140СУ, Н944КР)."),
    FormatProfile(
        "Прихоперское ПО", "subject", "multi", "none",
        "Часто НЕСКОЛЬКО ТС перечислены прямо в теме; вложений может не быть."),
    FormatProfile(
        "Северное ПО", "subject", "single", "none",
        "Один ТС: тема вида «ДД-ММ-ГГГГ ГОСНОМЕР» (Саратов, Ефимов)."),
    FormatProfile(
        "Северо-Восточное ПО", "subject", "single", "none",
        "Один ТС: тема «МОДЕЛЬ ГОСНОМЕР» — часто с суффиксом RUS, спецномерами "
        "(64СН3847) и двойными пробелами (В  175 ТУ)."),
    FormatProfile(
        "Ульяновское ПО", "subject_or_attachments", "multi", "table",
        "Бывает табличный отчёт-вложение (XLSX «Группировка»: строка = ТС) либо "
        "один гос.номер прямо в теме."),
    FormatProfile(
        "Пензаэнерго", "subject", "single", "none",
        "Один ТС: гос.номер в теме (регион 58)."),
    FormatProfile(
        "Мордовэнерго", "subject", "single", "none",
        "Один ТС: тема «расхождения пробега по ГОСНОМЕР»."),
    FormatProfile(
        "Оренбургэнерго", "subject", "single", "none",
        "Один ТС: тема «<тип проблемы> ГОСНОМЕР» (регион 56/156)."),
]


def resolve_format_profile(company: str | None,
                           contact: str | None = None) -> FormatProfile | None:
    """Подобрать формат-профиль по company_name (подстрока ПО). Автор (contact)
    пока используется только как контекст — жёсткой привязки к автору нет."""
    if not company:
        return None
    for p in _FORMAT_PROFILES:
        if p.key in company:
            return p
    return None


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

# Plate: letter + 3 digits + 2 letters, optional 2-3 region digits
# (some tickets omit the region, e.g. "Х774НВ").
_L = "АВЕКМНОРСТУХABEKMHOPCTYX"
# Lookbehind: номер не должен начинаться в середине слова — иначе «№ШР175 ОТ 15.06»
# ложно склеивается в «Р175ОТ15» (где «ОТ»=«от», «15» из даты). См. 64144.
_PLATE_RE = re.compile(
    rf"(?<![A-Za-zА-Яа-яЁё0-9.-])(?:"
    rf"[{_L}]\s{{0,2}}\d{{3}}\s{{0,2}}[{_L}]{{2}}\d{{0,3}}"  # обычный: А123ВС[64]; «М 396 УМ 763»; «В  175 ТУ» (двойной пробел, 64494)
    rf"|\d{{2}}\s{{0,2}}[{_L}]{{2}}\s{{0,2}}\d{{4}}"         # спецтехника регион+серия: 64СН3847, 56НА3151 (64228)
    rf"|\d{{2}}[-\s]?\d{{2}}\s?[{_L}]{{2}}"                  # спецтехника: 5297СУ, 81-40РВ
    rf"|[{_L}]{{2}}\s?\d{{2}}[-\s]?\d{{2}}"                  # спецтехника (обратный порядок): СУ5297, СВ8797
    rf")",
    re.I,
)
# Fallback: усечённый номер 2 буквы + 3 цифры (ЕК424) — только если обычный/спец
# не нашлись (иначе ловит «Акт122» и т.п., но lookbehind режет «Акт»→«кт»).
_PLATE_FALLBACK_RE = re.compile(rf"(?<![A-Za-zА-Яа-яЁё0-9.-])[{_L}]{{2}}\s?\d{{3}}", re.I)
# Standard-only (буква+3цифры+2буквы[+регион]) для извлечения СПИСКА номеров из
# «общей» заявки (один файл — много ТС). Без спецформата, чтобы «23-00 нет»→«2300НЕ» не лез.
# Регион только слитно (без \s? перед \d{0,3}) — иначе в списке «В152ТУ\n2.»
# хвост «2» от номера следующего пункта прилипает к номеру.
_PLATE_STD_RE = re.compile(rf"(?<![A-Za-zА-Яа-яЁё0-9.-])[{_L}]\s?\d{{3}}\s?[{_L}]{{2}}\d{{0,3}}", re.I)


def extract_all_plates(text: str, limit: int = 40) -> list[str]:
    """All distinct standard plates in order of appearance (для списков ТС)."""
    seen: set[str] = set()
    out: list[str] = []
    for m in _PLATE_STD_RE.finditer(text or ""):
        p = _normalize_plate(m.group(0))  # translit: «M203YO»→«М203УО» (64481)
        if p not in seen:
            seen.add(p)
            out.append(p)
            if len(out) >= limit:
                break
    return out


def _split_acts(text: str) -> list[str]:
    """Split a multi-act PDF into per-act segments by the «Акт №» marker.

    A single forwarded PDF often bundles several acts (one vehicle each), each
    with its OWN «Дата неисправности» and waybill. Parsing the whole text gives
    every vehicle the FIRST act's date (64250). Splitting lets each vehicle take
    the date/mileage from its own act. Returns the whole text as one segment if
    there is no «Акт №» marker.
    """
    parts = re.split(r"(?=\bАкт\s+№)", text or "", flags=re.I)
    return [p for p in parts if p.strip()]


# Структурный акт неисправности (Волжское ПО, 64481): «Дата неисправности
# <дата>», «Пробег по путевому листу (км) <N>», «Пробег в системе ГЛОНАСС (км) <N>».
_FAULT_DATE_RE = re.compile(
    r"дата\s+неисправности\D{0,30}?(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})", re.I | re.S)
# Пробег по путевому листу / одометру ОТ КЛИЕНТА. Разные формулировки дочерних
# Россетей: «Пробег по путевому листу (км) 251», «по одометру 110 км», «показаний
# одометра 60 км». Используется и в актах, и в теле-списках.
_WAYBILL_KM_RE = re.compile(
    r"(?:путево\w+\s+лист\w*|одометр\w*)[^\d]{0,25}?(\d+(?:[.,]\d+)?)(?![\d.,])", re.I | re.S)
# Пробег по системе ГЛОНАСС/ССМ/СМС ОТ КЛИЕНТА (заявленный): «Пробег в системе
# ГЛОНАСС (км) 20», «ССМ ГЛОНАСС 52,57 км», «по ГЛОНАС 0 км», «по СМС 98,10 км».
# Это то, что клиент видит в ПК — отдельно от РЕАЛЬНОЙ телеметрии (geo.gpspos.ru).
# (?!\.\d) — не принимать за пробег ДАТУ: «ССМ за 17.06.2026» не должно дать 17.06
# (64455). Дата DD.MM.YYYY имеет «.digit» после первой пары — отсекаем.
_GLONASS_KM_RE = re.compile(
    r"(?:глонас\w*|ссм|смс)[^\d]{0,25}?(\d+(?:[.,]\d+)?)(?![\d.,])", re.I | re.S)

# Дата с НАЗВАНИЕМ месяца: «18 июня 2026», «18 июня» (Ульяновские/свободные акты).
_RU_MONTHS = {
    "январ": 1, "феврал": 2, "март": 3, "апрел": 4, "ма": 5, "июн": 6,
    "июл": 7, "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12,
}
_MONTH_DATE_RE = re.compile(
    r"\b(\d{1,2})\s+([а-яё]{3,8})(?:\s+(\d{4}))?", re.I)


def _iso_from_month_name(text: str, fallback_year: int | None = None) -> str | None:
    """«18 июня 2026»/«18 июня» → ISO. Год по умолчанию текущий (МСК)."""
    for m in _MONTH_DATE_RE.finditer(text or ""):
        day = int(m.group(1))
        mon_raw = m.group(2).lower()
        mon = next((v for k, v in _RU_MONTHS.items() if mon_raw.startswith(k)), None)
        if not mon or not (1 <= day <= 31):
            continue
        year = int(m.group(3)) if m.group(3) else (fallback_year or _msk_today().year)
        try:
            return _dt.date(year, mon, day).isoformat()
        except ValueError:
            continue
    return None


def _safe_km(raw: str | None) -> float | None:
    """Парсинг числа-пробега с отсевом мусора: пустое/телефон (>5 цифр до точки)/
    нереальные значения (≥100000 км/сутки) → None. Защита от случаев, когда поле
    пустое и regex хватает телефон ответственного (64481 акт №29)."""
    if not raw:
        return None
    intpart = re.split(r"[.,]", raw)[0]
    if len(intpart) > 5:
        return None
    try:
        v = float(raw.replace(",", "."))
    except ValueError:
        return None
    # 0 допустимо: «по ГЛОНАСС 0 км» — клиент видит нулевой пробег (нет трека).
    return v if 0 <= v < 100000 else None


def _iso_from_dmy(s: str | None) -> str | None:
    """«18.06.2026»/«18.06.26» → ISO, или None."""
    if not s:
        return None
    m = _DATE_SHORT_RE.search(s)
    return _parse_date_short(m) if m else None


def _parse_act_blocks(text: str) -> list[tuple[str, str | None, float | None, float | None]]:
    """Структурный многоактный акт «Заявка №…Дата неисправности…Пробег по
    путевому листу» (Волжское ПО, 64481): один «Акт №» = один ТС.

    На каждый сегмент («Акт №») берём ОДИН гос.номер (дедуп латиница/кириллица
    через _normalize_plate), дату неисправности (приоритет — маркер «Дата
    неисправности», иначе первая дата сегмента) и пробег по путевому листу.
    Дедуп по ПАРЕ (номер, дата): один ТС может фигурировать в НЕСКОЛЬКИХ актах с
    РАЗНЫМИ датами неисправности (64481: М203УО в актах №27 и №30, В836МН в №28 и
    №29) — это отдельные записи. Отсекаем лишь повтор той же пары (латиница/
    кириллица одного акта). Возвращает [(plate, date_iso|None, sheet_km|None)]."""
    out: list[tuple[str, str | None, float | None, float | None]] = []
    seen: set[tuple[str, str | None]] = set()
    for seg in _split_acts(text or ""):
        plates = extract_all_plates(seg)
        if not plates:
            m = _PLATE_RE.search(seg)
            if m:
                plates = [_normalize_plate(m.group(0))]
        if not plates:
            continue
        plate = plates[0]
        # Дата акта (отчётная) повторяется в сегменте несколько раз: шапка
        # «Акт № N от DATE», «DATE года», «Заявка № N от DATE». Дата НЕИСПРАВНОСТИ
        # — отдельная, отличается от отчётной. Поэтому:
        #   1) маркер «Дата неисправности <date>», если он != отчётной даты;
        #   2) иначе первая дата сегмента, отличная от отчётной (OCR в части
        #      актов ставит дату неисправности ПЕРЕД меткой — 64481 акт №28);
        #   3) иначе отчётная дата.
        hm = re.search(r"Акт\s*[№N]\s*\d+\D{0,6}(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})",
                       seg, re.I)
        header = _iso_from_dmy(hm.group(1)) if hm else None
        date: str | None = None
        fm = _FAULT_DATE_RE.search(seg)
        if fm:
            d = _iso_from_dmy(fm.group(1))
            if d and d != header:
                date = d
        if not date:
            for dm in _DATE_SHORT_RE.finditer(seg):
                d = _parse_date_short(dm)
                if d and d != header:
                    date = d
                    break
        if not date:
            # Дата словом: «18 июня 2026» (Ульяновские/свободные акты).
            date = _iso_from_month_name(seg)
        if not date:
            date = header
        if (plate, date) in seen:
            continue
        seen.add((plate, date))
        # Пробег по путевому листу (ПЛ) и пробег по системе ГЛОНАСС (заявленный
        # клиентом). _safe_km отсекает мусор (пустое поле → телефон ответственного,
        # 64481 акт №29).
        wm = _WAYBILL_KM_RE.search(seg)
        gm = _GLONASS_KM_RE.search(seg)
        sheet = _safe_km(wm.group(1)) if wm else None
        glonass = _safe_km(gm.group(1)) if gm else None
        out.append((plate, date, sheet, glonass))
    return out


def _parse_body_vehicles(text: str | None) -> list[tuple[str, str | None, float | None, float | None]]:
    """Нумерованный тело-список «1. <номер> <модель>, … за <дата> … ГЛОНАСС X км,
    … одометр Y км; 2. …» (Прихоперское ПО, 64455): у каждого ТС СВОЯ дата, свой
    пробег по одометру (= путевой лист) и заявленный пробег по системе ГЛОНАСС.
    Возвращает [(plate, date_iso|None, sheet_km|None, glonass_km|None)], дедуп по
    (номер, дата)."""
    if not text:
        return []
    body = _strip_html(text)
    matches = list(_PLATE_RE.finditer(body))
    out: list[tuple[str, str | None, float | None, float | None]] = []
    seen: set[tuple[str, str | None]] = set()
    for i, m in enumerate(matches):
        plate = _normalize_plate(m.group(0))
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        win = body[m.end(): end]
        dm = _DATE_RE.search(win) or _DATE_SHORT_RE.search(win)
        date = _iso_from_dmy(dm.group(0)) if dm else _iso_from_month_name(win)
        wm = _WAYBILL_KM_RE.search(win)
        gm = _GLONASS_KM_RE.search(win)
        sheet = _safe_km(wm.group(1)) if wm else None
        glonass = _safe_km(gm.group(1)) if gm else None
        key = (plate, date)
        if key in seen:
            continue
        seen.add(key)
        out.append((plate, date, sheet, glonass))
    return out


# Short date: DD.MM.YY  or  DD.MM.YYYY
_DATE_SHORT_RE = re.compile(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2}(?:\d{2})?)")


def _parse_date_short(m: "re.Match[str]") -> str | None:
    """Parse DD.MM.YY or DD.MM.YYYY match → ISO, or None on invalid."""
    try:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        return _dt.date(y, mo, d).isoformat()
    except (ValueError, IndexError):
        return None


def _parse_summary_table(text: str) -> list[tuple[str, str | None, float | None, float | None]]:
    """Parse a «сводное письмо» table (header contains «Дата выезда»).

    Each ТС occupies one or more rows; one row = one «выезд» on its own date
    (incl. «нет данных» rows, which still carry a date). One ТС may have SEVERAL
    dates → SEVERAL records (по одному объекту несколько выездов по разным датам,
    63317/О579СХ). We therefore emit ONE record per distinct date row.

    Колонки строки: «… | Дата выезда | Пробег по Глонасс | Пробег по 1С(ПЛ) |
    Разница% ». После даты берём ДВА первых числа: 1-е = пробег по ГЛОНАСС
    (declared_system_km), 2-е = пробег по 1С/путевому листу (sheet_km); 3-е
    (разница%) игнорируем (63317 — клиент даёт оба пробега в таблице).

    Returns list of ``(plate, date_iso|None, glonass_km|None, sheet_km|None)``,
    deduped by ``(plate, date)``. A plate with no parseable date is still emitted
    once as ``(plate, None, None, None)`` so it isn't silently dropped.
    """
    results: list[tuple[str, str | None, float | None, float | None]] = []
    seen_pairs: set[tuple[str, str | None]] = set()
    plates_order: list[str] = []
    plates_with_date: set[str] = set()

    current_plate: str | None = None

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue

        # Switch the current plate when a new one appears on the line.
        plate_match = _PLATE_STD_RE.search(stripped)
        if plate_match:
            current_plate = _normalize_plate(plate_match.group(0))
            if current_plate not in plates_order:
                plates_order.append(current_plate)

        # Each parseable date on the current plate's rows = a separate record.
        if current_plate:
            dm = _DATE_SHORT_RE.search(stripped)
            if dm:
                iso = _parse_date_short(dm)
                if iso:
                    key = (current_plate, iso)
                    if key not in seen_pairs:
                        seen_pairs.add(key)
                        # Числа ПОСЛЕ даты: убираем время в скобках «(19:00)» и
                        # хвостовые даты интервала, берём первые два числа.
                        tail = stripped[dm.end():]
                        tail = re.sub(r"\([^)]*\)", " ", tail)
                        tail = re.sub(r"\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}", " ", tail)
                        nums = re.findall(r"\d+(?:[.,]\d+)?", tail)
                        glonass = _safe_km(nums[0]) if len(nums) >= 1 else None
                        sheet = _safe_km(nums[1]) if len(nums) >= 2 else None
                        results.append((current_plate, iso, glonass, sheet))
                        plates_with_date.add(current_plate)

    # Plates that appeared but never had a parseable date → emit once as None.
    for p in plates_order:
        if p not in plates_with_date:
            results.append((p, None, None, None))

    return results


def _parse_grouping_table(text: str) -> list[tuple[str, float | None, float | None]]:
    """Табличный отчёт «Группировка <дата> | Пробег по ГЛОНАСС | Пробег ТС | …»
    (Ульяновские РС, 64436): по одному XLSX на дату, строка — один ТС.

    «Пробег ТС» = пробег по путевому листу (одометр), «Пробег по ГЛОНАСС» =
    заявленный клиентом пробег по системе. Пустые ячейки XLSX выпадают при
    извлечении, поэтому берём ЧИСЛА после ячейки с гос.номером: 1-е = ГЛОНАСС,
    2-е = Пробег ТС. Возвращает (plate, sheet_km|None, glonass_km|None)."""
    results: list[tuple[str, float | None, float | None]] = []
    for line in (text or "").splitlines():
        if "|" not in line:
            continue
        cells = [c.strip() for c in line.split("|")]
        plate: str | None = None
        name_idx = -1
        for i, cell in enumerate(cells):
            m = _PLATE_STD_RE.search(cell) or _PLATE_FALLBACK_RE.search(cell)
            if m:
                plate = _normalize_plate(m.group(0))
                name_idx = i
                break
        if not plate:
            continue
        nums: list[float] = []
        for cell in cells[name_idx + 1:]:
            try:
                nums.append(float(cell.replace(",", ".").replace(" ", "")))
            except ValueError:
                continue
        glonass = nums[0] if len(nums) >= 1 else None
        sheet = nums[1] if len(nums) >= 2 else None
        results.append((plate, sheet, glonass))
    return results


_DATE_RE = re.compile(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})")
# Интервал дат неисправности: «15.06-16.06», «15.06.2026 - 16.06.2026», «15.06 по 16.06».
_RANGE_RE = re.compile(
    r"(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?"
    r"\s*(?:[–—-]|\bпо\b|\bдо\b)\s*"
    r"(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?"
)
# Интервал с ОБЩИМ месяцем: «26-28.06.2026», «26 - 28.06» (64680) — у первого дня
# нет своего «.MM», месяц/год общий для обоих дней.
_RANGE_DDMM_RE = re.compile(
    r"(?<!\d)(\d{1,2})\s*[–—-]\s*(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?(?!\d)")


def _norm_year(y: str | None, fallback: int) -> int:
    if not y:
        return fallback
    yi = int(y)
    return yi + 2000 if yi < 100 else yi


def _detect_date_range(text: str) -> tuple[str, str] | None:
    """Найти интервал дат «start-end» → (start_iso, end_iso) или None.

    Год берётся из явного (любого из двух), иначе текущий (МСК). Возвращаем только
    валидный интервал: start<=end и длиной до 31 дня (иначе это не «дата неисправности»)."""
    cur = _msk_today().year
    # Сначала интервал с общим месяцем «DD-DD.MM[.YYYY]» (64680).
    for m in _RANGE_DDMM_RE.finditer(text or ""):
        d1, d2, mo, y = m.groups()
        try:
            yr = _norm_year(y, cur)
            start = _dt.date(yr, int(mo), int(d1))
            end = _dt.date(yr, int(mo), int(d2))
        except (ValueError, TypeError):
            continue
        if start <= end and (end - start).days <= 7:
            return start.isoformat(), end.isoformat()
    for m in _RANGE_RE.finditer(text or ""):
        d1, mo1, y1, d2, mo2, y2 = m.groups()
        try:
            start = _dt.date(_norm_year(y1 or y2, cur), int(mo1), int(d1))
            end = _dt.date(_norm_year(y2 or y1, cur), int(mo2), int(d2))
            # Переход года без явных годов: «28.12 — 03.01» → конец в следующем году.
            if end < start and not (y1 or y2):
                end = end.replace(year=end.year + 1)
        except (ValueError, TypeError):
            continue
        # Это короткий интервал «даты неисправности» (≤7 дней), а НЕ отчётный период
        # (месяц) — длинные диапазоны НЕ перетирают распарсенную дату неисправности.
        if end < start or (end - start).days > 7:
            continue
        return start.isoformat(), end.isoformat()
    return None


# Mileage figure inside a comment («пробег … 49 км по ССМ ГЛОНАСС 0 км»):
# a number immediately followed by км/м. Used only to confirm a comment is
# actually about a mileage discrepancy before we treat its date as analyzable.
_COMMENT_MILEAGE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(км|м)\b", re.I)
# Признак, что комментарий вводит НОВУЮ дату неисправности БЕЗ числа пробега
# (переоткрытие заявки): «За 24.06.2026 пробег не выгрузился», «возобновить
# заявку», «не вышел на связь», «нет данных», «отсутствует трек/информация»
# (64228 — заявку решили за 16.06, затем открыли заново с датой 24.06 без км).
_COMMENT_FAULT_RE = re.compile(
    r"не\s+выгруз|возобнов|не\s+вышел\s+на\s+связь|нет\s+данных|"
    r"отсутству(?:ет|ют)\s+(?:трек|информац|данны)|пробег\s+не\b",
    re.I,
)


def _scan_comment_for_new_date(comments: str | None, base_date: str | None,
                               ) -> str | None:
    """If a comment names a date DIFFERENT from ``base_date`` together with a
    mileage figure (км/м) OR a fault phrase, return that comment's date in ISO.

    Case 63301 (Нижнеломовское ПО): body fault is date A (already answered);
    later a client comment introduces date B («За 27.05.2026 пробег по путевому
    листу 49 км по ССМ ГЛОНАСС 0 км») — a NEW date to analyze.
    Case 64228 (Северо-Восточное): заявка решена за 16.06, затем переоткрыта
    комментарием «За 24.06.2026 пробег не выгрузился. Прошу возобновить заявку»
    — новая дата БЕЗ числа пробега. Поэтому строку считаем «несущей дату», если
    в ней есть либо число км/м, либо фраза-признак неисправности.
    We pick the most recent such date so the analysis follows the freshest
    comment. Bounded: returns at most one extra date. Never raises.
    """
    if not comments or not comments.strip():
        return None
    try:
        candidates: list[str] = []
        for line in comments.splitlines():
            if not (_COMMENT_MILEAGE_RE.search(line) or _COMMENT_FAULT_RE.search(line)):
                continue
            for dm in _DATE_RE.finditer(line):
                try:
                    iso = _dt.date(int(dm.group(3)), int(dm.group(2)),
                                   int(dm.group(1))).isoformat()
                except (ValueError, IndexError):
                    continue
                if iso != base_date:
                    candidates.append(iso)
        if not candidates:
            return None
        # Freshest date among the comment-introduced ones.
        return max(candidates)
    except Exception:  # pragma: no cover - never break automate
        return None


def _strip_html(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip()


_MD_NOISE_RE = re.compile(r"\*\*|\*|__|`|#+|^\s*[-•]\s+", re.M)


def _clean_answer(text: str | None) -> str:
    """Убрать лишние символы из ответа клиенту (markdown-разметку LLM: **, *, #,
    `, маркеры списков) — в Okdesk это выглядит мусором (64432)."""
    if not text:
        return ""
    cleaned = _MD_NOISE_RE.sub("", text)
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _to_km(value: float, unit: str | None) -> float:
    if unit and unit.lower().startswith("м") and not unit.lower().startswith("км"):
        return round(value / 1000.0, 3)
    return value


def _parse_number(raw: str) -> float:
    return float(raw.replace(",", ".").replace(" ", ""))


@dataclass
class ParsedIssue:
    plate: str | None = None
    date: str | None = None  # ISO date YYYY-MM-DD (начало интервала, если он есть)
    date_to: str | None = None  # ISO: конец интервала неисправности (15.06-16.06)
    sheet_mileage_km: float | None = None  # по путевому листу
    declared_system_km: float | None = None  # «в ПК», то что увидел клиент
    llm_extracted: bool = False  # часть полей восстановлена ИИ (regex не справился)


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
    last_message_date: str | None = None  # ISO: дата последнего выхода объекта на связь
    last_packet_msk: str | None = None  # HH:MM последнего пакета за дату (МСК)
    tail_gap_min: float | None = None  # разрыв от последнего пакета до конца суток, мин
    day_profile: list[dict[str, Any]] | None = None  # профиль суток по 4-ч отрезкам
    graph_events: dict[str, Any] | None = None  # структурный анализ графика (события)
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
    # Клиент подтвердил питание/массу и ждёт удалённой диагностики — заявка зависает
    # в wait, мяч на нашей стороне (не «ждём клиента»).
    needs_remote_diagnostics: bool = False
    # Спецтехника без км-пробега (трактор/погрузчик/буровая) — км-вердикт ненадёжен.
    spec_vehicle: bool = False


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
    {"key": "Диагностика", "when": "Терминал не на связи / нет данных за дату и нет признаков глушения или штатного отключения — нужна удалённая проверка силами нашей техподдержки.",
     "template": "Здравствуйте! Для первичной удалённой диагностики терминала просим: 1. Включить питание терминала (массу или клеммы АКБ) и не выключать до конца рабочего дня. 2. Проверить целостность проводов питания. 3. Проверить светодиодную индикацию на корпусе. Сообщите о результате."},
]


# General-assistant system prompt: used when the mileage path can't proceed
# (no plate parsed, non-mileage issue type, object/telemetry lookup failed).
# The AI reads the issue, understands the problem, names the data it still
# needs, and drafts an answer OR a clear note for the operator. Strict JSON out.
_GENERAL_SYSTEM_PROMPT = (
    "Ты — ассистент техподдержки GPSPOS (мониторинг транспорта: Okdesk, "
    "GPSPOS Nav nav.gpspos.ru, GPSPOS Geo geo.gpspos.ru). Эта заявка НЕ "
    "подходит под автоматический разбор расхождения пробега (нет гос.номера, "
    "другой тип заявки или не нашлись данные по объекту). Твоя задача: "
    "Начинай ответ клиенту с приветствия («Здравствуйте!»). "
    "(а) понять суть обращения и сформулировать проблему клиента; "
    "(б) определить, каких данных не хватает для решения (объект/ТС и гос.номер, "
    "период/дата, тип системы мониторинга, телеметрия, доступ к объекту в Geo/Nav); "
    "(в) если данных достаточно — дай вежливый черновик ответа клиенту на русском; "
    "если нет — кратко сформулируй, что понял и что оператору нужно уточнить или "
    "проверить, прежде чем отвечать. Не выдумывай данные, которых нет. "
    "Учитывай отправителя (поле «отправитель»): главный клиент — дочерние "
    "компании Россетей. Верни СТРОГО JSON без пояснений: "
    '{"problem": "...", "needed_data": ["..."], "answer": "...", '
    '"confidence": 0.0-1.0, "reasoning": "..."}'
)


# PASS 1 (control center): classify the issue intent and list which concrete
# data would help resolve it, so we can fetch only those facts via Geo tools.
_GENERAL_INTENT_PROMPT = (
    "Ты — диспетчер техподдержки GPSPOS (мониторинг транспорта Россетей: Okdesk, "
    "GPSPOS Nav, GPSPOS Geo). Проанализируй заявку и определи её НАМЕРЕНИЕ и какие "
    "конкретные данные помогут её решить. Намерения (intent): "
    "mileage (расхождение пробега), object_offline (объект/терминал не на связи), "
    "data_gap (нет данных/трека за период), track_request (запрос трека/маршрута), "
    "settings (настройки объекта/детектора), billing (оплата/тариф/договор), "
    "other (прочее). В поле needed перечисли, что стоит подтянуть из системы "
    "(допустимо: object_status, daily_stats, track, company). Если в тексте есть "
    "гос.номер ТС — верни его в plate_guess (кириллица, формат А123ВС64, без пробелов), "
    "иначе null. Если есть дата сбоя/периода — date_guess в формате YYYY-MM-DD, иначе null. "
    "Не выдумывай. Верни СТРОГО JSON без пояснений: "
    '{"intent": "...", "needed": ["..."], "plate_guess": "...", '
    '"date_guess": "YYYY-MM-DD", "reasoning": "..."}'
)


# PASS 2 (control center): given the original question + facts we gathered from
# Geo tools, draft the answer (or an operator note) and self-assess confidence.
_GENERAL_ANSWER_PROMPT = (
    "Ты — ассистент техподдержки GPSPOS (мониторинг транспорта Россетей). Тебе дали "
    "исходную заявку и ФАКТЫ, собранные из системы мониторинга (статус объекта, "
    "суточная статистика и т.п.). Опираясь ТОЛЬКО на эти факты и текст заявки: "
    "(а) сформулируй проблему клиента; (б) дай вежливый черновик ответа на русском, "
    "подставляя реальные числа из фактов; если данных не хватает — кратко скажи, что "
    "оператору нужно ещё проверить, и заполни это в needs_more. "
    "ВАЖНО: если в фактах есть «ситуация_с_данными» с «последнее_сообщение_относительно_даты»=«раньше_даты_неисправности» "
    "и данных за дату нет — объект перестал выходить на связь ещё ДО заявленной даты: это случай для "
    "удалённой проверки силами НАШЕЙ техподдержки (проверить питание/массу терминала, проводку, светодиодную индикацию). "
    "Не предлагай передачу/перенастройку объекта и НЕ пиши «силами клиента»; укажи дату последнего сообщения. "
    "Не выдумывай данные, "
    "которых нет в фактах. Верни СТРОГО JSON без пояснений: "
    '{"problem": "...", "answer": "...", "confidence": 0.0-1.0, '
    '"reasoning": "...", "needs_more": "..."}'
)


# Maps PASS 1 intent → a human-readable category label for the operator UI.
_INTENT_CATEGORY: dict[str, str] = {
    "mileage": "Расхождение пробега",
    "object_offline": "Объект не на связи",
    "data_gap": "Нет данных",
    "track_request": "Запрос трека",
    "settings": "Настройки объекта",
    "billing": "Биллинг/договор",
    "other": "Общий разбор",
}


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

        # Приоритет: полный номер в теме/имени файла → усечённый в теме →
        # полный в тексте → усечённый в тексте. Имя файла важнее текста акта,
        # где год+«Не» давал ложный «2026НЕ».
        m = (_PLATE_RE.search(title) or _PLATE_FALLBACK_RE.search(title)
             or _PLATE_RE.search(text) or _PLATE_FALLBACK_RE.search(text))
        if m:
            parsed.plate = _normalize_plate(m.group(0))

        # Fault-date detection. The fault date is rarely the first date in the
        # text — that's usually the report/send/act date (e.g. Волжское ПО акты:
        # «Акт № 3 от 08.06 … осмотр 08.06 … в системе 03.06» — неисправность 03.06).
        # Priority of explicit markers:
        #   1. «Дата неисправности <date>» (табличный акт)
        #   2. «в системе [с] <date>» (когда в системе произошёл сбой)
        #   3. «за <date>» (расхождение пробега за …)
        #   4. дата в теме (формат Оренбурга: «10-06-2026 Х774НВ»)
        #   5. первая дата в тексте
        def _from_match(mm: "re.Match[str] | None") -> str | None:
            if not mm:
                return None
            try:
                return _dt.date(int(mm.group(3)), int(mm.group(2)), int(mm.group(1))).isoformat()
            except (ValueError, IndexError):
                return None

        def _from_iso(mm: "re.Match[str] | None") -> str | None:
            if not mm:
                return None
            try:
                return _dt.date(int(mm.group(1)), int(mm.group(2)), int(mm.group(3))).isoformat()
            except (ValueError, IndexError):
                return None

        def _from_flex(mm: "re.Match[str] | None") -> str | None:
            """Дата с 2- ИЛИ 4-значным годом (акты Волжского ПО: «10.06.26»)."""
            if not mm:
                return None
            try:
                y = int(mm.group(3))
                y = y + 2000 if y < 100 else y
                return _dt.date(y, int(mm.group(2)), int(mm.group(1))).isoformat()
            except (ValueError, IndexError):
                return None

        d = r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})"
        d2 = r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})"  # год 2 или 4 цифры
        iso = r"(\d{4})-(\d{2})-(\d{2})"
        # Маркер даты неисправности: разные дочерние Россети называют поле
        # по-разному — «неисправность», «сбой», «ошибка», «отказ».
        _fault = r"дат\w*\s+(?:неисправност\w*|сбо\w*|ошибк\w*|отказ\w*)[^\d]{0,30}"
        parsed.date = (
            # Высокий приоритет: маркеры с 2- или 4-значным годом (акты Волжского ПО:
            # «Дата неисправности | 10.06.26», «в системе с 10.06.26»). Без этого
            # дата неисправности (2-значный год) не ловилась и бралась дата акта/файла.
            _from_flex(re.search(_fault + d2, text, re.I | re.S))
            or _from_flex(re.search(r"в\s+системе(?:\s+с)?[^\d]{0,20}" + d2, text, re.I))
            or _from_match(re.search(_fault + d, text, re.I | re.S))
            or _from_iso(re.search(_fault + iso, text, re.I | re.S))
            or _from_match(re.search(r"в\s+системе(?:\s+с)?[^\d]{0,20}" + d, text, re.I))
            or _from_match(re.search(r"(?<!период\s)за\s*" + d, text, re.I))
            or _from_iso(re.search(r"(?<!период\s)за\s*" + iso, text, re.I))
            or _from_match(_DATE_RE.search(title))
            or _from_match(_DATE_RE.search(text))
            or _from_iso(re.search(iso, text))
        )

        # Интервал неисправности («15.06-16.06») — пробег анализируем за ВЕСЬ
        # интервал. Явный диапазон приоритетнее одиночной даты.
        rng = _detect_date_range(text)
        if rng:
            parsed.date, parsed.date_to = rng

        # по путевому листу / по ПЛ / по одометру <num> <unit>.
        # Единица (км/м) ОБЯЗАТЕЛЬНА — иначе регулярка цепляет даты (10.05.2026)
        # и прочие числа. Допускаем «составил – », «равен» между словом и числом.
        sm = re.search(r"(?:путев\w*\s+лист\w*|одометр\w*|по\s*ПЛ|ПЛ)[^\d\n]{0,18}(\d+(?:[.,]\d+)?)\s*(км|м)\b", text, re.I)
        if sm:
            parsed.sheet_mileage_km = _to_km(_parse_number(sm.group(1)), sm.group(2))
        else:
            # Fallback: табличный акт Самары — единица в скобках ПЕРЕД числом,
            # без единицы после: «Пробег по путевому листу (км) 367» (см. 64253).
            # Единица «(км)» — обязательный якорь сразу перед числом, поэтому даты
            # (16.06.2026) и прочие числа не цепляются. Без bare «ПЛ», чтобы не ловить
            # лишнее: таблица всегда пишет полное «путевому листу»/«по ПЛ».
            sm = re.search(r"(?:путев\w*\s+лист\w*|одометр\w*|по\s*ПЛ)[^\d\n]{0,12}\((км|м)\)[^\d\n]{0,4}(\d+(?:[.,]\d+)?)", text, re.I)
            if sm:
                parsed.sheet_mileage_km = _to_km(_parse_number(sm.group(2)), sm.group(1))

        # «в ПК <num> <unit>» / «в системе <num> <unit>» — то, что клиент видит
        # в системе (Волжское/Самара пишут «в системе», Оренбург — «в ПК»).
        # Единица (км/м) обязательна — иначе зацепит дату-маркер «в системе 03.06».
        # Приоритет «в ПК» (явный маркер) над «в системе», т.к. re.search берёт
        # первое совпадение — иначе ранняя «в системе N км» перебила бы «в ПК».
        cm = (re.search(r"в\s*ПК[^\d\n]{0,6}(\d+(?:[.,]\d+)?)\s*(км|м)\b", text, re.I)
              or re.search(r"в\s*систем\w*[^\d\n]{0,6}(\d+(?:[.,]\d+)?)\s*(км|м)\b", text, re.I))
        if cm:
            parsed.declared_system_km = _to_km(_parse_number(cm.group(1)), cm.group(2))
        else:
            # Тот же табличный фолбэк для значения «в системе»: «Пробег в системе
            # ГЛОНАСС (км) 318». Якорь «(км)» защищает от даты-маркера «в системе 03.06».
            cm = (re.search(r"в\s*ПК[^\d\n]{0,18}\((км|м)\)[^\d\n]{0,4}(\d+(?:[.,]\d+)?)", text, re.I)
                  or re.search(r"в\s*систем\w*[^\d\n]{0,18}\((км|м)\)[^\d\n]{0,4}(\d+(?:[.,]\d+)?)", text, re.I))
            if cm:
                parsed.declared_system_km = _to_km(_parse_number(cm.group(2)), cm.group(1))
        return parsed

    # ----- telemetry -----------------------------------------------------
    async def gather_telemetry(self, plate: str, iso_date: str,
                               iso_date_to: str | None = None) -> TelemetryFacts:
        facts = TelemetryFacts()
        obj = await self._geo.find_object_by_plate(plate)
        if not obj:
            facts.flags.append("object_not_found")
            return facts
        oid = int(obj["id"])
        facts.object_id = oid
        facts.object_name = obj.get("name")

        day = _dt.date.fromisoformat(iso_date)
        # Интервал неисправности (1.6): окно от начала до конца интервала (МСК),
        # пробег/трек считаем за ВЕСЬ период, а не один день.
        day_to = day
        if iso_date_to:
            try:
                dt2 = _dt.date.fromisoformat(iso_date_to)
                if dt2 >= day:
                    day_to = dt2
            except ValueError:
                pass
        from_ms, _ = _msk_day_window_ms(day)
        _, till_ms = _msk_day_window_ms(day_to)

        stats = await self._geo.get_daily_stats(oid, from_ms, till_ms)
        ymd0 = int(day.strftime("%Y%m%d"))
        ymd1 = int(day_to.strftime("%Y%m%d"))
        # За интервал суммируем все суточные строки в диапазоне; для одного дня —
        # это ровно та же строка (без stats[0]-фоллбэка, чтобы не взять чужой день).
        rng_rows = [r for r in stats if ymd0 <= (r.get("day") or 0) <= ymd1]
        if rng_rows:
            facts.system_mileage_km = round(
                sum(float(r.get("length") or 0) for r in rng_rows) / 1000.0, 2)
            facts.max_speed = max((r.get("maxSpeed") or 0) for r in rng_rows)
            facts.move_time_min = round(
                sum(float(r.get("moveTime") or 0) for r in rng_rows) / 60000.0, 1)

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
                # min/avg по ВАЛИДНЫМ показаниям (≥ _GLITCH_V): битые near-zero
                # пакеты не должны давать «мин. напряжение 0 В» при реальных 27 В.
                valid_powers = [v for v in powers if v >= _GLITCH_V]
                ref = valid_powers or powers
                facts.min_power_v = round(min(ref), 1)
                facts.avg_power_v = round(sum(ref) / len(ref), 1)
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
            # «Хвостовой» разрыв: данные были, но ОБОРВАЛИСЬ среди дня и не
            # возобновились до конца суток (признак потери питания/связи в течение
            # рабочего дня — 64275). Время последнего пакета и разрыв до 24:00 МСК.
            # Хвостовой разрыв и профиль суток — ТОЛЬКО для одного дня. Для
            # многодневного интервала «конец суток» и 6×4ч-сетка некорректны
            # (давали бы ложный midday_stop и профиль лишь первого дня).
            single_day = day_to == day
            last_ms = times[-1] if times else 0
            if last_ms and single_day:
                facts.last_packet_msk = _dt.datetime.fromtimestamp(last_ms / 1000.0, _MSK).strftime("%H:%M")
                facts.tail_gap_min = round(max(0.0, (till_ms - last_ms) / 60000.0), 1)

            # Профиль суток по 4-часовым отрезкам — чтобы ИИ «читал график»:
            # как менялись напряжение и движение в течение дня (64281/64275).
            if single_day:
                seg_ms = 4 * 3600 * 1000
                profile: list[dict[str, Any]] = []
                for i in range(6):
                    b0 = from_ms + i * seg_ms
                    b1 = b0 + seg_ms
                    seg = [p for p in packets if b0 <= (p.get("time") or 0) < b1]
                    label = f"{i * 4:02d}–{i * 4 + 4:02d}"
                    if not seg:
                        profile.append({"период": label, "статус": "нет данных"})
                        continue
                    seg_v = [
                        (p.get("tags") or {}).get("pwr_ext") for p in seg
                        if isinstance(p.get("tags"), dict) and (p.get("tags") or {}).get("pwr_ext") is not None
                    ]
                    seg_v = [v for v in seg_v if v >= _GLITCH_V]
                    seg_speed = [p.get("speed") or 0 for p in seg]
                    profile.append({
                        "период": label,
                        "пакетов": len(seg),
                        "напряжение_В": round(sum(seg_v) / len(seg_v), 1) if seg_v else None,
                        "макс_скорость": max(seg_speed) if seg_speed else 0,
                    })
                facts.day_profile = profile

            # Структурный «разбор графика» для ИИ: конкретные моменты (окно
            # движения, время падения напряжения, крупные разрывы) — чтобы ответ
            # опирался на факты с графика, а не на общие фразы.
            def _hm(ms: float) -> str:
                return _dt.datetime.fromtimestamp(ms / 1000.0, _MSK).strftime("%H:%M")

            ev: dict[str, Any] = {}
            move_times = [p.get("time") for p in packets if (p.get("speed") or 0) > 0 and p.get("time")]
            if move_times:
                ev["движение_с"] = _hm(min(move_times))
                ev["движение_по"] = _hm(max(move_times))
            else:
                ev["движение"] = "не зафиксировано"
            drop = next(
                (p.get("time") for p in packets
                 if isinstance(p.get("tags"), dict)
                 and (p.get("tags") or {}).get("pwr_ext") is not None
                 and _GLITCH_V <= (p["tags"]["pwr_ext"]) < _POWER_OFF_V and p.get("time")),
                None,
            )
            if drop:
                ev["напряжение_упало_в"] = _hm(drop)
            if facts.max_gap_min and facts.max_gap_min > _TRACK_GAP_MIN:
                ev["макс_разрыв_трека_мин"] = facts.max_gap_min
            facts.graph_events = ev

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
        # Если данных за указанную дату нет — узнаём, когда объект последний раз
        # выходил на связь. Это вход в алгоритм: молчит ли он ещё ДО даты (давно
        # оффлайн → диагностика) или выходил ПОЗЖЕ (питания не было, потом дали).
        if facts.packets == 0:
            try:
                st = await self._geo.get_object_status(oid)
                last_ts = getattr(st, "time", None) if st else None
                if last_ts:
                    facts.last_message_date = _msk_date_from_ms(last_ts).isoformat()
            except Exception:  # pragma: no cover - best effort, never break analysis
                log.warning("object_status_failed", object_id=oid)
        return facts

    async def _verify_data_resumed(self, object_id: int, fault_date: str,
                                   max_days: int = 14) -> dict[str, Any] | None:
        """Did real data RESUME after the fault date? (case 64201)

        When telemetry shows power-off/no-data on the fault date and a comment
        claims the issue is fixed (масса включена / питание восстановлено), we
        must NOT trust the comment blindly — we check whether anything AFTER the
        fault date (up to min(today, fault_date+max_days)) actually has packets.
        Returns
        ``{"данные_возобновились": bool, "дата_возобновления": ISO|None}`` or
        ``None`` if the check couldn't run (caller then omits the fact).

        IMPLEMENTATION: we use ``get_packets`` over the window — the SAME live
        source that ``gather_telemetry``/``build_track`` already trust. The
        precomputed DailyStat.length lags badly: for 64201 (object 8789, fault
        10.06) every DailyStat row 11.06..18.06 reports ``length=0`` while
        ``get_packets`` returns 995 real packets on 17.06. Trusting the stale
        DailyStat produced a FALSE NEGATIVE (recommend a brigade visit instead
        of confirming power restoration). The resume date is the date of the
        first real packet. Bounded to ONE packets call. Never raises.
        """
        try:
            start_day = _dt.date.fromisoformat(fault_date) + _dt.timedelta(days=1)
            today = _msk_today()
            end_day = min(today, _dt.date.fromisoformat(fault_date)
                          + _dt.timedelta(days=max_days))
            if end_day < start_day:
                return None
            from_ms, _ = _msk_day_window_ms(start_day)
            _, till_ms = _msk_day_window_ms(end_day)
            packets = await self._geo.get_packets(object_id, from_ms, till_ms)
            resumed_on: str | None = None
            first_ts = min(
                (p.get("time") for p in packets
                 if isinstance(p.get("time"), (int, float)) and p.get("time")),
                default=None,
            )
            if first_ts is not None:
                resumed_on = _msk_date_from_ms(first_ts).isoformat()
            return {
                "данные_возобновились": resumed_on is not None,
                "дата_возобновления": resumed_on,
            }
        except Exception:  # pragma: no cover - never break automate
            return None

    @staticmethod
    def _derive_flags(f: TelemetryFacts) -> None:
        # Движение = питание точно было. Используется и для power_off, и для jamming.
        moving = bool((f.system_mileage_km or 0) > 0.5 or (f.move_time_min or 0) > 1)
        # «Не было питания» НЕ ставим, если ТС реально двигалось: движущийся
        # терминал запитан, а доля низких показаний — это битые near-zero пакеты
        # датчика, а не отсутствие питания (64281). Реальное отключение питания —
        # это стоящее ТС с устойчиво низким напряжением.
        if f.power_off_ratio and f.power_off_ratio > 0.2 and not moving:
            f.flags.append("power_off")
        # Jamming = the GPS POSITION is corrupted: track shots (teleports) and/or
        # loss of satellites. Isolated speed spikes alone are NOT enough — a
        # terminal can report a bogus 138 km/h on a single noisy fix while the
        # track stays clean (e.g. 64070). Real jamming (64051) shows many
        # teleports with impossible implied speeds and/or satellite dropouts.
        # Спутниковые/нулевые сигналы считаем глушением ТОЛЬКО если ТС реально
        # двигалось: у СТОЯЩЕГО терминала мало спутников — норма (плохой обзор неба
        # на стоянке), а не глушение. Иначе припаркованное авто с потерей питания
        # среди дня ложно помечалось «Глушение» (64275). Телепорты (явный спуфинг)
        # остаются признаком глушения независимо от движения (``moving`` выше).
        # Пороги откалиброваны на 159 «глушений» vs 58 «не-глушений» из training_samples
        # (recall 73%→78%, ложные срабатывания не растут, ~10%):
        #  • implied-speed >500 при teleport_jumps>=1 (было >=2) — у не-глушений
        #    max_implied_kmh>500 практически не встречается, ловим +7 пропущенных;
        #  • всплески скорости speed_spike_count>=100 (порог именно 100: на 90
        #    стоит пограничное не-глушение) — ещё +1 без ложных.
        jamming = (
            f.teleport_jumps >= 5
            or (f.max_implied_kmh is not None and f.max_implied_kmh > 500 and f.teleport_jumps >= 1)
            or (moving and f.speed_spike_count is not None and f.speed_spike_count >= 100)
            or (moving and f.low_sat_ratio is not None and f.low_sat_ratio > 0.08)
            or (moving and f.zero_coord_moving_ratio is not None and f.zero_coord_moving_ratio > 0.15)
            # Глушение, при котором ТС ВЫГЛЯДИТ «стоячим» (нет скорости/трека) — но
            # это СЛЕДСТВИЕ подавления GPS, а не реальная стоянка: спутников почти
            # нет (low_sat≈1.0), поэтому ни координат, ни скорости, ни трека не
            # зафиксировано; при этом по напряжению (питание в норме, пакеты идут)
            # терминал работал и ТС, скорее всего, было В ДВИЖЕНИИ (64657 В791МН).
            # Поэтому здесь НЕ требуем moving (его обнулило само глушение); требуем
            # лишь норм. питание, чтобы не спутать с обесточенным терминалом.
            or (f.packets > 0 and f.low_sat_ratio is not None and f.low_sat_ratio > 0.9
                and (f.avg_power_v is None or f.avg_power_v >= _POWER_OFF_V))
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
        # A long telemetry gap means the terminal lost connection/power: data
        # is buffered in the black box and uploads late, so the mileage catches
        # up afterwards. That's «Терминал подключился», not «Данные верны».
        if "track_gap" in f.flags:
            return "Терминал подключился"
        # System lower than the waybill with a clean track is ambiguous —
        # could be legitimate (пробуксовка/малая скорость → «Данные верны») or
        # a delayed black-box upload (→ «Терминал подключился»). We don't force
        # it here; the LLM decides with the catalog guidance and the operator
        # confirms (large gaps are flagged needs_review in automate()).
        return "Данные верны"

    # ----- LLM refinement ------------------------------------------------
    @staticmethod
    def _format_examples(examples: list[dict[str, Any]] | None) -> str:
        """Render up to 3 retrieved past cases as a bounded few-shot block.

        Each answer is truncated to ~300 chars; empty/None examples yield "".
        """
        if not examples:
            return ""
        lines: list[str] = []
        for ex in examples[:3]:
            answer = (ex.get("answer") or "").strip()
            if not answer:
                continue
            if len(answer) > 300:
                answer = answer[:300].rstrip() + "…"
            cat = ex.get("category") or "?"
            plate = ex.get("plate") or "?"
            date = ex.get("fault_date") or "?"
            lines.append(f"- [{cat}] {plate} {date} → ответ: {answer}")
        if not lines:
            return ""
        return (
            "\nПримеры ранее решённых похожих заявок "
            "(ориентир по решению и формулировкам, НЕ копировать дословно):\n"
            + "\n".join(lines)
            + "\n"
        )

    async def _draft_with_llm(self, parsed: ParsedIssue, f: TelemetryFacts, hint: str,
                              attachments_text: str | None = None,
                              sender: dict[str, Any] | None = None,
                              examples: list[dict[str, Any]] | None = None,
                              comments: str | None = None,
                              verify_resumed: dict[str, Any] | None = None,
                              comment_date_facts: dict[str, Any] | None = None,
                              ) -> dict[str, Any]:
        catalog = "\n".join(
            f"- {c['key']}: {c['when']}\n  Шаблон: {c['template']}" for c in _CATEGORY_CATALOG
        )
        facts = {
            "отправитель": sender or None,
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
        # IMPROVEMENT 1 (64201): verification of whether data actually resumed
        # after the fault date — used to NOT trust a «восстановлено» comment blindly.
        if verify_resumed is not None:
            facts["проверка_данных_после_даты"] = verify_resumed
        # IMPROVEMENT 2 (63301): a comment introduced a NEW date with mileage —
        # telemetry gathered for that date too; analyze the freshest date.
        if comment_date_facts is not None:
            facts["данные_за_дату_из_комментария"] = comment_date_facts
        # Детерминированная ветка «нет данных за дату» (алгоритм оператора):
        # сравниваем дату последней связи объекта с датой неисправности, чтобы
        # модель выбрала между диагностикой (объект давно молчит) и «не было
        # питания, восстановлено позже».
        if "no_data" in (f.flags or []):
            situation: dict[str, Any] = {"данные_за_дату": "отсутствуют"}
            if f.last_message_date:
                situation["дата_последнего_сообщения"] = f.last_message_date
                if parsed.date:
                    if f.last_message_date < parsed.date:
                        situation["последнее_сообщение_относительно_даты"] = "раньше_даты_неисправности"
                    elif f.last_message_date > parsed.date:
                        situation["последнее_сообщение_относительно_даты"] = "позже_даты_неисправности"
                    else:
                        situation["последнее_сообщение_относительно_даты"] = "в_дату_неисправности"
            facts["ситуация_с_данными"] = situation
        # Обрыв данных среди дня (64275): данные были, но прекратились рано
        # (последний пакет до 17:00 МСК) и не возобновились до конца суток.
        if (f.packets and f.tail_gap_min and f.tail_gap_min > 240
                and f.last_packet_msk and f.last_packet_msk < "17:00"):
            facts["данные_оборвались_среди_дня"] = {
                "последний_пакет_мск": f.last_packet_msk,
                "хвостовой_разрыв_мин": f.tail_gap_min,
            }
        if f.day_profile:
            facts["профиль_дня_по_4ч"] = f.day_profile
        if f.graph_events:
            facts["анализ_графика"] = f.graph_events
        if parsed.date_to and parsed.date_to != parsed.date:
            facts["период_анализа"] = f"{parsed.date} — {parsed.date_to}"
        system = (
            "Ты — ассистент техподдержки GPSPOS. По данным телеметрии классифицируй причину "
            "расхождения пробега и составь короткий вежливый ответ клиенту на русском. "
            "Начинай ответ с приветствия («Здравствуйте!»). "
            "Выбери одну категорию из каталога. Подставь реальные числа (дату, пробег) в ответ. "
            "Если есть «период_анализа» — пробег и данные посчитаны за ВЕСЬ интервал дат; "
            "отвечай по интервалу (укажи его), а не по одному дню. "
            "ЗНАНИЯ о данных, питании и напряжении (применяй при выводе): "
            "(1) если за дату ЕСТЬ данные/пакеты — значит питание на терминале БЫЛО; "
            "(1а) НЕ выбирай «Не было питания», если доля_без_питания (power_off_ratio)≈0 и/или "
            "среднее напряжение в норме и есть пакеты/движение — питание было, причина в другом "
            "(глушение/связь/расхождение пробега); «Не было питания» — только при реально низком "
            "напряжении на СТОЯЩЕМ ТС или полном отсутствии данных из-за обесточивания; "
            "(2) если данных НЕТ — либо не было питания на терминале, либо проблема со связью (напр. не работает SIM-карта); "
            "(3) «напряжение» — это бортовая сеть ОБЪЕКТА: норма для легковых ≥12 В, для грузовых ≥24 В; низкое "
            "напряжение указывает на проблему питания/АКБ, но если данные идут — терминал запитан; "
            "(4) если напряжение в норме (>12 В), но НЕТ спутников и скорости — это, скорее всего, ГЛУШЕНИЕ GPS, а не отсутствие питания. "
            "Важно: если пробег по системе заметно МЕНЬШЕ путевого листа, а трек чистый (нет глушения/обрывов) — "
            "это почти всегда временная потеря связи/питания терминала: данные копятся в чёрном ящике и "
            "выгружаются позже, пробег потом сходится. В этом случае НЕ выбирай «Данные верны», ставь умеренную "
            "уверенность (≤0.7) и рекомендуй перепроверить пробег после выгрузки. "
            "Если в фактах есть большой обрыв трека (макс_разрыв_трека_мин велик) или признак track_gap — "
            "СНАЧАЛА проверь признаки глушения: прострелы трека (телепорты), потеря спутников, скачки расчётной "
            "скорости. При наличии таких признаков это ГЛУШЕНИЕ (по данным операторов разрыв трека в ~3/4 случаев "
            "оказывается глушением, а не буферизацией). Только если трек в остальном ЧИСТЫЙ (нет телепортов/потери "
            "спутников/скачков) — это возможна временная потеря связи с догрузкой из чёрного ящика («Терминал "
            "подключился»), но ставь невысокую уверенность (≤0.6) и рекомендуй проверку оператором. "
            "Учитывай отправителя (поле «отправитель»): дочерние компании Россетей оформляют заявки "
            "по-разному — Оренбургэнерго (Восточное/Центральное ПО) обычно указывают гос.номер и дату в теме; "
            "Волжское ПО присылает табличный «Акт» с полем «Дата неисправности»; Самарские РС (Чапаевское ПО) — "
            "общие заявки с вложением-актом по каждому ТС. Текст вложений — первоисточник, верь ему больше темы. "
            "Учитывай комментарии оператора и клиента по заявке (если они даны) — это свежие факты «с места». "
            "Правила по комментариям: "
            "(а) если в комментариях ПОДТВЕРЖДЕНО, что питание восстановлено / масса включена / проводка исправна / "
            "индикация активна / неисправность устранена — НЕ предлагай диагностику; дай ответ о том, что в указанную "
            "дату отсутствовало питающее напряжение на входах терминала, а позже питание было восстановлено силами "
            "заказчика (укажи дату восстановления, взяв её из комментария или трека), и что нет возможности восстановить "
            "трек за период, когда питание было отключено; категория «Не было питания», уверенность ≥0.8. "
            "(б) если ранее по заявке УЖЕ выдавалась удалённая диагностика (есть комментарий с инструкцией: включить "
            "питание/массу, проверить провода питания, проверить светодиодную индикацию), а данные так и не появились — "
            "НЕ повторяй удалённую диагностику, а рекомендуй ВЫЕЗД бригады специалистов для диагностики на месте. "
            "(в) ВАЖНО — НЕ верь комментарию о восстановлении напрямую, сверяй с данными. Если в фактах есть "
            "«проверка_данных_после_даты»: когда клиент сообщил о включении питания/массы И данные ДЕЙСТВИТЕЛЬНО "
            "возобновились (данные_возобновились=true) — подтверди восстановление, укажи дату_возобновления как дату, "
            "когда данные снова пошли. Если клиент сообщил о восстановлении, НО данные по-прежнему отсутствуют "
            "(данные_возобновились=false) — так и напиши: по данным системы мониторинга питание/данные не появились, "
            "и рекомендуй ВЫЕЗД бригады специалистов для диагностики на месте (а не повторную удалённую диагностику). "
            "(г) если в фактах есть «данные_за_дату_из_комментария» — клиент в комментарии указал НОВУЮ дату "
            "расхождения; анализируй именно её (самую свежую) и отвечай по данным за эту дату, подставляя её число и пробег. "
            "(д) если данных за указанную дату НЕТ (признак no_data / поле «ситуация_с_данными») — действуй по алгоритму: "
            "— если «последнее_сообщение_относительно_даты»=«раньше_даты_неисправности» — объект перестал выходить на связь ещё ДО заявленной даты: "
            "рекомендуй удалённую проверку силами НАШЕЙ техподдержки (НЕ пиши «силами клиента»): проверить питание/массу терминала, проводку, светодиодную индикацию, категория «Диагностика»; "
            "— иначе если в «проверка_данных_после_даты» данные_возобновились=true — в указанную дату питания/связи не было, но позже данные пошли: "
            "ответь, что в указанную дату отсутствовало питающее напряжение/связь, данные возобновились (укажи дату_возобновления), "
            "трек за период отсутствия восстановить нельзя; категория «Не было питания», уверенность ≥0.8; "
            "— иначе (последнее сообщение позже даты, но данные так и не возобновились) — рекомендуй ВЫЕЗД бригады специалистов для диагностики на месте. "
            "(е) если есть «данные_оборвались_среди_дня» (данные за дату БЫЛИ, но прекратились рано и большой хвостовой разрыв) "
            "И в «проверка_данных_после_даты» данные_возобновились=true с более поздней датой — значит в указанную дату питание "
            "пропало среди дня (после времени последнего пакета) и было восстановлено позже: ответь, что в указанную дату после "
            "<последний_пакет_мск> отсутствовало питающее напряжение на входах терминала, питание восстановлено <дата_возобновления>, "
            "трек за период отсутствия восстановить нельзя; категория «Не было питания». "
            "Поле «профиль_дня_по_4ч» — это «график» суток по 4-часовым отрезкам (напряжение, макс.скорость, число пакетов): "
            "читай его как телеметрический график — если в отрезках есть движение (макс_скорость>0) и нормальное напряжение (≈12–30 В), "
            "значит питание БЫЛО (не пиши «нет питания»); «нет данных» в отрезке = в это время пакеты не поступали. "
            "Поле «анализ_графика» — конкретные моменты с графика (окно движения, время падения напряжения, крупные разрывы): "
            "ПРОАНАЛИЗИРУЙ их перед ответом и опирайся на конкретные времена/значения, а не на общие фразы. "
            "Будь гибким в формулировках и опирайся на конкретику фактов, но НЕ выходи за рамки категорий каталога и не выдумывай данные. "
            "Держи ответ кратким (2–4 предложения), по делу, без воды. "
            "Не выдумывай данные, которых нет. Верни СТРОГО JSON без пояснений: "
            '{"category": "...", "answer": "...", "confidence": 0.0-1.0, "reasoning": "..."}'
        )
        att_block = ""
        if attachments_text and attachments_text.strip():
            att_block = f"\nТекст из вложений заявки (путевые листы и т.п.):\n{attachments_text[:4000]}\n"
        comments_block = ""
        if comments and comments.strip():
            comments_block = (
                "\nКомментарии по заявке (хронологически, автор • дата • текст):\n"
                f"{comments.strip()[:6000]}\n"
            )
        examples_block = self._format_examples(examples)
        user = (
            f"Каталог категорий ответов:\n{catalog}\n\n"
            f"Факты по заявке (JSON):\n{json.dumps(facts, ensure_ascii=False)}\n"
            f"{att_block}"
            f"{comments_block}\n"
            f"{examples_block}"
            f"Подсказка эвристики (вероятная категория): {hint}\n\n"
            "Ответ строго в JSON."
        )
        raw = await self._llm.chat(system, user)
        return self._parse_llm_json(raw)

    async def _draft_general(self, title: str | None, description: str | None,
                             attachments_text: str | None = None,
                             sender: dict[str, Any] | None = None,
                             comments: str | None = None) -> AutomationResult:
        """Intent-routed, tool-using analyzer (bounded ReAct «control center»).

        Replaces the old single-shot fallback. Strictly bounded:
          PASS 1 — one LLM call: classify intent + list needed data.
          FETCH  — at most 3 cheap Geo tool calls (object lookup, status, daily
                   stats) guided by ``needed`` + a parsed/guessed plate & date.
          PASS 2 — one LLM call: draft the answer from the gathered facts.
        Always returns a valid AutomationResult(needs_review=True); never raises.
        """
        body = _strip_html(description)
        att = (attachments_text or "").strip()
        att_block = f"\n\nТекст вложений:\n{att[:3000]}" if att else ""
        sender_block = (
            f"Отправитель: {json.dumps(sender, ensure_ascii=False)}\n\n" if sender else ""
        )
        # Формат-профиль по ПО: подсказываем ИИ, ОТКУДА брать данные и сколько ТС
        # ожидать у этого отправителя (выведено из закономерностей по дочерним
        # «Россети Волга»). Мягкая подсказка — не жёсткое правило.
        profile = resolve_format_profile(
            (sender or {}).get("компания"), (sender or {}).get("контакт"))
        profile_block = (
            f"Формат заявок этого отправителя: {profile.hint}\n\n" if profile else ""
        )
        comments_block = ""
        if comments and comments.strip():
            comments_block = (
                "\n\nКомментарии по заявке (хронологически, автор • дата • текст). "
                "Учитывай их: если в них подтверждено, что питание восстановлено / масса "
                "включена / неисправность устранена — не предлагай диагностику, а сообщи о "
                "восстановлении питания с датой и невозможности восстановить трек за период "
                "отключения; если ранее уже выдавалась удалённая диагностика, а данные так и "
                "не появились — рекомендуй выезд бригады для диагностики на месте:\n"
                f"{comments.strip()[:6000]}"
            )
        question = (
            sender_block
            + profile_block
            + f"Тема заявки: {title or ''}\n\n"
            + f"Описание: {body or ''}"
            + att_block
            + comments_block
        )

        # ---- PASS 1: intent + data needs --------------------------------
        intent = "other"
        needed: list[str] = []
        plate_guess: str | None = None
        date_guess: str | None = None
        intent_reasoning = ""
        try:
            raw = await self._llm.chat(
                _GENERAL_INTENT_PROMPT, question + "\n\nОтвет строго в JSON."
            )
            p1 = self._parse_llm_json(raw)
            intent = str(p1.get("intent") or "other").strip().lower() or "other"
            nd = p1.get("needed")
            if isinstance(nd, list):
                needed = [str(x).strip().lower() for x in nd if str(x).strip()]
            plate_guess = (str(p1.get("plate_guess")).strip()
                           if p1.get("plate_guess") else None)
            date_guess = (str(p1.get("date_guess")).strip()
                          if p1.get("date_guess") else None)
            intent_reasoning = str(p1.get("reasoning") or "").strip()
        except Exception:  # pragma: no cover - never break automate
            log.warning("general_intent_failed", title=(title or "")[:60])

        # ---- resolve plate & date (regex first, then model's guess) -----
        parsed = self.parse_issue(title, description, None, extra_text=attachments_text)
        plate = parsed.plate
        if not plate and plate_guess:
            cand = _normalize_plate(plate_guess)
            if _PLATE_RE.search(cand) or _PLATE_FALLBACK_RE.search(cand):
                plate = cand
        if not plate:
            all_plates = extract_all_plates(f"{title or ''} {body} {att}")
            if all_plates:
                plate = all_plates[0]
        date = parsed.date
        if not date and date_guess:
            try:
                date = _dt.date.fromisoformat(date_guess[:10]).isoformat()
            except (ValueError, TypeError):
                date = None

        # ---- FETCH: at most 3 bounded Geo tool calls --------------------
        facts: dict[str, Any] = {}
        fetched: list[str] = []
        failed: list[str] = []
        obj: dict[str, Any] | None = None
        object_name: str | None = None
        object_id: int | None = None
        want_status = (not needed) or ("object_status" in needed)
        want_stats = "daily_stats" in needed or intent in ("mileage", "data_gap")

        if plate and (want_status or want_stats):
            try:  # tool 1: resolve object
                obj = await self._geo.find_object_by_plate(plate)
            except Exception:  # pragma: no cover - tool may fail
                obj = None
                failed.append("find_object")
            if obj:
                object_id = int(obj["id"])
                object_name = obj.get("name")
                facts["object_name"] = object_name
                fetched.append("object")
            else:
                facts["object_lookup"] = "объект по гос.номеру не найден"

        if object_id is not None and want_status:
            try:  # tool 2: current status
                st = await self._geo.get_object_status(object_id)
                if st is not None:
                    facts["status"] = {
                        "online": st.online,
                        "last_time_unix": st.time,
                        "speed": st.speed,
                        "sat": st.sat,
                        "lat": st.lat,
                        "lng": st.lng,
                    }
                    fetched.append("object_status")
            except Exception:  # pragma: no cover - tool may fail
                failed.append("object_status")

        if object_id is not None and date and want_stats:
            try:  # tool 3: daily stats for the given day
                day = _dt.date.fromisoformat(date)
                from_ms, till_ms = _msk_day_window_ms(day)
                stats = await self._geo.get_daily_stats(object_id, from_ms, till_ms)
                ymd = int(day.strftime("%Y%m%d"))
                row = next((r for r in stats if r.get("day") == ymd), None)
                if row:
                    facts["daily_stats"] = {
                        "дата": date,
                        "пробег_км": round(float(row.get("length") or 0) / 1000.0, 2),
                        "макс_скорость": row.get("maxSpeed"),
                        "время_в_движении_мин": round(
                            float(row.get("moveTime") or 0) / 60000.0, 1),
                    }
                    fetched.append("daily_stats")
                else:
                    facts["daily_stats"] = "нет суточной статистики за дату"
            except Exception:  # pragma: no cover - tool may fail
                failed.append("daily_stats")

        # Детерминированная подсказка (64279): если объект последний раз выходил
        # на связь ЯВНО раньше заявленной даты и данных за дату нет — это «давно
        # не на связи» → удалённая проверка силами техподдержки, а не произвольный
        # ответ про передачу/настройку объекта.
        st_obj = facts.get("status") if isinstance(facts.get("status"), dict) else None
        last_unix = st_obj.get("last_time_unix") if st_obj else None
        if last_unix and date:
            try:
                last_date = _msk_date_from_ms(last_unix).isoformat()
                sit: dict[str, Any] = {
                    "дата_последнего_сообщения": last_date,
                    "данные_за_дату": "есть" if isinstance(facts.get("daily_stats"), dict) else "отсутствуют",
                }
                if last_date < date:
                    sit["последнее_сообщение_относительно_даты"] = "раньше_даты_неисправности"
                elif last_date > date:
                    sit["последнее_сообщение_относительно_даты"] = "позже_даты_неисправности"
                else:
                    sit["последнее_сообщение_относительно_даты"] = "в_дату_неисправности"
                facts["ситуация_с_данными"] = sit
            except Exception:  # pragma: no cover - best effort
                pass

        # ---- PASS 2: draft the answer from gathered facts ---------------
        problem = ""
        answer = ""
        answer_reasoning = ""
        needs_more = ""
        confidence = 0.0
        try:
            facts_json = json.dumps(facts, ensure_ascii=False, default=str)
            p2_user = (
                question
                + f"\n\nГос.номер: {plate or '—'}; дата: {date or '—'}; "
                + f"намерение: {intent}\n\n"
                + f"Собранные факты из системы (JSON):\n{facts_json}\n\n"
                + "Ответ строго в JSON."
            )
            raw = await self._llm.chat(_GENERAL_ANSWER_PROMPT, p2_user)
            p2 = self._parse_llm_json(raw)
            problem = str(p2.get("problem") or "").strip()
            answer = _clean_answer(str(p2.get("answer") or ""))
            answer_reasoning = str(p2.get("reasoning") or "").strip()
            needs_more = str(p2.get("needs_more") or "").strip()
            try:
                confidence = float(p2.get("confidence") or 0.0)
            except (TypeError, ValueError):
                confidence = 0.0
        except Exception:  # pragma: no cover - never break automate
            log.warning("general_answer_failed", title=(title or "")[:60])
        confidence = max(0.0, min(confidence, 1.0))

        # Фолбэк: если LLM не дал ответа, но гос.номер РАСПОЗНАН — формируем
        # детерминированный черновик с распознанным объектом и его статусом, чтобы
        # оператор не видел пустой результат / «номер не найден» (64577: заявка
        # «не выходит на связь» без даты — номер В876ТР распознан, объект найден).
        if not answer and plate:
            if obj is None:
                answer = (f"По гос.номеру {plate} объект в системе мониторинга не найден — "
                          f"проверьте корректность номера и привязку терминала к объекту.")
            else:
                nm = object_name or plate
                st_d = facts.get("status") if isinstance(facts.get("status"), dict) else None
                online = st_d.get("online") if st_d else None
                last_iso = None
                if st_d and st_d.get("last_time_unix"):
                    try:
                        last_iso = _msk_date_from_ms(st_d["last_time_unix"]).isoformat()
                    except Exception:
                        last_iso = None
                status_txt = "на связи" if online else "не на связи"
                tail = f" Последний выход на связь: {last_iso}." if last_iso else ""
                answer = (f"Объект {nm} (гос.номер {plate}): по данным системы мониторинга "
                          f"терминал {status_txt}.{tail} Для детального разбора уточните дату "
                          f"возникновения неисправности.")
            confidence = confidence or 0.3

        # ---- assemble reasoning + result --------------------------------
        parts: list[str] = [f"Намерение: {_INTENT_CATEGORY.get(intent, intent)}"]
        if problem:
            parts.append(f"Суть обращения: {problem}")
        if fetched:
            parts.append("Использованы данные: " + ", ".join(fetched))
        if failed:
            parts.append("Не удалось получить: " + ", ".join(failed))
        if needs_more:
            parts.append("Ещё нужно проверить: " + needs_more)
        if answer_reasoning:
            parts.append(answer_reasoning)
        elif intent_reasoning:
            parts.append(intent_reasoning)
        reasoning = " | ".join(parts) or (
            "Общий разбор: не удалось автоматически распознать заявку. "
            "Оператору нужно уточнить детали обращения."
        )

        telemetry = TelemetryFacts(object_id=object_id, object_name=object_name)
        return AutomationResult(
            parsed=ParsedIssue(plate=plate, date=date),
            telemetry=telemetry,
            category=_INTENT_CATEGORY.get(intent, "Общий разбор"),
            confidence=confidence,
            draft_answer=answer,
            reasoning=reasoning,
            needs_review=True,  # general path always wants operator confirmation
            error=None,
        )

    async def _extract_with_llm(self, title: str | None, body: str | None,
                                attachments_text: str | None = None) -> dict[str, Any]:
        """Fallback-извлечение полей заявки силами LLM, когда regex не справился
        (табличные акты, нестандартные формулировки разных дочерних Россетей).

        Возвращает {plate, date(ISO), sheet_mileage_km, declared_system_km};
        отсутствующие поля — null. Вызывается ТОЛЬКО когда regex не нашёл
        гос.номер или дату, чтобы не тратить токены на штатных заявках.
        """
        system = (
            "Ты извлекаешь структурированные данные из заявки о расхождении пробега транспорта. "
            "Найди в тексте (тема, описание, текст вложений): гос.номер ТС РФ, дату неисправности, "
            "пробег по путевому листу (км), пробег в системе у клиента (км, «в ПК»). "
            "Гос.номер верни кириллицей в формате А123ВС64 (без пробелов). "
            "Дата неисправности — день, когда зафиксирован сбой/расхождение, а НЕ дата письма, акта или осмотра; "
            "верни в формате YYYY-MM-DD. Пробег — число в км (если в метрах — переведи в км). "
            "Если какого-то поля нет — поставь null. Не выдумывай. "
            'Верни СТРОГО JSON без пояснений: {"plate":"...","date":"YYYY-MM-DD",'
            '"sheet_mileage_km":0,"declared_system_km":0}'
        )
        parts = [f"Тема: {title or ''}", f"Описание: {body or ''}"]
        if attachments_text and attachments_text.strip():
            parts.append(f"Текст вложений:\n{attachments_text[:4000]}")
        user = "\n\n".join(parts) + "\n\nОтвет строго в JSON."
        raw = await self._llm.chat(system, user)
        return self._parse_llm_json(raw)

    def _apply_llm_extraction(self, parsed: ParsedIssue, ext: dict[str, Any]) -> None:
        """Аккуратно заполнить ТОЛЬКО недостающие поля parsed данными от LLM,
        с валидацией. Никогда не перетирает то, что нашёл regex."""
        if not parsed.plate and ext.get("plate"):
            cand = _normalize_plate(str(ext["plate"]))
            if _PLATE_RE.search(cand) or _PLATE_FALLBACK_RE.search(cand):
                parsed.plate = cand
                parsed.llm_extracted = True
        if not parsed.date and ext.get("date"):
            try:
                parsed.date = _dt.date.fromisoformat(str(ext["date"])[:10]).isoformat()
                parsed.llm_extracted = True
            except (ValueError, TypeError):
                pass
        if parsed.sheet_mileage_km is None and isinstance(ext.get("sheet_mileage_km"), (int, float)):
            parsed.sheet_mileage_km = float(ext["sheet_mileage_km"])
            parsed.llm_extracted = True
        if parsed.declared_system_km is None and isinstance(ext.get("declared_system_km"), (int, float)):
            parsed.declared_system_km = float(ext["declared_system_km"])
            parsed.llm_extracted = True

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

    async def _resolve_alt_plate(self, current: str | None, text: str) -> str | None:
        """Среди распознанных в тексте гос.номеров вернуть первый, КОТОРЫЙ ЕСТЬ в
        гео (кроме current). Для случаев, когда номер из темы неточный/опечатка, а
        в теле есть валидный (64655: Х871НХ→Т871НХ64). Best-effort, вызывается
        только когда объект по основному номеру не найден."""
        try:
            cands = extract_all_plates(text)
        except Exception:
            return None
        seen: set[str] = set()
        for p in cands:
            if not p or p == current or p in seen:
                continue
            seen.add(p)
            try:
                if await self._geo.find_object_by_plate(p):
                    return p
            except Exception:  # pragma: no cover - geo may fail
                continue
        return None

    async def automate(self, title: str | None, description: str | None,
                       params: list[dict[str, Any]] | None = None,
                       issue_type: str | None = None,
                       attachments_text: str | None = None,
                       sender: dict[str, Any] | None = None,
                       comments: str | None = None,
                       examples: list[dict[str, Any]] | None = None,
                       example_provider: Callable[
                           [str, str | None, list[str]],
                           Awaitable[list[dict[str, Any]]],
                       ] | None = None) -> AutomationResult:
        parsed = self.parse_issue(title, description, params, extra_text=attachments_text)
        # Fallback: если regex не нашёл гос.номер ИЛИ дату — просим LLM извлечь
        # поля из текста/вложений (нестандартные форматы дочерних Россетей).
        # Не тратим токены, когда regex справился.
        if (not parsed.plate or not parsed.date) and (title or description or attachments_text):
            try:
                ext = await self._extract_with_llm(title, _strip_html(description), attachments_text)
                self._apply_llm_extraction(parsed, ext)
            except Exception:  # pragma: no cover - best effort
                log.warning("llm_extract_failed", title=(title or "")[:60])

        # Правила разбора особых заявок (см. память project-overdue-rules):
        #  • «ложный wait» — клиент подтвердил питание/работу ТС и ждёт удалённой
        #    диагностики (наш шаблон исчерпан, мяч на нашей стороне);
        #  • спецтехника — без км-пробега, км-вердикт ненадёжен.
        _body_for_spec = f"{title or ''} {_strip_html(description)} {attachments_text or ''}"
        awaiting_diag = _client_awaiting_remote_diag(comments)
        spec = _is_special_vehicle(parsed.plate, _body_for_spec)
        directive_lines: list[str] = []
        if awaiting_diag:
            directive_lines.append(
                "ВАЖНО: клиент уже подтвердил питание/массу/работу ТС и ждёт "
                "УДАЛЁННОЙ диагностики. НЕ повторяй шаблон про включение питания. "
                "Дай результат удалённой диагностики по данным телеметрии за дату; "
                "если данных нет / терминал не выходит на связь — рекомендуй ВЫЕЗД "
                "сервисной бригады.")
        if spec:
            directive_lines.append(
                "ВАЖНО: это СПЕЦТЕХНИКА (трактор/погрузчик/буровая и т.п.) без "
                "обычного км-пробега. НЕ делай вывод о расхождении по километрам; "
                "оценивай факт работы/выхода на связь, при необходимости — моточасы.")
        comments_llm = (("\n".join(directive_lines) + "\n\n" + (comments or "")).strip()
                        if directive_lines else comments)

        def _finalize(res: AutomationResult) -> AutomationResult:
            res.needs_remote_diagnostics = awaiting_diag
            res.spec_vehicle = spec
            notes: list[str] = []
            if awaiting_diag:
                notes.append("⚠ Требуется удалённая диагностика: клиент подтвердил "
                             "питание/работу ТС — не ждать клиента; при отсутствии "
                             "данных назначить выезд бригады.")
            if spec:
                notes.append("⚠ Спецтехника без км-пробега — оценивать по факту "
                             "работы/моточасам, км-расхождение неинформативно.")
            if notes:
                res.reasoning = " ".join(notes) + ("\n" + res.reasoning if res.reasoning else "")
                res.needs_review = True
            return res

        telemetry = TelemetryFacts()
        # No plate, or no fault date → the mileage path can't proceed. Instead of
        # a dead-end error, hand off to the GENERAL ASSISTANT path: the AI reads
        # the issue, names the missing data and drafts an answer / operator note.
        is_mileage = bool(issue_type and "пробег" in issue_type.lower())
        if not parsed.plate or not parsed.date:
            # If the type is explicitly non-mileage, the general path is the right
            # home regardless; if it's mileage but unparseable, still go general.
            return _finalize(await self._draft_general(title, description, attachments_text, sender, comments_llm))
        # A non-mileage issue type that happens to carry a plate still belongs to
        # the general path — the mileage analysis below would be meaningless.
        if issue_type and not is_mileage:
            return _finalize(await self._draft_general(title, description, attachments_text, sender, comments_llm))
        try:
            telemetry = await self.gather_telemetry(parsed.plate, parsed.date, parsed.date_to)
        except Exception:  # pragma: no cover - network errors
            # Telemetry/object lookup failed — fall through to the general path
            # rather than a hard error, so the operator still gets a draft.
            log.exception("gather_telemetry_failed", plate=parsed.plate)
            return _finalize(await self._draft_general(title, description, attachments_text, sender, comments_llm))
        if "object_not_found" in telemetry.flags:
            # Номер из ТЕМЫ мог быть неточным/опечаткой (64655: «Х871НХ» в теме vs
            # «Т871НХ64» в теле — в гео есть второй). Пробуем другие распознанные
            # номера и берём первый, который реально находится в гео.
            alt = await self._resolve_alt_plate(
                parsed.plate, f"{title or ''} {_strip_html(description)} {attachments_text or ''}")
            if alt and alt != parsed.plate:
                parsed.plate = alt
                try:
                    telemetry = await self.gather_telemetry(parsed.plate, parsed.date, parsed.date_to)
                except Exception:  # pragma: no cover
                    log.exception("gather_telemetry_failed", plate=parsed.plate)
                    return _finalize(await self._draft_general(title, description, attachments_text, sender, comments_llm))
            if "object_not_found" in telemetry.flags:
                # Plate parsed but no matching object in Geo: general path can still
                # understand the request and tell the operator what to verify.
                return _finalize(await self._draft_general(title, description, attachments_text, sender, comments_llm))

        # Переоткрытие заявки: если комментарий вводит НОВУЮ дату неисправности
        # (свежее даты тела), анализируем ИМЕННО ЕЁ — дата тела уже была отвечена
        # (64228: решили за 16.06, затем открыли заново «За 24.06 пробег не
        # выгрузился. Прошу возобновить заявку»). Делаем свежую дату ОСНОВНОЙ:
        # переснимаем телеметрию, и весь дальнейший разбор идёт по ней.
        _fresh = _scan_comment_for_new_date(comments, parsed.date)
        if _fresh and _fresh != parsed.date:
            try:
                ct0 = await self.gather_telemetry(parsed.plate, _fresh)
                if "object_not_found" not in ct0.flags:
                    parsed.date = _fresh
                    parsed.date_to = None
                    telemetry = ct0
            except Exception:  # pragma: no cover - best effort
                log.warning("comment_date_reanalyze_failed",
                            plate=parsed.plate, date=_fresh)

        hint = self._heuristic_category(parsed, telemetry)
        # RAG: fetch similar past resolved cases as few-shot examples. The
        # provider is category-aware (hint computed above), so retrieval is
        # targeted. Best-effort: any failure proceeds without examples.
        if examples is None and example_provider is not None:
            try:
                examples = await example_provider(hint, parsed.plate, telemetry.flags)
            except Exception:  # pragma: no cover - best effort, never break automate
                log.warning("example_provider_failed", plate=parsed.plate)
                examples = None
        # IMPROVEMENT 1 (64201): if the fault date shows power-off/no-data AND
        # there are comments (possibly claiming a fix), verify against real data
        # whether anything actually resumed after the fault date. Bounded to one
        # extra daily-stats call; any failure omits the fact (never breaks).
        # Обрыв данных среди дня (64275): данные за дату БЫЛИ, но прекратились рано
        # (последний пакет до 17:00 МСК) и не возобновились до конца суток —
        # признак потери питания/связи в течение рабочего дня.
        midday_stop = bool(
            telemetry.packets
            and telemetry.tail_gap_min and telemetry.tail_gap_min > 240
            and telemetry.last_packet_msk and telemetry.last_packet_msk < "17:00"
        )
        verify_resumed: dict[str, Any] | None = None
        if (telemetry.object_id is not None
                and ("power_off" in telemetry.flags or "no_data" in telemetry.flags or midday_stop)):
            # Запускаем и без комментариев: это вход в детерминированную ветку
            # «нет данных/обрыв за дату → возобновились ли они позже» (алгоритм ниже).
            verify_resumed = await self._verify_data_resumed(
                telemetry.object_id, parsed.date)

        # IMPROVEMENT 2 (63301): if a comment introduces a NEW date+mileage that
        # differs from the body's fault date, gather telemetry for that date too
        # and pass it as a fact so the LLM answers by the freshest comment date.
        comment_date_facts: dict[str, Any] | None = None
        comment_date = _scan_comment_for_new_date(comments, parsed.date)
        if comment_date:
            try:
                ct = await self.gather_telemetry(parsed.plate, comment_date)
                comment_date_facts = {
                    "дата": comment_date,
                    "реальный_пробег_системы_км": ct.system_mileage_km,
                    "пакетов_телеметрии": ct.packets,
                    "признаки": ct.flags,
                    "телепортов_трека": ct.teleport_jumps,
                    "доля_слабого_сигнала": ct.low_sat_ratio,
                    "доля_без_питания": ct.power_off_ratio,
                }
            except Exception:  # pragma: no cover - never break automate
                log.warning("comment_date_telemetry_failed",
                            plate=parsed.plate, date=comment_date)

        llm = await self._draft_with_llm(
            parsed, telemetry, hint,
            attachments_text=attachments_text, sender=sender, examples=examples,
            comments=comments_llm,
            verify_resumed=verify_resumed,
            comment_date_facts=comment_date_facts,
        )
        category = llm.get("category") or hint
        draft = _clean_answer(llm.get("answer") or "")
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
        # «Терминал подключился» при разрыве трека ненадёжен (~27% точности по данным
        # операторов): чаще это глушение. Всегда отправляем на проверку оператором.
        force_review = category == "Терминал подключился"
        return _finalize(AutomationResult(
            parsed=parsed, telemetry=telemetry, category=category,
            confidence=min(confidence, 0.6) if force_review else confidence,
            draft_answer=draft, reasoning=reasoning,
            needs_review=confidence < 0.85 or bool(under_recording) or force_review,
        ))

    async def build_track(self, title: str | None, description: str | None,
                          max_points: int = 2500, attachments_text: str | None = None,
                          plate: str | None = None, fault_date: str | None = None,
                          date_from: str | None = None, date_to: str | None = None) -> dict[str, Any]:
        """Return track points + telemetry series for map/charts rendering.

        Points: {t(ms), lat, lng, speed, sat, pwr}. ``teleports`` are indices i
        where the jump from point i-1 to i is physically impossible (GPS spoofing).
        ``plate``/``fault_date`` override parsing (per-object track из разбора).
        ``date_from``/``date_to`` (YYYY-MM-DD) задают произвольный интервал.
        """
        if plate and fault_date:
            parsed = ParsedIssue(plate=plate, date=fault_date)
        else:
            parsed = self.parse_issue(title, description, None, extra_text=attachments_text)
        if not parsed.plate or not parsed.date:
            return {"error": "no_plate_or_date", "parsed": asdict(parsed), "points": []}
        obj = await self._geo.find_object_by_plate(parsed.plate)
        if not obj:
            return {"error": "object_not_found", "parsed": asdict(parsed), "points": []}
        oid = int(obj["id"])
        # Window: explicit interval (capped 31 days) or the single fault day.
        # Поддержка ВРЕМЕНИ: 'YYYY-MM-DD' → границы суток МСК; 'YYYY-MM-DDTHH:MM'
        # (или с пробелом) → точный момент МСК (интервал трека по времени, 3.4).
        def _bound_ms(s: str, end: bool) -> int:
            if "T" in s or " " in s:
                dt = _dt.datetime.fromisoformat(s.replace(" ", "T"))
                return int(dt.replace(tzinfo=_MSK).timestamp() * 1000)
            d = _dt.date.fromisoformat(s)
            a, b = _msk_day_window_ms(d)
            return b if end else a

        try:
            f_raw = date_from or parsed.date
            t_raw = date_to or f_raw
            from_ms = _bound_ms(f_raw, end=False)
            till_ms = _bound_ms(t_raw, end=True)
        except (ValueError, TypeError):
            from_ms, till_ms = _msk_day_window_ms(_dt.date.fromisoformat(parsed.date))
        if till_ms < from_ms:
            from_ms, till_ms = till_ms, from_ms
        _cap = 31 * 86400 * 1000
        if till_ms - from_ms > _cap:
            till_ms = from_ms + _cap
        range_from = _msk_date_from_ms(from_ms).isoformat()
        range_to = _msk_date_from_ms(max(from_ms, till_ms - 1)).isoformat()
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
        # Current object status (online/offline, last fix time) — best effort.
        status: dict[str, Any] = {}
        try:
            st = await self._geo.get_object_status(oid)
            if st is not None:
                status = {
                    "online": st.online,
                    "last_time": st.time,  # unix seconds of last packet
                    "speed": st.speed,
                    "sat": st.sat,
                }
        except Exception:  # pragma: no cover - best effort
            pass

        return {
            "parsed": asdict(parsed),
            "object_id": oid,
            "object_name": obj.get("name"),
            "imei": obj.get("imei"),
            "phone": obj.get("phone") or obj.get("phone1"),
            "status": status,
            "range_from": range_from,
            "range_to": range_to,
            "total_packets": len(packets),
            "points": points,
            "teleports": [index_map[i] for i in teleports if i in index_map],
        }

    # Hard cap on attachments processed per batch. Without it, issues like
    # ОДКРА «письма» (9+ scanned letter-PDFs) trigger minutes of Tesseract OCR
    # per request — the call never returns and the UI shows «Ошибка разбора».
    _BATCH_MAX_ATTACHMENTS = 25

    async def analyze_batch(self, issue_external_id: int, attachments: list[Any],
                            issue_title: str | None = None,
                            issue_description: str | None = None) -> list[dict[str, Any]]:
        """Per-object analysis of a batch/«общая» issue (one vehicle act per attachment).

        Returns a list of {file, plate, date, sheet_mileage_km, system_mileage_km,
        flags, teleport_jumps, verdict}. Mass issues are usually jamming, but some
        objects have correct data (system ≈ waybill) and need separate handling.

        Degrades gracefully: never raises. When there are no extractable
        attachments, OCR yields nothing, or no plates can be parsed, returns
        ``[]`` (the endpoint surfaces a note) instead of propagating an error.
        """
        from app.services import attachment_reader

        results: list[dict[str, Any]] = []
        try:
            attachments = list(attachments or [])
        except Exception:
            attachments = []
        extractable = [
            a for a in attachments
            if attachment_reader.is_extractable(
                getattr(a, "attachment_file_name", None) or ""
            )
        ]
        # Вложений нет, но в ТЕМЕ/ТЕЛЕ перечислено несколько ТС (Прихоперское ПО,
        # 64455: «…В524ОА…, В191РХ…, А651НМ…»). Раньше такая заявка шла в одиночный
        # automate и анализировался ТОЛЬКО первый номер. Разбираем КАЖДЫЙ номер:
        # дата/пробег берём из общего разбора темы+тела (одна на всех, если своей нет).
        if not extractable:
            # Триггер по ТЕМЕ (как во фронте: countPlates(issue.subject)) — чтобы
            # фронт и бэк согласованно выбирали пакетный путь. Дату/пробег берём
            # из темы+тела ниже (parse_issue).
            plates = extract_all_plates(issue_title or "")
            if len(plates) >= 2:
                # Каждый ТС — СВОЯ дата и свой пробег из нумерованного тела (64455).
                # Если для номера тело не разобралось — общая дата/ПЛ из разбора
                # темы+тела (fallback).
                body_map = {p: (d, s, g) for p, d, s, g in _parse_body_vehicles(issue_description)}
                p0 = self.parse_issue(issue_title, issue_description, None)
                targets_subj = [
                    (plate, *body_map.get(plate, (p0.date, p0.sheet_mileage_km, p0.declared_system_km)))
                    for plate in plates
                ]
                sem0 = asyncio.Semaphore(_BATCH_CONCURRENCY)

                async def _one_subj(plate: str, pdate: str | None, psheet: float | None,
                                    pglonass: float | None) -> dict[str, Any] | None:
                    async with sem0:
                        try:
                            return await self._analyze_object(
                                plate, pdate, psheet, None, "(из текста заявки)",
                                declared=pglonass)
                        except Exception:
                            log.warning("analyze_batch_subject_failed", plate=plate)
                            return None

                chunk0 = await asyncio.gather(
                    *(_one_subj(p, d, s, g) for p, d, s, g in targets_subj))
                return [r for r in chunk0 if r is not None]
        # Bound the OCR work so the request always returns in reasonable time.
        for a in extractable[: self._BATCH_MAX_ATTACHMENTS]:
            name = getattr(a, "attachment_file_name", None) or ""
            try:
                res = await self._okdesk.download_attachment(issue_external_id, a.id)
                text = attachment_reader.extract_text(name, res[0]) if res else ""
            except Exception:
                log.warning("analyze_batch_extract_failed", file=name)
                text = ""
            # Пустые/мусорные вложения (подпись письма image001.jpg → OCR в пару
            # символов) НЕ дают данных, но через title-fallback плодили ложный
            # объект «Нет номера/даты» (64657). Порог 15 символов отсекает шум.
            if not text or len(text.strip()) < 15:
                continue
            try:
                addr_m = re.search(r"по\s+адресу[:\s]+(.{5,120}?)(?:\s+и\s+состав|\s+наход|\.|$)", text, re.I | re.S)
                address = re.sub(r"\s+", " ", addr_m.group(1)).strip() if addr_m else None
                # Имя файла — надёжный источник гос.номера (в нём «…_с255но_КАМАЗ_…»).
                # В тексте год+«Не» давал ложный «2026НЕ».
                filename_plate = self.parse_issue(name, "", None).plate
            except Exception:
                log.warning("analyze_batch_parse_failed", file=name)
                continue

            # Сформировать цели (plate, date, sheet) для анализа.
            # Приоритет веток:
            # 1. Имя файла содержит гос.номер → один ТС, факты из всего текста.
            # 2. Сводное письмо с таблицей «Дата выезда» (63317) → каждый ТС
            #    получает СВОЮ дату из его строки, а не общую первую дату.
            # 3. Мульти-акт PDF (несколько «Акт №») → сегментация по актам (64250).
            # 4. Общая заявка со списком ТС → одна дата/ПЛ на всех.
            # targets: (plate, date, sheet_km(ПЛ от клиента), glonass_km(система от клиента)).
            targets: list[tuple[str, str | None, float | None, float | None]] = []
            base_date: str | None = None
            tl = text.lower()
            # Признак «акта неисправности»: явный маркер ЛИБО сочетание пробега по
            # путевому/одометру и по ГЛОНАСС/ССМ у ТС (свободные акты Ульяновского).
            act_like = (("дата неисправности" in tl and "путево" in tl)
                        or (("одометр" in tl or "путево" in tl)
                            and ("глонас" in tl or "ссм" in tl or "смс" in tl)))
            if filename_plate:
                p = self.parse_issue(name, "", None, extra_text=text)
                base_date = p.date
                targets.append((filename_plate, p.date, p.sheet_mileage_km, p.declared_system_km))
            elif re.search(r"дат[аы]\s+выезда", text, re.I):
                # Сводное письмо-таблица (Саратовские РС, 63317):
                # «Автомобиль, г/н | Дата выезда | Пробег по Глонасс | Пробег по 1С».
                summary_pairs = _parse_summary_table(text)
                for plate, pdate, glonass, sheet in summary_pairs:
                    # targets: (plate, date, sheet=ПЛ/1С, glonass=заявл. система)
                    targets.append((plate, pdate, sheet, glonass))
                if not targets:
                    p = self.parse_issue(name, "", None, extra_text=text)
                    base_date = p.date
                    for plate in extract_all_plates(text):
                        targets.append((plate, p.date, p.sheet_mileage_km, p.declared_system_km))
            elif "пробег тс" in tl:
                # Табличный отчёт «Группировка <дата>» (Ульяновские РС, 64436):
                # строка — гос.номер + «Пробег ТС» (=ПЛ) + «Пробег по ГЛОНАСС» (система).
                p0 = self.parse_issue(name, "", None, extra_text=text)
                for plate, sheet_km, glonass_km in _parse_grouping_table(text):
                    targets.append((plate, p0.date, sheet_km, glonass_km))
                if not targets:
                    base_date = p0.date
                    for plate in extract_all_plates(text):
                        targets.append((plate, p0.date, p0.sheet_mileage_km, p0.declared_system_km))
            elif act_like:
                # Акт(ы) неисправности. Многоактный PDF (Волжское, 64481): один
                # «Акт №» = один ТС. Если же «Акт №» нет, но в документе НЕСКОЛЬКО
                # номеров (Чапаевское «Общая»: один Word — список ТС) — раскладываем
                # по списку (_parse_body_vehicles), иначе потеряли бы всех кроме 1-го.
                rows = _parse_act_blocks(text)
                if len(rows) < 2 and len(extract_all_plates(text)) >= 2:
                    rows = _parse_body_vehicles(text)
                for plate, pdate, psheet, pglonass in rows:
                    targets.append((plate, pdate, psheet, pglonass))
                if not targets:
                    p = self.parse_issue(name, "", None, extra_text=text)
                    base_date = p.date
                    for plate in extract_all_plates(text):
                        targets.append((plate, p.date, p.sheet_mileage_km, p.declared_system_km))
            else:
                acts = _split_acts(text)
                if len(acts) >= 2:
                    for seg in acts:
                        seg_plates = extract_all_plates(seg)
                        if not seg_plates:
                            continue
                        sp = self.parse_issue(name, "", None, extra_text=seg)
                        for plate in seg_plates:
                            targets.append((plate, sp.date, sp.sheet_mileage_km, sp.declared_system_km))
                else:
                    p = self.parse_issue(name, "", None, extra_text=text)
                    base_date = p.date
                    plates = extract_all_plates(text)
                    # Один документ — несколько ТС списком, без «Акт №» и без маркеров
                    # пробега (Чапаевское без явных пробегов): не терять остальные ТС.
                    if len(plates) >= 2:
                        bv = _parse_body_vehicles(text)
                        if len(bv) >= 2:
                            for plate, pdate, psheet, pglonass in bv:
                                targets.append((plate, pdate, psheet, pglonass))
                    # 64290: номер только в ТЕМЕ тикета (forward-письмо), не в PDF.
                    if not plates and issue_title:
                        tp = self.parse_issue(issue_title, "", None).plate
                        if tp:
                            plates = [tp]
                    if not targets:
                        for plate in plates:
                            targets.append((plate, p.date, p.sheet_mileage_km, p.declared_system_km))

            # Дата документа/темы для объектов без своей даты (Чапаевское «Общая»:
            # дата одна в шапке/имени файла/теме, не у каждого ТС в списке) — чтобы
            # анализ телеметрии мог идти, а не упирался в «Нет номера/даты».
            if any(d is None for _, d, _, _ in targets):
                doc_date = (self.parse_issue(name, "", None, extra_text=text).date
                            or (self.parse_issue(issue_title, "", None).date
                                if issue_title else None))
                if doc_date:
                    targets = [(p, d or doc_date, s, g) for p, d, s, g in targets]

            if not targets:
                results.append({
                    "file": name, "plate": None, "date": base_date,
                    "sheet_mileage_km": None, "system_mileage_km": None,
                    "declared_system_km": None,
                    "address": address, "flags": [], "teleport_jumps": 0,
                    "verdict": "Нет номера/даты",
                })
                continue

            # Дедуп по ПАРЕ (номер без региона, дата): один объект может иметь
            # несколько выездов по разным датам (63317/О579СХ) — каждую дату
            # разбираем отдельно; повторы той же пары (мульти-акт PDF, вариант
            # номера с регионом и без — 64513) отсекаем.
            seen_pairs: set[tuple[str, str | None]] = set()
            uniq: list[tuple[str, str | None, float | None, float | None]] = []
            for plate, pdate, psheet, pglonass in targets:
                key = (_plate_dedup_key(plate), pdate)
                if key in seen_pairs:
                    continue
                seen_pairs.add(key)
                uniq.append((plate, pdate, psheet, pglonass))

            # Параллельный разбор с ограничением конкуренции — иначе сотни
            # последовательных запросов телеметрии дают таймаут (63317).
            sem = asyncio.Semaphore(_BATCH_CONCURRENCY)

            async def _one(plate: str, pdate: str | None, psheet: float | None,
                           pglonass: float | None) -> dict[str, Any] | None:
                async with sem:
                    try:
                        return await self._analyze_object(plate, pdate, psheet, address, name,
                                                          declared=pglonass)
                    except Exception:
                        log.warning("analyze_batch_object_failed", file=name, plate=plate)
                        return None

            chunk = await asyncio.gather(*(_one(p, d, s, g) for p, d, s, g in uniq))
            results.extend(r for r in chunk if r is not None)
        # Глобальный дедуп по (номер без региона, дата) ПОВЕРХ всех вложений: один
        # и тот же ТС на одну дату мог прийти в РАЗНЫХ вложениях/актах либо как
        # вариант номера с регионом и без (64513). Строки без номера сохраняем.
        final: list[dict[str, Any]] = []
        seen_final: set[tuple[str, str | None]] = set()
        for r in results:
            plate = r.get("plate")
            if not plate:
                final.append(r)
                continue
            key = (_plate_dedup_key(str(plate)), r.get("date"))
            if key in seen_final:
                continue
            seen_final.add(key)
            final.append(r)
        return final

    async def compose_aggregate_answer(self, objects: list[dict[str, Any]],
                                       company: str | None = None,
                                       prior: dict[str, dict] | None = None) -> str:
        """Compose ONE comprehensive, polite Russian answer for an aggregate
        (ОДКР) issue, grouping objects by verdict. No splitting into children.

        ``prior`` maps a normalized plate -> ``{category, answer, fault_date}``
        for vehicles that already received a resolved answer in a past issue.
        When provided, those prior answers are surfaced to the model so the new
        aggregate response stays consistent with what the client was told before.
        """
        # ДЕТЕРМИНИРОВАННАЯ группировка по фактическому вердикту (включая ручные
        # правки оператора). LLM здесь НЕ используем: он путал, какой ТС в какой
        # группе (64435 — относил машины не в свой вердикт). Группы строим в коде —
        # гарантирует, что гос.номер всегда в группе своего вердикта.
        phrasing = {
            "Данные верны": "сбоев не обнаружено, данные корректны",
            "Терминал подключился": "терминал временно терял связь, данные позже догрузились, пробег сошёлся",
            "Глушение": "в указанный период фиксировалось воздействие средств подавления GPS-сигнала (глушение), из-за чего данные трека искажены/занижены",
            "Не было питания": "отсутствовало питание терминала в указанную дату (трек за период отсутствует)",
            "Проверить": "требуется дополнительная проверка",
            "Нет данных": "данные отсутствуют — требуется удалённая проверка силами нашей техподдержки",
            "Объект не найден": "объект не найден в системе мониторинга",
        }
        order = list(phrasing.keys())
        groups: dict[str, list[str]] = {}
        for o in objects:
            plate = o.get("plate")
            verdict = o.get("verdict")
            if not plate or verdict not in phrasing:
                continue  # «Нет номера/даты» и т.п. в сводку не включаем
            groups.setdefault(verdict, [])
            if plate not in groups[verdict]:
                groups[verdict].append(plate)
        if not groups:
            return ""
        # Без служебных ярлыков («Глушение:» и т.п. — это для специалистов): клиенту
        # отдаём связные фразы по группам. Группировка по вердикту — детерминированная.
        lines = ["Здравствуйте! По результатам сверки:"]
        for verdict in order:
            plates = groups.get(verdict)
            if plates:
                lines.append(f"По ТС {', '.join(plates)} {phrasing[verdict]}.")
        return "\n".join(lines)

    async def _analyze_object(self, plate: str, date: str | None, sheet: float | None,
                              address: str | None, file: str,
                              declared: float | None = None) -> dict[str, Any]:
        item: dict[str, Any] = {
            "file": file, "plate": plate, "date": date,
            # sheet — пробег по путевому листу (ПЛ) от клиента; declared — пробег по
            # системе ГЛОНАСС со слов клиента (то, что он видит в ПК); system — РЕАЛЬНЫЙ
            # пробег из телеметрии geo.gpspos.ru (ниже).
            "sheet_mileage_km": sheet, "declared_system_km": declared,
            "system_mileage_km": None,
            "address": address, "flags": [], "teleport_jumps": 0,
            "spec_vehicle": _is_special_vehicle(plate, file),
            "verdict": "Нет номера/даты",
        }
        if plate and date:
            try:
                t = await self.gather_telemetry(plate, date)
                item["system_mileage_km"] = t.system_mileage_km
                item["flags"] = t.flags
                item["teleport_jumps"] = t.teleport_jumps
                system = t.system_mileage_km
                # Order matters: jamming/power-off take precedence over a mileage
                # match (spoofing makes the track unreliable even if mileage coincides).
                if "object_not_found" in t.flags:
                    item["verdict"] = "Объект не найден"
                elif "no_data" in t.flags:
                    item["verdict"] = "Нет данных"
                elif "power_off" in t.flags:
                    item["verdict"] = "Не было питания"
                elif item["spec_vehicle"]:
                    # Спецтехника: км-вердикт (Глушение/Данные верны) ненадёжен —
                    # данные есть, оценивать по факту работы/моточасам вручную.
                    item["verdict"] = "Проверить"
                elif "jamming" in t.flags:
                    item["verdict"] = "Глушение"
                elif sheet and system is not None and abs(sheet - system) <= max(5.0, sheet * 0.1):
                    item["verdict"] = "Данные верны"
                else:
                    item["verdict"] = "Проверить"
            except Exception:
                item["verdict"] = "Ошибка данных"
        return item

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
            telemetry = await self.gather_telemetry(parsed.plate, parsed.date, parsed.date_to)
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
            "needs_remote_diagnostics": r.needs_remote_diagnostics,
            "spec_vehicle": r.spec_vehicle,
        }
