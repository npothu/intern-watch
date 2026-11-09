import datetime as dt
import json
from pathlib import Path

import pytest

from src import coverage as cov
from src.paths import ROOT

CASES = json.loads(
    (Path(__file__).parents[1] / "shared" / "ats-board-cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["url"] or "<empty>")
def test_detect_matches_shared_cases(case):
    hit = cov.detect(case["url"])
    if case["ats"] is None:
        assert hit is None
    else:
        assert hit == cov.Board(case["ats"], case["board"], case.get("scope"))


ROWS = [
    {"company": "Acme", "ats": "greenhouse", "slug": "acme"},
    {"company": "Beta", "ats": "lever", "slug": "beta"},
]
SUPPORTED = {"greenhouse", "lever", "ashby", "smartrecruiters"}


def _rec(url, company="X", key="manual:abc", **kw):
    return {"key": key, "url": url, "company": company, "added": "2026-11-01", **kw}


def _report(books, matches=None):
    misses = cov.collect_misses(books, matches or {})
    return cov.build_report(misses, ROWS, SUPPORTED)


def test_buckets_and_rows():
    book = {
        "a": _rec("https://job-boards.greenhouse.io/acme/jobs/1"),             # configured
        "b": _rec("https://jobs.smartrecruiters.com/Gamma/123", "Gamma"),      # addable
        "c": _rec("https://jobs.smartrecruiters.com/gamma/456", "Gamma"),      # same board
        "d": _rec("https://acme.wd1.myworkdayjobs.com/Ext/job/x_R1", "Acme"),  # unsupported
        "e": _rec("https://careers.delta.example/jobs?gh_jid=9", "Delta"),     # unknown board
        "f": _rec("https://boards.greenhouse.io/zeta/jobs/2", key="jr:abc"),   # not manual
    }
    rep = _report({"u": book})
    assert rep.total == 5
    assert cov.suggested_rows(rep) == [
        {"company": "Gamma", "ats": "smartrecruiters", "slug": "Gamma"}]
    assert len(rep.addable[0].misses) == 2
    assert [g.board for g in rep.configured] == ["acme"]
    assert [g.ats for g in rep.unsupported] == ["workday"]
    assert [g.ats for g in rep.unknown_board] == ["greenhouse"]


def test_convex_matches_counted_and_deduped_with_ledger():
    url = "https://jobs.ashbyhq.com/omega/123"
    rep = _report({"u": {"a": _rec(url, "Omega")}},
                  {"u": [{"url": url, "source": "manual", "company": "Omega",
                          "foundVia": "Instagram"},
                         {"url": "https://jobs.ashbyhq.com/psi/1", "tag": "[MANUAL]",
                          "company": "Psi", "foundVia": "instagram"}]})
    assert rep.total == 2
    assert rep.by_via == {"instagram": 1, "unspecified": 1}


def test_generic_company_falls_back_to_board():
    rep = _report({"u": {"a": _rec("https://apply.workable.com/twg/j/1", "Apply")}})
    assert rep.unsupported[0].company == "twg"


def test_markdown_has_rows_and_watchlist():
    rep = _report({"u": {"a": _rec("https://jobs.smartrecruiters.com/Gamma/1", "Gamma")}})
    watch = [{"company": "Example Corp", "url": "https://careers.example.invalid",
              "last_checked": "2026-11-07", "check_every_days": 7},
             {"company": "Gamma"}]
    md = cov.render_markdown(rep, watch, dt.date(2026, 11, 8))
    assert "ats: smartrecruiters\n  slug: Gamma" in md
    assert "🟢 [Example Corp](https://careers.example.invalid) | 2026-11-07" in md
    assert "🔴 Gamma | never | 7d | 2026-11-01 | 1 |" in md


def test_watched_board_ids_and_supported_from_real_files():
    ids = cov.watched_board_ids()
    assert ids and all(":" in i for i in ids)
    assert {"greenhouse", "lever", "ashby", "smartrecruiters"} <= set(cov.supported_ats())


def test_every_configured_ats_is_supported():
    # A boards row for an ATS the adapter can't poll raises in the source; the
    # report must never treat such a name as supported, nor ship one.
    assert {r["ats"] for r in cov.load_boards()} <= set(cov.supported_ats())


def test_supported_ats_is_the_adapter_dispatch():
    from src.adapters import ats_boards
    assert set(cov.supported_ats()) == set(ats_boards._API) | set(ats_boards._LISTERS) | {"workday"}


def test_watched_ids_use_the_adapter_loader_and_board_id(tmp_path, monkeypatch):
    from src.adapters import ats_boards
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "b.yaml").write_text(
        "boards:\n- {company: A, ats: greenhouse, slug: a}\n")
    (tmp_path / "data" / "b.local.yaml").write_text(
        "boards:\n- {company: Dup, ats: Greenhouse, slug: A}\n"
        "- {company: W, ats: workday, slug: w.wd1/Ext}\n")
    rows = ats_boards.load_boards("data/b.yaml", root=tmp_path, data_root=tmp_path)
    assert cov.watched_board_ids(rows) == ["greenhouse:a", "workday:w.wd1/ext"]


def test_oracle_and_eightfold_count_as_watched_by_host():
    rows = [{"company": "Acme", "ats": "oracle", "slug": "abcd.fa.us2.oraclecloud.com/CX_1"},
            {"company": "Ngc", "ats": "eightfold", "slug": "ngc.eightfold.ai/ngc.com"}]
    book = {
        "a": _rec("https://abcd.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1"),
        "b": _rec("https://ngc.eightfold.ai/careers/job/123456"),
        "c": _rec("https://zzzz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/2"),
        "d": _rec("https://other.eightfold.ai/careers/job/123456"),
    }
    rep = cov.build_report(cov.collect_misses({"u": book}, {}), rows, {"oracle", "eightfold"})
    assert sorted(g.ats for g in rep.configured) == ["eightfold", "oracle"]
    assert cov.suggested_rows(rep) == [
        {"company": "X", "ats": "oracle", "slug": "zzzz.fa.us2.oraclecloud.com/CX"}]
    assert [g.sample.watch_scope for g in rep.unknown_board] == ["other.eightfold.ai"]


def test_vanity_host_maps_match_normalize_and_the_boards_file():
    from src import normalize
    assert set(cov.EIGHTFOLD_BOARDS) == set(normalize._EIGHTFOLD_CUSTOM_HOSTS)
    slugs = {r["slug"] for r in cov.load_boards() if r["ats"] == "eightfold"}
    assert set(cov.EIGHTFOLD_BOARDS.values()) <= slugs
    for host, tenant in normalize._EIGHTFOLD_CUSTOM_HOSTS.items():
        assert cov.EIGHTFOLD_BOARDS[host].startswith((f"{host}/", f"{tenant}.eightfold.ai/"))
    pods = {r["slug"].split("/")[0] for r in cov.load_boards() if r["ats"] == "oracle"}
    assert set(cov.ORACLE_CUSTOM_HOSTS.values()) <= pods


def test_real_ledger_shapes_resolve_to_main_boards():
    ids = set(cov.watched_board_ids())
    scopes = cov._scopes(ids)
    for url in ["https://careers.americanexpress.com/en/sites/CX_1/job/26012000",
                "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1",
                "https://generalmotors.wd5.myworkdayjobs.com/en-US/Careers_GM/job/x_JR-1",
                "https://apply.careers.microsoft.com/careers/job/1970393556621237",
                "https://careers.amd.com/careers-home/jobs/67890"]:
        hit = cov.detect(url)
        assert hit and cov.is_watched(hit, ids, scopes), url


def test_failed_convex_ingests_count_as_misses():
    failed = {"u": [{"url": "https://acme.wd5.myworkdayjobs.com/Ext/job/x_R1",
                     "ats": "workday", "atsBoard": "acme.wd5/Ext", "foundVia": "instagram",
                     "added": "2026-11-03"}]}
    misses = cov.collect_misses({}, {}, failed)
    rep = cov.build_report(misses, ROWS, SUPPORTED | {"workday"})
    assert cov.suggested_rows(rep) == [
        {"company": "acme.wd5/Ext", "ats": "workday", "slug": "acme.wd5/Ext"}]
    assert rep.by_via == {"instagram": 1}


def test_no_adapter_ats_never_yields_a_row():
    unsupported = ["https://job-boards.eu.greenhouse.io/x/jobs/1", "https://jobs.eu.lever.co/x/1",
                   "https://x.avature.net/careers/JobDetail/a/1", "https://x.icims.com/jobs/1/job",
                   "https://apply.workable.com/x/j/1", "https://x.taleo.net/careersection/1",
                   "https://careers.x.example/job/a/b/1/2"]
    book = {str(i): _rec(u) for i, u in enumerate(unsupported)}
    rep = cov.build_report(cov.collect_misses({"u": book}, {}), ROWS, set(cov.supported_ats()))
    assert cov.suggested_rows(rep) == []


def test_eu_greenhouse_board_seen_on_us_embed_is_one_unsupported_gap():
    rep = _report({"u": {
        "a": _rec("https://job-boards.eu.greenhouse.io/veeam/jobs/1", "Veeam"),
        "b": _rec("https://job-boards.greenhouse.io/embed/job_app?for=veeam&token=2", "Veeam"),
    }})
    assert rep.addable == []
    assert [(g.ats, len(g.misses)) for g in rep.unsupported] == [("greenhouse-eu", 2)]


def test_example_watchlist_parses():
    entries = cov.load_watchlist(ROOT / "data" / "manual_watchlist.example.yaml")
    assert entries and all(e.get("url") for e in entries)


def test_skip_if_empty_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(cov, "load_books", lambda: {})
    monkeypatch.setattr(cov, "_user_names", lambda: [])
    out = tmp_path / "gaps.md"
    assert cov.main(["--skip-if-empty", "--watchlist", str(tmp_path / "none.yaml"),
                     "--out", str(out)]) == 0
    assert not out.exists()


def test_ts_detector_lists_the_same_vanity_hosts():
    ts = (ROOT / "convex" / "ats_detect.ts").read_text(encoding="utf-8")
    for host in [*cov.ORACLE_CUSTOM_HOSTS, *cov.ORACLE_CUSTOM_HOSTS.values(), *cov.JIBE_HOSTS,
                 *cov.EIGHTFOLD_BOARDS, *cov.EIGHTFOLD_BOARDS.values()]:
        assert f'"{host}"' in ts, host
