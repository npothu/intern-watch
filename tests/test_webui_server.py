"""Web UI server: the Hub's batch tick writes and the single/batch toggle
routes, wired through the FakeStore tracker driver."""

import io
import json

import pytest

from src.store import ApiError
from src.webui.server import Handler, Hub
from tests.fakestore import FakeStore


def _writable_store():
    """A FakeStore with the plumbing fields set so Hub.writable is true."""
    fs = FakeStore()
    fs.repo, fs.token, fs.issue_number = "owner/intern-watch", "tok", 7
    return fs


def _hub(tmp_path, store=None):
    store = store or _writable_store()
    hub = Hub(tmp_path, "example", [], fetch=False, store=store)
    # refresh() would normally seed the issue number and cache sets from
    # origin/main + the issue read-back; seed them directly so the Hub is
    # writable and instant writes are observable
    hub.issue_number = store.issue_number
    hub.checked, hub.present = set(), set()
    hub.hidden, hub.h_present = set(), set()
    hub.saved, hub.s_present = set(), set()
    return hub


# -- set_ticks_batch -------------------------------------------------------

def test_set_ticks_batch_instant_writes_update_cache_and_payload(tmp_path):
    hub = _hub(tmp_path)
    a, b = "a" * 12, "b" * 12
    res = hub.set_ticks_batch("dismissed", [a, b], True)

    assert res == {"ok": True, "field": "dismissed", "value": True,
                   "count": 2, "queued": []}
    # instant rows updated the live cache set, and the store saw them too
    assert hub.hidden == {a, b}
    assert hub.store.get_ticks("example").hidden == {a, b}
    assert hub.pending == {}


def test_set_ticks_batch_validates_short_format(tmp_path):
    hub = _hub(tmp_path)
    with pytest.raises(ApiError, match="lowercase hex"):
        hub.set_ticks_batch("dismissed", ["not-a-short"], True)
    with pytest.raises(ApiError, match="lowercase hex"):
        hub.set_ticks_batch("dismissed", ["A" * 12], True)  # uppercase


def test_set_ticks_batch_rejects_over_500(tmp_path):
    hub = _hub(tmp_path)
    with pytest.raises(ApiError, match="500"):
        hub.set_ticks_batch("dismissed", ["a" * 12] * 501, True)


def test_set_ticks_batch_rejects_unknown_field(tmp_path):
    hub = _hub(tmp_path)
    with pytest.raises(ApiError, match="unknown tick field"):
        hub.set_ticks_batch("bogus", ["a" * 12], True)
    # every known field is accepted
    for field in ("applied", "saved", "dismissed"):
        hub.set_ticks_batch(field, ["a" * 12], True)


class _QueuingStore(FakeStore):
    """set_ticks reports the shorts that a real issue would NOT render (no
    checkbox to PATCH) as queued, while applying the rendered ones."""

    def __init__(self, queued: set):
        super().__init__()
        self.queued = queued

    def set_ticks(self, user, writes):
        q = [w.short for w in writes if w.short in self.queued]
        super().set_ticks(user, [w for w in writes if w.short not in self.queued])
        return q


def test_set_ticks_batch_queued_shorts_land_in_pending(tmp_path):
    a, c = "a" * 12, "c" * 12
    store = _QueuingStore({c})
    store.repo, store.token, store.issue_number = "owner/intern-watch", "tok", 7
    hub = _hub(tmp_path, store=store)

    res = hub.set_ticks_batch("dismissed", [a, c], True)

    assert res["queued"] == [c]
    assert hub.hidden == {a}                       # instant row updated
    assert c not in hub.hidden
    assert hub.pending.get(c) == {"dismissed": True}   # overlaid until commit
    assert hub.pending.get(a) is None
    # the store only persisted the instant row
    assert hub.store.get_ticks("example").hidden == {a}


# -- handler routes --------------------------------------------------------

