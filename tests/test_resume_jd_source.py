"""acquire_jd 4-tier fallback: each tier, the short-result miss, fail-open.

No real network: httpx clients and fetch_description are monkeypatched.
"""

from __future__ import annotations

import json

import pytest

from src.models import Job
from src.resume import jd_source


def _job(**kw) -> Job:
    base = {"company": "Acme", "title": "SWE Intern",
            "url": "https://acme.test/job", "source": "dashboard",
            "dedup_key": "jr:" + "0" * 24}
    base.update(kw)
    return Job(**base)


class FakeResp:
    def __init__(self, *, text="", payload=None, status_ok=True):
        self.text = text
        self._payload = payload
        self._ok = status_ok

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self._ok:
            raise RuntimeError("HTTP error")


class FakeClient:
    """Records GETs and replies from a url->FakeResp map (or raises)."""

    def __init__(self, responses: dict):
        self.responses = responses
        self.calls: list[str] = []
        self.closed = False

    def get(self, url, **kw):
        self.calls.append(url)
        resp = self.responses[url]
        if isinstance(resp, Exception):
            raise resp
        return resp

    def close(self):
        self.closed = True


# ---- Tier 1: in-memory description short-circuits ----------------------

def test_tier1_description_wins(monkeypatch):
    # No client needed; should never touch the network.
    monkeypatch.setattr(jd_source.httpx, "Client",
                        lambda *a, **k: pytest.fail("made a client"))
    job = _job(description="x" * 300)
    assert jd_source.acquire_jd(job) == "x" * 300


def test_tier1_short_description_falls_through():
    # 50 chars < MIN_JD_CHARS -> not a hit; nothing else available -> None.
    client = FakeClient({})
    job = _job(description="too short", url="")
    assert jd_source.acquire_jd(job, client=client, allow_scrape=False) is None


# ---- Tier 2: Greenhouse content API ------------------------------------

def test_tier2_greenhouse_json(monkeypatch):
    body = "<p>" + "Build great software. " * 30 + "</p>"
    client = FakeClient({
        "https://gh.test/content": FakeResp(payload={"content": body}),
    })
    job = _job(jd_url="https://gh.test/content", url="")
    got = jd_source.acquire_jd(job, client=client, allow_scrape=False)
    assert got and "Build great software." in got
    assert client.calls == ["https://gh.test/content"]


def test_tier2_failure_falls_through_to_tier3(monkeypatch):
    captured = {}

    def fake_fetch(client, jid):
        captured["id"] = jid
        return "Real JD text. " * 30

    monkeypatch.setattr(jd_source, "fetch_description", fake_fetch)
    client = FakeClient({
        "https://gh.test/content": RuntimeError("greenhouse 500"),
    })
    job = _job(jd_url="https://gh.test/content",
               jobright_id="a" * 24, url="")
    got = jd_source.acquire_jd(job, client=client, allow_scrape=False)
    assert got and got.startswith("Real JD text.")
    assert captured["id"] == "a" * 24


# ---- Tier 3: jobright info page ----------------------------------------

def test_tier3_jobright(monkeypatch):
    monkeypatch.setattr(jd_source, "fetch_description",
                        lambda client, jid: "Jobright JD. " * 30)
    client = FakeClient({})
    job = _job(jobright_id="b" * 24, url="")
    got = jd_source.acquire_jd(job, client=client, allow_scrape=False)
    assert got and got.startswith("Jobright JD.")


def test_tier3_short_result_falls_through(monkeypatch):
    monkeypatch.setattr(jd_source, "fetch_description",
                        lambda client, jid: "tiny")
    client = FakeClient({})
    job = _job(jobright_id="b" * 24, url="")
    assert jd_source.acquire_jd(job, client=client, allow_scrape=False) is None


# ---- Tier 4: generic scrape --------------------------------------------

def test_tier4_scrape_full_body():
    html = "<html><body>" + "<p>Some role content. </p>" * 40 + "</body></html>"
    client = FakeClient({"https://acme.test/job": FakeResp(text=html)})
    job = _job()
    got = jd_source.acquire_jd(job, client=client)
    assert got and "Some role content." in got


def test_tier4_prefers_embedded_json_ld():
    desc = "Structured JD description. " * 20
    ld = json.dumps({"@type": "JobPosting", "description": f"<p>{desc}</p>"})
    html = (f'<html><head><script type="application/ld+json">{ld}</script>'
            "</head><body>nav chrome footer</body></html>")
    client = FakeClient({"https://acme.test/job": FakeResp(text=html)})
    got = jd_source.acquire_jd(_job(), client=client)
    assert got and got.startswith("Structured JD description.")
    assert "nav chrome" not in got


def test_tier4_disabled_when_allow_scrape_false():
    client = FakeClient({"https://acme.test/job": FakeResp(text="x" * 500)})
    assert jd_source.acquire_jd(_job(), client=client,
                                allow_scrape=False) is None
    assert client.calls == []


def test_tier4_js_heavy_body_rejected_by_guard():
    # A body that is mostly tracker/hydration JS (no JD markers) must be
    # rejected even though it clears MIN_JD_CHARS -- an honest miss beats
    # returning JavaScript as a "job description".
    js_like = ("function(s,a,e,v,n,t,z){window.saq=n;document.write(v);"
              "var x=null,{});") * 30
    html = "<html><body>" + js_like + "</body></html>"
    client = FakeClient({"https://acme.test/job": FakeResp(text=html)})
    assert jd_source._generic_scrape(client, "https://acme.test/job") is None


