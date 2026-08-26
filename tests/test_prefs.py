"""Watch-prefs overlay and report (src/prefs.py)."""

import datetime as dt
import json

from src import prefs

TODAY = dt.date(2026, 8, 26)
NOW = dt.datetime(2026, 8, 26, 14, 0, tzinfo=dt.UTC)


def _yaml():
    return {"name": "example",
            "notify": {"email": {"smtp_user_env": "U", "smtp_pass_env": "P",
                                 "timezone": "America/New_York",
                                 "send_at_local": [8], "to": "a@x.com"}},
            "terms_wanted": ["Fall 2026"],
            "term_rules": {"Spring": "top_atl_remote", "Summer": "anything",
                           "Fall": "top_atl_remote"},
            "priority": {"companies": ["Microsoft"], "from_tracker": False}}


def test_overlay_none_is_a_copy():
    cfg = _yaml()
    out = prefs.apply_overlay(cfg, None)
    assert out == cfg and out is not cfg


def test_overlay_turns_on_rolling_terms_and_maps_keys():
    out = prefs.apply_overlay(_yaml(), {
        "terms": {"leadWeeks": 2, "horizonMonths": 12,
                  "include": ["Summer 2028"], "exclude": []},
        "rules": {"Summer": "priority_only", "Bogus": "anything"},
        "priority": {"companies": ["Meta", " Amazon "], "fromTracker": True,
                     "emailImmediately": False},
        "location": {"remoteCounts": False},
        "email": {"sendAtLocal": [18, 8, 8], "timezone": "UTC",
                  "to": ["b@x.com", "c@x.com"]},
    })
    assert out["terms"] == {"rolling": True, "lead_weeks": 2,
                            "horizon_months": 12,
                            "include": ["Summer 2028"], "exclude": []}
    assert out["term_rules"] == {"Spring": "top_atl_remote",
                                 "Summer": "priority_only",
                                 "Fall": "top_atl_remote"}
    assert out["priority"] == {"companies": ["Meta", "Amazon"],
                               "from_tracker": True,
                               "email_immediately": False}
    assert out["location"] == {"remote_counts": False}
    assert out["notify"]["email"]["send_at_local"] == [8, 18]
    assert out["notify"]["email"]["timezone"] == "UTC"
    assert out["notify"]["email"]["to"] == "b@x.com, c@x.com"


def test_overlay_ignores_malformed_values():
    out = prefs.apply_overlay(_yaml(), {
        "terms": {"leadWeeks": "three", "include": "Summer 2028"},
        "rules": "anything",
        "priority": {"companies": "Meta", "fromTracker": "yes"},
        "email": {"sendAtLocal": [8, "x"], "to": []},
    })
    assert out["terms"] == {"rolling": True}
    assert out["term_rules"] == _yaml()["term_rules"]
    assert out["priority"] == _yaml()["priority"]
    assert out["notify"]["email"]["send_at_local"] == [8]
    assert out["notify"]["email"]["to"] == "a@x.com"


def test_tracker_companies_reads_the_ledger_file(tmp_path):
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "applications.json").write_text(json.dumps({
        "example": {"abc": {"company": "Databricks", "status": "applied"},
                    "def": {"company": "Databricks, Inc.", "status": "oa"},
                    "ghi": {"company": "Ramp", "status": "interview"}},
        "other": {"zzz": {"company": "Nope", "status": "applied"}},
    }), encoding="utf-8")
    got = prefs.tracker_companies("example", tmp_path)
    assert got == {"databricks": "Databricks", "ramp": "Ramp"}
    assert prefs.tracker_companies("nobody", tmp_path) == {}


def test_watch_report_shape():
    cfg = prefs.apply_overlay(_yaml(), {"terms": {"leadWeeks": 3,
                                                  "horizonMonths": 14}})
    rep = prefs.watch_report(cfg, TODAY, NOW, {"ramp": "Ramp"},
                             legacy_rules=False)
    assert rep["reported_at"] == NOW.isoformat()
    assert rep["terms"]["rolling"] is True
    assert [r["term"] for r in rep["terms"]["rows"] if r["wanted"]] == [
        "Spring 2027", "Summer 2027", "Fall 2027"]
    assert rep["rules"] == {"legacy": False, "Spring": "top_atl_remote",
                            "Summer": "anything", "Fall": "top_atl_remote"}
    assert rep["priority"]["companies"] == ["Microsoft"]
    assert rep["priority"]["tracker_companies"] == ["Ramp"]
    assert rep["priority"]["subject_names"] is True
    assert rep["location"] == {"metro": "Atlanta, GA", "radius_miles": 35,
                               "remote_counts": True}
    assert rep["email"] == {"send_at_local": [8],
                            "timezone": "America/New_York", "to": ["a@x.com"]}


def test_watch_report_legacy_terms():
    rep = prefs.watch_report(_yaml(), TODAY, NOW, {}, legacy_rules=True)
    assert rep["terms"]["rolling"] is False
    assert [r["term"] for r in rep["terms"]["rows"]] == ["Fall 2026"]
    assert rep["rules"]["legacy"] is True
