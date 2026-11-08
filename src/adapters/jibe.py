"""Jibe (iCIMS Attract) career-site listing for ats_boards.

Some iCIMS customers front their portal with a Jibe career site
(careers.amd.com, careers.<employer>.com/jobs/<id>?icims=1). That site renders
from a public JSON search on its own host; robots.txt allows it:

  /api/jobs?keywords=<q>&page=<n>&limit=100&sortBy=relevance

Rows ship the JD inline (description / responsibilities / qualifications),
so no jd_url is needed. A board row's slug is the career-site host.
Relevancy-sorted, so paging stops at the first page with no intern-titled
row, at totalCount, or at the page cap.
"""

from __future__ import annotations

import json
from urllib.parse import quote

import httpx

from ..normalize import strip_html
from .listing_http import INTERN_RE, Pacer, iso_date, page_cap, request_text

QUERIES = ("intern", "co-op")
PAGE_SIZE = 100
SEARCH_URL = ("https://{host}/api/jobs?keywords={query}&page={page}"
              "&limit={limit}&sortBy=relevance")
POSTING_URL = "https://{host}/jobs/{req_id}"


def _jobs(data: dict) -> list[dict]:
    return [j.get("data") or {} for j in data.get("jobs") or []
            if isinstance(j, dict)]


def fetch_pages(client: httpx.Client, board: dict) -> list[str]:
    host = board["slug"]
    pacer = Pacer()
    pages: list[str] = []
    for query in QUERIES:
        seen = 0
        for page in range(1, page_cap(board) + 1):
            raw = request_text(client, pacer, SEARCH_URL.format(
                host=host, query=quote(query), page=page, limit=PAGE_SIZE))
            pages.append(raw)
            data = json.loads(raw)
            got = _jobs(data)
            seen += len(got)
            if (not got or seen >= int(data.get("totalCount") or 0)
                    or not any(INTERN_RE.search(j.get("title") or "")
                               for j in got)):
                break
    return pages


def _location(job: dict) -> str:
    full = job.get("full_location") or job.get("short_location") or ""
    parts = [p.strip() for p in full.split(";") if p.strip()]
    country = job.get("country") or ""
    # One location: name its country so filters.location_country does not
    # have to guess from a province name; several may span countries.
    if len(parts) == 1 and country and country not in parts[0]:
        parts[0] = f"{parts[0]}, {country}"
    return " / ".join(parts)


def rows(data: dict, slug: str) -> list[tuple]:
    """(title, url, location, date_posted, description, jd_url) per job."""
    out = []
    for j in _jobs(data):
        req_id = str(j.get("req_id") or j.get("slug") or "").strip()
        if not req_id.isdigit():
            continue
        body = " ".join(strip_html(j.get(k) or "") for k in (
            "description", "responsibilities", "qualifications")).strip()
        out.append((j.get("title"),
                    POSTING_URL.format(host=slug, req_id=req_id),
                    _location(j), iso_date(j.get("posted_date")),
                    body or None, None))
    return out
