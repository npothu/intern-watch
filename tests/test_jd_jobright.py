"""Lazy jobright JD enrichment: title-only jobright rows get their info page
fetched at accept time so the grad-only/unpaid/clearance filters can fire.

The GM "2026 Fall Intern - Research & Development: AI/ML" posting is the
motivating case: its README row has no JD, but its info page's mustHave list
carries "Must be currently enrolled in a PhD program".
"""

import datetime as dt
import json
from pathlib import Path

import httpx
import pytest

from src import main
from src.adapters import jobright_page
from src.adapters.jobright_page import compose_description, fetch_description
from src.filters import jd_grad_only
from src.models import Job

ROOT = Path(__file__).parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "jobright_gm_phd_page.html"
GM_ID = "6a2c14d0fc06447490548159"
OTHER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa"
NOW = dt.datetime(2026, 6, 12, 18, 0, tzinfo=dt.UTC)

PHD_LINE = "Must be currently enrolled in a PhD program"


@pytest.fixture(autouse=True)
def _reset_build_id():
    jobright_page._build_id = None
    yield
    jobright_page._build_id = None


def _gm_html() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def _gm_job_result() -> dict:
    return json.loads(
        _gm_html().split("application/json\">", 1)[1].split("</script>", 1)[0]
    )["props"]["pageProps"]["dataSource"]["jobResult"]


def _json_route_body(job_result: dict) -> dict:
    return {"pageProps": {"dataSource": {"jobResult": job_result,
                                         "companyResult": {"companyName": "General Motors"}}}}


def _next_data_html(build_id: str, job_result: dict) -> str:
    next_data = {
        "props": {"pageProps": {"dataSource": {"jobResult": job_result}}},
        "buildId": build_id,
        "page": "/jobs/info/[id]",
        "query": {"id": GM_ID},
    }
    return ('<!doctype html><html><head></head><body><div id="__next"></div>'
            '<script id="__NEXT_DATA__" type="application/json">'
            f'{json.dumps(next_data)}</script></body></html>')


def _mock_client(handler):
    """An httpx.Client factory whose requests are served by `handler`.
    Binds the real Client up front so patching main.httpx.Client (the shared
    module global) doesn't recurse into this factory."""
    real = httpx.Client
    return lambda **kw: real(transport=httpx.MockTransport(handler), **kw)


# ----------------------------------------------------------- (a) extraction

def test_compose_description_includes_phd_line():
    job_result = _gm_job_result()
    desc = compose_description(job_result)
    assert PHD_LINE in desc
    assert "research scientists" in desc          # jobSummary folded in
    assert "novel ML models" in desc              # coreResponsibilities folded in


