"""JD collection (ATS adapters + Greenhouse enrichment) and JD-based
elimination filters."""

import datetime as dt
import json
from pathlib import Path

import httpx

from src import main
from src.adapters.ats_boards import JD_MAX_CHARS, AtsBoardsAdapter
from src.dedupe import dedupe
from src.filters import (UserFilter, jd_grad_only,
                         jd_requires_active_clearance)
from src.models import Job, SourceConfig
from src.normalize import strip_html

TODAY = dt.date(2026, 6, 12)
ROOT = Path(__file__).parent.parent


def _adapter():
    return AtsBoardsAdapter(SourceConfig(name="ats-boards", adapter="ats_boards"))


# ------------------------------------------------------------- collection

def test_strip_html_plain_and_escaped():
    assert strip_html("<h2>Who we are</h2><p>Stripe&nbsp;is great</p>") \
        == "Who we are Stripe is great"
    # Greenhouse `content` arrives entity-escaped
    assert strip_html("&lt;p&gt;Master&amp;#39;s degree required&lt;/p&gt;") \
        == "Master's degree required"


def test_lever_jd_includes_requirement_lists():
    raw = json.dumps([{
        "text": "Software Engineer Intern",
        "hostedUrl": "https://jobs.lever.co/x/1",
        "createdAt": 1760000000000,
        "categories": {"location": "Atlanta, GA"},
        "descriptionPlain": "Build cool things.",
        "lists": [{"text": "Requirements",
                   "content": "<li>Active TS/SCI clearance</li>"}],
        "additionalPlain": "Benefits galore.",
    }])
    job = _adapter().parse(raw, "lever:x:XCorp", TODAY)[0]
    assert "Build cool things." in job.description
    assert "Active TS/SCI clearance" in job.description   # from lists html
    assert "Benefits galore." in job.description


def test_ashby_jd_from_description_plain():
    raw = json.dumps({"jobs": [{
        "title": "SWE Intern", "jobUrl": "https://jobs.ashbyhq.com/x/1",
        "location": "NYC", "isListed": True,
        "descriptionPlain": "Pursuing a Bachelor's degree.",
    }]})
    job = _adapter().parse(raw, "ashby:x:XCorp", TODAY)[0]
    assert job.description == "Pursuing a Bachelor's degree."
    assert job.jd_url is None


def test_jd_truncated_to_cap():
    raw = json.dumps({"jobs": [{
        "title": "SWE Intern", "jobUrl": "https://jobs.ashbyhq.com/x/1",
        "location": "NYC", "descriptionPlain": "x" * (JD_MAX_CHARS + 500),
    }]})
    job = _adapter().parse(raw, "ashby:x:XCorp", TODAY)[0]
    assert len(job.description) == JD_MAX_CHARS


def test_dedupe_merge_keeps_description_and_jd_url():
    a = Job(company="X", title="SWE Intern", url="https://x.com/1",
            source="s1", terms=["Fall 2026"], term_confidence="explicit")
    b = Job(company="X", title="SWE Intern", url="https://x.com/1",
            source="s2", description="the jd", jd_url="https://api/jd")
    merged = dedupe([a, b])
    assert len(merged) == 1
    assert merged[0].description == "the jd"
    assert merged[0].jd_url == "https://api/jd"


