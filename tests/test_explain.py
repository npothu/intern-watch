"""--explain KEY decision tracer: read-only, no network, no state writes.

fetch_all is monkeypatched to a fixed job set; load_users is monkeypatched to
hermetic configs so the trace never depends on the shipped users/example.yaml.
"""

from __future__ import annotations

import datetime as dt

from src import main, state as st
from src.models import Job

TODAY = dt.date(2026, 6, 12)

DELIVERED = "jr:" + "a" * 24   # SWE intern, accept-always Summer rule
REJECTED = "jr:" + "b" * 24    # excluded keyword in title


def _user_cfg() -> dict:
    return {
        "name": "tester",
        "role_filter": {
            "include_keywords": ["swe", "engineer"],
            "exclude_keywords": ["mechanical"],
        },
        "terms_wanted": ["Summer 2027"],
        "unknown_term_policy": "keep",
        "rules": [{"when": {"term": ["Summer 2027"]},
                   "accept_if_any": [{"always": True}]}],
        "notify": {"email": {"send_at_utc": [18]}},
    }


def _jobs() -> list[Job]:
    return [
        Job(company="Stripe", title="SWE Intern", url="https://x.test/a",
            dedup_key=DELIVERED, terms=["Summer 2027"],
            term_confidence="explicit", source="jobright-swe"),
        Job(company="BoltCo", title="Mechanical Engineer Intern",
            url="https://x.test/b", dedup_key=REJECTED, terms=["Summer 2027"],
            term_confidence="explicit", source="jobright-swe"),
    ]


def _patch(monkeypatch):
    monkeypatch.setattr(main, "load_sources", lambda path: [])
    monkeypatch.setattr(main, "fetch_all",
                        lambda sources, state, today: _jobs())
    monkeypatch.setattr(main, "dedupe", lambda jobs: jobs)
    monkeypatch.setattr(main, "load_users", lambda d: [_user_cfg()])


def _trace(monkeypatch, key, state=None, user=None):
    _patch(monkeypatch)
    return "\n".join(
        main.explain(key, state or st.empty_state(), TODAY,
                     [_user_cfg()], user))


# ---------------------------------------------------------------- delivered job

def test_delivered_job_trace_accepts(monkeypatch):
    state = st.empty_state()
    st.mark_notified(state, DELIVERED, "tester")
    out = _trace(monkeypatch, DELIVERED, state)
    assert "role filter: pass" in out
    assert "elimination: none" in out
    assert "FINAL: ACCEPT" in out
    assert "always" in out                 # the accept reason
    assert "notified=True" in out          # status read from state


# ---------------------------------------------------------------- rejected job

def test_rejected_job_trace_shows_keyword(monkeypatch):
    out = _trace(monkeypatch, REJECTED)
    assert "FINAL: REJECT" in out
    assert "excluded-keyword:mechanical" in out
    assert "role filter: REJECT" in out


# ---------------------------------------------------------------- never ingested

def test_never_ingested_path(monkeypatch):
    out = _trace(monkeypatch, "jr:" + "c" * 24)
    assert "never ingested" in out
    assert "grep" in out                   # the hint


# ---------------------------------------------------------------- --user filter

def test_user_filter_limits_trace(monkeypatch):
    out = _trace(monkeypatch, DELIVERED, user="tester")
    assert "user: tester" in out
    # an unknown --user yields the no-config note, not a traceback
    out2 = _trace(monkeypatch, DELIVERED, user="nobody")
    assert "no user config named 'nobody'" in out2


# ---------------------------------------------------------------- no state writes

def test_explain_does_not_write_state(monkeypatch, tmp_path):
    _patch(monkeypatch)
    state_file = tmp_path / "seen.json"
    rc = main.main(["--explain", DELIVERED, "--state-file", str(state_file)])
    assert rc == 0
    assert not state_file.exists()         # read-only path never persists