def _post(hub, path, payload):
    """Run Handler.do_POST against an in-memory request/response, returning
    the parsed JSON payload written back."""
    body = json.dumps(payload).encode("utf-8")
    h = object.__new__(Handler)
    h.hub = hub
    h.headers = {"Content-Length": str(len(body))}
    h.rfile = io.BytesIO(body)
    h.wfile = io.BytesIO()
    h.path = path
    h.send_response = lambda *a, **k: None
    h.send_header = lambda *a, **k: None
    h.end_headers = lambda: None
    h.do_POST()
    return json.loads(h.wfile.getvalue())


def test_handler_dismissed_batch_payload_shape(tmp_path):
    hub = _hub(tmp_path)
    a, b = "a" * 12, "b" * 12
    res = _post(hub, "/api/dismissed",
                {"shorts": [a, b], "dismissed": True})
    assert res == {"ok": True, "field": "dismissed", "value": True,
                   "count": 2, "queued": []}


def test_handler_dismissed_single_returns_exact_legacy_shape(tmp_path):
    hub = _hub(tmp_path)
    a = "a" * 12
    res = _post(hub, "/api/dismissed", {"short": a, "dismissed": True})
    # the EXACT legacy payload keys a cached page expects
    assert set(res) == {"ok", "short", "dismissed", "queued"}
    assert res["ok"] is True
    assert res["short"] == a
    assert res["dismissed"] is True
    assert res["queued"] is False


def test_handler_single_and_batch_cover_all_fields(tmp_path):
    hub = _hub(tmp_path)
    a = "a" * 12
    assert set(_post(hub, "/api/applied", {"short": a, "applied": True})) == \
        {"ok", "short", "applied", "queued"}
    assert set(_post(hub, "/api/saved", {"short": a, "saved": True})) == \
        {"ok", "short", "saved", "queued"}


def test_handler_batch_invalid_short_errors(tmp_path):
    hub = _hub(tmp_path)
    res = _post(hub, "/api/dismissed",
                {"shorts": ["bad"], "dismissed": True})
    assert "error" in res and "hex" in res["error"]


# -- mail-sync inbox --------------------------------------------------------

def test_snapshot_includes_inbox_actions_none_by_default(tmp_path):
    hub = _hub(tmp_path)
    assert "inbox_actions" in hub.snapshot()
    assert hub.snapshot()["inbox_actions"] is None  # frontend hides the tab


def test_snapshot_includes_populated_inbox(tmp_path):
    hub = _hub(tmp_path)
    hub.inbox = {"actions": [{"id": "act-1"}], "health": None}
    assert hub.snapshot()["inbox_actions"] == {"actions": [{"id": "act-1"}],
                                               "health": None}


def test_refresh_loads_inbox_from_store(tmp_path):
    store = _writable_store()
    store.actions = {"actions": [{"id": "act-1"}], "health": None}
    hub = _hub(tmp_path, store=store)
    hub.refresh()
    assert hub.inbox == {"actions": [{"id": "act-1"}], "health": None}


def test_refresh_mail_failure_does_not_break_refresh(monkeypatch, tmp_path):
    """A get_actions exception is swallowed: inbox stays None, refresh keeps
    its other warnings, and the Hub stays fully usable."""
    import logging
    from src.webui import server as srv

    store = _writable_store()

    class _BrokenMail(FakeStore):
        def get_actions(self, user):
            raise RuntimeError("gmail down")

    monkeypatch.setattr(srv, "log", logging.getLogger("test-noop"))
    hub = _hub(tmp_path, store=_BrokenMail())
    hub.refresh()  # must not raise
    assert hub.inbox is None


# -- health warnings --------------------------------------------------------

def _health(**kw):
    base = {"email": "a@x.com", "lastPushAt": None, "lastSyncAt": None,
            "lastError": None, "lastErrorAt": None, "watchExpiration": None,
            "historyId": None}
    base.update(kw)
    return base


def _mills(hours_ago):
    import datetime as dt
    now = dt.datetime.now(dt.timezone.utc)
    return int((now - dt.timedelta(hours=hours_ago)).timestamp() * 1000)


