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


# ---- employer-URL tier (jobright full posting) -------------------------------

def _shim(jid="6a0000000000000000000001"):
    return SimpleNamespace(description=None, jd_url=None,
                           url=f"https://jobright.ai/jobs/info/{jid}",
                           dedup_key=f"jr:{jid}", jobright_id=jid)


def test_employer_url_ats_api_beats_jobright_summary(monkeypatch):
    """A jobright job whose employer URL is a supported ATS gets the full
    posting from the ATS API, before the summary tier is even consulted."""
    import httpx

    def handler(request):
        if request.url.host == "api.lever.co":
            return httpx.Response(200, json={
                "descriptionPlain": FILLER,
                "lists": [{"text": "Requirements", "content": "<li>Rust</li>"}]})
        return httpx.Response(404)

    called = {"summary": False}
    monkeypatch.setattr(jd_source, "_try_jobright",
                        lambda *a, **k: called.__setitem__("summary", True) or "SUMMARY " * 40)
    client = httpx.Client(transport=httpx.MockTransport(handler))
    got = jd_source.acquire_jd(
        _shim(), client=client,
        employer_url="https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555")
    assert got and "Requirements" in got and "Rust" in got
    assert called["summary"] is False


def test_employer_scrape_beats_summary_only_when_at_least_as_long(monkeypatch):
    """A non-ATS employer page wins over the jobright summary only when it is
    a real posting (at least as long); a short nav shell loses to the summary."""
    summary = "Summary bullet about the role. " * 12          # ~370 chars
    monkeypatch.setattr(jd_source, "_try_ats_api", lambda *a, **k: None)
    monkeypatch.setattr(jd_source, "_try_jobright", lambda *a, **k: summary)

    shell = "Careers Home Login Apply Now " * 9                 # ~260 chars, > MIN
    monkeypatch.setattr(jd_source, "_try_scrape", lambda *a, **k: shell)
    got = jd_source.acquire_jd(_shim(), client=object(),
                               employer_url="https://careers.example.com/j/1")
    assert got == summary

    posting = ("Responsibilities: own services. Qualifications: Go, SQL. " * 40)
    monkeypatch.setattr(jd_source, "_try_scrape", lambda *a, **k: posting)
    got = jd_source.acquire_jd(_shim(), client=object(),
                               employer_url="https://careers.example.com/j/1")
    assert got == posting


def test_matches_with_jds_threads_cached_and_resolved_employer_urls(monkeypatch):
    """The watch push passes the employer URL into acquisition: from the
    state cache when delivery already resolved it, else via the session
    (which then caches it and feeds the url index, like the backfill)."""
    from src import main
    from src import state as st

    state = st.empty_state()
    state["matches"]["u"] = [
        {"key": "jr:aaa", "short": "s1", "url": "https://jobright.ai/jobs/info/aaa"},
        {"key": "jr:bbb", "short": "s2", "url": "https://jobright.ai/jobs/info/bbb"},
    ]
    st.apply_url_put(state, "jr:aaa", "https://boards.greenhouse.io/acme/jobs/1")

    seen = {}
    monkeypatch.setattr(jd_source, "acquire_jd",
                        lambda shim, **kw: seen.__setitem__(shim.dedup_key, kw.get("employer_url"))
                        or FILLER)

    class Resolver:
        def resolve_apply_url(self, jid):
            return "https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555" \
                if jid == "bbb" else None

    class NotGitHubStore:  # anything that isn't the GitHub driver pushes
        pass

    out = main._matches_with_jds(NotGitHubStore(), state, "u", {}, Resolver())
    assert seen["jr:aaa"] == "https://boards.greenhouse.io/acme/jobs/1"
    assert seen["jr:bbb"].startswith("https://jobs.lever.co/acme/")
    assert st.apply_url_get(state, "jr:bbb").startswith("https://jobs.lever.co/")
    assert all(item.get("jd") == FILLER for item in out)
    assert all(item.get("jd_state") == "ok" for item in state["matches"]["u"])
