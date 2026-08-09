"""Regression: real jobs from the first live digests (2026-06-11/12).

Those digests delivered hardware-engineering roles (Astranis, Rocket Lab,
Zipline), and research-track roles are inapplicable for the user. Two
layers of protection:

1. The exact leaked jobs, hard-coded from the delivered emails, must now
   be rejected (and the legitimately-SW ones must survive).
2. A sweep replays EVERY job in the committed source snapshots -- backdated
   to their snapshot date -- and asserts nothing deliverable (accepted or
   LLM-bound ambiguous; the LLM judges term/company/location, never role)
   carries a research or non-SW-discipline title. The patterns here are
   written independently of the yaml exclude keywords on purpose: if a
   future keyword edit reopens a hole, this fails.
"""

import re
from pathlib import Path

import pytest
import yaml

from src.adapters.ats_boards import AtsBoardsAdapter
from src.adapters.jobright_md import JobrightMdAdapter
from src.adapters.simplify_json import SimplifyJsonAdapter
from src.adapters.speedyapply_md import SpeedyApplyMdAdapter
from src.adapters.vanshb03_md import Vanshb03MdAdapter
from src.filters import UserFilter
from src.models import Job, SourceConfig

ROOT = Path(__file__).parent.parent


@pytest.fixture(scope="module")
def uf() -> UserFilter:
    cfg = yaml.safe_load((ROOT / "users" / "example.yaml").read_text(encoding="utf-8"))
    return UserFilter(cfg, ROOT)


def _job(title, company, source, **kw):
    base = {"title": title, "company": company, "source": source, "sources": [source],
            "terms": ["Fall 2026"], "url": "https://example.com/x",
            "locations": ["San Francisco, CA"]}
    base.update(kw)
    return Job(**base)


# ------------------------------------------------- the exact leaked jobs
# Delivered in the 2026-06-12 01:42/02:51 UTC digests; flagged by the user.

@pytest.mark.parametrize("title,company,source", [
    ("Supplier Industrialization Engineering Intern (Fall 2026)",
     "Zipline", "jobright-eng"),
    ("Environmental Test Engineer Intern (Fall 2026)", "Astranis", "ats-boards"),
    ("Harness Design Engineer Intern (Fall 2026)", "Astranis", "ats-boards"),
    ("Mission Engineering Intern (Fall 2026)", "Astranis", "ats-boards"),
    ("Propulsion Engineer Intern (Fall 2026)", "Astranis", "ats-boards"),
    ("Thermal Engineer Intern (Fall 2026)", "Astranis", "ats-boards"),
    ("HITL Engineering Intern Fall 2026", "Rocket Lab", "ats-boards"),
])
def test_leaked_hardware_jobs_now_rejected(uf, title, company, source):
    assert uf.evaluate(_job(title, company, source)).status == "reject"


def test_leaked_1password_developer_still_deliverable(uf):
    # Same digest, but a real SW role -- the fix must not over-correct.
    v = uf.evaluate(_job("Developer Intern, Ecosystems (Fall 2026)",
                         "1Password", "ats-boards"))
    assert v.status != "reject"


# ---------------------------------------------- real research-track titles
# Verbatim from the 2026-06-11 Simplify snapshot (publication-record roles).

@pytest.mark.parametrize("title,company", [
    ("Research Intern - AI Systems & Architecture", "Microsoft"),
    ("Research Scientist Intern - Monetization GenAI - 2026 Start", "TikTok"),
    ("Research Engineer Intern - Ads ML Infra - 2026 Start - PhD", "TikTok"),
    ("Researcher Intern - Intelligent Creation-Vision and Graphics - 2026 "
     "Start - PhD", "TikTok"),
    ("2026 Machine Learning Research Intern", "Lambda"),
    ("PhD Research Intern", "Simular"),
    ("Summer 2026] Applied Scientist - Intern", "Roblox"),
    ("Amazon Robotics - Applied Scientist 2 Intern / Co-op - 2026", "Amazon"),
    ("Applied Scientist / Research Engineer - Internship", "Mistral AI"),
    ("HPE Labs - AI Research Lab Research Associate (Intern)",
     "Hewlett Packard Enterprise"),
    ("Chiplet Security Research Intern", "Tenstorrent"),
])
def test_real_research_titles_rejected(uf, title, company):
    assert uf.evaluate(_job(title, company, "simplify")).status == "reject"


# ------------------------------------------- full-snapshot backdated sweep
# Replays every job parsed from the committed fixtures (the real state of
# all sources on 2026-06-11) through the filter.

_RESEARCH_RE = re.compile(
    r"research\s+(scientist|intern|engineer|fellow|associate|assistant)"
    r"|researcher|applied scientist|research lab", re.I)
_NON_SW_RE = re.compile(
    r"propulsion|environmental test|\bhitl\b|industrialization"
    r"|(thermal|harness|payload|fluids|optical|materials|mechanical"
    r"|electrical|civil|manufacturing|structural) (design )?engineer", re.I)


def _cfg(name, adapter, files=("README.md",), default_terms=None):
    return SourceConfig(name=name, adapter=adapter, repo="x/y", branch="main",
                        files=list(files), default_terms=default_terms or {},
                        boards_file="data/ats_boards.yaml")


def _all_fixture_jobs(fixtures, today):
    def read(name):
        return (fixtures / name).read_text(encoding="utf-8")

    jobs = []
    jobs += SimplifyJsonAdapter(_cfg("simplify", "simplify_json", ["f"])).parse(
        read("_full_simplify_listings.json"), "f", today)
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
    ats = AtsBoardsAdapter(_cfg("ats-boards", "ats_boards"))
    jobs += ats.parse(read("ats_greenhouse_anduril.json"), "greenhouse:anduril:Anduril", today)
    jobs += ats.parse(read("ats_lever_palantir.json"), "lever:palantir:Palantir", today)
    jobs += ats.parse(read("ats_ashby_notion.json"), "ashby:notion:Notion", today)
    return jobs


def test_snapshot_sweep_no_research_or_hardware_delivered(uf, fixtures, today):
    if not (fixtures / "_full_simplify_listings.json").exists():
        pytest.skip("full simplify snapshot is local-only (12 MB, deliberately "
                    "untracked); run scripts/refresh_fixtures.py to create it")
    jobs = _all_fixture_jobs(fixtures, today)
    assert len(jobs) > 2000           # the sweep is only meaningful at scale

    deliverable = [j for j in jobs
                   if uf.evaluate(j).status in ("accept", "ambiguous")]
    assert deliverable                # filter isn't rejecting everything

    bad = [j for j in deliverable
           if _RESEARCH_RE.search(j.title) or _NON_SW_RE.search(j.title)]
    assert not bad, "deliverable research/hardware titles:\n" + "\n".join(
        f"  [{j.source}] {j.company}: {j.title}" for j in bad[:40])
