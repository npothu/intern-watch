"""IBM careers listing for ats_boards.

careers.ibm.com is an Avature portal that answers non-browser clients with
an empty HTTP 202, so the portal itself is not fetched. The public job search
on ibm.com/careers/search instead calls IBM's site-search API with a JSON
POST, unauthenticated; this module sends the same kind of query, filtered to
the "Internship" job type:

  POST https://www-api.ibm.com/search/api/v2
       {"appId": "careers", "scopes": ["careers2"], "query": {...},
        "size": 100, "from": <n>}

Each hit carries the title, the careers.ibm.com JobDetail URL, a location
("CITY, CC"), a teaser (not used: it is truncated) and a date. There is no
public JD endpoint that answers bots, so rows get no jd_url. The board row's
slug is unused (one board: IBM).
"""

from __future__ import annotations

import json

import httpx

from .listing_http import (
    Pacer,
    iso_date,
    page_cap,
    page_through,
    request_text,
    spell_country,
)

SEARCH_URL = "https://www-api.ibm.com/search/api/v2"
PAGE_SIZE = 100
_SOURCE_FIELDS = ["title", "url", "dcdate", "field_keyword_18",
                  "field_keyword_19"]


def location(raw: str) -> str:
    """'BATON ROUGE, US' -> 'Baton Rouge, United States' (codes spelled out
    by listing_http.spell_country; IBM upper-cases some city names)."""
    city, sep, code = (raw or "").rpartition(",")
    if not sep or not city.strip():
        return spell_country(raw or "", min_parts=2)
    return spell_country(f"{city.strip().title()},{code}", min_parts=2)


def query_body(offset: int) -> dict:
    return {
        "appId": "careers",
        "scopes": ["careers2"],
        # The API only accepts a simple_query_string "must" (match_all is a
        # 400); the job-type filter does the real narrowing.
        "query": {"bool": {
            "must": [{"simple_query_string": {
                # "|" is OR; a bare co-op would parse "-op" as NOT op.
                "query": 'intern | coop | "co-op"',
                "fields": ["title^3", "description^2", "keywords^1"]}}],
            "filter": [{"term": {"field_keyword_18": "Internship"}}]}},
        "size": PAGE_SIZE,
        "from": offset,
        "sort": [{"_score": "desc"}],
        "lang": "zz",
        "_source": _SOURCE_FIELDS,
    }


def _hits(data: dict) -> tuple[list[dict], int]:
    hits = data.get("hits") or {}
    total = hits.get("total") or {}
    count = total.get("value") if isinstance(total, dict) else total
    return hits.get("hits") or [], int(count or 0)


def fetch_pages(client: httpx.Client, board: dict) -> list[str]:
    pacer = Pacer()

    def fetch(offset: int) -> tuple[str, list[str], int]:
        raw = request_text(client, pacer, SEARCH_URL, body=query_body(offset))
        hits, total = _hits(json.loads(raw))
        return (raw, [(h.get("_source") or {}).get("title") or ""
                      for h in hits], total)
    return page_through(fetch, page_size=PAGE_SIZE, cap=page_cap(board),
                        what="ibm/careers")


def rows(data: dict, slug: str) -> list[tuple]:
    """(title, url, location, date_posted, description, jd_url) per hit."""
    out = []
    for h in _hits(data)[0]:
        src = h.get("_source") or {}
        url = src.get("url") or ""
        if "JobDetail" not in url:
            continue
        posted = iso_date(src.get("dcdate"))
        out.append((src.get("title"), url,
                    location(src.get("field_keyword_19") or ""),
                    posted, None, None))
    return out
