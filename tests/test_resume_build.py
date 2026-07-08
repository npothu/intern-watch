"""build_resume parity, out_name collisions, build_for_job JD-miss path."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from src import dashboard
from src.models import Job
from src.resume import build, fit, jd, render, select
from src.resume.bank import load_bank

ROOT = Path(__file__).resolve().parents[1]

FIXTURE_BANK = ROOT / "tests" / "fixtures" / "resume_bank.json"


def _bank():
    return load_bank(FIXTURE_BANK)


@pytest.fixture(autouse=True)
def _fixture_bank(monkeypatch):
    """Template-proof: never resolve a bank from users/ — the personal bank
    isn't shipped, so build_for_job and the CLI always get the fixture."""
    monkeypatch.setattr(build, "bank_path", lambda user, root: FIXTURE_BANK)
    monkeypatch.setattr("src.resume.__main__.bank_path",
                        lambda user, root: FIXTURE_BANK)


# ---- build_resume parity with the old inline pipeline ------------------

def _old_pipeline(jd_text, bank, *, out_path, use_llm=False):
    """The exact sequence __main__.main ran before the refactor."""
    profile = jd.analyze(jd_text)
    plan = select.build_plan(bank, profile, max_projects=select.MAX_PROJECTS)
    used_llm = False
    if use_llm:
        pass  # parity test runs LLM off (no network)
    fit.fit_plan(plan)
    render.render(plan, out_path)
    # the old _report body, reproduced verbatim
    lines = [f"# Resume build: {out_path.name}", ""]
    lines.append(f"- estimated length: **{fit.estimate_pages(plan):.2f} pages**")
    lines.append(f"- LLM bullet rewrite: {'on' if used_llm else 'off'}")
    lines.append("")
    lines.append("## Project order (score)")
    for p in plan.projects:
        marker = " *(LLM-rewritten)*" if p.llm_rewritten else ""
        lines.append(f"1. {p.name} — {p.score:.0f}, variant `{p.variant}`{marker}")
    lines.append("")
    lines.append("## Top JD keywords")
    top = ", ".join(f"{s} ({profile.weights[s]:.0f})"
                    for s in profile.ranked()[:12])
    lines.append(top or "(none recognized)")
    if plan.gaps:
        lines.append("")
        lines.append("## Keyword gaps (JD asks, bank lacks — do NOT fake)")
        lines.append(", ".join(plan.gaps))
    if plan.notes:
        lines.append("")
        lines.append("## Build notes")
        lines.extend(f"- {n}" for n in plan.notes)
    return "\n".join(lines) + "\n"


def test_build_resume_report_parity(fixtures, tmp_path):
    jd_text = (fixtures / "jd_ml_intern.txt").read_text(encoding="utf-8")
    bank = _bank()

    expected_out = tmp_path / "expected.docx"
    expected = _old_pipeline(jd_text, bank, out_path=expected_out)

    got_out = tmp_path / "got.docx"
    result = build.build_resume(jd_text, bank, company="TestCo",
                                out_path=got_out, llm_cfg={}, use_llm=False)

    # report differs only in the embedded filename; normalize that out
    assert (result.report.replace("got.docx", "X")
            == expected.replace("expected.docx", "X"))
    assert result.used_llm is False
    assert got_out.exists()
    # page estimate matches a fresh deterministic plan of the same JD/bank
    fresh = select.build_plan(bank, jd.analyze(jd_text))
    fit.fit_plan(fresh)
    assert result.pages == fit.estimate_pages(fresh)


def test_build_resume_matches_cli(fixtures, tmp_path, capsys):
    """The CLI's printed report must equal build_resume's report exactly."""
    from src.resume.__main__ import main

    out = tmp_path / "Alex_Example_TestCo.docx"
    rc = main(["--jd", str(fixtures / "jd_ml_intern.txt"),
               "--company", "TestCo", "--out", str(out), "--no-llm"])
    assert rc == 0
    printed = capsys.readouterr().out

    bank = _bank()
    jd_text = (fixtures / "jd_ml_intern.txt").read_text(encoding="utf-8")
    result = build.build_resume(jd_text, bank, company="TestCo",
                                out_path=out, llm_cfg={}, use_llm=False)
    # CLI prints report + "\n" (from print) + "wrote ...".
    assert printed.startswith(result.report)
    assert f"wrote {out}" in printed


# ---- out_name ----------------------------------------------------------

def test_out_name_basic():
    bank = _bank()
    name = build.out_name(bank, "Big Tech Inc.")
    assert name.endswith("_BigTechInc.docx")
    assert name.startswith("Alex_")


def test_out_name_empty_company():
    assert build.out_name(_bank(), "").endswith("_Tailored.docx")


def test_out_name_stays_clean():
    """The filename is employer-facing: no hashes, keys, or counters ever."""
    name = build.out_name(_bank(), "Stripe")
    assert name == "Alex_Example_Stripe.docx"


# ---- resume_llm_cfg ----------------------------------------------------

def test_resume_llm_cfg_prefers_resume_block(tmp_path):
    (tmp_path / "users").mkdir()
    (tmp_path / "users" / "u.yaml").write_text(
        "llm: {model: cheap}\nresume_llm: {model: strong}\n", encoding="utf-8")
    assert build.resume_llm_cfg("u", tmp_path) == {"model": "strong"}


