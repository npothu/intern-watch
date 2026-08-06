"""Dashboard issue: body generation, checkbox roundtrip, API sync."""

import datetime as dt
import json

import httpx
import yaml

from src import dashboard as db, main, state as st, store

NOW = dt.datetime(2026, 6, 12, 12, 0, tzinfo=dt.timezone.utc)
TERMS = ["Fall 2026", "Spring 2027", "Summer 2027"]


def _item(i, term="Fall 2026", **kw):
    d = {"key": f"url:https://x.com/{i}", "company": f"Co{i}",
         "title": f"SWE Intern {i}", "location": "Atlanta, GA", "salary": None,
         "url": f"https://x.com/{i}", "tag": "", "term": term,
         "added": "2026-06-12", "applied": False}
    d.update(kw)
    return d


def test_body_checkbox_roundtrip():
    matches = [_item(1), _item(2, applied=True), _item(3, term="Summer 2027")]
    body = db.build_body(matches, TERMS, NOW)
    checked, present = db.parse_checkboxes(body)
    assert present == {db.short_key(m["key"]) for m in matches}
    assert checked == {db.short_key(matches[1]["key"])}
    assert body.index("Fall 2026") < body.index("Summer 2027")
    assert "3 matches · 1 applied" in body


def test_user_tick_flows_back_into_state():
    state = st.empty_state()
    assert st.matches_add(state, "example", _item(1)) is True
    assert st.matches_add(state, "example", _item(1)) is False   # idempotent
    st.matches_add(state, "example", _item(2))

    body = db.build_body(st.matches_items(state, "example"), TERMS, NOW)
    target = db.short_key("url:https://x.com/1")
    edited = "\n".join(
        line.replace("- [ ]", "- [x]", 1) if f"iw:{target}" in line else line
        for line in body.splitlines())

    checked, present = db.parse_checkboxes(edited)
    by_short = {db.short_key(m["key"]): m["key"]
                for m in st.matches_items(state, "example")}
    st.matches_set_applied(state, "example",
                           {by_short[s] for s in checked},
                           {by_short[s] for s in present})
    applied = {i["key"]: i["applied"] for i in st.matches_items(state, "example")}
    assert applied["url:https://x.com/1"] is True
    assert applied["url:https://x.com/2"] is False


def test_unrendered_matches_keep_applied_flag():
    state = st.empty_state()
    st.matches_add(state, "example", _item(1, applied=True))
    st.matches_set_applied(state, "example", set(), set())   # row not on issue
    assert st.matches_items(state, "example")[0]["applied"] is True


def test_markdown_escaping_and_url_parens():
    row = db._row(_item(1, title="C++ [Backend] *Intern*",
                        url="https://x.com/job(123)", tag="[TOP]",
                        salary="$50/hr"))
    assert "\\[Backend\\]" in row
    assert "%28123%29" in row
    assert "(123)" not in row
    assert "$50/hr" in row


def test_row_shows_visible_resume_command():
    # The short key lives in a hidden HTML comment; the row must also surface
    # the exact `/resume <key>` to copy-paste into a comment.
    item = _item(1)
    short = db.short_key(item["key"])
    row = db._row(item)
    assert f"`/resume {short}`" in row
    assert f"<!--iw:{short}-->" in row


def test_truncation_note_past_max_rows():
    matches = [_item(i) for i in range(db.MAX_ROWS + 5)]
    body = db.build_body(matches, TERMS, NOW)
    _, present = db.parse_checkboxes(body)
    assert len(present) == db.MAX_ROWS
    assert "5 older match(es) not shown" in body


def test_matches_pruned_with_jobs():
    state = st.empty_state()
    st.matches_add(state, "example", _item(1, added="2026-01-01"))
    st.matches_add(state, "example", _item(2, added="2026-06-10"))
    st.prune(state, dt.date(2026, 6, 12), keep_days=120)
    assert [i["key"] for i in st.matches_items(state, "example")] \
        == ["url:https://x.com/2"]


