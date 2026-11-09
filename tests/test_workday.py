"""Workday career sites: CXS listing parser, pagination, JD enrichment, and
dedup-key parity with the Workday URLs other sources already carry."""

import datetime as dt
import json

import httpx
import pytest

from src import main
from src.adapters import workday_api as wd
from src.adapters.ats_boards import AtsBoardsAdapter
from src.dedupe import dedup_key
from src.models import Job, SourceConfig
from src.normalize import canonical_url

TODAY = dt.date(2026, 11, 8)
SLUG = "generalmotors.wd5/Careers_GM"


def _adapter():
    return AtsBoardsAdapter(SourceConfig(name="ats-boards", adapter="ats_boards"))


def _parse(fixtures):
    raw = (fixtures / "ats_workday_gm.json").read_text(encoding="utf-8")
    return _adapter().parse(raw, f"workday:{SLUG}:General Motors", TODAY)


def test_slug_and_urls():
    assert wd.split_slug(SLUG) == ("generalmotors", "wd5", "Careers_GM")
    assert wd.list_url(SLUG) == ("https://generalmotors.wd5.myworkdayjobs.com"
                                 "/wday/cxs/generalmotors/Careers_GM/jobs")
    assert wd.public_url(SLUG, "/job/X/Y_JR-1") == (
        "https://generalmotors.wd5.myworkdayjobs.com/Careers_GM/job/X/Y_JR-1")
    with pytest.raises(ValueError):
        wd.split_slug("generalmotors/Careers_GM")


def test_posted_date():
    assert wd.posted_date("Posted Today", TODAY) == TODAY
    assert wd.posted_date("Posted Yesterday", TODAY) == dt.date(2026, 11, 7)
    assert wd.posted_date("Posted 11 Days Ago", TODAY) == dt.date(2026, 10, 28)
    # "30+" is a lower bound on the age
    assert wd.posted_date("Posted 30+ Days Ago", TODAY) == dt.date(2026, 10, 9)
    assert wd.posted_date(None, TODAY) is None
    assert wd.posted_date("Posted sometime", TODAY) is None


def test_workday_parse(fixtures):
    jobs = _parse(fixtures)
    # 9 rows: 7 intern titles, 2 Spanish "Practicante" rows pre-filtered
    assert len(jobs) == 7
    assert all(j.company == "General Motors" and j.source == "ats-boards"
               for j in jobs)
    assert all(j.url.startswith(
        "https://generalmotors.wd5.myworkdayjobs.com/Careers_GM/job/") for j in jobs)
    assert all(j.jd_url and j.jd_url.startswith(
        "https://generalmotors.wd5.myworkdayjobs.com/wday/cxs/generalmotors/"
        "Careers_GM/job/") for j in jobs)
    assert all(j.description is None for j in jobs)

    warren = next(j for j in jobs if "Computational Design" in j.title)
    assert warren.locations == ["Warren, Michigan, United States of America"]
    assert warren.terms == ["Summer 2027"]
    assert warren.date_posted == TODAY - dt.timedelta(days=30)
    assert warren.work_model == "On Site"
    assert next(j for j in jobs if j.title == "Customs Intern").work_model == "Hybrid"

    # "2 Locations" is a placeholder, not a place: left empty for enrichment
    multi = [j for j in jobs if "Sculpting" in j.title]
    assert len(multi) == 2 and all(j.locations == [] for j in multi)


def test_keys_match_existing_workday_urls(fixtures):
    """The url: dedup key and the ats:wd: canonical token must equal what a
    Simplify/curated-list link to the same posting produces, or the posting
    is delivered twice."""
    job = next(j for j in _parse(fixtures) if "Computational Design" in j.title)
    curated = Job(company="General Motors", title=job.title, source="simplify",
                  url=("https://generalmotors.wd5.myworkdayjobs.com/en-US/"
                                 "Careers_GM/job/Warren-Michigan-United-States-of-"
                                 "America/Summer-2027-Intern---Computational-"
                                 "Design-Intern_JR-202621454?utm_source=Simplify"))
    assert dedup_key(job) == dedup_key(curated)
    assert canonical_url(job.url) == canonical_url(curated.url) \
        == "ats:wd:generalmotors:JR-202621454"
    # repost counter (-1) collapses onto the same requisition token
    java = next(j for j in _parse(fixtures) if "Java" in j.title)
    assert canonical_url(java.url) == "ats:wd:generalmotors:JR-202619011"