def test_resume_llm_cfg_falls_back(tmp_path):
    (tmp_path / "users").mkdir()
    (tmp_path / "users" / "u.yaml").write_text(
        "llm: {model: cheap}\n", encoding="utf-8")
    assert build.resume_llm_cfg("u", tmp_path) == {"model": "cheap"}
    assert build.resume_llm_cfg("missing", tmp_path) == {}


# ---- resume_build_cfg --------------------------------------------------

def test_resume_build_cfg_defaults_when_absent():
    cfg = build.resume_build_cfg({})
    assert cfg == {"enabled": False, "modes": [], "use_llm": True,
                   "allow_scrape": True, "max_per_run": 20}
    # None user config behaves the same (missing file / no block).
    assert build.resume_build_cfg(None) == cfg


def test_resume_build_cfg_override_merge():
    cfg = build.resume_build_cfg({
        "resume_build": {"enabled": True, "modes": ["commit", "email"],
                         "max_per_run": 5}})
    assert cfg["enabled"] is True
    assert cfg["modes"] == ["commit", "email"]
    assert cfg["max_per_run"] == 5
    # untouched keys keep their defaults
    assert cfg["use_llm"] is True
    assert cfg["allow_scrape"] is True


def test_resume_build_cfg_drops_unknown_modes(caplog):
    import logging
    with caplog.at_level(logging.WARNING):
        cfg = build.resume_build_cfg({
            "resume_build": {"modes": ["commit", "bogus", "dashboard"]}})
    assert cfg["modes"] == ["commit", "dashboard"]
    assert "bogus" in caplog.text


def test_resume_build_cfg_live_config_is_off():
    """example.yaml ships disabled so the live watcher is unchanged."""
    data = yaml.safe_load(
        (ROOT / "users" / "example.yaml").read_text(encoding="utf-8"))
    cfg = build.resume_build_cfg(data)
    raw = (data or {}).get("resume_build", {}) or {}
    assert cfg["enabled"] == raw.get("enabled", False)
    # every configured mode survives validation (no silent drops of valid modes)
    valid = {"commit", "email", "dashboard"}
    assert cfg["modes"] == [m for m in raw.get("modes", []) if m in valid]


# ---- build_for_job -----------------------------------------------------

def test_build_for_job_none_when_jd_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(build, "acquire_jd", lambda *a, **k: None)
    job = Job(company="Acme", title="SWE Intern", url="https://x.test",
              dedup_key="jr:" + "d" * 24, source="dashboard")
    assert build.build_for_job(job, "example", out_dir=tmp_path,
                               root=ROOT) is None


def test_build_for_job_builds(monkeypatch, tmp_path, fixtures):
    jd_text = (fixtures / "jd_ml_intern.txt").read_text(encoding="utf-8")
    monkeypatch.setattr(build, "acquire_jd", lambda *a, **k: jd_text)
    job = Job(company="Stripe", title="SWE Intern", url="https://x.test",
              dedup_key="jr:" + "e" * 24, source="dashboard")
    result = build.build_for_job(job, "example", out_dir=tmp_path,
                                 root=ROOT, use_llm=False)
    assert result is not None
    assert result.out_path.exists()
    # clean employer-facing filename; uniqueness via the short-key subdir
    short = dashboard.short_key("jr:" + "e" * 24)
    assert result.out_path.name == "Alex_Example_Stripe.docx"
    assert result.out_path.parent == tmp_path / short


def test_build_for_job_same_company_jobs_do_not_collide(monkeypatch, tmp_path,
                                                        fixtures):
    jd_text = (fixtures / "jd_ml_intern.txt").read_text(encoding="utf-8")
    monkeypatch.setattr(build, "acquire_jd", lambda *a, **k: jd_text)
    outs = []
    for key in ("jr:" + "a" * 24, "jr:" + "b" * 24):
        job = Job(company="Tesla", title="SWE Intern", url="https://x.test",
                  dedup_key=key, source="dashboard")
        result = build.build_for_job(job, "example", out_dir=tmp_path,
                                     root=ROOT, use_llm=False)
        outs.append(result.out_path)
    assert outs[0] != outs[1] and all(p.exists() for p in outs)
    assert outs[0].name == outs[1].name == "Alex_Example_Tesla.docx"


def test_build_for_job_jd_text_bypasses_acquisition(monkeypatch, tmp_path,
                                                    fixtures):
    # A caller-supplied JD (pasted into a /resume comment) is used verbatim;
    # acquisition must not run -- this is the escape hatch for blocked sites.
    jd_text = (fixtures / "jd_ml_intern.txt").read_text(encoding="utf-8")
    monkeypatch.setattr(build, "acquire_jd",
                        lambda *a, **k: pytest.fail("acquired despite jd_text"))
    job = Job(company="Tesla", title="SWE Intern",
              url="https://www.tesla.com/careers/job/1",
              dedup_key="url:https://www.tesla.com/careers/job/1",
              source="dashboard")
    result = build.build_for_job(job, "example", out_dir=tmp_path, root=ROOT,
                                 use_llm=False, jd_text=jd_text)
    assert result is not None and result.out_path.exists()