"""Eightfold career-site listing for ats_boards.

Eightfold "PCS" career sites (<tenant>.eightfold.ai, or an employer domain
such as apply.careers.microsoft.com) render from a public JSON search the
page itself calls; robots.txt on those hosts explicitly allows /api/pcsx:

  search: /api/pcsx/search?domain=<domain>&query=<q>&start=<n>
  detail: /api/pcsx/position_details?position_id=<id>&domain=<domain>&hl=en

`domain` is the tenant's company domain (microsoft.com, micron.com); a
missing or wrong one is a 422. A board row's slug is "<host>/<domain>".
Pages are fixed at 10 rows and relevancy-sorted, so paging stops at the first
page with no intern-titled row, at `count`, or at the page cap (default
DEFAULT_PAGES; Eightfold's small pages need more of them than the other
listers).
"""

from __future__ import annotations

import datetime as dt
import json
from urllib.parse import quote

import httpx

from ..normalize import strip_html
from .listing_http import INTERN_RE, Pacer, page_cap, request_text, spell_country

QUERIES = ("intern", "co-op")
DEFAULT_PAGES = 20
SEARCH_URL = "https://{host}/api/pcsx/search?domain={domain}&query={query}&start={start}"
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
        start = 0
        for _ in range(cap):
            raw = request_text(client, pacer, SEARCH_URL.format(
                host=host, domain=quote(domain), query=quote(query),
                start=start))
            pages.append(raw)
            data = json.loads(raw)
            got = _positions(data)
            start += len(got)
            total = int((data.get("data") or {}).get("count") or 0)
            if (not got or start >= total
                    or not any(INTERN_RE.search(p.get("name") or "")
                               for p in got)):
                break
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
