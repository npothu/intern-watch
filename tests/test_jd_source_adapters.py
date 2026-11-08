"""JD adapters for JS-rendered boards (Oracle CX / Eightfold / Apple / iCIMS /
Phenom) and Avature's 202 -- the Python twin of
convex/jd_acquire_adapters.test.ts, over the same recorded fixtures."""

import json
from pathlib import Path
from types import SimpleNamespace

import httpx

from src.resume import jd_source

FIX = Path(__file__).parent / "fixtures" / "jd"


def _text(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


def _json(name: str):
    return json.loads(_text(name))


def _client(routes: dict[str, httpx.Response]) -> tuple[httpx.Client, list[str]]:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen.append(url)
        return routes.get(url, httpx.Response(404, text="not found"))

    return httpx.Client(transport=httpx.MockTransport(handler)), seen


def test_oracle_api_for_matches_the_working_feed_shape():
    kind, api = jd_source._ats_api_for(
        "https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19813")
    assert kind == "oracle"
    assert api == ("https://ehtl.fa.us6.oraclecloud.com/hcmRestApi/resources/latest/"
                   "recruitingCEJobRequisitionDetails?expand=all&onlyData=true"
                   "&finder=ById;Id=%2219813%22,siteNumber=CX")
    _, no_site = jd_source._ats_api_for(
        "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/job/334345/")
    assert no_site.endswith("finder=ById;Id=%22334345%22")
    assert jd_source._ats_api_for(
        "https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/jobs") is None


def test_eightfold_and_apple_api_for():
    assert jd_source._ats_api_for(
        "https://apply.careers.microsoft.com/careers/job/1970393556972687") == (
        "eightfold", "https://apply.careers.microsoft.com/api/apply/v2/jobs/1970393556972687")
    assert jd_source._ats_api_for("https://acme.eightfold.ai/careers?pid=563808972035923")[1] == (
        "https://acme.eightfold.ai/api/apply/v2/jobs/563808972035923")
    assert jd_source._ats_api_for("https://acme.eightfold.ai/careers?query=intern") is None
    assert jd_source._ats_api_for(
        "https://jobs.apple.com/en-us/details/200676912-3715/software-engineering-intern") == (
        "apple", "https://jobs.apple.com/api/v1/jobDetails/200676912-3715")


def test_payloads_from_recorded_fixtures():
    oracle = jd_source._jd_from_ats_payload("oracle", _json("oracle_cx_detail.json"))
    assert "Firmware" in oracle and "<p" not in oracle
    assert jd_source._jd_from_ats_payload("oracle", _json("oracle_cx_empty.json")) is None
    assert "Microsoft" in jd_source._jd_from_ats_payload("eightfold", _json("eightfold_job.json"))
    apple = jd_source._jd_from_ats_payload("apple", _json("apple_job.json"))
    assert "Minimum Qualifications" in apple and "Preferred Qualifications" in apple


def test_phenom_ddo_is_an_embedded_description():
    got = jd_source._embedded_description(_text("phenom_job.html"))
    assert got and "Splunk" in got


def test_icims_scrape_fetches_the_iframe_page():
    url = ("https://campus-americas.icims.com/jobs/26272/"
           "data-engineer-intern%2c-2027-summer-u.s./job")
    frame = jd_source._page_fetch_url(url)
    assert frame.endswith("in_iframe=1")
    assert jd_source._page_fetch_url(frame) == frame
    client, seen = _client({frame: httpx.Response(200, text=_text("icims_iframe.html"))})
    got = jd_source._generic_scrape(client, url)
    assert got and "Atlassian" in got
    assert seen == [frame]


def test_icims_ua_is_the_crawler_ua_for_both_url_forms():
    url = ("https://campus-americas.icims.com/jobs/26272/"
           "data-engineer-intern%2c-2027-summer-u.s./job")
    frame = jd_source._page_fetch_url(url)
    for given in (url, frame):  # rewritten, and pasted already-framed
        agents: list[str] = []

        def handler(request: httpx.Request, agents: list[str] = agents) -> httpx.Response:
            agents.append(request.headers["user-agent"])
            return httpx.Response(200, text=_text("icims_iframe.html"))

        client = httpx.Client(transport=httpx.MockTransport(handler))
        assert jd_source._generic_scrape(client, given)
        assert agents == [jd_source._CRAWLER_UA], given
    # Non-iCIMS pages keep the browser UA.
    agents = []
    client = httpx.Client(transport=httpx.MockTransport(
        lambda r: agents.append(r.headers["user-agent"]) or httpx.Response(200, text="<p>x</p>")))
    jd_source._generic_scrape(client, "https://example.com/jobs/1")
    assert agents == [jd_source._PAGE_UA]


def test_oracle_custom_domain_page_hint():
    url = "https://careers.example.com/en/sites/CX_1/job/26011082"
    api = jd_source._oracle_api_url("egug.fa.us2.oraclecloud.com", "CX_1", "26011082")
    page = _text("oracle_custom_domain_page.html")
    assert jd_source._oracle_api_from_page(url, page) == ("oracle", api)
    client, _ = _client({
        url: httpx.Response(200, text=_text("oracle_custom_domain_page.html")),
        api: httpx.Response(200, json=_json("oracle_cx_detail.json")),
    })
    got = jd_source._generic_scrape(client, url)
    assert got and "Firmware" in got


def test_oracle_page_hint_runs_before_the_blocked_page_tells():
    url = "https://careers.example.com/en/sites/CX_1/job/26011082"
    api = jd_source._oracle_api_url("egug.fa.us2.oraclecloud.com", "CX_1", "26011082")
    shell = _text("oracle_custom_domain_page.html").replace(
        "<head>", "<head><noscript>Please enable JavaScript to use this site</noscript>")
    client, _ = _client({
        url: httpx.Response(200, text=shell),
        api: httpx.Response(200, json=_json("oracle_cx_detail.json")),
    })
    got = jd_source._generic_scrape(client, url)
    assert got and "Firmware" in got


def test_avature_202_is_a_miss_not_a_jd():
    url = "https://careers.example.com/en_US/careers/JobDetail?jobId=137214"
    waf = httpx.Response(202, text="", headers={"x-amzn-waf-action": "challenge"})
    client, _ = _client({url: waf})
    assert jd_source._generic_scrape(client, url) is None


def test_acquire_jd_prefers_the_oracle_feed():
    url = "https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19813"
    _, api = jd_source._ats_api_for(url)
    client, seen = _client({api: httpx.Response(200, json=_json("oracle_cx_detail.json"))})
    job = SimpleNamespace(description=None, jd_url=None, url=url, jobright_id=None, dedup_key="k")
    got = jd_source.acquire_jd(job, client=client)
    assert got and "Firmware" in got
    assert seen == [api]
