from pathlib import Path
import json
import httpx
import pytest

from src.adapters import jobright_page
from src.adapters.jobright_auth import JobrightSession

EMPLOYER_URL = "https://boards.greenhouse.io/acme/jobs/9"


def _job_result(apply_link, original_url=None):
    return {
        "jobSummary": "some summary",
        "qualifications": {"mustHave": ["x"]},
        "applyLink": apply_link,
        "originalUrl": original_url or apply_link,
    }


@pytest.fixture(autouse=True)
def _reset_build_id():
    jobright_page._build_id = None
    yield
    jobright_page._build_id = None


def _make_session(handler, tmp_path, cap=25, cookie=None):
    s = JobrightSession("a@b.c", "pw",
                        session_path=tmp_path / "jobright_session.json",
                        cap=cap)
    s._client.close()
    s._client = httpx.Client(transport=httpx.MockTransport(handler))
    if cookie:
        s._client.cookies.set("SESSION_ID", cookie)
    return s


def _login_ok(request):
    return httpx.Response(200, json={"errorCode": 10000},
                          headers={"set-cookie": "SESSION_ID=tok123"})


def test_from_env_missing_returns_none(monkeypatch):
    monkeypatch.delenv("JOBRIGHT_EMAIL", raising=False)
    monkeypatch.delenv("JOBRIGHT_PASSWORD", raising=False)
    assert JobrightSession.from_env() is None


def test_login_persists_session_cookie(tmp_path):
    requests = []

    def handler(request):
        requests.append(request)
        return _login_ok(request)

    s = _make_session(handler, tmp_path)
    assert s.login() is True
    data = json.loads(s.session_path.read_text())
    assert data["cookies"]["SESSION_ID"] == "tok123"
    assert len(requests) == 1


def test_resolve_apply_url_strips_utm(tmp_path):
    jobright_page._build_id = "b1"
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.startswith("/swan/auth"):
            return _login_ok(request)
        return httpx.Response(200, json={
            "pageProps": {"dataSource": {"jobResult": _job_result(
                EMPLOYER_URL + "?utm_source=jobright")}}})

    s = _make_session(handler, tmp_path, cookie="tok")
    assert s.resolve_apply_url("abc") == EMPLOYER_URL
    assert len(requests) == 1


def test_expired_session_relogins_once_and_retries(tmp_path):
    jobright_page._build_id = "b1"
    requests = []
    data_calls = {"n": 0}

    def handler(request):
        requests.append(request)
        if request.url.path.startswith("/swan/auth"):
            return _login_ok(request)
        data_calls["n"] += 1
        link = None if data_calls["n"] == 1 else EMPLOYER_URL
        return httpx.Response(200, json={
            "pageProps": {"dataSource": {"jobResult": _job_result(link)}}})

    s = _make_session(handler, tmp_path, cookie="expired")
    assert s.resolve_apply_url("abc") == EMPLOYER_URL
    assert data_calls["n"] == 2
    assert len(requests) == 3


def test_rejected_credentials_disable_no_further_requests(tmp_path):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(401)

    s = _make_session(handler, tmp_path)
    assert s.resolve_apply_url("abc") is None
    assert s.disabled is True
    assert s.auth_failed_msg
    assert len(requests) == 1


def test_transport_raising_makes_resolve_none(tmp_path):
    jobright_page._build_id = "b1"

    def handler(request):
        raise httpx.ConnectError("down", request=request)

    s = _make_session(handler, tmp_path, cookie="tok")
    assert s.resolve_apply_url("abc") is None


def test_cap_is_honoured(tmp_path):
    jobright_page._build_id = "b1"
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={
            "pageProps": {"dataSource": {"jobResult": _job_result(
                EMPLOYER_URL)}}})

    s = _make_session(handler, tmp_path, cap=1, cookie="tok")
    assert s.resolve_apply_url("one") == EMPLOYER_URL
    assert s.resolve_apply_url("two") is None
    assert len(requests) == 1


def test_miss_is_memoised(tmp_path):
    jobright_page._build_id = "b1"
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(500)

    s = _make_session(handler, tmp_path, cookie="tok")
    assert s.resolve_apply_url("abc") is None
    n = len(requests)
    assert s.resolve_apply_url("abc") is None
    assert len(requests) == n


def test_applylink_jobright_ai_rejected(tmp_path):
    jobright_page._build_id = "b1"
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={
            "pageProps": {"dataSource": {"jobResult": _job_result(
                "https://jobright.ai/jobs/info/abc?utm_source=jobright")}}})

    s = _make_session(handler, tmp_path, cookie="tok")
    assert s.resolve_apply_url("abc") is None
    assert len(requests) == 1
