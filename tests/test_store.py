"""TrackerStore seam: GitHubStore against mocked httpx, the STORE factory,
and the FakeStore contract."""

import datetime as dt
import json
import logging

import httpx
import pytest

from src import dashboard, state as st, store


def _item(i, **kw):
    d = {"key": f"url:https://x.com/{i}", "company": f"Co{i}",
         "title": f"SWE Intern {i}", "location": "Atlanta, GA", "salary": None,
         "url": f"https://x.com/{i}", "tag": "", "term": "Fall 2026",
         "added": "2026-06-12", "applied": False}
    d.update(kw)
    return d


TERMS = ["Fall 2026", "Spring 2027", "Summer 2027"]
NOW = dt.datetime(2026, 6, 12, 12, 0, tzinfo=dt.timezone.utc)


def _mock_client(monkeypatch, handler):
    real = httpx.Client

    def factory(**kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(**kwargs)

    monkeypatch.setattr(store.httpx, "Client", factory)


def _make_store(monkeypatch, tmp_path, issue=7):
    """A writable GitHubStore: env-provided repo/token, issue number pinned
    (construction resolves it from git, which tmp_path can't satisfy)."""
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/intern-watch")
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    gs = store.GitHubStore(tmp_path, {"name": "example"})
    gs.issue_number = issue
    return gs


# -- get_ticks ------------------------------------------------------------

def test_get_ticks_parses_a_real_dashboard_body(monkeypatch, tmp_path):
    matches = [_item(1), _item(2, applied=True), _item(3, dismissed=True),
               _item(4, saved=True)]
    body = dashboard.build_body(matches, TERMS, NOW)
    issue = {"html_url": "https://github.com/owner/intern-watch/issues/7",
             "body": body}

    def handler(request):
        assert request.method == "GET"
        assert "/issues/7" in str(request.url)
        return httpx.Response(200, json=issue)

    _mock_client(monkeypatch, handler)
    gs = _make_store(monkeypatch, tmp_path)

    ticks = gs.get_ticks("example")
    assert ticks is not None
    a, b = dashboard.short_key(matches[0]["key"]), \
        dashboard.short_key(matches[1]["key"])
    c, d = dashboard.short_key(matches[2]["key"]), \
        dashboard.short_key(matches[3]["key"])
    # only the ACTIVE rows carry an applied box (the dismissed row 3 lives
    # in the Hidden section with a hide box instead)
    assert ticks.present == {a, b, d}
    assert ticks.checked == {b}
    assert ticks.hidden == {c} and ticks.h_present == {a, b, c, d}
    assert ticks.saved == {d} and ticks.s_present == {a, b, d}
    assert gs.issue_url == issue["html_url"]
    assert gs.error_name is None
    assert gs.read_warning is None  # success clears it
    assert gs.writable is True


def test_get_ticks_closed_issue_parses_but_flags_not_open(monkeypatch,
                                                          tmp_path):
    """GitHub serves closed issues with HTTP 200, so the parse still succeeds
    and issue_open must carry the closed state for the cron's skip."""
    body = dashboard.build_body([_item(1)], TERMS, NOW)
    issue = {"html_url": "https://github.com/owner/intern-watch/issues/7",
             "state": "closed", "body": body}
    called = []

    def handler(request):
        called.append(request.method)
        return httpx.Response(200, json=issue)

    _mock_client(monkeypatch, handler)
    gs = _make_store(monkeypatch, tmp_path)

    ticks = gs.get_ticks("example")
    assert ticks is not None
    assert ticks.issue_open is False
    assert ticks.present == {dashboard.short_key("url:https://x.com/1")}
    assert gs.error_name is None


def test_sync_user_skips_closed_ticks_without_any_http(monkeypatch):
    """A store-provided closed read-back must trigger the same skip as the
    legacy GET path - return before read-back/repaint, no API calls."""
    state = st.empty_state()
    st.matches_add(state, "example", _item(1))
    state["_meta"]["dashboard_issue"] = {"example": 7}

    def handler(request):  # pragma: no cover - must never fire
        raise AssertionError(f"unexpected {request.method} {request.url}")

    _mock_client(monkeypatch, handler)
    ticks = store.TicksView(issue_open=False)

    dashboard.sync_user(state, "example", TERMS, NOW,
                        "owner/intern-watch", "tok", ticks=ticks)
    # matches untouched: nothing read back, nothing repainted
    assert not any(i.get("applied") for i in st.matches_items(state,
                                                               "example"))


def test_sync_user_closed_ticks_logs_the_same_warning(
        monkeypatch, caplog):
    def handler(request):  # pragma: no cover - must never fire
        raise AssertionError(f"unexpected {request.method} {request.url}")

    _mock_client(monkeypatch, handler)
    state = st.empty_state()
    st.matches_add(state, "example", _item(1))
    state["_meta"]["dashboard_issue"] = {"example": 7}

    with caplog.at_level(logging.INFO, logger="src.dashboard"):
        dashboard.sync_user(state, "example", TERMS, NOW,
                            "owner/intern-watch", "tok",
                            ticks=store.TicksView(issue_open=False))
    assert any("dashboard issue #7 is closed -- skipping update (reopen it "
               "to resume)" in r.getMessage() for r in caplog.records)


def test_get_ticks_returns_none_and_records_error_on_failure(
        monkeypatch, tmp_path):
    def handler(request):
        return httpx.Response(500)

    _mock_client(monkeypatch, handler)
    gs = _make_store(monkeypatch, tmp_path)

    assert gs.get_ticks("example") is None
    assert gs.error_name == "HTTPStatusError"


def test_get_ticks_none_without_token_or_issue(tmp_path):
    gs = store.GitHubStore(tmp_path, {"name": "example"})
    gs.issue_number = 7
    assert gs.get_ticks("example") is None  # no repo/token detected
    gs2 = store.GitHubStore(tmp_path, {"name": "example"})
    assert gs2.get_ticks("example") is None  # no issue number at all


def test_get_ticks_read_warning_no_token_but_issue_known(tmp_path):
    """A known issue with no creds to read it keeps the legacy webui warning
    string byte-for-byte."""
    gs = store.GitHubStore(tmp_path, {"name": "example"})
    gs.issue_number = 7
    assert gs.get_ticks("example") is None
    assert gs.read_warning == (
        "no GitHub token (set GITHUB_TOKEN or log in with `gh auth "
        "login`) — applied toggles are read-only this session")


def test_get_ticks_read_warning_none_with_no_issue(tmp_path):
    """No issue number at all -> silence (the legacy webui appended nothing)."""
    gs = store.GitHubStore(tmp_path, {"name": "example"})
    assert gs.get_ticks("example") is None
    assert gs.read_warning is None


def test_get_ticks_read_warning_http_failure(monkeypatch, tmp_path):
    """HTTP failure reproduces the legacy 'couldn't read dashboard issue'
    warning verbatim, incl. the exception class name."""
    def handler(request):
        return httpx.Response(500)

    _mock_client(monkeypatch, handler)
    gs = _make_store(monkeypatch, tmp_path)
    assert gs.get_ticks("example") is None
    assert gs.error_name == "HTTPStatusError"
    assert gs.read_warning == (
        "couldn't read dashboard issue #7 (HTTPStatusError) — applied "
        "ticks made on GitHub may not show")


def test_github_store_writable(monkeypatch, tmp_path):
    gs = _make_store(monkeypatch, tmp_path)
    assert gs.writable is True
    gs.issue_number = None
    assert gs.writable is False


# -- set_ticks ------------------------------------------------------------

def test_set_ticks_patches_once_and_queues_off_window(monkeypatch, tmp_path):
    matches = [_item(1), _item(2), _item(3)]
    body = dashboard.build_body(matches, TERMS, NOW)
    a, b = dashboard.short_key("url:https://x.com/1"), \
        dashboard.short_key("url:https://x.com/2")
    current = {"body": body}
    patched: list[str] = []
    dispatched: list[dict] = []

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"body": current["body"]})
        if request.method == "PATCH":
            payload = json.loads(request.content)
            patched.append(payload["body"])
            current["body"] = payload["body"]
            return httpx.Response(200, json={})
        if request.method == "POST":  # workflow dispatch
            dispatched.append(json.loads(request.content))
            return httpx.Response(204, json={})
        raise AssertionError(f"unexpected {request.method}")

    _mock_client(monkeypatch, handler)
    gs = _make_store(monkeypatch, tmp_path)

    # a and b are rendered rows (flip succeeds -> one accumulated PATCH);
    # the 12-hex ghost has no marker -> workflow fallback, reported as queued
    queued = gs.set_ticks("example", [
        store.TickWrite(a, "applied", True),
        store.TickWrite(b, "saved", True),
        store.TickWrite("0" * 12, "dismissed", True),
    ])
    assert queued == ["0" * 12]
    assert len(patched) == 1
    checked, present = dashboard.parse_checkboxes(patched[0])
    # only the applied flip ticks the `iw:` box; b's saved tick went into the
    # separate `iws:` box, which parse_saved reads
    assert checked == {a} and present == {a, b,
                                          dashboard.short_key(
                                              "url:https://x.com/3")}
    saved, _ = dashboard.parse_saved(patched[0])
    assert saved == {b}
    assert dispatched[0]["ref"] == "main"
    assert dispatched[0]["inputs"] == {"user": "example", "short": "0" * 12,
                                       "field": "dismissed", "value": "true"}


