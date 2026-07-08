"""Adapter for the three jobright-ai README repos (SWE / Engineer / PM).

Table appears after an HTML comment containing 'TABLE_START'. Columns:
| Company | Job Title | Location | Work Model | Date Posted |
Title links to jobright.ai/jobs/info/{24-hex} -- that id is canonical.
"""

from __future__ import annotations

import datetime as dt
import logging

from ..models import Job
from ..normalize import (extract_jobright_id, infer_terms, parse_month_day,
                         split_locations, strip_tracking)
from .base import Adapter
from .md_utils import is_separator_row, md_link, plain_text, split_row

log = logging.getLogger(__name__)

_WORK_MODELS = {"on site": "On Site", "onsite": "On Site",
                "hybrid": "Hybrid", "remote": "Remote"}


class JobrightMdAdapter(Adapter):
    def parse(self, raw: str, path: str, today: dt.date) -> list[Job]:
        lines = raw.splitlines()
        start = None
        for i, line in enumerate(lines):
            if "TABLE_START" in line:
                start = i + 1
                break
        if start is None:
            raise RuntimeError(f"{self.cfg.name}: TABLE_START marker not found")

        jobs: list[Job] = []
        prev_company = ""
        for line in lines[start:]:
            line = line.strip()
            if not line:
                continue
            if not line.startswith("|"):
                break  # table ended
            cells = split_row(line)
            if len(cells) < 5 or is_separator_row(cells):
                continue
            if cells[0].lower() == "company":  # header row
                continue
            try:
                company, _ = md_link(cells[0])
                if company in ("↳", ""):       # continuation: company from row above
                    company = prev_company
                title, title_url = md_link(cells[1])
                if not company or not title or not title_url:
                    continue
                prev_company = company
                jr_id = extract_jobright_id(title_url)
                terms, confidence = infer_terms(title, today)
                work_model = _WORK_MODELS.get(plain_text(cells[3]).casefold())
                jobs.append(Job(
                    company=company,
                    title=title,
                    locations=split_locations(plain_text(cells[2])),
                    terms=terms,
                    term_confidence=confidence,
                    url=strip_tracking(title_url),
                    jobright_id=jr_id,
                    work_model=work_model,
                    date_posted=parse_month_day(plain_text(cells[4]), today),
                    source=self.cfg.name,
                ))
            except Exception as exc:  # noqa: BLE001
                log.warning("%s: skipping malformed row: %s", self.cfg.name, exc)
        return jobs
