"""First-sight seeding of newly added sources and ATS boards (src/seeding.py)."""

import datetime as dt

from src import main, seeding
from src import state as st
from src.adapters import ats_boards
from src.dedupe import dedupe
from src.models import Job, SourceConfig
from tests.test_main_integration import _freeze_clock, _user_cfg, _wire

TODAY = dt.date(2026, 6, 12)


def _url(i, board=None):
    """Each board posts under its own URL path, like a real ATS board."""
    host = (board or "x").replace(":", "-")
    return f"https://{host}.example/jobs/{i}"


def _key(i, board=None):
    return f"url:{_url(i, board)}"


def _job(i, source="old-src", board=None):
    return Job(company=f"Co{i}", title="Software Engineer Intern",
               url=_url(i, board), source=source, board=board,
               terms=["Summer 2027"], term_confidence="explicit",
               locations=["Atlanta, GA"])


def _state(known_sources=(), known_boards=(), entries=()):
    state = st.empty_state()
    state["_meta"]["known_sources"] = sorted(known_sources)
    state["_meta"]["known_boards"] = sorted(known_boards)
    for key, sources in entries:
        st.touch(state, key, sources, TODAY - dt.timedelta(days=3))
    return state


def _plan(state, raw, report):
    dedupe(raw)  # stamps dedup_key on every raw row
    return seeding.first_sight(state, raw, report)


def _report(sources=None, boards=None):
    return seeding.FetchReport(sources=dict(sources or {}),
                               boards=dict(boards or {}))


# ------------------------------------------------------------ unit: planning

def test_new_source_backlog_seeded_known_source_not():
    state = _state(known_sources={"old-src"})
    raw = [_job(1, "old-src"), _job(2, "new-src"), _job(3, "new-src")]
    plan = _plan(state, raw, _report({"old-src": False, "new-src": False}))
    assert set(plan) == {raw[1].dedup_key, raw[2].dedup_key}
    assert plan[raw[1].dedup_key] == ["new-src"]


def test_same_job_via_known_source_is_evaluated_not_seeded():
    state = _state(known_sources={"old-src"})
    raw = [_job(1, "new-src"), _job(1, "old-src")]
    plan = _plan(state, raw, _report({"old-src": False, "new-src": False}))
    assert plan == {}


def test_already_seen_job_from_new_source_is_not_touched():
    state = _state(known_sources={"old-src"}, entries=[(_key(1), ["old-src"])])
    raw = [_job(1, "new-src")]
    raw[0].dedup_key = _key(1)
    assert seeding.first_sight(state, raw, _report({"new-src": False})) == {}


def test_new_board_inside_known_source_seeded():
    state = _state(known_sources={"ats-boards"}, known_boards={"greenhouse:old"})
    raw = [_job(1, "ats-boards", "greenhouse:old"),
           _job(2, "ats-boards", "oracle:new")]
    plan = _plan(state, raw, _report(
        {"ats-boards": False},
        {"greenhouse:old": False,
         "oracle:new": False}))
    assert plan == {raw[1].dedup_key: ["oracle:new"]}


def test_backfill_rows_opt_out():
    state = _state(known_sources={"ats-boards"})
    raw = [_job(1, "new-src"), _job(2, "ats-boards", "oracle:new")]
    plan = _plan(state, raw, _report(
        {"new-src": True, "ats-boards": False},
        {"oracle:new": True}))
    assert plan == {}


def test_bootstrap_derives_known_from_state():
    # No known_* lists yet (first run of this code). old-src appears in
    # state; greenhouse:old left a (since closed) job under its URL path that
    # state saw through ats-boards, so its all-new listings still count as a
    # known board; oracle:new left nothing -> only its new job is seeded.
    state = st.empty_state()
    for key, src in [(_key(1), ["old-src"]),
                     (_key(9, "greenhouse:old"), ["ats-boards"])]:
        st.touch(state, key, src, TODAY)
    raw = [_job(2, "old-src"),
           _job(10, "ats-boards", "greenhouse:old"),
           _job(11, "ats-boards", "greenhouse:old"),
           _job(20, "ats-boards", "oracle:new")]
    plan = _plan(state, raw, _report(
        {"old-src": False, "ats-boards": False},
        {"greenhouse:old": False,
         "oracle:new": False}))
    assert plan == {raw[3].dedup_key: ["oracle:new"]}