def _mock_client(monkeypatch, handler):
    real = httpx.Client

    def factory(**kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(**kwargs)

    monkeypatch.setattr(db.httpx, "Client", factory)


def _mock_store_client(monkeypatch, handler):
    """Patch src.store's httpx too: the TrackerStore drivers open their own."""
    real = httpx.Client

    def factory(**kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(**kwargs)

    monkeypatch.setattr(store.httpx, "Client", factory)


def test_sync_creates_then_updates_issue(monkeypatch):
    posted, patched = [], []
    issue_body = {"value": ""}

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content) if request.content else {}
        if request.method == "POST":
            posted.append(payload)
            issue_body["value"] = payload["body"]
            return httpx.Response(201, json={"number": 7})
        if request.method == "GET":
            return httpx.Response(200, json={"state": "open",
                                             "body": issue_body["value"]})
        if request.method == "PATCH":
            patched.append(payload)
            issue_body["value"] = payload["body"]
            return httpx.Response(200, json={"number": 7})
        raise AssertionError(f"unexpected {request.method}")

    _mock_client(monkeypatch, handler)
    state = st.empty_state()
    st.matches_add(state, "example", _item(1))
    st.matches_add(state, "example", _item(2))

    # first run: creates the issue, remembers its number
    db.sync_user(state, "example", TERMS, NOW, "owner/intern-watch", "tok")
    assert state["_meta"]["dashboard_issue"]["example"] == 7
    assert len(posted) == 1 and not patched

    # user ticks item 1 on GitHub
    target = db.short_key("url:https://x.com/1")
    issue_body["value"] = "\n".join(
        line.replace("- [ ]", "- [x]", 1) if f"iw:{target}" in line else line
        for line in issue_body["value"].splitlines())

    # second run: reads the tick back, rewrites the body with it preserved
    db.sync_user(state, "example", TERMS, NOW, "owner/intern-watch", "tok")
    assert len(patched) == 1
    applied = {i["key"]: i["applied"] for i in st.matches_items(state, "example")}
    assert applied["url:https://x.com/1"] is True
    checked, _ = db.parse_checkboxes(patched[0]["body"])
    assert checked == {target}


def test_sync_skips_closed_issue(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"state": "closed", "body": ""})
        raise AssertionError("closed issue must not be written to")

    _mock_client(monkeypatch, handler)
    state = st.empty_state()
    st.matches_add(state, "example", _item(1))
    state["_meta"]["dashboard_issue"] = {"example": 7}
    db.sync_user(state, "example", TERMS, NOW, "owner/intern-watch", "tok")


def test_sync_recreates_deleted_issue(monkeypatch):
    posted = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(404)
        if request.method == "POST":
            posted.append(json.loads(request.content))
            return httpx.Response(201, json={"number": 9})
        raise AssertionError(f"unexpected {request.method}")

    _mock_client(monkeypatch, handler)
    state = st.empty_state()
    st.matches_add(state, "example", _item(1))
    state["_meta"]["dashboard_issue"] = {"example": 7}
    db.sync_user(state, "example", TERMS, NOW, "owner/intern-watch", "tok")
    assert state["_meta"]["dashboard_issue"]["example"] == 9
    assert len(posted) == 1


# --------------------------------------------- retro cross-source cleanup

def _dup_item(key, url, **kw):
    d = {"key": key, "company": "Cloudflare", "title": "Security Eng Intern",
         "location": "Austin, TX", "salary": None, "url": url, "tag": "",
         "term": "Fall 2026", "added": "2026-06-12", "applied": False}
    d.update(kw)
    return d


GH_A = "https://boards.greenhouse.io/cloudflare/jobs/8052785"
GH_B = "https://job-boards.greenhouse.io/cloudflare/jobs/8052785"


