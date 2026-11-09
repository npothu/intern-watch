"""SmartRecruiters posting helpers for the ats_boards adapter.

SmartRecruiters exposes an official, public, no-auth JSON API:

  list:   https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset=0&q=intern
  detail: https://api.smartrecruiters.com/v1/companies/{slug}/postings/{postingId}

The list envelope is paged ({offset, limit, totalFound, content: [...]}); each
content row carries the title, company, location, releasedDate and a public
posting URL, but NOT the JD body. The body lives on the per-posting detail
endpoint under jobAd.sections.* as HTML, so postings get a jd_url that
main.enrich_jds fetches lazily for new jobs only -- the same pattern Greenhouse
uses. This module only holds the SmartRecruiters-specific parsing; the dispatch
and Job construction stay in ats_boards.py.
"""

from __future__ import annotations

import json
from urllib.parse import quote

import httpx

from ..normalize import strip_html
from .listing_http import Pacer, page_cap, page_through, request_text

PAGE_SIZE = 100
LIST_URL = ("https://api.smartrecruiters.com/v1/companies/{slug}/postings"
            "?limit=100&offset={offset}&q={query}")
# Full-text queries (fuzzy, title + body). A big board (thousands of
# postings) buries its interns past the first page of an unfiltered list, so
# the board is searched once per query instead; the title-level INTERN_RE in
# ats_boards still decides what is an internship.
QUERIES = ("intern", "co-op")
DETAIL_URL = ("https://api.smartrecruiters.com/v1/companies/{slug}"
              "/postings/{posting_id}")


def fetch_pages(client: httpx.Client, board: dict) -> list[str]:
    """Every page of each query, complete or IncompleteListing (a short
    page before totalFound, repeated rows, or the board's page cap)."""
    pacer = Pacer()
    pages: list[str] = []
    for query in QUERIES:
        def fetch(offset: int, query: str = query) -> tuple[str, list[str], int]:
            raw = request_text(client, pacer, LIST_URL.format(
                slug=board["slug"], offset=offset, query=quote(query)))
            data = json.loads(raw)
            rows = data.get("content") or []
            return (raw, [str(r.get("id") or "") for r in rows],
                    int(data.get("totalFound") or 0))
        pages += page_through(
            fetch, page_size=PAGE_SIZE, cap=page_cap(board),
            what=f"smartrecruiters/{board['slug']} q={query}").pages
    return pages


def posting_url(posting: dict, slug: str) -> str | None:
    """Public posting page: the canonical postingUrl (no apply-flow params),
    falling back to applyUrl, then a jobs.smartrecruiters.com page built from
    the slug + id."""
    for key in ("postingUrl", "applyUrl"):
        val = posting.get(key)
        if val:
            return val
    pid = posting.get("id")
    return f"https://jobs.smartrecruiters.com/{slug}/{pid}" if pid else None


def location_str(posting: dict) -> str:
    """Prefer the pre-joined fullLocation; otherwise stitch city/region/country
    so the non-US/Canada elimination still has something to scan."""
    loc = posting.get("location") or {}
    full = loc.get("fullLocation")
    if full:
        return full
    parts = [loc.get("city"), loc.get("region"), loc.get("country")]
    return ", ".join(p for p in parts if p)


def jd_text(detail: dict) -> str | None:
    """Plain-text JD from a detail-endpoint payload: concatenate every
    jobAd.sections.* text (description, qualifications, ...) so the
    clearance/grad-only/unpaid JD eliminations see the requirement bullets."""
    sections = ((detail.get("jobAd") or {}).get("sections")) or {}
    parts = []
    for section in sections.values():
        if isinstance(section, dict) and section.get("text"):
            parts.append(strip_html(section["text"]))
    text = " ".join(p for p in parts if p).strip()
    return text or None