def test_bootstrap_evidence_ignores_jobs_ingested_by_another_source():
    # The new board's job was already in state via simplify: that is no
    # evidence the BOARD was fetched before, so its other new job is seeded.
    state = st.empty_state()
    st.touch(state, _key(20, "oracle:new"), ["simplify"], TODAY)
    st.touch(state, _key(99), ["ats-boards"], TODAY)
    raw = [_job(20, "ats-boards", "oracle:new"),
           _job(21, "ats-boards", "oracle:new")]
    plan = _plan(state, raw, _report(
        {"ats-boards": False}, {"oracle:new": False}))
    assert plan == {raw[1].dedup_key: ["oracle:new"]}


def test_greenhouse_embed_tenants_do_not_share_board_evidence():
    # Embed URLs share one path; the tenant lives in the query. An old
    # tenant's history must not make a new tenant's board look known.
    def gh(tenant, n, board):
        j = _job(n, "ats-boards", board)
        j.url = (f"https://boards.greenhouse.io/embed/job_app?for={tenant}"
                 f"&token={n}000000")
        return j
    state = st.empty_state()
    old = gh("old", 1, "greenhouse:old")
    dedupe([old])
    st.touch(state, old.dedup_key, ["ats-boards"], TODAY)
    raw = [gh("old", 2, "greenhouse:old"), gh("new", 3, "greenhouse:new")]
    plan = _plan(state, raw, _report({"ats-boards": False},
                                     {"greenhouse:old": False,
                                      "greenhouse:new": False}))
    assert plan == {raw[1].dedup_key: ["greenhouse:new"]}


def test_path_shapes():
    p = seeding._path
    assert p("url:https://boards.greenhouse.io/embed/job_app?token=123456") is None
    assert (p("url:https://boards.greenhouse.io/embed/job_app?for=meta2024&token=1")
            != p("url:https://boards.greenhouse.io/embed/job_app?for=meta2025&token=1"))
    wd = "url:https://gm.wd5.myworkdayjobs.com/Careers_GM/job/"
    assert p(wd + "Warren-MI/Intern_JR-1") == p(wd + "Dublin-Ireland/Java_JR-2")
    assert p("url:https://jobs.lever.co/acme/uuid-1") == "url:https://jobs.lever.co/acme"
    # Custom-domain Greenhouse boards that key the posting in the query
    assert (p("url:https://stripe.com/jobs/search?gh_jid=8130883")
            == "url:https://stripe.com/jobs")
    assert (p("url:https://boards.greenhouse.io/robinhood/jobs/8198241?t=gh_src%3D")
            == "url:https://boards.greenhouse.io/robinhood/jobs")
    assert (p("url:https://www.jumptrading.com/hr/job?gh_jid=7362318")
            == "url:https://www.jumptrading.com/hr")
    assert (p("url:https://stripe.com/jobs/search?gh_jid=1")
            == p("url:https://stripe.com/jobs/search?gh_jid=2"))


def test_new_source_recorded_only_once_it_returns_jobs(monkeypatch, tmp_path):
    listed: list = []

    class Adapter:
        def __init__(self, cfg):
            self.cfg = cfg

        def fetch(self, client, today):
            return [j.model_copy() for j in listed if j.source == self.cfg.name]

    old = [_job(1, "old-src")]
    listed += old
    sources = [SourceConfig(name="old-src", adapter="a"),
               SourceConfig(name="new-src", adapter="a")]
    _wire(monkeypatch, sources, {s.name: Adapter for s in sources},
          [_user_cfg()])
    _freeze_clock(monkeypatch)
    state_file = tmp_path / "seen.json"
    assert main.main(["--state-file", str(state_file), "--seed"]) == 0
    state = st.load_state(state_file)
    assert state["_meta"]["known_sources"] == ["old-src"]   # empty: not yet


def test_board_backfill_honored_when_its_source_is_new_too():
    state = _state(known_sources={"old-src"})
    raw = [_job(1, "ats-boards", "oracle:wanted"),
           _job(2, "ats-boards", "oracle:other")]
    plan = _plan(state, raw, _report({"ats-boards": False},
                                     {"oracle:wanted": True,
                                      "oracle:other": False}))
    assert plan == {raw[1].dedup_key: ["ats-boards"]}


def test_record_known_unions_and_sorts():
    state = _state(known_sources={"b"}, known_boards={"x:1"})
    seeding.record_known(state, _report({"a": False},
                                        {"y:2": False}))
    assert state["_meta"]["known_sources"] == ["a", "b"]
    assert state["_meta"]["known_boards"] == ["x:1", "y:2"]


# ------------------------------------------------- adapter stamps board ids

