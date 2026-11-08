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


# ------------------------------------------------------------ Oracle CX

ORACLE_SLUG = "egug.fa.us2.oraclecloud.com/CX_1"


def _adapter():
    return AtsBoardsAdapter(SourceConfig(
        name="ats-boards", adapter="ats_boards",
        boards_file="data/ats_boards.yaml"))


def test_oracle_parse(fixtures):
    raw = (fixtures / "ats_oracle_amex.json").read_text(encoding="utf-8")
    jobs = _adapter().parse(raw, f"oracle:{ORACLE_SLUG}:American Express",
                            TODAY)
    assert len(jobs) == 5                       # 3 manager rows pre-filtered
    assert all(j.company == "American Express" for j in jobs)
    assert all(j.url.startswith(
        "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/"
        "sites/CX_1/job/") for j in jobs)
    assert all(j.jd_url and "recruitingCEJobRequisitionDetails" in j.jd_url
               and "siteNumber=CX_1" in j.jd_url for j in jobs)
    assert all(j.date_posted is not None and j.locations for j in jobs)
    swe = next(j for j in jobs if "Software Engineer" in j.title)
    assert swe.terms == ["Summer 2027"]
    assert any("Sunnyvale" in loc for loc in swe.locations)


def test_oracle_slug_must_name_a_site():
    from src.adapters import oracle_cx
    with pytest.raises(ValueError):
        oracle_cx.split_slug("egug.fa.us2.oraclecloud.com")


def test_oracle_paging_stops_on_a_page_without_interns():
    asked = []

    def handler(req):
        finder = req.url.params["finder"]
        off = int(finder.split("offset=")[1].split(",")[0])
        kw = finder.split("keyword=")[1].split(",")[0]
        asked.append((kw, off))
        title = "Software Intern" if off == 0 else "Internal Auditor"
        return httpx.Response(200, json={"items": [{
            "TotalJobsCount": 1000,
            "requisitionList": [{"Id": str(off + i), "Title": title}
                                for i in range(100)]}]})

    from src.adapters import oracle_cx
    with _client(handler) as c:
        oracle_cx.fetch_pages(c, {"slug": ORACLE_SLUG})
    assert asked == [("intern", 0), ("intern", 100),
                     ("co-op", 0), ("co-op", 100)]


def test_oracle_detail_jd_text(fixtures):
    from src.adapters import oracle_cx
    detail = json.loads((fixtures / "ats_oracle_amex_detail.json")
                        .read_text(encoding="utf-8"))
    assert oracle_cx.is_detail_payload(detail)
    assert not oracle_cx.is_detail_payload({"items": []})
    assert not oracle_cx.is_detail_payload({"content": "<p>x</p>"})
    body = oracle_cx.jd_text(detail)
    assert body and "<" not in body
    # corporate boilerplate is not part of the JD
    assert "our culture is built on" not in body


def test_enrich_jds_reads_oracle_detail(fixtures, monkeypatch):
    from src import main
    from src.models import Job
    detail = (fixtures / "ats_oracle_amex_detail.json").read_text(encoding="utf-8")
    real = httpx.Client
    monkeypatch.setattr(main.httpx, "Client", lambda **kw: real(
        transport=httpx.MockTransport(lambda req: httpx.Response(
            200, text=detail)), **kw))
    job = Job(company="American Express", title="Intern", url="https://x/1",
              jd_url="https://egug.fa.us2.oraclecloud.com/hcmRestApi/x",
              source="ats-boards")
    assert main.enrich_jds([job]) == 1
    assert job.description and "<" not in job.description


@pytest.mark.parametrize("url", [
    "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/"
    "CX_1/job/26011784",
    "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/"
    "CX/job/26011784/?utm_source=simplify",
    "https://EGUG.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en-US/"
    "sites/CX_1/requisitions/preview/26011784",
    "https://careers.americanexpress.com/en/sites/CX_1/job/26011784",
])
def test_canonical_url_oracle_variants_collapse(url):
    assert canonical_url(url) == "ats:oracle:egug:26011784"


