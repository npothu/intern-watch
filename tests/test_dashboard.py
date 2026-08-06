"""Dashboard issue: body generation, checkbox roundtrip, API sync."""

import datetime as dt
import json

import httpx

from src import dashboard as db, state as st

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