def _page(titles, total=None, offset=0):
    rows = [{"title": t, "externalPath": f"/job/X/{t.replace(' ', '-')}_R{offset + i:04d}"}
            for i, t in enumerate(titles)]
    body: dict = {"jobPostings": rows}
    if total is not None:
        body["total"] = total
    return body


INTERN_FACETS = [
    {"facetParameter": "jobFamilyGroup", "values": [
        {"descriptor": "Interns", "id": "fam-intern", "count": 400},
        {"descriptor": "Internal Audit", "id": "fam-audit", "count": 3}]},
    {"facetParameter": "workerSubType", "values": [
        {"descriptor": "Intern (Fixed Term)", "id": "wst-intern", "count": 41},
        {"descriptor": "Co-Op (Fixed Term)", "id": "wst-coop", "count": 2},
        {"descriptor": "Fixed Term Employee (Non-Intern)", "id": "wst-no", "count": 9},
        {"descriptor": "Regular", "id": "wst-reg", "count": 900}]},
    {"facetParameter": "locationMainGroup", "values": [
        {"facetParameter": "locations", "values": [
            {"descriptor": "Cooperstown, NY", "id": "loc-coop", "count": 1}]}]},
]


def _client(calls, *, facets, facet_total=0, site_total=0, site_titles=None):
    """Mock CXS. The probe (limit 1) answers `facets` and the whole-site
    total; a faceted query serves `facet_total` intern rows; an unfiltered
    query serves `site_total` rows titled by site_titles(i) (default:
    every 7th an intern, the rest not)."""
    title = site_titles or (lambda i: f"Intern {i}" if i % 7 == 0
                            else f"International Tax {i}")

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        if body["limit"] == 1:
            return httpx.Response(200, json={"total": site_total, "facets": facets,
                                             "jobPostings": []})
        off = body["offset"]
        n_total = facet_total if body["appliedFacets"] else site_total
        n = max(0, min(wd.PAGE_SIZE, n_total - off))
        names = ([f"Intern {off + i}" for i in range(n)] if body["appliedFacets"]
                 else [title(off + i) for i in range(n)])
        page = _page(names, offset=off)
        page["total"] = n_total if off == 0 else 0
        return httpx.Response(200, json=page)
    return httpx.Client(transport=httpx.MockTransport(handler))


def _noop(_s):
    return None


def test_intern_facet_prefers_worker_subtype():
    assert wd.intern_facet(INTERN_FACETS) == {
        "workerSubType": ["wst-intern", "wst-coop"]}
    # no workerSubType: the job-family param with the most intern postings
    fam = [{"facetParameter": "jobFamily", "values": [
               {"descriptor": "Intern", "id": "a", "count": 4}]},
           {"facetParameter": "jobFamilyGroup", "values": [
               {"descriptor": "Intern_Group", "id": "b", "count": 9},
               {"descriptor": "IT, Telecom & Internet", "id": "c", "count": 99}]}]
    assert wd.intern_facet(fam) == {"jobFamilyGroup": ["b"]}
    pharmacy = [{"facetParameter": "workerSubType", "values": [
        {"descriptor": "Pharmacy Intern (Trainee)", "id": "p", "count": 3860}]}]
    assert wd.intern_facet(pharmacy) is None
    assert wd.intern_facet([]) is None


def test_fetch_listing_facet_path_pages_to_total():
    calls: list = []
    client = _client(calls, facets=INTERN_FACETS, facet_total=43)
    data = json.loads(wd.fetch_listing(SLUG, client, sleep=_noop))
    assert len(data["jobPostings"]) == 43
    assert calls[0]["limit"] == 1 and calls[0]["appliedFacets"] == {}
    listed = calls[1:]
    assert [c["offset"] for c in listed] == [0, 20, 40]
    assert all(c["appliedFacets"] == {"workerSubType": ["wst-intern", "wst-coop"]}
               and c["limit"] == wd.PAGE_SIZE and c["searchText"] == ""
               for c in listed)


