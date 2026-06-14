"""Extract plain text from issue attachments (PDF / Word / Excel / text).

Lets the AI read attachment content without spending tokens on raw binaries.
Pure-python parsers (pypdf, python-docx, openpyxl); image OCR is intentionally
out of scope for now (would need tesseract) — flagged via `extractable`.
"""

from __future__ import annotations

import csv
import io
from typing import Any

import structlog

log = structlog.get_logger(__name__)

# Cap extracted text so a huge spreadsheet/PDF can't blow up the LLM prompt.
_MAX_CHARS = 8000

_TEXT_EXTS = {".txt", ".csv", ".log"}
_PDF_EXTS = {".pdf"}
_DOCX_EXTS = {".docx"}
_XLSX_EXTS = {".xlsx", ".xlsm"}
_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".bmp", ".tif", ".tiff"}


def _ext(filename: str) -> str:
    i = filename.rfind(".")
    return filename[i:].lower() if i >= 0 else ""


def is_extractable(filename: str) -> bool:
    e = _ext(filename)
    return e in _TEXT_EXTS | _PDF_EXTS | _DOCX_EXTS | _XLSX_EXTS


def kind(filename: str) -> str:
    e = _ext(filename)
    if e in _PDF_EXTS:
        return "pdf"
    if e in _DOCX_EXTS:
        return "word"
    if e in _XLSX_EXTS:
        return "excel"
    if e in _IMAGE_EXTS:
        return "image"
    if e in _TEXT_EXTS:
        return "text"
    return "other"


def _truncate(text: str) -> str:
    text = text.strip()
    if len(text) > _MAX_CHARS:
        return text[:_MAX_CHARS] + "\n…[текст обрезан]"
    return text


def extract_text(filename: str, data: bytes) -> str:
    """Return extracted text, or '' if not extractable / on parse error."""
    e = _ext(filename)
    try:
        if e in _PDF_EXTS:
            return _truncate(_pdf(data))
        if e in _DOCX_EXTS:
            return _truncate(_docx(data))
        if e in _XLSX_EXTS:
            return _truncate(_xlsx(data))
        if e in _TEXT_EXTS:
            return _truncate(_plain(data))
    except Exception:  # pragma: no cover - never break the caller
        log.warning("attachment_extract_failed", filename=filename)
    return ""


def _cyrillic_ratio(s: str) -> float:
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return 0.0
    cyr = sum(1 for c in letters if "а" <= c.lower() <= "я" or c.lower() == "ё")
    return cyr / len(letters)


def _pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    parts = []
    for page in reader.pages:
        t = page.extract_text() or ""
        if t.strip():
            parts.append(t)
    text = "\n".join(parts)
    # Scanned PDFs (no text layer) come back empty; some have broken font
    # encodings that decode to Latin mojibake. Our domain is Russian docs —
    # if there's almost no Cyrillic, the text layer is unreliable: drop it
    # rather than feed garbage to the AI. (Such files need OCR — future work.)
    if len(text) > 40 and _cyrillic_ratio(text) < 0.15:
        return ""
    return text


def _docx(data: bytes) -> str:
    from docx import Document

    doc = Document(io.BytesIO(data))
    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))
    return "\n".join(parts)


def _xlsx(data: bytes) -> str:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    parts: list[str] = []
    for ws in wb.worksheets:
        parts.append(f"# Лист: {ws.title}")
        for row in ws.iter_rows(values_only=True):
            vals = [str(c) for c in row if c is not None]
            if vals:
                parts.append(" | ".join(vals))
    return "\n".join(parts)


def _plain(data: bytes) -> str:
    for enc in ("utf-8", "cp1251", "latin1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")
