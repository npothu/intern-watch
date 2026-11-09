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


def test_request_retries_429_with_backoff_then_raises(no_sleep):
    hits = []

    def handler(req):
        hits.append(1)
        return httpx.Response(429)

    with _client(handler) as c, pytest.raises(httpx.HTTPStatusError):
        listing_http.request_text(c, listing_http.Pacer(), "https://x.example/")
    assert len(hits) == 1 + listing_http.RATE_LIMIT_RETRIES
    assert no_sleep == [5.0, 10.0, 20.0]


def test_request_honours_retry_after_then_succeeds(no_sleep):
    answers = [httpx.Response(429, headers={"Retry-After": "7"}),
               httpx.Response(429, headers={"Retry-After": "999"}),
               httpx.Response(200, text="ok")]

    with _client(lambda req: answers.pop(0)) as c:
        assert listing_http.request_text(
            c, listing_http.Pacer(), "https://x.example/") == "ok"
    assert no_sleep == [7.0, listing_http.RETRY_AFTER_MAX]


def test_request_5xx_gets_one_retry(no_sleep):
    hits = []

    def handler(req):
        hits.append(1)
        return httpx.Response(503)

    with _client(handler) as c, pytest.raises(httpx.HTTPStatusError):
        listing_http.request_text(c, listing_http.Pacer(), "https://x.example/")
    assert len(hits) == 2


def test_board_time_budget_stops_backoff(monkeypatch, no_sleep):
    clock = {"t": 0.0}
    monkeypatch.setattr(listing_http, "monotonic", lambda: clock["t"])
    monkeypatch.setattr(listing_http, "sleep",
                        lambda s: clock.__setitem__("t", clock["t"] + s))

    def handler(req):
        return httpx.Response(429, headers={"Retry-After": "60"})

    pacer = listing_http.Pacer(budget=100)
    with _client(handler) as c, pytest.raises(listing_http.IncompleteListing,
                                              match="budget"):
        listing_http.request_text(c, pacer, "https://x.example/")
    assert clock["t"] == 60.0          # the second 60s wait would pass 100s


def test_page_cap_override_and_garbage():
    assert listing_http.page_cap({}) == listing_http.MAX_PAGES
    assert listing_http.page_cap({"max_pages": 2}) == 2
    assert listing_http.page_cap({"max_pages": "x"}) == listing_http.MAX_PAGES
    assert listing_http.page_cap({"max_pages": 100000}) == listing_http.PAGE_CAP_CEILING


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
    "https://EGUG.FA.us2.oraclecloud.com/hcmUI/CandidateExperience/en-US/"
    "sites/CX_1/requisitions/preview/26011784",
    "https://careers.americanexpress.com/en/sites/CX_1/job/26011784",
])
def test_canonical_url_oracle_variants_collapse(url):
    assert canonical_url(url) == "ats:oracle:egug.fa.us2.oraclecloud.com:26011784"


def test_canonical_url_oracle_pods_stay_apart_and_ids_keep_case():
    a = canonical_url("https://edbz.fa.us2.oraclecloud.com/hcmUI/"
                      "CandidateExperience/en/sites/CX/job/240001HW")
    b = canonical_url("https://egup.fa.us2.oraclecloud.com/hcmUI/"
                      "CandidateExperience/en/sites/CX/job/240001HW")
    assert a == "ats:oracle:edbz.fa.us2.oraclecloud.com:240001HW"
    assert b == "ats:oracle:egup.fa.us2.oraclecloud.com:240001HW"
    # the same pod label in another data centre is a different pod
    assert canonical_url("https://edbz.fa.em2.oraclecloud.com/hcmUI/"
                         "CandidateExperience/en/sites/CX/job/240001HW") != a
    # ids are not case-folded: a case-distinct id is not assumed equal
    assert canonical_url("https://edbz.fa.us2.oraclecloud.com/hcmUI/"
                         "CandidateExperience/en/sites/CX/job/240001hw") != a
    # no-site form some sites link
    assert canonical_url("https://eeho.fa.us2.oraclecloud.com/hcmUI/"
                         "CandidateExperience/en/job/334345/") == (
        "ats:oracle:eeho.fa.us2.oraclecloud.com:334345")


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
                                                  "hits": [{"_id": f"{body['from']}-{i}"}
                                                           for i in range(n)]}})

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
        page = int(req.url.params["page"])
        n = 100 if page == 1 else 5
        return httpx.Response(200, json={"totalCount": 105, "jobs": [
            {"data": {"req_id": str(page * 1000 + i), "title": "Intern"}}
            for i in range(n)]})

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