def test_canonical_url_oracle_pods_stay_apart_and_ids_keep_case():
    a = canonical_url("https://edbz.fa.us2.oraclecloud.com/hcmUI/"
                      "CandidateExperience/en/sites/CX/job/240001hw")
    b = canonical_url("https://egup.fa.us2.oraclecloud.com/hcmUI/"
                      "CandidateExperience/en/sites/CX/job/240001HW")
    assert a == "ats:oracle:edbz:240001HW"
    assert b == "ats:oracle:egup:240001HW"
    # no-site form some sites link
    assert canonical_url("https://eeho.fa.us2.oraclecloud.com/hcmUI/"
                         "CandidateExperience/en/job/334345/") == (
        "ats:oracle:eeho:334345")


def test_oracle_listing_url_joins_aggregator_link(fixtures):
    raw = (fixtures / "ats_oracle_amex.json").read_text(encoding="utf-8")
    job = _adapter().parse(raw, f"oracle:{ORACLE_SLUG}:American Express",
                           TODAY)[0]
    req_id = job.url.rsplit("/", 1)[1]
    assert canonical_url(job.url) == canonical_url(
        f"https://careers.americanexpress.com/en/sites/CX_1/job/{req_id}")


# ------------------------------------------------------------- Eightfold

MS_SLUG = "apply.careers.microsoft.com/microsoft.com"


def test_eightfold_parse(fixtures):
    raw = (fixtures / "ats_eightfold_microsoft.json").read_text(encoding="utf-8")
    jobs = _adapter().parse(raw, f"eightfold:{MS_SLUG}:Microsoft", TODAY)
    assert len(jobs) == 9                       # the senior row pre-filtered
    assert all(j.url.startswith(
        "https://apply.careers.microsoft.com/careers/job/") for j in jobs)
    assert all(j.jd_url and "position_details" in j.jd_url
               and "domain=microsoft.com" in j.jd_url for j in jobs)
    assert all(j.date_posted is not None for j in jobs)
    assert any("Redmond, WA, United States" in j.locations for j in jobs)


def test_eightfold_paging_and_domain():
    asked = []

    def handler(req):
        assert req.url.params["domain"] == "microsoft.com"
        q, start = req.url.params["query"], int(req.url.params["start"])
        asked.append((q, start))
        if q == "co-op":
            return httpx.Response(200, json={"data": {"count": 0,
                                                      "positions": []}})
        return httpx.Response(200, json={"data": {"count": 25, "positions": [
            {"id": start + i, "name": "Intern"} for i in range(10)]}})

    from src.adapters import eightfold
    with _client(handler) as c:
        eightfold.fetch_pages(c, {"slug": MS_SLUG})
    assert asked == [("intern", 0), ("intern", 10), ("intern", 20),
                     ("co-op", 0)]


def test_eightfold_detail_jd_text(fixtures):
    from src.adapters import eightfold
    detail = json.loads((fixtures / "ats_eightfold_micron_detail.json")
                        .read_text(encoding="utf-8"))
    assert eightfold.is_detail_payload(detail)
    assert not eightfold.is_detail_payload({"data": {"positions": []}})
    body = eightfold.jd_text(detail)
    assert body and "<" not in body


@pytest.mark.parametrize("url,token", [
    ("https://apply.careers.microsoft.com/careers/job/1970393556972687",
     "ats:eightfold:microsoft:1970393556972687"),
    ("https://apply.careers.microsoft.com/careers/job/1970393557044764/",
     "ats:eightfold:microsoft:1970393557044764"),
    ("https://microsoft.eightfold.ai/careers?pid=1970393556979054",
     "ats:eightfold:microsoft:1970393556979054"),
    ("https://apply.careers.microsoft.com/careers?query=intern&start=0"
     "&pid=1970393556922922&sort_by=relevance",
     "ats:eightfold:microsoft:1970393556922922"),
    ("https://careers.micron.com/careers/job/43785470",
     "ats:eightfold:micron:43785470"),
    ("https://micron.eightfold.ai/careers?pid=43785470",
     "ats:eightfold:micron:43785470"),
])
def test_canonical_url_eightfold(url, token):
    assert canonical_url(url) == token


