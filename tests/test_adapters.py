"""Parsers validated against committed snapshots of each real source."""

import datetime as dt

from src.adapters.jobright_md import JobrightMdAdapter
from src.adapters.simplify_json import SimplifyJsonAdapter
from src.adapters.speedyapply_md import SpeedyApplyMdAdapter
from src.adapters.vanshb03_md import Vanshb03MdAdapter
from src.models import SourceConfig


def _cfg(name, adapter, files, default_terms=None):
    return SourceConfig(name=name, adapter=adapter, repo="x/y", branch="main",
                        files=files, default_terms=default_terms or {})


# ----------------------------------------------------------------- simplify

def test_simplify_parses_sample(fixtures, today):
    raw = (fixtures / "simplify_listings.sample.json").read_text(encoding="utf-8")
    jobs = SimplifyJsonAdapter(_cfg("simplify", "simplify_json", ["f"])).parse(raw, "f", today)
    assert len(jobs) >= 60
    assert all(j.company and j.title and j.url for j in jobs)
    # inactive / invisible entries are dropped (3 are present in the sample)
    import json
    n_active = sum(1 for e in json.loads(raw) if e.get("active") and e.get("is_visible"))
    assert len(jobs) == n_active


def test_simplify_multi_term_kept(fixtures, today):
    raw = (fixtures / "simplify_listings.sample.json").read_text(encoding="utf-8")
    jobs = SimplifyJsonAdapter(_cfg("simplify", "simplify_json", ["f"])).parse(raw, "f", today)
    assert any(len(j.terms) > 1 for j in jobs)
    assert all("N/A" not in j.terms for j in jobs)
    explicit = [j for j in jobs if j.terms]
    assert all(j.term_confidence in ("explicit", "inferred") for j in explicit)


# ----------------------------------------------------------------- jobright

def test_jobright_swe(fixtures, today):
    raw = (fixtures / "jobright_swe_README.md").read_text(encoding="utf-8")
    jobs = JobrightMdAdapter(_cfg("jobright-swe", "jobright_md", ["README.md"])).parse(
        raw, "README.md", today)
    assert len(jobs) >= 40
    first = jobs[0]
    assert first.company == "Infineon Technologies"
    assert first.title.startswith("Internship - Modeling Engineer")
    assert first.jobright_id == "6a0b2c8c538d03366dc8273a"
    assert "utm_" not in first.url
    assert first.work_model == "On Site"
    assert first.date_posted == dt.date(2026, 6, 11)
    assert first.terms == ["Summer 2026"] and first.term_confidence == "explicit"
    # every row got a 24-hex jobright id
    assert all(j.jobright_id and len(j.jobright_id) == 24 for j in jobs)
    # ↳ continuation rows (43 in this fixture) inherit the company above
    assert all(j.company not in ("", "↳") for j in jobs)
    companies = {j.company for j in jobs}
    assert len(companies) < len(jobs)


def test_jobright_other_repos_parse(fixtures, today):
    for fname in ("jobright_eng_README.md", "jobright_pm_README.md"):
        raw = (fixtures / fname).read_text(encoding="utf-8")
        jobs = JobrightMdAdapter(_cfg("x", "jobright_md", ["README.md"])).parse(
            raw, "README.md", today)
        assert len(jobs) >= 30, fname


def test_jobright_missing_marker_raises(today):
    adapter = JobrightMdAdapter(_cfg("x", "jobright_md", ["README.md"]))
    try:
        adapter.parse("# just a readme, no table", "README.md", today)
        raise AssertionError("expected RuntimeError")
    except RuntimeError:
        pass


# ----------------------------------------------------------------- vanshb03

def test_vanshb03_main_readme(fixtures, today):
    cfg = _cfg("vanshb03-2027", "vanshb03_md", ["README.md"],
               {"README.md": ["Summer 2027"]})
    raw = (fixtures / "vanshb03_README.md").read_text(encoding="utf-8")
    jobs = Vanshb03MdAdapter(cfg).parse(raw, "README.md", today)
    assert len(jobs) >= 30
    volo = next(j for j in jobs if "Voloridge" in j.company)
    assert volo.jobright_id == "69eaa8e4dc35f7132c4ab803"
    assert "jr_id" not in volo.url and "utm_" not in volo.url
    # no row leaks the continuation marker; every row has a company
    assert all(j.company not in ("", "↳") for j in jobs)
    # rows with no term signal in the title fall back to the file default
    assert any(j.terms == ["Summer 2027"] and j.term_confidence == "inferred"
               for j in jobs)


def test_vanshb03_continuation_rows(fixtures, today):
    cfg = _cfg("vanshb03-2027", "vanshb03_md", ["README.md"],
               {"README.md": ["Summer 2027"]})
    raw = (fixtures / "vanshb03_README.md").read_text(encoding="utf-8")
    jobs = Vanshb03MdAdapter(cfg).parse(raw, "README.md", today)
    kudu = [j for j in jobs if j.company == "Kudu Dynamics"]
    assert len(kudu) >= 2                        # base row + at least one ↳ row
    assert len({j.url for j in kudu}) == len(kudu)  # distinct postings


def test_vanshb03_offseason(fixtures, today):
    cfg = _cfg("vanshb03-2027", "vanshb03_md", ["OFFSEASON_README.md"])
    raw = (fixtures / "vanshb03_OFFSEASON_README.md").read_text(encoding="utf-8")
    jobs = Vanshb03MdAdapter(cfg).parse(raw, "OFFSEASON_README.md", today)
    assert len(jobs) >= 30


