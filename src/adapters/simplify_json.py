"""Adapter for SimplifyJobs listings.json (single file, all terms)."""

from __future__ import annotations

import datetime as dt
import json
import logging

from ..models import Job
from ..normalize import infer_terms, split_locations, strip_tracking
from .base import Adapter

log = logging.getLogger(__name__)


class SimplifyJsonAdapter(Adapter):
    def parse(self, raw: str, path: str, today: dt.date) -> list[Job]:
        listings = json.loads(raw)
        jobs: list[Job] = []
        for entry in listings:
            try:
                if not (entry.get("active") and entry.get("is_visible")):
                    continue
                terms = [t for t in entry.get("terms") or [] if t and t != "N/A"]
                title = (entry.get("title") or "").strip()
                if terms:
                    confidence = "explicit"
                else:
                    terms, confidence = infer_terms(title, today)
                date_posted = None
                if entry.get("date_posted"):
                    date_posted = dt.datetime.fromtimestamp(
                        entry["date_posted"], tz=dt.timezone.utc).date()
                locations: list[str] = []
                for loc in entry.get("locations") or []:
                    locations.extend(split_locations(loc))
                url = strip_tracking(entry.get("url") or "")
                if not url or not title or not entry.get("company_name"):
                    continue
                jobs.append(Job(
                    company=entry["company_name"].strip(),
                    title=title,
                    locations=locations,
                    terms=terms,
                    term_confidence=confidence,
                    url=url,
                    date_posted=date_posted,
                    degrees=[d for d in entry.get("degrees") or [] if d],
                    source=self.cfg.name,
                ))
            except Exception as exc:  # noqa: BLE001 - one bad entry never kills the source
                log.warning("simplify: skipping malformed entry: %s", exc)
        return jobs
