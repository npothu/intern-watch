"""ATS board adapter: per-ATS parsers against real API fixtures."""

import datetime as dt

from src.adapters.ats_boards import INTERN_RE, AtsBoardsAdapter
from src.models import SourceConfig

TODAY = dt.date(2026, 6, 12)


def _adapter():
    return AtsBoardsAdapter(SourceConfig(
        name="ats-boards", adapter="ats_boards",
        boards_file="data/ats_boards.yaml"))


def test_intern_regex_word_boundaries():
    assert INTERN_RE.search("Software Engineer Intern")
    assert INTERN_RE.search("2027 Internship - Backend")
    assert INTERN_RE.search("Software Co-op (Fall)")
    assert INTERN_RE.search("SWE Coop")
    # the classic traps
    assert not INTERN_RE.search("Director of Internal Audit")
    assert not INTERN_RE.search("International Tax Manager")
    assert not INTERN_RE.search("Internet Engineer")


def test_greenhouse_parse(fixtures):
    raw = (fixtures / "ats_greenhouse_anduril.json").read_text(encoding="utf-8")
    jobs = _adapter().parse(raw, "greenhouse:anduril:Anduril", TODAY)
    assert len(jobs) == 4                      # non-intern rows pre-filtered
    assert all(j.company == "Anduril" for j in jobs)
    assert all("greenhouse.io" in j.url or "anduril" in j.url for j in jobs)
    assert all(j.source == "ats-boards" for j in jobs)
    # listing carries no JD; every job points at the per-job content endpoint
    assert all(j.description is None for j in jobs)
    assert all(j.jd_url and j.jd_url.startswith(
        "https://boards-api.greenhouse.io/v1/boards/anduril/jobs/")
        for j in jobs)
    j = next(job for job in jobs if "Electrical" in job.title)
    assert j.terms == ["Summer 2027"]          # bare "2027 ... Intern" -> Summer
    assert j.date_posted is not None


def test_lever_parse(fixtures):
    raw = (fixtures / "ats_lever_palantir.json").read_text(encoding="utf-8")
    jobs = _adapter().parse(raw, "lever:palantir:Palantir", TODAY)
    assert len(jobs) == 11
    assert all(j.company == "Palantir" for j in jobs)
    assert all(j.url.startswith("https://jobs.lever.co/palantir/") for j in jobs)
    assert all(j.date_posted is not None for j in jobs)
    assert any(j.locations for j in jobs)


def test_ashby_parse(fixtures):
    raw = (fixtures / "ats_ashby_notion.json").read_text(encoding="utf-8")
    jobs = _adapter().parse(raw, "ashby:notion:Notion", TODAY)
    assert len(jobs) == 1
    j = jobs[0]
    assert j.company == "Notion"
    assert j.title == "Software Engineer Intern (Fall 2026)"
    assert j.terms == ["Fall 2026"] and j.term_confidence == "explicit"
    assert j.locations


def test_smartrecruiters_parse(fixtures):
    raw = (fixtures / "ats_smartrecruiters_visa.json").read_text(encoding="utf-8")
    jobs = _adapter().parse(raw, "smartrecruiters:Visa:Visa", TODAY)
    # the Director row is dropped by the intern pre-filter; two interns survive
    assert len(jobs) == 2
    assert all(j.company == "Visa" for j in jobs)
    assert all(j.source == "ats-boards" for j in jobs)
    assert not any("Director" in j.title for j in jobs)

    swe = next(j for j in jobs if j.title.startswith("Software Engineer"))
    assert swe.terms == ["Summer 2027"] and swe.term_confidence == "explicit"
    assert swe.locations == ["Austin, TX, United States"]
    assert swe.date_posted == dt.date(2026, 6, 1)
    # public posting page; tracking params stripped; dedup keys off the url
    assert swe.url.startswith("https://jobs.smartrecruiters.com/Visa/")
    assert "utm_" not in swe.url and "oga=" not in swe.url
    # listing carries no JD body -> lazily enriched via the detail endpoint
    assert swe.description is None
    assert swe.jd_url == ("https://api.smartrecruiters.com/v1/companies/Visa"
                          "/postings/744000111100001")

    data = next(j for j in jobs if j.title.startswith("Data Science"))
    assert data.terms == ["Fall 2026"]
    assert data.locations == ["Toronto, ON, Canada"]


def test_smartrecruiters_jd_enrichment(fixtures):
    from src.adapters.smartrecruiters_api import jd_text
    import json
    detail = json.loads(
        (fixtures / "ats_smartrecruiters_visa_detail.json").read_text(encoding="utf-8"))
    body = jd_text(detail)
    assert body
    # the qualifications section is included so the elimination scans see it
    assert "active security clearance" in body.lower()
    assert "Bachelor" in body
    assert "<" not in body  # html stripped


def test_boards_yaml_is_loadable_and_clean():
    import yaml
    from pathlib import Path
    boards = yaml.safe_load(
        (Path(__file__).parent.parent / "data" / "ats_boards.yaml")
        .read_text(encoding="utf-8"))["boards"]
    assert len(boards) > 50
    assert all(b["ats"] in ("greenhouse", "lever", "ashby") for b in boards)
    assert all(b["company"] and b["slug"] for b in boards)
    # the known wrong-company boards stay out
    assert not any(b["slug"] == "linkedin" for b in boards)
    assert not any(b["ats"] == "lever" and b["slug"] == "neon" for b in boards)
