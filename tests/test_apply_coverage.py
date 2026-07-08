"""Coverage-preflight tests: the pure attribution/report logic and the CLI's
local-provider cost guarantee. No browser, no LLM, no network."""

from __future__ import annotations

import json

import pytest

from src.apply import __main__ as cli
from src.apply import coverage as cov
from src.apply.base import ATSFamily
from src.apply.profile import ApplyProfile
from src.dashboard import short_key


def _profile(**overrides) -> ApplyProfile:
    data = {
        "name": "Ada Lovelace",
        "email": "ada@example.com",
        "phone": "555-0100",
        "city": "Atlanta",
        "state": "Georgia",
        "links": {"linkedin": "https://linkedin.com/in/ada"},
        "questions": {"How did you hear about us?": "Company website"},
    }
    data.update(overrides)
    return ApplyProfile.model_validate(data)


# Book-resolvable contact fields, an essay only the LLM would try, and a
# do-not-fill field (the default list skips "additional information").
SYNTHETIC_FORM = [
    {"ref": "#first", "label": "First name", "type": "text",
     "is_select": False, "required": True},
    {"ref": "#email", "label": "Email", "type": "email",
     "is_select": False, "required": True},
    {"ref": "#essay", "label": "Why do you want to work here?",
     "type": "textarea", "is_select": False, "required": True},
    {"ref": "#extra", "label": "Additional information", "type": "textarea",
     "is_select": False, "required": False},
    {"ref": "#quirk", "label": "Favorite dinosaur?", "type": "text",
     "is_select": False, "required": False},
]


# ------------------------------------------------------------- attribution

def test_attribute_fields_book_llm_none():
    rows = cov.attribute_fields(SYNTHETIC_FORM, _profile())
    by_ref = {r["ref"]: r for r in rows}
    assert by_ref["#first"]["resolved_by"] == "book"
    assert by_ref["#email"]["resolved_by"] == "book"
    # The book has no answer -> the LLM pass WOULD attempt these.
    assert by_ref["#essay"]["resolved_by"] == "llm"
    assert by_ref["#quirk"]["resolved_by"] == "llm"
    # do_not_fill fields are never attempted by book OR llm.
    assert by_ref["#extra"]["resolved_by"] == "none"


def test_attribute_fields_carries_required_flag():
    rows = cov.attribute_fields(SYNTHETIC_FORM, _profile())
    by_ref = {r["ref"]: r for r in rows}
    assert by_ref["#first"]["required"] is True
    assert by_ref["#quirk"]["required"] is False


def test_attribute_fields_answer_bank_counts_as_book():
    form = [{"ref": "#hear", "label": "How did you hear about us?",
             "type": "text", "is_select": False, "required": False}]
    rows = cov.attribute_fields(form, _profile())
    assert rows[0]["resolved_by"] == "book"


def test_attribute_fields_skips_refless_and_never_calls_llm():
    # A field without a ref cannot be located later -> no row. And the whole
    # pass must run with NO LLM config in the environment (llm_cfg=None path).
    rows = cov.attribute_fields([{"label": "orphan", "type": "text"}],
                                _profile())
    assert rows == []


# ------------------------------------------------------------ report shape

def test_build_report_shape_and_counts():
    rows = cov.attribute_fields(SYNTHETIC_FORM, _profile())
    rep = cov.build_report("jr:abc", "https://x/apply", ATSFamily.ashby, rows)
    assert rep["key"] == "jr:abc"
    assert rep["family"] == "ashby"
    assert rep["supported"] is True
    assert rep["fields_total"] == 5
    assert rep["counts"] == {"book": 2, "llm": 2, "none": 1}
    # Only the required essay is a book-uncovered required field.
    assert rep["required_uncovered"] == 1
    assert all(set(r) == {"label", "ref", "required", "resolved_by"}
               for r in rep["fields"])


def test_report_path_uses_short_key_and_date(tmp_path):
    import datetime as dt
    p = cov.report_path("jr:abc", today=dt.date(2026, 7, 2), root=tmp_path)
    assert p == tmp_path / "2026-07-02" / f"{short_key('jr:abc')}.json"


def test_write_report_mkdirs_and_roundtrips(tmp_path):
    rep = cov.build_report("jr:abc", "https://x", ATSFamily.lever, [])
    path = cov.write_report(rep, "jr:abc", root=tmp_path)
    assert path.exists()
    assert json.loads(path.read_text(encoding="utf-8")) == rep


# ------------------------------------------------------ workday short-circuit