def test_dedup_existing_demotes_redundant_row():
    state = st.empty_state()
    state["matches"]["u"] = [
        _dup_item("url:a", GH_A, added="2026-06-10"),
        _dup_item("jr:b", GH_B, added="2026-06-12"),
    ]
    n = db.dedup_existing_matches(state, "u")
    assert n == 1
    by_key = {i["key"]: i for i in state["matches"]["u"]}
    assert not by_key["url:a"].get("dismissed")   # earliest-added survivor
    assert by_key["jr:b"]["dismissed"] is True


def test_dedup_existing_preserves_applied_and_saved():
    state = st.empty_state()
    state["matches"]["u"] = [
        _dup_item("url:a", GH_A, added="2026-06-10"),
        _dup_item("jr:b", GH_B, added="2026-06-12", applied=True),
    ]
    db.dedup_existing_matches(state, "u")
    by_key = {i["key"]: i for i in state["matches"]["u"]}
    # applied row is the survivor; the other is hidden, applied row untouched.
    assert by_key["jr:b"]["applied"] is True
    assert not by_key["jr:b"].get("dismissed")
    assert by_key["url:a"]["dismissed"] is True


def test_dedup_existing_keeps_all_when_two_acted_rows():
    state = st.empty_state()
    state["matches"]["u"] = [
        _dup_item("url:a", GH_A, applied=True),
        _dup_item("jr:b", GH_B, saved=True),
    ]
    assert db.dedup_existing_matches(state, "u") == 0
    assert not any(i.get("dismissed") for i in state["matches"]["u"])


def test_dedup_existing_idempotent_and_respects_restored():
    state = st.empty_state()
    state["matches"]["u"] = [
        _dup_item("url:a", GH_A, added="2026-06-10"),
        _dup_item("jr:b", GH_B, added="2026-06-12", restored=True),
    ]
    # restored row is never re-hidden.
    assert db.dedup_existing_matches(state, "u") == 0
    # idempotent: second call is a no-op even after clearing restored.
    state["matches"]["u"][1].pop("restored")
    assert db.dedup_existing_matches(state, "u") == 0


def test_dedup_existing_catches_jobright_url_row_via_content():
    # The historical jr: row stores the jobright link (canon None); it must
    # still be grouped with its greenhouse twins via content compatibility.
    state = st.empty_state()
    state["matches"]["u"] = [
        _dup_item("url:boards", GH_A, added="2026-06-10"),
        _dup_item("jr:cf", "https://jobright.ai/jobs/info/" + "c" * 24,
                  added="2026-06-11"),
        _dup_item("url:jobboards", GH_B, added="2026-06-12", term="Unknown term"),
    ]
    n = db.dedup_existing_matches(state, "u")
    assert n == 2   # earliest (url:boards) survives, other two hidden
    by_key = {i["key"]: i for i in state["matches"]["u"]}
    assert not by_key["url:boards"].get("dismissed")
    assert by_key["jr:cf"]["dismissed"] is True
    assert by_key["url:jobboards"]["dismissed"] is True


# --------------------------------------------- dashboard.main CLI (store-aware)

def _setup_root(tmp_path, matches, issue=7):
    """A repo-shaped root: users/example.yaml + state/seen.json with the
    dashboard issue number pinned (GitHubStore resolves it from state)."""
    (tmp_path / "users").mkdir()
    (tmp_path / "users" / "example.yaml").write_text(
        yaml.safe_dump({"name": "example", "terms_wanted": TERMS}),
        encoding="utf-8")
    (tmp_path / "state").mkdir()
    state = st.empty_state()
    for m in matches:
        st.matches_add(state, "example", m)
    if issue:
        state["_meta"]["dashboard_issue"] = {"example": issue}
    st.save_state(state, tmp_path / "state" / "seen.json")
    state_path = tmp_path / "state" / "seen.json"
    return state, state_path


