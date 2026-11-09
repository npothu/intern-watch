"""Oracle Recruiting Cloud (Candidate Experience) listing for ats_boards.

Oracle HCM career sites (https://<pod>.fa.<dc>.oraclecloud.com/hcmUI/
CandidateExperience/en/sites/<site>/...) render client-side from a public,
unauthenticated REST feed -- the same one the page calls:

  list:   /hcmRestApi/resources/latest/recruitingCEJobRequisitions
            ?onlyData=true&expand=requisitionList.secondaryLocations
            &finder=findReqs;siteNumber=<site>,limit=..,offset=..,keyword=..,
            sortBy=POSTING_DATES_DESC
  detail: /hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
            ?expand=all&onlyData=true&finder=ById;Id="<id>",siteNumber=<site>

A board row's slug is "<host>/<site>" (e.g. "egug.fa.us2.oraclecloud.com/
CX_1"). Requisition ids are per pod, shared by every site of that pod, so one
site per pod is enough (the canonical URL identity ignores the site).

The keyword search is fuzzy ("intern" also hits "Internal ..."), so a query
is read all the way to TotalJobsCount (listing_http.page_through): a page
with no intern title is not the end -- on a live board one followed. A short
page before the total, or the page cap (default DEFAULT_PAGES), fails the
board. The list carries no JD; each row gets the detail feed as jd_url for
main.enrich_jds.
"""

from __future__ import annotations

import json
from urllib.parse import quote

import httpx

from ..normalize import strip_html
from .listing_http import Pacer, iso_date, page_cap, page_through, request_text

PAGE_SIZE = 100
QUERIES = ("intern", "co-op")
# The keyword search is fuzzy ("intern" also hits "Internal ..."), so totals
# run to thousands on big pods (JPMorgan ~3,500 = 35 pages): page to the
# stated total, with headroom; past 75% of the cap a warning is logged.
DEFAULT_PAGES = 60
# A stated TotalJobsCount can count a requisition the feed never lists (BNY:
# 594 stated, 593 listed under every sort), so a query may finish this many
# rows short and still count as complete.
TOTAL_SLACK = 2
_API = "https://{host}/hcmRestApi/resources/latest"
LIST_URL = (_API + "/recruitingCEJobRequisitions?onlyData=true"
            "&expand=requisitionList.secondaryLocations"
            "&finder=findReqs;siteNumber={site},limit={limit},offset={offset},"
            "keyword={query},sortBy=POSTING_DATES_DESC")
DETAIL_URL = (_API + "/recruitingCEJobRequisitionDetails?expand=all"
              "&onlyData=true&finder=ById;Id=%22{req_id}%22,siteNumber={site}")
POSTING_URL = ("https://{host}/hcmUI/CandidateExperience/en/sites/{site}"
               "/job/{req_id}")


def split_slug(slug: str) -> tuple[str, str]:
    host, _, site = slug.partition("/")
    if not host or not site:
        raise ValueError(f"oracle slug must be '<host>/<site>', got {slug!r}")
    return host, site


def _reqs(data: dict) -> list[dict]:
    items = data.get("items") or []
    return (items[0].get("requisitionList") or []) if items else []


def fetch_pages(client: httpx.Client, board: dict) -> list[str]:
    host, site = split_slug(board["slug"])
    pacer = Pacer()
    pages: list[str] = []
    for query in QUERIES:
        def fetch(offset: int, query: str = query) -> tuple[str, list[str], int]:
            raw = request_text(client, pacer, LIST_URL.format(
                host=host, site=site, limit=PAGE_SIZE, offset=offset,
                query=quote(query)))
            data = json.loads(raw)
            total = int(((data.get("items") or [{}])[0]).get("TotalJobsCount")
                        or 0)
            return raw, [str(r.get("Id") or "") for r in _reqs(data)], total
        pages += page_through(
            fetch, page_size=PAGE_SIZE, cap=page_cap(board, DEFAULT_PAGES),
            what=f"oracle/{board['slug']} q={query}",
            slack=TOTAL_SLACK).pages
    return pages


def rows(data: dict, slug: str) -> list[tuple]:
    """(title, url, location, date_posted, description, jd_url) per req."""
    host, site = split_slug(slug)
    out = []
    for r in _reqs(data):
        req_id = str(r.get("Id") or "").strip()
        if not req_id:
            continue
        locs = [r.get("PrimaryLocation") or ""] + [
            s.get("Name") or "" for s in r.get("secondaryLocations") or []]
        out.append((
            r.get("Title"),
            POSTING_URL.format(host=host, site=site, req_id=req_id),
            " / ".join(loc for loc in locs if loc),
            iso_date(r.get("PostedDate")),
            None,
            DETAIL_URL.format(host=host, site=site, req_id=quote(req_id)),
        ))
    return out


def jd_text(detail: dict) -> str | None:
    """Plain-text JD from a detail-feed payload: the external description,
    responsibilities and qualifications (where degree/clearance demands
    live). Corporate boilerplate sections are left out."""
    items = detail.get("items") or []
    if not items:
        return None
    req = items[0]
    parts = [strip_html(req.get(k) or "") for k in (
        "ExternalDescriptionStr", "ExternalResponsibilitiesStr",
        "ExternalQualificationsStr")]
    text = " ".join(p for p in parts if p).strip()
    return text or None


def is_detail_payload(payload: dict) -> bool:
    items = payload.get("items")
    return (isinstance(items, list) and bool(items)
            and isinstance(items[0], dict)
            and "ExternalDescriptionStr" in items[0])
