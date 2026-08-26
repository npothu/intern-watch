"""Backdated sweeps over dated snapshots of the markdown sources.

tests/fixtures/history/<date>/ holds each source file exactly as it was on
that day, fetched from the source repos' own git history (the jobright
repos keep only a 7-day rolling window live, so these snapshots preserve
days the live files no longer show). Every job is replayed through the
filter with `today` backdated to the snapshot date; nothing deliverable
(accepted, or ambiguous and therefore LLM-bound -- the LLM judges
term/company/location, never role) may carry a research or
non-SW-discipline title.
"""

import datetime as dt
from pathlib import Path

import pytest
import yaml

from src.adapters.jobright_md import JobrightMdAdapter
from src.adapters.speedyapply_md import SpeedyApplyMdAdapter
from src.adapters.vanshb03_md import Vanshb03MdAdapter
from src.filters import UserFilter

from .test_regression_leaked import _NON_SW_RE, _RESEARCH_RE, _cfg

FIXTURE_DATE = dt.date(2026, 6, 11)
ROOT = Path(__file__).parent.parent
HISTORY = Path(__file__).parent / "fixtures" / "history"
DATES = sorted(p.name for p in HISTORY.iterdir() if p.is_dir())


@pytest.fixture(scope="module")
def uf() -> UserFilter:
    cfg = yaml.safe_load((ROOT / "users" / "example.yaml").read_text(encoding="utf-8"))
    return UserFilter(cfg, ROOT, today=FIXTURE_DATE)


def _day_jobs(date: str):
    import datetime as dt

    day_dir = HISTORY / date
    today = dt.date.fromisoformat(date)

    def read(name):
        return (day_dir / name).read_text(encoding="utf-8")

    jobs = []
    for name, fname in [("jobright-swe", "jobright_swe_README.md"),
                        ("jobright-eng", "jobright_eng_README.md"),
                        ("jobright-pm", "jobright_pm_README.md")]:
        jobs += JobrightMdAdapter(_cfg(name, "jobright_md")).parse(
            read(fname), "README.md", today)
    v_cfg = _cfg("vanshb03-2027", "vanshb03_md",
                 ["README.md", "OFFSEASON_README.md"],
                 {"README.md": ["Summer 2027"]})
    jobs += Vanshb03MdAdapter(v_cfg).parse(
        read("vanshb03_README.md"), "README.md", today)
    jobs += Vanshb03MdAdapter(v_cfg).parse(
        read("vanshb03_OFFSEASON_README.md"), "OFFSEASON_README.md", today)
    jobs += SpeedyApplyMdAdapter(_cfg("speedyapply", "speedyapply_md")).parse(
        read("speedyapply_README.md"), "README.md", today)
    return jobs


def test_history_dates_present():
    assert len(DATES) >= 3, f"expected >=3 dated snapshot dirs, got {DATES}"


@pytest.mark.parametrize("date", DATES)
def test_history_sweep_no_research_or_hardware_delivered(uf, date):
    jobs = _day_jobs(date)
    assert len(jobs) > 150, f"{date}: suspiciously few jobs parsed"

    deliverable = [j for j in jobs
                   if uf.evaluate(j).status in ("accept", "ambiguous")]
    assert deliverable, f"{date}: filter rejected everything"

    bad = [j for j in deliverable
           if _RESEARCH_RE.search(j.title) or _NON_SW_RE.search(j.title)]
    assert not bad, f"{date}: deliverable research/hardware titles:\n" + "\n".join(
        f"  [{j.source}] {j.company}: {j.title}" for j in bad[:40])


@pytest.mark.parametrize("date", DATES)
def test_history_sweep_strict_mode_applies_to_jobright_eng(uf, date):
    """Bare-'engineer' titles from the jobright Engineer repo never deliver."""
    for job in _day_jobs(date):
        if job.sources != ["jobright-eng"]:
            continue
        title = job.title.casefold()
        if any(kw in title for kw in uf.strict_include):
            continue
        assert uf.evaluate(job).status == "reject", \
            f"{date}: non-SW jobright-eng title delivered: {job.title}"