def test_tier4_real_jd_prose_passes_guard():
    jd_text = ("We are looking for a Software Engineer Intern. "
              "Responsibilities include building distributed systems. "
              "Qualifications: experience with C++ or Python. "
              "Bachelor's degree required. " * 5)
    html = "<html><body><p>" + jd_text + "</p></body></html>"
    client = FakeClient({"https://acme.test/job": FakeResp(text=html)})
    got = jd_source.acquire_jd(_job(), client=client)
    assert got and "Responsibilities" in got


def test_tier4_blocked_page_is_a_miss():
    # A 200 anti-bot challenge body (Tesla-style) must not become a "JD" even
    # though it clears MIN_JD_CHARS -- building from "Access Denied" is worse
    # than reporting nothing (the user can then paste the JD).
    body = ("<html><body><h1>Access Denied</h1><p>You don't have permission "
            "to access this server.</p>" + ("filler " * 60) + "</body></html>")
    client = FakeClient({"https://acme.test/job": FakeResp(text=body)})
    assert jd_source.acquire_jd(_job(), client=client) is None


# ---- employer url vs jobright url tier order ---------------------------

def test_employer_url_scrapes_before_jobright_page(monkeypatch):
    # url is a real employer link (extract_jobright_id -> None): the scrape
    # must win and the jobright page must never even be called.
    def fail_jobright(client, jid):
        pytest.fail("jobright page fetched before employer scrape")

    monkeypatch.setattr(jd_source, "fetch_description", fail_jobright)
    html = "<html><body>" + "<p>Employer site content. </p>" * 40 + "</body></html>"
    client = FakeClient({"https://acme.test/job": FakeResp(text=html)})
    job = _job(jobright_id="d" * 24)
    got = jd_source.acquire_jd(job, client=client)
    assert got and "Employer site content." in got
    assert client.calls == ["https://acme.test/job"]


def test_employer_url_js_junk_falls_back_to_jobright_page(monkeypatch):
    # employer page's generic scrape is mostly JS debris (leaked hydration
    # payload, no JD markers) -> guard rejects it -> falls back to the
    # jobright composed JD, same as an HTTP-blocked scrape would.
    monkeypatch.setattr(jd_source, "fetch_description",
                        lambda client, jid: "Jobright JD fallback text. " * 20)
    js_like = ("function(s,a,e,v,n,t,z){window.saq=n;document.write(v);"
              "var x=null,{});") * 30
    html = "<html><body>" + js_like + "</body></html>"
    client = FakeClient({"https://acme.test/job": FakeResp(text=html)})
    job = _job(jobright_id="9" * 24)
    got = jd_source.acquire_jd(job, client=client)
    assert got and got.startswith("Jobright JD fallback text.")
    assert client.calls == ["https://acme.test/job"]


def test_jobright_url_still_tries_jobright_page_first(monkeypatch):
    # url IS a jobright link: existing order holds -- jobright page first,
    # generic scrape of that same url is not attempted once it hits.
    monkeypatch.setattr(jd_source, "fetch_description",
                        lambda client, jid: "Jobright JD. " * 30)
    client = FakeClient({})
    job = _job(url="https://jobright.ai/jobs/info/" + "e" * 24,
               jobright_id="e" * 24)
    got = jd_source.acquire_jd(job, client=client)
    assert got and got.startswith("Jobright JD.")
    assert client.calls == []


def test_employer_url_blocked_scrape_falls_back_to_jobright_page(monkeypatch):
    # employer site serves an anti-bot challenge (a miss) -> falls back to
    # the jobright page, which succeeds.
    monkeypatch.setattr(jd_source, "fetch_description",
                        lambda client, jid: "Jobright fallback JD. " * 20)
    body = ("<html><body><h1>Access Denied</h1><p>You don't have permission "
            "to access this server.</p>" + ("filler " * 60) + "</body></html>")
    client = FakeClient({"https://acme.test/job": FakeResp(text=body)})
    job = _job(jobright_id="f" * 24)
    got = jd_source.acquire_jd(job, client=client)
    assert got and got.startswith("Jobright fallback JD.")
    assert client.calls == ["https://acme.test/job"]


# ---- fail-open: every tier raises -> None ------------------------------

def test_all_tiers_fail_open(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("nope")

    monkeypatch.setattr(jd_source, "fetch_description", boom)
    client = FakeClient({"https://acme.test/job": RuntimeError("scrape down")})
    job = _job(jd_url="https://gh.test/content", jobright_id="c" * 24)
    # greenhouse url missing from map -> KeyError caught; jobright -> boom;
    # scrape -> RuntimeError. All fail open.
    client.responses["https://gh.test/content"] = RuntimeError("gh down")
    assert jd_source.acquire_jd(job, client=client) is None


# ---- owns its client when none is passed -------------------------------

def test_makes_and_closes_own_client(monkeypatch):
    fake = FakeClient({"https://acme.test/job": FakeResp(text="y" * 400)})
    monkeypatch.setattr(jd_source.httpx, "Client", lambda *a, **k: fake)
    got = jd_source.acquire_jd(_job())
    assert got and got.startswith("y")
    assert fake.closed is True