def test_ats_adapter_stamps_board_and_reports_answered_boards(
        monkeypatch, tmp_path, fixtures):
    boards = tmp_path / "boards.yaml"
    boards.write_text(
        "boards:\n"
        "- {company: Anduril, ats: greenhouse, slug: AndurilIndustries}\n"
        "- {company: Empty, ats: ashby, slug: empty, backfill: true}\n"
        "- {company: Dead, ats: lever, slug: dead}\n", encoding="utf-8")
    gh = (fixtures / "ats_greenhouse_anduril.json").read_text(encoding="utf-8")

    def fake_fetch(client, url):
        if "greenhouse" in url:
            return gh
        if "ashby" in url:
            return '{"jobs": []}'
        raise RuntimeError("down")

    monkeypatch.setattr(ats_boards, "fetch_text", fake_fetch)
    monkeypatch.setattr(ats_boards, "ROOT", tmp_path)
    adapter = ats_boards.AtsBoardsAdapter(SourceConfig(
        name="ats-boards", adapter="ats_boards", boards_file="boards.yaml"))
    jobs = adapter.fetch(None, TODAY)
    assert jobs and {j.board for j in jobs} == {"greenhouse:andurilindustries"}
    # parse() itself stamps it, so any lister routed through parse gets it
    assert {j.board for j in adapter.parse(gh, "greenhouse:X:Anduril", TODAY)} \
        == {"greenhouse:x"}
    # zero-row boards count as answered; failed boards do not
    assert adapter.fetched_boards == {"greenhouse:andurilindustries": False,
                                      "ashby:empty": True}


# ------------------------------------------------------------ end to end

def _wire_two(monkeypatch, listed):
    class Adapter:
        def __init__(self, cfg):
            self.cfg = cfg
            self.fetched_boards = {}

        def fetch(self, client, today):
            jobs = [j.model_copy() for j in listed if j.source == self.cfg.name]
            if not jobs and self.cfg.name == "new-src":
                # not live yet; a source that answers (even empty) is known
                raise RuntimeError("not configured yet")
            for j in jobs:
                if j.board:
                    self.fetched_boards[j.board] = False
            return jobs

    sources = [SourceConfig(name="old-src", adapter="a"),
               SourceConfig(name="ats-boards", adapter="a"),
               SourceConfig(name="new-src", adapter="a")]
    _wire(monkeypatch, sources, {s.name: Adapter for s in sources},
          [_user_cfg()])
    _freeze_clock(monkeypatch)


def test_end_to_end_new_origins_deliver_nothing(monkeypatch, tmp_path):
    listed = [_job(1, "old-src"), _job(2, "ats-boards", "greenhouse:old")]
    _wire_two(monkeypatch, listed)
    state_file = tmp_path / "seen.json"
    argv = ["--state-file", str(state_file)]
    assert main.main(argv + ["--seed"]) == 0
    state = st.load_state(state_file)
    # --seed records what answered as known
    assert state["_meta"]["known_sources"] == ["ats-boards", "old-src"]
    assert state["_meta"]["known_boards"] == ["greenhouse:old"]

    # Next run: a new source and a new board appear with a backlog, plus one
    # genuinely new job on a known source and one on a known board.
    listed += [_job(3, "new-src"), _job(4, "new-src"),
               _job(5, "ats-boards", "oracle:new"),
               _job(6, "old-src"), _job(7, "ats-boards", "greenhouse:old")]
    assert main.main(argv) == 0
    state = st.load_state(state_file)
    boards = {2: "greenhouse:old", 5: "oracle:new", 7: "greenhouse:old"}
    keys = {i: _key(i, boards.get(i)) for i in range(1, 8)}
    for i in (3, 4, 5):
        assert state["jobs"][keys[i]]["seeded"] == TODAY.isoformat()
        assert not st.was_notified(state, keys[i], "example")
    for i in (6, 7):
        assert "seeded" not in state["jobs"][keys[i]]
        assert st.was_notified(state, keys[i], "example")
    assert "new-src" in state["_meta"]["known_sources"]
    assert "oracle:new" in state["_meta"]["known_boards"]

    # Third run: the once-new origins now deliver their new postings.
    listed += [_job(8, "new-src"), _job(9, "ats-boards", "oracle:new")]
    monkeypatch.setattr(main, "send_email", lambda *a, **k: True)
    assert main.main(argv + ["--send-now"]) == 0
    state = st.load_state(state_file)
    for i, board in ((8, None), (9, "oracle:new")):
        key = _key(i, board)
        assert "seeded" not in state["jobs"][key]
        assert st.was_notified(state, key, "example")


def test_seed_flag_tags_seeded(monkeypatch, tmp_path):
    listed = [_job(1, "old-src")]
    _wire_two(monkeypatch, listed)
    state_file = tmp_path / "seen.json"
    assert main.main(["--state-file", str(state_file), "--seed"]) == 0
    state = st.load_state(state_file)
    assert state["jobs"][_key(1)]["seeded"] == TODAY.isoformat()