def test_enrich_jds_fetches_greenhouse_content(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/jobs/42"):
            return httpx.Response(200, json={
                "content": "&lt;p&gt;Requires an active Top Secret "
                           "clearance.&lt;/p&gt;"})
        return httpx.Response(404)

    real = httpx.Client
    monkeypatch.setattr(main.httpx, "Client", lambda **kw: real(
        transport=httpx.MockTransport(handler), **kw))

    ok = Job(company="X", title="SWE Intern", url="https://x.com/1",
             source="s", jd_url="https://boards-api.greenhouse.io/v1/"
                                "boards/x/jobs/42")
    dead = Job(company="Y", title="SWE Intern", url="https://x.com/2",
               source="s", jd_url="https://boards-api.greenhouse.io/v1/"
                                  "boards/x/jobs/404")
    inline = Job(company="Z", title="SWE Intern", url="https://x.com/3",
                 source="s", description="already here", jd_url="https://nope")
    no_jd = Job(company="W", title="SWE Intern", url="https://x.com/4",
                source="s")

    assert main.enrich_jds([ok, dead, inline, no_jd]) == 1
    assert ok.description == "Requires an active Top Secret clearance."
    assert dead.description is None            # failure is non-fatal
    assert inline.description == "already here"  # not refetched


# ---------------------------------------------------------------- filters

def _uf():
    return UserFilter({
        "name": "t",
        "eliminate": {"unpaid": True, "grad_only": True,
                      "active_clearance": True, "veteran_only": True},
        "role_filter": {"include_keywords": ["software"]},
        "terms_wanted": ["Fall 2026"],
        "unknown_term_policy": "drop",
        "rules": [{"when": {"term": ["Fall 2026"]},
                   "accept_if_any": [{"always": True}]}],
    }, ROOT)


def _job(description, title="Software Engineer Intern"):
    return Job(company="X", title=title, url="https://x.com/1", source="s",
               terms=["Fall 2026"], term_confidence="explicit",
               description=description)


def test_jd_grad_only_logic():
    assert jd_grad_only("Currently pursuing a Master's degree in CS.")
    assert jd_grad_only("PhD students in robotics are encouraged.")
    # any undergrad mention suppresses
    assert not jd_grad_only("Pursuing a Bachelor's or Master's degree.")
    assert not jd_grad_only("Open to BS/MS students.")
    assert not jd_grad_only("Undergrad and Master's students welcome.")
    # body chatter that must NOT read as grad-only
    assert not jd_grad_only("You will graduate by Dec 2027. Bachelor's req.")
    assert not jd_grad_only("Join recent graduates and bachelor's interns.")


def test_jd_clearance_context_window():
    assert jd_requires_active_clearance(
        "Requirements: an active TS/SCI clearance with CI polygraph.")
    assert jd_requires_active_clearance(
        "Must currently hold a Top Secret clearance.")
    # obtainable stays -- the user can get cleared
    assert not jd_requires_active_clearance(
        "Ability to obtain and maintain a TS/SCI security clearance.")
    assert not jd_requires_active_clearance(
        "Must be eligible for a Top Secret clearance.")
    # bare mention without an 'active' cue: conservative keep
    assert not jd_requires_active_clearance(
        "Some roles may involve a security clearance down the road.")
    assert not jd_requires_active_clearance("No clearance talk at all.")


def test_jd_eliminations_in_evaluate():
    uf = _uf()
    assert uf.evaluate(_job("Requires an active TS/SCI clearance.")).reasons \
        == ["eliminated:active-clearance-jd"]
    assert uf.evaluate(_job("Enrolled in a Master's program.")).reasons \
        == ["eliminated:grad-only-jd"]
    assert uf.evaluate(_job("This internship is unpaid but rewarding.")).reasons \
        == ["eliminated:unpaid-jd"]
    # clean JD passes through to the rules and gets accepted
    ok = uf.evaluate(_job("Pursuing a Bachelor's degree. Paid hourly."))
    assert ok.status == "accept"


def test_jd_eeo_boilerplate_does_not_eliminate():
    eeo = ("We are an equal opportunity employer. All qualified applicants "
           "receive consideration without regard to race, religion, gender, "
           "disability or protected veteran status. Pursuing a Bachelor's "
           "degree in CS.")
    assert _uf().evaluate(_job(eeo)).status == "accept"


def test_no_jd_keeps_existing_behavior():
    assert _uf().evaluate(_job(None)).status == "accept"


# -------------------------------------------------------------------- llm

def test_llm_payload_includes_jd_excerpt(monkeypatch):
    from src import llm

    captured = {}

    def fake_call(model, system, user_msg, api_key):
        captured["msg"] = user_msg
        return "[]"

    monkeypatch.setitem(llm._PROVIDERS, "gemini", fake_call)
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    with_jd = _job("Long description " + "x" * 3000)
    with_jd.dedup_key = "url:https://x.com/1"
    without = _job(None)
    without.dedup_key = "url:https://x.com/2"
    llm.classify([with_jd, without], "top def", ["Fall 2026"],
                 {"provider": "gemini"})

    payload = json.loads(captured["msg"][captured["msg"].find("["):
                                         captured["msg"].rfind("]") + 1])
    by_key = {p["dedup_key"]: p for p in payload}
    assert "description" in by_key["url:https://x.com/1"]
    assert len(by_key["url:https://x.com/1"]["description"]) \
        == llm.JD_EXCERPT_CHARS
    assert "description" not in by_key["url:https://x.com/2"]