def test_main_github_store_repaints_interactive(tmp_path, monkeypatch):
    """STORE unset -> GitHubStore ticks with interactive=True: the PATCHed
    body still carries the iw: markers + checkboxes."""
    matches = [_item(1), _item(2, applied=True)]
    _setup_root(tmp_path, matches)
    ticks_body = db.build_body(matches, TERMS, NOW)
    patched, gets = [], []

    def handler(request):
        if request.method == "GET":
            gets.append(str(request.url))
            return httpx.Response(200, json={"state": "open",
                                             "body": ticks_body})
        if request.method == "PATCH":
            patched.append(json.loads(request.content))
            return httpx.Response(200, json={"number": 7})
        raise AssertionError(f"unexpected {request.method} {request.url}")

    _mock_client(monkeypatch, handler)        # dashboard.httpx (sync_user)
    _mock_store_client(monkeypatch, handler)  # store.httpx (get_ticks)
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/intern-watch")
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    monkeypatch.delenv("STORE", raising=False)

    assert db.main(["--user", "example", "--root", str(tmp_path)]) == 0
    # the store read the issue back, and the repaint is still interactive.
    assert gets
    assert patched
    assert "<!--iw:" in patched[0]["body"]
    assert "- [ ]" in patched[0]["body"]


def test_main_convex_store_repaints_digest(tmp_path, monkeypatch):
    """STORE=convex -> read-back from the store and a read-only digest: no
    GitHub issue GET beyond the sync_user PATCH, and the PATCHed body has no
    markers or checkboxes anywhere."""
    matches = [_item(1), _item(2, applied=True)]
    _setup_root(tmp_path, matches)
    short = db.short_key(matches[1]["key"])
    patched, convex_posts, gets = [], [], []

    def handler(request):
        if request.method == "POST" and "convex.cloud" in str(request.url):
            convex_posts.append(json.loads(request.content))
            return httpx.Response(200, json={"status": "success", "value": [
                {"short": short, "applied": True}]})
        if request.method == "GET":
            gets.append(str(request.url))
            return httpx.Response(404)
        if request.method == "PATCH":
            patched.append(json.loads(request.content))
            return httpx.Response(200, json={"number": 7})
        raise AssertionError(f"unexpected {request.method} {request.url}")

    _mock_client(monkeypatch, handler)        # dashboard.httpx (sync_user)
    _mock_store_client(monkeypatch, handler)  # store.httpx (convex AND github)
    monkeypatch.setenv("STORE", "convex")
    monkeypatch.setenv("CONVEX_URL", "https://test.convex.cloud")
    monkeypatch.setenv("CONVEX_SECRET", "secret")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/intern-watch")
    monkeypatch.setenv("GITHUB_TOKEN", "tok")

    assert db.main(["--user", "example", "--root", str(tmp_path)]) == 0
    # ticks came from the Convex store; the only GitHub request is the PATCH.
    assert convex_posts
    assert gets == []
    assert patched
    assert "<!--iw:" not in patched[0]["body"]
    for marker in ("<!--iws:", "<!--iwd:", "<!--iwb:"):
        assert marker not in patched[0]["body"]
    assert "- [ ]" not in patched[0]["body"]
    assert "- [x]" not in patched[0]["body"]
    assert "Read-only digest" in patched[0]["body"]


# ------------- _sync_dashboard (watcher cron; store repo/token may be unset)

def _dashboard_state(matches, issue=7):
    """State shaped for _sync_dashboard: matches + a pinned dashboard issue."""
    state = st.empty_state()
    for m in matches:
        st.matches_add(state, "example", m)
    if issue:
        state["_meta"]["dashboard_issue"] = {"example": issue}
    return state


def _stub_store_ledger(monkeypatch):
    """_sync_dashboard mirrors the store's ledger book into state; stub the
    ledger module so no real state/applications.json is touched."""
    class _Ledger:
        @staticmethod
        def sync_file(*a, **k):
            return None

        @staticmethod
        def ledger_path(*a, **k):
            return None

        @staticmethod
        def load_ledger(*a, **k):
            return {}

        @staticmethod
        def save_ledger(*a, **k):
            return None

    monkeypatch.setattr(main, "ledger", _Ledger)


