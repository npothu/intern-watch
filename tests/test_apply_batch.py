"""G3 regression: scripts/apply_batch.py must honour the applications ledger in
submit mode — skip slugs already submitted, and record a submit_attempt on every
click — so running it twice with --mode submit can never double-submit. Autofill
(the E2E harness) stays ledger-free."""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest

from scripts import apply_batch
from src import dashboard, ledger as ledger_mod
from src.apply.base import ApplyMode, ApplyResult, ApplyStatus, ATSFamily

USER = "example"


class _FakeFiller:
    """A filler that never touches a browser: it just reports a click."""

    def __init__(self, result: ApplyResult):
        self._result = result

    def apply(self, page, ctx):
        return self._result


class _NullPage:
    url = "https://x"

    def on(self, *a, **k):
        pass

    def goto(self, *a, **k):
        pass

    def wait_for_timeout(self, *a, **k):
        pass

    def screenshot(self, *a, **k):
        pass


class _NullSession:
    def __enter__(self):
        return _NullPage()

    def __exit__(self, *exc):
        return False


def _profile():
    from src.apply.profile import load_profile
    return load_profile(path=Path(__file__).resolve().parents[1] / "users" / "apply.example.yaml")


def _submitted_result():
    attempt = {"on": "2026-07-03", "family": "greenhouse",
               "final_url": "https://x", "confirmed": True,
               "signal": "test", "screenshot": None}
    return ApplyResult(status=ApplyStatus.submitted, family=ATSFamily.greenhouse,
                       message="ok", submit_attempt=attempt)


def test_submit_mode_skips_slug_already_in_ledger(tmp_path, monkeypatch):
    slug = "acme"
    ledger_path = tmp_path / "applications.json"
    ledger = {USER: {
        dashboard.short_key(slug): {"submit_attempt": {"confirmed": True}}}}
    ledger_mod.save_ledger(ledger, ledger_path)

    # If run_one reached the browser this would raise, proving the guard skipped.
    def _boom(*a, **k):
        raise AssertionError("browser session must not open for a skipped slug")
    monkeypatch.setattr(apply_batch, "browser_session", _boom)

    out = apply_batch.run_one(
        _profile(), USER, slug, "https://boards.greenhouse.io/x/jobs/1",
        ApplyMode.submit, tmp_path, inbox=None, store=tmp_path / "s.json",
        ledger=ledger_mod.load_ledger(ledger_path), ledger_path=ledger_path)
    assert out["status"] == "skipped"
    assert "ledger guard" in out["message"]


def test_submit_mode_records_attempt(tmp_path, monkeypatch):
    slug = "acme"
    ledger_path = tmp_path / "applications.json"

    monkeypatch.setattr(apply_batch, "get_filler",
                        lambda fam: _FakeFiller(_submitted_result()))
    monkeypatch.setattr(apply_batch, "browser_session",
                        lambda *a, **k: _NullSession())
    monkeypatch.setattr(apply_batch, "_resume", lambda p: tmp_path / "r.docx")

    out = apply_batch.run_one(
        _profile(), USER, slug, "https://boards.greenhouse.io/x/jobs/1",
        ApplyMode.submit, tmp_path, inbox=None, store=tmp_path / "s.json",
        ledger={}, ledger_path=ledger_path)
    assert out["status"] == "submitted"

    # A permanent ledger record now carries the submit attempt.
    ledger = ledger_mod.load_ledger(ledger_path)
    rec = ledger[USER][dashboard.short_key(slug)]
    assert rec["submit_attempt"]["confirmed"] is True

    # Second run: the guard now blocks it (no double-submit).
    def _boom(*a, **k):
        raise AssertionError("must not re-open browser for an already-submitted slug")
    monkeypatch.setattr(apply_batch, "browser_session", _boom)
    out2 = apply_batch.run_one(
        _profile(), USER, slug, "https://boards.greenhouse.io/x/jobs/1",
        ApplyMode.submit, tmp_path, inbox=None, store=tmp_path / "s.json",
        ledger=ledger_mod.load_ledger(ledger_path), ledger_path=ledger_path)
    assert out2["status"] == "skipped"


def test_autofill_mode_ignores_ledger(tmp_path, monkeypatch):
    """Autofill is the E2E harness — no ledger consult, no gating, even when the
    ledger already has a record for the slug."""
    slug = "acme"
    ledger_path = tmp_path / "applications.json"
    ledger_mod.save_ledger(
        {USER: {dashboard.short_key(slug):
                {"submit_attempt": {"confirmed": True}}}},
        ledger_path)

    called = {"n": 0}

    def _filler(fam):
        called["n"] += 1
        return _FakeFiller(ApplyResult(status=ApplyStatus.filled_paused,
                                       family=ATSFamily.greenhouse))
    monkeypatch.setattr(apply_batch, "get_filler", _filler)
    monkeypatch.setattr(apply_batch, "browser_session",
                        lambda *a, **k: _NullSession())
    monkeypatch.setattr(apply_batch, "_resume", lambda p: tmp_path / "r.docx")

    out = apply_batch.run_one(
        _profile(), USER, slug, "https://boards.greenhouse.io/x/jobs/1",
        ApplyMode.autofill, tmp_path, inbox=None, store=tmp_path / "s.json",
        ledger=None, ledger_path=None)
    assert out["status"] == "filled_paused"
    assert called["n"] == 1                       # the filler ran; no skip