def test_sr_listing_and_api_detail_urls_of_one_posting_join(fixtures):
    raw = (fixtures / "ats_smartrecruiters_visa.json").read_text(encoding="utf-8")
    job = _adapter().parse(raw, "smartrecruiters:Visa:Visa", TODAY)[0]
    assert job.jd_url and canonical_url(job.url) == canonical_url(job.jd_url)
    assert canonical_url(job.url).startswith("ats:sr:visa:")


@pytest.mark.parametrize("url", [
    "https://jobs.smartrecruiters.com/Acme/3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "https://careers.smartrecruiters.com/acme/"
    "3FA85F64-5717-4562-B3FC-2C963F66AFA6-some-title",
    "https://api.smartrecruiters.com/v1/companies/ACME/postings/"
    "3fa85f64-5717-4562-b3fc-2c963f66afa6",
])
def test_canonical_url_smartrecruiters_uuid_ids(url):
    assert canonical_url(url) == (
        "ats:sr:acme:3fa85f64-5717-4562-b3fc-2c963f66afa6")


def test_canonical_url_smartrecruiters_companies_stay_apart():
    a = canonical_url("https://jobs.smartrecruiters.com/AECOM2/744000155565444")
    b = canonical_url("https://jobs.smartrecruiters.com/Other/744000155565444")
    assert a == "ats:sr:aecom2:744000155565444" and a != b


@pytest.mark.parametrize("url", [
    "https://app.eightfold.ai/careers?domain=qualcomm.com&pid=446721230796",
    "https://app.eightfold.ai/careers/job/446721230796?domain=Qualcomm.com",
    "https://qualcomm.eightfold.ai/careers/job/446721230796",
])
def test_canonical_url_eightfold_shared_host_takes_tenant_from_domain(url):
    assert canonical_url(url) == "ats:eightfold:qualcomm:446721230796"


def test_canonical_url_eightfold_shared_host_without_domain_is_not_a_token():
    got = canonical_url("https://app.eightfold.ai/careers?pid=446721230796")
    assert got is not None and not got.startswith("ats:")


def test_jibe_honours_amd_crawl_delay(no_sleep):
    def handler(req):
        return httpx.Response(200, json={"totalCount": 0, "jobs": []})

    from src.adapters import jibe
    with _client(handler) as c:
        jibe.fetch_pages(c, {"slug": "careers.amd.com"})
    assert no_sleep == [5.0]          # 2 queries: one wait between them


def test_canonical_url_smartrecruiters_digit_leading_uuid_is_not_a_numeric_id():
    uuid = "12345678-5717-4562-b3fc-2c963f66afa6"
    listing = canonical_url(f"https://jobs.smartrecruiters.com/Acme/{uuid}")
    api = canonical_url(
        f"https://api.smartrecruiters.com/v1/companies/Acme/postings/{uuid}")
    assert listing == api == f"ats:sr:acme:{uuid}"
    assert canonical_url("https://jobs.smartrecruiters.com/Acme/12345678") != listing
    assert canonical_url("https://jobs.smartrecruiters.com/Acme/12345678-"
                         "aaaa-bbbb-cccc-dddddddddddd") not in (listing, None)
    # a numeric id with a title slug still keeps only the number
    assert canonical_url("https://jobs.smartrecruiters.com/Acme/744000149367234-"
                         "software-intern") == "ats:sr:acme:744000149367234"


# ----------------------------------------- complete-or-nothing listings

def _sr_body(n, total, off):
    return {"totalFound": total, "content": [
        {"id": str(744000000000 + off + i), "name": "Software Intern"}
        for i in range(n)]}


def _oracle_body(n, total, off):
    return {"items": [{"TotalJobsCount": total, "requisitionList": [
        {"Id": str(off + i), "Title": "Software Intern"} for i in range(n)]}]}


def _eightfold_body(n, total, off):
    return {"data": {"count": total, "positions": [
        {"id": off + i, "name": "Software Intern"} for i in range(n)]}}


def _ibm_body(n, total, off):
    return {"hits": {"total": {"value": total}, "hits": [
        {"_source": {"title": "Software Intern",
                     "url": f"https://careers.ibm.com/careers/JobDetail?jobId={off + i}"}}
        for i in range(n)]}}


