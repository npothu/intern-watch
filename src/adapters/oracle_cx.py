"""Oracle Recruiting Cloud (Candidate Experience) listing for ats_boards.

Oracle HCM career sites (https://<pod>.fa.<dc>.oraclecloud.com/hcmUI/
CandidateExperience/en/sites/<site>/...) render client-side from a public,
unauthenticated REST feed -- the same one the page calls:

  list:   /hcmRestApi/resources/latest/recruitingCEJobRequisitions
            ?onlyData=true&expand=requisitionList.secondaryLocations
            &finder=findReqs;siteNumber=<site>,limit=..,offset=..,keyword=..,
            sortBy=RELEVANCY
  detail: /hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
            ?expand=all&onlyData=true&finder=ById;Id="<id>",siteNumber=<site>

A board row's slug is "<host>/<site>" (e.g. "egug.fa.us2.oraclecloud.com/
CX_1"). Requisition ids are per pod, shared by every site of that pod, so one
site per pod is enough (the canonical URL identity ignores the site).

The keyword search is fuzzy ("intern" also hits "Internal ..."), relevancy
sorted, so paging stops at the first page with no intern-titled row, at
TotalJobsCount, or at the board's page cap. The list carries no JD; each row
gets the detail feed as jd_url for main.enrich_jds.
"""

from __future__ import annotations

import json
from urllib.parse import quote

import httpx

from ..normalize import strip_html
from .listing_http import INTERN_RE, Pacer, iso_date, page_cap, request_text

PAGE_SIZE = 100
QUERIES = ("intern", "co-op")
_API = "https://{host}/hcmRestApi/resources/latest"
LIST_URL = (_API + "/recruitingCEJobRequisitions?onlyData=true"
            "&expand=requisitionList.secondaryLocations"
            "&finder=findReqs;siteNumber={site},limit={limit},offset={offset},"
            "keyword={query},sortBy=RELEVANCY")
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
        offset = 0
        for _ in range(page_cap(board)):
            raw = request_text(client, pacer, LIST_URL.format(
                host=host, site=site, limit=PAGE_SIZE, offset=offset,
                query=quote(query)))
            pages.append(raw)
            data = json.loads(raw)
            reqs = _reqs(data)
            offset += len(reqs)
            total = int(((data.get("items") or [{}])[0]).get("TotalJobsCount")
                        or 0)
            if (not reqs or 0 < total <= offset
                    or not any(INTERN_RE.search(r.get("Title") or "")
                               for r in reqs)):
                break
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
