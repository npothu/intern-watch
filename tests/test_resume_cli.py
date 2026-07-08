"""End-to-end CLI run (LLM off): JD in, one-page .docx + report out."""

import pytest
from docx import Document

from src.resume import __main__ as rm
from src.resume.__main__ import ROOT, _llm_cfg, main

FIXTURE_BANK = ROOT / "tests" / "fixtures" / "resume_bank.json"


@pytest.fixture(autouse=True)
def _fixture_bank(monkeypatch):
    """Template-proof: the CLI must not depend on a personal users/ bank."""
    monkeypatch.setattr(rm, "bank_path", lambda user, root: FIXTURE_BANK)


def test_cli_end_to_end(fixtures, tmp_path, capsys):
    out = tmp_path / "Alex_Example_TestCo.docx"
    report = tmp_path / "report.md"
    rc = main(["--jd", str(fixtures / "jd_ml_intern.txt"),
               "--user", "example",
               "--company", "TestCo",
               "--out", str(out),
               "--report", str(report),
               "--no-llm"])
    assert rc == 0
    assert out.exists()

    doc = Document(str(out))
    assert any("Alex" in p.text for p in doc.paragraphs)

    printed = capsys.readouterr().out
    assert "Project order" in printed
    assert "estimated length" in printed

    md = report.read_text(encoding="utf-8")
    assert "LLM bullet rewrite: off" in md


def test_cli_out_directory_and_filename(fixtures, tmp_path):
    rc = main(["--jd", str(fixtures / "jd_backend_intern.txt"),
               "--company", "Big Tech Inc.",
               "--out", str(tmp_path),
               "--no-llm"])
    assert rc == 0
    assert (tmp_path / "Alex_Example_BigTechInc.docx").exists()


def test_llm_cfg_prefers_resume_block(tmp_path):
    y = tmp_path / "u.yaml"
    y.write_text("llm: {model: cheap}\nresume_llm: {model: strong}\n",
                 encoding="utf-8")
    assert _llm_cfg(y) == {"model": "strong"}


def test_llm_cfg_falls_back_to_watcher_block(tmp_path):
    y = tmp_path / "u.yaml"
    y.write_text("llm: {model: cheap}\n", encoding="utf-8")
    assert _llm_cfg(y) == {"model": "cheap"}
    assert _llm_cfg(tmp_path / "missing.yaml") == {}


def test_example_resume_llm_is_separate_from_watcher():
    cfg = _llm_cfg(ROOT / "users" / "example.yaml")
    assert cfg.get("provider") == "gemini"
    # the watcher's flash-lite classifier must not leak into resume builds
    assert "flash-lite" not in cfg.get("model", "")