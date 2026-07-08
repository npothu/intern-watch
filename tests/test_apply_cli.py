"""CLI tests for `python -m src.apply` — the submit-gate flag plumbing.

No browser: `run_item` is stubbed so we only assert how the CLI resolves and
forwards the --submit-gate / --no-submit-gate override (absent -> None, so the
profile default applies; flag -> forced on/off for the run)."""

from __future__ import annotations

import json

import pytest

from src.apply import __main__ as cli
from src.apply import queue as q
from src.apply.base import ApplyResult, ApplyStatus, ATSFamily
from src.apply.profile import ApplyProfile


def _profile() -> ApplyProfile:
    return ApplyProfile.model_validate(
        {"name": "Ada Lovelace", "email": "ada@example.com"})


@pytest.fixture
def state_file(tmp_path):
    sp = tmp_path / "seen.json"
    match = {"key": "jr:a", "company": "Acme", "title": "SWE Intern",
             "url": "https://x/y"}
    sp.write_text(json.dumps({"matches": {"example": [match]}}), encoding="utf-8")
    return sp


def _run(monkeypatch, state_file, extra_args):
    """Drive `drain` with run_item stubbed; return the submit_gate it received."""
    captured = {}

    def fake_run_item(item, profile, mode, user, today, **kw):
        captured["submit_gate"] = kw.get("submit_gate")
        return ApplyResult(status=ApplyStatus.filled_paused, family=ATSFamily.unknown)

    monkeypatch.setattr(cli, "run_item", fake_run_item)
    monkeypatch.setattr(q, "resolve", lambda url: (url, ATSFamily.unknown))
    monkeypatch.setattr(cli, "load_logins", lambda user: None)
    monkeypatch.setattr(cli, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(cli, "load_profile",
                        lambda user="", path=None: _profile())
    # --no-require-resume makes the item eligible without a real .docx on disk.
    rc = cli.main(["drain", "--user", "example", "--state", str(state_file),
                   "--no-require-resume"] + extra_args)
    assert rc == 0
    return captured["submit_gate"]


def test_cli_submit_gate_absent_is_none(monkeypatch, state_file):
    # Absent -> None, so run_item falls back to the profile default.
    assert _run(monkeypatch, state_file, []) is None


def test_cli_no_submit_gate_forces_off(monkeypatch, state_file):
    assert _run(monkeypatch, state_file, ["--no-submit-gate"]) is False


def test_cli_submit_gate_forces_on(monkeypatch, state_file):
    assert _run(monkeypatch, state_file, ["--submit-gate"]) is True
