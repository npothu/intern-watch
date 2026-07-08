"""Provider abstraction for the ambiguous-case classifier."""

import json

import httpx
import pytest

from src import llm
from src.models import Job


def _job(key="jr:" + "a" * 24):
    j = Job(company="Mystery Corp", title="SWE Intern", url="https://x.com/1",
            source="s", locations=["Denver, CO"])
    j.dedup_key = key
    return j


def test_api_key_env_defaults():
    assert llm.api_key_env_for({}) == "ANTHROPIC_API_KEY"
    assert llm.api_key_env_for({"provider": "gemini"}) == "GEMINI_API_KEY"
    assert llm.api_key_env_for({"provider": "gemini",
                                "api_key_env": "MY_KEY"}) == "MY_KEY"


def test_unknown_provider_raises(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    with pytest.raises(ValueError, match="unknown llm provider"):
        llm.classify([_job()], "", ["Fall 2026"], {"provider": "grok"})


def test_parse_json_array_strips_fences():
    assert llm.parse_json_array('```json\n[{"a": 1}]\n```') == [{"a": 1}]
    with pytest.raises(ValueError):
        llm.parse_json_array("no array here")


def test_gemini_end_to_end(monkeypatch):
    key = "jr:" + "b" * 24
    captured = {}

    def fake_post(url, json=None, timeout=None, headers=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["payload"] = json
        body = {"candidates": [{"content": {"parts": [{"text": __import__("json").dumps([
            {"dedup_key": key, "term": "Fall 2026", "is_top_company": True,
             "in_atlanta_metro": False, "reason": "well-known"}])}]}}]}
        return httpx.Response(200, json=body,
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(llm.httpx, "post", fake_post)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    out = llm.classify([_job(key)], "top = famous", ["Fall 2026"],
                       {"provider": "gemini"})
    assert out[key]["is_top_company"] is True
    assert out[key]["term"] == "Fall 2026"
    assert "gemini-flash-lite-latest:generateContent" in captured["url"]
    assert captured["headers"]["x-goog-api-key"] == "test-key"
    assert captured["payload"]["generationConfig"]["responseMimeType"] == "application/json"
    # the user's subjective definition reaches the prompt
    user_text = captured["payload"]["contents"][0]["parts"][0]["text"]
    assert "top = famous" in user_text and key in user_text


def test_gemini_bad_shape_raises(monkeypatch):
    def fake_post(url, **kw):
        return httpx.Response(200, json={"promptFeedback": {"blockReason": "x"}},
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(llm.httpx, "post", fake_post)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    with pytest.raises(ValueError, match="unexpected gemini response"):
        llm.classify([_job()], "", ["Fall 2026"], {"provider": "gemini"})


# ------------------------------------------------------- retry/backoff

def _http_status_error(code, retry_after=None):
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else {}
    req = httpx.Request("POST", "https://x")
    resp = httpx.Response(code, headers=headers, request=req)
    return httpx.HTTPStatusError(f"HTTP {code}", request=req, response=resp)


def test_retry_succeeds_after_transient_failures(monkeypatch):
    sleeps = []
    monkeypatch.setattr(llm.time, "sleep", lambda s: sleeps.append(s))
    calls = {"n": 0}

    def flaky(*args):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise _http_status_error(503)
        return "OK"

    out = llm._call_with_retry(flaky, "a", max_attempts=3, base_delay=1.0)
    assert out == "OK"
    assert calls["n"] == 3            # failed twice, third succeeded
    assert len(sleeps) == 2           # slept between the two retries
    # full-jitter backoff bounds: attempt 1 in [0,1), attempt 2 in [0,2)
    assert 0 <= sleeps[0] <= 1.0
    assert 0 <= sleeps[1] <= 2.0


def test_retry_gives_up_after_max_attempts(monkeypatch):
    sleeps = []
    monkeypatch.setattr(llm.time, "sleep", lambda s: sleeps.append(s))
    calls = {"n": 0}

    def always_429(*args):
        calls["n"] += 1
        raise _http_status_error(429)

    with pytest.raises(httpx.HTTPStatusError):
        llm._call_with_retry(always_429, max_attempts=3, base_delay=1.0)
    assert calls["n"] == 3            # exactly max_attempts calls
    assert len(sleeps) == 2           # no sleep after the final failure


def test_non_retryable_status_not_retried(monkeypatch):
    sleeps = []
    monkeypatch.setattr(llm.time, "sleep", lambda s: sleeps.append(s))
    calls = {"n": 0}

    def bad_request(*args):
        calls["n"] += 1
        raise _http_status_error(400)

    with pytest.raises(httpx.HTTPStatusError):
        llm._call_with_retry(bad_request, max_attempts=3, base_delay=1.0)
    assert calls["n"] == 1            # 400 is fatal: tried once, no retry
    assert sleeps == []


def test_timeout_is_retryable(monkeypatch):
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)
    calls = {"n": 0}

    def flaky(*args):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectTimeout("timed out")
        return "OK"

    assert llm._call_with_retry(flaky, max_attempts=3, base_delay=1.0) == "OK"
    assert calls["n"] == 2


def test_retry_after_header_honored(monkeypatch):
    sleeps = []
    monkeypatch.setattr(llm.time, "sleep", lambda s: sleeps.append(s))
    calls = {"n": 0}

    def flaky(*args):
        calls["n"] += 1
        if calls["n"] == 1:
            raise _http_status_error(429, retry_after=7)
        return "OK"

    assert llm._call_with_retry(flaky, max_attempts=3, base_delay=1.0) == "OK"
    assert sleeps == [7.0]            # exact server-requested wait, not jitter


def test_retry_cfg_defaults_and_overrides():
    assert llm._retry_cfg({}) == (llm.DEFAULT_RETRY_ATTEMPTS,
                                  llm.DEFAULT_RETRY_BASE_DELAY)
    assert llm._retry_cfg({"retry": {"max_attempts": 5, "base_delay": 0.25}}) \
        == (5, 0.25)
    # garbage values fall back to defaults rather than blowing up
    assert llm._retry_cfg({"retry": {"max_attempts": "oops"}}) \
        == (llm.DEFAULT_RETRY_ATTEMPTS, llm.DEFAULT_RETRY_BASE_DELAY)


def test_classify_retries_transient_then_succeeds(monkeypatch):
    """End-to-end: a transient gemini 503 is retried inside classify()."""
    key = "jr:" + "c" * 24
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    state = {"n": 0}

    def fake_post(url, json=None, timeout=None, headers=None):
        state["n"] += 1
        if state["n"] == 1:
            req = httpx.Request("POST", url)
            return httpx.Response(503, request=req)   # raise_for_status -> retry
        body = {"candidates": [{"content": {"parts": [{"text": __import__("json").dumps([
            {"dedup_key": key, "term": "Fall 2026", "is_top_company": True,
             "in_atlanta_metro": False, "reason": "ok"}])}]}}]}
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))

    monkeypatch.setattr(llm.httpx, "post", fake_post)
    out = llm.classify([_job(key)], "", ["Fall 2026"], {"provider": "gemini"})
    assert state["n"] == 2
    assert out[key]["is_top_company"] is True