def test_sync_dashboard_convex_repaints_digest(monkeypatch):
    """STORE=convex (non-GitHub store, repo/token empty) + Actions env:
    _sync_dashboard still repaints a read-only digest via the env repo/token;
    no issue GET happens because ticks come from the store."""
    matches = [_item(1), _item(2, applied=True)]
    state = _dashboard_state(matches)
    short = db.short_key(matches[1]["key"])
    ticks = store.TicksView(checked={short}, present={short})
    urls, patched = [], []

    def handler(request):
        urls.append(str(request.url))
        if request.method == "PATCH":
            patched.append(json.loads(request.content))
            return httpx.Response(200, json={"number": 7})
        raise AssertionError(f"unexpected {request.method} {request.url}")

    class _Convex:
        repo = ""
        token = ""

        def get_ticks(self, user):
            return ticks

        def get_ledger(self, user):
            return {}

        def push_matches(self, user, matches):
            pass

    _mock_client(monkeypatch, handler)                 # dashboard.httpx
    monkeypatch.setattr(main, "make_store",
                        lambda root, cfg=None: _Convex())
    _stub_store_ledger(monkeypatch)
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/intern-watch")
    monkeypatch.setenv("GITHUB_TOKEN", "tok")

    main._sync_dashboard("example", state, False, NOW, TERMS)

    # the digest was repainted to the env-provided (not the store's empty) repo.
    assert any("/repos/owner/intern-watch/issues/7" in u for u in urls)
    assert patched
    assert "<!--iw:" not in patched[0]["body"]
    for marker in ("<!--iws:", "<!--iwd:", "<!--iwb:"):
        assert marker not in patched[0]["body"]
    assert "- [ ]" not in patched[0]["body"]
    assert "- [x]" not in patched[0]["body"]
    assert "Read-only digest" in patched[0]["body"]


def test_sync_dashboard_convex_env_unset_skips(monkeypatch):
    """STORE=convex but no GITHUB_REPOSITORY/GITHUB_TOKEN: _sync_dashboard
    returns before touching the store or the issue - a clean skip."""
    state = _dashboard_state([_item(1)])

    def handler(request):
        raise AssertionError(f"no request expected, got {request.method}")

    _mock_client(monkeypatch, handler)

    def _never(root, cfg=None):
        raise AssertionError("make_store must not be called")

    monkeypatch.setattr(main, "make_store", _never)
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)

    main._sync_dashboard("example", state, False, NOW, TERMS)
    # no exception and no client interaction means it skipped cleanly.


def test_sync_dashboard_github_repaints_interactive(monkeypatch):
    """GitHub driver (interactive store) + Actions env: the repaint still
    carries the iw: markers + checkboxes; env repo/token reach sync_user."""
    matches = [_item(1), _item(2, applied=True)]
    state = _dashboard_state(matches)
    urls, patched = [], []

    def handler(request):
        urls.append(str(request.url))
        if request.method == "PATCH":
            patched.append(json.loads(request.content))
            return httpx.Response(200, json={"number": 7})
        raise AssertionError(f"unexpected {request.method} {request.url}")

    class _GitHub:
        repo = "owner/intern-watch"
        token = "tok"

        def get_ticks(self, user):
            return store.TicksView()

        def get_ledger(self, user):
            return {}

        def push_matches(self, user, matches):
            pass

    _mock_client(monkeypatch, handler)
    # isinstance(store, GitHubStore) drives interactive=True in _sync_dashboard.
    monkeypatch.setattr(main, "GitHubStore", _GitHub)
    monkeypatch.setattr(main, "make_store",
                        lambda root, cfg=None: _GitHub())
    _stub_store_ledger(monkeypatch)
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/intern-watch")
    monkeypatch.setenv("GITHUB_TOKEN", "tok")

    main._sync_dashboard("example", state, False, NOW, TERMS)

    assert any("/repos/owner/intern-watch/issues/7" in u for u in urls)
    assert patched
    assert "<!--iw:" in patched[0]["body"]
    assert "- [ ]" in patched[0]["body"]
