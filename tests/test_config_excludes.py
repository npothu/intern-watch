"""Regression guard for the research-track / R&D exclude keywords in
users/example.yaml -- a stopgap for PhD-only R&D titles that title-only
sources (jobright) ship without a JD for the grad-only filter to catch."""

from pathlib import Path

import pytest

from src.filters import UserFilter, load_users
from src.models import Job

ROOT = Path(__file__).parent.parent


@pytest.fixture
def uf() -> UserFilter:
    cfg = next(c for c in load_users(ROOT / "users") if c["name"] == "example")
    return UserFilter(cfg, ROOT)


def _gm_job(**kw) -> Job:
    base = dict(
        company="General Motors",
        title="2026 Fall Intern - Research & Development: AI/ML",
        locations=["Warren, Michigan, United States of America"],
        terms=["Fall 2026"],
        url="https://jobright.ai/jobs/info/6a2c14d0fc06447490548159",
        source="jobright-swe",
    )
    base.update(kw)
    return Job(**base)


def test_research_and_development_title_rejected(uf):
    v = uf.evaluate(_gm_job())
    assert v.status == "reject"
    assert any(r.startswith("excluded-keyword:") for r in v.reasons)


def test_rnd_abbreviation_title_rejected(uf):
    v = uf.evaluate(_gm_job(title="AI/ML R&D Intern"))
    assert v.status == "reject"
    assert any(r.startswith("excluded-keyword:") for r in v.reasons)


def test_plain_swe_title_not_excluded(uf):
    # Same metadata, ordinary SWE title: may accept or be ambiguous, but it
    # must NOT be killed by an exclude keyword.
    v = uf.evaluate(_gm_job(title="Software Engineer Intern"))
    assert not any(r.startswith("excluded-keyword:") for r in v.reasons)