def test_fetch_listing_never_truncates_a_facet_listing():
    """A listing too large for MAX_PAGES fails the board instead of
    returning its first pages as if they were all of it."""
    calls: list = []
    client = _client(calls, facets=INTERN_FACETS,
                     facet_total=wd.MAX_PAGES * wd.PAGE_SIZE + 1)
    with pytest.raises(wd.IncompleteListing):
        wd.fetch_listing(SLUG, client, sleep=_noop)
    assert len(calls) == 2            # probe + first page: stopped at the total
    # exactly at the ceiling is still a complete read
    calls.clear()
    client = _client(calls, facets=INTERN_FACETS,
                     facet_total=wd.MAX_PAGES * wd.PAGE_SIZE)
    data = json.loads(wd.fetch_listing(SLUG, client, sleep=_noop))
    assert len(data["jobPostings"]) == wd.MAX_PAGES * wd.PAGE_SIZE


def test_no_facet_reads_the_whole_site_to_its_total():
    """Without an intern facet the whole site is read (no search, no early
    stop): interns scattered after long intern-free stretches, as on a
    date-sorted tenant, are all kept, and parse() drops the rest."""
    calls: list = []

    def titles(i):
        return ("Late Intern" if i == 862 else
                "Early Co-op" if i == 3 else f"Engineer {i}")
    client = _client(calls, facets=[], site_total=863, site_titles=titles)
    data = json.loads(wd.fetch_listing(SLUG, client, sleep=_noop))
    assert len(data["jobPostings"]) == 863
    listed = calls[1:]
    assert all(c["searchText"] == "" and c["appliedFacets"] == {} for c in listed)
    assert [c["offset"] for c in listed] == list(range(0, 863, 20))
    jobs = _adapter().parse(json.dumps(data), f"workday:{SLUG}:Co", TODAY)
    assert sorted(j.title for j in jobs) == ["Early Co-op", "Late Intern"]


def test_too_large_site_without_facet_fails_before_paging():
    calls: list = []
    client = _client(calls, facets=[], site_total=wd.MAX_PAGES * wd.PAGE_SIZE + 1)
    with pytest.raises(wd.IncompleteListing):
        wd.fetch_listing(SLUG, client, sleep=_noop)
    assert len(calls) == 1            # only the probe


def test_missing_total_on_a_full_page_is_not_a_complete_read():
    full_no_total = httpx.Response(200, json=_page([f"Intern {i}" for i in range(20)]))
    with pytest.raises(wd.IncompleteListing):
        wd.fetch_listing(SLUG, _scripted([PROBE, full_no_total]), sleep=_noop)


def _scripted(responses):
    """MockTransport answering the scripted responses in order."""
    it = iter(responses)

    def handler(request):
        resp = next(it)
        if isinstance(resp, Exception):
            raise resp
        return resp
    return httpx.Client(transport=httpx.MockTransport(handler))


PROBE = httpx.Response(200, json={"total": 9, "facets": INTERN_FACETS})
FULL = httpx.Response(200, json=_page([f"Intern {i}" for i in range(20)], total=60))


def test_dead_board_raises():
    with pytest.raises(httpx.HTTPStatusError):
        wd.fetch_listing(SLUG, _scripted([httpx.Response(404)]), sleep=_noop)


def test_first_page_failure_after_probe_fails_the_board():
    """A 429 on the facet query's first page (after a good probe) must not
    read as an empty, successful board: first-sight seeding would record it
    as known and deliver its whole backlog next run."""
    with pytest.raises(httpx.HTTPStatusError):
        wd.fetch_listing(SLUG, _scripted(
            [PROBE, httpx.Response(429), httpx.Response(429)]), sleep=_noop)
    with pytest.raises(httpx.ReadTimeout):
        wd.fetch_listing(SLUG, _scripted(
            [PROBE, httpx.ReadTimeout("slow"), httpx.ReadTimeout("slow")]),
            sleep=_noop)


def test_late_page_failure_fails_the_board_too():
    with pytest.raises(httpx.HTTPStatusError):
        wd.fetch_listing(SLUG, _scripted(
            [PROBE, FULL, httpx.Response(500), httpx.Response(500)]), sleep=_noop)


def test_one_retry_recovers_a_transient_error():
    sleeps: list = []
    data = json.loads(wd.fetch_listing(SLUG, _scripted(
        [PROBE, httpx.Response(429), httpx.Response(
            200, json=_page(["Only Intern"], total=1))]), sleep=sleeps.append))
    assert [r["title"] for r in data["jobPostings"]] == ["Only Intern"]
    assert wd.RETRY_DELAY in sleeps


def test_malformed_slug_fails_alone():
    out = wd.fetch_listings(["not-a-workday-slug"])
    assert isinstance(out["not-a-workday-slug"], ValueError)