def test_canonical_url_eightfold_search_page_without_pid_is_not_a_posting():
    got = canonical_url("https://micron.eightfold.ai/careers?query=intern")
    assert got is not None and not got.startswith("ats:")


# ------------------------------------------------------------------- IBM

def test_ibm_parse(fixtures):
    raw = (fixtures / "ats_ibm_search.json").read_text(encoding="utf-8")
    jobs = _adapter().parse(raw, "ibm:careers:IBM", TODAY)
    assert len(jobs) == 12
    assert all(j.url.startswith("https://careers.ibm.com/careers/JobDetail?jobId=")
               for j in jobs)
    assert all(j.jd_url is None and j.description is None for j in jobs)
    procurement = next(j for j in jobs if j.title.startswith("Procurement"))
    assert procurement.locations == ["Research Triangle Park, United States"]


@pytest.mark.parametrize("raw,want", [
    ("BATON ROUGE, US", "Baton Rouge, United States"),
    ("Markham, CA", "Markham, Canada"),          # not California
    ("Bangalore, IN", "Bangalore, India"),       # not Indiana
    ("Multiple Cities", "Multiple Cities"),
    ("Somewhere, XX", "Somewhere, XX"),
])
def test_ibm_location_spells_out_country_codes(raw, want):
    from src.adapters import ibm_careers
    assert ibm_careers.location(raw) == want


def test_ibm_posts_bounded_pages():
    bodies = []

    def handler(req):
        body = json.loads(req.content)
        bodies.append(body["from"])
        n = 100 if body["from"] == 0 else 20
        return httpx.Response(200, json={"hits": {"total": {"value": 120},
                                                  "hits": [{}] * n}})

    from src.adapters import ibm_careers
    with _client(handler) as c:
        ibm_careers.fetch_pages(c, {"slug": "careers"})
    assert bodies == [0, 100]


@pytest.mark.parametrize("url", [
    "https://careers.ibm.com/en_US/careers/JobDetail?jobId=137095",
    "https://careers.ibm.com/careers/JobDetail?jobId=137095",
    "https://ibmglobal.avature.net/en_US/careers/JobDetail?jobId=137095",
    "https://careers.ibm.com/en_US/careers/JobDetail/AI-ML-Engineer-Intern-"
    "2027-SAN-JOSE/137095",
])
def test_canonical_url_ibm_avature_variants_collapse(url):
    assert canonical_url(url) == "ats:avature:ibmglobal:137095"


def test_canonical_url_avature_other_tenant_and_search_page():
    assert canonical_url("https://siemens.avature.net/en_US/externaljobs/"
                         "JobDetail/526984") == "ats:avature:siemens:526984"
    got = canonical_url("https://careers.ibm.com/en_US/careers/SearchJobs/"
                        "?search=intern")
    assert got is not None and not got.startswith("ats:")


# ------------------------------------------------------------------ Jibe

def test_jibe_parse(fixtures):
    raw = (fixtures / "ats_jibe_amd.json").read_text(encoding="utf-8")
    jobs = _adapter().parse(raw, "jibe:careers.amd.com:AMD", TODAY)
    assert len(jobs) == 6
    assert all(j.url.startswith("https://careers.amd.com/jobs/") for j in jobs)
    assert all(j.description and "<" not in j.description for j in jobs)
    assert all(j.jd_url is None for j in jobs)
    single = next(j for j in jobs if j.locations == ["Austin, Texas, United States"])
    assert single.terms == ["Summer 2027"]
    multi = next(j for j in jobs if len(j.locations) > 2)
    assert "Boxborough, Massachusetts" in multi.locations