def test_set_ticks_raises_without_token_or_issue(tmp_path):
    gs = store.GitHubStore(tmp_path, {"name": "example"})
    with pytest.raises(store.ApiError) as ei:
        gs.set_ticks("example", [store.TickWrite("a" * 12, "applied", True)])
    assert "no GitHub token/issue" in str(ei.value)


# -- ledger + status ------------------------------------------------------

def test_get_ledger_falls_back_to_the_local_file(tmp_path):
    book = tmp_path / "state" / "applications.json"
    book.parent.mkdir(parents=True)
    book.write_text('{"example": {"abc": {"company": "Co"}}}', encoding="utf-8")
    gs = store.GitHubStore(tmp_path, {"name": "example"})
    assert gs.get_ledger("example") == {"abc": {"company": "Co"}}
    assert gs.get_ledger("other") == {}


def test_record_status_validates_and_dispatches(monkeypatch, tmp_path):
    dispatched: list[dict] = []

    def handler(request):
        if request.method == "POST":
            dispatched.append(json.loads(request.content))
            return httpx.Response(204, json={})
        raise AssertionError(f"unexpected {request.method}")

    _mock_client(monkeypatch, handler)
    gs = _make_store(monkeypatch, tmp_path)

    gs.record_status("example", "a" * 12, "oa", note="HackerRank, due 7/14")
    assert dispatched[0]["inputs"] == {"user": "example", "short": "a" * 12,
                                       "field": "status", "value": "oa",
                                       "note": "HackerRank, due 7/14"}
    with pytest.raises(store.ApiError):
        gs.record_status("example", "a" * 12, "not-a-status")