def test_one_bad_board_does_not_fail_the_source(tmp_path, monkeypatch):
    boards = tmp_path / "boards.yaml"
    boards.write_text(
        "boards:\n"
        "- {company: Good, ats: workday, slug: good.wd1/Ext}\n"
        "- {company: Bad, ats: workday, slug: bad.wd1/Ext}\n", encoding="utf-8")
    monkeypatch.setattr("src.adapters.ats_boards.ROOT", tmp_path)
    monkeypatch.setattr("src.adapters.ats_boards.DATA_ROOT", tmp_path)

    def fake_listing(slug, client=None, sleep=None):
        if slug.startswith("bad"):
            raise httpx.ConnectError("boom")
        return json.dumps(_page(["SWE Intern"], total=1))
    monkeypatch.setattr(wd, "fetch_listing", fake_listing)
    adapter = AtsBoardsAdapter(SourceConfig(
        name="ats-boards", adapter="ats_boards", boards_file="boards.yaml"))
    jobs = adapter.fetch(httpx.Client(), TODAY)
    assert [j.company for j in jobs] == ["Good"]


def test_enrich_jds_reads_workday_detail(fixtures, monkeypatch):
    detail = (fixtures / "ats_workday_gm_detail.json").read_text(encoding="utf-8")
    job = next(j for j in _parse(fixtures) if "Digital Sculpting" in j.title)
    assert job.locations == []

    def handler(request):
        assert request.url.path.startswith("/wday/cxs/generalmotors/Careers_GM/job/")
        assert "authorization" not in request.headers
        return httpx.Response(200, text=detail)
    real = httpx.Client
    monkeypatch.setattr(main.httpx, "Client", lambda **kw: real(
        transport=httpx.MockTransport(handler), **kw))
    placed = next(j for j in _parse(fixtures) if "Computational Design" in j.title)
    assert main.enrich_jds([job, placed]) == 2
    assert job.description and "<" not in job.description
    # a row whose listing named its location keeps it (detail only fills gaps)
    assert placed.locations == ["Warren, Michigan, United States of America"]
    assert job.locations == ["Warren, Michigan, United States of America",
                             "Pasadena, California, United States of America"]


def test_detail_locations_adds_primary_country():
    detail = {"jobPostingInfo": {"location": "Hyderabad",
                                 "additionalLocations": ["Bangalore"],
                                 "country": {"descriptor": "India"}}}
    assert wd.detail_locations(detail) == ["Hyderabad, India", "Bangalore, India"]
    # an additional location that is already placed keeps its own country
    detail["jobPostingInfo"]["additionalLocations"] = [
        "Austin, Texas, United States of America", "Bangalore"]
    assert wd.detail_locations(detail) == [
        "Hyderabad, India", "Austin, Texas, United States of America",
        "Bangalore, India"]
    assert wd.detail_locations({"jobPostingInfo": {
        "location": "China, Shanghai", "country": {"descriptor": "China"}}}) \
        == ["China, Shanghai"]
    assert wd.detail_locations({}) == []


def test_fetch_listings_keeps_one_tenant_sequential(monkeypatch):
    """Sites of one tenant share a host: they run in one worker, in order,
    and a failing site is returned, not raised."""
    import threading
    seen: list[tuple[str, int]] = []

    def fake_listing(slug, client=None, sleep=None):
        seen.append((slug, threading.get_ident()))
        if slug == "b.wd1/Dead":
            raise httpx.ConnectError("boom")
        return "{}"
    monkeypatch.setattr(wd, "fetch_listing", fake_listing)
    monkeypatch.setattr(wd.time, "sleep", lambda _s: None)
    slugs = ["a.wd1/One", "b.wd1/Dead", "a.wd1/Two", "c.wd5/X", "a.wd1/One"]
    out = wd.fetch_listings(slugs)
    assert set(out) == {"a.wd1/One", "a.wd1/Two", "b.wd1/Dead", "c.wd5/X"}
    assert isinstance(out["b.wd1/Dead"], httpx.ConnectError)
    a_calls = [(s, t) for s, t in seen if s.startswith("a.")]
    assert [s for s, _t in a_calls] == ["a.wd1/One", "a.wd1/Two"]
    assert len({t for _s, t in a_calls}) == 1
    with pytest.raises(httpx.ConnectError):
        wd.listing(out, "b.wd1/Dead")


