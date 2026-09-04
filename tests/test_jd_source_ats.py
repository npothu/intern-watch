"""ATS-API resolver + chain-order tests for jd_source (jd_acquire.ts twin)."""

from types import SimpleNamespace

from src.resume import jd_source

FILLER = "Responsibilities: build things and own outcomes. " * 10


def test_ats_api_for_mappings():
    cases = {
        "https://boards.greenhouse.io/stripe/jobs/123456": "greenhouse",
        "https://jobs.lever.co/palantir/11111111-2222-3333-4444-555555555555":
            "lever",
        "https://jobs.smartrecruiters.com/Visa/744000012345-intern":
            "smartrecruiters",
        "https://apply.workable.com/acme/j/AB12CD34EF": "workable",
    }
    for url, kind in cases.items():
        resolved = jd_source._ats_api_for(url)
        assert resolved is not None and resolved[0] == kind, url
    assert jd_source._ats_api_for("https://example.com/careers/1") is None


def test_workday_cxs_url_drops_locale():
    kind, api = jd_source._ats_api_for(
        "https://nvidia.wd5.myworkdayjobs.com/en-US/Site/job/US-CA/Intern_JR1")
    assert kind == "workday"
    assert api == ("https://nvidia.wd5.myworkdayjobs.com"
                   "/wday/cxs/nvidia/Site/job/US-CA/Intern_JR1")


def test_jd_from_ats_payloads():
    assert "Responsibilities" in jd_source._jd_from_ats_payload(
        "greenhouse", {"content": f"<p>{FILLER}</p>"})
    lever = jd_source._jd_from_ats_payload("lever", {
        "descriptionPlain": FILLER,
        "lists": [{"text": "Requirements",
                   "content": "<li>Python</li><li>SQL</li>"}]})
    assert "Requirements" in lever and "Python" in lever
    wd = jd_source._jd_from_ats_payload(
        "workday", {"jobPostingInfo": {"jobDescription": f"<p>{FILLER}</p>"}})
    assert "Responsibilities" in wd
    assert jd_source._jd_from_ats_payload(
        "greenhouse", {"content": "<p>short</p>"}) is None


def test_llm_extract_gated_and_validated(monkeypatch):
    job = SimpleNamespace(dedup_key="k")
    # no cfg / no key -> skipped
    assert jd_source._llm_extract("<p>x</p>", None, job) is None
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    calls = {}

    def fake_call(model, system, user, key):
        calls["ran"] = True
        return FILLER

    monkeypatch.setitem(jd_source.__dict__, "_llm_extract_call_override", None)
    import src.llm as llm
    monkeypatch.setitem(llm._PROVIDERS, "gemini", fake_call)
    got = jd_source._llm_extract(f"<html><body>{FILLER}</body></html>",
                                 {"provider": "gemini"}, job)
    assert calls.get("ran") and got and "Responsibilities" in got

    def fake_none(model, system, user, key):
        return "NONE"

    monkeypatch.setitem(llm._PROVIDERS, "gemini", fake_none)
    assert jd_source._llm_extract(f"<html>{FILLER}</html>",
                                  {"provider": "gemini"}, job) is None


def test_strip_html_drops_svg_content():
    from src.normalize import strip_html
    html = ('<p>Real JD text here.</p>'
            '<svg viewBox="0 0 32 32"><path d="M2 21.3 5.1 21.4"/></svg>')
    got = strip_html(html)
    assert "Real JD text" in got
    assert "21.3" not in got


def test_strip_html_truncated_svg_does_not_leak():
    from src.normalize import strip_html
    truncated = ('<p>Real JD text here.</p>'
                 '<svg viewBox="0 0 32 32"><path d="M2 21.3056C5.24 21.41')
    got = strip_html(truncated)
    assert "Real JD text" in got
    assert "21.3056" not in got


def test_strip_html_truncated_script_does_not_leak():
    from src.normalize import strip_html
    truncated = ('<p>Real JD text here.</p>'
                 '<script>self.__next_f.push([1,"M28 4C29.1 21.3056V21.3')
    got = strip_html(truncated)
    assert "Real JD text" in got
    assert "21.3056" not in got
