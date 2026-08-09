"""Project scoring, ordering, variant choice, and skills-line reordering."""

import pytest

from src.resume import jd, select
from src.resume.bank import load_bank

BANK = load_bank("tests/fixtures/resume_bank.json")


def _plan(fixtures, name):
    profile = jd.analyze((fixtures / name).read_text(encoding="utf-8"))
    return select.build_plan(BANK, profile), profile


def test_ml_jd_leads_with_ml_projects(fixtures):
    plan, _ = _plan(fixtures, "jd_ml_intern.txt")
    ml_projects = {"Liver Transplant Outcome Prediction",
                   "Multichannel EEG Seizure Detection Pipeline",
                   "Lumos AI (GT Hacklytics 2026 - 2nd Place)"}
    assert plan.projects[0].name in ml_projects
    top3 = {p.name for p in plan.projects[:3]}
    assert len(top3 & ml_projects) >= 2


def test_embedded_jd_leads_with_systems_projects(fixtures):
    plan, _ = _plan(fixtures, "jd_embedded_intern.txt")
    systems = {"GT Exploratory Rocketry Club - Avionics Flight Computer",
               "XV6 Kernel Extensions & Optimizations"}
    assert plan.projects[0].name in systems
    assert systems <= {p.name for p in plan.projects[:3]}


def test_backend_jd_surfaces_db_and_api_projects(fixtures):
    plan, _ = _plan(fixtures, "jd_backend_intern.txt")
    top4 = {p.name for p in plan.projects[:4]}
    assert "Audio Streaming Service Database" in top4
    assert "Lumos AI (GT Hacklytics 2026 - 2nd Place)" in top4


def test_scores_are_descending(fixtures):
    plan, _ = _plan(fixtures, "jd_ml_intern.txt")
    scores = [p.score for p in plan.projects]
    assert scores == sorted(scores, reverse=True)


def test_max_projects_respected(fixtures):
    profile = jd.analyze((fixtures / "jd_ml_intern.txt").read_text("utf-8"))
    plan = select.build_plan(BANK, profile, max_projects=4)
    assert len(plan.projects) == 4
    assert any(n.startswith("dropped (low relevance)") for n in plan.notes)


def test_ml_jd_reorders_languages_and_coursework(fixtures):
    plan, _ = _plan(fixtures, "jd_ml_intern.txt")
    assert plan.languages.split(", ")[0] == "Python"
    assert plan.coursework.split(", ")[0] == "Machine Learning"


def test_embedded_jd_puts_c_family_first(fixtures):
    plan, _ = _plan(fixtures, "jd_embedded_intern.txt")
    first_two = plan.languages.split(", ")[:2]
    assert set(first_two) <= {"C", "C++", "Python"}
    assert "C" in first_two or "C++" in first_two


def test_skills_line_capped(fixtures):
    plan, _ = _plan(fixtures, "jd_backend_intern.txt")
    assert len(plan.tools.split(", ")) <= select.MAX_LINE_ITEMS


def test_variant_follows_jd(fixtures):
    profile = jd.analyze((fixtures / "jd_ml_intern.txt").read_text("utf-8"))
    lumos = BANK.projects["Lumos AI (GT Hacklytics 2026 - 2nd Place)"]
    assert select.pick_variant(lumos, profile) == "mlFocused"


def test_tech_reordered_toward_jd(fixtures):
    profile = jd.analyze((fixtures / "jd_backend_intern.txt").read_text("utf-8"))
    plan = select.build_plan(BANK, profile)
    lumos = next(p for p in plan.projects
                 if p.name.startswith("Lumos"))
    tech_run = next(r.text for r in lumos.heading_runs if r.italics)
    # FastAPI/Python are JD-relevant; they should lead the tech list
    assert tech_run.split(", ")[0] in {"Python", "FastAPI"}


def test_gaps_only_contain_missing_skills(fixtures):
    plan, profile = _plan(fixtures, "jd_backend_intern.txt")
    assert "python" not in plan.gaps
    assert "kubernetes" not in profile.weights or "kubernetes" in plan.gaps


def test_plan_is_deterministic(fixtures):
    a, _ = _plan(fixtures, "jd_ml_intern.txt")
    b, _ = _plan(fixtures, "jd_ml_intern.txt")
    assert a.model_dump() == b.model_dump()


def test_bank_validation_rejects_missing_base():
    from src.resume.bank import Project
    with pytest.raises(ValueError, match="base"):
        Project(tech=["X"], date="now", bullets={"extended": ["only"]})
