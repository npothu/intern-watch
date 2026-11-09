"""Eightfold career-site listing for ats_boards.

Eightfold "PCS" career sites (<tenant>.eightfold.ai, or an employer domain
such as apply.careers.microsoft.com) render from a public JSON search the
page itself calls; robots.txt on those hosts explicitly allows /api/pcsx:

  search: /api/pcsx/search?domain=<domain>&query=<q>&start=<n>
  detail: /api/pcsx/position_details?position_id=<id>&domain=<domain>&hl=en

`domain` is the tenant's company domain (microsoft.com, micron.com); a
missing or wrong one is a 422. A board row's slug is "<host>/<domain>".
Pages are fixed at 10 rows. A query is read to `count` (listing_http.
page_through); a short page before it, or the page cap (default
DEFAULT_PAGES -- the small pages need more of them), fails the board.
"""

from __future__ import annotations

import datetime as dt
import json
from urllib.parse import quote

import httpx

from ..normalize import strip_html
from .listing_http import (
    IncompleteListing,
    Pacer,
    page_cap,
    page_through,
    request_text,
    spell_country,
)

QUERIES = ("intern", "co-op")
DEFAULT_PAGES = 30
PAGE_SIZE = 10        # fixed by the API (a num= parameter is ignored)
# sort_by=timestamp: the default relevance order repeats rows across
# non-adjacent pages (Micron: 163 rows, 155 distinct).
SEARCH_URL = ("https://{host}/api/pcsx/search?domain={domain}&query={query}"
              "&start={start}&sort_by=timestamp")
DETAIL_URL = ("https://{host}/api/pcsx/position_details?position_id={pid}"
              "&domain={domain}&hl=en")
POSTING_URL = "https://{host}/careers/job/{pid}"


def split_slug(slug: str) -> tuple[str, str]:
    host, _, domain = slug.partition("/")
    if not host or not domain:
        raise ValueError(f"eightfold slug must be '<host>/<domain>', got {slug!r}")
    return host, domain


def _positions(data: dict) -> list[dict]:
    return ((data.get("data") or {}).get("positions")) or []


def fetch_pages(client: httpx.Client, board: dict) -> list[str]:
    host, domain = split_slug(board["slug"])
    cap = page_cap(board, DEFAULT_PAGES)
    pacer = Pacer()
    pages: list[str] = []
    for query in QUERIES:
        def fetch(start: int, query: str = query) -> tuple[str, list[str], int]:
            raw = request_text(client, pacer, SEARCH_URL.format(
                host=host, domain=quote(domain), query=quote(query),
                start=start))
            data = json.loads(raw)
            total = int((data.get("data") or {}).get("count") or 0)
            return (raw, ["" if p.get("id") is None else str(p["id"])
                         for p in _positions(data)],
                    total)
        what = f"eightfold/{board['slug']} q={query}"
        first = page_through(fetch, page_size=PAGE_SIZE, cap=cap, what=what,
                             unique=False)
        pages += first.pages
        if first.total and len(first.ids) < first.total:
            # Rows posted the same day tie on the timestamp and their order
            # is unstable across pages: some repeat, others never show. A
            # second pass shifted by half a page reads them (Micron: 158 +
            # shifted pass = all 163).
            second = page_through(fetch, page_size=PAGE_SIZE, cap=cap,
                                  what=f"{what} (shifted)",
                                  start=PAGE_SIZE // 2, unique=False)
            pages += second.pages
            found = len(first.ids | second.ids)
            if found < max(first.total, second.total):
                raise IncompleteListing(
                    f"{what}: {found} distinct rows of {first.total} after a "
                    "shifted second pass")
    return pages


def rows(data: dict, slug: str) -> list[tuple]:
    """(title, url, location, date_posted, description, jd_url) per position."""
    host, domain = split_slug(slug)
    out = []
    for p in _positions(data):
        pid = str(p.get("id") or "").strip()
        if not pid.isdigit():
            continue
        locs = p.get("standardizedLocations") or p.get("locations") or []
        ts = p.get("postedTs")
        posted = (dt.datetime.fromtimestamp(ts, tz=dt.UTC).date()
                  if isinstance(ts, int | float) and ts > 0 else None)
        out.append((
            p.get("name"),
            POSTING_URL.format(host=host, pid=pid),
            " / ".join(spell_country(str(loc)) for loc in locs if loc),
            posted,
            None,
            DETAIL_URL.format(host=host, pid=pid, domain=quote(domain)),
        ))
    return out


def is_detail_payload(payload: dict) -> bool:
    data = payload.get("data")
    return isinstance(data, dict) and "jobDescription" in data


def jd_text(detail: dict) -> str | None:
    text = strip_html((detail.get("data") or {}).get("jobDescription") or "")
    return text or None
