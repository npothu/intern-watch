"""Multi-request ATS listers: paging bounds, politeness, failure isolation and
cross-source URL identity. No live network: httpx.MockTransport + fixtures."""

import json
import sys
from pathlib import Path

import httpx
import pytest

from src.adapters import listing_http
from src.adapters import smartrecruiters_api as sr
from src.adapters.ats_boards import AtsBoardsAdapter
from src.models import SourceConfig
from src.normalize import canonical_url

from .conftest import TODAY

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import discover_ats_boards as discover  # noqa: E402


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    calls: list[float] = []
    monkeypatch.setattr(listing_http, "sleep", calls.append)
    return calls


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _sr_page(n: int, total: int, start: int = 0) -> dict:
    return {"totalFound": total, "content": [
        {"id": str(744000000000 + start + i), "name": f"Software Intern {i}",
         "releasedDate": "2026-06-01T00:00:00Z",
         "location": {"city": "Austin", "region": "TX", "country": "us"}}
        for i in range(n)]}


# ------------------------------------------------------------ http helper

def test_pacer_sleeps_between_requests_not_before_first(no_sleep):
    seen = []

    def handler(req):
        seen.append(str(req.url))
        return httpx.Response(200, text="{}")

    pacer = listing_http.Pacer()
    with _client(handler) as c:
        for i in range(3):
            listing_http.request_text(c, pacer, f"https://x.example/{i}")
    assert len(seen) == 3
    assert no_sleep == [listing_http.REQUEST_DELAY] * 2


def test_request_retries_once_on_429_then_raises(no_sleep):
    hits = []

    def handler(req):
        hits.append(1)
        return httpx.Response(429)

    with _client(handler) as c, pytest.raises(httpx.HTTPStatusError):
        listing_http.request_text(c, listing_http.Pacer(), "https://x.example/")
    assert len(hits) == 2
    assert listing_http.RETRY_DELAY in no_sleep


def test_page_cap_override_and_garbage():
    assert listing_http.page_cap({}) == listing_http.MAX_PAGES
    assert listing_http.page_cap({"max_pages": 2}) == 2
    assert listing_http.page_cap({"max_pages": "x"}) == listing_http.MAX_PAGES


# ------------------------------------------------------- SmartRecruiters

def test_sr_pages_each_query_until_total_found():
    asked = []

    def handler(req):
        q = req.url.params["q"]
        off = int(req.url.params["offset"])
        asked.append((q, off))
        if q == "intern":
            return httpx.Response(200, json=_sr_page(
                100 if off == 0 else 30, 130, off))
        return httpx.Response(200, json=_sr_page(0, 0))

    with _client(handler) as c:
        pages = sr.fetch_pages(c, {"slug": "Acme"})
    assert asked == [("intern", 0), ("intern", 100), ("co-op", 0)]
    assert len(pages) == 3


def test_sr_pages_respect_cap():
    asked = []

    def handler(req):
        asked.append(req.url.params["q"])
        return httpx.Response(200, json=_sr_page(100, 10_000))

    with _client(handler) as c:
        sr.fetch_pages(c, {"slug": "Acme", "max_pages": 2})
    assert asked == ["intern", "intern", "co-op", "co-op"]


def test_ats_boards_fetch_isolates_a_failing_board(tmp_path, monkeypatch):
    boards = tmp_path / "boards.yaml"
    boards.write_text(
        "boards:\n"
        "- {company: Broken, ats: smartrecruiters, slug: Broken}\n"
        "- {company: Acme, ats: smartrecruiters, slug: Acme}\n")
    monkeypatch.setattr("src.adapters.ats_boards.ROOT", tmp_path)

    def handler(req):
        if "/Broken/" in req.url.path:
            return httpx.Response(404)
        q = req.url.params["q"]
        return httpx.Response(200, json=_sr_page(2 if q == "intern" else 0,
                                                 2 if q == "intern" else 0))

    adapter = AtsBoardsAdapter(SourceConfig(
        name="ats-boards", adapter="ats_boards", boards_file="boards.yaml"))
    with _client(handler) as c:
        jobs = adapter.fetch(c, TODAY)
    assert {j.company for j in jobs} == {"Acme"}
    assert len(jobs) == 2


@pytest.mark.parametrize("url", [
    "https://jobs.smartrecruiters.com/WesternDigital/744000149367234",
    "https://jobs.smartrecruiters.com/westerndigital/744000149367234-"
    "software-engineering-intern?oga=true",
    "https://careers.smartrecruiters.com/WesternDigital/744000149367234",
    "https://api.smartrecruiters.com/v1/companies/WesternDigital/postings/"
    "744000149367234",
])
def test_canonical_url_smartrecruiters_variants_collapse(url):
    assert canonical_url(url) == "ats:sr:westerndigital:744000149367234"


def test_canonical_url_smartrecruiters_company_page_is_not_a_posting():
    got = canonical_url("https://jobs.smartrecruiters.com/WesternDigital")
    assert got is not None and not got.startswith("ats:")


def test_sr_listing_url_joins_simplify_style_link(fixtures):
    raw = (fixtures / "ats_smartrecruiters_visa.json").read_text(encoding="utf-8")
    adapter = AtsBoardsAdapter(SourceConfig(
        name="ats-boards", adapter="ats_boards",
        boards_file="data/ats_boards.yaml"))
    job = adapter.parse(raw, "smartrecruiters:Visa:Visa", TODAY)[0]
    pid = json.loads(raw)["content"][0]["id"]
    assert canonical_url(job.url) == canonical_url(
        f"https://jobs.smartrecruiters.com/visa/{pid}-some-slug?oga=true")


# ------------------------------------------------------------- discovery

def test_discovery_rerun_keeps_manual_and_unprobed_rows():
    existing = [
        {"company": "Acme", "ats": "greenhouse", "slug": "acme"},
        {"company": "Acme", "ats": "greenhouse", "slug": "acmegone"},
        {"company": "Solidigm", "ats": "smartrecruiters", "slug": "Solidigm",
         "manual": True},
        {"company": "Bigco", "ats": "oracle", "slug": "pod.fa.us2.oraclecloud.com/CX_1"},
    ]
    found = [{"company": "Acme", "ats": "greenhouse", "slug": "acme"},
             {"company": "Solidigm", "ats": "smartrecruiters", "slug": "solidigm"}]
    merged = discover.merge_boards(found, existing)
    slugs = [(b["ats"], b["slug"]) for b in merged]
    # a probed row that discovery no longer finds is dropped (stale board);
    # the hand-added and unprobed rows survive; no (ats, slug) duplicates.
    assert ("greenhouse", "acmegone") not in slugs
    assert ("oracle", "pod.fa.us2.oraclecloud.com/CX_1") in slugs
    assert [s for s in slugs if s[0] == "smartrecruiters"] == [
        ("smartrecruiters", "Solidigm")]
    assert len(slugs) == 3