# -- match snapshot: the GitHub driver serves matches through seen.json -----

def test_github_store_does_not_serve_matches(tmp_path):
    gs = store.GitHubStore(tmp_path, {"name": "example"})
    assert gs.get_matches("example") is None
    assert gs.push_matches("example", [{"key": "url:a"}]) is None


# -- mail sync: the GitHub driver serves none of it -------------------------

def test_github_store_does_not_serve_mail_sync(tmp_path):
    gs = store.GitHubStore(tmp_path, {"name": "example"})
    assert gs.get_actions("example") is None
    with pytest.raises(store.ApiError) as ei:
        gs.resolve_action("example", "action-1", short="a" * 12,
                          status="oa")
    assert "convex store" in str(ei.value)


def test_protocol_conformance_github_and_convex(monkeypatch, tmp_path):
    """Both drivers carry the two new mail-sync methods the Protocol declares
    (get_actions / resolve_action). Uses attribute checks: TrackerStore is a
    plain Protocol (not @runtime_checkable), so isinstance would TypeError."""
    gs = store.GitHubStore(tmp_path, {"name": "example"})
    monkeypatch.setenv("CONVEX_URL", "https://x.convex.cloud")
    monkeypatch.setenv("CONVEX_SECRET", "secret")
    cs = store.ConvexStore(tmp_path, {"name": "example"})
    for driver in (gs, cs):
        assert callable(driver.get_actions)
        assert callable(driver.resolve_action)
    # the Protocol itself declares both methods
    assert "get_actions" in store.TrackerStore.__annotations__ or \
        hasattr(store.TrackerStore, "get_actions")
    assert "resolve_action" in store.TrackerStore.__annotations__ or \
        hasattr(store.TrackerStore, "resolve_action")


# -- factory ---------------------------------------------------------------

def test_make_store_defaults_to_github_and_rejects_unknown(monkeypatch,
                                                           tmp_path):
    monkeypatch.delenv("STORE", raising=False)
    assert isinstance(store.make_store(tmp_path, {"name": "u"}),
                      store.GitHubStore)
    monkeypatch.setenv("STORE", "bogus")
    with pytest.raises(ValueError, match="bogus"):
        store.make_store(tmp_path, {"name": "u"})


# -- FakeStore contract -----------------------------------------------------

def test_fakestore_roundtrips():
    from tests.fakestore import FakeStore
    fs = FakeStore()
    fs.set_ticks("u", [store.TickWrite("a1b2c3d4e5f6", "applied", True),
                       store.TickWrite("b1b2c3d4e5f6", "saved", True)])
    view = fs.get_ticks("u")
    assert view.checked == {"a1b2c3d4e5f6"}
    assert view.saved == {"b1b2c3d4e5f6"}
    assert view.present == {"a1b2c3d4e5f6"}
    assert view.s_present == {"b1b2c3d4e5f6"}
    assert fs.get_ticks("other") is None

    fs.push_matches("u", [{"key": "url:a"}, {"key": "url:b"}])
    assert fs.get_matches("u") == [{"key": "url:a"}, {"key": "url:b"}]
    assert fs.get_matches("other") is None

    fs.record_status("u", "a1b2c3d4e5f6", "oa", note="n")
    assert fs.statuses == [("u", "a1b2c3d4e5f6", "oa", "n")]
    assert fs.set_ticks("u", [store.TickWrite("c1b2c3d4e5f6",
                                              "dismissed", True)]) == []