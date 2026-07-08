"""Queue/orchestration tests — no browser, no network (resolve + session stubbed)."""

from __future__ import annotations

import contextlib
import datetime as dt
import json

from pathlib import Path

import pytest

from src.apply import queue as q
from src.apply.base import (ApplyContext, ApplyMode, ApplyResult, ApplyStatus,
                            ATSFamily)
from src.apply.profile import load_profile

TODAY = dt.date(2026, 6, 17)


@pytest.fixture
def profile():
    return load_profile(path=Path(__file__).resolve().parents[1] / "users" / "apply.example.yaml")


def _match(key, company="Acme", url="https://x/y", **extra):
    return {"key": key, "company": company, "title": "SWE Intern", "url": url, **extra}


def test_resume_path_for_naming(profile):
    p = q.resume_path_for(profile, "Stripe, Inc.")
    assert p.name == f"{profile.first_name}_{profile.last_name}_StripeInc.docx"


def test_build_plan_gating(monkeypatch, profile):
    monkeypatch.setattr(q, "resolve", lambda url: (url + "#final", ATSFamily.greenhouse))
    monkeypatch.setattr(q.Path, "exists", lambda self: True)

    matches = [
        _match("a"),
        _match("b", applied=True),
        _match("c"),
        _match("d", approved_to_apply=True),
    ]
    auto = {it.key: it for it in q.build_plan(matches, profile, ApplyMode.autofill)}
    assert auto["a"].eligible and auto["a"].family is ATSFamily.greenhouse
    assert not auto["b"].eligible and auto["b"].skip_reason == "already applied"
    assert auto["c"].eligible

    sub = {it.key: it for it in q.build_plan(matches, profile, ApplyMode.submit)}
    assert not sub["c"].eligible and "approved" in sub["c"].skip_reason
    assert sub["d"].eligible


def test_build_plan_missing_resume(monkeypatch, profile):
    monkeypatch.setattr(q, "resolve", lambda url: (url, ATSFamily.greenhouse))
    monkeypatch.setattr(q.Path, "exists", lambda self: False)
    plan = q.build_plan([_match("a")], profile, ApplyMode.autofill)
    assert not plan[0].eligible and "resume" in plan[0].skip_reason
    plan2 = q.build_plan([_match("a")], profile, ApplyMode.autofill,
                         require_resume=False)
    assert plan2[0].eligible


def test_approve_toggles(profile):
    matches = [_match("a")]
    assert q.approve(matches, "a") and matches[0]["approved_to_apply"] is True
    assert q.approve(matches, "a", approved=False)
    assert matches[0]["approved_to_apply"] is False
    assert not q.approve(matches, "missing")


def test_run_item_records_and_gates_submit(monkeypatch, profile):
    monkeypatch.setattr(q, "resolve", lambda url: (url, ATSFamily.greenhouse))
    monkeypatch.setattr(q.Path, "exists", lambda self: True)
    captured = {}

    class FakeFiller:
        family = ATSFamily.greenhouse
        def apply(self, page, ctx: ApplyContext) -> ApplyResult:
            captured["mode"] = ctx.mode
            status = (ApplyStatus.submitted if ctx.mode is ApplyMode.submit
                      else ApplyStatus.filled_paused)
            return ApplyResult(status=status, family=self.family, message="ok")

    class Page:
        def goto(self, *a, **k):
            pass

    @contextlib.contextmanager
    def fake_session(prof, family):
        yield Page()

    monkeypatch.setattr(q, "get_filler", lambda fam: FakeFiller())
    monkeypatch.setattr(q, "browser_session", fake_session)

    item = q.build_plan([_match("a", approved_to_apply=True)], profile,
                        ApplyMode.submit)[0]
    res = q.run_item(item, profile, ApplyMode.submit, "example", TODAY)
    assert res.status is ApplyStatus.submitted
    assert captured["mode"] is ApplyMode.submit
    assert item.match["applied"] is True
    assert item.match["applied_at"] == TODAY.isoformat()