def test_jibe_pages_by_page_number():
    asked = []

    def handler(req):
        asked.append((req.url.params["keywords"], req.url.params["page"]))
        n = 100 if req.url.params["page"] == "1" else 5
        return httpx.Response(200, json={"totalCount": 105, "jobs": [
            {"data": {"req_id": str(i), "title": "Intern"}} for i in range(n)]})

    from src.adapters import jibe
    with _client(handler) as c:
        jibe.fetch_pages(c, {"slug": "careers.amd.com"})
    assert asked == [("intern", "1"), ("intern", "2"),
                     ("co-op", "1"), ("co-op", "2")]


@pytest.mark.parametrize("url", [
    "https://careers.amd.com/jobs/90891",
    "https://careers.amd.com/jobs/90891?icims=1",
    "https://careers.amd.com/careers-home/jobs/90891",
    "https://careers.amd.com/jobs/90891?lang=en-us",
])
def test_canonical_url_jibe_variants_collapse(url):
    assert canonical_url(url) == "ats:jibe:careers.amd.com:90891"


def test_jibe_listing_url_joins_aggregator_link(fixtures):
    raw = (fixtures / "ats_jibe_amd.json").read_text(encoding="utf-8")
    job = _adapter().parse(raw, "jibe:careers.amd.com:AMD", TODAY)[0]
    req = job.url.rsplit("/", 1)[1]
    assert canonical_url(job.url) == canonical_url(
        f"https://careers.amd.com/careers-home/jobs/{req}?icims=1")


@pytest.mark.parametrize("url", [
    "https://careers-gdms.icims.com/jobs/75637/software-engineer-intern/job",
    "https://careers-gdms.icims.com/jobs/75637/software-engineer-intern/job"
    "?in_iframe=1",
    "https://careers-gdms.icims.com/jobs/75637/job?mobile=true",
    "https://careers-gdms.icims.com/jobs/75637/login",
])
def test_canonical_url_icims_variants_collapse(url):
    assert canonical_url(url) == "ats:icims:careers-gdms:75637"


def test_canonical_url_icims_search_page_is_not_a_posting():
    got = canonical_url("https://careers-gdms.icims.com/jobs/search?ss=1")
    assert got is not None and not got.startswith("ats:")


@pytest.mark.parametrize("raw,want,country", [
    ("Markham, ON, CA", "Markham, ON, Canada", "canada"),     # not California
    ("Bengaluru, KA, IN", "Bengaluru, KA, India", "other"),   # not Indiana
    ("Redmond, WA, US", "Redmond, WA, United States", "us"),
    ("Austin, Texas", "Austin, Texas", "us"),                  # no code: as is
    ("Somewhere, ZZ", "Somewhere, ZZ", "unknown"),
])
def test_spell_country_fixes_iso_code_misreads(raw, want, country):
    from src.filters import location_country
    assert listing_http.spell_country(raw) == want
    assert location_country(want) == country


@pytest.mark.parametrize("raw", ["San Jose, CA", "Boulder, CO", "Chicago, IL"])
def test_spell_country_leaves_two_part_us_locations_alone(raw):
    # the last part of "City, ST" is a state, not Canada/Colombia/Israel
    assert listing_http.spell_country(raw) == raw


def test_missing_total_count_does_not_stop_paging_early():
    asked = []

    def handler(req):
        off = int(req.url.params["offset"])
        asked.append((req.url.params["q"], off))
        n = 100 if off < 200 else 0
        return httpx.Response(200, json={"content": _sr_page(n, 0, off)["content"]})

    with _client(handler) as c:
        sr.fetch_pages(c, {"slug": "Acme"})
    assert [a for a in asked if a[0] == "intern"] == [
        ("intern", 0), ("intern", 100), ("intern", 200)]