def _jibe_body(n, total, off):
    return {"totalCount": total, "jobs": [
        {"data": {"req_id": str(off + i), "title": "Software Intern"}}
        for i in range(n)]}


def _offset(req, ats):
    if ats == "smartrecruiters":
        return int(req.url.params["offset"])
    if ats == "oracle":
        return int(req.url.params["finder"].split("offset=")[1].split(",")[0])
    if ats == "eightfold":
        return int(req.url.params["start"])
    if ats == "ibm":
        return json.loads(req.content)["from"]
    return (int(req.url.params["page"]) - 1) * 100


# ats -> (board row, page size, body builder)
LISTERS = {
    "smartrecruiters": ({"slug": "Acme"}, 100, _sr_body),
    "oracle": ({"slug": ORACLE_SLUG}, 100, _oracle_body),
    "eightfold": ({"slug": MS_SLUG}, 10, _eightfold_body),
    "ibm": ({"slug": "careers"}, 100, _ibm_body),
    "jibe": ({"slug": "careers.amd.com"}, 100, _jibe_body),
}


def _lister(ats):
    from src.adapters.ats_boards import _LISTERS
    return _LISTERS[ats]


@pytest.mark.parametrize("ats", sorted(LISTERS))
def test_lister_reads_to_the_stated_total(ats):
    board, size, body = LISTERS[ats]
    total = 2 * size + 3

    def handler(req):
        off = _offset(req, ats)
        return httpx.Response(200, json=body(min(size, total - off), total, off))

    with _client(handler) as c:
        pages = _lister(ats)(c, board)
    per_query = 3                       # two full pages + the short last one
    assert len(pages) % per_query == 0 and len(pages) >= per_query


@pytest.mark.parametrize("ats", sorted(LISTERS))
def test_lister_short_page_before_total_raises(ats):
    from src.adapters.listing_http import IncompleteListing
    board, size, body = LISTERS[ats]

    def handler(req):
        off = _offset(req, ats)
        # claims 5 pages but the second one comes back short
        return httpx.Response(200, json=body(size if off == 0 else 3,
                                             5 * size, off))

    with _client(handler) as c, pytest.raises(IncompleteListing):
        _lister(ats)(c, board)


@pytest.mark.parametrize("ats", sorted(LISTERS))
def test_lister_page_cap_raises(ats):
    from src.adapters.listing_http import IncompleteListing
    board, size, body = LISTERS[ats]

    def handler(req):
        return httpx.Response(200, json=body(size, 10_000 * size,
                                             _offset(req, ats)))

    with _client(handler) as c, pytest.raises(IncompleteListing, match="cap"):
        _lister(ats)(c, {**board, "max_pages": 2})


@pytest.mark.parametrize("ats", sorted(LISTERS))
def test_lister_failed_page_raises(ats):
    board, size, body = LISTERS[ats]

    def handler(req):
        off = _offset(req, ats)
        if off:
            return httpx.Response(503)
        return httpx.Response(200, json=body(size, 3 * size, off))

    with _client(handler) as c, pytest.raises(httpx.HTTPStatusError):
        _lister(ats)(c, board)


@pytest.mark.parametrize("ats", ["oracle", "eightfold", "jibe"])
def test_page_without_interns_is_not_the_end(ats):
    board, size, body = LISTERS[ats]
    offsets = []

    def handler(req):
        off = _offset(req, ats)
        offsets.append(off)
        data = body(size if off < 2 * size else 5, 2 * size + 5, off)
        if off == size:                  # a whole page of non-interns ...
            rows = (data.get("items", [{}])[0].get("requisitionList")
                    or (data.get("data") or {}).get("positions")
                    or data.get("jobs"))
            for r in rows:
                for k in ("Title", "name"):
                    if k in r:
                        r[k] = "Internal Auditor"
                if "data" in r:
                    r["data"]["title"] = "Internal Auditor"
        return httpx.Response(200, json=data)   # ... then one more intern

    with _client(handler) as c:
        _lister(ats)(c, board)
    assert 2 * size in offsets


