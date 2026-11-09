"""Workday career-site helpers for the ats_boards adapter.

Workday has no official public jobs API, but every career site
(https://{tenant}.{wdN}.myworkdayjobs.com/{site}) is a single-page app that
reads its listings from the same public, unauthenticated "CXS" JSON endpoints
in the visitor's browser:

  list:   POST https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
          {"appliedFacets": {}, "limit": 20, "offset": N, "searchText": "intern"}
  detail: GET  https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}

A board row in data/ats_boards.yaml is `ats: workday` with
`slug: {tenant}.{wdN}/{site}` (the career site's own URL, minus the domain).

The list endpoint caps `limit` at 20, returns `total` only on the first page,
and repeats rows past `total`, so paging runs exactly to that total. A listing
is always read COMPLETELY or not at all: if the total needs more than
MAX_PAGES pages, or any request fails, the board fails for this run. A short
read must never pass for a full one, because on a board's first sight
(src/seeding.py) whatever it missed would later be delivered as news instead
of being seeded as backlog. Which rows to ask for:

1. Most tenants expose an employment-type facet (workerSubType "Intern (Fixed
   Term)", jobFamilyGroup "Interns", ...). One unfiltered call (limit 1) reads
   the facet values, and the listing pages with that facet applied: exactly the
   intern/co-op postings, a few pages even for the largest employers.
2. Tenants without one are read whole (empty search) and parse() keeps the
   intern/co-op titles. Free-text search cannot be made complete cheaply: its
   ranking is unreliable ("intern" also matches International/Internal; some
   tenants sort by date), and any early stop can truncate interns. On every
   tenant measured, a "co-op" search returned the entire site anyway. These
   sites are small (the largest in the template, Motorola Solutions, is ~860
   jobs: 44 pages).

List rows carry no JD body; jobs get a jd_url (the detail endpoint) that
main.enrich_jds fetches lazily for new jobs only, the same pattern Greenhouse
and SmartRecruiters use.

Public URLs are https://{host}/{site}{externalPath}: the form Simplify and the
other curated lists link, so normalize.normalize_url gives the same `url:` dedup
key and normalize.canonical_url the same `ats:wd:<tenant>:<reqid>` token.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor

import httpx

from ..models import Job
from ..normalize import strip_html

log = logging.getLogger(__name__)

PAGE_SIZE = 20          # the CXS endpoint answers 400 above 20
MAX_PAGES = 60          # 1,200 rows: a listing needing more fails, never truncates
REQUEST_DELAY = 0.25    # seconds between requests to one tenant
RETRY_DELAY = 3.0       # backoff before the single retry of a 429/5xx/timeout
WORKERS = 4             # tenants polled at once; each tenant stays sequential
TIMEOUT = 20.0
USER_AGENT = "intern-baddie (job alert bot)"

_SLUG_RE = re.compile(r"^([a-z0-9-]+)\.(wd\d+)/([A-Za-z0-9_-]+)$", re.I)
_INTERN_RE = re.compile(r"\bintern(ship)?s?\b|\bco-?op\b", re.I)
_DAYS_AGO_RE = re.compile(r"(\d+)\+?\s+days?\s+ago", re.I)
_MULTI_LOC_RE = re.compile(r"^\s*\d+\s+locations?\s*$", re.I)
# Facet values naming an intern/co-op employment type. Lookarounds instead of
# \b so "Intern_Group" matches; "International", "Internal" and "Cooperstown"
# do not.
_FACET_VALUE_RE = re.compile(
    r"(?<![a-z])(intern(s|ships?)?|co[- ]?op)(?![a-z])", re.I)
_FACET_SKIP_RE = re.compile(r"non-intern|pharmacy", re.I)  # CVS: ~3,900 rows
# Facet parameters that describe the job (not its location or company).
# workerSubType is the employment type itself, so it wins when present; the
# job-family ones are used only without it (CVS files 3,900 pharmacy roles
# under an "Internships and Development Programs" family group).
_FACET_PARAMS = ("workerSubType", "jobFamilyGroup", "Job_Family_Group",
                 "jobFamily", "jobFamilies")


def split_slug(slug: str) -> tuple[str, str, str]:
    """'nvidia.wd5/NVIDIAExternalCareerSite' -> (tenant, wd host, site)."""
    m = _SLUG_RE.match(slug.strip())
    if not m:
        raise ValueError(f"bad workday slug {slug!r} (want tenant.wdN/site)")
    return m.group(1).lower(), m.group(2).lower(), m.group(3)


def _origin(slug: str) -> tuple[str, str, str]:
    tenant, host, site = split_slug(slug)
    return f"https://{tenant}.{host}.myworkdayjobs.com", tenant, site


def list_url(slug: str) -> str:
    origin, tenant, site = _origin(slug)
    return f"{origin}/wday/cxs/{tenant}/{site}/jobs"


def detail_url(slug: str, external_path: str) -> str:
    origin, tenant, site = _origin(slug)
    return f"{origin}/wday/cxs/{tenant}/{site}{external_path}"


def public_url(slug: str, external_path: str) -> str:
    origin, _tenant, site = _origin(slug)
    return f"{origin}/{site}{external_path}"


def posted_date(text: str | None, today: dt.date) -> dt.date | None:
    """'Posted Today' / 'Posted Yesterday' / 'Posted 3 Days Ago' /
    'Posted 30+ Days Ago' -> a date. '30+' maps to today-30, a lower bound on
    the age, so a max_age_days cutoff under 30 still drops it."""
    if not text:
        return None
    low = text.casefold()
    if "today" in low:
        return today
    if "yesterday" in low:
        return today - dt.timedelta(days=1)
    m = _DAYS_AGO_RE.search(low)
    if m:
        return today - dt.timedelta(days=int(m.group(1)))
    return None


def location_str(posting: dict) -> str:
    """locationsText, except Workday's '3 Locations' placeholder, which is
    no location at all (enrich_jds fills the real ones from the detail)."""
    text = (posting.get("locationsText") or "").strip()
    return "" if _MULTI_LOC_RE.match(text) else text


_WORK_MODELS = {"remote": "Remote", "hybrid": "Hybrid",
                "onsite": "On Site", "on site": "On Site", "on-site": "On Site"}


def set_work_models(jobs: list[Job], data: dict, slug: str) -> None:
    """Copy each row's remoteType onto its Job (the `remote` location rule
    reads Job.work_model). Matched by public URL, which parse() built."""
    by_url = {public_url(slug, row["externalPath"]):
              _WORK_MODELS.get((row.get("remoteType") or "").strip().casefold())
              for row in data.get("jobPostings", []) if row.get("externalPath")}
    for job in jobs:
        job.work_model = job.work_model or by_url.get(job.url)


def intern_facet(facets: list) -> dict[str, list[str]] | None:
    """{param: [value ids]} selecting the intern/co-op postings, or None.
    Within one param Workday ORs the values; across params it ANDs, so one
    param is chosen: workerSubType if it has a match, else the job-family
    param with the most matching postings."""
    found: dict[str, list[tuple[str, int]]] = {}

    def walk(nodes: list) -> None:
        for facet in nodes:
            values = facet.get("values") or []
            if values and "facetParameter" in values[0]:
                walk(values)        # a group (locationMainGroup) of facets
                continue
            param = facet.get("facetParameter")
            if param not in _FACET_PARAMS:
                continue
            for v in values:
                name = v.get("descriptor") or ""
                if (v.get("id") and _FACET_VALUE_RE.search(name)
                        and not _FACET_SKIP_RE.search(name)):
                    found.setdefault(param, []).append(
                        (v["id"], int(v.get("count") or 0)))

    walk(facets or [])
    if not found:
        return None
    param = ("workerSubType" if "workerSubType" in found else
             max(found, key=lambda p: sum(n for _id, n in found[p])))
    return {param: [vid for vid, _n in found[param]]}


class _Pager:
    """POSTs to one tenant's list endpoint with a polite delay; the first
    request's failure propagates (dead board), later ones end that query."""

    def __init__(self, client: httpx.Client, slug: str,
                 sleep: Callable[[float], None]) -> None:
        self.client, self.slug, self.sleep = client, slug, sleep
        self.url = list_url(slug)
        self.requests = 0

    def post(self, facets: dict, search: str, offset: int, limit: int) -> dict:
        """One list request. A 429, 5xx or transport error gets ONE retry
        after RETRY_DELAY; anything still failing raises."""
        body = {"appliedFacets": facets, "limit": limit, "offset": offset,
                "searchText": search}
        for attempt in (1, 2):
            if self.requests:
                self.sleep(REQUEST_DELAY)
            self.requests += 1
            try:
                resp = self.client.post(self.url, timeout=TIMEOUT, json=body)
            except httpx.TransportError:
                if attempt == 2:
                    raise
                self.sleep(RETRY_DELAY)
                continue
            if attempt == 1 and (resp.status_code == 429
                                 or resp.status_code >= 500):
                self.sleep(RETRY_DELAY)
                continue
            resp.raise_for_status()
            data: dict = resp.json()
            return data
        raise AssertionError("unreachable")  # pragma: no cover

    def pages(self, facets: dict, postings: dict[str, dict]) -> None:
        """Every row of one query into postings (keyed by externalPath), to
        the reported total. Raises IncompleteListing instead of truncating:
        the rows received must reach the total, whether the query ends on a
        full page or a short one."""
        total = 0
        for page in range(MAX_PAGES + 1):
            if page and page * PAGE_SIZE >= total:
                return
            # Any page failing (after its retry) fails the whole board.
            data = self.post(facets, "", page * PAGE_SIZE, PAGE_SIZE)
            rows = data.get("jobPostings") or []
            if page == 0:
                if data.get("total") is None and rows:
                    raise IncompleteListing(
                        f"workday {self.slug}: rows but no total on page 0")
                total = int(data.get("total") or 0)
                check_pages(self.slug, total)
            for row in rows:
                path = row.get("externalPath")
                if path and row.get("title"):
                    postings.setdefault(path, row)
            if len(rows) < PAGE_SIZE:
                if page * PAGE_SIZE + len(rows) < total:
                    raise IncompleteListing(
                        f"workday {self.slug}: listing ended at "
                        f"{page * PAGE_SIZE + len(rows)} of {total} rows")
                return