def test_local_overlay_merges_after_template(tmp_path, monkeypatch):
    from src.adapters import ats_boards
    code, data = tmp_path / "code", tmp_path / "data_repo"
    (code / "data").mkdir(parents=True)
    (data / "data").mkdir(parents=True)
    (code / "data" / "ats_boards.yaml").write_text(
        "boards:\n- {company: A, ats: workday, slug: a.wd1/Ext}\n", encoding="utf-8")
    monkeypatch.setattr(ats_boards, "ROOT", code)
    monkeypatch.setattr(ats_boards, "DATA_ROOT", data)
    # no overlay: the template alone
    assert [b["slug"] for b in ats_boards.load_boards("data/ats_boards.yaml")] \
        == ["a.wd1/Ext"]
    (data / "data" / "ats_boards.local.yaml").write_text(
        "boards:\n- {company: A, ats: workday, slug: a.wd1/Ext}\n"
        "- {company: B, ats: workday, slug: b.wd5/Site}\n", encoding="utf-8")
    assert ats_boards.local_boards_path("data/ats_boards.yaml") \
        == data / "data" / "ats_boards.local.yaml"
    assert [b["slug"] for b in ats_boards.load_boards("data/ats_boards.yaml")] \
        == ["a.wd1/Ext", "b.wd5/Site"]


def test_discovery_keeps_instance_boards_out_of_the_template():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
    import discover_ats_boards as d
    found = [{"company": "NVIDIA", "ats": "workday", "slug": "nvidia.wd5/X"},
             {"company": "Small Regional Co", "ats": "workday", "slug": "src.wd1/Y"},
             {"company": "Cisco", "ats": "workday", "slug": "cisco.wd5/C"}]
    template = [{"company": "Cisco", "ats": "workday", "slug": "cisco.wd5/C"}]
    public, local = d.split_workday(found, template)
    assert [r["slug"] for r in public] == ["nvidia.wd5/X"]
    assert [r["slug"] for r in local] == ["src.wd1/Y"]


def test_load_boards_dedupes_slugs_case_insensitively(tmp_path):
    from src.adapters.ats_boards import load_boards
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "ats_boards.yaml").write_text(
        "boards:\n- {company: KLA, ats: workday, slug: kla.wd1/search}\n",
        encoding="utf-8")
    (tmp_path / "data" / "ats_boards.local.yaml").write_text(
        "boards:\n- {company: KLA, ats: Workday, slug: kla.wd1/Search}\n"
        "- {company: X, ats: Workday, slug: x.wd5/Ext}\n",
        encoding="utf-8")
    rows = load_boards("data/ats_boards.yaml", root=tmp_path, data_root=tmp_path)
    assert [r["slug"] for r in rows] == ["kla.wd1/search", "x.wd5/Ext"]  # template wins
    assert all(r["ats"] == "workday" for r in rows)   # "Workday" normalized


def test_bad_board_row_is_isolated_and_reported(tmp_path, monkeypatch):
    from src import config_check
    from src.adapters import ats_boards
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "ats_boards.yaml").write_text(
        "boards:\n"
        "- {company: Bad, ats: workday, slug: bad-slug}\n"
        "- {company: Good, ats: workday, slug: good.wd1/Ext}\n", encoding="utf-8")
    rep = config_check.boards_report(tmp_path, tmp_path)
    assert not rep.ok and any("Bad" in e and "tenant.wdN/site" in e
                              for e in rep.errors)

    monkeypatch.setattr(ats_boards, "ROOT", tmp_path)
    monkeypatch.setattr(ats_boards, "DATA_ROOT", tmp_path)

    def fake_listing(slug, client=None, sleep=None):
        return json.dumps(_page(["SWE Intern"], total=1))
    monkeypatch.setattr(wd, "fetch_listing", fake_listing)
    adapter = AtsBoardsAdapter(SourceConfig(name="ats-boards", adapter="ats_boards"))
    assert [j.company for j in adapter.fetch(httpx.Client(), TODAY)] == ["Good"]


def test_template_boards_pass_config_check():
    from pathlib import Path

    from src import config_check
    root = Path(__file__).parent.parent
    assert config_check.boards_report(root, root).ok


