"""Applications ledger: permanent records, status history, watcher sync."""

import datetime as dt
import json

from src import dashboard, ledger, state as st, statewrite
from src.webui import core

TODAY = dt.date(2026, 7, 2)
LATER = dt.date(2026, 7, 9)


def _item(key, **kw):
    base = {"key": key, "company": "Acme", "title": "SWE Intern",
            "url": "https://example.com/j/1", "location": "Atlanta, GA",
            "term": "Fall 2026", "added": "2026-06-20", "applied": False}
    base.update(kw)
    return base


def _short(key):
    return dashboard.short_key(key)


# -- records ------------------------------------------------------------------

def test_record_applied_snapshots_and_is_idempotent():
    led = {}
    rec = ledger.record_applied(led, "u", _item("url:a", salary=None,
                                                resume="resumes/u/x/y.docx"),
                                TODAY)
    assert rec["company"] == "Acme" and rec["resume"] == "resumes/u/x/y.docx"
    assert "salary" not in rec                       # None fields dropped
    assert rec["applied"] == "2026-07-02"
    assert rec["history"] == [{"on": "2026-07-02", "status": "applied"}]
    # re-tick: nothing resets
    ledger.set_status(led, "u", _short("url:a"), "oa", LATER)
    assert ledger.record_applied(led, "u", _item("url:a"), LATER) is None
    assert led["u"][_short("url:a")]["status"] == "oa"


def test_set_status_appends_history_and_skips_noop_repeats():
    led = {}
    ledger.record_applied(led, "u", _item("url:a"), TODAY)
    short = _short("url:a")
    rec = ledger.set_status(led, "u", short, "oa", LATER,
                            note="HackerRank, due 7/14")
    assert rec["status"] == "oa"
    assert rec["history"][-1] == {"on": "2026-07-09", "status": "oa",
                                  "note": "HackerRank, due 7/14"}
    ledger.set_status(led, "u", short, "oa", LATER)  # no-op repeat
    assert len(rec["history"]) == 2
    assert ledger.set_status(led, "u", "0" * 12, "oa", LATER) is None


def test_set_status_rejects_unknown_status():
    led = {}
    ledger.record_applied(led, "u", _item("url:a"), TODAY)
    try:
        ledger.set_status(led, "u", _short("url:a"), "ghosted", TODAY)
    except ValueError:
        pass
    else:
        raise AssertionError("ghosted must not be settable")


def test_unprogressed_removal_rule():
    led = {}
    ledger.record_applied(led, "u", _item("url:a"), TODAY)
    ledger.record_applied(led, "u", _item("url:b"), TODAY)
    ledger.set_status(led, "u", _short("url:b"), "interview", LATER)
    assert ledger.remove_if_unprogressed(led, "u", _short("url:a"))
    assert not ledger.remove_if_unprogressed(led, "u", _short("url:b"))
    assert list(led["u"]) == [_short("url:b")]


# -- watcher sync -------------------------------------------------------------

def test_sync_records_backfills_and_honors_unticks():
    led = {}
    matches = [_item("url:a", applied=True), _item("url:b", applied=True),
               _item("url:c")]
    assert ledger.sync_records(led, "u", matches, TODAY) is True
    assert set(led["u"]) == {_short("url:a"), _short("url:b")}

    # url:b progressed, then both get unticked: only url:a is dropped
    ledger.set_status(led, "u", _short("url:b"), "offer", LATER)
    for m in matches:
        m["applied"] = False
    assert ledger.sync_records(led, "u", matches, LATER) is True
    assert set(led["u"]) == {_short("url:b")}
    # steady state: nothing to do
    assert ledger.sync_records(led, "u", matches, LATER) is False


def test_sync_file_roundtrip(tmp_path):
    path = tmp_path / "applications.json"
    state = st.empty_state()
    state["matches"]["u"] = [_item("url:a", applied=True)]
    assert ledger.sync_file(state, "u", path, TODAY) is True
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["u"][_short("url:a")]["status"] == "applied"
    assert ledger.sync_file(state, "u", path, TODAY) is False  # unchanged


# -- statewrite status path ---------------------------------------------------

def test_apply_status_on_unrecorded_match_implies_applied():
    state = st.empty_state()
    state["matches"]["u"] = [_item("url:a")]
    led = {}
    rec = statewrite.apply_status(state, led, "u", _short("url:a"),
                                  "phone_screen", "recruiter call Tue",
                                  TODAY)
    assert rec["status"] == "phone_screen"
    assert [h["status"] for h in rec["history"]] == ["applied",
                                                     "phone_screen"]
    assert state["matches"]["u"][0]["applied"] is True
    assert statewrite.apply_status(state, led, "u", "0" * 12, "oa",
                                   "", TODAY) is None


def test_statewrite_cli_status(tmp_path, capsys):
    spath, lpath = tmp_path / "seen.json", tmp_path / "applications.json"
    state = st.empty_state()
    state["matches"]["u"] = [_item("url:a", applied=True)]
    st.save_state(state, spath)
    ledger.save_ledger({"u": {_short("url:a"): {
        "company": "Acme", "title": "SWE Intern", "key": "url:a",
        "applied": "2026-07-02", "status": "applied",
        "history": [{"on": "2026-07-02", "status": "applied"}]}}}, lpath)

    rc = statewrite.main(["--user", "u", "--short", _short("url:a"),
                          "--field", "status", "--value", "interview",
                          "--note", "onsite 7/20",
                          "--state", str(spath), "--ledger", str(lpath)])
    assert rc == 0 and "interview" in capsys.readouterr().out
    saved = json.loads(lpath.read_text(encoding="utf-8"))
    rec = saved["u"][_short("url:a")]
    assert rec["status"] == "interview"
    assert rec["history"][-1]["note"] == "onsite 7/20"

    rc = statewrite.main(["--user", "u", "--short", _short("url:a"),
                          "--field", "status", "--value", "nonsense",
                          "--state", str(spath), "--ledger", str(lpath)])
    assert rc == 1


# -- webui pending overlay with string fields ---------------------------------

def test_overlay_pending_handles_status_strings():
    shaped = core.shape_matches([_item("url:a", applied=True)])
    shaped[0]["status"] = "applied"  # as attached from the ledger
    short = _short("url:a")
    pending = {short: {"status": "oa", "applied": True}}

    still = core.overlay_pending(shaped, pending)
    assert shaped[0]["status"] == "oa" and shaped[0]["pending"] is True
    assert still == {short: {"status": "oa"}}  # applied already agreed

    shaped = core.shape_matches([_item("url:a", applied=True)])
    shaped[0]["status"] = "oa"       # commit landed
    assert core.overlay_pending(shaped, still) == {}