def test_incomplete_board_returns_no_rows_and_is_not_recorded(
        tmp_path, monkeypatch):
    boards = tmp_path / "boards.yaml"
    boards.write_text(
        "boards:\n"
        "- {company: Short, ats: smartrecruiters, slug: Short}\n"
        "- {company: Acme, ats: smartrecruiters, slug: Acme}\n")
    monkeypatch.setattr("src.adapters.ats_boards.ROOT", tmp_path)

    def handler(req):
        off = int(req.url.params["offset"])
        if "/Short/" in req.url.path:
            return httpx.Response(200, json=_sr_body(100 if off == 0 else 7,
                                                     900, off))
        q = req.url.params["q"]
        return httpx.Response(200, json=_sr_body(2 if q == "intern" else 0,
                                                 2 if q == "intern" else 0, off))

    adapter = AtsBoardsAdapter(SourceConfig(
        name="ats-boards", adapter="ats_boards", boards_file="boards.yaml"))
    with _client(handler) as c:
        jobs = adapter.fetch(c, TODAY)
    assert {j.company for j in jobs} == {"Acme"}
    assert set(adapter.fetched_boards) == {"smartrecruiters:acme"}
    assert all(j.board == "smartrecruiters:acme" for j in jobs)


def _pager_fetch(pages_by_offset, total):
    def fetch(offset):
        ids = pages_by_offset.get(offset, [])
        return json.dumps(ids), ids, total
    return fetch


def test_page_through_repeated_rows_under_total_raise():
    # 3 pages of 2 reach the stated 5 in rows, but one id repeats
    fetch = _pager_fetch({0: ["a", "b"], 2: ["c", "a"], 4: ["e"]}, 5)
    with pytest.raises(listing_http.IncompleteListing, match="distinct"):
        listing_http.page_through(fetch, page_size=2, cap=9, what="t")
    got = listing_http.page_through(fetch, page_size=2, cap=9, what="t",
                                    unique=False)
    assert got.ids == {"a", "b", "c", "e"} and got.total == 5


def test_page_through_slack_accepts_a_stated_total_the_feed_never_lists():
    fetch = _pager_fetch({0: ["a", "b"], 2: ["c"]}, 4)
    with pytest.raises(listing_http.IncompleteListing):
        listing_http.page_through(fetch, page_size=2, cap=9, what="t")
    got = listing_http.page_through(fetch, page_size=2, cap=9, what="t",
                                    slack=1)
    assert got.ids == {"a", "b", "c"}


def test_page_through_warns_past_three_quarters_of_the_cap(caplog):
    fetch = _pager_fetch({i: [str(i)] for i in range(4)}, 4)
    with caplog.at_level("WARNING"):
        listing_http.page_through(fetch, page_size=1, cap=5, what="board-x")
    assert "board-x: used 4 of 5 pages" in caplog.text


def test_eightfold_sorts_by_timestamp_and_recovers_tie_reorders():
    from src.adapters import eightfold
    total = 26                     # ids 0..25
    # Unstable ties: the first pass (start 0) repeats 9 and 20 and never
    # shows 10 or 15; the half-page-shifted pass (start 5) shows both.
    first = {0: list(range(0, 10)),
             10: [9] + list(range(11, 15)) + list(range(16, 21)),
             20: [20] + list(range(21, 26))}
    shifted = {5: list(range(5, 15)), 15: list(range(15, 25)), 25: [25]}
    asked = []

    def handler(req):
        assert req.url.params["sort_by"] == "timestamp"
        if req.url.params["query"] == "co-op":
            return httpx.Response(200, json={"data": {"count": 0,
                                                      "positions": []}})
        start = int(req.url.params["start"])
        asked.append(start)
        ids = (first if start % 10 == 0 else shifted).get(start, [])
        return httpx.Response(200, json={"data": {"count": total,
                                                  "positions": [
            {"id": i, "name": "Intern"} for i in ids]}})

    with _client(handler) as c:
        eightfold.fetch_pages(c, {"slug": MS_SLUG})
    assert asked == [0, 10, 20, 5, 15, 25]


def test_eightfold_still_short_after_shifted_pass_raises():
    from src.adapters import eightfold

    def handler(req):
        start = int(req.url.params["start"])
        ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] if start < 20 else [1]
        return httpx.Response(200, json={"data": {"count": 21, "positions": [
            {"id": i, "name": "Intern"} for i in ids]}})

    with _client(handler) as c, pytest.raises(listing_http.IncompleteListing,
                                              match="shifted"):
        eightfold.fetch_pages(c, {"slug": MS_SLUG})