def test_workday_short_circuits_without_browser(tmp_path, monkeypatch):
    # Any browser use must fail loudly -> proves the workday path opens none.
    def boom(*a, **k):
        raise AssertionError("browser session opened for workday coverage")
    import src.apply.driver as driver
    monkeypatch.setattr(driver, "browser_session", boom)

    rep, path = cov.run_coverage("jr:wd", "https://acme.myworkdayjobs.com/j",
                                 ATSFamily.workday, _profile(), root=tmp_path)
    assert rep["supported"] is False
    assert rep["family"] == "workday"
    assert rep["fields"] == []
    assert path.exists()
    assert "unsupported" in cov.format_table(rep)


# ------------------------------------------------------- provider guarantee

def test_coverage_provider_defaults_to_local():
    assert cli.coverage_provider("") == "local"
    assert cli.coverage_provider("local") == "local"
    # Only an EXPLICIT browserbase opts into the metered browser.
    assert cli.coverage_provider("browserbase") == "browserbase"


def _run_coverage_cli(monkeypatch, tmp_path, extra_args):
    """Drive `coverage` end-to-end with the browser half stubbed; return the
    provider the run would have used."""
    sp = tmp_path / "seen.json"
    match = {"key": "jr:a", "company": "Acme", "title": "SWE Intern",
             "url": "https://x/y"}
    sp.write_text(json.dumps({"matches": {"example": [match]}}),
                  encoding="utf-8")

    captured = {}

    def fake_run_coverage(key, final_url, family, profile, **kw):
        captured["provider"] = profile.cloud.provider
        rep = cov.build_report(key, final_url, family, [])
        return rep, cov.write_report(rep, key, root=tmp_path / "reports")

    monkeypatch.setattr(cli, "run_coverage", fake_run_coverage)
    monkeypatch.setattr(cli, "resolve", lambda url: (url, ATSFamily.unknown))
    monkeypatch.setattr(cli, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(cli, "load_profile",
                        lambda user="", path=None: _profile())
    rc = cli.main(["coverage", "--user", "example", "--key", "jr:a",
                   "--state", str(sp)] + extra_args)
    assert rc == 0
    return captured["provider"]


def test_cli_coverage_defaults_to_local_provider(monkeypatch, tmp_path):
    # The cost guarantee: no --provider flag -> local, NEVER the profile's
    # browserbase default.
    assert _run_coverage_cli(monkeypatch, tmp_path, []) == "local"


def test_cli_coverage_explicit_browserbase_opts_in(monkeypatch, tmp_path):
    got = _run_coverage_cli(monkeypatch, tmp_path,
                            ["--provider", "browserbase"])
    assert got == "browserbase"


def test_cli_coverage_requires_key(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(cli, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(cli, "load_profile",
                        lambda user="", path=None: _profile())
    sp = tmp_path / "seen.json"
    sp.write_text(json.dumps({"matches": {"example": []}}), encoding="utf-8")
    rc = cli.main(["coverage", "--user", "example", "--state", str(sp)])
    assert rc == 2


def test_cli_coverage_unknown_key(monkeypatch, tmp_path):
    monkeypatch.setattr(cli, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(cli, "load_profile",
                        lambda user="", path=None: _profile())
    sp = tmp_path / "seen.json"
    sp.write_text(json.dumps({"matches": {"example": []}}), encoding="utf-8")
    rc = cli.main(["coverage", "--user", "example", "--key", "jr:missing",
                   "--state", str(sp)])
    assert rc == 1


def test_cli_coverage_accepts_raw_url(monkeypatch, tmp_path):
    """A URL key bypasses the matches lookup entirely."""
    captured = {}

    def fake_run_coverage(key, final_url, family, profile, **kw):
        captured["key"], captured["url"] = key, final_url
        rep = cov.build_report(key, final_url, family, [])
        return rep, cov.write_report(rep, key, root=tmp_path / "reports")

    monkeypatch.setattr(cli, "run_coverage", fake_run_coverage)
    monkeypatch.setattr(cli, "resolve",
                        lambda url: (url + "#final", ATSFamily.greenhouse))
    monkeypatch.setattr(cli, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(cli, "load_profile",
                        lambda user="", path=None: _profile())
    # no --user below: the sole-profile detection must not hit the real repo
    monkeypatch.setattr("src.apply.profile.detect_user", lambda: "example")
    rc = cli.main(["coverage", "--key", "https://boards.greenhouse.io/x/1",
                   "--state", str(tmp_path / "absent.json")])
    assert rc == 0
    assert captured["url"].endswith("#final")


# --------------------------------------------------------------- table text

def test_format_table_lists_rows_and_summary():
    rows = cov.attribute_fields(SYNTHETIC_FORM, _profile())
    rep = cov.build_report("jr:abc", "https://x", ATSFamily.ashby, rows)
    text = cov.format_table(rep)
    assert "First name" in text
    assert "book 2, llm 2, none 1" in text
    assert "required uncovered: 1" in text


def test_format_table_empty_form():
    rep = cov.build_report("jr:abc", "https://x", ATSFamily.lever, [])
    assert "no fillable form fields" in cov.format_table(rep)