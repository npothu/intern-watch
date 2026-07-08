"""Adapter for vanshb03/Summer2027-Internships (README + OFFSEASON_README).

Columns: | Company | Role | Location | Application/Link | Date Posted |
Apply link is an HTML <a href="..."><img/></a> button whose href often carries
jr_id={24-hex} (same id space as the jobright repos -- used for dedup).
'↳' in the Company cell means "same company as the row above".
"""

from __future__ import annotations

import datetime as dt
import logging

from ..models import Job
from ..normalize import (extract_jobright_id, infer_terms, parse_month_day,
                         split_locations, strip_tracking)
from .base import Adapter
from .md_utils import html_anchor, iter_tables, md_link, plain_text

log = logging.getLogger(__name__)


class Vanshb03MdAdapter(Adapter):
    def parse(self, raw: str, path: str, today: dt.date) -> list[Job]:
        default_terms = self.cfg.default_terms.get(path, [])
        jobs: list[Job] = []
        for header, rows in iter_tables(raw.splitlines()):
            header_norm = [plain_text(h).casefold() for h in header]
            if "company" not in header_norm or "role" not in header_norm:
                continue
            idx = {name: header_norm.index(name)
                   for name in ("company", "role", "location", "date posted")
                   if name in header_norm}
            link_idx = next((i for i, h in enumerate(header_norm)
                             if "link" in h or "application" in h), None)
            prev_company = ""
            for cells in rows:
                if len(cells) < len(header_norm):
                    continue
                try:
                    company_cell = cells[idx["company"]]
                    company, _ = md_link(company_cell)
                    if company in ("↳", ""):
                        company = prev_company
                    if not company:
                        continue
                    prev_company = company
                    title = plain_text(cells[idx["role"]])
                    apply_url = None
                    if link_idx is not None:
                        _, apply_url = html_anchor(cells[link_idx])
                        if apply_url is None:
                            _, apply_url = md_link(cells[link_idx])
                    if not title or not apply_url:
                        continue
                    jr_id = extract_jobright_id(apply_url)
                    terms, confidence = infer_terms(title, today)
                    if not terms and default_terms:
                        terms, confidence = list(default_terms), "inferred"
                    date_posted = None
                    if "date posted" in idx:
                        date_posted = parse_month_day(
                            plain_text(cells[idx["date posted"]]), today)
                    jobs.append(Job(
                        company=company,
                        title=title,
                        locations=split_locations(plain_text(cells[idx["location"]]))
                        if "location" in idx else [],
                        terms=terms,
                        term_confidence=confidence,
                        url=strip_tracking(apply_url),
                        jobright_id=jr_id,
                        date_posted=date_posted,
                        source=self.cfg.name,
                    ))
                except Exception as exc:  # noqa: BLE001
                    log.warning("%s: skipping malformed row: %s", self.cfg.name, exc)
        return jobs