def test_oracle_sorts_by_posting_date_and_tolerates_two_unlisted_rows():
    from src.adapters import oracle_cx

    def handler(req):
        finder = req.url.params["finder"]
        assert "sortBy=POSTING_DATES_DESC" in finder
        off = int(finder.split("offset=")[1].split(",")[0])
        n = 100 if off == 0 else 92
        return httpx.Response(200, json={"items": [{
            "TotalJobsCount": 194, "requisitionList": [
                {"Id": str(off + i), "Title": "Intern"} for i in range(n)]}]})

    with _client(handler) as c:
        pages = oracle_cx.fetch_pages(c, {"slug": ORACLE_SLUG})
    assert len(pages) == 4                     # 2 pages x 2 queries


@pytest.mark.parametrize("url", [
    "https://careers.amd.com/jobs/91238",
    "https://campus-amd.icims.com/jobs/91238/login",
    "https://campus-amd.icims.com/jobs/91238/some-title/job?in_iframe=1",
])
def test_amd_icims_apply_link_joins_its_jibe_posting(url):
    assert canonical_url(url) == "ats:jibe:careers.amd.com:91238"


def test_other_icims_portals_keep_their_own_token():
    assert canonical_url("https://careers-gdms.icims.com/jobs/75637/login") == (
        "ats:icims:careers-gdms:75637")


def test_slack_never_stops_on_a_full_page():
    # total 7 with slack 2: a full page reaching 6 must not end the query
    asked = []

    def fetch(offset):
        asked.append(offset)
        ids = [str(offset + i) for i in range(3 if offset < 6 else 1)]
        return "", ids, 7

    got = listing_http.page_through(fetch, page_size=3, cap=9, what="t",
                                    slack=2)
    assert asked == [0, 3, 6] and len(got.ids) == 7


def test_slack_needs_both_raw_and_distinct_shortfall_within_it():
    # stops short by 1 row, but only 3 distinct of a stated 6
    fetch = _pager_fetch({0: ["a", "b", "c"], 3: ["a", "a"]}, 6)
    with pytest.raises(listing_http.IncompleteListing, match="distinct"):
        listing_http.page_through(fetch, page_size=3, cap=9, what="t", slack=2)


def test_blank_ids_do_not_count_as_postings():
    # 3 rows reach the stated 3, but one has no id: 2 distinct postings
    fetch = _pager_fetch({0: ["a", "", "b"]}, 3)
    with pytest.raises(listing_http.IncompleteListing, match="distinct"):
        listing_http.page_through(fetch, page_size=3, cap=9, what="t")


def test_eightfold_union_ignores_rows_without_an_id():
    from src.adapters import eightfold

    def handler(req):
        start = int(req.url.params["start"])
        # 11 stated; every pass shows ids 0..9 plus one row without an id
        rows = ([{"id": i, "name": "Intern"} for i in range(10)]
                if start in (0, 5) else [{"name": "Intern"}])
        return httpx.Response(200, json={"data": {"count": 11,
                                                  "positions": rows}})

    with _client(handler) as c, pytest.raises(listing_http.IncompleteListing,
                                              match="shifted"):
        eightfold.fetch_pages(c, {"slug": MS_SLUG})


def test_retry_after_http_date(monkeypatch):
    import datetime as dt
    from email.utils import format_datetime
    when = dt.datetime.now(dt.UTC) + dt.timedelta(seconds=30)
    resp = httpx.Response(429, headers={"Retry-After": format_datetime(when, usegmt=True)})
    assert 25 <= listing_http._retry_after(resp, 1) <= 30
    past = httpx.Response(429, headers={"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"})
    assert listing_http._retry_after(past, 1) == 0.0
    junk = httpx.Response(429, headers={"Retry-After": "soon"})
    assert listing_http._retry_after(junk, 2) == listing_http.RETRY_DELAY * 2


def test_eightfold_rows_keep_id_zero():
    from src.adapters import eightfold
    data = {"data": {"positions": [{"id": 0, "name": "Intern"},
                                   {"name": "No id"}]}}
    out = eightfold.rows(data, MS_SLUG)
    assert [r[1].rsplit("/", 1)[1] for r in out] == ["0"]


def test_ibm_query_sort_is_deterministic():
    from src.adapters import ibm_careers
    assert ibm_careers.query_body(0)["sort"] == [{"dcdate": "desc"},
                                                 {"_id": "asc"}]
