"""Bounded, polite HTTP for the multi-request ATS listing adapters.

Greenhouse/Lever/Ashby answer a whole board in one GET. SmartRecruiters,
Oracle Recruiting Cloud, Eightfold, IBM and Jibe page their search results, so
one board costs several requests. These helpers keep that cheap and polite:

- every request after the first waits REQUEST_DELAY seconds (sequential, never
  concurrent; one board's pages run back to back on the same host);
- a 429 or 5xx gets ONE retry after RETRY_DELAY, then the error propagates so
  the per-board try/except in ats_boards.fetch skips just that board;
- a missing total-count field never ends paging early (only an empty
  page, the intern stop rule or the cap do);
- callers cap their own page count (MAX_PAGES unless a board row overrides
  it), so a misbehaving feed can never loop.

`sleep` is module-level so tests can patch it out.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import time
from typing import Any

import httpx

REQUEST_DELAY = 1.0   # seconds between requests to one board
RETRY_DELAY = 5.0     # backoff before the single 429/5xx retry
TIMEOUT = 30.0
MAX_PAGES = 5         # default per-query page cap

sleep = time.sleep

# Title-level internship test shared by every board parser (and the listers'
# relevancy-paging stop rule). Word-bounded: "Internal Audit" is not a hit.
INTERN_RE = re.compile(r"\bintern(ship)?s?\b|\bco-?op\b", re.I)

# Feeds that end a location in an ISO country code ("Redmond, WA, US",
# "Markham, ON, CA", "Bengaluru, KA, IN") misread downstream: ", CA" reads as
# California and ", IN" as Indiana in filters.location_country. Known codes
# are spelled out; an unmapped code is left as is (unknown locations are
# kept, never wrongly eliminated).
_COUNTRIES = {
    "US": "United States", "CA": "Canada", "GB": "United Kingdom",
    "IN": "India", "DE": "Germany", "FR": "France", "IE": "Ireland",
    "JP": "Japan", "CN": "China", "SG": "Singapore", "PH": "Philippines",
    "TH": "Thailand", "HU": "Hungary", "AE": "United Arab Emirates",
    "BR": "Brazil", "MX": "Mexico", "PL": "Poland", "CZ": "Czech Republic",
    "IL": "Israel", "AU": "Australia", "NL": "Netherlands", "ES": "Spain",
    "IT": "Italy", "KR": "South Korea", "RO": "Romania", "EG": "Egypt",
    "CR": "Costa Rica", "AR": "Argentina", "CO": "Colombia",
    "MY": "Malaysia", "VN": "Vietnam", "ZA": "South Africa",
    "PT": "Portugal", "AT": "Austria", "CH": "Switzerland", "SE": "Sweden",
    "DK": "Denmark", "FI": "Finland", "NO": "Norway", "BE": "Belgium",
    "TW": "Taiwan", "ID": "Indonesia", "NZ": "New Zealand",
    "TR": "Turkey", "SA": "Saudi Arabia", "CL": "Chile", "HK": "Hong Kong",
}


def spell_country(raw: str, *, min_parts: int = 3) -> str:
    """Spell out a trailing ISO country code. Only a location with at least
    `min_parts` comma parts is touched: in "San Jose, CA" the last part is a
    state, not Canada. A feed whose last part is always a country (IBM's
    "CITY, CC") passes min_parts=2."""
    if (raw or "").count(",") + 1 < min_parts:
        return raw or ""
    head, sep, code = (raw or "").rpartition(",")
    name = _COUNTRIES.get(code.strip().upper()) if sep else None
    if name is None:
        return raw or ""
    return f"{head.strip()}, {name}" if head.strip() else name


class Pacer:
    """Sleeps REQUEST_DELAY before every request except the first."""

    def __init__(self) -> None:
        self._first = True

    def wait(self) -> None:
        if not self._first:
            sleep(REQUEST_DELAY)
        self._first = False


def request_text(client: httpx.Client, pacer: Pacer, url: str, *,
                 body: Any = None) -> str:
    """GET (or POST `body` as JSON) and return the response text."""
    for attempt in (1, 2):
        pacer.wait()
        if body is None:
            resp = client.get(url, timeout=TIMEOUT, follow_redirects=True)
        else:
            resp = client.post(url, content=json.dumps(body), timeout=TIMEOUT,
                               headers={"Content-Type": "application/json"})
        if attempt == 1 and (resp.status_code == 429
                             or resp.status_code >= 500):
            sleep(RETRY_DELAY)
            continue
        resp.raise_for_status()
        return resp.text
    raise AssertionError("unreachable")  # pragma: no cover


def page_cap(board: dict, default: int = MAX_PAGES) -> int:
    """Per-board override (`max_pages:` in ats_boards.yaml), else `default`."""
    try:
        return max(1, int(board.get("max_pages") or default))
    except (TypeError, ValueError):
        return default


def iso_date(value: str | None) -> dt.date | None:
    """Leading YYYY-MM-DD of a date or timestamp string, else None."""
    try:
        return dt.date.fromisoformat((value or "")[:10])
    except ValueError:
        return None
