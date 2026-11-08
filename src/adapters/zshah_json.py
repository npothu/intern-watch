"""Adapter for the zshah101 automated internship list's public JSON API.

The repo publishes `docs/api/jobs.json` next to its README: one object with a
`jobs` array of OPEN postings only (closed rows are dropped upstream), each
carrying the employer's own ATS URL (Workday, Oracle CX, SmartRecruiters,
Greenhouse, ...), so dedup keys and url_index canons join the ones the other
sources already produce. The README table is a truncated render of the same
data; the JSON is the full list.

Per row: `season` is "Summer 2027" / "Fall 2026" / ... or "Not stated";
`season_inferred` marks a season the upstream guessed rather than read from
the posting. `seasons` (list or null) carries multi-term rows.
"""

from __future__ import annotations

import datetime as dt
import json
import logging

from ..models import Job, TermConfidence
from ..normalize import infer_terms, split_locations, strip_tracking
from .base import Adapter

log = logging.getLogger(__name__)

_NO_SEASON = {"", "not stated", "n/a", "unknown"}


def _date(value: str | None) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value).date()
    except ValueError:
        return None


def _terms(entry: dict, title: str, today: dt.date) -> tuple[list[str], TermConfidence]:
    raw = entry.get("seasons") or [entry.get("season")]
    terms = [s.strip() for s in raw
             if isinstance(s, str) and s.strip().casefold() not in _NO_SEASON]
    if terms:
        return terms, "inferred" if entry.get("season_inferred") else "explicit"
    return infer_terms(title, today)


class ZshahJsonAdapter(Adapter):
    def parse(self, raw: str, path: str, today: dt.date) -> list[Job]:
        jobs: list[Job] = []
        for entry in json.loads(raw).get("jobs") or []:
            try:
                if entry.get("is_open") is False:
                    continue
                title = (entry.get("title") or "").strip()
                company = (entry.get("company") or "").strip()
                url = strip_tracking(entry.get("url") or "")
                if not title or not company or not url:
                    continue
                terms, confidence = _terms(entry, title, today)
                jobs.append(Job(
                    company=company,
                    title=title,
                    locations=split_locations(entry.get("location") or ""),
                    terms=terms,
                    term_confidence=confidence,
                    url=url,
                    work_model="Remote" if entry.get("remote") else None,
                    salary=entry.get("salary") or None,
                    date_posted=_date(entry.get("posted_at")),
                    source=self.cfg.name,
                ))
            except Exception as exc:  # noqa: BLE001 - one bad entry never kills the source
                log.warning("zshah: skipping malformed entry: %s", exc)
        return jobs