def test_fetch_description_parses_next_data(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert GM_ID in request.url.path
        return httpx.Response(200, text=_gm_html())

    monkeypatch.setattr(main.httpx, "Client", _mock_client(handler))
    with main.httpx.Client() as client:
        desc = fetch_description(client, GM_ID)
    assert PHD_LINE in desc


# -------------------------------------------------------- (b) filter fires

def test_jd_grad_only_true_on_fetched_gm_jd():
    job_result = _gm_job_result()
    assert jd_grad_only(compose_description(job_result)) is True


# ------------------------------------------------ (c)/(d) process-level hook

def _accepting_user_cfg():
    """Permissive config that accepts the GM job on the first pass: 'ai'
    matches include_keywords and nothing excludes it, term wanted, always-rule."""
    return {
        "name": "t",
        "eliminate": {"grad_only": True},
        "role_filter": {"include_keywords": [" ai ", "ml", "research"]},
        "terms_wanted": ["Fall 2026"],
        "unknown_term_policy": "keep",
        "rules": [{"when": {"term": ["Fall 2026"]},
                   "accept_if_any": [{"always": True}]}],
    }


def _gm_job():
    return Job(company="General Motors",
               title="2026 Fall Intern - Research & Development: AI/ML",
               url=f"https://jobright.ai/jobs/info/{GM_ID}",
               jobright_id=GM_ID, dedup_key=f"jr:{GM_ID}",
               terms=["Fall 2026"], term_confidence="explicit",
               source="jobright-eng")


def _captured_accepts(monkeypatch):
    """Make process_user surface its accepted jobs by intercepting outbox_add."""
    added: list = []
    monkeypatch.setattr(main.st, "outbox_add",
                        lambda state, name, item: added.append(item))
    return added


def test_accepted_jobright_grad_only_dropped_after_fetch(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_gm_html())

    monkeypatch.setattr(main.httpx, "Client", _mock_client(handler))
    added = _captured_accepts(monkeypatch)
    cfg = {**_accepting_user_cfg(),
           "notify": {"email": {"send_at_utc": [18]}}}
    state = main.st.empty_state()
    enricher = main._JobrightEnricher()

    main.process_user(cfg, [_gm_job()], state, dry_run=False, now=NOW,
                      send_now=True, enricher=enricher)
    enricher.close()
    # the PhD-only posting must not reach the outbox / notification
    assert added == []


def test_fetch_failure_keeps_jobright_job_accepted(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)        # jobright down / HTML changed

    monkeypatch.setattr(main.httpx, "Client", _mock_client(handler))
    added = _captured_accepts(monkeypatch)
    cfg = {**_accepting_user_cfg(),
           "notify": {"email": {"send_at_utc": [18]}}}
    state = main.st.empty_state()
    enricher = main._JobrightEnricher()

    main.process_user(cfg, [_gm_job()], state, dry_run=False, now=NOW,
                      send_now=True, enricher=enricher)
    enricher.close()
    # fail open: no JD means the existing (passing) verdict stands
    assert len(added) == 1
    assert added[0]["company"] == "General Motors"


def test_no_enricher_leaves_accepts_untouched(monkeypatch):
    """Callers that don't pass an enricher (e.g. older tests) are unaffected."""
    added = _captured_accepts(monkeypatch)
    cfg = {**_accepting_user_cfg(),
           "notify": {"email": {"send_at_utc": [18]}}}
    state = main.st.empty_state()

    main.process_user(cfg, [_gm_job()], state, dry_run=False, now=NOW,
                      send_now=True, enricher=None)
    assert len(added) == 1


# --------------------------------------------- (e) JSON route + buildId cache

def test_fetch_description_uses_json_route_when_build_id_cached():
    jobright_page._build_id = "4aO752QtDYrFh5BF6Ebhg"
    job_result = _gm_job_result()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert "/_next/data/4aO752QtDYrFh5BF6Ebhg/jobs/info/" in str(request.url)
        return httpx.Response(200, json=_json_route_body(job_result))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    desc = fetch_description(client, GM_ID)
    client.close()

    assert PHD_LINE in desc
    assert len(requests) == 1


def test_fetch_description_cold_start_discovers_build_id_from_html():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, text=_next_data_html("build-1", _gm_job_result()))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    desc = fetch_description(client, GM_ID)
    client.close()

    assert PHD_LINE in desc
    assert len(requests) == 1
    assert "_next/data" not in str(requests[0].url)
    assert jobright_page._build_id == "build-1"


def test_stale_build_id_falls_back_to_html_then_refreshes_for_next_call():
    jobright_page._build_id = "stale-build"
    job_result = _gm_job_result()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        url = str(request.url)
        if "_next/data/stale-build" in url:
            return httpx.Response(404)
        if "_next/data/fresh-build" in url:
            return httpx.Response(200, json=_json_route_body(job_result))
        return httpx.Response(200, text=_next_data_html("fresh-build", job_result))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    desc = fetch_description(client, GM_ID)

    assert PHD_LINE in desc
    assert len(requests) == 2
    assert "_next/data/stale-build" in str(requests[0].url)
    assert "_next/data" not in str(requests[1].url)
    assert jobright_page._build_id == "fresh-build"

    desc2 = fetch_description(client, OTHER_ID)
    client.close()

    assert PHD_LINE in desc2
    assert len(requests) == 3
    assert "_next/data/fresh-build" in str(requests[2].url)


def test_both_routes_failing_is_a_miss_the_caller_can_handle():
    jobright_page._build_id = "stale-build"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        fetch_description(client, GM_ID)
    client.close()


def test_job_result_extracts_from_both_payload_shapes():
    job_result = _gm_job_result()
    html_shape = {"props": {"pageProps": {"dataSource": {"jobResult": job_result}}}}
    json_shape = {"pageProps": {"dataSource": {"jobResult": job_result}}}

    desc_from_html_shape = compose_description(jobright_page._job_result(html_shape))
    desc_from_json_shape = compose_description(jobright_page._job_result(json_shape))

    assert desc_from_html_shape == desc_from_json_shape
    assert PHD_LINE in desc_from_html_shape