def test_run_item_unsupported_when_no_filler(monkeypatch, profile):
    monkeypatch.setattr(q, "resolve", lambda url: (url, ATSFamily.unknown))
    monkeypatch.setattr(q.Path, "exists", lambda self: True)
    monkeypatch.setattr(q, "get_filler", lambda fam: None)
    item = q.build_plan([_match("a")], profile, ApplyMode.autofill,
                        require_resume=False)[0]
    res = q.run_item(item, profile, ApplyMode.autofill, "example", TODAY)
    assert res.status is ApplyStatus.unsupported
    assert item.match["apply_status"] == "unsupported"


def test_resolve_submit_gate_precedence(profile):
    # Profile default is on; an explicit CLI override (True/False) wins.
    assert q.resolve_submit_gate(profile, None) is True
    assert q.resolve_submit_gate(profile, False) is False
    assert q.resolve_submit_gate(profile, True) is True
    profile.submit_gate = False
    assert q.resolve_submit_gate(profile, None) is False   # profile off, no override
    assert q.resolve_submit_gate(profile, True) is True    # override still wins


def test_run_item_threads_submit_gate_into_ctx(monkeypatch, profile):
    monkeypatch.setattr(q, "resolve", lambda url: (url, ATSFamily.unknown))
    monkeypatch.setattr(q.Path, "exists", lambda self: True)
    seen = {}

    class FakeFiller:
        family = ATSFamily.unknown
        def apply(self, page, ctx: ApplyContext) -> ApplyResult:
            seen["submit_gate"] = ctx.submit_gate
            return ApplyResult(status=ApplyStatus.filled_paused, family=self.family)

    class Page:
        def goto(self, *a, **k):
            pass

    @contextlib.contextmanager
    def fake_session(prof, family):
        yield Page()

    monkeypatch.setattr(q, "get_filler", lambda fam: FakeFiller())
    monkeypatch.setattr(q, "browser_session", fake_session)

    item = q.build_plan([_match("a")], profile, ApplyMode.autofill,
                        require_resume=False)[0]
    # Explicit override off -> the filler sees submit_gate False.
    q.run_item(item, profile, ApplyMode.autofill, "example", TODAY, submit_gate=False)
    assert seen["submit_gate"] is False
    # No override -> profile default (on).
    q.run_item(item, profile, ApplyMode.autofill, "example", TODAY)
    assert seen["submit_gate"] is True


from src import dashboard, ledger as ledger_mod


def _ledger_with(user, key, **rec_extra):
    """A ledger holding one record for `key`, keyed by its dashboard short."""
    rec = {"key": key, "company": "Acme", "status": "applied"}
    rec.update(rec_extra)
    return {user: {dashboard.short_key(key): rec}}


def test_already_done_ledger_blocks_submit_attempt():
    # A record carrying a submit_attempt blocks re-submit no matter the status.
    led = _ledger_with("example", "a", submit_attempt={"confirmed": False})
    assert q._already_done(_match("a"), "example", led) == \
        "submit already attempted per ledger"


def test_already_done_ledger_blocks_manual_applied():
    # A plain applied record (no submit_attempt, e.g. hand-ticked) still blocks:
    # auto-applying again would be a duplicate submission.
    led = _ledger_with("example", "a")
    assert q._already_done(_match("a"), "example", led) == "already applied per ledger"


def test_already_done_ledger_does_not_block_untouched_job():
    # A first-time job (no ledger record) is not blocked by the ledger.
    led = _ledger_with("example", "other")
    assert q._already_done(_match("a"), "example", led) == ""


def test_already_done_falls_back_to_match_without_ledger():
    assert q._already_done(_match("a")) == ""
    assert q._already_done(_match("a", applied=True)) == "already applied"
    assert q._already_done(_match("a", apply_status="submitted")) == "already applied"