def test_mail_health_warning_error():
    from src.webui.server import _mail_health_warnings
    w = _mail_health_warnings(_health(lastError="quota exceeded"))
    assert "mail sync error: quota exceeded" in w


def test_mail_health_warning_stale():
    from src.webui.server import _mail_health_warnings
    # 49h old sync with a real account -> stalled
    w = _mail_health_warnings(_health(lastSyncAt=_mills(49)))
    assert "mail sync stalled (>48h)" in w
    # fresh sync (1h) -> no stalled warning
    assert "stalled" not in _mail_health_warnings(
        _health(lastSyncAt=_mills(1)))
    # no account (no email) yet -> never flagged stalled
    assert _mail_health_warnings(_health(email=None, lastSyncAt=_mills(49))) == []


def test_mail_health_warning_expired_watch():
    from src.webui.server import _mail_health_warnings
    # in the past (1h ago) -> expired warning
    w = _mail_health_warnings(_health(watchExpiration=_mills(1)))
    assert "gmail watch expired - rerun setup" in w
    # future expiration -> no warning
    assert _mail_health_warnings(_health(watchExpiration=_mills(-0.5))) == []


def test_refresh_derives_all_health_warnings(tmp_path):
    store = _writable_store()
    store.actions = {"actions": [], "health": _health(
        lastError="quota", lastSyncAt=_mills(49), watchExpiration=_mills(1))}
    hub = _hub(tmp_path, store=store)
    hub.refresh()
    joined = " ".join(hub.warnings)
    assert "mail sync error: quota" in joined
    assert "mail sync stalled (>48h)" in joined
    assert "gmail watch expired - rerun setup" in joined


# -- /api/action route ------------------------------------------------------

def test_action_resolve_pending_overlay(tmp_path):
    """A resolve runs the set_status pending bookkeeping (a resolved action
    implies an application). Checked directly because a snapshot() call drains
    pending through the match overlay."""
    hub = _hub(tmp_path)
    hub.resolve_action("act-1", short="a" * 12, status="oa")
    assert hub.pending.get("a" * 12) == {"status": "oa", "applied": True}
    assert hub.store.resolve_calls == [("example", "act-1", "a" * 12,
                                        "oa", False)]


def test_action_route_resolve_drops_action(tmp_path):
    hub = _hub(tmp_path)
    hub.inbox = {"actions": [{"id": "act-1", "subject": "hi"},
                             {"id": "act-2"}], "health": None}
    res = _post(hub, "/api/action",
                {"id": "act-1", "short": "a" * 12, "status": "oa"})
    assert res["ok"] is True
    # the resolved action is gone from the cached inbox
    assert hub.inbox["actions"] == [{"id": "act-2"}]
    assert hub.store.resolve_calls == [("example", "act-1", "a" * 12,
                                        "oa", False)]


def test_action_dismiss_needs_no_short(tmp_path):
    hub = _hub(tmp_path)
    hub.inbox = {"actions": [{"id": "act-9"}], "health": None}
    res = _post(hub, "/api/action", {"id": "act-9", "dismiss": True})
    assert res["ok"] is True
    assert hub.inbox["actions"] == []
    assert hub.pending == {}
    assert hub.store.resolve_calls == [("example", "act-9", "", "", True)]


def test_action_bad_status_returns_400(tmp_path):
    hub = _hub(tmp_path)
    hub.inbox = {"actions": [{"id": "act-1"}], "health": None}
    res = _post(hub, "/api/action",
                {"id": "act-1", "short": "a" * 12, "status": "bogus"})
    assert "error" in res and "bogus" in res["error"]
    assert "status" in res["error"]
    assert hub.store.resolve_calls == []  # never reached the store


def test_action_requires_short_unless_dismiss(tmp_path):
    hub = _hub(tmp_path)
    hub.inbox = {"actions": [{"id": "act-1"}], "health": None}
    res = _post(hub, "/api/action", {"id": "act-1", "status": "oa"})
    assert "error" in res and "short" in res["error"]
