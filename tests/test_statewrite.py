"""dashboard-write path: the statewrite CLI and the webui pending overlay."""

import json

from src import dashboard, statewrite
from src import state as st
from src.webui import core


def _item(key, **kw):
    base = {"key": key, "company": "Acme", "title": "SWE Intern",
            "url": "https://example.com/j/1", "location": "Atlanta, GA",
            "term": "Fall 2026", "added": "2026-06-01", "applied": False}
    base.update(kw)
    return base


def _short(key):
    return dashboard.short_key(key)


# -- apply_write semantics ----------------------------------------------------

def test_apply_write_applied_roundtrip():
    state = st.empty_state()
    state["matches"]["u"] = [_item("url:a")]
    assert statewrite.apply_write(state, "u", _short("url:a"),
                                  "applied", True)["applied"] is True
    # mutates the real state entry, not a copy
    assert state["matches"]["u"][0]["applied"] is True
    statewrite.apply_write(state, "u", _short("url:a"), "applied", False)
    assert state["matches"]["u"][0]["applied"] is False


def test_apply_write_saved_roundtrip():
    state = st.empty_state()
    state["matches"]["u"] = [_item("url:a")]
    assert statewrite.apply_write(state, "u", _short("url:a"),
                                  "saved", True)["saved"] is True
    assert state["matches"]["u"][0]["saved"] is True
    statewrite.apply_write(state, "u", _short("url:a"), "saved", False)
    assert state["matches"]["u"][0]["saved"] is False


def test_apply_write_dismiss_and_restore_mirror_issue_semantics():
    state = st.empty_state()
    state["matches"]["u"] = [_item("url:a", restored=True)]
    item = statewrite.apply_write(state, "u", _short("url:a"),
                                  "dismissed", True)
    assert item["dismissed"] is True and "restored" not in item
    item = statewrite.apply_write(state, "u", _short("url:a"),
                                  "dismissed", False)
    # sparse + sweep-exempt, exactly like matches_set_dismissed
    assert "dismissed" not in item and item["restored"] is True


def test_apply_write_unknown_short_returns_none():
    state = st.empty_state()
    state["matches"]["u"] = [_item("url:a")]
    assert statewrite.apply_write(state, "u", "0" * 12,
                                  "applied", True) is None
    assert statewrite.apply_write(state, "ghost", _short("url:a"),
                                  "applied", True) is None


# -- CLI ----------------------------------------------------------------------

def test_cli_writes_state_file(tmp_path, capsys):
    path = tmp_path / "seen.json"
    state = st.empty_state()
    state["matches"]["u"] = [_item("url:a")]
    st.save_state(state, path)

    rc = statewrite.main(["--user", "u", "--short", _short("url:a"),
                          "--field", "dismissed", "--value", "true",
                          "--state", str(path)])
    assert rc == 0
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["matches"]["u"][0]["dismissed"] is True
    assert "Acme" in capsys.readouterr().out


def test_cli_writes_saved_field(tmp_path, capsys):
    path = tmp_path / "seen.json"
    state = st.empty_state()
    state["matches"]["u"] = [_item("url:a")]
    st.save_state(state, path)

    rc = statewrite.main(["--user", "u", "--short", _short("url:a"),
                          "--field", "saved", "--value", "true",
                          "--state", str(path)])
    assert rc == 0
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["matches"]["u"][0]["saved"] is True


def test_cli_unknown_short_exits_nonzero(tmp_path, capsys):
    path = tmp_path / "seen.json"
    st.save_state(st.empty_state(), path)
    rc = statewrite.main(["--user", "u", "--short", "0" * 12,
                          "--field", "applied", "--value", "true",
                          "--state", str(path)])
    assert rc == 1
    assert "no match" in capsys.readouterr().err


# -- webui pending overlay ----------------------------------------------------

def test_overlay_pending_applies_then_reconciles():
    a, b = _short("url:a"), _short("url:b")
    shaped = core.shape_matches([_item("url:a"), _item("url:b")])
    pending = {a: {"applied": True}, b: {"dismissed": True}}

    still = core.overlay_pending(shaped, pending)
    by = {m["short"]: m for m in shaped}
    assert by[a]["applied"] is True and by[a]["pending"] is True
    assert by[b]["dismissed"] is True
    assert still == pending  # state doesn't reflect the writes yet

    # commit landed: state now agrees -> pending drains, no overlay flag
    shaped = core.shape_matches([_item("url:a", applied=True),
                                 _item("url:b", dismissed=True)])
    still = core.overlay_pending(shaped, still)
    assert still == {}
    assert all("pending" not in m for m in shaped)


def test_overlay_pending_drops_vanished_matches():
    shaped = core.shape_matches([_item("url:a")])
    still = core.overlay_pending(shaped, {_short("url:gone"):
                                          {"applied": True}})
    assert still == {}
