"""Adapter for speedyapply/2026-SWE-College-Jobs.

Multiple table sections (FAANG+ / Quant / Other) with header variants:
| Company | Position | Location | Salary | Posting | Age |   (Salary optional)
Columns are mapped by header name, never by position. Age is relative
('2d', '3w') and converted to a date at parse time.
"""

from __future__ import annotations

import datetime as dt
import logging
import re

from ..models import Job
from ..normalize import infer_terms, split_locations, strip_tracking
from .base import Adapter
from .md_utils import html_anchor, iter_tables, plain_text

log = logging.getLogger(__name__)

_AGE_RE = re.compile(r"(\d+)\s*(h|d|w|mo|m)\b", re.I)
_AGE_DAYS = {"h": 0, "d": 1, "w": 7, "mo": 30, "m": 30}


def parse_age(text: str, today: dt.date) -> dt.date | None:
    m = _AGE_RE.search(text or "")
    if not m:
        return None
    return today - dt.timedelta(days=int(m.group(1)) * _AGE_DAYS[m.group(2).lower()])


class SpeedyApplyMdAdapter(Adapter):
    def parse(self, raw: str, path: str, today: dt.date) -> list[Job]:
        jobs: list[Job] = []
        for header, rows in iter_tables(raw.splitlines()):
            header_norm = [plain_text(h).casefold() for h in header]
            if "company" not in header_norm or "position" not in header_norm:
                continue
            col = {name: header_norm.index(name) for name in header_norm}
            for cells in rows:
                if len(cells) < len(header_norm):
                    continue
                try:
                    company, _ = html_anchor(cells[col["company"]])
                    title = plain_text(cells[col["position"]])
                    _, apply_url = html_anchor(cells[col["posting"]]) \
                        if "posting" in col else (None, None)
                    if not company or not title or not apply_url:
                        continue
                    salary = plain_text(cells[col["salary"]]) if "salary" in col else None
                    terms, confidence = infer_terms(title, today)
                    date_posted = parse_age(cells[col["age"]], today) \
                        if "age" in col else None
                    jobs.append(Job(
                        company=company,
                        title=title,
                        locations=split_locations(plain_text(cells[col["location"]]))
                        if "location" in col else [],
                        terms=terms,
                        term_confidence=confidence,
                        url=strip_tracking(apply_url),
                        salary=salary or None,
                        date_posted=date_posted,
                        source=self.cfg.name,
                    ))
                except Exception as exc:  # noqa: BLE001
                    log.warning("speedyapply: skipping malformed row: %s", exc)
        return jobs