def test_new_workday_board_backlog_is_seeded(fixtures, tmp_path, monkeypatch):
    """First-sight seeding (src/seeding.py): a Workday board fetched for the
    first time reports itself in fetched_boards and stamps Job.board, so its
    whole backlog is seeded, not evaluated and mailed. A board that failed
    is absent from the report and seeds nothing. Inert until seeding lands."""
    seeding = pytest.importorskip("src.seeding")
    from src import state as st
    from src.adapters import ats_boards
    from src.dedupe import dedupe

    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "ats_boards.yaml").write_text(
        "boards:\n"
        f"- {{company: General Motors, ats: workday, slug: {SLUG}}}\n"
        "- {company: Dead, ats: workday, slug: dead.wd1/Ext}\n", encoding="utf-8")
    monkeypatch.setattr(ats_boards, "ROOT", tmp_path)
    monkeypatch.setattr(ats_boards, "DATA_ROOT", tmp_path)
    listing = (fixtures / "ats_workday_gm.json").read_text(encoding="utf-8")

    def fake_listing(slug, client=None, sleep=None):
        if slug.startswith("dead"):
            raise httpx.HTTPStatusError("429", request=None, response=None)
        return listing
    monkeypatch.setattr(wd, "fetch_listing", fake_listing)

    adapter = AtsBoardsAdapter(SourceConfig(name="ats-boards", adapter="ats_boards"))
    raw = adapter.fetch(httpx.Client(), TODAY)
    gm_board = "workday:generalmotors.wd5/careers_gm"
    assert raw and all(j.board == gm_board for j in raw)
    assert adapter.fetched_boards == {gm_board: False}   # the dead one is absent

    state = st.empty_state()
    state["_meta"]["known_sources"] = ["ats-boards"]
    state["_meta"]["known_boards"] = ["greenhouse:anduril"]
    dedupe(raw)
    plan = seeding.first_sight(state, raw, seeding.FetchReport(
        sources={"ats-boards": False}, boards=dict(adapter.fetched_boards)))
    assert set(plan) == {j.dedup_key for j in raw}
    assert all(origins == [gm_board] for origins in plan.values())


def _rows(n, title="Intern", start=0):
    return _page([f"{title} {start + i}" for i in range(n)], offset=start)["jobPostings"]


def test_short_page_before_total_is_incomplete():
    """total 100, a full page, then a 3-row page: 23 < 100 is a truncated
    read, not the end of the listing."""
    with pytest.raises(wd.IncompleteListing, match="23 of 100"):
        wd.fetch_listing(SLUG, _scripted([
            PROBE,
            httpx.Response(200, json={"total": 100, "jobPostings": _rows(20)}),
            httpx.Response(200, json={"jobPostings": _rows(3, start=20)})]),
            sleep=_noop)


def test_empty_page_before_total_is_incomplete():
    with pytest.raises(wd.IncompleteListing, match="20 of 100"):
        wd.fetch_listing(SLUG, _scripted([
            PROBE,
            httpx.Response(200, json={"total": 100,
                                      "jobPostings": _rows(20, "Engineer")}),
            httpx.Response(200, json={"jobPostings": []})]), sleep=_noop)


def test_short_last_page_landing_on_total_is_complete():
    data = json.loads(wd.fetch_listing(SLUG, _scripted([
        PROBE,
        httpx.Response(200, json={"total": 43, "jobPostings": _rows(20)}),
        httpx.Response(200, json={"jobPostings": _rows(20, start=20)}),
        httpx.Response(200, json={"jobPostings": _rows(3, start=40)})]),
        sleep=_noop))
    assert len(data["jobPostings"]) == 43


def test_rows_without_total_on_page_zero_are_incomplete():
    with pytest.raises(wd.IncompleteListing, match="no total"):
        wd.fetch_listing(SLUG, _scripted([
            PROBE, httpx.Response(200, json={"jobPostings": _rows(3)})]),
            sleep=_noop)


def test_bare_us_city_never_inherits_a_foreign_country():
    """Austin under a Polish primary must stay unplaced (kept), not become
    'Austin, Poland' (a final rejection); a bare non-US city still inherits."""
    from src.filters import location_country
    detail = {"jobPostingInfo": {"location": "Krakow",
                                 "additionalLocations": ["Austin", "Gdansk"],
                                 "country": {"descriptor": "Poland"}}}
    locs = wd.detail_locations(detail)
    assert locs == ["Krakow, Poland", "Austin", "Gdansk, Poland"]
    assert location_country("Austin") == "unknown"