class IncompleteListing(RuntimeError):
    """A listing that cannot be read completely: too large for MAX_PAGES, no
    total to check against, or fewer rows than its reported total."""


def check_pages(slug: str, total: int) -> None:
    if -(-total // PAGE_SIZE) > MAX_PAGES:
        raise IncompleteListing(
            f"workday {slug}: {total} rows need more than {MAX_PAGES} pages; "
            "failing the board rather than reading part of it (find its "
            "intern facet or raise MAX_PAGES)")


def fetch_listing(slug: str, client: httpx.Client | None = None,
                  sleep: Callable[[float], None] = time.sleep) -> str:
    """One career site's intern/co-op postings (its intern facet), or every
    posting when it has no such facet, as a JSON string {"jobPostings": [...]}
    (deduped by externalPath) for AtsBoardsAdapter.parse, which keeps the
    intern/co-op titles. Raises IncompleteListing rather than truncating.
    Raises if any request fails after its one retry: the board then counts
    as failed for this run, never as a short or empty listing. Uses its own
    client by default: every tenant is
    a different host, and the watcher's shared client carries a GitHub token
    that must not be sent to employers."""
    if client is None:
        with httpx.Client(headers={"User-Agent": USER_AGENT}) as own:
            return fetch_listing(slug, own, sleep)
    pager = _Pager(client, slug, sleep)
    postings: dict[str, dict] = {}
    probe = pager.post({}, "", 0, 1)
    facets = intern_facet(probe.get("facets") or [])
    if not facets:
        # the probe's total is the whole site: fail before paging it
        check_pages(slug, int(probe.get("total") or 0))
    pager.pages(facets or {}, postings)
    log.debug("workday %s: %d rows in %d requests (%s)", slug, len(postings),
              pager.requests, "facet" if facets else "whole site")
    return json.dumps({"jobPostings": list(postings.values())})


def fetch_listings(slugs: Iterable[str]) -> dict[str, str | Exception]:
    """fetch_listing for many career sites, WORKERS tenants at a time. Sites
    of one tenant share a host and run back to back in one worker, so no
    employer ever sees concurrent requests. A board's failure is returned as
    its value, never raised, so one bad tenant cannot fail the source."""
    by_tenant: dict[str, list[str]] = {}
    bad: dict[str, str | Exception] = {}
    for slug in dict.fromkeys(slugs):
        try:
            tenant_name = split_slug(slug)[0]
        except ValueError as exc:   # a malformed row fails alone
            bad[slug] = exc
            continue
        by_tenant.setdefault(tenant_name, []).append(slug)

    def tenant(sites: list[str]) -> list[tuple[str, str | Exception]]:
        out: list[tuple[str, str | Exception]] = []
        for i, slug in enumerate(sites):
            if i:
                time.sleep(REQUEST_DELAY)
            try:
                out.append((slug, fetch_listing(slug)))
            except Exception as exc:  # noqa: BLE001 - reported per board by the caller
                out.append((slug, exc))
        return out
    if not by_tenant:
        return bad
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        return bad | {slug: res for batch in pool.map(tenant, by_tenant.values())
                      for slug, res in batch}


def listing(results: dict[str, str | Exception], slug: str) -> str:
    """One board's prefetched listing; re-raises its failure."""
    result = results[slug]
    if isinstance(result, Exception):
        raise result
    return result


def jd_text(detail: dict) -> str | None:
    """Plain-text JD from a detail-endpoint payload."""
    info = detail.get("jobPostingInfo") or {}
    text = strip_html(info.get("jobDescription") or "").strip()
    return text or None


# Bare city names that must never inherit a foreign primary's country: a US
# site listed without its state under a foreign primary ("Austin" under
# Krakow) would become "Austin, Poland" and turn a kept job into a final
# rejection. Leaving such a city unknown keeps the job (filters treats an
# unplaced location as kept). Large US metros and tech/engineering hubs;
# a bare city missing here still inherits, which is the residual risk.
_US_CITY_NAMES = frozenset((
    "albuquerque", "anaheim", "ann arbor", "arlington", "atlanta", "aurora",
    "austin", "baltimore", "bellevue", "berkeley", "birmingham", "boise",
    "boston", "boulder", "bridgewater", "buffalo", "burlington", "cambridge",
    "cary", "chandler", "charlotte", "chattanooga", "chicago", "cincinnati",
    "cleveland", "colorado springs", "columbus", "cupertino", "dallas",
    "dayton", "dearborn", "denver", "des moines", "detroit", "durham",
    "el paso", "el segundo", "fort collins", "fort worth", "fremont",
    "fresno", "gainesville", "glendale", "grand rapids", "greenville",
    "hartford", "henderson", "hillsboro", "honolulu", "houston", "huntsville",
    "indianapolis", "irvine", "irving", "jacksonville", "jersey city",
    "kansas city", "knoxville", "las vegas", "lexington", "lincoln",
    "long beach", "los angeles", "louisville", "lowell", "madison",
    "manhattan", "memphis", "mesa", "miami", "milwaukee", "minneapolis",
    "mountain view", "nashville", "new orleans", "new york", "newark",
    "norfolk", "novi", "oakland", "oklahoma city", "omaha", "orlando",
    "palo alto", "pasadena", "philadelphia", "phoenix", "pittsburgh", "plano",
    "portland", "princeton", "provo", "raleigh", "redmond", "reno",
    "richmond", "riverside", "rochester", "sacramento", "salt lake city",
    "san antonio", "san diego", "san francisco", "san jose", "san mateo",
    "santa clara", "santa monica", "scottsdale", "seattle", "st louis",
    "st. louis", "st paul", "st. paul", "stamford", "sunnyvale", "syracuse",
    "tampa", "tempe", "toledo", "tucson", "tulsa", "virginia beach", "warren",
    "washington", "waukesha", "wichita", "wilmington", "winston-salem",
    "worcester",
))


def _us_city(loc: str) -> bool:
    from ..filters import _METRO_AMBIGUOUS, _METRO_UNAMBIGUOUS
    name = loc.split(",", 1)[0].strip().casefold()
    return (name in _US_CITY_NAMES or name in _METRO_UNAMBIGUOUS
            or name in _METRO_AMBIGUOUS)


def detail_locations(detail: dict) -> list[str]:
    """Primary + additional locations from a detail payload, placed by
    country for the country elimination. The payload carries only the
    primary's country, so it is appended to the primary when its name lacks
    it ("Hyderabad" -> "Hyderabad, India") and to any additional location
    filters.location_country cannot place on its own ("Bangalore" ->
    "Bangalore, India"). A bare additional city is assumed to share the
    primary's country, except a known US city (_US_CITY_NAMES), which stays
    unplaced and so kept: inheriting there would turn a kept job into a
    final rejection. A location that is placed already is never touched."""
    from ..filters import location_country
    info = detail.get("jobPostingInfo") or {}
    country = ((info.get("country") or {}).get("descriptor") or "").strip()
    primary = (info.get("location") or "").strip() if isinstance(
        info.get("location"), str) else ""
    if country and country.casefold() not in primary.casefold():
        primary = f"{primary}, {country}" if primary else country
    extra = [loc.strip() for loc in info.get("additionalLocations") or []
             if isinstance(loc, str) and loc.strip()]
    if country:
        extra = [f"{loc}, {country}"
                 if location_country(loc) == "unknown" and not _us_city(loc)
                 else loc for loc in extra]
    return [loc for loc in [primary, *extra] if loc]
