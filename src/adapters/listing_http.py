"""Bounded, polite HTTP for the multi-request ATS listing adapters.

Greenhouse/Lever/Ashby answer a whole board in one GET. SmartRecruiters,
Oracle Recruiting Cloud, Eightfold, IBM and Jibe page their search results, so
one board costs several requests. These helpers keep that cheap and polite:

- every request after the first waits REQUEST_DELAY seconds (sequential, never
  concurrent; one board's pages run back to back on the same host);
- a 429 is retried up to RATE_LIMIT_RETRIES times, honouring Retry-After
  (else 5s, 10s, 20s); a 5xx gets one retry; every wait counts against the
  board's BOARD_BUDGET seconds. Then the error propagates so the per-board
  try/except in ats_boards.fetch skips just that board;
- a listing is all or nothing: page_through returns only a COMPLETE paged
  query and raises IncompleteListing on a short page, repeated rows that
  leave the distinct count under the total, the page cap or the time
  budget, so a board never hands first-sight seeding a partial backlog. A
  board past 75% of its page cap logs a warning first;
- callers cap their own page count (MAX_PAGES unless a board row overrides
  it), so a misbehaving feed can never loop.

`sleep` and `monotonic` are module-level so tests can patch them out.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

REQUEST_DELAY = 1.0   # seconds between requests to one board
RETRY_DELAY = 5.0     # first backoff; doubles per 429 retry
RATE_LIMIT_RETRIES = 3
RETRY_AFTER_MAX = 60.0  # cap on an honoured Retry-After
BOARD_BUDGET = 300.0  # seconds of waiting (pacing + backoff) per board
TIMEOUT = 30.0
MAX_PAGES = 5         # default per-query page cap
PAGE_CAP_CEILING = 100  # hard ceiling on any max_pages override
CAP_WARN_FRACTION = 0.75

sleep = time.sleep
monotonic = time.monotonic
log = logging.getLogger(__name__)

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
    """One board's request pacing and time budget. Sleeps `delay` (default
    REQUEST_DELAY; a host's robots.txt crawl-delay when longer) before every
    request except the first; `pause` sleeps for a backoff. Any wait that
    would push the board past BOARD_BUDGET seconds raises IncompleteListing
    instead, so one slow or rate-limited board cannot stall the run."""

    def __init__(self, delay: float = REQUEST_DELAY,
                 budget: float = BOARD_BUDGET) -> None:
        self._first = True
        self._delay = max(delay, REQUEST_DELAY)
        self._budget = budget
        self._start: float | None = None

    def pause(self, seconds: float) -> None:
        if self._start is None:
            self._start = monotonic()
        if monotonic() - self._start + seconds > self._budget:
            raise IncompleteListing(
                f"board time budget ({self._budget:.0f}s) exhausted")
        sleep(seconds)
        self._first = True          # the backoff already spaced the retry

    def wait(self) -> None:
        if not self._first:
            self.pause(self._delay)
        elif self._start is None:
            self._start = monotonic()
        self._first = False


def _retry_after(resp: httpx.Response, attempt: int) -> float:
    """Seconds to wait before retry number `attempt` (1-based) of a 429:
    the server's Retry-After -- delta-seconds or an HTTP-date -- capped at
    RETRY_AFTER_MAX, else exponential backoff from RETRY_DELAY."""
    value = (resp.headers.get("Retry-After") or "").strip()
    if value.isdigit():
        return min(float(value), RETRY_AFTER_MAX)
    if value:
        try:
            when = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            when = None
        if when is not None:
            if when.tzinfo is None:
                when = when.replace(tzinfo=dt.UTC)
            delta = (when - dt.datetime.now(dt.UTC)).total_seconds()
            return min(max(delta, 0.0), RETRY_AFTER_MAX)
    return RETRY_DELAY * 2 ** (attempt - 1)


def request_text(client: httpx.Client, pacer: Pacer, url: str, *,
                 body: Any = None) -> str:
    """GET (or POST `body` as JSON) and return the response text."""
    rate_limited = 0
    server_errors = 0
    while True:
        pacer.wait()
        if body is None:
            resp = client.get(url, timeout=TIMEOUT, follow_redirects=True)
        else:
            resp = client.post(url, content=json.dumps(body), timeout=TIMEOUT,
                               headers={"Content-Type": "application/json"})
        if resp.status_code == 429 and rate_limited < RATE_LIMIT_RETRIES:
            rate_limited += 1
            wait = _retry_after(resp, rate_limited)
            log.info("429 from %s; retry %d/%d in %.0fs", resp.url.host,
                     rate_limited, RATE_LIMIT_RETRIES, wait)
            pacer.pause(wait)
            continue
        if resp.status_code >= 500 and server_errors < 1:
            server_errors += 1
            pacer.pause(RETRY_DELAY)
            continue
        resp.raise_for_status()
        return resp.text


class IncompleteListing(RuntimeError):
    """A board's listing could not be read to the end this run: a short or
    empty page before the stated total, or the page cap. The board fails
    for the run (no rows): first-sight seeding (src/seeding.py) records a
    board as known once it returns rows, so a partial first answer would be
    seeded as the whole backlog and the unread rest delivered later as news."""


@dataclass
class Listing:
    """One paged query: its raw pages, the distinct row ids read and the
    feed's stated total (0 when it gives none)."""

    pages: list[str]
    ids: set[str]
    total: int


