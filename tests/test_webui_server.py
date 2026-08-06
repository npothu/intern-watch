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
