"""ConvexStore against mocked httpx, the STORE factory, the migration script,
and the dashboard read-only digest mode."""

import datetime as dt
import json

import httpx
import pytest

from src import dashboard, ledger, store
from src import state as st

TERMS = ["Fall 2026", "Spring 2027", "Summer 2027"]
NOW = dt.datetime(2026, 6, 12, 12, 0, tzinfo=dt.UTC)


def _item(i, **kw):
    d = {"key": f"url:https://x.com/{i}", "company": f"Co{i}",
         "title": f"SWE Intern {i}", "location": "Atlanta, GA", "salary": None,
         "url": f"https://x.com/{i}", "tag": "", "term": "Fall 2026",
         "added": "2026-06-12", "applied": False}
    d.update(kw)
    return d


def _success(value):
    return httpx.Response(200, json={"status": "success", "value": value})


def _mock_client(monkeypatch, handler):
    """Replace store.httpx.Client with one using `handler` (MockTransport)."""
    real = httpx.Client

    def factory(**kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(**kwargs)

    monkeypatch.setattr(store.httpx, "Client", factory)


def _mock_dashboard_client(monkeypatch, handler):
    real = httpx.Client

    def factory(**kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(**kwargs)

    monkeypatch.setattr(dashboard.httpx, "Client", factory)


def _make_store(monkeypatch, tmp_path):
    monkeypatch.setenv("CONVEX_URL", "https://test.convex.cloud")
    monkeypatch.setenv("CONVEX_SECRET", "secret")
    return store.ConvexStore(tmp_path, {"name": "example"})


# -- get_ticks ------------------------------------------------------------

def test_get_ticks_builds_view_with_all_present(monkeypatch, tmp_path):
    seen = []

    def handler(request):
        assert request.method == "POST"
        body = json.loads(request.content)
        assert body["path"] == "tracker:getTicks"
        assert body["args"] == {"user": "example", "secret": "secret"}
        assert body["format"] == "json"
        seen.append(body["path"])
        return _success([
            {"short": "a1" * 6, "applied": True, "saved": False,
             "dismissed": False},
            {"short": "b1" * 6, "applied": False, "saved": True,
             "dismissed": False},
            {"short": "c1" * 6, "applied": False, "saved": False,
             "dismissed": True},
        ])

    _mock_client(monkeypatch, handler)
    s = _make_store(monkeypatch, tmp_path)
    view = s.get_ticks("example")
    assert view is not None
    shorts = {"a1" * 6, "b1" * 6, "c1" * 6}
    # every row-bearing short is present for all three kinds (no window)
    assert view.present == shorts and view.h_present == shorts
    assert view.s_present == shorts
    assert view.checked == {"a1" * 6}
    assert view.saved == {"b1" * 6}
    assert view.hidden == {"c1" * 6}
    assert view.issue_open is True
    assert s.error_name is None
    assert s.read_warning is None  # success clears it
    assert s.writable is True


def test_get_ticks_none_and_records_error_on_api_error(monkeypatch, tmp_path):
    def handler(request):
        return httpx.Response(200, json={"status": "error",
                                          "errorMessage": "boom"})

    _mock_client(monkeypatch, handler)
    s = _make_store(monkeypatch, tmp_path)
    assert s.get_ticks("example") is None
    assert s.error_name == "ApiError"


def test_get_ticks_none_on_transport_error(monkeypatch, tmp_path):
    def handler(request):
        raise httpx.ConnectError("down")

    _mock_client(monkeypatch, handler)
    s = _make_store(monkeypatch, tmp_path)
    assert s.get_ticks("example") is None
    assert s.error_name == "ApiError"


def test_get_ticks_read_warning_folds_in_detail(monkeypatch, tmp_path):
    """The store wrapper is ApiError; read_warning carries the real cause
    (the bare exception class alone would be useless to the user)."""

    def handler(request):
        raise httpx.ConnectError("boom")

    _mock_client(monkeypatch, handler)
    s = _make_store(monkeypatch, tmp_path)
    assert s.get_ticks("example") is None
    assert s.error_name == "ApiError"
    assert s.read_warning is not None
    assert s.read_warning.startswith("couldn't reach the Convex store")
    assert s.read_warning.endswith("-- ticks and statuses may be stale")
    assert "boom" in s.read_warning  # the underlying cause is folded in


# -- set_ticks / record_status ---------------------------------------------

def test_set_ticks_one_mutation_with_secret(monkeypatch, tmp_path):
    calls = []

    def handler(request):
        body = json.loads(request.content)
        assert body["path"] == "tracker:setTicks"
        assert body["args"] == {
            "user": "example",
            "writes": [{"short": "ab" * 6, "field": "applied", "value": True},
                       {"short": "cd" * 6, "field": "saved", "value": False}],
            "secret": "secret",
        }
        calls.append(1)
        return _success(None)

    _mock_client(monkeypatch, handler)
    s = _make_store(monkeypatch, tmp_path)
    out = s.set_ticks("example", [
        store.TickWrite("ab" * 6, "applied", True),
        store.TickWrite("cd" * 6, "saved", False),
    ])
    assert out == []  # Convex commits instantly; nothing workflow-queued
    assert len(calls) == 1


def test_set_ticks_raises_on_api_error(monkeypatch, tmp_path):
    def handler(request):
        return httpx.Response(200, json={"status": "error",
                                          "errorMessage": "bad secret"})

    _mock_client(monkeypatch, handler)
    with pytest.raises(store.ApiError):
        _make_store(monkeypatch, tmp_path).set_ticks(
            "example", [store.TickWrite("ab" * 6, "applied", True)])


def test_record_status_validates_and_payload(monkeypatch, tmp_path):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return _success(None)

    _mock_client(monkeypatch, handler)
    s = _make_store(monkeypatch, tmp_path)
    s.record_status("example", "ab" * 6, "oa", note="HackerRank",
                    snapshot={"company": "Acme"})
    assert calls[0]["path"] == "tracker:recordStatus"
    assert calls[0]["args"] == {"user": "example", "short": "ab" * 6,
                                "status": "oa", "note": "HackerRank",
                                "snapshot": {"company": "Acme"},
                                "secret": "secret"}
    with pytest.raises(store.ApiError):
        s.record_status("example", "ab" * 6, "not-a-status")


# -- get_ledger / push_matches / get_matches -------------------------------

def test_get_ledger_shapes_records(monkeypatch, tmp_path):
    def handler(request):
        body = json.loads(request.content)
        assert body["path"] == "tracker:getLedger"
        assert body["args"] == {"user": "example", "secret": "secret"}
        return _success([
            {"short": "ab" * 6, "status": "oa", "note": "HackerRank",
             "history": [{"status": "applied", "at": "2026-07-02T09:00:00Z"},
                         {"status": "oa", "note": "HackerRank",
                          "at": "2026-07-09T13:00:00Z"}],
             "snapshot": {"key": "url:a", "company": "Acme",
                          "title": "SWE Intern", "url": "https://x/a"},
             "createdAt": "2026-07-02T09:00:00Z"},
        ])

    _mock_client(monkeypatch, handler)
    rec = _make_store(monkeypatch, tmp_path).get_ledger("example")["ab" * 6]
    assert rec["company"] == "Acme"
    assert rec["status"] == "oa"
    assert rec["note"] == "HackerRank"
    assert rec["history"] == [
        {"on": "2026-07-02", "status": "applied"},
        {"on": "2026-07-09", "status": "oa", "note": "HackerRank"},
    ]
    assert rec["applied"] == "2026-07-02"


def test_get_ledger_missing_snapshot_falls_back_to_created_at(
        monkeypatch, tmp_path):
    def handler(request):
        body = json.loads(request.content)
        assert body["path"] == "tracker:getLedger"
        assert body["args"] == {"user": "example", "secret": "secret"}
        return _success([
            {"short": "ab" * 6, "status": "oa", "note": None,
             "history": [{"status": "applied",
                          "at": "2026-07-02T09:00:00Z"}],
             "snapshot": None, "createdAt": "2026-07-03T08:00:00Z"},
        ])

    _mock_client(monkeypatch, handler)
    rec = _make_store(monkeypatch, tmp_path).get_ledger("example")["ab" * 6]
    assert set(rec) - {"status", "history", "applied"} == set()
    assert rec["applied"] == "2026-07-03"


def test_push_matches_chunks_upserts_then_prunes_once(monkeypatch, tmp_path):
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        return _success(None)

    _mock_client(monkeypatch, handler)
    items = [_item(i) for i in range(450)]
    _make_store(monkeypatch, tmp_path).push_matches("example", items)
    upserts = [c for c in calls if c["path"] == "tracker:pushMatches"]
    prunes = [c for c in calls if c["path"] == "tracker:pruneMatches"]
    # 450 > chunk: three pure-upsert chunks, each carrying the augmented short
    assert [len(c["args"]["items"]) for c in upserts] == [200, 200, 50]
    for c in upserts:
        for it in c["args"]["items"]:
            assert it["short"] == dashboard.short_key(it["key"])
    # ...plus ONE prune over the FULL kept set (never per chunk, or a chunk
    # would delete the others' rows)
    assert len(prunes) == 1
    prune = prunes[0]["args"]
    assert set(prune["keep"]) == {dashboard.short_key(i["key"]) for i in items}
    assert prune["secret"] == "secret"


def test_push_matches_within_chunk_still_prunes(monkeypatch, tmp_path):
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body["path"])
        return _success(None)

    _mock_client(monkeypatch, handler)
    _make_store(monkeypatch, tmp_path).push_matches("example", [_item(1)])
    # one upsert + one prune even when the snapshot fits in a single chunk,
    # so rows dropped from the state list still get cleaned up
    assert calls == ["tracker:pushMatches", "tracker:pruneMatches"]


def test_get_matches_returns_item_payloads(monkeypatch, tmp_path):
    def handler(request):
        body = json.loads(request.content)
        assert body["path"] == "tracker:getMatches"
        assert body["args"] == {"user": "example", "secret": "secret"}
        return _success([{"key": "url:1", "company": "Co1", "short": "ab" * 6}])

    _mock_client(monkeypatch, handler)
    assert _make_store(monkeypatch, tmp_path).get_matches("example") == [
        {"key": "url:1", "company": "Co1", "short": "ab" * 6}]


# -- mail sync --------------------------------------------------------------

def test_get_actions_queries_mail_module(monkeypatch, tmp_path):
    seen = []

    def handler(request):
        body = json.loads(request.content)
        assert body["path"] == "mail:getActions"
        assert body["args"] == {"user": "example", "secret": "secret"}
        seen.append(body["path"])
        return _success({"actions": [], "health": None})

    _mock_client(monkeypatch, handler)
    out = _make_store(monkeypatch, tmp_path).get_actions("example")
    assert out == {"actions": [], "health": None}
    assert seen == ["mail:getActions"]


def test_get_actions_degrades_to_none_on_error(monkeypatch, tmp_path):
    def handler(request):
        return httpx.Response(200, json={"status": "error",
                                          "errorMessage": "boom"})

    _mock_client(monkeypatch, handler)
    assert _make_store(monkeypatch, tmp_path).get_actions("example") is None


def test_get_actions_degrades_to_none_on_transport_error(monkeypatch,
                                                         tmp_path):
    def handler(request):
        raise httpx.ConnectError("down")

    _mock_client(monkeypatch, handler)
    assert _make_store(monkeypatch, tmp_path).get_actions("example") is None


def test_resolve_action_shapes_args(monkeypatch, tmp_path):
    """short/status only present when non-empty; dismiss only present when
    True; the secret is always carried."""
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        return _success(None)

    _mock_client(monkeypatch, handler)
    s = _make_store(monkeypatch, tmp_path)

    s.resolve_action("example", "act-1", short="ab" * 6, status="oa")
    assert calls[-1]["path"] == "mail:resolveAction"
    assert calls[-1]["args"] == {"user": "example", "id": "act-1",
                                 "short": "ab" * 6, "status": "oa",
                                 "secret": "secret"}
    # empty short/status are omitted entirely
    s.resolve_action("example", "act-2", short="", status="")
    assert calls[-1]["args"] == {"user": "example", "id": "act-2",
                                 "secret": "secret"}
    # dismiss=True carries dismiss and skips short/status
    s.resolve_action("example", "act-3", dismiss=True)
    assert calls[-1]["args"] == {"user": "example", "id": "act-3",
                                 "dismiss": True, "secret": "secret"}
    # dismiss omitted when False
    s.resolve_action("example", "act-4", short="cd" * 6, status="rejected")
    assert "dismiss" not in calls[-1]["args"]


def test_set_mail_account_mutation(monkeypatch, tmp_path):
    calls = []

    def handler(request):
        body = json.loads(request.content)
        assert body["path"] == "mail:setMailAccount"
        assert body["args"] == {
            "user": "example", "email": "a@x.com", "refreshToken": "rt",
            "secret": "secret"}
        calls.append(1)
        return _success(None)

    _mock_client(monkeypatch, handler)
    _make_store(monkeypatch, tmp_path).set_mail_account(
        "example", "a@x.com", "rt")
    assert calls == [1]


def test_tracker_module_prefix_regression(monkeypatch, tmp_path):
    """The generalized _post still routes the existing tracker functions
    under the `tracker:` prefix -- the mail functions are mail:, not a
    global change."""
    paths = []

    def handler(request):
        body = json.loads(request.content)
        paths.append(body["path"])
        return _success([])

    _mock_client(monkeypatch, handler)
    s = _make_store(monkeypatch, tmp_path)
    s.get_ticks("example")
    s.set_ticks("example", [store.TickWrite("ab" * 6, "applied", True)])
    s.get_ledger("example")
    s.get_matches("example")
    s.get_actions("example")
    assert paths == ["tracker:getTicks", "tracker:setTicks",
                     "tracker:getLedger", "tracker:getMatches",
                     "mail:getActions"]


def test_every_read_query_carries_the_secret(monkeypatch, tmp_path):
    """Each read query must send the secret with its args, or the deployment
    (which now gates reads with TRACKER_SECRET) would reject it. Guards
    against a future refactor dropping the secret from one path."""
    by_path = {
        "tracker:getTicks": _success([]),
        "tracker:getLedger": _success([]),
        "tracker:getMatches": _success([]),
        "tracker:getResumeUrls": _success([]),
        "mail:getActions": _success({"actions": [], "health": None}),
    }

    def handler(request):
        body = json.loads(request.content)
        assert body["args"].get("secret") == "secret"
        return by_path[body["path"]]

    _mock_client(monkeypatch, handler)
    s = _make_store(monkeypatch, tmp_path)
    assert s.get_ticks("example") is not None
    assert s.get_ledger("example") == {}
    assert s.get_matches("example") == []
    assert s.get_actions("example") == {"actions": [], "health": None}
    assert s.get_resume_urls("example") == {}


# -- resume storage --------------------------------------------------------

def test_put_resume_uploads_and_attaches(monkeypatch, tmp_path):
    """put_resume mints an upload URL, POSTs the DOCX bytes with the DOCX
    content-type, then attaches the storage id to the (user, short) row."""
    calls = []
    upload_url = "https://storage.example.com/upload/xyz"

    def handler(request):
        url = str(request.url)
        if url.startswith("https://test.convex.cloud"):
            body = json.loads(request.content)
            if body["path"] == "tracker:generateResumeUploadUrl":
                assert body["args"] == {"user": "example", "short": "ab" * 6,
                                        "secret": "secret"}
                return _success(upload_url)
            if body["path"] == "tracker:attachResume":
                assert body["args"] == {
                    "user": "example", "short": "ab" * 6,
                    "filename": "Jane_Doe_Acme.docx",
                    "storageId": "st000abc", "secret": "secret"}
                calls.append("attach")
                return _success(None)
            raise AssertionError(f"unexpected convex path {body['path']}")
        if url == upload_url:
            assert request.headers["Content-Type"] == store.ConvexStore._DOCX_MIME
            assert request.content == b"docx-bytes"
            calls.append("upload")
            return httpx.Response(200, json={"storageId": "st000abc"})
        raise AssertionError(f"unexpected upload url {url}")

    _mock_client(monkeypatch, handler)
    ref = _make_store(monkeypatch, tmp_path).put_resume(
        "example", "ab" * 6, "Jane_Doe_Acme.docx", b"docx-bytes")
    # the bytes land before the row is attached
    assert calls == ["upload", "attach"]
    assert ref == "st000abc"


def test_put_resume_raises_when_upload_is_degraded(monkeypatch, tmp_path):
    def handler(request):
        url = str(request.url)
        if url.startswith("https://test.convex.cloud"):
            body = json.loads(request.content)
            if body["path"] == "tracker:generateResumeUploadUrl":
                return _success("https://storage.example.com/upload")
            raise AssertionError(f"must not attach: {body['path']}")
        return httpx.Response(500)  # upload fails

    _mock_client(monkeypatch, handler)
    with pytest.raises(store.ApiError):
        _make_store(monkeypatch, tmp_path).put_resume(
            "example", "ab" * 6, "Jane_Doe_Acme.docx", b"docx-bytes")


def test_get_resume_urls_returns_serving_urls(monkeypatch, tmp_path):
    def handler(request):
        body = json.loads(request.content)
        assert body["path"] == "tracker:getResumeUrls"
        assert body["args"] == {"user": "example", "secret": "secret"}
        return _success([
            {"short": "ab" * 6,
             "url": "https://test.convex.cloud/api/storage/abc",
             "filename": "Jane_Doe_Acme.docx"},
            {"short": "cd" * 6,
             "url": "https://test.convex.cloud/api/storage/def",
             "filename": "Jane_Doe_Beta.docx"},
        ])

    _mock_client(monkeypatch, handler)
    assert _make_store(monkeypatch, tmp_path).get_resume_urls("example") == {
        "ab" * 6: "https://test.convex.cloud/api/storage/abc",
        "cd" * 6: "https://test.convex.cloud/api/storage/def",
    }


def test_get_resume_urls_empty_when_absent(monkeypatch, tmp_path):
    def handler(request):
        body = json.loads(request.content)
        assert body["path"] == "tracker:getResumeUrls"
        return _success([])

    _mock_client(monkeypatch, handler)
    assert _make_store(monkeypatch, tmp_path).get_resume_urls("example") == {}


def test_get_resume_urls_empty_on_api_error(monkeypatch, tmp_path):
    def handler(request):
        return httpx.Response(200, json={"status": "error",
                                          "errorMessage": "boom"})

    _mock_client(monkeypatch, handler)
    assert _make_store(monkeypatch, tmp_path).get_resume_urls("example") == {}


def test_put_profile_sends_data_as_a_json_string(monkeypatch, tmp_path):
    """Convex field names must be non-control ASCII, so a profile dict (which
    can carry user-authored dict keys, e.g. a project name with an em dash)
    is sent as a JSON string, not the raw object - inserting such an object
    server-side fails with an opaque "Server Error"."""
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        return _success(None)

    _mock_client(monkeypatch, handler)
    data = {"header": {"name": "Alex"},
            "projects": {"Sys-savesync — Save Sync": {"tech": ["C"]}}}
    _make_store(monkeypatch, tmp_path).put_profile("example", data)
    assert calls[0]["path"] == "resume:putProfile"
    assert calls[0]["args"]["user"] == "example"
    assert calls[0]["args"]["secret"] == "secret"
    assert isinstance(calls[0]["args"]["data"], str)
    assert json.loads(calls[0]["args"]["data"]) == data


# -- constructor + factory -------------------------------------------------

def test_constructor_raises_without_env(monkeypatch, tmp_path):
    monkeypatch.delenv("CONVEX_URL", raising=False)
    monkeypatch.delenv("CONVEX_SECRET", raising=False)
    with pytest.raises(store.ApiError):
        store.ConvexStore(tmp_path, {"name": "example"})
    monkeypatch.setenv("CONVEX_URL", "https://x.convex.cloud")
    with pytest.raises(store.ApiError):
        store.ConvexStore(tmp_path, {"name": "example"})


def test_make_store_convex_and_unknown(monkeypatch, tmp_path):
    monkeypatch.setenv("CONVEX_URL", "https://x.convex.cloud")
    monkeypatch.setenv("CONVEX_SECRET", "secret")
    monkeypatch.setenv("STORE", "convex")
    assert isinstance(store.make_store(tmp_path, {"name": "u"}),
                      store.ConvexStore)
    monkeypatch.setenv("STORE", "bogus")
    with pytest.raises(ValueError) as ei:
        store.make_store(tmp_path, {"name": "u"})
    assert "convex" in str(ei.value)


# -- read-only digest mode -------------------------------------------------

def test_build_body_read_only_digest():
    matches = [_item(1, tag="[TOP]", salary="$50/hr"),
               _item(2, applied=True), _item(3, dismissed=True)]
    body = dashboard.build_body(matches, TERMS, NOW, interactive=False)
    # no markers, no checkboxes anywhere
    for marker in ("<!--iw:", "<!--iws:", "<!--iwd:", "<!--iwb:"):
        assert marker not in body
    assert "- [ ]" not in body and "- [x]" not in body
    # active row renders as a plain line, tag + suffix parts intact (the tag
    # and salary are markdown-escaped, so `[TOP]`/`$` survive to the output)
    assert "Co1 — [SWE Intern 1](https://x.com/1) (Atlanta, GA)" in body
    assert "· $50/hr" in body and "· seen 2026-06-12" in body
    # header note flags read-only + the webui
    assert "Read-only digest" in body and "src.webui" in body
    assert dashboard.parse_checkboxes(body) == (set(), set())
    assert dashboard.parse_dismissed(body) == (set(), set())
    assert dashboard.parse_saved(body) == (set(), set())


def test_build_body_interactive_still_has_controls():
    matches = [_item(1, applied=True)]
    body = dashboard.build_body(matches, TERMS, NOW)
    assert "<!--iw:" in body
    short = dashboard.short_key("url:https://x.com/1")
    checked, present = dashboard.parse_checkboxes(body)
    assert checked == {short} and present == {short}


def test_sync_user_interactive_false_patches_digest(monkeypatch):
    state = st.empty_state()
    st.matches_add(state, "example", _item(1))
    st.matches_add(state, "example", _item(2, applied=True))
    state["_meta"]["dashboard_issue"] = {"example": 7}
    patched = []

    def handler(request):
        assert request.method == "PATCH"
        patched.append(json.loads(request.content))
        return httpx.Response(200, json={"number": 7})

    _mock_dashboard_client(monkeypatch, handler)
    dashboard.sync_user(state, "example", TERMS, NOW,
                        "owner/intern-watch", "tok",
                        ticks=store.TicksView(), interactive=False)
    assert len(patched) == 1
    body = patched[0]["body"]
    assert "<!--iw:" not in body and "iws:" not in body and "iwd:" not in body
    assert "- [ ]" not in body and "- [x]" not in body
    assert dashboard.parse_checkboxes(body) == (set(), set())


# -- migration script ------------------------------------------------------

def _fabricate(tmp_path):
    path = tmp_path / "state"
    path.mkdir(parents=True)
    state = st.empty_state()
    st.matches_add(state, "example", _item(1))
    st.matches_add(state, "example", _item(2, applied=True))
    st.matches_add(state, "example", _item(3, dismissed=True))
    st.save_state(state, path / "seen.json")
    short = dashboard.short_key("url:https://x.com/1")
    ledger.save_ledger({"example": {short: {
        "key": "url:https://x.com/1", "company": "Co1",
        "title": "SWE Intern 1", "applied": "2026-06-12",
        "status": "oa",
        "history": [{"on": "2026-06-12", "status": "applied"},
                    {"on": "2026-06-20", "status": "oa", "note": "n"}]}}},
        path / "applications.json")
    return short


def test_migrate_dry_run_prints_and_writes_nothing(monkeypatch, tmp_path,
                                                   capsys):
    from scripts import migrate_tracker_to_convex as mig

    _fabricate(tmp_path)

    def handler(request):
        raise AssertionError(f"dry run must not call {request.url}")

    _mock_client(monkeypatch, handler)  # any httpx call fails the dry run
    rc = mig.main(["--dry-run", "--root", str(tmp_path)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "[example]" in out
    assert "2 tick write" in out
    assert "1 record" in out and "history" in out
    assert "3 matches" in out
    assert "nothing written" in out


def test_migrate_live_writes(monkeypatch, tmp_path, capsys):
    from scripts import migrate_tracker_to_convex as mig

    _fabricate(tmp_path)
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body["path"])
        return _success(None)

    _mock_client(monkeypatch, handler)
    monkeypatch.setenv("CONVEX_URL", "https://test.convex.cloud")
    monkeypatch.setenv("CONVEX_SECRET", "secret")
    rc = mig.main(["--root", str(tmp_path)])
    assert rc == 0
    # 2 tick writes in ONE setTicks; 2 ledger history entries; 3 matches
    assert calls == ["tracker:setTicks", "tracker:recordStatus",
                     "tracker:recordStatus", "tracker:pushMatches",
                     "tracker:pruneMatches"]
    out = capsys.readouterr().out
    assert "migrated 1 user(s)" in out


# -- webui Hub wired to ConvexStore -----------------------------------------

def test_hub_with_convex_store_refresh_overlays_ticks(monkeypatch, tmp_path):
    """A Convex-backed Hub reads ticks from the deployment (not a GitHub
    issue), is writable, and never touches the GitHub API."""
    from src.webui import server as srv

    monkeypatch.setenv("CONVEX_URL", "https://test.convex.cloud")
    monkeypatch.setenv("CONVEX_SECRET", "secret")
    state = st.empty_state()
    st.matches_add(state, "example", _item(1))
    st.matches_add(state, "example", _item(2))
    st.matches_add(state, "example", _item(3))
    items = st.matches_items(state, "example")
    shorts = [dashboard.short_key(i["key"]) for i in items]
    a, b, c = shorts
    state["_meta"]["dashboard_issue"] = {"example": 5}
    state_path = tmp_path / "state" / "seen.json"
    state_path.parent.mkdir(parents=True)
    st.save_state(state, state_path)

    convex_rows = [  # the deployment's tick rows drive the overlay
        {"short": a, "applied": True, "saved": False, "dismissed": False},
        {"short": b, "applied": False, "saved": False, "dismissed": True},
        {"short": c, "applied": False, "saved": True, "dismissed": False},
    ]

    def handler(request):
        # Convex only -- refresh must never call the GitHub API
        assert str(request.url).startswith("https://test.convex.cloud")
        body = json.loads(request.content)
        if body["path"] == "tracker:getTicks":
            return _success(convex_rows)
        if body["path"] == "tracker:getLedger":
            return _success([])
        if body["path"] == "tracker:getResumeUrls":
            return _success([])
        raise AssertionError(f"unexpected convex call {body['path']}")

    _mock_client(monkeypatch, handler)
    conv = store.ConvexStore(tmp_path, {"name": "example"})
    hub = srv.Hub(tmp_path, "example", TERMS, fetch=False, store=conv)
    hub.refresh()
    assert hub.writable is True
    assert hub.checked == {a}
    assert hub.hidden == {b}
    assert hub.saved == {c}
    snap = hub.snapshot()
    by_short = {m["short"]: m for m in snap["matches"]}
    assert by_short[a]["applied"] is True and by_short[a]["saved"] is False
    assert by_short[b]["dismissed"] is True
    assert by_short[c]["saved"] is True and by_short[c]["applied"] is False