def page_through(fetch: Callable[[int], tuple[str, list[str], int]], *,
                 page_size: int, cap: int, what: str, start: int = 0,
                 unique: bool = True, slack: int = 0) -> Listing:
    """One COMPLETE paged query, or IncompleteListing.

    fetch(offset) returns (raw page, the page's row ids, the stated total --
    0 when the feed gives none). Complete means: the rows read reach the
    stated total, or (no total) a page shorter than page_size arrives. A
    short page before a stated total, or `cap` pages without finishing,
    raises. With `unique` (the default) rows are counted by distinct id: a
    feed that repeats rows across pages while dropping others (unstable
    order among ties) reaches its total in rows but not in postings, and
    raises too. A caller that can recover the missing rows (Eightfold: a
    second, shifted pass) passes unique=False and checks the union itself.
    `slack` lets a feed whose stated total counts rows it never lists
    (Oracle: BNY states 594 and lists 593 under every sort) finish up to
    that many rows short -- only after it stopped on a short page, and only
    when both the rows read and the distinct ids are within `slack`. A
    relevancy-sorted page with no intern title is NOT the end: on a live
    Oracle board an intern title followed such a page."""
    pages: list[str] = []
    ids: set[str] = set()
    seen = start
    total = 0
    for n in range(cap):
        raw, row_ids, total = fetch(seen)
        pages.append(raw)
        ids.update(i for i in row_ids if i)    # a row with no id is no posting
        seen += len(row_ids)
        # Keep paging while pages are full: slack only applies once the feed
        # has actually stopped (a short page), never to cut a full page off.
        done = bool(total and seen >= total)
        if not done and len(row_ids) < page_size:
            if total and total - seen > slack:
                raise IncompleteListing(
                    f"{what}: short page ({len(row_ids)} rows) at {seen} of "
                    f"{total}")
            done = True
        if done:
            if n + 1 > cap * CAP_WARN_FRACTION:
                log.warning("%s: used %d of %d pages; raise max_pages on its "
                            "ats_boards.yaml row before it fails", what, n + 1,
                            cap)
            if unique and start == 0 and total and len(ids) < total - slack:
                raise IncompleteListing(
                    f"{what}: {len(ids)} distinct rows of {total} (the feed "
                    "repeated rows across pages)")
            return Listing(pages, ids, total)
    raise IncompleteListing(
        f"{what}: page cap {cap} reached at {seen} of {total or '?'} rows "
        "(raise max_pages on its ats_boards.yaml row)")


def page_cap(board: dict, default: int = MAX_PAGES) -> int:
    """Per-board override (`max_pages:` in ats_boards.yaml), else `default`."""
    try:
        return min(PAGE_CAP_CEILING,
                   max(1, int(board.get("max_pages") or default)))
    except (TypeError, ValueError):
        return default


def iso_date(value: str | None) -> dt.date | None:
    """Leading YYYY-MM-DD of a date or timestamp string, else None."""
    try:
        return dt.date.fromisoformat((value or "")[:10])
    except ValueError:
        return None