# --------------------------------------------------------------- speedyapply

def test_speedyapply_all_tables(fixtures, today):
    raw = (fixtures / "speedyapply_README.md").read_text(encoding="utf-8")
    jobs = SpeedyApplyMdAdapter(_cfg("speedyapply", "speedyapply_md",
                                     ["README.md"])).parse(raw, "README.md", today)
    assert len(jobs) >= 60
    nvidia = next(j for j in jobs if j.company == "NVIDIA" and "GeForce NOW" in j.title
                  and j.title.startswith("Cloud Software"))
    assert nvidia.salary == "$62/hr"
    assert nvidia.terms == ["Fall 2026"] and nvidia.term_confidence == "explicit"
    assert nvidia.date_posted == today - dt.timedelta(days=2)
    # the "Other" section has no Salary column -- those rows still parse
    anduril = next(j for j in jobs if j.company == "Anduril")
    assert anduril.salary is None
    assert len(anduril.locations) >= 4           # run-on multi-location split
    assert any("Atlanta" in loc for loc in anduril.locations)
    quant = next(j for j in jobs if "Shaw" in j.company)
    assert quant.salary == "$127/hr"
    assert quant.terms == ["Summer 2027"]


def test_speedyapply_ai_list_same_format(fixtures):
    # speedyapply/2027-AI-College-Jobs shares the SWE list's table layout;
    # the fixture is the live README trimmed to 12 rows per table.
    raw = (fixtures / "speedyapply_ai_README.md").read_text(encoding="utf-8")
    snap = dt.date(2026, 11, 8)
    jobs = SpeedyApplyMdAdapter(_cfg("speedyapply-ai", "speedyapply_md",
                                     ["README.md"])).parse(raw, "README.md", snap)
    assert len(jobs) == 36                       # FAANG+ / Quant / Other x 12
    assert {j.source for j in jobs} == {"speedyapply-ai"}
    msr = next(j for j in jobs if j.company == "Microsoft")
    assert msr.salary == "$52/hr"
    assert msr.date_posted == snap - dt.timedelta(days=1)
    assert msr.url.startswith("https://apply.careers.microsoft.com/")
    assert any(j.company == "Hudson River Trading" for j in jobs)   # Quant table
    assert all(j.url.startswith("http") for j in jobs)


# -------------------------------------------------------------------- zshah

def _zshah(fixtures, today):
    from src.adapters.zshah_json import ZshahJsonAdapter
    raw = (fixtures / "zshah_jobs.sample.json").read_text(encoding="utf-8")
    return ZshahJsonAdapter(_cfg("zshah-2027", "zshah_json",
                                 ["docs/api/jobs.json"])).parse(
        raw, "docs/api/jobs.json", today)


def test_zshah_parses_api_sample(fixtures, today):
    # Trimmed snapshot of docs/api/jobs.json (2026-11-08): up to 3 rows per
    # (ATS, season, program). Not refreshed by scripts/refresh_fixtures.py --
    # the live file is ~1 MB.
    jobs = _zshah(fixtures, today)
    assert len(jobs) == 97
    assert {j.source for j in jobs} == {"zshah-2027"}
    zoox = next(j for j in jobs if j.company == "Zoox")
    assert zoox.terms == ["Summer 2027"] and zoox.term_confidence == "explicit"
    assert zoox.url.startswith("https://jobs.lever.co/zoox/")
    assert zoox.date_posted == dt.date(2026, 11, 7)
    notion = next(j for j in jobs if j.company == "Notion")
    assert notion.salary == "$57/hr"
    # date-only Oracle rows and fractional-second offsets both parse; the
    # few rows with posted_at null stay undated
    assert sum(j.date_posted is None for j in jobs) == 3
    assert next(j for j in jobs if j.company == "Parspec").date_posted \
        == dt.date(2026, 11, 6)


def test_zshah_not_stated_season_falls_back_to_title(fixtures, today):
    jobs = _zshah(fixtures, today)
    parspec = next(j for j in jobs if j.company == "Parspec")
    # "Not stated" is never passed through as a term
    assert "Not stated" not in parspec.terms
    assert parspec.term_confidence != "explicit"
    leidos = next(j for j in jobs if j.company == "Leidos")
    assert leidos.work_model == "Remote"


def test_zshah_skips_closed_and_malformed(today):
    import json

    from src.adapters.zshah_json import ZshahJsonAdapter
    raw = json.dumps({"jobs": [
        {"company": "A", "title": "SWE Intern", "url": "https://x.invalid/1",
         "season": "Summer 2027", "is_open": False},
        {"company": "", "title": "SWE Intern", "url": "https://x.invalid/2"},
        {"company": "B", "title": "SWE Intern", "url": "https://x.invalid/3",
         "season": "Summer 2027", "season_inferred": True,
         "seasons": ["Summer 2027", "Fall 2027"], "posted_at": "garbage"},
    ]})
    jobs = ZshahJsonAdapter(_cfg("zshah-2027", "zshah_json", ["f"])).parse(
        raw, "f", today)
    assert [j.company for j in jobs] == ["B"]
    assert jobs[0].terms == ["Summer 2027", "Fall 2027"]
    assert jobs[0].term_confidence == "inferred"
    assert jobs[0].date_posted is None