def test_build_plan_ledger_guard_marks_ineligible(monkeypatch, profile):
    monkeypatch.setattr(q, "resolve", lambda url: (url, ATSFamily.greenhouse))
    monkeypatch.setattr(q.Path, "exists", lambda self: True)
    led = _ledger_with("example", "a", submit_attempt={"confirmed": True})
    plan = {it.key: it for it in q.build_plan(
        [_match("a"), _match("b")], profile, ApplyMode.autofill,
        user="example", ledger=led)}
    assert not plan["a"].eligible and "ledger" in plan["a"].skip_reason
    assert plan["b"].eligible                       # no record -> runs


def test_run_item_writes_submit_attempt_merge_safe(monkeypatch, tmp_path, profile):
    monkeypatch.setattr(q, "resolve", lambda url: (url, ATSFamily.greenhouse))
    monkeypatch.setattr(q.Path, "exists", lambda self: True)
    lpath = tmp_path / "applications.json"
    # Pre-existing UNRELATED record must survive the write (merge-safe).
    ledger_mod.save_ledger(_ledger_with("example", "other", status="oa"), lpath)

    attempt = {"on": "2026-06-17", "family": "greenhouse",
               "final_url": "https://x/y", "confirmed": True,
               "signal": "confirmation-text", "screenshot": "state/x/confirmation.png"}

    class FakeFiller:
        family = ATSFamily.greenhouse
        def apply(self, page, ctx):
            return ApplyResult(status=ApplyStatus.submitted, family=self.family,
                               message="ok", submit_attempt=attempt)

    class Page:
        def goto(self, *a, **k):
            pass

    @contextlib.contextmanager
    def fake_session(prof, family):
        yield Page()

    monkeypatch.setattr(q, "get_filler", lambda fam: FakeFiller())
    monkeypatch.setattr(q, "browser_session", fake_session)

    item = q.build_plan([_match("a", approved_to_apply=True)], profile,
                        ApplyMode.submit, user="example")[0]
    q.run_item(item, profile, ApplyMode.submit, "example", TODAY,
               ledger_path=lpath)

    led = ledger_mod.load_ledger(lpath)
    # Unrelated record untouched; new record carries the submit_attempt.
    assert led["example"][dashboard.short_key("other")]["status"] == "oa"
    new = led["example"][dashboard.short_key("a")]
    assert new["submit_attempt"] == attempt
    # The just-written attempt now blocks a re-drain.
    led2 = ledger_mod.load_ledger(lpath)
    assert q._already_done(item.match, "example", led2) == \
        "submit already attempted per ledger"


def test_run_item_no_ledger_write_without_attempt(monkeypatch, tmp_path, profile):
    """A run that never clicked submit (submit_attempt is None) must not create
    a ledger record - only a real click writes the guard entry."""
    monkeypatch.setattr(q, "resolve", lambda url: (url, ATSFamily.unknown))
    lpath = tmp_path / "applications.json"

    class FakeFiller:
        family = ATSFamily.unknown
        def apply(self, page, ctx):
            return ApplyResult(status=ApplyStatus.filled_paused, family=self.family)

    class Page:
        def goto(self, *a, **k):
            pass

    @contextlib.contextmanager
    def fake_session(prof, family):
        yield Page()

    monkeypatch.setattr(q, "get_filler", lambda fam: FakeFiller())
    monkeypatch.setattr(q, "browser_session", fake_session)
    item = q.build_plan([_match("a")], profile, ApplyMode.autofill,
                        require_resume=False)[0]
    q.run_item(item, profile, ApplyMode.autofill, "example", TODAY,
               ledger_path=lpath)
    assert not lpath.exists()                        # no attempt -> no write


def test_load_and_save_roundtrip(tmp_path, profile):
    sp = tmp_path / "seen.json"
    sp.write_text(json.dumps({"matches": {"example": [_match("a")]}}), encoding="utf-8")
    state, matches = q.load_matches(sp, "example")
    assert len(matches) == 1
    matches[0]["approved_to_apply"] = True
    q.save(state, sp)
    again = json.loads(sp.read_text(encoding="utf-8"))
    assert again["matches"]["example"][0]["approved_to_apply"] is True